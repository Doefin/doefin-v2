// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.20;

import {LibAdminConfigStorage} from "../libraries/LibAdminConfigStorage.sol";
import {LibConstants} from "../libraries/LibConstants.sol";
import {LibReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {IAdminConfig} from "../interfaces/IAdminConfig.sol";
import {LibDiamond} from "../libraries/LibDiamond.sol";
import {Errors} from "../libraries/Errors.sol";
import {Events} from "../libraries/Events.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title AdminConfigFacet
 * @author Doefin
 * @notice Diamond facet for protocol administration and configuration management
 * @dev Handles collateral tokens, fee configuration, and token symbol management
 * @dev Only contract owner can modify configuration settings
 * @dev Enhanced version with comprehensive fee management and token symbol support
 */
contract AdminConfigFacet is IAdminConfig {
    using SafeERC20 for IERC20;

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
     * @custom:reverts NoChangeRequired if `_maxFeeRateBps` is the same as the current value
     * @custom:security Only callable by contract owner
     * @custom:audit CR-3291973202 (folded into SCRUM-236) — added the `NoChangeRequired`
     *      no-op guard to match `setFeeReceiver` / `setResolutionFeeBps`.
     */
    function setMaxFeeRate(uint16 _maxFeeRateBps) external override {
        LibDiamond.enforceIsContractOwner();
        if (_maxFeeRateBps > MAX_FEE_RATE_BPS_CAP) revert Errors.MaxFeeRateExceedsCeiling();

        LibAdminConfigStorage.AdminConfigStorage storage acs = LibAdminConfigStorage.adminConfigStorage();
        uint16 oldRate = acs.maxFeeRateBps;
        if (oldRate == _maxFeeRateBps) revert Errors.NoChangeRequired();
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

    // ----------------------------------------
    // Fee Bank (SCRUM-236)
    // ----------------------------------------

    /**
     * @notice Sweeps accrued fees for `token` out of the Diamond fee bank to `acs.feeReceiver`.
     * @dev SCRUM-236 pull-payment model. Trading fees (SettlementFacet) and resolution
     *      fees (ConditionalTokensFacet) accrue into the in-Diamond
     *      `acs.accruedFees[token]` accumulator on every settlement / redemption leg.
     *      This function is the only decrement path: it transfers `amount` of `token`
     *      from `address(this)` to `acs.feeReceiver`.
     * @dev Passing `amount == type(uint256).max` drains the full per-token balance
     *      atomically in a single call. The drain-when-empty case resolves to
     *      `amount == 0` and reverts `ZeroAmount` (single error path for "nothing
     *      to withdraw").
     * @dev Owner-only. Under SCRUM-213 the owner is a Gnosis Safe;
     *      `LibDiamond.enforceIsContractOwner` already handles the Safe correctly
     *      (the Safe address is the on-chain owner).
     * @dev Reentrancy: the entire body — accruedFees decrement, external transfer,
     *      event emission — sits inside one `LibReentrancyGuard` window. A malicious
     *      ERC20 with a transfer hook cannot re-enter the Diamond mid-state.
     * @dev Event ordering: decrement -> transfer -> emit, all inside the guard, so an
     *      off-chain indexer never sees a `FeesWithdrawn` for a call that later reverts.
     * @param token The collateral token to sweep
     * @param amount Amount to withdraw, or `type(uint256).max` to drain
     * @custom:emits FeesWithdrawn(token, feeReceiver, amount)
     * @custom:reverts NotContractOwner if caller is not the owner
     * @custom:reverts InvalidTokenAddress if `token == address(0)`
     * @custom:reverts ZeroAmount if the resolved amount is 0 (includes drain-when-empty)
     * @custom:reverts InsufficientAccruedFees(requested, available) if `amount > accruedFees[token]`
     * @custom:reverts InvalidFeeReceiver if `acs.feeReceiver == address(0)`
     * @custom:audit SCRUM-236 §6.1 meta-check — this is a Diamond-as-`from` site; the
     *      symmetric decrement of `accruedFees[token]` preserves
     *      `balance >= outstandingPairs + accruedFees` (INV-SOLV-4-revised).
     */
    function withdrawFees(address token, uint256 amount) external {
        LibDiamond.enforceIsContractOwner();
        if (token == address(0)) revert Errors.InvalidTokenAddress();

        LibAdminConfigStorage.AdminConfigStorage storage acs = LibAdminConfigStorage.adminConfigStorage();

        // SCRUM-236 §6.7: convert the drain idiom via a local before the bounds check.
        // Parameter mutation is avoided — `w` is the resolved amount used everywhere
        // below (state decrement, transfer, event).
        uint256 accrued = acs.accruedFees[token];
        uint256 w = (amount == type(uint256).max) ? accrued : amount;
        if (w == 0) revert Errors.ZeroAmount();
        if (w > accrued) revert Errors.InsufficientAccruedFees(w, accrued);
        address feeReceiver = acs.feeReceiver;
        if (feeReceiver == address(0)) revert Errors.InvalidFeeReceiver();

        // Reentrancy guard wraps the ENTIRE state-mutating + interaction + emit block,
        // per design §6.2.
        LibReentrancyGuard._nonReentrantBefore();
        acs.accruedFees[token] = accrued - w;
        IERC20(token).safeTransfer(feeReceiver, w);
        emit Events.FeesWithdrawn(token, feeReceiver, w);
        LibReentrancyGuard._nonReentrantAfter();
    }

    /**
     * @notice Returns the current per-token balance in the in-Diamond fee bank.
     * @dev SCRUM-236. Counterpart view for `withdrawFees`; used by off-chain treasury
     *      tooling and by the audit harness to assert INV-FEE-NEW symmetry.
     * @param token The collateral token to inspect
     * @return The amount of `token` currently held in `accruedFees[token]`
     */
    function getAccruedFees(address token) external view returns (uint256) {
        return LibAdminConfigStorage.adminConfigStorage().accruedFees[token];
    }
}
