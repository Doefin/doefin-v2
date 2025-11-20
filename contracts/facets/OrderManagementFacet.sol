// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibOrderbook} from "../libraries/LibOrderbook.sol";
import {IOrderManagement} from "../interfaces/IOrderManagement.sol";

/**
 * @title OrderManagementFacet
 * @author Doefin
 * @notice Facet for managing existing orders (cancel, modify)
 * @dev This facet is part of the Diamond pattern implementation and handles order management
 *      Split from ExchangeFacet to reduce contract size below 24KB limit
 */
contract OrderManagementFacet is IOrderManagement {
    /**
     * @notice Cancel an existing order by its unique identifier
     * @dev Only the order creator can cancel their own orders
     *      Delegates to LibOrderbook.cancelOrder for actual implementation
     * @param orderId The unique identifier of the order to cancel
     * @custom:emits OrderCancelled event with order ID
     * @custom:requirements Order must exist, be active, and caller must be the order creator
     */
    function cancelOrder(uint256 orderId) external {
        LibOrderbook.cancelOrder(orderId, msg.sender);
    }

    /**
     * @notice Modify parameters of an existing limit order
     * @dev Only limit orders can be modified, and only by their creator
     *      Delegates to LibOrderbook.modifyOrder for actual implementation
     * @param orderId The unique identifier of the order to modify
     * @param newAmount The new total amount for the order (in position token units)
     * @param newPricePerToken The new price per position token (in collateral units)
     * @param newMinFillAmount The new minimum fill amount (0 for no minimum)
     * @param newExpiry The new expiry timestamp (0 for no expiry)
     * @custom:emits OrderModified event with old and new order parameters
     * @custom:requirements Order must exist, be active, be a limit order, and caller must be the order creator
     */
    function modifyLimitOrder(uint256 orderId, uint256 newAmount, uint256 newPricePerToken, uint256 newMinFillAmount, uint256 newExpiry) external {
        LibOrderbook.modifyOrder(msg.sender, orderId, newAmount, newPricePerToken, newMinFillAmount, newExpiry);
    }
}
