// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {LibSettlementStorage} from "../libraries/LibSettlementStorage.sol";

/**
 * @title StorageLayoutProbe
 * @author Doefin
 * @notice Test-only probe for the storage-layout snapshot test (ARCH-05 / SCRUM-229).
 * @dev The Diamond reaches its storage structs through assembly slot assignment in
 *      {LibDoefinStorage} / {LibSettlementStorage}, so the Solidity compiler never emits
 *      a `storageLayout` for them — there is no contract that declares them as state
 *      variables. Declaring them here forces solc to compute and emit the full layout
 *      of every nested struct. The storage-layout snapshot test reads that layout back
 *      and asserts it against a committed baseline, turning the hand-sized `__gap`
 *      arithmetic into a CI regression gate.
 *
 *      This contract is never deployed and is not part of any facet. It lives in
 *      contracts/mock (audit-excluded) for that reason. It carries no logic — its only
 *      purpose is to make the storage layout observable to the compiler.
 */
contract StorageLayoutProbe {
    LibDoefinStorage.AppStorage internal appStorage;
    LibSettlementStorage.SettlementStorage internal settlementStorage;
}
