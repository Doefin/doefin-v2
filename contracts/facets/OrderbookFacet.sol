// SPDX-License-Identifier: AGPL-3.0
// Uses shared storage derived from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {IOrderbookFacet} from "../interfaces/IOrderbook.sol";
import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {LibCTHelpers} from "../libraries/LibCTHelpers.sol";
import {LibERC1155} from "../libraries/LibERC1155.sol";
import {LibEscrowLogic} from "../libraries/LibEscrowLogic.sol";

contract OrderbookFacet is IOrderbookFacet {
    function createLimitOrder(
        LibDoefinStorage.Position calldata positionParams,
        uint256 amount,
        uint256 pricePerToken,
        uint256 minFillAmount,
        uint256 expiry,
        LibDoefinStorage.OrderDirection direction
    ) external override returns (uint256 orderId) {
        enforceValidPositionId(positionParams);
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        // Generate new order ID
        orderId = ds.orderbookStorage.orders[0].orderId + 1;
        ds.orderbookStorage.orders[0].orderId = orderId;

        uint256 positionId = positionParams.positionId;
        bytes32 conditionId = positionParams.conditionId;
        address collateralToken = positionParams.collateralToken;

        // Lock escrow from msg.sender to contract
        _lockEscrowWithEvent(msg.sender, amount, pricePerToken, positionId, collateralToken, direction);

        LibDoefinStorage.OrderFeeConfig memory orderFeeConfig = LibEscrowLogic.getMarketFees();

        LibDoefinStorage.Order memory order = LibDoefinStorage.Order({
            orderId: orderId,
            maker: msg.sender,
            positionParams: positionParams,
            amount: amount,
            filledAmount: 0,
            minFillAmount: minFillAmount,
            pricePerToken: pricePerToken,
            expiry: expiry,
            createdAt: block.timestamp,
            active: true,
            direction: direction,
            orderFeeConfig: orderFeeConfig,
            __gap: [uint256(0), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        });

        // Store the order
        ds.orderbookStorage.orders[orderId] = order;
        if (direction == LibDoefinStorage.OrderDirection.Buy) {
            insertSorted(ds.orderbookStorage.buyOrdersByPosition[positionId], orderId, direction);
        } else {
            insertSorted(ds.orderbookStorage.sellOrdersByPosition[positionId], orderId, direction);
        }

        emit OrderCreated(orderId, msg.sender, positionId, amount, pricePerToken, block.timestamp, direction, conditionId);
    }

    /// @notice Cancels an open order by ID
    /// @param orderId The ID of the order to cancel
    function cancelOrder(uint256 orderId) external override {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[orderId];

        require(order.maker == msg.sender, "Orderbook: Only maker can cancel");

        // Mark order inactive
        order.active = false;

        // Release only the remaining unfilled portion
        uint256 remainingAmount = order.amount - order.filledAmount;

        if (remainingAmount > 0) {
            _releaseEscrowWithEvent(
                order.maker,
                remainingAmount,
                order.pricePerToken,
                order.positionParams.positionId,
                order.positionParams.collateralToken,
                order.direction
            );
        }

        emit OrderCanceled(orderId);
    }

    function fillMarketOrderWithRoute(
        LibDoefinStorage.Position calldata positionParams,
        uint256 amount,
        bool fillOrKill,
        LibDoefinStorage.OrderDirection direction,
        LibDoefinStorage.MatchOrderRoute calldata matchOrderRoute,
        uint256 maxAveragePrice
    ) external override {
        enforceValidPositionId(positionParams);
        _fillMarketRouteInternal(positionParams, amount, fillOrKill, direction, matchOrderRoute, maxAveragePrice);
    }

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

        emit MarketOrderFilled(orderId, msg.sender, affordableAmount, affordableAmount, remainingAmount);

        // Clean up if fully filled
        if (remainingAmount == 0) _deleteOrderIfFullyFilled(orderId, order.positionParams.positionId, order.direction);
    }

    /// @dev Deletes a fully filled order from storage and removes it from index mapping.
    function _deleteOrderIfFullyFilled(uint256 orderId, uint256 positionId, LibDoefinStorage.OrderDirection direction) internal {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        uint256[] storage orderList = direction == LibDoefinStorage.OrderDirection.Buy
            ? ds.orderbookStorage.sellOrdersByPosition[positionId]
            : ds.orderbookStorage.buyOrdersByPosition[positionId];

        removeOrderIdFromArray(orderList, orderId);
        delete ds.orderbookStorage.orders[orderId];
    }

    function _fillMarketRouteInternal(
        LibDoefinStorage.Position calldata positionParams,
        uint256 amount,
        bool fillOrKill,
        LibDoefinStorage.OrderDirection direction,
        LibDoefinStorage.MatchOrderRoute calldata matchOrderRoute,
        uint256 maxAveragePrice
    ) internal {
        uint256 len = matchOrderRoute.matchedOrderIds.length;
        require(matchOrderRoute.matchedAmounts.length == len, "Orderbook: Length mismatch");

        LibDoefinStorage.FillContext memory fillCtx = _buildFillContexts(amount, 0, 0, maxAveragePrice);

        for (uint256 i = 0; i < len; i++) {
            uint256 orderId = matchOrderRoute.matchedOrderIds[i];

            LibDoefinStorage.SettleContext memory settleCtx = _buildSettleContext(positionParams);

            _processMatchedOrder(orderId, fillCtx, settleCtx);

            fillCtx.totalFilled += settleCtx.amount;
            fillCtx.totalCost += settleCtx.adjustedCost;

            // Break early if we’ve filled requested amount
            if (fillCtx.totalFilled >= amount) break;
        }

        if (fillOrKill) {
            require(fillCtx.totalFilled >= amount, "Orderbook: FillOrKill failed");
        }
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

    function modifyLimitOrder(uint256 orderId, uint256 newAmount, uint256 newPrice, uint256 newMinFillAmount, uint256 newExpiry) external override {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[orderId];

        require(order.active, "Orderbook: Inactive");
        require(order.filledAmount == 0, "Orderbook: Already partially filled");
        require(order.maker == msg.sender, "Orderbook: Not owner");

        uint256 oldAmount = order.amount;
        uint256 oldPrice = order.pricePerToken;

        // Adjust collateral first
        LibDoefinStorage.ModifyCollateralContext memory modifyCtx = LibDoefinStorage.ModifyCollateralContext({
            maker: order.maker,
            collateralToken: order.positionParams.collateralToken,
            positionId: order.positionParams.positionId,
            makerFeeBps: order.orderFeeConfig.makerFeeBps,
            oldAmount: oldAmount,
            newAmount: newAmount,
            oldPrice: oldPrice,
            newPrice: newPrice,
            direction: order.direction
        });

        LibEscrowLogic.adjustCollateralForModifiedOrder(modifyCtx);

        // Then update order fields
        order.amount = newAmount;
        order.pricePerToken = newPrice;
        order.minFillAmount = newMinFillAmount;
        order.expiry = newExpiry;

        emit OrderUpdated(orderId, newAmount, newPrice, newMinFillAmount, newExpiry);
    }

    function _calculateTotalBuyCost(uint256 amount, uint256 pricePerToken, uint256 feeBps) internal pure returns (uint256) {
        uint256 rawCost = amount * pricePerToken;
        uint256 fee = (rawCost * feeBps) / 10_000;
        return rawCost + fee;
    }

    function batchCleanupOrders(uint256[] calldata orderIds) external override {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        for (uint256 i = 0; i < orderIds.length; i++) {
            uint256 orderId = orderIds[i];
            LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[orderId];

            if (!order.active || order.amount == order.filledAmount || (order.expiry != 0 && order.expiry < block.timestamp)) {
                order.active = false;

                uint256[] storage book = order.direction == LibDoefinStorage.OrderDirection.Buy
                    ? ds.orderbookStorage.buyOrdersByPosition[order.positionParams.positionId]
                    : ds.orderbookStorage.sellOrdersByPosition[order.positionParams.positionId];

                // Remove orderId from the order book array
                for (uint256 j = 0; j < book.length; j++) {
                    if (book[j] == orderId) {
                        book[j] = book[book.length - 1];
                        book.pop();
                        break;
                    }
                }
            }
        }
    }

    function enforceValidPositionId(LibDoefinStorage.Position calldata pos) internal view {
        bytes32 collectionId = LibCTHelpers.getCollectionId(pos.parentCollectionId, pos.conditionId, pos.indexSet);
        uint256 expectedPositionId = LibCTHelpers.getPositionId(pos.collateralToken, collectionId);
        require(expectedPositionId == pos.positionId, "Orderbook: Invalid positionId");
    }

    function _selectViableOrders(
        uint256 positionId,
        LibDoefinStorage.OrderDirection direction
    ) internal view returns (LibDoefinStorage.SimulatedOrder[] memory) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        uint256[] storage book = direction == LibDoefinStorage.OrderDirection.Buy
            ? ds.orderbookStorage.sellOrdersByPosition[positionId]
            : ds.orderbookStorage.buyOrdersByPosition[positionId];

        LibDoefinStorage.SimulatedOrder[] memory raw = new LibDoefinStorage.SimulatedOrder[](book.length);
        uint256 count = 0;

        for (uint256 i = 0; i < book.length; i++) {
            LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[book[i]];

            if (!order.active) continue;
            if (order.expiry != 0 && order.expiry < block.timestamp) continue;

            uint256 available = order.amount - order.filledAmount;
            if (available == 0) continue;

            raw[count++] = LibDoefinStorage.SimulatedOrder({
                orderId: order.orderId,
                pricePerToken: order.pricePerToken,
                available: available,
                takerFeeBps: order.orderFeeConfig.takerFeeBps
            });
        }

        // Shrink array in memory
        LibDoefinStorage.SimulatedOrder[] memory result = new LibDoefinStorage.SimulatedOrder[](count);
        for (uint256 i = 0; i < count; i++) {
            result[i] = raw[i];
        }

        return result;
    }

    /// @notice Simulates a market order to preview matched orders and pricing
    /// @param positionParams includes all required data to compute positionId
    /// @param amount Amount to fill
    /// @param direction Buy or Sell
    /// @return matchedOrderIds IDs of matched limit orders
    /// @return matchedAmounts Corresponding fill amounts
    /// @return totalCost Total collateral required (if buying) or received (if selling)
    /// @return averagePrice Weighted average fill price
    function simulateMarketOrder(
        LibDoefinStorage.Position calldata positionParams,
        uint256 amount,
        LibDoefinStorage.OrderDirection direction
    ) external view returns (uint256[] memory matchedOrderIds, uint256[] memory matchedAmounts, uint256 totalCost, uint256 averagePrice) {
        enforceValidPositionId(positionParams);

        LibDoefinStorage.SimulatedOrder[] memory orders = _selectViableOrders(positionParams.positionId, direction);

        matchedOrderIds = new uint256[](orders.length);
        matchedAmounts = new uint256[](orders.length);

        uint256 matched = 0;

        for (uint256 i = 0; i < orders.length && matched < amount; i++) {
            LibDoefinStorage.SimulatedOrder memory order = orders[i];

            uint256 toMatch = _min(order.available, amount - matched);
            uint256 rawCost = toMatch * order.pricePerToken;

            uint256 feeAdjustedCost;
            if (direction == LibDoefinStorage.OrderDirection.Buy) {
                feeAdjustedCost = rawCost + ((rawCost * order.takerFeeBps) / 10_000);
            } else {
                feeAdjustedCost = rawCost - ((rawCost * order.takerFeeBps) / 10_000);
            }

            totalCost += feeAdjustedCost;
            matchedOrderIds[i] = order.orderId;
            matchedAmounts[i] = toMatch;
            matched += toMatch;
        }

        require(matched >= amount, "simulateMarketOrder: Couldn't satisify the ammount");

        averagePrice = matched > 0 ? totalCost / matched : 0;

        // Compact matched arrays
        uint256 count = 0;
        for (uint256 i = 0; i < matchedAmounts.length; i++) {
            if (matchedAmounts[i] > 0) count++;
        }

        if (count < matchedOrderIds.length) {
            uint256[] memory finalIds = new uint256[](count);
            uint256[] memory finalAmounts = new uint256[](count);
            uint256 j = 0;
            for (uint256 i = 0; i < matchedAmounts.length; i++) {
                if (matchedAmounts[i] > 0) {
                    finalIds[j] = matchedOrderIds[i];
                    finalAmounts[j] = matchedAmounts[i];
                    j++;
                }
            }
            matchedOrderIds = finalIds;
            matchedAmounts = finalAmounts;
        }
    }

    /// @notice Retrieves the details of a specific order
    /// @param orderId The ID of the order to fetch
    /// @return Order struct with full order details
    function getOrder(uint256 orderId) external view override returns (LibDoefinStorage.Order memory) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        return ds.orderbookStorage.orders[orderId];
    }

    /// @notice Retrieves the orderbook for a specific positionId and direction
    /// @param positionId The Position ID of the orderbook
    /// @return Ordirectionder Direction for the orderbook
    /// @dev For test/debug only
    function getOrderbook(uint256 positionId, LibDoefinStorage.OrderDirection direction) external view override returns (uint256[] memory) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        if (direction == LibDoefinStorage.OrderDirection.Buy) {
            return ds.orderbookStorage.buyOrdersByPosition[positionId];
        } else {
            return ds.orderbookStorage.sellOrdersByPosition[positionId];
        }
    }

    /// @notice Returns the best available price for a given position and direction
    /// @param positionId Position to check
    /// @param direction Buy or Sell
    /// @return price Best available price in collateral units
    /// @return amount available for the best price
    function getBestPrice(
        uint256 positionId,
        LibDoefinStorage.OrderDirection direction
    ) external view override returns (uint256 price, uint256 amount) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        uint256[] storage book = direction == LibDoefinStorage.OrderDirection.Buy
            ? ds.orderbookStorage.sellOrdersByPosition[positionId]
            : ds.orderbookStorage.buyOrdersByPosition[positionId];

        for (uint256 i = 0; i < book.length; i++) {
            LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[book[i]];
            if (!order.active) continue;
            if (order.expiry != 0 && order.expiry < block.timestamp) continue;

            uint256 remaining = order.amount - order.filledAmount;
            if (remaining > 0) {
                return (order.pricePerToken, remaining);
            }
        }

        return (0, 0); // No available orders
    }

    /// @notice Returns the next order ID to be assigned
    /// @return The current next order ID (incremented per new order)
    function getNextOrderId() external view override returns (uint256) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        return ds.orderbookStorage.orders[0].orderId + 1;
    }

    function getCollateralBalance(address user, address token) external view returns (uint256) {
        return LibDoefinStorage.diamondStorage().escrowStorage.collateralBalances[user][token];
    }

    function getLockedERC1155(address user, uint256 positionId) external view returns (uint256) {
        return LibDoefinStorage.diamondStorage().escrowStorage.lockedERC1155Balances[user][positionId];
    }

    function _releaseEscrowWithEvent(
        address to,
        uint256 amount,
        uint256 pricePerToken,
        uint256 positionId,
        address collateralToken,
        LibDoefinStorage.OrderDirection direction
    ) internal {
        if (direction == LibDoefinStorage.OrderDirection.Buy) {
            LibEscrowLogic.releaseCollateral(to, collateralToken, amount, pricePerToken);
        } else {
            LibEscrowLogic.releaseERC1155(to, positionId, amount);
        }
        emit EscrowReleased(to, collateralToken, positionId, amount, pricePerToken, direction);
    }

    function _lockEscrowWithEvent(
        address from,
        uint256 amount,
        uint256 pricePerToken,
        uint256 positionId,
        address collateralToken,
        LibDoefinStorage.OrderDirection direction
    ) internal {
        if (direction == LibDoefinStorage.OrderDirection.Buy) {
            LibEscrowLogic.lockCollateral(from, collateralToken, amount, pricePerToken);
        } else {
            LibEscrowLogic.lockERC1155(from, positionId, amount);
        }
        emit EscrowLocked(from, collateralToken, positionId, amount, pricePerToken, direction);
    }

    function removeOrderIdFromArray(uint256[] storage arr, uint256 orderId) internal {
        for (uint256 i = 0; i < arr.length; i++) {
            if (arr[i] == orderId) {
                arr[i] = arr[arr.length - 1]; // Replace with last
                arr.pop();
                break;
            }
        }
    }

    function insertSorted(uint256[] storage orderArray, uint256 orderId, LibDoefinStorage.OrderDirection direction) internal {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        LibDoefinStorage.Order storage newOrder = ds.orderbookStorage.orders[orderId];
        uint256 price = newOrder.pricePerToken;

        uint256 i = 0;

        // Ascending for Sell (lowest price first)
        // Descending for Buy (highest price first)
        while (i < orderArray.length) {
            LibDoefinStorage.Order storage existing = ds.orderbookStorage.orders[orderArray[i]];
            if (
                (direction == LibDoefinStorage.OrderDirection.Sell && price < existing.pricePerToken) ||
                (direction == LibDoefinStorage.OrderDirection.Buy && price > existing.pricePerToken)
            ) {
                break;
            }
            i++;
        }

        // Insert at position i
        orderArray.push(orderId); // expand length
        for (uint256 j = orderArray.length - 1; j > i; j--) {
            orderArray[j] = orderArray[j - 1];
        }
        orderArray[i] = orderId;
    }
}
