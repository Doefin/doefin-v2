// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibOrderbook} from "../libraries/LibOrderbook.sol";
import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {LibEscrowLogic} from "../libraries/LibEscrowLogic.sol";
import {IExchange} from "../interfaces/IExchange.sol";

/**
 * @title ExchangeFacetV2
 * @notice Refactored exchange facet using the new library architecture
 */
contract ExchangeFacet is IExchange {
    using LibDoefinStorage for LibDoefinStorage.AppStorage;

    /// @notice Create a new limit order
    function createLimitOrder(
        uint256 positionId,
        address collateralToken,
        uint256 amount,
        uint256 pricePerToken,
        uint256 minFillAmount,
        uint256 expiry,
        bool fillOrKill,
        LibDoefinStorage.OrderDirection direction,
        LibDoefinStorage.ExecutionType executionType
    ) external {
        LibOrderbook.createOrder(positionId, collateralToken, amount, pricePerToken, minFillAmount, expiry, fillOrKill, direction, executionType);
    }

    /// @notice Cancel an existing order by ID
    function cancelOrder(uint256 orderId) external {
        LibOrderbook.cancelOrder(orderId, msg.sender);
    }

    /// @notice Modify an existing limit order
    function modifyLimitOrder(
        uint256 orderId,
        uint256 newAmount,
        uint256 newPricePerToken,
        uint256 newMinFillAmount,
        uint256 newExpiry
    ) external {
        LibOrderbook.modifyOrder(msg.sender, orderId, newAmount, newPricePerToken, newMinFillAmount, newExpiry);
    }

    function getNextOrderId() external view returns (uint256) {
        return LibDoefinStorage.appStorage().orderbookStorage.nextOrderId;
    }

    function getOrder(uint256 orderId) external view returns (LibDoefinStorage.Order memory) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        return ds.orderbookStorage.orders[orderId];
    }

    function getOrderbook(uint256 positionId, LibDoefinStorage.OrderDirection direction) external view returns (uint256[] memory) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        if (direction == LibDoefinStorage.OrderDirection.Buy) {
            return ds.orderbookStorage.buyOrdersByPosition[positionId];
        } else {
            return ds.orderbookStorage.sellOrdersByPosition[positionId];
        }
    }

    /**
     * @notice Batch get multiple orders
     * @param orderIds Array of order IDs
     * @return orders Array of order details
     */
    function getOrders(uint256[] calldata orderIds) external view returns (LibDoefinStorage.Order[] memory orders) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        orders = new LibDoefinStorage.Order[](orderIds.length);

        for (uint256 i = 0; i < orderIds.length; i++) {
            orders[i] = ds.orderbookStorage.orders[orderIds[i]];
        }
    }

    function getUserEscrowStatus(address user, address[] calldata tokens, uint256[] calldata positionIds)
        external
        view
        returns (uint256[] memory erc20Balances, uint256[] memory erc1155Balances)
    {
        return LibEscrowLogic.getEscrowStatus(user, tokens, positionIds);
    }
}
