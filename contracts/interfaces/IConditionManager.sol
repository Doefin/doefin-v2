// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.20;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";

interface IConditionManager {
    function createCondition(
        address oracle,
        bytes32 questionId,
        uint8 outcomeSlotCount,
        string calldata metadataURI
    ) external returns (bytes32 conditionId);

    function createConditionWithMetadata(
        LibDoefinStorage.QuestionType questionType,
        bytes calldata metadata,
        uint8 outcomeSlotCount,
        string calldata metadataURI,
        bytes32 salt
    ) external returns (bytes32 conditionId, bytes32 questionId);

    function getCondition(bytes32 conditionId) external view returns (LibDoefinStorage.Condition memory);

    function cancelCondition(bytes32 conditionId) external;

    /// @notice Owner-only: resolve a cancelled, unresolved condition as void — every outcome pays
    ///         an equal share, no resolution fee (CTF-005).
    /// @param conditionId The cancelled condition to void
    function voidCondition(bytes32 conditionId) external;
}
