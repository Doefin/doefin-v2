// SPDX-License-Identifier: AGPL-3.0
// Uses shared storage derived from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

interface IConditionManager {
    event ConditionCreated(bytes32 indexed conditionId, address indexed oracle, bytes32 indexed questionId, uint8 outcomeSlotCount, string metadataURI);
    event ConditionCancelled(bytes32 indexed conditionId);

    function createCondition(address oracle, bytes32 questionId, uint8 outcomeSlotCount, string calldata metadataURI) external returns (bytes32 conditionId);
    function getCondition(bytes32 conditionId) external view returns (address oracle, bytes32 questionId, uint8 outcomeSlotCount, string memory metadataURI);
    function cancelCondition(bytes32 conditionId) external;
}