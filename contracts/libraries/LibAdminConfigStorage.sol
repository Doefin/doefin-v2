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
    struct AdminConfigStorage {
        /// @notice Collateral tokens approved for orders and positions
        mapping(address => bool) isAllowed;
        /// @notice Per-token collateral precision unit (e.g. 1e6 for USDC)
        mapping(address => uint256) unitPerPair;
        /// @notice Per-token display symbol (e.g. "USDC")
        mapping(address => string) tokenSymbols;
        /// @notice Recipient of protocol fees (trading + redemption)
        address feeReceiver;
        /// @notice Redemption fee charged on a winning-position payout, in basis points
        uint16 resolutionFeeBps;
        /// @notice SCRUM-224: admin ceiling on the operator-supplied settlement fee.
        ///         SettlementFacet enforces `fee <= cashValue * maxFeeRateBps / 10000`.
        ///         Fail-closed: 0 forbids any non-zero fee (NOT "unlimited").
        uint16 maxFeeRateBps;
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
