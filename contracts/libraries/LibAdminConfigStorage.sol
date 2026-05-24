// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.20;

/**
 * @title LibAdminConfigStorage
 * @author Doefin
 * @notice EIP-7201 namespaced storage for protocol admin configuration.
 * @dev SCRUM-229 (ARCH-03) peeled this sub-struct out of the monolithic
 *      `LibDoefinStorage.AppStorage` so the admin-config module owns an isolated
 *      storage namespace. The slot is derived by the EIP-7201 formula, which masks
 *      the low byte to align the namespace to a 256-slot boundary — the struct can
 *      grow up to 256 slots without colliding with another namespace, so no
 *      hand-sized `__gap` is required.
 * @custom:storage-location erc7201:doefin.admin-config.storage
 */
library LibAdminConfigStorage {
    /// @dev EIP-7201 namespace slot. Derivation:
    ///      keccak256(abi.encode(uint256(keccak256("doefin.admin-config.storage")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant STORAGE_POSITION =
        0xf40d4f44b73a30edbc8834be4a1fac961a187f5028f483c6ae44def1200b3900;

    /// @notice Protocol admin configuration — collateral allow-list, fee receiver, fee rates.
    /// @dev SCRUM-236 — `accruedFees` joins the namespace as the pull-payment fee-bank
    ///      accumulator. The placement keeps fee *policy* (`feeReceiver`,
    ///      `resolutionFeeBps`, `maxFeeRateBps`) and fee *escrow* (`accruedFees`) in a
    ///      single admin-treasury namespace. EIP-7201 reserves a 256-slot region per
    ///      namespace, so adding a single mapping slot needs no `__gap` adjustment —
    ///      see contract NatSpec above.
    struct AdminConfigStorage {
        /// @notice Collateral tokens approved for orders and positions
        /// @dev INV-SOLV-4-revised (SCRUM-236) assumes any allow-listed token is a
        ///      standard ERC-20 — no fee-on-transfer, no rebasing, no callback hooks.
        ///      Enforced by governance (this owner-only allow-list), not by code.
        mapping(address => bool) isAllowed;
        /// @notice Per-token collateral precision unit (e.g. 1e6 for USDC)
        mapping(address => uint256) unitPerPair;
        /// @notice Per-token display symbol (e.g. "USDC")
        mapping(address => string) tokenSymbols;
        /// @notice Recipient of protocol fees (trading + redemption) at withdraw time.
        /// @dev SCRUM-236: per-trade fee transfers were removed. `feeReceiver` is now the
        ///      destination of the owner-only `AdminConfigFacet.withdrawFees` call; trading
        ///      and resolution fees accrue in `accruedFees` first.
        address feeReceiver;
        /// @notice Redemption fee charged on a winning-position payout, in basis points
        uint16 resolutionFeeBps;
        /// @notice SCRUM-224: admin ceiling on the operator-supplied settlement fee.
        ///         SettlementFacet enforces `fee <= cashValue * maxFeeRateBps / 10000`.
        ///         Fail-closed: 0 forbids any non-zero fee (NOT "unlimited").
        uint16 maxFeeRateBps;
        /// @notice SCRUM-236 — fees accrued inside the Diamond per collateral token,
        ///         awaiting an owner-initiated `withdrawFees` sweep.
        /// @dev Incremented on every settlement leg (trading fee — `SettlementFacet`)
        ///      and every winning redemption (resolution fee — `ConditionalTokensFacet`).
        ///      Decremented only via `AdminConfigFacet.withdrawFees`. The accumulator is
        ///      exact (direct SSTORE; no division or rounding on increment) and is the
        ///      load-bearing component of INV-SOLV-4-revised:
        ///        `balanceOf(Diamond, token) >= outstandingPairs[token] + accruedFees[token]`.
        mapping(address => uint256) accruedFees;
    }

    /// @notice Returns the admin-config storage struct at its EIP-7201 namespace slot.
    /// @return acs Storage pointer to AdminConfigStorage
    function adminConfigStorage() internal pure returns (AdminConfigStorage storage acs) {
        bytes32 position = STORAGE_POSITION;
        assembly {
            acs.slot := position
        }
    }
}
