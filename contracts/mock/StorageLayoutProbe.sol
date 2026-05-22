// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {LibSettlementStorage} from "../libraries/LibSettlementStorage.sol";
import {LibAdminConfigStorage} from "../libraries/LibAdminConfigStorage.sol";
import {LibAccessControlStorage} from "../libraries/LibAccessControlStorage.sol";

/**
 * @title StorageLayoutProbe
 * @author Doefin
 * @notice Test-only probe for the storage-layout snapshot test (ARCH-05 / SCRUM-229).
 * @dev The Diamond reaches its storage structs through assembly slot assignment in the
 *      storage libraries, so the Solidity compiler never emits a `storageLayout` for
 *      them — no contract declares them as state variables. Declaring them here forces
 *      solc to compute and emit the full layout of every nested struct. The
 *      storage-layout snapshot test reads that layout back and asserts it against a
 *      committed baseline, turning the hand-sized `__gap` arithmetic into a CI gate.
 *
 *      The `*Slot()` getters expose each namespace's `STORAGE_POSITION` constant so the
 *      test can verify the hardcoded EIP-7201 slots match the formula.
 *
 *      This contract is never deployed as part of the Diamond and carries no protocol
 *      logic. It lives in contracts/mock (audit-excluded) for that reason.
 */
contract StorageLayoutProbe {
    LibDoefinStorage.AppStorage internal appStorage;
    LibSettlementStorage.SettlementStorage internal settlementStorage;
    LibAdminConfigStorage.AdminConfigStorage internal adminConfigStorage;
    LibAccessControlStorage.AccessControlStorage internal accessControlStorage;

    function appStorageSlot() external pure returns (bytes32) {
        return LibDoefinStorage.STORAGE_POSITION;
    }

    function settlementStorageSlot() external pure returns (bytes32) {
        return LibSettlementStorage.STORAGE_POSITION;
    }

    function adminConfigStorageSlot() external pure returns (bytes32) {
        return LibAdminConfigStorage.STORAGE_POSITION;
    }

    function accessControlStorageSlot() external pure returns (bytes32) {
        return LibAccessControlStorage.STORAGE_POSITION;
    }
}
