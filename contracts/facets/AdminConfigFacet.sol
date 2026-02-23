// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {LibFeeManager} from "../libraries/LibFeeManager.sol";
import {LibQuoteCurrency} from "../libraries/LibQuoteCurrency.sol";
import {IAdminConfig} from "../interfaces/IAdminConfig.sol";
import {LibDiamond} from "../libraries/LibDiamond.sol";
import {Errors} from "../libraries/Errors.sol";
import {Events} from "../libraries/Events.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/**
 * @title AdminConfigFacet
 * @author Doefin
 * @notice Diamond facet for protocol administration and configuration management
 * @dev Handles collateral tokens, fee configuration, protocol fee withdrawal, and cross-currency conversion paths
 * @dev Only contract owner can modify configuration settings
 * @dev Enhanced version with comprehensive fee management and token symbol support
 */
contract AdminConfigFacet is IAdminConfig {
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
    // NEW: Fee Withdrawal Functions
    // ----------------------------------------

    /**
     * @notice Withdraws accumulated protocol fees for a specific token
     * @dev Delegates to LibFeeManager for fee withdrawal logic and validation
     * @dev If amount is 0, withdraws all available fees for the token
     * @param token The ERC20 token address to withdraw fees for
     * @param amount The amount to withdraw (0 = withdraw all available)
     * @custom:security Only callable by contract owner
     * @custom:note Fees are sent to the currently configured fee receiver
     * @custom:gas Gas cost varies with withdrawal amount and token type
     */
    function withdrawProtocolFees(address token, uint256 amount) external override {
        LibFeeManager.withdrawProtocolFees(token, amount, address(0));
    }

    /**
     * @notice Withdraws accumulated protocol fees to a specific recipient address
     * @dev Allows sending fees to a different address than the configured fee receiver
     * @dev Useful for custom fee distribution or emergency withdrawal scenarios
     * @param token The ERC20 token address to withdraw fees for
     * @param amount The amount to withdraw (0 = withdraw all available)
     * @param recipient The address to receive the withdrawn fees
     * @custom:security Only callable by contract owner
     * @custom:note Bypasses the configured fee receiver for this specific withdrawal
     * @custom:gas Gas cost includes token transfer to custom recipient
     */
    function withdrawProtocolFeesTo(address token, uint256 amount, address recipient) external override {
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
     * @notice Batch withdraws protocol fees for multiple tokens in a single transaction
     * @dev More gas-efficient than individual withdrawals when dealing with multiple tokens
     * @dev Arrays must have equal length; amount[i] applies to tokens[i]
     * @param tokens Array of ERC20 token addresses to withdraw fees for
     * @param amounts Array of amounts to withdraw (0 = withdraw all for that token)
     * @custom:security Only callable by contract owner
     * @custom:note All fees sent to the currently configured fee receiver
     * @custom:gas Significant gas savings for multiple token withdrawals
     * @custom:reverts If arrays have mismatched lengths
     */
    function batchWithdrawProtocolFees(address[] calldata tokens, uint256[] calldata amounts) external override {
        LibFeeManager.batchWithdrawProtocolFees(tokens, amounts, address(0));
    }

    /**
     * @notice Batch withdraws protocol fees for multiple tokens to a specific recipient
     * @dev Combines batch efficiency with custom recipient functionality
     * @dev All withdrawn fees are sent to the single specified recipient address
     * @param tokens Array of ERC20 token addresses to withdraw fees for
     * @param amounts Array of amounts to withdraw (0 = withdraw all for that token)
     * @param recipient The address to receive all withdrawn fees
     * @custom:security Only callable by contract owner
     * @custom:note Bypasses configured fee receiver for all tokens in batch
     * @custom:gas Most efficient method for multi-token fee withdrawal to custom address
     * @custom:reverts If arrays have mismatched lengths or recipient is invalid
     */
    function batchWithdrawProtocolFeesTo(address[] calldata tokens, uint256[] calldata amounts, address recipient) external override {
        LibFeeManager.batchWithdrawProtocolFees(tokens, amounts, recipient);
    }

    // ----------------------------------------
    // NEW: Fee Query Functions
    // ----------------------------------------

    /**
     * @notice Retrieves the accumulated protocol fee balance for a specific token
     * @dev Returns the total amount of fees available for withdrawal
     * @dev Does not include fees that have already been withdrawn
     * @param token The ERC20 token address to query fee balance for
     * @return The accumulated fee amount available for withdrawal
     * @custom:view Read-only function with no state changes
     * @custom:note Balance is updated in real-time as trades and redemptions occur
     */
    function getProtocolFeesBalance(address token) external view override returns (uint256) {
        return LibFeeManager.getAccumulatedFees(token);
    }

    /**
     * @notice Retrieves accumulated protocol fee balances for multiple tokens
     * @dev More gas-efficient than calling getProtocolFeesBalance multiple times
     * @dev Returns array with same length and order as input tokens array
     * @param tokens Array of ERC20 token addresses to query
     * @return fees Array of accumulated fee amounts corresponding to input tokens
     * @custom:view Read-only batch query function
     * @custom:gas Optimized for querying multiple token balances simultaneously
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

    /**
     * @notice Get oracle asset ID path for cross-currency conversion
     * @param fromToken The source token address
     * @param toToken The target token address
     * @return assetIds Array of oracle asset IDs needed for conversion
     */
    function getCrossCurrencyConversionPath(address fromToken, address toToken) external view override returns (bytes32[] memory assetIds) {
        return LibQuoteCurrency.getCrossCurrencyConversionPath(fromToken, toToken);
    }

    // ========================================
    // CONVERSION PATH MANAGEMENT
    // ========================================

    /**
     * @notice Sets a custom oracle asset conversion path between two tokens
     * @dev Enables cross-currency trading by defining oracle price feed routes
     * @dev Asset IDs correspond to oracle price feed identifiers for the conversion chain
     * @dev Allows adding new currency pairs without contract redeployment
     * @param fromToken The source token address for conversion
     * @param toToken The target token address for conversion
     * @param assetIds Array of oracle asset IDs representing the conversion path
     * @custom:emits ConversionPathSet with token addresses and asset ID array
     * @custom:reverts TokenNotAllowed if either token is not whitelisted as collateral
     * @custom:reverts InvalidConversionPath if fromToken equals toToken
     * @custom:security Only callable by contract owner
     * @custom:note Path overwrites any existing configuration for the token pair
     * @custom:example For USDC→BTC: assetIds could be ["ETH/USD", "BTC/ETH"] for routing
     */
    function setConversionPath(address fromToken, address toToken, bytes32[] calldata assetIds) external override {
        LibDiamond.enforceIsContractOwner();

        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        // Validate both tokens are allowed
        if (!ds.adminConfigStorage.isAllowed[fromToken] || !ds.adminConfigStorage.isAllowed[toToken]) {
            revert Errors.TokenNotAllowed();
        }

        // Validate tokens are different
        if (fromToken == toToken) {
            revert Errors.InvalidConversionPath();
        }

        // Store the conversion path
        bytes32 pathKey = keccak256(abi.encodePacked(fromToken, toToken));
        ds.adminConfigStorage.conversionPaths[pathKey] = assetIds;

        emit Events.ConversionPathSet(fromToken, toToken, assetIds);
    }

    /**
     * @notice Remove a custom conversion path between two tokens
     * @param fromToken The source token address
     * @param toToken The target token address
     * @dev Reverts to hardcoded fallback logic if available
     */
    function removeConversionPath(address fromToken, address toToken) external override {
        LibDiamond.enforceIsContractOwner();

        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        bytes32 pathKey = keccak256(abi.encodePacked(fromToken, toToken));

        // Delete the conversion path
        delete ds.adminConfigStorage.conversionPaths[pathKey];

        emit Events.ConversionPathRemoved(fromToken, toToken);
    }

    /**
     * @notice Get the configured conversion path for a token pair
     * @param fromToken The source token address
     * @param toToken The target token address
     * @return assetIds The configured asset IDs, or empty array if not configured
     */
    function getConfiguredConversionPath(address fromToken, address toToken) external view override returns (bytes32[] memory assetIds) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        bytes32 pathKey = keccak256(abi.encodePacked(fromToken, toToken));

        bytes32[] storage configuredPath = ds.adminConfigStorage.conversionPaths[pathKey];
        assetIds = new bytes32[](configuredPath.length);

        for (uint256 i = 0; i < configuredPath.length; i++) {
            assetIds[i] = configuredPath[i];
        }
    }
}
