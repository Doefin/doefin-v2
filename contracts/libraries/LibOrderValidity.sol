// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinOrder} from "./LibDoefinOrder.sol";
import {LibSettlementStorage} from "./LibSettlementStorage.sol";

/**
 * @title LibOrderValidity
 * @author Doefin
 * @notice Single source of truth for the off-chain-orderbook validity rules an order must
 *         satisfy before it can be filled or matched.
 * @dev The rules — not cancelled, nonce current, salt above the position-min, not expired —
 *      live here so the bool-returning `NonceManagerFacet.isOrderValid` (used by the
 *      orderbook off-chain) and the revert-on-failure `SettlementFacet._validateOrder`
 *      (used on the settlement hot path) share the same predicate (CPX-003).
 * @custom:audit CPX-003 — pre-fix, the two facets implemented the rule twice, with a stale
 *      NatSpec on NonceManagerFacet claiming "the SettlementFacet calls isOrderValid()"
 *      that did not match the code (SettlementFacet inlined the rule).
 */
library LibOrderValidity {
    /**
     * @notice Check whether an order satisfies the off-chain-orderbook validity rules.
     * @param ss The settlement storage pointer.
     * @param order The DoefinOrder to check.
     * @param orderHash The pre-computed EIP-712 hash of the order.
     * @return ok True if the order is valid; false otherwise.
     * @dev Pure predicate — does NOT enforce collateral allow-list or price-bounds.
     *      Those are settlement-only invariants checked separately by SettlementFacet.
     */
    function check(
        LibSettlementStorage.SettlementStorage storage ss,
        LibDoefinOrder.DoefinOrder calldata order,
        bytes32 orderHash
    ) internal view returns (bool ok) {
        if (ss.cancelledOrders[orderHash]) return false;
        if (order.nonce < ss.makerToNonce[order.maker]) return false;
        if (order.salt < ss.makerPositionToMinSalt[order.maker][order.positionId]) return false;
        if (order.expiration != 0 && block.timestamp >= order.expiration) return false;
        return true;
    }
}
