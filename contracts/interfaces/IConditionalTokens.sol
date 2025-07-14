// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

interface IConditionalTokens {
    event ConditionPreparation(bytes32 indexed conditionId, address indexed oracle, bytes32 indexed questionId, uint8 outcomeSlotCount);

    event PositionSplit(
        address indexed stakeholder,
        address indexed collateralToken,
        bytes32 indexed parentCollectionId,
        bytes32 conditionId,
        uint[] partition,
        uint amount
    );

    event ConditionResolution(
        bytes32 indexed conditionId,
        address indexed oracle,
        bytes32 indexed questionId,
        uint8 outcomeSlotCount,
        uint[] payoutNumerators
    );

    event PositionsMerge(
        address indexed stakeholder,
        address indexed collateralToken,
        bytes32 indexed parentCollectionId,
        bytes32 conditionId,
        uint[] partition,
        uint amount
    );

    event PayoutRedemption(
        address indexed redeemer,
        address indexed collateralToken,
        bytes32 indexed parentCollectionId,
        bytes32 conditionId,
        uint[] indexSets,
        uint payout
    );

    event PayoutRedemptionFeePaid(address indexed redeemer, address indexed feeReceiver, uint256 feeAmount, uint256 userPayout);

    event PayoutRedeemedToParentPosition(
        address indexed redeemer,
        address collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256 parentPositionId,
        uint256 payoutAmount
    );

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
