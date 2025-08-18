// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {LibFeeManager} from "../libraries/LibFeeManager.sol";
import {IAdminConfig} from "../interfaces/IAdminConfig.sol";
import {LibDiamond} from "../libraries/LibDiamond.sol";
import {Errors} from "../libraries/Errors.sol";
import {Events} from "../libraries/Events.sol";

/**
 * @title AdminConfigFacetV2
 * @notice Enhanced admin configuration facet with fee withdrawal functionality
 * @dev Extends the original AdminConfigFacet with new fee management capabilities
 */
contract AdminConfigFacet is IAdminConfig {
    function addCollateralToken(address token, uint256 unitPerPair) external override {
        LibDiamond.enforceIsContractOwner();
        if (token == address(0)) revert Errors.InvalidTokenAddress();
        if (unitPerPair == 0) revert Errors.InvalidUnitPerPair();

        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        if (ds.adminConfigStorage.isAllowed[token]) revert Errors.TokenAlreadyAllowed();

        ds.adminConfigStorage.isAllowed[token] = true;
        ds.adminConfigStorage.unitPerPair[token] = unitPerPair;

        emit Events.CollateralTokenAdded(token, unitPerPair);
    }

    function removeCollateralToken(address token) external override {
        LibDiamond.enforceIsContractOwner();
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        if (!ds.adminConfigStorage.isAllowed[token]) revert Errors.TokenNotAllowed();

        ds.adminConfigStorage.isAllowed[token] = false;
        delete ds.adminConfigStorage.unitPerPair[token];

        emit Events.CollateralTokenRemoved(token);
    }

    function setFeeReceiver(address feeReceiver) external override {
        LibDiamond.enforceIsContractOwner();
        if (feeReceiver == address(0)) revert Errors.InvalidFeeReceiver();
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        address oldReceiver = ds.adminConfigStorage.feeReceiver;
        if (oldReceiver == feeReceiver) return; // No change, no event
        ds.adminConfigStorage.feeReceiver = feeReceiver;
        emit Events.FeeReceiverUpdated(oldReceiver, feeReceiver);
    }

    function setResolutionFeeBps(uint16 bps) external override {
        LibDiamond.enforceIsContractOwner();
        if (bps > 10_000) revert Errors.FeeTooHigh();

        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        uint256 oldFeeBps = ds.adminConfigStorage.resolutionFeeBps;
        if (oldFeeBps == bps) return; // No change, no event
        ds.adminConfigStorage.resolutionFeeBps = bps;
        emit Events.ResolutionFeeUpdated(oldFeeBps, bps);
    }

    function setTradingFeesBps(uint16 makerBps, uint16 takerBps) external override {
        LibDiamond.enforceIsContractOwner();
        if (makerBps > 10_000 || takerBps > 10_000) revert Errors.FeeTooHigh();

        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        uint256 oldMakerBps = ds.adminConfigStorage.makerTradingFeeBps;
        uint256 oldTakerBps = ds.adminConfigStorage.takerTradingFeeBps;
        ds.adminConfigStorage.makerTradingFeeBps = makerBps;
        ds.adminConfigStorage.takerTradingFeeBps = takerBps;
        emit Events.TradingFeesUpdated(oldMakerBps, oldTakerBps, makerBps, takerBps);
    }

    function isAllowedCollateral(address token) external view override returns (bool) {
        return LibDoefinStorage.diamondStorage().adminConfigStorage.isAllowed[token];
    }

    function getCollateralUnit(address token) external view override returns (uint256) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        if (!ds.adminConfigStorage.isAllowed[token]) revert Errors.TokenNotAllowed();
        return ds.adminConfigStorage.unitPerPair[token];
    }

    function getFees()
        external
        view
        override
        returns (
            address feeReceiver,
            uint16 resolutionFeeBps,
            uint16 makerTradingFeeBps,
            uint16 takerTradingFeeBps
        )
    {
        LibDoefinStorage.AdminConfigStorage storage cfg = LibDoefinStorage.diamondStorage().adminConfigStorage;
        return (cfg.feeReceiver, cfg.resolutionFeeBps, cfg.makerTradingFeeBps, cfg.takerTradingFeeBps);
    }

    // ----------------------------------------
    // NEW: Fee Withdrawal Functions
    // ----------------------------------------

    /**
     * @notice Withdraw accumulated protocol fees for a specific token
     * @param token The token to withdraw fees for
     * @param amount The amount to withdraw (0 = withdraw all)
     */
    function withdrawProtocolFees(address token, uint256 amount) external override {
        LibFeeManager.withdrawProtocolFees(token, amount, address(0));
    }

    /**
     * @notice Withdraw accumulated protocol fees to a specific recipient
     * @param token The token to withdraw fees for
     * @param amount The amount to withdraw (0 = withdraw all)
     * @param recipient The address to send fees to
     */
    function withdrawProtocolFeesTo(
        address token,
        uint256 amount,
        address recipient
    ) external override {
        LibFeeManager.withdrawProtocolFees(token, amount, recipient);
    }

    /**
     * @notice Withdraw all accumulated fees for a specific token
     * @param token The token to withdraw all fees for
     */
    function withdrawAllProtocolFees(address token) external override {
        LibFeeManager.withdrawAllProtocolFees(token, address(0));
    }

    /**
     * @notice Withdraw all accumulated fees for a specific token to a specific recipient
     * @param token The token to withdraw all fees for
     * @param recipient The address to send fees to
     */
    function withdrawAllProtocolFeesTo(address token, address recipient) external override {
        LibFeeManager.withdrawAllProtocolFees(token, recipient);
    }

    /**
     * @notice Batch withdraw fees for multiple tokens
     * @param tokens Array of token addresses
     * @param amounts Array of amounts to withdraw (0 = withdraw all for that token)
     */
    function batchWithdrawProtocolFees(address[] calldata tokens, uint256[] calldata amounts) external override {
        LibFeeManager.batchWithdrawProtocolFees(tokens, amounts, address(0));
    }

    /**
     * @notice Batch withdraw fees for multiple tokens to a specific recipient
     * @param tokens Array of token addresses
     * @param amounts Array of amounts to withdraw (0 = withdraw all for that token)
     * @param recipient The address to send fees to
     */
    function batchWithdrawProtocolFeesTo(
        address[] calldata tokens,
        uint256[] calldata amounts,
        address recipient
    ) external override {
        LibFeeManager.batchWithdrawProtocolFees(tokens, amounts, recipient);
    }

    // ----------------------------------------
    // NEW: Fee Query Functions
    // ----------------------------------------

    /**
     * @notice Get accumulated protocol fees for a token
     * @param token The token address
     * @return The accumulated fee amount
     */
    function getProtocolFeesBalance(address token) external view override returns (uint256) {
        return LibFeeManager.getAccumulatedFees(token);
    }

    /**
     * @notice Get accumulated fees for multiple tokens
     * @param tokens Array of token addresses
     * @return fees Array of accumulated fee amounts
     */
    function getProtocolFeesBalances(address[] calldata tokens) external view override returns (uint256[] memory fees) {
        return LibFeeManager.getAccumulatedFeesForTokens(tokens);
    }

    /**
     * @notice Check if there are any fees available for withdrawal
     * @param token The token address
     * @return True if fees are available
     */
    function hasFeesAvailable(address token) external view override returns (bool) {
        return LibFeeManager.hasFeesAvailable(token);
    }

    /**
     * @notice Get comprehensive fee statistics for a token
     * @param token The token address
     * @return available The currently available fees
     * @return receiver The configured fee receiver
     */
    function getFeeStatistics(address token) external view override returns (uint256 available, address receiver) {
        return LibFeeManager.getFeeStatistics(token);
    }

    /**
     * @notice Get total value of accumulated fees across all tokens
     * @param tokens Array of token addresses to sum
     * @return totalValue The total value (implementation dependent on price feeds)
     */
    function getTotalAccumulatedFeesValue(address[] calldata tokens) external view override returns (uint256 totalValue) {
        return LibFeeManager.getTotalAccumulatedFeesValue(tokens);
    }
}
