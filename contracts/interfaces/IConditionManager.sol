// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

interface IConditionManager {
    function createCondition(
        address oracle,
        bytes32 questionId,
        uint8 outcomeSlotCount,
        string calldata metadataURI
    ) external returns (bytes32 conditionId);

    function getCondition(bytes32 conditionId)
        external
        view
        returns (
            address oracle,
            bytes32 questionId,
            uint8 outcomeSlotCount,
            string memory metadataURI
        );

    function cancelCondition(bytes32 conditionId) external;
}
