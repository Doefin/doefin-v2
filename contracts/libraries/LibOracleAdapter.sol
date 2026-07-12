// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.20;

import {Errors} from "./Errors.sol";
import {Events} from "./Events.sol";
import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {BlockHeaderUtils} from "./BlockHeaderUtils.sol";
import {LibCTFCondition} from "./LibCTFCondition.sol";

/// @title LibOracleAdapter
/// @notice Coordinates resolution of Bitcoin difficulty conditions
/// @dev Called by BlockHeaderOracle after each block submission
library LibOracleAdapter {
    // ========================================
    // QUESTION CREATION FUNCTIONS
    // ========================================

    /// @notice Create a DifficultyThreshold question
    /// @param questionId Unique question identifier
    /// @param conditionId Associated CTF condition ID
    /// @param threshold Difficulty threshold value
    /// @param targetBlockHeight Block height to measure difficulty at
    function createDifficultyThresholdQuestion(bytes32 questionId, bytes32 conditionId, uint256 threshold, uint256 targetBlockHeight) internal {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        // Apply settlement delay
        uint256 settlementBlock = targetBlockHeight + LibDoefinStorage.SETTLEMENT_DELAY;

        // Register question
        ds.oracleAdapterStorage.blockToThresholdQuestions[settlementBlock].push(
            LibDoefinStorage.DifficultyThresholdQuestion({
                questionId: questionId,
                conditionId: conditionId,
                threshold: threshold,
                targetBlockHeight: targetBlockHeight
            })
        );

        // Update stats
        ds.oracleAdapterStorage.totalQuestionsCreated++;

        // Emit generic event
        emit Events.QuestionCreated(questionId, conditionId, LibDoefinStorage.QuestionType.DifficultyThreshold, settlementBlock, msg.sender);

        // Emit specialized event with all question parameters
        emit Events.DifficultyThresholdQuestionCreated(questionId, conditionId, threshold, targetBlockHeight, settlementBlock, msg.sender);
    }

    /// @notice Create a DifficultyRange question
    /// @param questionId Unique question identifier
    /// @param conditionId Associated CTF condition ID
    /// @param targetBlockHeight Block height to measure difficulty at
    /// @param buckets Difficulty range boundaries (must be sorted ascending)
    function createDifficultyRangeQuestion(bytes32 questionId, bytes32 conditionId, uint256 targetBlockHeight, uint256[] memory buckets) internal {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        // Apply settlement delay
        uint256 settlementBlock = targetBlockHeight + LibDoefinStorage.SETTLEMENT_DELAY;

        // Register question
        ds.oracleAdapterStorage.blockToRangeQuestions[settlementBlock].push(
            LibDoefinStorage.DifficultyRangeQuestion({
                questionId: questionId,
                conditionId: conditionId,
                targetBlockHeight: targetBlockHeight,
                buckets: buckets
            })
        );

        // Update stats
        ds.oracleAdapterStorage.totalQuestionsCreated++;

        // Emit generic event
        emit Events.QuestionCreated(questionId, conditionId, LibDoefinStorage.QuestionType.DifficultyRange, settlementBlock, msg.sender);

        // Emit specialized event with all question parameters
        emit Events.DifficultyRangeQuestionCreated(questionId, conditionId, targetBlockHeight, buckets, settlementBlock, msg.sender);
    }

    /// @notice Create a BlockCount question
    /// @param questionId Unique question identifier
    /// @param conditionId Associated CTF condition ID
    /// @param startTimestamp Start of time window
    /// @param endTimestamp End of time window
    /// @param countBuckets Block count range boundaries (must be sorted ascending)
    function createBlockCountQuestion(
        bytes32 questionId,
        bytes32 conditionId,
        uint256 startTimestamp,
        uint256 endTimestamp,
        uint256[] memory countBuckets
    ) internal {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        // For timestamp-based questions, register at timestamp bucket (no settlement delay)
        uint256 bucket = getTimestampBucket(endTimestamp);

        // Register question
        ds.oracleAdapterStorage.timestampToBlockCountQuestions[bucket].push(
            LibDoefinStorage.BlockCountQuestion({
                questionId: questionId,
                conditionId: conditionId,
                startTimestamp: startTimestamp,
                endTimestamp: endTimestamp,
                countBuckets: countBuckets
            })
        );

        // Update stats
        ds.oracleAdapterStorage.totalQuestionsCreated++;

        // Emit generic event
        emit Events.QuestionCreated(questionId, conditionId, LibDoefinStorage.QuestionType.BlockCount, bucket, msg.sender);

        // Emit specialized event with all question parameters
        emit Events.BlockCountQuestionCreated(questionId, conditionId, startTimestamp, endTimestamp, countBuckets, bucket, msg.sender);
    }

    /// @notice Create a MiningDuration question
    /// @param questionId Unique question identifier
    /// @param conditionId Associated CTF condition ID
    /// @param startBlockHeight Starting block height
    /// @param blockCount Number of blocks to measure duration for
    /// @param durationBuckets Duration range boundaries in seconds (must be sorted ascending)
    function createMiningDurationQuestion(
        bytes32 questionId,
        bytes32 conditionId,
        uint256 startBlockHeight,
        uint256 blockCount,
        uint256[] memory durationBuckets
    ) internal {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        // Apply settlement delay to the end block
        uint256 endBlockHeight = startBlockHeight + blockCount;
        uint256 settlementBlock = endBlockHeight + LibDoefinStorage.SETTLEMENT_DELAY;

        // Register question
        ds.oracleAdapterStorage.blockToDurationQuestions[settlementBlock].push(
            LibDoefinStorage.MiningDurationQuestion({
                questionId: questionId,
                conditionId: conditionId,
                startBlockHeight: startBlockHeight,
                blockCount: blockCount,
                durationBuckets: durationBuckets
            })
        );

        // Update stats
        ds.oracleAdapterStorage.totalQuestionsCreated++;

        // Emit generic event
        emit Events.QuestionCreated(questionId, conditionId, LibDoefinStorage.QuestionType.MiningDuration, settlementBlock, msg.sender);

        // Emit specialized event with all question parameters
        emit Events.MiningDurationQuestionCreated(
            questionId,
            conditionId,
            startBlockHeight,
            blockCount,
            durationBuckets,
            settlementBlock,
            msg.sender
        );
    }

    // ========================================
    // MAIN ENTRY POINT
    // ========================================

    /// @notice Main settlement function called after each block submission
    /// @dev Checks for conditions ready at current block and timestamp, then resolves them
    function settleCondition() internal {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        uint256 currentHeight = ds.blockHeaderOracleStorage.currentBlockHeight;
        LibDoefinStorage.BlockHeader memory latestBlock = _getLatestBlockHeader();
        uint256 currentTimestamp = latestBlock.timestamp;

        // Update auxiliary mappings for timestamp queries
        _updateAuxiliaryMappings(currentHeight, currentTimestamp);

        // Resolve block-number based conditions
        _resolveConditionsAtBlock(currentHeight);

        // Resolve timestamp-based conditions
        _resolveConditionsAtTimestamp(currentTimestamp);
    }

    // ========================================
    // RESOLUTION COORDINATORS
    // ========================================

    /// @notice Resolve all conditions ready at a specific block height
    /// @param blockHeight The block height to check for ready conditions
    function _resolveConditionsAtBlock(uint256 blockHeight) private {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        // Resolve DifficultyThreshold questions
        LibDoefinStorage.DifficultyThresholdQuestion[] storage thresholdQuestions = ds.oracleAdapterStorage.blockToThresholdQuestions[blockHeight];

        for (uint256 i = thresholdQuestions.length; i > 0; i--) {
            _resolveDifficultyThresholdQuestion(thresholdQuestions[i - 1]);
            thresholdQuestions.pop(); // Remove after resolution for gas refund
        }

        // Resolve DifficultyRange questions
        LibDoefinStorage.DifficultyRangeQuestion[] storage rangeQuestions = ds.oracleAdapterStorage.blockToRangeQuestions[blockHeight];

        for (uint256 i = rangeQuestions.length; i > 0; i--) {
            _resolveDifficultyRangeQuestion(rangeQuestions[i - 1]);
            rangeQuestions.pop();
        }

        // Resolve MiningDuration questions
        LibDoefinStorage.MiningDurationQuestion[] storage durationQuestions = ds.oracleAdapterStorage.blockToDurationQuestions[blockHeight];

        for (uint256 i = durationQuestions.length; i > 0; i--) {
            _resolveMiningDurationQuestion(durationQuestions[i - 1]);
            durationQuestions.pop();
        }
    }

    /// @notice Resolve all conditions ready at a specific timestamp
    /// @param timestamp The current block timestamp
    function _resolveConditionsAtTimestamp(uint256 timestamp) private {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        // Get timestamp bucket
        uint256 bucket = getTimestampBucket(timestamp);

        // Resolve BlockCount questions
        LibDoefinStorage.BlockCountQuestion[] storage blockCountQuestions = ds.oracleAdapterStorage.timestampToBlockCountQuestions[bucket];

        for (uint256 i = blockCountQuestions.length; i > 0; i--) {
            LibDoefinStorage.BlockCountQuestion storage question = blockCountQuestions[i - 1];

            // Check if this question's endTimestamp has been reached
            if (timestamp >= question.endTimestamp) {
                _resolveBlockCountQuestion(question);
                blockCountQuestions.pop();
            }
        }
    }

    // ========================================
    // TYPE-SPECIFIC RESOLUTION DISPATCHERS
    // ========================================

    /// @notice Resolve a DifficultyThreshold question
    /// @param question The question to resolve
    function _resolveDifficultyThresholdQuestion(LibDoefinStorage.DifficultyThresholdQuestion storage question) private {
        // Get actual difficulty at target block
        uint256 actualDifficulty = _getBlockDifficulty(question.targetBlockHeight);

        // Determine outcome: [0] = No (≤ threshold), [1] = Yes (> threshold)
        uint256[] memory payouts = new uint256[](2);
        if (actualDifficulty > question.threshold) {
            payouts[0] = 0;
            payouts[1] = 1;
        } else {
            payouts[0] = 1;
            payouts[1] = 0;
        }

        // Report to CTF
        LibCTFCondition._reportPayouts(address(this), question.questionId, payouts);

        // Update stats
        LibDoefinStorage.appStorage().oracleAdapterStorage.totalQuestionsResolved++;
    }

    /// @notice Resolve a DifficultyRange question
    /// @param question The question to resolve
    function _resolveDifficultyRangeQuestion(LibDoefinStorage.DifficultyRangeQuestion storage question) private {
        // Get actual difficulty at target block
        uint256 actualDifficulty = _getBlockDifficulty(question.targetBlockHeight);

        // Find which bucket the difficulty falls into
        uint256 outcomeSlotCount = question.buckets.length + 1;
        uint256 winningIndex = _findBucketIndex(actualDifficulty, question.buckets);

        // Create payout vector
        uint256[] memory payouts = new uint256[](outcomeSlotCount);
        payouts[winningIndex] = 1;

        // Report to CTF
        LibCTFCondition._reportPayouts(address(this), question.questionId, payouts);

        // Update stats
        LibDoefinStorage.appStorage().oracleAdapterStorage.totalQuestionsResolved++;
    }

    /// @notice Resolve a BlockCount question
    /// @param question The question to resolve
    function _resolveBlockCountQuestion(LibDoefinStorage.BlockCountQuestion storage question) private {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        // Get block heights at start and end timestamps
        uint256 startBlockHeight = ds.oracleAdapterStorage.timestampToBlockHeight[question.startTimestamp];
        uint256 endBlockHeight = ds.oracleAdapterStorage.timestampToBlockHeight[question.endTimestamp];

        // If exact timestamps not found, find nearest blocks
        if (startBlockHeight == 0) {
            startBlockHeight = _findBlockByTimestamp(question.startTimestamp);
        }
        if (endBlockHeight == 0) {
            endBlockHeight = _findBlockByTimestamp(question.endTimestamp);
        }

        // Calculate actual block count
        uint256 actualBlockCount = endBlockHeight - startBlockHeight;

        // Find which bucket the count falls into
        uint256 outcomeSlotCount = question.countBuckets.length + 1;
        uint256 winningIndex = _findBucketIndex(actualBlockCount, question.countBuckets);

        // Create payout vector
        uint256[] memory payouts = new uint256[](outcomeSlotCount);
        payouts[winningIndex] = 1;

        // Report to CTF
        LibCTFCondition._reportPayouts(address(this), question.questionId, payouts);

        // Update stats
        ds.oracleAdapterStorage.totalQuestionsResolved++;
    }

    /// @notice Resolve a MiningDuration question
    /// @param question The question to resolve
    function _resolveMiningDurationQuestion(LibDoefinStorage.MiningDurationQuestion storage question) private {
        // Get start and end block headers
        LibDoefinStorage.BlockHeader memory startBlock = _getBlockHeaderByNumber(question.startBlockHeight);
        LibDoefinStorage.BlockHeader memory endBlock = _getBlockHeaderByNumber(question.startBlockHeight + question.blockCount);

        // Calculate actual mining duration
        uint256 actualDuration = endBlock.timestamp - startBlock.timestamp;

        // Find which bucket the duration falls into
        uint256 outcomeSlotCount = question.durationBuckets.length + 1;
        uint256 winningIndex = _findBucketIndex(actualDuration, question.durationBuckets);

        // Create payout vector
        uint256[] memory payouts = new uint256[](outcomeSlotCount);
        payouts[winningIndex] = 1;

        // Report to CTF
        LibCTFCondition._reportPayouts(address(this), question.questionId, payouts);

        // Update stats
        LibDoefinStorage.appStorage().oracleAdapterStorage.totalQuestionsResolved++;
    }

    // ========================================
    // HELPER FUNCTIONS
    // ========================================

    /// @notice Calculate timestamp bucket for efficient lookup
    /// @param timestamp The timestamp to bucket
    /// @return The bucketed timestamp
    /// @dev The `(t / BUCKET) * BUCKET` shape is an intentional bucket-floor — division
    ///      truncates to the floor, multiplication recovers the bucket boundary. Slither's
    ///      `divide-before-multiply` heuristic flags any expression of this shape because
    ///      it can lose precision; here the precision loss IS the operation (flooring).
    // slither-disable-next-line divide-before-multiply
    function getTimestampBucket(uint256 timestamp) internal pure returns (uint256) {
        return (timestamp / LibDoefinStorage.TIMESTAMP_BUCKET) * LibDoefinStorage.TIMESTAMP_BUCKET;
    }

    /// @notice Find which bucket index a value falls into
    /// @param value The value to categorize
    /// @param buckets The sorted bucket boundaries
    /// @return The index of the bucket (0 to buckets.length)
    function _findBucketIndex(uint256 value, uint256[] storage buckets) private view returns (uint256) {
        if (buckets.length == 0) {
            revert Errors.OracleAdapter_InvalidBucketConfiguration();
        }

        // Check if below first bucket
        if (value < buckets[0]) {
            return 0;
        }

        // Check if above or equal to last bucket
        if (value >= buckets[buckets.length - 1]) {
            return buckets.length;
        }

        // Find the bucket range (linear search for small arrays)
        for (uint256 i = 0; i < buckets.length - 1; i++) {
            if (value >= buckets[i] && value < buckets[i + 1]) {
                return i + 1;
            }
        }

        revert Errors.OracleAdapter_InvalidBucketConfiguration();
    }

    /// @notice Update auxiliary mappings for timestamp/block conversions
    /// @param blockHeight The block height
    /// @param timestamp The block timestamp
    function _updateAuxiliaryMappings(uint256 blockHeight, uint256 timestamp) private {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        ds.oracleAdapterStorage.timestampToBlockHeight[timestamp] = blockHeight;
        ds.oracleAdapterStorage.blockHeightToTimestamp[blockHeight] = timestamp;
    }

    /// @notice Find block height closest to a given timestamp
    /// @param targetTimestamp The target timestamp
    /// @return blockHeight The closest block height
    function _findBlockByTimestamp(uint256 targetTimestamp) private view returns (uint256 blockHeight) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        // Try exact match first
        blockHeight = ds.oracleAdapterStorage.timestampToBlockHeight[targetTimestamp];
        if (blockHeight != 0) {
            return blockHeight;
        }

        // Search within ±10 blocks (approximately ±100 minutes)
        for (uint256 i = 1; i <= 10; i++) {
            // Try forward
            blockHeight = ds.oracleAdapterStorage.timestampToBlockHeight[targetTimestamp + (i * 60)];
            if (blockHeight != 0) {
                return blockHeight;
            }

            // Try backward
            if (targetTimestamp >= i * 60) {
                blockHeight = ds.oracleAdapterStorage.timestampToBlockHeight[targetTimestamp - (i * 60)];
                if (blockHeight != 0) {
                    return blockHeight;
                }
            }
        }

        revert Errors.OracleAdapter_BlockNotFoundForTimestamp();
    }

    /// @notice Get difficulty of a block at specific height
    /// @param blockHeight The block height
    /// @return The difficulty value
    function _getBlockDifficulty(uint256 blockHeight) private view returns (uint256) {
        LibDoefinStorage.BlockHeader memory blockHeader = _getBlockHeaderByNumber(blockHeight);
        return BlockHeaderUtils.calculateDifficulty(blockHeader);
    }

    /// @notice Get block header by block number
    /// @param blockNumber The block number
    /// @return The block header
    function _getBlockHeaderByNumber(uint256 blockNumber) private view returns (LibDoefinStorage.BlockHeader memory) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        uint256 currentHeight = ds.blockHeaderOracleStorage.currentBlockHeight;

        // Verify block is within buffer range
        if (blockNumber > currentHeight || blockNumber <= currentHeight - LibDoefinStorage.NUM_OF_BLOCK_HEADERS) {
            revert Errors.OracleAdapter_BlockNotInBuffer();
        }

        // Calculate ring buffer index
        uint256 offset = currentHeight - blockNumber;
        uint256 index = (ds.blockHeaderOracleStorage.nextBlockIndex + LibDoefinStorage.NUM_OF_BLOCK_HEADERS - offset - 1) %
            LibDoefinStorage.NUM_OF_BLOCK_HEADERS;

        return ds.blockHeaderOracleStorage.blockHeaders[index];
    }

    /// @notice Get the latest block header
    /// @return The latest block header
    function _getLatestBlockHeader() private view returns (LibDoefinStorage.BlockHeader memory) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        uint256 currentBlockIndex = ((ds.blockHeaderOracleStorage.nextBlockIndex + LibDoefinStorage.NUM_OF_BLOCK_HEADERS) - 1) %
            LibDoefinStorage.NUM_OF_BLOCK_HEADERS;
        return ds.blockHeaderOracleStorage.blockHeaders[currentBlockIndex];
    }
}
