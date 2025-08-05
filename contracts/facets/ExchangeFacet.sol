// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibOrderbook} from "../libraries/LibOrderbook.sol";
import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {IExchange} from "../interfaces/IExchange.sol";

/**
 * @title ExchangeFacetV2
 * @notice Refactored exchange facet using the new library architecture
 */
contract ExchangeFacet is IExchange {
    using LibDoefinStorage for LibDoefinStorage.DiamondStorage;

    /// @notice Create a new limit order
    function createLimitOrder(
        uint256 positionId,
        address collateralToken,
        uint256 amount,
        uint256 pricePerToken,
        uint256 minFillAmount,
        uint256 expiry,
        LibDoefinStorage.OrderDirection direction
    ) external {
        LibOrderbook.createOrder(positionId, collateralToken, amount, pricePerToken, minFillAmount, expiry, direction);
    }

    /// @notice Cancel an existing order by ID
    function cancelOrder(uint256 orderId) external {
        LibOrderbook.cancelOrder(orderId, msg.sender);
    }

    /// @notice Modify an existing limit order
    function modifyLimitOrder(uint256 orderId, uint256 newAmount, uint256 newPricePerToken, uint256 newMinFillAmount, uint256 newExpiry) external {
        LibOrderbook.modifyOrder(msg.sender, orderId, newAmount, newPricePerToken, newMinFillAmount, newExpiry);
    }

    function getNextOrderId() external view returns (uint256) {
        return LibDoefinStorage.diamondStorage().orderbookStorage.nextOrderId;
    }

    function getOrder(uint256 orderId) external view returns (LibDoefinStorage.Order memory) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        return ds.orderbookStorage.orders[orderId];
    }

    function getOrderbook(uint256 positionId, LibDoefinStorage.OrderDirection direction) external view returns (uint256[] memory) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        if (direction == LibDoefinStorage.OrderDirection.Buy) {
            return ds.orderbookStorage.buyOrdersByPosition[positionId];
        } else {
            return ds.orderbookStorage.sellOrdersByPosition[positionId];
        }
    }

    /**
     * @notice Get comprehensive order information including collateral status
     * @param orderId The order ID
     * @return order The order details
     * @return collateralLocked The amount of collateral locked for this order
     */
    function getOrderWithCollateral(uint256 orderId) external view returns (
        LibDoefinStorage.Order memory order,
        uint256 collateralLocked
    ) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        order = ds.orderbookStorage.orders[orderId];
        
        if (order.direction == LibDoefinStorage.OrderDirection.Buy) {
            // For buy orders, calculate ERC20 collateral needed
            uint256 unitPerPair = ds.adminConfigStorage.unitPerPair[order.collateralToken];
            uint256 cost = (order.remainingAmount * order.pricePerToken) / unitPerPair;
            uint256 makerFee = (cost * order.orderFeeConfig.makerFeeBps) / 10_000;
            collateralLocked = cost + makerFee;
        } else {
            // For sell orders, collateral is the position tokens
            collateralLocked = order.remainingAmount;
        }
    }

    /**
     * @notice Batch get multiple orders
     * @param orderIds Array of order IDs
     * @return orders Array of order details
     */
    function getOrders(uint256[] calldata orderIds) external view returns (LibDoefinStorage.Order[] memory orders) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        orders = new LibDoefinStorage.Order[](orderIds.length);
        
        for (uint256 i = 0; i < orderIds.length; i++) {
            orders[i] = ds.orderbookStorage.orders[orderIds[i]];
        }
    }

    /**
     * @notice Get orders by maker address (requires off-chain indexing for efficiency)
     * @param maker The maker address
     * @param startOrderId Starting order ID for pagination
     * @param limit Maximum number of orders to return
     * @return orders Array of orders by the maker
     * @return nextStartId Next order ID for pagination (0 if no more)
     */
    function getOrdersByMaker(
        address maker,
        uint256 startOrderId,
        uint256 limit
    ) external view returns (
        LibDoefinStorage.Order[] memory orders,
        uint256 nextStartId
    ) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        
        // This is a simple implementation - in production, you'd want proper indexing
        LibDoefinStorage.Order[] memory tempOrders = new LibDoefinStorage.Order[](limit);
        uint256 found = 0;
        uint256 currentId = startOrderId == 0 ? 1 : startOrderId;
        uint256 maxOrderId = ds.orderbookStorage.nextOrderId;
        
        while (found < limit && currentId < maxOrderId) {
            LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[currentId];
            if (order.maker == maker && order.active) {
                tempOrders[found] = order;
                found++;
            }
            currentId++;
        }
        
        // Resize array to actual found orders
        orders = new LibDoefinStorage.Order[](found);
        for (uint256 i = 0; i < found; i++) {
            orders[i] = tempOrders[i];
        }
        
        nextStartId = currentId < maxOrderId ? currentId : 0;
    }

    /**
     * @notice Get market depth for a position
     * @param positionId The position ID
     * @param maxOrders Maximum number of orders per side
     * @return buyOrders Array of buy order IDs
     * @return sellOrders Array of sell order IDs
     * @return buyPrices Array of buy prices
     * @return sellPrices Array of sell prices
     * @return buyAmounts Array of buy amounts
     * @return sellAmounts Array of sell amounts
     */
    function getMarketDepth(uint256 positionId, uint256 maxOrders) external view returns (
        uint256[] memory buyOrders,
        uint256[] memory sellOrders,
        uint256[] memory buyPrices,
        uint256[] memory sellPrices,
        uint256[] memory buyAmounts,
        uint256[] memory sellAmounts
    ) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        
        uint256[] storage buyOrderIds = ds.orderbookStorage.buyOrdersByPosition[positionId];
        uint256[] storage sellOrderIds = ds.orderbookStorage.sellOrdersByPosition[positionId];
        
        uint256 buyCount = buyOrderIds.length > maxOrders ? maxOrders : buyOrderIds.length;
        uint256 sellCount = sellOrderIds.length > maxOrders ? maxOrders : sellOrderIds.length;
        
        buyOrders = new uint256[](buyCount);
        sellOrders = new uint256[](sellCount);
        buyPrices = new uint256[](buyCount);
        sellPrices = new uint256[](sellCount);
        buyAmounts = new uint256[](buyCount);
        sellAmounts = new uint256[](sellCount);
        
        // Get buy orders (highest price first)
        for (uint256 i = 0; i < buyCount; i++) {
            uint256 orderId = buyOrderIds[i];
            LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[orderId];
            buyOrders[i] = orderId;
            buyPrices[i] = order.pricePerToken;
            buyAmounts[i] = order.remainingAmount;
        }
        
        // Get sell orders (lowest price first)
        for (uint256 i = 0; i < sellCount; i++) {
            uint256 orderId = sellOrderIds[i];
            LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[orderId];
            sellOrders[i] = orderId;
            sellPrices[i] = order.pricePerToken;
            sellAmounts[i] = order.remainingAmount;
        }
    }

    /**
     * @notice Get order statistics for a position
     * @param positionId The position ID
     * @return totalBuyOrders Number of active buy orders
     * @return totalSellOrders Number of active sell orders
     * @return totalBuyVolume Total volume of buy orders
     * @return totalSellVolume Total volume of sell orders
     * @return bestBuyPrice Best (highest) buy price
     * @return bestSellPrice Best (lowest) sell price
     */
    function getOrderStatistics(uint256 positionId) external view returns (
        uint256 totalBuyOrders,
        uint256 totalSellOrders,
        uint256 totalBuyVolume,
        uint256 totalSellVolume,
        uint256 bestBuyPrice,
        uint256 bestSellPrice
    ) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        
        uint256[] storage buyOrderIds = ds.orderbookStorage.buyOrdersByPosition[positionId];
        uint256[] storage sellOrderIds = ds.orderbookStorage.sellOrdersByPosition[positionId];
        
        totalBuyOrders = buyOrderIds.length;
        totalSellOrders = sellOrderIds.length;
        
        // Calculate buy statistics
        if (totalBuyOrders > 0) {
            bestBuyPrice = ds.orderbookStorage.orders[buyOrderIds[0]].pricePerToken;
            for (uint256 i = 0; i < totalBuyOrders; i++) {
                LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[buyOrderIds[i]];
                totalBuyVolume += order.remainingAmount;
            }
        }
        
        // Calculate sell statistics
        if (totalSellOrders > 0) {
            bestSellPrice = ds.orderbookStorage.orders[sellOrderIds[0]].pricePerToken;
            for (uint256 i = 0; i < totalSellOrders; i++) {
                LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[sellOrderIds[i]];
                totalSellVolume += order.remainingAmount;
            }
        }
    }
}