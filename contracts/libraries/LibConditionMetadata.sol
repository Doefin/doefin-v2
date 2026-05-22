// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {Errors} from "./Errors.sol";

/// @title LibConditionMetadata
/// @notice Library for encoding, decoding, and validating condition metadata
library LibConditionMetadata {
    
    // ========================================
    // QUESTION ID GENERATION
    // ========================================
    
    /// @notice Generate deterministic questionId for any question type
    /// @param questionType The type of question
    /// @param metadata Encoded question parameters
    /// @param salt Optional salt for duplicate questions
    /// @return questionId Deterministic question identifier
    function generateQuestionId(
        LibDoefinStorage.QuestionType questionType,
        bytes memory metadata,
        bytes32 salt
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(questionType, keccak256(metadata), salt));
    }
    
    // ========================================
    // DECODING FUNCTIONS
    // ========================================
    //
    // @dev Question metadata is encoded OFF-CHAIN (the JS helpers in
    //      `test/utils/oracleAdapterUtils.js` and the admin scripts under
    //      `scripts/admin-scripts/`); `ConditionManagerFacet.createConditionWithMetadata`
    //      accepts the already-encoded `bytes` blob. The on-chain symmetric
    //      `encode*` helpers were removed in the SCRUM-234 dead-code pass —
    //      they were never invoked by any production caller and the
    //      reachability analysis confirmed zero callsites in `contracts/`.
    //      Each `decode*` below mirrors the layout the JS side produces.


    /// @notice Decode DifficultyThreshold metadata
    function decodeDifficultyThreshold(bytes memory metadata)
        internal pure
        returns (uint256 threshold, uint256 targetBlockHeight)
    {
        return abi.decode(metadata, (uint256, uint256));
    }
    
    /// @notice Decode DifficultyRange metadata
    function decodeDifficultyRange(bytes memory metadata)
        internal pure
        returns (uint256 targetBlockHeight, uint256[] memory buckets)
    {
        return abi.decode(metadata, (uint256, uint256[]));
    }
    
    /// @notice Decode BlockCount metadata
    function decodeBlockCount(bytes memory metadata)
        internal pure
        returns (
            uint256 startTimestamp,
            uint256 endTimestamp,
            uint256[] memory countBuckets
        )
    {
        return abi.decode(metadata, (uint256, uint256, uint256[]));
    }
    
    /// @notice Decode MiningDuration metadata
    function decodeMiningDuration(bytes memory metadata)
        internal pure
        returns (
            uint256 startBlockHeight,
            uint256 blockCount,
            uint256[] memory durationBuckets
        )
    {
        return abi.decode(metadata, (uint256, uint256, uint256[]));
    }
    
    // ========================================
    // VALIDATION FUNCTIONS
    // ========================================
    
    /// @notice Validate DifficultyThreshold parameters
    function validateDifficultyThreshold(
        uint256 threshold,
        uint256 targetBlockHeight,
        uint256 outcomeSlotCount,
        uint256 currentBlockHeight
    ) internal pure {
        if (outcomeSlotCount != 2) {
            revert Errors.InvalidOutcomeSlotCount();
        }
        if (threshold == 0) {
            revert Errors.ZeroAmount();
        }
        if (targetBlockHeight <= currentBlockHeight) {
            revert Errors.ValueOutOfRange();
        }
    }
    
    /// @notice Validate DifficultyRange parameters
    function validateDifficultyRange(
        uint256 targetBlockHeight,
        uint256[] memory buckets,
        uint256 outcomeSlotCount,
        uint256 currentBlockHeight
    ) internal pure {
        if (outcomeSlotCount != buckets.length + 1) {
            revert Errors.InvalidOutcomeSlotCount();
        }
        if (buckets.length == 0 || buckets.length > LibDoefinStorage.MAX_BUCKETS) {
            revert Errors.ValueOutOfRange();
        }
        if (targetBlockHeight <= currentBlockHeight) {
            revert Errors.ValueOutOfRange();
        }
        
        // Validate buckets are strictly monotonically increasing
        for (uint256 i = 0; i < buckets.length - 1; i++) {
            if (buckets[i] >= buckets[i + 1]) {
                revert Errors.ValueOutOfRange();
            }
            if (buckets[i] == 0) {
                revert Errors.ZeroAmount();
            }
        }
        if (buckets[buckets.length - 1] == 0) {
            revert Errors.ZeroAmount();
        }
    }
    
    /// @notice Validate BlockCount parameters
    function validateBlockCount(
        uint256 startTimestamp,
        uint256 endTimestamp,
        uint256[] memory countBuckets,
        uint256 outcomeSlotCount
    ) internal view {
        if (outcomeSlotCount != countBuckets.length + 1) {
            revert Errors.InvalidOutcomeSlotCount();
        }
        if (countBuckets.length == 0 || countBuckets.length > LibDoefinStorage.MAX_BUCKETS) {
            revert Errors.ValueOutOfRange();
        }
        if (endTimestamp <= startTimestamp) {
            revert Errors.ValueOutOfRange();
        }
        if (startTimestamp <= block.timestamp) {
            revert Errors.ValueOutOfRange();
        }
        
        // Validate buckets are strictly monotonically increasing
        for (uint256 i = 0; i < countBuckets.length - 1; i++) {
            if (countBuckets[i] >= countBuckets[i + 1]) {
                revert Errors.ValueOutOfRange();
            }
            if (countBuckets[i] == 0) {
                revert Errors.ZeroAmount();
            }
        }
        if (countBuckets[countBuckets.length - 1] == 0) {
            revert Errors.ZeroAmount();
        }
        
        // Validate reasonable block count
        if (countBuckets[countBuckets.length - 1] > LibDoefinStorage.MAX_BLOCK_COUNT) {
            revert Errors.ValueOutOfRange();
        }
    }
    
    /// @notice Validate MiningDuration parameters
    function validateMiningDuration(
        uint256 startBlockHeight,
        uint256 blockCount,
        uint256[] memory durationBuckets,
        uint256 outcomeSlotCount,
        uint256 currentBlockHeight
    ) internal pure {
        if (outcomeSlotCount != durationBuckets.length + 1) {
            revert Errors.InvalidOutcomeSlotCount();
        }
        if (durationBuckets.length == 0 || durationBuckets.length > LibDoefinStorage.MAX_BUCKETS) {
            revert Errors.ValueOutOfRange();
        }
        if (startBlockHeight <= currentBlockHeight) {
            revert Errors.ValueOutOfRange();
        }
        if (blockCount == 0 || blockCount > LibDoefinStorage.MAX_BLOCK_COUNT) {
            revert Errors.ValueOutOfRange();
        }
        
        // Validate buckets are strictly monotonically increasing
        for (uint256 i = 0; i < durationBuckets.length - 1; i++) {
            if (durationBuckets[i] >= durationBuckets[i + 1]) {
                revert Errors.ValueOutOfRange();
            }
            if (durationBuckets[i] == 0) {
                revert Errors.ZeroAmount();
            }
        }
        if (durationBuckets[durationBuckets.length - 1] == 0) {
            revert Errors.ZeroAmount();
        }
        
        // Validate reasonable duration
        if (durationBuckets[durationBuckets.length - 1] > LibDoefinStorage.MAX_DURATION) {
            revert Errors.ValueOutOfRange();
        }
    }
}
