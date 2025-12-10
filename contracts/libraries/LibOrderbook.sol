// SPDX-License-Identifier: AGPL-3.0
// Uses shared storage derived from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {LibCollateralManager} from "./LibCollateralManager.sol";
import {LibFeeManager} from "./LibFeeManager.sol";
import {LibCrossCurrencySettlement} from "./LibCrossCurrencySettlement.sol";
import {LibMatchEngine} from "../libraries/LibMatchEngine.sol";
import {LibSettlement} from "../libraries/LibSettlement.sol";
import {LibQuoteCurrency} from "./LibQuoteCurrency.sol";
import {Errors} from "./Errors.sol";
import {Events} from "./Events.sol";

/// @title LibOrderbook - Handles creation, modification, and cancellation of orders
library LibOrderbook {
    using LibDoefinStorage for LibDoefinStorage.AppStorage;

    /// @notice Create a new limit order and lock collateral
    function createOrder(
        uint256 positionId,
        address collateralToken,
        uint256 amount,
        uint256 pricePerToken,
        uint256 minFillAmount,
        uint256 expiry,
        bool fillOrKill,
        LibDoefinStorage.OrderDirection direction,
        LibDoefinStorage.ExecutionType executionType,
        LibDoefinStorage.OrderType orderType,
        LibDoefinStorage.CrossCurrencyConfig memory crossCurrencyConfig
    ) internal returns (uint256 orderId) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        uint256 unitsPerPair = ds.adminConfigStorage.unitPerPair[collateralToken];
        if (unitsPerPair == 0) revert Errors.TokenNotAllowed();
        if (pricePerToken >= unitsPerPair || pricePerToken == 0) revert Errors.InvalidPrice();
        if (amount < minFillAmount || amount == 0) revert Errors.InvalidAmounts();
        if (expiry != 0 && expiry <= block.timestamp) revert Errors.OrderCreatedWithPastExpiry();

        if (orderType == LibDoefinStorage.OrderType.CrossCurrency) {
            if (crossCurrencyConfig.quoteCurrencyToken == address(0)) revert Errors.InvalidQuoteCurrencyToken();
            if (crossCurrencyConfig.quoteCurrencyToken == collateralToken) revert Errors.SameCollateralAndQuoteCurrency();
            if (crossCurrencyConfig.exchangeRateType == LibDoefinStorage.ExchangeRateType.Dynamic) {
                (, bool isStale) = LibQuoteCurrency.getOracleExchangeRate(crossCurrencyConfig.quoteCurrencyToken, collateralToken);
                if (isStale) revert Errors.OraclePriceStale();
            }
        } else if (
            crossCurrencyConfig.quoteCurrencyToken != address(0) ||
            crossCurrencyConfig.exchangeRate != 0 ||
            uint8(crossCurrencyConfig.exchangeRateType) != 0
        ) {
            revert Errors.UnexpectedCrossCurrencyConfig();
        }

        orderId = ds.orderbookStorage.nextOrderId++;

        LibDoefinStorage.OrderFeeConfig memory orderFeeConfig = LibFeeManager.getMarketFees();

        LibDoefinStorage.Order memory order = LibDoefinStorage.Order({
            orderId: orderId,
            positionId: positionId,
            amount: amount,
            remainingAmount: amount,
            minFillAmount: minFillAmount,
            pricePerToken: pricePerToken,
            expiry: expiry,
            createdAt: block.timestamp,
            exchangeRate: crossCurrencyConfig.exchangeRate,
            maker: msg.sender,
            direction: direction,
            executionType: executionType,
            orderType: orderType,
            exchangeRateType: crossCurrencyConfig.exchangeRateType,
            active: true,
            fillOrKill: fillOrKill,
            collateralToken: collateralToken,
            makerFeeBps: orderFeeConfig.makerFeeBps,
            takerFeeBps: orderFeeConfig.takerFeeBps,
            quoteCurrencyToken: crossCurrencyConfig.quoteCurrencyToken
        });

        LibQuoteCurrency.validateCrossCurrencyOrder(order);

        bool isLimit = executionType == LibDoefinStorage.ExecutionType.Limit;
        if (isLimit) {
            if (order.direction == LibDoefinStorage.OrderDirection.Buy) {
                if (order.orderType == LibDoefinStorage.OrderType.CrossCurrency) {
                    uint256 totalQuoteRequired = LibCrossCurrencySettlement.calculateRequiredQuoteAmount(order, order.amount);
                    uint256 quoteUnitPerPair = ds.adminConfigStorage.unitPerPair[order.quoteCurrencyToken];
                    LibCollateralManager.lockERC20Collateral(order.maker, order.quoteCurrencyToken, totalQuoteRequired, quoteUnitPerPair, 0);
                } else {
                    LibCollateralManager.lockERC20Collateral(
                        order.maker,
                        order.collateralToken,
                        order.amount,
                        order.pricePerToken,
                        order.makerFeeBps
                    );
                }
            } else {
                LibCollateralManager.lockERC1155Collateral(order.maker, order.positionId, order.amount);
            }
        }

        ds.orderbookStorage.orders[orderId] = order;
        if (isLimit) _insertSorted(order);

        emit Events.OrderCreated(
            orderId,
            msg.sender,
            positionId,
            collateralToken,
            amount,
            pricePerToken,
            minFillAmount,
            expiry,
            direction,
            executionType,
            fillOrKill,
            order.makerFeeBps,
            order.takerFeeBps,
            orderType,
            order.quoteCurrencyToken,
            order.exchangeRateType,
            order.exchangeRate
        );

        uint256[] memory makerIds = LibMatchEngine.findPotentialMatchesForOrder(orderId);
        if (makerIds.length > 0) {
            LibSettlement.fillOrders(orderId, makerIds);
        }
    }

    /// @notice Cancel an open order and release collateral
    function cancelOrder(uint256 orderId, address sender) internal {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[orderId];
        if (order.maker != sender) revert Errors.NotAuthorizedToCancel();

        uint256 remainingAmount = order.remainingAmount;

        if (order.direction == LibDoefinStorage.OrderDirection.Buy) {
            if (order.orderType == LibDoefinStorage.OrderType.CrossCurrency) {
                uint256 totalQuoteToRelease = LibCrossCurrencySettlement.calculateRequiredQuoteAmount(order, order.remainingAmount);
                uint256 quoteUnitPerPair = ds.adminConfigStorage.unitPerPair[order.quoteCurrencyToken];
                LibCollateralManager.releaseERC20Collateral(order.maker, order.quoteCurrencyToken, totalQuoteToRelease, quoteUnitPerPair, 0);
            } else {
                LibCollateralManager.releaseERC20Collateral(
                    order.maker,
                    order.collateralToken,
                    order.remainingAmount,
                    order.pricePerToken,
                    order.makerFeeBps
                );
            }
        } else {
            LibCollateralManager.releaseERC1155Collateral(order.maker, order.positionId, order.remainingAmount);
        }
        removeOrderFromOrderbook(order);

        delete ds.orderbookStorage.orders[orderId];
        emit Events.OrderCancelled(orderId, sender, remainingAmount);
    }

    /// @notice Modify an open order
    function modifyOrder(
        address maker,
        uint256 orderId,
        uint256 newAmount,
        uint256 newPricePerToken,
        uint256 newMinFillAmount,
        uint256 newExpiry
    ) internal {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[orderId];

        if (order.maker != maker) revert Errors.NotAuthorizedToCancel();
        if (!order.active) revert Errors.OrderNotActive();
        if (order.expiry != 0 && block.timestamp >= order.expiry) revert Errors.OrderExpired();
        if (order.remainingAmount != order.amount) revert Errors.PartiallyFilledOrdersNotModifiable();

        LibDoefinStorage.ModifyCollateralContext memory modifyCtx = LibDoefinStorage.ModifyCollateralContext({
            positionId: order.positionId,
            oldAmount: order.amount,
            newAmount: newAmount,
            oldPrice: order.pricePerToken,
            newPrice: newPricePerToken,
            maker: maker,
            makerFeeBps: order.makerFeeBps,
            collateralToken: order.collateralToken,
            direction: order.direction
        });
        LibCollateralManager.adjustCollateralForModifiedOrder(modifyCtx);

        uint256 oldMinFill = order.minFillAmount;
        uint256 oldExpiry = order.expiry;

        order.amount = newAmount;
        order.remainingAmount = newAmount;
        order.pricePerToken = newPricePerToken;
        order.minFillAmount = newMinFillAmount;
        order.expiry = newExpiry;

        if (newPricePerToken != modifyCtx.oldPrice) {
            removeOrderFromOrderbook(order);
            _insertSorted(order);
        }

        emit Events.OrderModified(
            orderId,
            maker,
            modifyCtx.oldAmount,
            newAmount,
            modifyCtx.oldPrice,
            newPricePerToken,
            oldMinFill,
            newMinFillAmount,
            oldExpiry,
            newExpiry
        );
    }

    function _insertSorted(LibDoefinStorage.Order memory order) internal {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        uint256[] storage book = order.direction == LibDoefinStorage.OrderDirection.Buy
            ? ds.orderbookStorage.buyOrdersByPosition[order.positionId]
            : ds.orderbookStorage.sellOrdersByPosition[order.positionId];

        uint256 price = order.pricePerToken;
        if (order.orderType == LibDoefinStorage.OrderType.CrossCurrency) {
            bool useOracleRate = (order.exchangeRateType == LibDoefinStorage.ExchangeRateType.Dynamic);
            (uint256 quoteCurrencyPrice, bool isStale) = LibQuoteCurrency.calculateQuoteCurrencyPrice(order, useOracleRate);
            if (isStale) {
                revert Errors.OraclePriceStale();
            }
            price = quoteCurrencyPrice;
        }

        uint256 left = 0;
        uint256 right = book.length;

        while (left < right) {
            uint256 mid = (left + right) / 2;
            LibDoefinStorage.Order storage existingOrder = ds.orderbookStorage.orders[book[mid]];
            uint256 existingPrice = existingOrder.pricePerToken;

            if (existingOrder.orderType == LibDoefinStorage.OrderType.CrossCurrency) {
                bool useExistingOracleRate = (existingOrder.exchangeRateType == LibDoefinStorage.ExchangeRateType.Dynamic);
                (uint256 existingQuotePrice, bool existingIsStale) = LibQuoteCurrency.calculateQuoteCurrencyPrice(
                    existingOrder,
                    useExistingOracleRate
                );
                if (existingIsStale) {
                    revert Errors.OraclePriceStale();
                }
                existingPrice = existingQuotePrice;
            }

            if (
                price == existingPrice
                    ? order.createdAt < existingOrder.createdAt
                    : (order.direction == LibDoefinStorage.OrderDirection.Sell ? price < existingPrice : price > existingPrice)
            ) {
                right = mid;
            } else {
                left = mid + 1;
            }
        }

        book.push(order.orderId);
        for (uint256 j = book.length - 1; j > left; j--) {
            book[j] = book[j - 1];
        }
        book[left] = order.orderId;
    }

    /// @dev Remove an orderId from orderbook array
    function removeOrderFromOrderbook(LibDoefinStorage.Order memory order) internal {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        uint256[] storage book = order.direction == LibDoefinStorage.OrderDirection.Buy
            ? ds.orderbookStorage.buyOrdersByPosition[order.positionId]
            : ds.orderbookStorage.sellOrdersByPosition[order.positionId];

        uint256 len = book.length;

        for (uint256 i = 0; i < len; i++) {
            if (book[i] == order.orderId) {
                for (uint256 j = i; j < len - 1; j++) {
                    book[j] = book[j + 1];
                }
                book.pop();
                break;
            }
        }
    }
}
