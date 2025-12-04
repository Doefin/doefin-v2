// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";

/**
 * @title IExchangeView
 * @author Doefin
 * @notice Interface for view-only exchange functions
 * @dev Split from IExchange to reduce main facet size
 */
interface IExchangeView {
    /**
     * @notice Get the next order ID that will be assigned
     * @return The next order ID that will be used for new orders
     */
    function getNextOrderId() external view returns (uint256);

    /**
     * @notice Retrieve details of a specific order
     * @param orderId The unique identifier of the order to retrieve
     * @return The Order struct containing all order details
     */
    function getOrder(uint256 orderId) external view returns (LibDoefinStorage.Order memory);

    /**
     * @notice Get all order IDs in the orderbook for a specific position and direction
     * @param positionId The ERC1155 position token ID to query
     * @param direction The order direction (Buy or Sell) to filter by
     * @return Array of order IDs in the orderbook
     */
    function getOrderbook(uint256 positionId, LibDoefinStorage.OrderDirection direction) external view returns (uint256[] memory);

    /**
     * @notice Batch retrieve multiple orders by their IDs
     * @param orderIds Array of order IDs to retrieve
     * @return orders Array of Order structs corresponding to the provided order IDs
     */
    function getOrders(uint256[] calldata orderIds) external view returns (LibDoefinStorage.Order[] memory orders);

    /**
     * @notice Get escrow status for a user across multiple tokens and positions
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
    ) external view returns (uint256[] memory erc20Balances, uint256[] memory erc1155Balances);
}
