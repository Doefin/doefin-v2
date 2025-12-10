// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {LibQuoteCurrency} from "./LibQuoteCurrency.sol";
import {Errors} from "./Errors.sol";

library LibCrossCurrencySettlement {
    /**
     * @notice Check if trade involves cross-currency orders
     */
    function isCrossCurrencyTrade(uint256 takerOrderId, uint256 makerOrderId) internal view returns (bool) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        bool takerIsCrossCurrency = false;
        if (takerOrderId != 0) {
            takerIsCrossCurrency = (ds.orderbookStorage.orders[takerOrderId].orderType == LibDoefinStorage.OrderType.CrossCurrency);
        }

        bool makerIsCrossCurrency = (ds.orderbookStorage.orders[makerOrderId].orderType == LibDoefinStorage.OrderType.CrossCurrency);

        return takerIsCrossCurrency || makerIsCrossCurrency;
    }

    /**
     * @notice Validate cross-currency match and calculate price
     */
    function validateCrossCurrencyMatch(
        LibDoefinStorage.Order memory takerOrder,
        LibDoefinStorage.Order memory makerOrder
    ) internal view returns (bool crossing, LibDoefinStorage.MatchType matchType, uint256 price) {
        // Only complementary matching supported
        if (takerOrder.direction == makerOrder.direction || takerOrder.positionId != makerOrder.positionId) {
            return (false, LibDoefinStorage.MatchType.Complementary, 0);
        }

        matchType = LibDoefinStorage.MatchType.Complementary;

        // Validate compatibility
        if (takerOrder.orderType == LibDoefinStorage.OrderType.CrossCurrency && makerOrder.orderType == LibDoefinStorage.OrderType.CrossCurrency) {
            if (!LibQuoteCurrency.areOrdersCompatible(takerOrder, makerOrder)) {
                return (false, matchType, 0);
            }
        } else if (takerOrder.orderType != makerOrder.orderType) {
            return (false, matchType, 0); // Mixed types not allowed
        }

        // Calculate quote currency price
        if (makerOrder.orderType == LibDoefinStorage.OrderType.CrossCurrency) {
            bool useOracleRate = (makerOrder.exchangeRateType == LibDoefinStorage.ExchangeRateType.Dynamic);
            (uint256 quoteCurrencyPrice, bool isStale) = LibQuoteCurrency.calculateQuoteCurrencyPrice(makerOrder, useOracleRate);

            if (useOracleRate && isStale) {
                return (false, matchType, 0);
            }

            if (takerOrder.direction == LibDoefinStorage.OrderDirection.Buy) {
                price = (quoteCurrencyPrice * (10_000 + makerOrder.takerFeeBps)) / 10_000;
            } else {
                price = (quoteCurrencyPrice * (10_000 - makerOrder.takerFeeBps)) / 10_000;
            }
        } else {
            revert Errors.InvalidOrderType();
        }

        // Check price crossing
        if (takerOrder.executionType == LibDoefinStorage.ExecutionType.Market) {
            crossing = true;
        } else {
            crossing = takerOrder.direction == LibDoefinStorage.OrderDirection.Buy
                ? takerOrder.pricePerToken >= price
                : takerOrder.pricePerToken <= price;
        }
    }

    /**
     * @notice Calculate required quote currency amount for cross-currency order
     */
    function calculateRequiredQuoteAmount(LibDoefinStorage.Order memory order, uint256 amount) internal view returns (uint256) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        uint256 collateralUnit = ds.adminConfigStorage.unitPerPair[order.collateralToken];
        if (collateralUnit == 0) revert Errors.InvalidUnitPerPair();

        uint256 exchangeRate;
        if (order.exchangeRateType == LibDoefinStorage.ExchangeRateType.Dynamic) {
            (exchangeRate, ) = LibQuoteCurrency.getOracleExchangeRate(order.quoteCurrencyToken, order.collateralToken);
        } else {
            exchangeRate = order.exchangeRate;
        }

        if (exchangeRate == 0) revert Errors.InvalidExchangeRate();
        uint256 quoteAmount = (((amount * order.pricePerToken) / collateralUnit) * exchangeRate) / 1e18;
        return quoteAmount + (quoteAmount * order.makerFeeBps) / 10000;
    }
}
