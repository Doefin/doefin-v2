// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibOrderbook} from "../libraries/LibOrderbook.sol";
import {IOrderManagement} from "../interfaces/IOrderManagement.sol";

/**
 * @title OrderManagementFacet
 * @author Doefin
 * @notice Diamond facet for managing existing orders including cancellation and modification
 * @dev Part of the Diamond pattern implementation handling order lifecycle management
 * @dev Split from ExchangeFacet to reduce contract size below 24KB limit per EIP-170
 * @dev Delegates to LibOrderbook for all order management operations and validation
 * @custom:facet Order lifecycle management separated for contract size optimization
 * @custom:diamond Part of the EIP-2535 Diamond Standard implementation
 * @custom:delegation Uses LibOrderbook for all order management logic
 * @custom:access Enforces order creator authorization for all management operations
 */
contract OrderManagementFacet is IOrderManagement {
    /**
     * @notice Cancels an existing order and returns locked collateral to the order creator
     * @dev Only the order creator can cancel their own orders for security
     * @dev Delegates to LibOrderbook.cancelOrder for validation and state updates
     * @dev Releases locked collateral back to the order creator's escrow balance
     * @param orderId The unique identifier of the order to cancel
     * @custom:access Only order creator can cancel (enforced via msg.sender check)
     * @custom:state Updates order status and releases locked collateral
     * @custom:emits OrderCancelled event with order ID via LibOrderbook
     * @custom:validation Order must exist, be active, and caller must be the order creator
     * @custom:collateral Releases locked collateral back to user escrow
     */
    function cancelOrder(uint256 orderId) external {
        LibOrderbook.cancelOrder(orderId, msg.sender);
    }

    /**
     * @notice Modifies parameters of an existing limit order with comprehensive validation
     * @dev Only limit orders can be modified, market orders are not modifiable
     * @dev Only the order creator can modify their own orders for security
     * @dev Delegates to LibOrderbook.modifyOrder for validation and state updates
     * @dev Handles collateral adjustments if order amount changes significantly
     * @param orderId The unique identifier of the order to modify
     * @param newAmount The new total amount for the order (in position token units)
     * @param newPricePerToken The new price per position token (in collateral units)
     * @param newMinFillAmount The new minimum fill amount (0 for no minimum fill requirement)
     * @param newExpiry The new expiry timestamp (0 for no expiry)
     * @custom:access Only order creator can modify (enforced via msg.sender parameter)
     * @custom:validation Order must exist, be active, be a limit order, and caller must be creator
     * @custom:collateral Adjusts locked collateral if order amount changes
     * @custom:emits OrderModified event with old and new order parameters via LibOrderbook
     * @custom:limits Only limit orders are modifiable, market orders cannot be modified
     */
    function modifyLimitOrder(uint256 orderId, uint256 newAmount, uint256 newPricePerToken, uint256 newMinFillAmount, uint32 newExpiry) external {
        LibOrderbook.modifyOrder(msg.sender, orderId, newAmount, newPricePerToken, newMinFillAmount, newExpiry);
    }
}
