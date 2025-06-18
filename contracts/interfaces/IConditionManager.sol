// SPDX-License-Identifier: MIT
pragma solidity ^0.8.6;

interface IConditionManager {
    event ConditionCreated(bytes32 indexed conditionId, address indexed oracle, bytes32 indexed questionId, string metadataURI);
    event ConditionCancelled(bytes32 indexed conditionId);

    function createCondition(address oracle, bytes32 questionId, uint outcomeSlotCount, string calldata metadataURI) external returns (bytes32 conditionId);
    function getCondition(bytes32 conditionId) external view returns (address oracle, bytes32 questionId, uint outcomeSlotCount, string memory metadataURI);
    function cancelCondition(bytes32 conditionId) external;
}