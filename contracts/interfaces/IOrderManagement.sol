// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

/**
 * @title IOrderManagement
 * @author Doefin
 * @notice Interface for order management functionality
 * @dev Defines functions for cancelling and modifying existing orders
 */
interface IOrderManagement {
    /**
     * @notice Cancel an existing order by its unique identifier
     * @dev Only the order creator can cancel their own orders
     * @param orderId The unique identifier of the order to cancel
     */
    function cancelOrder(uint256 orderId) external;

    /**
     * @notice Modify parameters of an existing limit order
     * @dev Only limit orders can be modified, and only by their creator
     * @param orderId The unique identifier of the order to modify
     * @param newAmount The new total amount for the order (in position token units)
     * @param newPricePerToken The new price per position token (in collateral units)
     * @param newMinFillAmount The new minimum fill amount (0 for no minimum)
     * @param newExpiry The new expiry timestamp (0 for no expiry)
     */
    function modifyLimitOrder(uint256 orderId, uint256 newAmount, uint256 newPricePerToken, uint256 newMinFillAmount, uint32 newExpiry) external;
}
