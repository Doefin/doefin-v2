// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {IAdminConfig} from "../interfaces/IAdminConfig.sol";
import {LibDiamond} from "../libraries/LibDiamond.sol";
import {Errors} from "../libraries/Errors.sol";
import {Events} from "../libraries/Events.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/**
 * @title AdminConfigFacet
 * @author Doefin
 * @notice Diamond facet for protocol administration and configuration management
 * @dev Handles collateral tokens, fee configuration, and token symbol management
 * @dev Only contract owner can modify configuration settings
 * @dev Enhanced version with comprehensive fee management and token symbol support
 */
contract AdminConfigFacet is IAdminConfig {
    /// @notice Hard ceiling on the admin-configurable maximum settlement fee rate (10%).
    /// @dev SCRUM-224 — `setMaxFeeRate` reverts if the requested rate exceeds this. The
    ///      admin may configure any value in [0, MAX_FEE_RATE_BPS_CAP]; the operator
    ///      then supplies the per-leg fee amount at settlement, bounded by the
    ///      configured `maxFeeRateBps` (see SettlementFacet._validateFee).
    uint16 internal constant MAX_FEE_RATE_BPS_CAP = 1000;

    /**
     * @notice Adds a new collateral token to the protocol with specified unit configuration
     * @dev Automatically fetches and stores token symbol from ERC20Metadata interface
     * @dev Unit per pair represents the decimal scaling factor for price calculations
     * @param token The ERC20 token address to add as collateral
     * @param unitPerPair The scaling unit for price calculations (e.g., 10^18 for 18-decimal tokens)
     * @custom:emits CollateralTokenAdded with token address and unit configuration
     * @custom:reverts InvalidTokenAddress if token is zero address
     * @custom:reverts InvalidUnitPerPair if unitPerPair is zero
     * @custom:reverts TokenAlreadyAllowed if token is already configured
     * @custom:security Only callable by contract owner
     * @custom:note Fallback symbol "UNKNOWN" used if token doesn't implement symbol()
     */
    function addCollateralToken(address token, uint256 unitPerPair) external override {
        LibDiamond.enforceIsContractOwner();
        if (token == address(0)) revert Errors.InvalidTokenAddress();
        if (unitPerPair == 0) revert Errors.InvalidUnitPerPair();

        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        if (ds.adminConfigStorage.isAllowed[token]) revert Errors.TokenAlreadyAllowed();

        ds.adminConfigStorage.isAllowed[token] = true;
        ds.adminConfigStorage.unitPerPair[token] = unitPerPair;

        // Automatically fetch and store token symbol
        try IERC20Metadata(token).symbol() returns (string memory symbol) {
            // Only store the symbol if it's non-empty, otherwise use fallback
            if (bytes(symbol).length > 0) {
                ds.adminConfigStorage.tokenSymbols[token] = symbol;
            } else {
                ds.adminConfigStorage.tokenSymbols[token] = "UNKNOWN";
            }
        } catch {
            // Fallback for tokens without symbol() function
            ds.adminConfigStorage.tokenSymbols[token] = "UNKNOWN";
        }

        emit Events.CollateralTokenAdded(token, unitPerPair);
    }

    /**
     * @notice Removes a collateral token from the protocol
     * @dev Disables the token for new orders but doesn't affect existing positions
     * @dev Clears both the allowed flag and unit configuration
     * @param token The ERC20 token address to remove from allowed collaterals
     * @custom:emits CollateralTokenRemoved with token address
     * @custom:reverts TokenNotAllowed if token was not previously allowed
     * @custom:security Only callable by contract owner
     * @custom:note Existing orders and positions remain valid after removal
     */
    function removeCollateralToken(address token) external override {
        LibDiamond.enforceIsContractOwner();
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        if (!ds.adminConfigStorage.isAllowed[token]) revert Errors.TokenNotAllowed();

        ds.adminConfigStorage.isAllowed[token] = false;
        delete ds.adminConfigStorage.unitPerPair[token];

        emit Events.CollateralTokenRemoved(token);
    }

    /**
     * @notice Sets the protocol fee receiver address
     * @dev Address that will receive all protocol fees collected from trades and redemptions
     * @dev Prevents setting the same address to avoid unnecessary gas consumption
     * @param feeReceiver The address that will receive protocol fees
     * @custom:emits FeeReceiverUpdated with old and new receiver addresses
     * @custom:reverts InvalidFeeReceiver if feeReceiver is zero address
     * @custom:reverts NoChangeRequired if feeReceiver is the same as current
     * @custom:security Only callable by contract owner
     * @custom:note Fee receiver change affects future fee distributions immediately
     */
    function setFeeReceiver(address feeReceiver) external override {
        LibDiamond.enforceIsContractOwner();
        if (feeReceiver == address(0)) revert Errors.InvalidFeeReceiver();
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        address oldReceiver = ds.adminConfigStorage.feeReceiver;
        if (oldReceiver == feeReceiver) revert Errors.NoChangeRequired();
        ds.adminConfigStorage.feeReceiver = feeReceiver;
        emit Events.FeeReceiverUpdated(oldReceiver, feeReceiver);
    }

    /**
     * @notice Sets the resolution fee charged when redeeming winning positions
     * @dev Fee is charged as a percentage of the payout amount in basis points
     * @dev Resolution fee is deducted when users redeem their winning positions
     * @param bps Fee percentage in basis points (100 bps = 1%, max 10000 bps = 100%)
     * @custom:emits ResolutionFeeUpdated with old and new fee amounts
     * @custom:reverts FeeTooHigh if bps exceeds 10,000 (100%)
     * @custom:reverts NoChangeRequired if bps is the same as current setting
     * @custom:security Only callable by contract owner
     * @custom:note Fee change affects future redemptions immediately
     */
    function setResolutionFeeBps(uint16 bps) external override {
        LibDiamond.enforceIsContractOwner();
        if (bps > 10_000) revert Errors.FeeTooHigh();

        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        uint16 oldFeeBps = ds.adminConfigStorage.resolutionFeeBps;
        if (oldFeeBps == bps) revert Errors.NoChangeRequired();
        ds.adminConfigStorage.resolutionFeeBps = bps;
        emit Events.ResolutionFeeUpdated(oldFeeBps, bps);
    }

    /**
     * @notice Sets trading fees for makers and takers
     * @dev Maker fee applies to passive orders providing liquidity
     * @dev Taker fee applies to aggressive orders consuming liquidity
     * @dev Fees are charged as percentage of trade value in basis points
     * @param makerBps Maker fee in basis points (100 bps = 1%, max 10000 bps = 100%)
     * @param takerBps Taker fee in basis points (100 bps = 1%, max 10000 bps = 100%)
     * @custom:emits TradingFeesUpdated with old and new maker/taker fees
     * @custom:reverts FeeTooHigh if either fee exceeds 10,000 basis points
     * @custom:security Only callable by contract owner
     * @custom:note Fee changes affect new orders immediately; existing orders retain original fees
     */
    function setTradingFeesBps(uint16 makerBps, uint16 takerBps) external override {
        LibDiamond.enforceIsContractOwner();
        if (makerBps > 10_000 || takerBps > 10_000) revert Errors.FeeTooHigh();

        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        uint16 oldMakerBps = ds.adminConfigStorage.makerTradingFeeBps;
        uint16 oldTakerBps = ds.adminConfigStorage.takerTradingFeeBps;
        ds.adminConfigStorage.makerTradingFeeBps = makerBps;
        ds.adminConfigStorage.takerTradingFeeBps = takerBps;
        emit Events.TradingFeesUpdated(oldMakerBps, oldTakerBps, makerBps, takerBps);
    }

    /**
     * @notice Sets the maximum settlement fee rate the operator may charge
     * @dev SCRUM-224 — the operator supplies the fee amount per settlement leg; the
     *      contract enforces `fee <= (cashValue * maxFeeRateBps) / 10000`. This
     *      function configures that ceiling. Fail-closed: a value of 0 means the
     *      operator may not charge any non-zero fee.
     * @param _maxFeeRateBps New maximum fee rate in basis points (0..MAX_FEE_RATE_BPS_CAP)
     * @custom:emits MaxFeeRateUpdated with old and new rates
     * @custom:reverts MaxFeeRateExceedsCeiling if `_maxFeeRateBps` exceeds the 1000-bps cap
     * @custom:security Only callable by contract owner
     */
    function setMaxFeeRate(uint16 _maxFeeRateBps) external override {
        LibDiamond.enforceIsContractOwner();
        if (_maxFeeRateBps > MAX_FEE_RATE_BPS_CAP) revert Errors.MaxFeeRateExceedsCeiling();

        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        uint16 oldRate = ds.adminConfigStorage.maxFeeRateBps;
        ds.adminConfigStorage.maxFeeRateBps = _maxFeeRateBps;
        emit Events.MaxFeeRateUpdated(oldRate, _maxFeeRateBps);
    }

    /**
     * @notice Returns the configured maximum settlement fee rate
     * @return The maximum fee rate in basis points
     */
    function getMaxFeeRate() external view override returns (uint16) {
        return LibDoefinStorage.appStorage().adminConfigStorage.maxFeeRateBps;
    }

    function isAllowedCollateral(address token) external view override returns (bool) {
        return LibDoefinStorage.appStorage().adminConfigStorage.isAllowed[token];
    }

    function getCollateralUnit(address token) external view override returns (uint256) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        if (!ds.adminConfigStorage.isAllowed[token]) revert Errors.TokenNotAllowed();
        return ds.adminConfigStorage.unitPerPair[token];
    }

    function getFees()
        external
        view
        override
        returns (address feeReceiver, uint16 resolutionFeeBps, uint16 makerTradingFeeBps, uint16 takerTradingFeeBps)
    {
        LibDoefinStorage.AdminConfigStorage storage cfg = LibDoefinStorage.appStorage().adminConfigStorage;
        return (cfg.feeReceiver, cfg.resolutionFeeBps, cfg.makerTradingFeeBps, cfg.takerTradingFeeBps);
    }

    // ----------------------------------------
    // Token Symbol Management
    // ----------------------------------------

    /**
     * @notice Get token symbol for a given token address
     * @param token The token address
     * @return symbol The token symbol
     */
    function getTokenSymbol(address token) external view override returns (string memory symbol) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        return ds.adminConfigStorage.tokenSymbols[token];
    }

    /**
     * @notice Update token symbol for a given token address
     * @param token The token address
     * @param symbol The new symbol
     */
    function setTokenSymbol(address token, string calldata symbol) external override {
        LibDiamond.enforceIsContractOwner();
        if (!LibDoefinStorage.appStorage().adminConfigStorage.isAllowed[token]) {
            revert Errors.TokenNotAllowed();
        }

        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        ds.adminConfigStorage.tokenSymbols[token] = symbol;
        emit Events.TokenSymbolUpdated(token, symbol);
    }
}
