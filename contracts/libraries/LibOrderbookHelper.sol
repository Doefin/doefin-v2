// SPDX-License-Identifier: AGPL-3.0
// Uses shared storage derived from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {LibEscrowLogic} from "../libraries/LibEscrowLogic.sol";

library LibOrderbookHelper {
    function _buildSettleContext(LibDoefinStorage.Position calldata pos) internal view returns (LibDoefinStorage.SettleContext memory settleCtx) {
        LibDoefinStorage.OrderFeeConfig memory orderFeeConfig = LibDoefinStorage.OrderFeeConfig({makerFeeBps: 0, takerFeeBps: 0});
        settleCtx = LibDoefinStorage.SettleContext({
            taker: msg.sender,
            maker: address(0),
            collateralToken: pos.collateralToken,
            positionId: pos.positionId,
            amount: 0,
            pricePerToken: 0,
            adjustedCost: 0,
            direction: LibDoefinStorage.OrderDirection.Buy,
            orderFeeConfig: orderFeeConfig
        });
    }

    function _buildFillContexts(
        uint256 amount,
        uint256 totalFilled,
        uint256 totalCost,
        uint256 maxAveragePrice
    ) internal pure returns (LibDoefinStorage.FillContext memory fillCtx) {
        fillCtx = LibDoefinStorage.FillContext({amount: amount, totalFilled: totalFilled, maxAveragePrice: maxAveragePrice, totalCost: totalCost});
    }

    /// @dev Calculates how much can be filled from this order, respecting user's maxAveragePrice constraint.
    function _calculateAffordableFill(
        LibDoefinStorage.Order storage order,
        LibDoefinStorage.FillContext memory ctx
    ) internal view returns (uint256 affordableAmount, uint256 adjustedCost) {
        require(order.active, "Orderbook: Order inactive");
        require(order.expiry == 0 || block.timestamp <= order.expiry, "Orderbook: Order expired");

        // Determine how much the user still wants to fill
        uint256 remainingToFill = ctx.amount - ctx.totalFilled;

        // Determine how much the order still offers
        uint256 available = order.amount - order.filledAmount;

        uint256 feeAdjustedPricePerToken = order.pricePerToken + (order.pricePerToken * order.orderFeeConfig.takerFeeBps) / 10_000;

        // Respecting user maxAveragePrice
        if (ctx.maxAveragePrice > 0) {
            // Calculate how much cost space remains under user's constraint
            uint256 freeMargin = ctx.maxAveragePrice * ctx.amount - ctx.totalCost;

            // Compute the number of tokens this order can fill under that remaining budget
            uint256 maxAtThisPrice = freeMargin / feeAdjustedPricePerToken;

            // Final fill amount is the min of the three limits
            affordableAmount = _min3(available, remainingToFill, maxAtThisPrice);

            // Calculate the adjusted cost with respect to taker fee.
            adjustedCost = feeAdjustedPricePerToken * affordableAmount;
        } else {
            // If maxAverage is not important, then it's minimum of these two
            affordableAmount = _min(available, remainingToFill);

            // Still need to return proper adjusted cost for consistency
            adjustedCost = feeAdjustedPricePerToken * affordableAmount;
        }
    }

    /// @dev Settles one matched order: computes affordable fill amount, updates storage, transfers funds.
    function _processMatchedOrder(
        uint256 orderId,
        LibDoefinStorage.FillContext memory ctx,
        LibDoefinStorage.SettleContext memory settleCtx
    ) internal {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[orderId];
        (uint256 affordableAmount, uint256 feeAdjustedCost) = _calculateAffordableFill(order, ctx);

        // Populate settlement context
        settleCtx.amount = affordableAmount;
        settleCtx.adjustedCost = feeAdjustedCost;
        settleCtx.pricePerToken = order.pricePerToken;
        settleCtx.maker = order.maker;
        settleCtx.direction = order.direction;
        settleCtx.orderFeeConfig = order.orderFeeConfig;

        // Update order fill amount
        order.filledAmount += affordableAmount;

        // Settle funds, emit event
        _settleTradeWithFees(settleCtx);

        uint256 remainingAmount = order.amount - order.filledAmount;

        // emit MarketOrderFilled(orderId, msg.sender, affordableAmount, affordableAmount, remainingAmount);

        // Clean up if fully filled
        if (remainingAmount == 0) _deleteOrderIfFullyFilledOrCanceled(order);
    }

    function _settleTradeWithFees(LibDoefinStorage.SettleContext memory ctx) internal {
        require(ctx.maker != address(0), "Maker can not be zero address");
        LibEscrowLogic.settleTrade(ctx);
    }

    function _min3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256) {
        return _min(_min(a, b), c);
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    /// @dev Deletes a fully filled order from storage and removes it from index mapping.
    function _deleteOrderIfFullyFilledOrCanceled(LibDoefinStorage.Order memory order) internal {
        require(order.active == false || order.filledAmount == order.amount, "Can not remove the orders");
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        uint256 positionId = order.positionParams.positionId;
        uint256[] storage orderList = order.direction == LibDoefinStorage.OrderDirection.Buy
            ? ds.orderbookStorage.buyOrdersByPosition[positionId]
            : ds.orderbookStorage.sellOrdersByPosition[positionId];

        _removeOrderIdFromArray(orderList, order.orderId);
        delete ds.orderbookStorage.orders[order.orderId];

        // emit OrderDeleted(order.orderId);
    }

    function _removeOrderIdFromArray(uint256[] storage arr, uint256 orderId) internal {
        for (uint256 i = 0; i < arr.length; i++) {
            if (arr[i] == orderId) {
                for (uint256 j = i; j < arr.length - 1; j++) {
                    arr[j] = arr[j + 1]; // Shift elements left
                }
                arr.pop(); // Remove last duplicate
                break;
            }
        }
    }
}
