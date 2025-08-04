// SPDX-License-Identifier: AGPL-3.0
// Uses shared storage derived from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {LibEscrowLogic} from "./LibEscrowLogic.sol";

/// @title LibOrderbook - Handles creation, modification, and cancellation of orders
library LibOrderbook {
    using LibDoefinStorage for LibDoefinStorage.DiamondStorage;

    /// @notice Create a new limit order and lock collateral
    function createOrder(
        uint256 positionId,
        address collateralToken,
        uint256 amount,
        uint256 pricePerToken,
        uint256 minFillAmount,
        uint256 expiry,
        LibDoefinStorage.OrderDirection direction
    ) internal returns (uint256 orderId) {
        require(pricePerToken <= 1e18, "Invalid price");
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

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
            __gap: [uint256(0), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        });

        LibEscrowLogic.lockCollateral(order);

        ds.orderbookStorage.orders[orderId] = order;
        _insertSorted(order);

        // emit LibDoefinStorage.OrderCreated(
        //     orderId,
        //     msg.sender,
        //     positionId,
        //     amount,
        //     pricePerToken,
        //     block.timestamp,
        //     direction,
        //     0x0 // conditionId optional for now
        // );
    }

    /// @notice Cancel an open order and release collateral
    function cancelOrder(uint256 orderId, address sender) internal {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[orderId];

        require(order.maker == sender, "Only maker can cancel order");

        LibEscrowLogic.releaseCollateral(order);
        _removeOrder(orderId, order.positionId, order.direction);

        delete ds.orderbookStorage.orders[orderId];
        // emit LibDoefinStorage.OrderCanceled(orderId);
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
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[orderId];

        require(order.maker == maker, "Orderbook: Not owner");
        require(order.active, "Order is not active");
        require(order.expiry == 0 || block.timestamp < order.expiry, "Order expired");
        require(order.remainingAmount == order.amount, "Partially filled orders cannot be modified");

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

        order.amount = newAmount;
        order.remainingAmount = newAmount;
        order.pricePerToken = newPricePerToken;
        order.minFillAmount = newMinFillAmount;
        order.expiry = newExpiry;

        // Reorder the book if the price has changed.
        if (newPricePerToken != order.pricePerToken) {
            _removeOrder(orderId, order.positionId, order.direction);
            _insertSorted(order);
        }

        // emit LibDoefinStorage.OrderUpdated(orderId, newAmount, newPricePerToken, newMinFillAmount, newExpiry);
    }

    function _insertSorted(LibDoefinStorage.Order memory order) internal {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        uint256[] storage book = order.direction == LibDoefinStorage.OrderDirection.Buy
            ? ds.orderbookStorage.buyOrdersByPosition[order.positionId]
            : ds.orderbookStorage.sellOrdersByPosition[order.positionId];

        uint256 price = order.pricePerToken;

        uint256 i = 0;

        // Ascending for Sell (lowest price first)
        // Descending for Buy (highest price first)
        while (i < book.length) {
            uint256 existingPrice = ds.orderbookStorage.orders[book[i]].pricePerToken;
            if (
                (order.direction == LibDoefinStorage.OrderDirection.Sell && price < existingPrice) ||
                (order.direction == LibDoefinStorage.OrderDirection.Buy && price > existingPrice)
            ) {
                break;
            }
            i++;
        }

        // Insert at position i
        book.push(order.orderId); // expand length
        for (uint256 j = book.length - 1; j > i; j--) {
            book[j] = book[j - 1];
        }
        book[i] = order.orderId;
    }

    /// @dev Remove an orderId from orderbook array
    function _removeOrder(uint256 orderId, uint256 positionId, LibDoefinStorage.OrderDirection direction) private {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        uint256[] storage book = direction == LibDoefinStorage.OrderDirection.Buy
            ? ds.orderbookStorage.buyOrdersByPosition[positionId]
            : ds.orderbookStorage.sellOrdersByPosition[positionId];

        uint256 len = book.length;

        for (uint256 i = 0; i < len; i++) {
            if (book[i] == orderId) {
                for (uint256 j = i; j < len - 1; j++) {
                    book[j] = book[j + 1];
                }
                book.pop();
                break;
            }
        }
    }
}
