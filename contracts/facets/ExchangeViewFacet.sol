// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {LibCollateralManager} from "../libraries/LibCollateralManager.sol";
import {IExchangeView} from "../interfaces/IExchangeView.sol";

/**
 * @title ExchangeViewFacet
 * @author Doefin
 * @notice View-only functions for the exchange facet to reduce main facet size
 * @dev This facet contains read-only functions split from ExchangeFacet for size optimization
 */
contract ExchangeViewFacet is IExchangeView {
    using LibDoefinStorage for LibDoefinStorage.AppStorage;

    /**
     * @notice Get the next order ID that will be assigned
     * @dev Returns the incremental counter for order IDs
     * @return The next order ID that will be used for new orders
     */
    function getNextOrderId() external view returns (uint256) {
        return LibDoefinStorage.appStorage().orderbookStorage.nextOrderId;
    }

    /**
     * @notice Retrieve details of a specific order
     * @dev Returns the complete Order struct for the given order ID
     * @param orderId The unique identifier of the order to retrieve
     * @return The Order struct containing all order details including amounts, prices, and configuration
     */
    function getOrder(uint256 orderId) external view returns (LibDoefinStorage.Order memory) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        return ds.orderbookStorage.orders[orderId];
    }

    /**
     * @notice Get all order IDs in the orderbook for a specific position and direction
     * @dev Returns an array of order IDs that can be used to fetch individual order details
     * @param positionId The ERC1155 position token ID to query
     * @param direction The order direction (Buy or Sell) to filter by
     * @return Array of order IDs in the orderbook for the specified position and direction
     */
    function getOrderbook(uint256 positionId, LibDoefinStorage.OrderDirection direction) external view returns (uint256[] memory) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        if (direction == LibDoefinStorage.OrderDirection.Buy) {
            return ds.orderbookStorage.buyOrdersByPosition[positionId];
        } else {
            return ds.orderbookStorage.sellOrdersByPosition[positionId];
        }
    }

    /**
     * @notice Batch retrieve multiple orders by their IDs
     * @dev More gas efficient than calling getOrder multiple times
     * @param orderIds Array of order IDs to retrieve
     * @return orders Array of Order structs corresponding to the provided order IDs
     */
    function getOrders(uint256[] calldata orderIds) external view returns (LibDoefinStorage.Order[] memory orders) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        orders = new LibDoefinStorage.Order[](orderIds.length);

        for (uint256 i = 0; i < orderIds.length; i++) {
            orders[i] = ds.orderbookStorage.orders[orderIds[i]];
        }
    }

    /**
     * @notice Get escrow status for a user across multiple tokens and positions
     * @dev Returns both ERC20 collateral balances and ERC1155 position token balances
     *      Useful for checking available balances before creating orders
     * @param user The address of the user to check escrow status for
     * @param tokens Array of ERC20 token addresses to check balances for
     * @param positionIds Array of ERC1155 position token IDs to check balances for
     * @return erc20Balances Array of ERC20 token balances in the escrow
     * @return erc1155Balances Array of ERC1155 position token balances in the escrow
     */
    function getUserEscrowStatus(
        address user,
        address[] calldata tokens,
        uint256[] calldata positionIds
    ) external view returns (uint256[] memory erc20Balances, uint256[] memory erc1155Balances) {
        return LibCollateralManager.getEscrowStatus(user, tokens, positionIds);
    }
}
