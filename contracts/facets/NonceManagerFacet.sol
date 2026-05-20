// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinOrder} from "../libraries/LibDoefinOrder.sol";
import {LibSettlementStorage} from "../libraries/LibSettlementStorage.sol";
import {LibOrderValidity} from "../libraries/LibOrderValidity.sol";
import {Errors} from "../libraries/Errors.sol";
import {Events} from "../libraries/Events.sol";
import {INonceManager} from "../interfaces/INonceManager.sol";

/**
 * @title NonceManagerFacet
 * @author Doefin
 * @notice On-chain order cancellation and nonce management for the v2.1 hybrid settlement system
 * @dev Provides three cancellation mechanisms:
 *      1. Individual order cancellation by hash
 *      2. Bulk cancellation via nonce increment (invalidates all orders with nonce < new value)
 *      3. Position-based cancellation via minimum salt (invalidates orders for a specific position)
 *      `isOrderValid` is the bool-returning wrapper over the shared {LibOrderValidity}
 *      predicate, used by the off-chain orderbook. SettlementFacet does NOT call
 *      `isOrderValid` directly — it inlines the same rules through `_validateOrder` so it
 *      can revert with specific reasons (CPX-003).
 */
contract NonceManagerFacet is INonceManager {
    // ========================================
    // NONCE MANAGEMENT
    // ========================================

    /**
     * @notice Increment caller's nonce, cancelling all orders with nonce < new value
     * @return newNonce The new nonce value
     * @custom:emits NonceBumped
     */
    function incrementNonce() external returns (uint256 newNonce) {
        LibSettlementStorage.SettlementStorage storage ss = LibSettlementStorage.settlementStorage();
        newNonce = ++ss.makerToNonce[msg.sender];
        emit Events.NonceBumped(msg.sender, newNonce);
    }

    /**
     * @notice Get the current nonce for a maker
     * @param maker The maker address
     * @return The current nonce value (0 for fresh addresses)
     */
    function getNonce(address maker) external view returns (uint256) {
        LibSettlementStorage.SettlementStorage storage ss = LibSettlementStorage.settlementStorage();
        return ss.makerToNonce[maker];
    }

    // ========================================
    // INDIVIDUAL CANCELLATION
    // ========================================

    /**
     * @notice Cancel a specific order by its hash
     * @dev Only the order's maker can cancel. Computes the EIP-712 hash and marks it as cancelled.
     * @param order The DoefinOrder to cancel
     * @custom:emits OrderCancelledOnChain
     * @custom:reverts NotOrderMaker if msg.sender != order.maker
     */
    function cancelOrder(LibDoefinOrder.DoefinOrder calldata order) external {
        if (msg.sender != order.maker) {
            revert Errors.NotOrderMaker();
        }

        LibSettlementStorage.SettlementStorage storage ss = LibSettlementStorage.settlementStorage();
        bytes32 orderHash = _getOrderHash(order);
        if (ss.cancelledOrders[orderHash]) {
            revert Errors.OrderCancelled(orderHash);
        }
        ss.cancelledOrders[orderHash] = true;
        emit Events.OrderCancelledOnChain(orderHash, msg.sender);
    }

    /**
     * @notice Batch cancel specific orders
     * @dev All orders must have msg.sender as maker
     * @param orders Array of DoefinOrders to cancel
     * @custom:emits OrderCancelledOnChain for each order
     * @custom:reverts NotOrderMaker if msg.sender != order.maker for any order
     */
    function cancelOrders(LibDoefinOrder.DoefinOrder[] calldata orders) external {
        LibSettlementStorage.SettlementStorage storage ss = LibSettlementStorage.settlementStorage();
        bytes32 domainSep = _getDomainSeparator();
        for (uint256 i; i < orders.length; ++i) {
            if (msg.sender != orders[i].maker) {
                revert Errors.NotOrderMaker();
            }
            bytes32 orderHash = LibDoefinOrder.hashOrderCalldata(orders[i], domainSep);
            if (ss.cancelledOrders[orderHash]) {
                revert Errors.OrderCancelled(orderHash);
            }
            ss.cancelledOrders[orderHash] = true;
            emit Events.OrderCancelledOnChain(orderHash, msg.sender);
        }
    }

    /**
     * @notice Check if a specific order has been cancelled
     * @param orderHash The EIP-712 hash of the order
     * @return True if the order has been individually cancelled
     */
    function isCancelled(bytes32 orderHash) external view returns (bool) {
        LibSettlementStorage.SettlementStorage storage ss = LibSettlementStorage.settlementStorage();
        return ss.cancelledOrders[orderHash];
    }

    // ========================================
    // SALT-BASED CANCELLATION
    // ========================================

    /**
     * @notice Cancel all orders for a position with salt below minValidSalt
     * @dev Only affects the caller's own orders (msg.sender == maker)
     * @param positionId The CTF position ID
     * @param minValidSalt The new minimum valid salt; orders with salt < this are invalid
     * @custom:emits PositionOrdersCancelled
     */
    function cancelOrdersForPosition(
        bytes32 positionId,
        uint256 minValidSalt
    ) external {
        LibSettlementStorage.SettlementStorage storage ss = LibSettlementStorage.settlementStorage();
        if (minValidSalt <= ss.makerPositionToMinSalt[msg.sender][positionId]) {
            revert Errors.InvalidSaltThreshold();
        }
        ss.makerPositionToMinSalt[msg.sender][positionId] = minValidSalt;
        emit Events.PositionOrdersCancelled(msg.sender, positionId, minValidSalt);
    }

    // ========================================
    // ORDER VALIDITY CHECK
    // ========================================

    /**
     * @notice Check if an order is valid (not cancelled, nonce OK, salt OK, not expired)
     * @dev Bool wrapper over the shared {LibOrderValidity.check} predicate, intended for
     *      off-chain orderbook consumers. The settlement hot path does NOT call this
     *      function — it inlines the same rules through `SettlementFacet._validateOrder`
     *      to revert with specific reasons (CPX-003).
     * @param order The DoefinOrder to validate
     * @return True if the order passes all validity checks
     */
    function isOrderValid(LibDoefinOrder.DoefinOrder calldata order) external view returns (bool) {
        LibSettlementStorage.SettlementStorage storage ss = LibSettlementStorage.settlementStorage();
        bytes32 orderHash = _getOrderHash(order);
        return LibOrderValidity.check(ss, order, orderHash);
    }

    // ========================================
    // INTERNAL FUNCTIONS
    // ========================================

    /**
     * @dev Compute the full EIP-712 order hash using the Diamond's domain separator
     * @param order The DoefinOrder struct
     * @return The full EIP-712 hash
     */
    function _getOrderHash(LibDoefinOrder.DoefinOrder calldata order) internal view returns (bytes32) {
        return LibDoefinOrder.hashOrderCalldata(order, _getDomainSeparator());
    }

    /**
     * @dev Compute the EIP-712 domain separator.
     * @return The domain separator.
     * @custom:audit SEC-004 — delegates to {LibDoefinOrder.diamondDomainSeparator}.
     */
    function _getDomainSeparator() internal view returns (bytes32) {
        return LibDoefinOrder.diamondDomainSeparator(address(this));
    }
}
