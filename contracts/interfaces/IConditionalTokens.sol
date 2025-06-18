// SPDX-License-Identifier: MIT
pragma solidity ^0.8.6;

interface IConditionalTokens {
    event ConditionPrepared(bytes32 indexed conditionId, address indexed oracle, bytes32 indexed questionId);
    event PositionSplit(address indexed user, bytes32 indexed conditionId, uint amount);
    event PositionMerged(address indexed user, bytes32 indexed conditionId, uint amount);
    event PositionRedeemed(address indexed user, bytes32 indexed conditionId, uint amount);

    function prepareCondition(address oracle, bytes32 questionId, uint outcomeSlotCount) external;
    function reportPayouts(bytes32 questionId, uint[] calldata payouts) external;
    function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint amount, uint[] calldata partition) external;
    function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint amount) external;
    function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint[] calldata indexSets) external;
    function getPositionId(address collateralToken, bytes32 collectionId, uint indexSet) external view returns (uint);
    function getPayoutNumerators(bytes32 conditionId) external view returns (uint[] memory);
    function getPositionTokenAddress(uint positionId) external view returns (address);
}