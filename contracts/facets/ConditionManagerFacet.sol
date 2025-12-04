// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {LibAccessControl} from "../libraries/LibAccessControl.sol";
import {LibCTFCondition} from "../libraries/LibCTFCondition.sol";
import {LibConditionMetadata} from "../libraries/LibConditionMetadata.sol";
import {LibOracleAdapter} from "../libraries/LibOracleAdapter.sol";
import {LibCTHelpers} from "../libraries/LibCTHelpers.sol";
import {LibDoefinBlockHeaderOracle} from "../libraries/LibDoefinBlockHeaderOracle.sol";
import {IConditionManager} from "../interfaces/IConditionManager.sol";
import {Errors} from "../libraries/Errors.sol";
import {Events} from "../libraries/Events.sol";

contract ConditionManagerFacet is IConditionManager {
    using LibDoefinStorage for LibDoefinStorage.AppStorage;

    /// @notice Create a new condition with question type and metadata
    /// @param questionType The type of question (Threshold, Range, BlockCount, Duration)
    /// @param metadata Encoded question parameters
    /// @param outcomeSlotCount Number of possible outcomes
    /// @param metadataURI Off-chain metadata URI
    /// @param salt Optional salt for duplicate questions
    /// @return conditionId The CTF condition identifier
    /// @return questionId The deterministic question identifier
    function createConditionWithMetadata(
        LibDoefinStorage.QuestionType questionType,
        bytes calldata metadata,
        uint8 outcomeSlotCount,
        string calldata metadataURI,
        bytes32 salt
    ) external returns (bytes32 conditionId, bytes32 questionId) {
        LibAccessControl.enforceIsMarketMaker();

        if (outcomeSlotCount <= 1) {
            revert Errors.InvalidOutcomeSlotCount();
        }

        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        // Get current block height for validation
        uint256 currentBlockHeight = LibDoefinBlockHeaderOracle.getCurrentBlockHeight();

        // Generate deterministic questionId
        questionId = LibConditionMetadata.generateQuestionId(questionType, metadata, salt);

        // Oracle is this contract (Diamond)
        address oracle = address(this);

        // Prepare condition in CTF
        conditionId = LibCTFCondition.prepareCondition(oracle, questionId, outcomeSlotCount);

        // Store condition metadata
        ds.conditionalTokens.conditions[conditionId] = LibDoefinStorage.Condition({
            oracle: oracle,
            questionId: questionId,
            outcomeSlotCount: outcomeSlotCount,
            metadataURI: metadataURI,
            active: true,
            creator: msg.sender
        });

        // Route to appropriate question registration based on type
        if (questionType == LibDoefinStorage.QuestionType.DifficultyThreshold) {
            (uint256 threshold, uint256 targetBlockHeight) =
                LibConditionMetadata.decodeDifficultyThreshold(metadata);

            // Validate parameters
            LibConditionMetadata.validateDifficultyThreshold(
                threshold,
                targetBlockHeight,
                outcomeSlotCount,
                currentBlockHeight
            );

            // Create oracle question
            LibOracleAdapter.createDifficultyThresholdQuestion(
                questionId,
                conditionId,
                threshold,
                targetBlockHeight
            );
        }
        else if (questionType == LibDoefinStorage.QuestionType.DifficultyRange) {
            (uint256 targetBlockHeight, uint256[] memory buckets) =
                LibConditionMetadata.decodeDifficultyRange(metadata);

            // Validate parameters
            LibConditionMetadata.validateDifficultyRange(
                targetBlockHeight,
                buckets,
                outcomeSlotCount,
                currentBlockHeight
            );

            // Create oracle question
            LibOracleAdapter.createDifficultyRangeQuestion(
                questionId,
                conditionId,
                targetBlockHeight,
                buckets
            );
        }
        else if (questionType == LibDoefinStorage.QuestionType.BlockCount) {
            (uint256 startTimestamp, uint256 endTimestamp, uint256[] memory countBuckets) =
                LibConditionMetadata.decodeBlockCount(metadata);

            // Validate parameters
            LibConditionMetadata.validateBlockCount(
                startTimestamp,
                endTimestamp,
                countBuckets,
                outcomeSlotCount
            );

            // Create oracle question
            LibOracleAdapter.createBlockCountQuestion(
                questionId,
                conditionId,
                startTimestamp,
                endTimestamp,
                countBuckets
            );
        }
        else if (questionType == LibDoefinStorage.QuestionType.MiningDuration) {
            (uint256 startBlockHeight, uint256 blockCount, uint256[] memory durationBuckets) =
                LibConditionMetadata.decodeMiningDuration(metadata);

            // Validate parameters
            LibConditionMetadata.validateMiningDuration(
                startBlockHeight,
                blockCount,
                durationBuckets,
                outcomeSlotCount,
                currentBlockHeight
            );

            // Create oracle question
            LibOracleAdapter.createMiningDurationQuestion(
                questionId,
                conditionId,
                startBlockHeight,
                blockCount,
                durationBuckets
            );
        }
        else {
            revert Errors.OracleAdapter_InvalidQuestionType();
        }

        emit Events.ConditionCreated(
            conditionId,
            oracle,
            questionId,
            outcomeSlotCount,
            metadataURI,
            msg.sender
        );

        return (conditionId, questionId);
    }

    // Keep the old createCondition for backwards compatibility if needed
    function createCondition(
        address oracle,
        bytes32 questionId,
        uint8 outcomeSlotCount,
        string calldata metadataURI
    ) external override returns (bytes32 conditionId) {
        LibAccessControl.enforceIsMarketMaker();
        if (outcomeSlotCount <= 1) {
            revert Errors.InvalidOutcomeSlotCount();
        }
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        conditionId = LibCTFCondition.prepareCondition(oracle, questionId, outcomeSlotCount);

        ds.conditionalTokens.conditions[conditionId] = LibDoefinStorage.Condition({
            oracle: oracle,
            questionId: questionId,
            outcomeSlotCount: outcomeSlotCount,
            metadataURI: metadataURI,
            active: true,
            creator: msg.sender
        });

        emit Events.ConditionCreated(conditionId, oracle, questionId, outcomeSlotCount, metadataURI, msg.sender);
    }

    function getCondition(bytes32 conditionId)
        external
        view
        override
        returns (LibDoefinStorage.Condition memory)
    {
        LibDoefinStorage.Condition storage condition = LibDoefinStorage.appStorage().conditionalTokens.conditions[conditionId];
        return condition;
    }

    function cancelCondition(bytes32 conditionId) external override {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        LibDoefinStorage.Condition storage cond = ds.conditionalTokens.conditions[conditionId];
        if (cond.creator == address(0)) {
            revert Errors.ConditionDoesNotExist();
        }

        if (cond.creator != msg.sender && !LibAccessControl.isOwner(msg.sender)) {
            revert Errors.NotAuthorizedToCancel();
        }

        if (cond.oracle == address(0)) revert Errors.InvalidOracleAddress();

        if (!cond.active) revert Errors.ConditionAlreadyInactive();

        cond.active = false;
        emit Events.ConditionCancelled(conditionId, msg.sender);
    }
}
