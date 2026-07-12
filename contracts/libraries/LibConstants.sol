// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.20;

/**
 * @title LibConstants
 * @author Doefin
 * @notice Shared protocol-wide constants.
 * @dev SCRUM-230 (INFO-3) — single source of truth for values that were otherwise
 *      hard-coded as magic numbers at multiple sites.
 */
library LibConstants {
    /// @notice Basis-points denominator — 10_000 bps = 100%.
    /// @dev Used by every bps fee calculation: SettlementFacet._validateFee,
    ///      AdminConfigFacet.setResolutionFeeBps, ConditionalTokensFacet redemption.
    uint256 internal constant BPS_DENOMINATOR = 10_000;

    // ========================================
    // FEE KIND DISCRIMINATORS (SCRUM-236)
    // ========================================
    //
    // `Events.FeeAccrued.kind` carries one of these to let off-chain indexers split
    // trading revenue from resolution revenue without re-deriving it from the call
    // site. They are deliberately small enough for a `uint8` field so the event
    // log only consumes a single non-topic word for the discriminator. Adding a
    // third kind in the future (e.g. "redistribution") fits without an ABI break.

    /// @notice `FeeAccrued.kind` value for fees accrued during settlement (SettlementFacet).
    uint8 internal constant FEE_KIND_TRADING = 0;

    /// @notice `FeeAccrued.kind` value for fees accrued during redemption
    ///         (`ConditionalTokensFacet._handlePayoutTransfer`).
    uint8 internal constant FEE_KIND_RESOLUTION = 1;
}
