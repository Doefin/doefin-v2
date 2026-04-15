// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
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
    // Fee Withdrawal (Admin Only)
    // ----------------------------------------

    /**
     * @notice Withdraw accumulated protocol fees (Admin only)
     * @param token The token to withdraw fees for
     * @param amount The amount to withdraw (0 = withdraw all)
     * @param recipient The address to send fees to (0 = use configured fee receiver)
     */
    function withdrawProtocolFees(address token, uint256 amount, address recipient) internal {
        LibDiamond.enforceIsContractOwner();

        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        if (token == address(0)) revert Errors.InvalidTokenAddress();

        uint256 availableFees = ds.escrowStorage.protocolFees[token];
        if (availableFees == 0) revert Errors.NoFeesToWithdraw();

        uint256 withdrawAmount = amount == 0 ? availableFees : amount;
        if (withdrawAmount > availableFees) revert Errors.InsufficientFeeBalance();

        address feeRecipient = recipient == address(0) ? ds.adminConfigStorage.feeReceiver : recipient;
        if (feeRecipient == address(0)) revert Errors.InvalidFeeReceiver();

        ds.escrowStorage.protocolFees[token] -= withdrawAmount;

        IERC20(token).safeTransfer(feeRecipient, withdrawAmount);

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
    function batchWithdrawProtocolFees(address[] memory tokens, uint256[] memory amounts, address recipient) internal {
        if (tokens.length != amounts.length) revert Errors.ArrayLengthMismatch();

        LibDiamond.enforceIsContractOwner();

        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        address feeRecipient = recipient == address(0) ? ds.adminConfigStorage.feeReceiver : recipient;
        if (feeRecipient == address(0)) revert Errors.InvalidFeeReceiver();

        for (uint256 i = 0; i < tokens.length; i++) {
            address token = tokens[i];

            // Gracefully skip invalid or empty entries to make batch ops resilient
            if (token == address(0)) continue;

            uint256 availableFees = ds.escrowStorage.protocolFees[token];
            if (availableFees == 0) continue;

            uint256 withdrawAmount = amounts[i] == 0 ? availableFees : amounts[i];
            if (withdrawAmount > availableFees) revert Errors.InsufficientFeeBalance();

            ds.escrowStorage.protocolFees[token] -= withdrawAmount;
            IERC20(token).safeTransfer(feeRecipient, withdrawAmount);

            emit Events.ProtocolFeesWithdrawn(token, feeRecipient, withdrawAmount, ds.escrowStorage.protocolFees[token]);
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
