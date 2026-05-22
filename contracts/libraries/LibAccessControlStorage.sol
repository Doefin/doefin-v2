// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

/**
 * @title LibAccessControlStorage
 * @author Doefin
 * @notice EIP-7201 namespaced storage for the market-maker access-control role.
 * @dev SCRUM-229 (ARCH-03) peeled this sub-struct out of the monolithic
 *      `LibDoefinStorage.AppStorage`. The EIP-7201 slot reserves a 256-slot-aligned
 *      region, so no hand-sized `__gap` is required.
 * @custom:storage-location erc7201:doefin.access-control.storage
 */
library LibAccessControlStorage {
    /// @dev EIP-7201 namespace slot. Derivation:
    ///      keccak256(abi.encode(uint256(keccak256("doefin.access-control.storage")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant STORAGE_POSITION =
        0x80256eede14fe5b6a56eb50d92fb9f744a77c459b32f6cb6c8d3b41af4abfa00;

    /// @notice Access-control role storage.
    struct AccessControlStorage {
        /// @notice Addresses granted the market-maker role
        mapping(address => bool) marketMakers;
    }

    /// @notice Returns the access-control storage struct at its EIP-7201 namespace slot.
    /// @return acs Storage pointer to AccessControlStorage
    function accessControlStorage() internal pure returns (AccessControlStorage storage acs) {
        bytes32 position = STORAGE_POSITION;
        assembly {
            acs.slot := position
        }
    }
}
