// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {IOracleManager} from "../interfaces/IOracleManager.sol";
import {Errors} from "./Errors.sol";

/**
 * @title LibQuoteCurrency
 * @notice Helper library for cross-currency order quote currency operations
 * @dev Handles mapping quote currencies to oracle asset IDs and price calculations
 */
library LibQuoteCurrency {
    using LibDoefinStorage for LibDoefinStorage.AppStorage;

    /**
     * @notice Get exchange rate from oracle for quote currency conversion
     * @param quoteCurrencyToken Quote currency token address
     * @param baseCollateralToken Base collateral token address
     * @return exchangeRate Rate to convert base to quote currency (scaled by 1e18)
     * @return isStale Whether the oracle price is stale
     */
    function getOracleExchangeRate(
        address quoteCurrencyToken,
        address baseCollateralToken
    ) internal view returns (uint256 exchangeRate, bool isStale) {
        // For same currency, return 1:1 rate
        if (quoteCurrencyToken == baseCollateralToken) {
            return (1e18, false);
        }

        // Get conversion path from AdminConfig storage
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        bytes32[] memory assetIds = _getCrossCurrencyConversionPath(ds, baseCollateralToken, quoteCurrencyToken);

        if (assetIds.length == 0) {
            revert Errors.IncompatibleQuoteCurrencies();
        }

        IOracleManager oracle = IOracleManager(address(this));
        uint256 cumulativeRate = 1e18;

        // Apply conversions in sequence
        for (uint256 i = 0; i < assetIds.length; i++) {
            (uint256 price, , bool isPaused) = oracle.getPrice(assetIds[i]);

            if (isPaused) {
                return (0, true);
            }

            // Normalize price and apply to cumulative rate
            uint256 normalizedPrice = _normalizeOraclePrice(price, assetIds[i]);

            // For inverse conversions (e.g., USD->USDC when we have USD-USDC rate)
            // We need to determine the direction based on asset ID and our conversion path
            bool isInverse = _isInverseConversion(assetIds[i], quoteCurrencyToken);

            if (isInverse) {
                // Inverse rate: 1 / price
                cumulativeRate = (cumulativeRate * 1e18) / normalizedPrice;
            } else {
                // Direct rate: price
                cumulativeRate = (cumulativeRate * normalizedPrice) / 1e18;
            }
        }

        return (cumulativeRate, false);
    }

    /**
     * @notice Calculate effective quote currency price for a cross-currency order
     * @param order The cross-currency order
     * @param useOracleRate Whether to use oracle rate (for dynamic) or order rate (for fixed)
     * @return quoteCurrencyPrice Price per token in quote currency (scaled by quote currency decimals)
     * @return isStale Whether the calculation used stale oracle data
     * @dev Uses 1e36 scaling to prevent precision loss with large exchange rates:
     *      quoteCurrencyPrice = (pricePerToken × quoteUnitPerPair × 1e36) ÷ (collateralUnitPerPair × exchangeRate)
     *      This maintains 1e18 scaling in the result for accurate order matching comparisons.
     * @dev Example: For exchangeRate = 96000e18 (BTC/USD), without 1e36 scaling:
     *      (650000 × 1e6 × 1e18) ÷ (1e8 × 96000e18) ≈ 0 (underflow)
     *      With 1e36: (650000 × 1e6 × 1e36) ÷ (1e8 × 96000e18) = proper result
     */
    function calculateQuoteCurrencyPrice(
        LibDoefinStorage.Order memory order,
        bool useOracleRate
    ) internal view returns (uint256 quoteCurrencyPrice, bool isStale) {
        if (order.orderType != LibDoefinStorage.OrderType.CrossCurrency) {
            revert Errors.InvalidOrderType();
        }

        uint256 exchangeRate;

        if (useOracleRate) {
            (exchangeRate, isStale) = getOracleExchangeRate(order.crossCurrencyConfig.quoteCurrencyToken, order.collateralToken);
            if (isStale) {
                return (0, true);
            }
        } else {
            exchangeRate = order.crossCurrencyConfig.exchangeRate;
            isStale = false;
        }

        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        uint256 collateralUnitPerPair = ds.adminConfigStorage.unitPerPair[order.collateralToken];
        uint256 quoteUnitPerPair = ds.adminConfigStorage.unitPerPair[order.crossCurrencyConfig.quoteCurrencyToken];

        quoteCurrencyPrice = (order.pricePerToken * quoteUnitPerPair * 1e36) / (collateralUnitPerPair * exchangeRate);
    }

    /**
     * @notice Check if two cross-currency orders are compatible for matching
     * @param makerOrder The maker order
     * @param takerOrder The taker order
     * @return compatible Whether the orders can be matched
     */
    function areOrdersCompatible(
        LibDoefinStorage.Order memory makerOrder,
        LibDoefinStorage.Order memory takerOrder
    ) internal pure returns (bool compatible) {
        // Both must be cross-currency orders
        if (makerOrder.orderType != LibDoefinStorage.OrderType.CrossCurrency || takerOrder.orderType != LibDoefinStorage.OrderType.CrossCurrency) {
            return false;
        }

        // Must have same quote currency
        if (makerOrder.crossCurrencyConfig.quoteCurrencyToken != takerOrder.crossCurrencyConfig.quoteCurrencyToken) {
            return false;
        }

        // Must be on same position (complementary matching only)
        if (makerOrder.positionId != takerOrder.positionId) {
            return false;
        }

        // Must be opposite directions
        if (makerOrder.direction == takerOrder.direction) {
            return false;
        }

        return true;
    }

    /**
     * @notice Validate cross-currency order configuration
     * @param order The order to validate
     */
    function validateCrossCurrencyOrder(LibDoefinStorage.Order memory order) internal view {
        if (order.orderType != LibDoefinStorage.OrderType.CrossCurrency) {
            return;
        }

        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        // Validate quote currency is allowed
        if (ds.adminConfigStorage.unitPerPair[order.crossCurrencyConfig.quoteCurrencyToken] == 0) {
            revert Errors.TokenNotAllowed();
        }

        // Buy orders must use Fixed exchange rate
        if (
            order.direction == LibDoefinStorage.OrderDirection.Buy &&
            order.crossCurrencyConfig.exchangeRateType != LibDoefinStorage.ExchangeRateType.Fixed
        ) {
            revert Errors.BuyOrdersMustUseFixedRate();
        }

        // Validate exchange rate is reasonable (non-zero)
        if (order.crossCurrencyConfig.exchangeRate == 0) {
            revert Errors.InvalidExchangeRate();
        }
    }

    // Internal helper functions

    /**
     * @notice Get token symbol from admin config storage
     * @param token The token address
     * @return symbol The token symbol
     */
    function _getTokenSymbol(address token) internal view returns (string memory symbol) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        // Get symbol from stored mapping (populated when token is added via AdminConfigFacet)
        symbol = ds.adminConfigStorage.tokenSymbols[token];

        // Fallback if symbol is empty or not set
        if (bytes(symbol).length == 0) {
            return "UNKNOWN";
        }

        return symbol;
    }

    /**
     * @notice Normalize oracle price to 1e18 scale
     * @param oraclePrice Raw price from oracle
     * @param assetId Asset identifier to read decimals configuration
     * @return normalizedPrice Price scaled to 1e18
     */
    function _normalizeOraclePrice(uint256 oraclePrice, bytes32 assetId) internal view returns (uint256 normalizedPrice) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        uint8 decimals = ds.oracleStorage.assetConfigs[assetId].decimals;

        // Default to 18 decimals if not configured
        if (decimals == 0) {
            decimals = 18;
        }

        // Ensure decimals is within valid range
        if (decimals > 18) {
            revert Errors.InvalidOracleDecimals(assetId, decimals);
        }

        // Calculate scale factor: 10^(18 - decimals)
        // If decimals == 18, scale factor is 1 (no scaling needed)
        // If decimals < 18, we multiply to scale up to 18 decimals
        uint256 scaleFactor = 10 ** (18 - decimals);

        // Use checked arithmetic to prevent overflow
        normalizedPrice = oraclePrice * scaleFactor;
    }

    /**
     * @notice Determine if a conversion step requires inverse calculation
     * @param assetId The oracle asset ID being used
     * @param quoteToken The quote token we're converting to
     * @return isInverse Whether to apply inverse calculation
     */
    function _isInverseConversion(bytes32 assetId, address quoteToken) internal view returns (bool isInverse) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        string memory quoteSymbol = ds.adminConfigStorage.tokenSymbols[quoteToken];

        // For BTC->USD conversions
        if (assetId == keccak256("BTC-USD")) {
            // If we're going FROM BTC, use direct rate
            // If we're going TO BTC, use inverse rate
            return keccak256(bytes(quoteSymbol)) == keccak256("BTC");
        }

        // For USD stablecoin conversions (USD-USDC, USD-USDT)
        if (assetId == keccak256("USD-USDC")) {
            // USD-USDC gives USD per USDC
            // If we want USDC per USD (i.e., going TO USDC), use inverse
            return keccak256(bytes(quoteSymbol)) == keccak256("USDC");
        }

        if (assetId == keccak256("USD-USDT")) {
            // USD-USDT gives USD per USDT
            // If we want USDT per USD (i.e., going TO USDT), use inverse
            return keccak256(bytes(quoteSymbol)) == keccak256("USDT");
        }

        return false;
    }

    /**
     * @notice Get oracle asset ID path for cross-currency conversion
     * @param fromToken The source token address
     * @param toToken The target token address
     * @return assetIds Array of oracle asset IDs needed for conversion
     */
    function getCrossCurrencyConversionPath(address fromToken, address toToken) internal view returns (bytes32[] memory assetIds) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        return _getCrossCurrencyConversionPath(ds, fromToken, toToken);
    }

    /**
     * @notice Internal helper for cross-currency conversion path logic
     * @param ds The app storage reference
     * @param fromToken The source token address
     * @param toToken The target token address
     * @return assetIds Array of oracle asset IDs needed for conversion
     */
    function _getCrossCurrencyConversionPath(
        LibDoefinStorage.AppStorage storage ds,
        address fromToken,
        address toToken
    ) internal view returns (bytes32[] memory assetIds) {
        // Validate both tokens are allowed
        if (!ds.adminConfigStorage.isAllowed[fromToken] || !ds.adminConfigStorage.isAllowed[toToken]) {
            revert Errors.TokenNotAllowed();
        }

        // Same token - no conversion needed
        if (fromToken == toToken) {
            assetIds = new bytes32[](0);
            return assetIds;
        }

        // Check if a configured conversion path exists
        bytes32 pathKey = keccak256(abi.encodePacked(fromToken, toToken));
        bytes32[] storage configuredPath = ds.adminConfigStorage.conversionPaths[pathKey];

        if (configuredPath.length > 0) {
            // Return the configured path
            assetIds = new bytes32[](configuredPath.length);
            for (uint256 i = 0; i < configuredPath.length; i++) {
                assetIds[i] = configuredPath[i];
            }
            return assetIds;
        }

        // Fallback to hardcoded logic for backward compatibility
        string memory fromSymbol = ds.adminConfigStorage.tokenSymbols[fromToken];
        string memory toSymbol = ds.adminConfigStorage.tokenSymbols[toToken];
        bytes32 fromHash = keccak256(bytes(fromSymbol));
        bytes32 toHash = keccak256(bytes(toSymbol));

        // Direct USD stablecoin conversions
        if ((fromHash == keccak256("USDC") && toHash == keccak256("USDT")) || (fromHash == keccak256("USDT") && toHash == keccak256("USDC"))) {
            assetIds = new bytes32[](2);
            assetIds[0] = keccak256("USD-USDC");
            assetIds[1] = keccak256("USD-USDT");
            return assetIds;
        }

        // BTC to USD stablecoins (2-step conversion)
        if (fromHash == keccak256("BTC") && (toHash == keccak256("USDC") || toHash == keccak256("USDT"))) {
            assetIds = new bytes32[](2);
            assetIds[0] = keccak256("BTC-USD");
            assetIds[1] = toHash == keccak256("USDC") ? keccak256("USD-USDC") : keccak256("USD-USDT");
            return assetIds;
        }

        // USD stablecoins to BTC (2-step conversion)
        if ((fromHash == keccak256("USDC") || fromHash == keccak256("USDT")) && toHash == keccak256("BTC")) {
            assetIds = new bytes32[](2);
            assetIds[0] = fromHash == keccak256("USDC") ? keccak256("USD-USDC") : keccak256("USD-USDT");
            assetIds[1] = keccak256("BTC-USD");
            return assetIds;
        }

        // Fallback - empty array indicates no known conversion path
        assetIds = new bytes32[](0);
    }
}
