// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibAdminConfigStorage} from "../libraries/LibAdminConfigStorage.sol";
import {LibConstants} from "../libraries/LibConstants.sol";
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

        LibAdminConfigStorage.AdminConfigStorage storage acs = LibAdminConfigStorage.adminConfigStorage();

        if (acs.isAllowed[token]) revert Errors.TokenAlreadyAllowed();

        acs.isAllowed[token] = true;
        acs.unitPerPair[token] = unitPerPair;

        // Automatically fetch and store token symbol
        try IERC20Metadata(token).symbol() returns (string memory symbol) {
            // Only store the symbol if it's non-empty, otherwise use fallback
            if (bytes(symbol).length > 0) {
                acs.tokenSymbols[token] = symbol;
            } else {
                acs.tokenSymbols[token] = "UNKNOWN";
            }
        } catch {
            // Fallback for tokens without symbol() function
            acs.tokenSymbols[token] = "UNKNOWN";
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
        LibAdminConfigStorage.AdminConfigStorage storage acs = LibAdminConfigStorage.adminConfigStorage();

        if (!acs.isAllowed[token]) revert Errors.TokenNotAllowed();

        acs.isAllowed[token] = false;
        delete acs.unitPerPair[token];

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
        LibAdminConfigStorage.AdminConfigStorage storage acs = LibAdminConfigStorage.adminConfigStorage();
        address oldReceiver = acs.feeReceiver;
        if (oldReceiver == feeReceiver) revert Errors.NoChangeRequired();
        acs.feeReceiver = feeReceiver;
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
        if (bps > LibConstants.BPS_DENOMINATOR) revert Errors.FeeTooHigh();

        LibAdminConfigStorage.AdminConfigStorage storage acs = LibAdminConfigStorage.adminConfigStorage();
        uint16 oldFeeBps = acs.resolutionFeeBps;
        if (oldFeeBps == bps) revert Errors.NoChangeRequired();
        acs.resolutionFeeBps = bps;
        emit Events.ResolutionFeeUpdated(oldFeeBps, bps);
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

        LibAdminConfigStorage.AdminConfigStorage storage acs = LibAdminConfigStorage.adminConfigStorage();
        uint16 oldRate = acs.maxFeeRateBps;
        acs.maxFeeRateBps = _maxFeeRateBps;
        emit Events.MaxFeeRateUpdated(oldRate, _maxFeeRateBps);
    }

    /**
     * @notice Returns the configured maximum settlement fee rate
     * @return The maximum fee rate in basis points
     */
    function getMaxFeeRate() external view override returns (uint16) {
        return LibAdminConfigStorage.adminConfigStorage().maxFeeRateBps;
    }

    function isAllowedCollateral(address token) external view override returns (bool) {
        return LibAdminConfigStorage.adminConfigStorage().isAllowed[token];
    }

    function getCollateralUnit(address token) external view override returns (uint256) {
        LibAdminConfigStorage.AdminConfigStorage storage acs = LibAdminConfigStorage.adminConfigStorage();
        if (!acs.isAllowed[token]) revert Errors.TokenNotAllowed();
        return acs.unitPerPair[token];
    }

    /**
     * @notice Returns the protocol fee configuration
     * @return feeReceiver Address that receives protocol fees
     * @return resolutionFeeBps Resolution fee charged on redemption, in basis points
     */
    function getFees() external view override returns (address feeReceiver, uint16 resolutionFeeBps) {
        LibAdminConfigStorage.AdminConfigStorage storage cfg = LibAdminConfigStorage.adminConfigStorage();
        return (cfg.feeReceiver, cfg.resolutionFeeBps);
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
        LibAdminConfigStorage.AdminConfigStorage storage acs = LibAdminConfigStorage.adminConfigStorage();
        return acs.tokenSymbols[token];
    }

    /**
     * @notice Update token symbol for a given token address
     * @param token The token address
     * @param symbol The new symbol
     */
    function setTokenSymbol(address token, string calldata symbol) external override {
        LibDiamond.enforceIsContractOwner();
        if (!LibAdminConfigStorage.adminConfigStorage().isAllowed[token]) {
            revert Errors.TokenNotAllowed();
        }

        LibAdminConfigStorage.AdminConfigStorage storage acs = LibAdminConfigStorage.adminConfigStorage();
        acs.tokenSymbols[token] = symbol;
        emit Events.TokenSymbolUpdated(token, symbol);
    }
}
