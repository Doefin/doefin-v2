// SPDX-License-Identifier: AGPL-3.0
// Uses shared storage derived from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {LibEscrowLogic} from "./LibEscrowLogic.sol";
import {LibMatchEngine} from "../libraries/LibMatchEngine.sol";
import {LibSettlement} from "../libraries/LibSettlement.sol";
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
        LibDoefinStorage.ExecutionType executionType
    ) internal returns (uint256 orderId) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        uint256 unitsPerPair = ds.adminConfigStorage.unitPerPair[collateralToken];
        if (unitsPerPair == 0) {
            revert Errors.TokenNotAllowed();
        }
        if (pricePerToken >= unitsPerPair || pricePerToken == 0) {
            revert Errors.InvalidPrice();
        }
        if (amount < minFillAmount || amount == 0) {
            revert Errors.InvalidAmounts();
        }
        if (expiry != 0 && expiry <= block.timestamp) {
            revert Errors.OrderCreatedWithPastExpiry();
        }

        orderId = ds.orderbookStorage.nextOrderId++;

        LibDoefinStorage.OrderFeeConfig memory orderFeeConfig = LibEscrowLogic.getMarketFees();

        LibDoefinStorage.Order memory order = LibDoefinStorage.Order({
            orderId: orderId,
            maker: msg.sender,
            positionId: positionId,
            collateralToken: collateralToken,
            amount: amount,
            remainingAmount: amount,
            pricePerToken: pricePerToken,
            minFillAmount: minFillAmount,
            expiry: expiry,
            direction: direction,
            createdAt: block.timestamp,
            active: true,
            orderFeeConfig: orderFeeConfig,
            executionType: executionType,
            fillOrKill: fillOrKill
        });

        if (order.executionType == LibDoefinStorage.ExecutionType.Limit) {
            LibEscrowLogic.lockCollateral(order);
        }

        ds.orderbookStorage.orders[orderId] = order;
        if (order.executionType == LibDoefinStorage.ExecutionType.Limit) {
            _insertSorted(order);
        }

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
            orderFeeConfig.makerFeeBps,
            orderFeeConfig.takerFeeBps
        );

        _tryFillImmediately(orderId);
    }

    function _tryFillImmediately(uint256 orderId) internal {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        uint256[] memory makerIds = LibMatchEngine.findPotentialMatchesForOrder(orderId);

        if (makerIds.length > 0) {
            LibSettlement.fillOrders(orderId, makerIds);

            // Re-read from storage after execution
            LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[orderId];
            if (order.executionType == LibDoefinStorage.ExecutionType.Market && order.fillOrKill && order.remainingAmount > 0) {
                revert Errors.FillOrKillFailed();
            }
        } else {
            LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[orderId];

            if (order.executionType == LibDoefinStorage.ExecutionType.Market && order.fillOrKill) {
                revert Errors.FillOrKillFailed();
            }
        }
    }

    /// @notice Cancel an open order and release collateral
    function cancelOrder(uint256 orderId, address sender) internal {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[orderId];
        if (order.maker != sender) revert Errors.NotAuthorizedToCancel();

        uint256 remainingAmount = order.remainingAmount;

        LibEscrowLogic.releaseCollateral(order);
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
            maker: maker,
            collateralToken: order.collateralToken,
            positionId: order.positionId,
            makerFeeBps: order.orderFeeConfig.makerFeeBps,
            oldAmount: order.amount,
            newAmount: newAmount,
            oldPrice: order.pricePerToken,
            newPrice: newPricePerToken,
            direction: order.direction
        });
        // Adjust collateral if the total cost decreased or increased
        LibEscrowLogic.adjustCollateralForModifiedOrder(modifyCtx);

        uint256 oldMinFill = order.minFillAmount;
        uint256 oldExpiry = order.expiry;

        order.amount = newAmount;
        order.remainingAmount = newAmount;
        order.pricePerToken = newPricePerToken;
        order.minFillAmount = newMinFillAmount;
        order.expiry = newExpiry;

        // Reorder the book if the price has changed.
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

        // Binary search for insertion index - O(log n)
        uint256 left = 0;
        uint256 right = book.length;

        while (left < right) {
            uint256 mid = (left + right) / 2;
            uint256 existingPrice = ds.orderbookStorage.orders[book[mid]].pricePerToken;

            // Ascending for Sell (lowest price first)
            // Descending for Buy (highest price first)
            if (
                (order.direction == LibDoefinStorage.OrderDirection.Sell && price < existingPrice) ||
                (order.direction == LibDoefinStorage.OrderDirection.Buy && price > existingPrice)
            ) {
                right = mid;
            } else {
                left = mid + 1;
            }
        }

        // Insert at position left
        book.push(order.orderId); // expand length
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
