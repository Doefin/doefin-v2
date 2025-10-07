// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {LibReentrancyGuard} from "./LibReentrancyGuard.sol";
import {LibDiamond} from "./LibDiamond.sol";
import {Errors} from "./Errors.sol";
import {Events} from "./Events.sol";

/**
 * @title LibFeeManager
 * @notice Centralized fee management for calculations, accrual, and withdrawal
 * @dev Handles all fee-related operations with proper access control
 */
library LibFeeManager {
    using SafeERC20 for IERC20;

    // ----------------------------------------
    // Fee Configuration
    // ----------------------------------------

    /**
     * @notice Get current market fee configuration
     * @return orderFeeConfig The current fee configuration
     */
    function getMarketFees() internal view returns (LibDoefinStorage.OrderFeeConfig memory orderFeeConfig) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        orderFeeConfig = LibDoefinStorage.OrderFeeConfig({
            makerFeeBps: ds.adminConfigStorage.makerTradingFeeBps,
            takerFeeBps: ds.adminConfigStorage.takerTradingFeeBps
        });
    }

    // ----------------------------------------
    // Fee Calculations
    // ----------------------------------------

    /**
     * @notice Calculate maker fee for a given cost
     * @param cost The cost amount to calculate fee on
     * @return The maker fee amount
     */
    function computeMakerFee(uint256 cost) internal view returns (uint256) {
        uint256 bps = LibDoefinStorage.appStorage().adminConfigStorage.makerTradingFeeBps;
        return Math.mulDiv(cost, bps, 10_000);
    }

    /**
     * @notice Calculate fees for complementary and merge matches
     * @param settlementExecCtx The settlement execution context
     * @return makerFee The maker fee amount
     * @return takerFee The taker fee amount
     * @return cost The base cost amount
     */
    function computeTradeExecutionFees(LibDoefinStorage.SettlementExecutionContext memory settlementExecCtx)
        internal
        view
        returns (
            uint256 makerFee,
            uint256 takerFee,
            uint256 cost
        )
    {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        LibDoefinStorage.Order memory makerOrder = settlementExecCtx.makerOrder;

        address token = makerOrder.collateralToken;
        uint256 unitPerPair = ds.adminConfigStorage.unitPerPair[token];
        if (unitPerPair == 0) revert Errors.TokenNotAllowed();

        // Calculate normalized cost
        cost = Math.mulDiv(settlementExecCtx.fillableAmount, makerOrder.pricePerToken, unitPerPair);

        // Calculate fees
        makerFee = Math.mulDiv(cost, makerOrder.orderFeeConfig.makerFeeBps, 10_000);
        takerFee = Math.mulDiv(cost, makerOrder.orderFeeConfig.takerFeeBps, 10_000);
    }

    /**
     * @notice Calculate fees for mint matches (split operations)
     * @param makerOrder The maker order
     * @param fillableAmount The amount being filled
     * @return makerFee The maker fee amount
     * @return takerFee The taker fee amount
     * @return makerContribution The maker's contribution to the mint
     * @return takerContribution The taker's contribution to the mint
     */
    function computeMintFees(LibDoefinStorage.Order memory makerOrder, uint256 fillableAmount)
        internal
        view
        returns (
            uint256 makerFee,
            uint256 takerFee,
            uint256 makerContribution,
            uint256 takerContribution
        )
    {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        address collateralToken = makerOrder.collateralToken;
        uint256 unitPerPair = ds.adminConfigStorage.unitPerPair[collateralToken];

        // Calculate contributions
        makerContribution = Math.mulDiv(fillableAmount, makerOrder.pricePerToken, unitPerPair);
        takerContribution = fillableAmount - makerContribution;

        // Calculate fees on respective contributions
        makerFee = Math.mulDiv(makerContribution, makerOrder.orderFeeConfig.makerFeeBps, 10_000);
        takerFee = Math.mulDiv(takerContribution, makerOrder.orderFeeConfig.takerFeeBps, 10_000);
    }

    // ----------------------------------------
    // Fee Accrual
    // ----------------------------------------

    /**
     * @notice Accrue protocol fees from a trade
     * @param makerFee The maker fee amount
     * @param takerFee The taker fee amount
     * @param settlementExecCtx The settlement execution context containing trade details
     * @param settlementExecCtx The settlement execution context containing trade details
     */
    function accrueFees(
        uint256 makerFee,
        uint256 takerFee,
        LibDoefinStorage.SettlementExecutionContext memory settlementExecCtx
    ) internal {
        uint256 totalFees = makerFee + takerFee;
        if (totalFees == 0) return;

        address token = settlementExecCtx.makerOrder.collateralToken;

        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        ds.escrowStorage.protocolFees[token] += totalFees;

        emit Events.ProtocolFeesAccrued(
            token,
            settlementExecCtx.makerOrder.orderId,
            settlementExecCtx.takerOrder.orderId,
            settlementExecCtx.makerOrder.maker,
            settlementExecCtx.takerOrder.taker,
            settlementExecCtx.fillableAmount,
            settlementExecCtx.makerOrder.pricePerToken,
            makerFee,
            takerFee,
            totalFees,
            ds.escrowStorage.protocolFees[token]
        );
        emit Events.ProtocolFeesAccrued(
            token,
            settlementExecCtx.makerOrder.orderId,
            settlementExecCtx.takerOrder.orderId,
            settlementExecCtx.makerOrder.maker,
            settlementExecCtx.takerOrder.taker,
            settlementExecCtx.fillableAmount,
            settlementExecCtx.makerOrder.pricePerToken,
            makerFee,
            takerFee,
            totalFees,
            ds.escrowStorage.protocolFees[token]
        );
    }

    // ----------------------------------------
    // Fee Withdrawal (Admin Only)
    // ----------------------------------------

    /**
     * @notice Withdraw accumulated protocol fees (Admin only)
     * @param token The token to withdraw fees for
     * @param amount The amount to withdraw (0 = withdraw all)
     * @param recipient The address to send fees to (0 = use configured fee receiver)
     */
    function withdrawProtocolFees(
        address token,
        uint256 amount,
        address recipient
    ) internal {
        // Enforce admin access
        LibDiamond.enforceIsContractOwner();

        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        // Validate token
        if (token == address(0)) revert Errors.InvalidTokenAddress();

        // Get current fee balance
        uint256 availableFees = ds.escrowStorage.protocolFees[token];
        if (availableFees == 0) revert Errors.NoFeesToWithdraw();

        // Determine withdrawal amount
        uint256 withdrawAmount = amount == 0 ? availableFees : amount;
        if (withdrawAmount > availableFees) revert Errors.InsufficientFeeBalance();

        // Determine recipient
        address feeRecipient = recipient == address(0) ? ds.adminConfigStorage.feeReceiver : recipient;
        if (feeRecipient == address(0)) revert Errors.InvalidFeeReceiver();

        // Update fee balance
        ds.escrowStorage.protocolFees[token] -= withdrawAmount;

        LibReentrancyGuard._nonReentrantBefore();
        // Transfer fees
        IERC20(token).safeTransfer(feeRecipient, withdrawAmount);
        
        LibReentrancyGuard._nonReentrantAfter();

        emit Events.ProtocolFeesWithdrawn(token, feeRecipient, withdrawAmount, ds.escrowStorage.protocolFees[token]);
    }

    /**
     * @notice Withdraw all accumulated fees for a specific token (Admin only)
     * @param token The token to withdraw all fees for
     * @param recipient The address to send fees to (0 = use configured fee receiver)
     */
    function withdrawAllProtocolFees(address token, address recipient) internal {
        withdrawProtocolFees(token, 0, recipient);
    }

    /**
     * @notice Batch withdraw fees for multiple tokens (Admin only)
     * @param tokens Array of token addresses
     * @param amounts Array of amounts to withdraw (0 = withdraw all for that token)
     * @param recipient The address to send fees to (0 = use configured fee receiver)
     */
    function batchWithdrawProtocolFees(
        address[] memory tokens,
        uint256[] memory amounts,
        address recipient
    ) internal {
        if (tokens.length != amounts.length) revert Errors.ArrayLengthMismatch();

        for (uint256 i = 0; i < tokens.length; i++) {
            if (getAccumulatedFees(tokens[i]) > 0) {
                withdrawProtocolFees(tokens[i], amounts[i], recipient);
            }
        }
    }

    // ----------------------------------------
    // Fee Queries
    // ----------------------------------------

    /**
     * @notice Get accumulated protocol fees for a token
     * @param token The token address
     * @return The accumulated fee amount
     */
    function getAccumulatedFees(address token) internal view returns (uint256) {
        return LibDoefinStorage.appStorage().escrowStorage.protocolFees[token];
    }

    /**
     * @notice Get accumulated fees for multiple tokens
     * @param tokens Array of token addresses
     * @return fees Array of accumulated fee amounts
     */
    function getAccumulatedFeesForTokens(address[] memory tokens) internal view returns (uint256[] memory fees) {
        fees = new uint256[](tokens.length);
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        for (uint256 i = 0; i < tokens.length; i++) {
            fees[i] = ds.escrowStorage.protocolFees[tokens[i]];
        }
    }

    /**
     * @notice Check if there are any fees available for withdrawal
     * @param token The token address
     * @return True if fees are available
     */
    function hasFeesAvailable(address token) internal view returns (bool) {
        return LibDoefinStorage.appStorage().escrowStorage.protocolFees[token] > 0;
    }

    // ----------------------------------------
    // Fee Statistics
    // ----------------------------------------

    /**
     * @notice Get fee statistics for a token
     * @param token The token address
     * @return available The currently available fees
     * @return receiver The configured fee receiver
     */
    function getFeeStatistics(address token) internal view returns (uint256 available, address receiver) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        available = ds.escrowStorage.protocolFees[token];
        receiver = ds.adminConfigStorage.feeReceiver;
    }
}
