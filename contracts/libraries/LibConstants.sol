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
}
