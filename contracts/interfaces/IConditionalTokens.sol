// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

interface IConditionalTokens {
    function prepareCondition(address oracle, bytes32 questionId, uint8 outcomeSlotCount) external;
    function reportPayouts(bytes32 questionId, uint[] calldata payouts) external;
    function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint amount, uint[] calldata partition) external;
    function mergePositions(
        address collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256[] calldata partition,
        uint256 amount
    ) external;
    function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint[] calldata indexSets) external;
    function getPositionId(address collateralToken, bytes32 collectionId) external view returns (uint);
    function getPayoutNumerators(bytes32 conditionId) external view returns (uint[] memory);
    function getConditionId(address oracle, bytes32 questionId, uint8 outcomeSlotCount) external pure returns (bytes32);
    function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint indexSet) external view returns (bytes32);
}
