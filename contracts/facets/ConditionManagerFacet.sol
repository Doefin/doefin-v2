// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.20;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {LibAccessControl} from "../libraries/LibAccessControl.sol";
import {LibDiamond} from "../libraries/LibDiamond.sol";
import {LibCTFCondition} from "../libraries/LibCTFCondition.sol";
import {LibConditionMetadata} from "../libraries/LibConditionMetadata.sol";
import {LibOracleAdapter} from "../libraries/LibOracleAdapter.sol";
import {LibCTHelpers} from "../libraries/LibCTHelpers.sol";
import {LibDoefinBlockHeaderOracle} from "../libraries/LibDoefinBlockHeaderOracle.sol";
import {IConditionManager} from "../interfaces/IConditionManager.sol";
import {Errors} from "../libraries/Errors.sol";
import {Events} from "../libraries/Events.sol";

/**
 * @title ConditionManagerFacet
 * @author Doefin
 * @notice Diamond facet for creating and managing prediction market conditions
 * @dev Supports Bitcoin-specific question types with Oracle integration for automated resolution
 * @dev Handles condition metadata, validation, and lifecycle management
 * @dev Integrates with LibOracleAdapter for automated settlement based on Bitcoin block data
 */
contract ConditionManagerFacet is IConditionManager {
    using LibDoefinStorage for LibDoefinStorage.AppStorage;

    /**
     * @notice Creates a new condition with structured metadata and Oracle integration
     * @dev Enhanced condition creation supporting Bitcoin-specific question types
     * @dev Automatically registers questions with the Oracle adapter for settlement
     * @dev Validates question parameters against current Bitcoin block height
     * @param questionType The type of Bitcoin question (Threshold, Range, BlockCount, Duration)
     * @param metadata Encoded question parameters specific to the question type
     * @param outcomeSlotCount Number of possible outcomes (must be > 1)
     * @param metadataURI Off-chain metadata URI for question details
     * @param salt Optional salt for creating duplicate questions with same parameters
     * @return conditionId The CTF condition identifier for position creation
     * @return questionId The deterministic question identifier for Oracle resolution
     * @custom:emits ConditionCreated with complete condition details
     * @custom:reverts InvalidOutcomeSlotCount if outcomeSlotCount <= 1
     * @custom:reverts Various validation errors based on question type parameters
     * @custom:security Only market makers can create conditions
     * @custom:note Question parameters are validated against current blockchain state
     * @custom:gas Higher cost for first-time question registration with Oracle
     */
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
            (uint256 threshold, uint256 targetBlockHeight) = LibConditionMetadata.decodeDifficultyThreshold(metadata);

            // Validate parameters
            LibConditionMetadata.validateDifficultyThreshold(threshold, targetBlockHeight, outcomeSlotCount, currentBlockHeight);

            // Create oracle question
            LibOracleAdapter.createDifficultyThresholdQuestion(questionId, conditionId, threshold, targetBlockHeight);
        } else if (questionType == LibDoefinStorage.QuestionType.DifficultyRange) {
            (uint256 targetBlockHeight, uint256[] memory buckets) = LibConditionMetadata.decodeDifficultyRange(metadata);

            // Validate parameters
            LibConditionMetadata.validateDifficultyRange(targetBlockHeight, buckets, outcomeSlotCount, currentBlockHeight);

            // Create oracle question
            LibOracleAdapter.createDifficultyRangeQuestion(questionId, conditionId, targetBlockHeight, buckets);
        } else if (questionType == LibDoefinStorage.QuestionType.BlockCount) {
            (uint256 startTimestamp, uint256 endTimestamp, uint256[] memory countBuckets) = LibConditionMetadata.decodeBlockCount(metadata);

            // Validate parameters
            LibConditionMetadata.validateBlockCount(startTimestamp, endTimestamp, countBuckets, outcomeSlotCount);

            // Create oracle question
            LibOracleAdapter.createBlockCountQuestion(questionId, conditionId, startTimestamp, endTimestamp, countBuckets);
        } else if (questionType == LibDoefinStorage.QuestionType.MiningDuration) {
            (uint256 startBlockHeight, uint256 blockCount, uint256[] memory durationBuckets) = LibConditionMetadata.decodeMiningDuration(metadata);

            // Validate parameters
            LibConditionMetadata.validateMiningDuration(startBlockHeight, blockCount, durationBuckets, outcomeSlotCount, currentBlockHeight);

            // Create oracle question
            LibOracleAdapter.createMiningDurationQuestion(questionId, conditionId, startBlockHeight, blockCount, durationBuckets);
        } else {
            revert Errors.OracleAdapter_InvalidQuestionType();
        }

        emit Events.ConditionCreated(conditionId, oracle, questionId, outcomeSlotCount, metadataURI, msg.sender);

        return (conditionId, questionId);
    }

    /**
     * @notice Creates a simple condition without Oracle integration (legacy compatibility)
     * @dev Maintains backwards compatibility with basic condition creation
     * @dev Does not integrate with Oracle adapter - manual resolution required
     * @dev Used for conditions that don't require automated Bitcoin data resolution
     * @param oracle The address authorized to resolve this condition
     * @param questionId The unique question identifier
     * @param outcomeSlotCount Number of possible outcomes (must be > 1)
     * @param metadataURI Off-chain metadata URI for question details
     * @return conditionId The CTF condition identifier
     * @custom:emits ConditionCreated with condition details
     * @custom:reverts InvalidOutcomeSlotCount if outcomeSlotCount <= 1
     * @custom:security Only market makers can create conditions
     * @custom:note Oracle must manually call reportPayouts to resolve condition
     * @custom:deprecated Prefer createConditionWithMetadata for Bitcoin questions
     */
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

    /**
     * @notice Retrieves complete condition information by condition ID
     * @dev Returns the stored condition metadata including Oracle and creator details
     * @dev Useful for verifying condition parameters before creating positions
     * @param conditionId The CTF condition identifier to query
     * @return The complete Condition struct with all metadata
     * @custom:view Read-only access to condition data
     * @custom:note Returns empty struct if condition ID doesn't exist
     */
    function getCondition(bytes32 conditionId) external view override returns (LibDoefinStorage.Condition memory) {
        LibDoefinStorage.Condition storage condition = LibDoefinStorage.appStorage().conditionalTokens.conditions[conditionId];
        return condition;
    }

    /**
     * @notice Cancels an active condition before resolution
     * @dev Deactivates the condition preventing new position creation
     * @dev Only condition creator or contract owner can cancel conditions
     * @dev Existing positions remain tradeable but condition won't be resolved
     * @param conditionId The CTF condition identifier to cancel
     * @custom:emits ConditionCancelled with condition ID and canceler address
     * @custom:reverts ConditionDoesNotExist if condition was never created
     * @custom:reverts NotAuthorizedToCancel if caller lacks permission
     * @custom:reverts InvalidOracleAddress if condition has invalid Oracle
     * @custom:reverts ConditionAlreadyInactive if condition already cancelled
     * @custom:security Only creator or owner can cancel to prevent griefing
     * @custom:note Cancellation is irreversible - condition cannot be reactivated
     */
    function cancelCondition(bytes32 conditionId) external override {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        LibDoefinStorage.Condition storage cond = ds.conditionalTokens.conditions[conditionId];
        if (cond.creator == address(0)) {
            revert Errors.ConditionDoesNotExist();
        }

        if (cond.creator != msg.sender && msg.sender != LibDiamond.contractOwner()) {
            revert Errors.NotAuthorizedToCancel();
        }

        if (cond.oracle == address(0)) revert Errors.InvalidOracleAddress();

        if (!cond.active) revert Errors.ConditionAlreadyInactive();

        cond.active = false;
        emit Events.ConditionCancelled(conditionId, msg.sender);
    }
}
