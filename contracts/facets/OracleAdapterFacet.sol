// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.20;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {LibOracleAdapter} from "../libraries/LibOracleAdapter.sol";

/**
 * @title OracleAdapterFacet
 * @author Doefin
 * @notice Diamond facet providing view-only access to oracle adapter data and Bitcoin question queries
 * @dev Part of the Diamond pattern implementation for modular oracle data access
 * @dev Provides structured access to difficulty threshold, range, duration, and block count questions
 * @dev All functions are view-only and optimized for efficient oracle data retrieval
 * @custom:facet Oracle adapter data access and question queries
 * @custom:diamond Part of the EIP-2535 Diamond Standard implementation
 * @custom:bitcoin Specialized for Bitcoin difficulty and block-related prediction market questions
 * @custom:view Read-only access to oracle adapter storage without state modifications
 */
contract OracleAdapterFacet {
    using LibDoefinStorage for LibDoefinStorage.AppStorage;

    // ========================================
    // VIEW FUNCTIONS - QUESTION QUERIES
    // ========================================

    /**
     * @notice Retrieves all difficulty threshold questions scheduled for resolution at a specific block height
     * @dev Returns array of threshold questions that become answerable when the specified block is reached
     * @dev Threshold questions test if Bitcoin mining difficulty exceeds a specific threshold value
     * @param blockHeight The Bitcoin block height to query for ready threshold questions
     * @return Array of DifficultyThresholdQuestion structs containing threshold values and question metadata
     * @custom:view Read-only access to block-indexed threshold question storage
     * @custom:bitcoin Questions related to Bitcoin mining difficulty threshold predictions
     * @custom:block Questions indexed by Bitcoin block height for automated resolution
     * @custom:threshold Questions testing if difficulty exceeds specific numerical thresholds
     */
    function getThresholdQuestionsAtBlock(uint256 blockHeight) external view returns (LibDoefinStorage.DifficultyThresholdQuestion[] memory) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        return ds.oracleAdapterStorage.blockToThresholdQuestions[blockHeight];
    }

    /**
     * @notice Retrieves all difficulty range questions scheduled for resolution at a specific block height
     * @dev Returns array of range questions that become answerable when the specified block is reached
     * @dev Range questions test if Bitcoin mining difficulty falls within a specific numerical range
     * @param blockHeight The Bitcoin block height to query for ready range questions
     * @return Array of DifficultyRangeQuestion structs containing min/max bounds and question metadata
     * @custom:view Read-only access to block-indexed range question storage
     * @custom:bitcoin Questions related to Bitcoin mining difficulty range predictions
     * @custom:block Questions indexed by Bitcoin block height for automated resolution
     * @custom:range Questions testing if difficulty falls within specific min/max bounds
     */
    function getRangeQuestionsAtBlock(uint256 blockHeight) external view returns (LibDoefinStorage.DifficultyRangeQuestion[] memory) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        return ds.oracleAdapterStorage.blockToRangeQuestions[blockHeight];
    }

    /**
     * @notice Retrieves all mining duration questions scheduled for resolution at a specific block height
     * @dev Returns array of duration questions that become answerable when the specified block is reached
     * @dev Duration questions test how long it takes to mine a specific number of Bitcoin blocks
     * @param blockHeight The Bitcoin block height to query for ready duration questions
     * @return Array of MiningDurationQuestion structs containing duration parameters and question metadata
     * @custom:view Read-only access to block-indexed duration question storage
     * @custom:bitcoin Questions related to Bitcoin block mining time predictions
     * @custom:block Questions indexed by Bitcoin block height for automated resolution
     * @custom:duration Questions testing mining time duration for specific block ranges
     */
    function getDurationQuestionsAtBlock(uint256 blockHeight) external view returns (LibDoefinStorage.MiningDurationQuestion[] memory) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        return ds.oracleAdapterStorage.blockToDurationQuestions[blockHeight];
    }

    /**
     * @notice Retrieves all block count questions scheduled for resolution at a specific timestamp
     * @dev Returns array of block count questions that become answerable at the specified timestamp
     * @dev Block count questions test how many Bitcoin blocks will be mined by a specific time
     * @dev Uses timestamp bucketing for efficient storage and querying of time-based questions
     * @param timestamp The timestamp to query for ready block count questions
     * @return Array of BlockCountQuestion structs containing block count parameters and question metadata
     * @custom:view Read-only access to timestamp-indexed block count question storage
     * @custom:bitcoin Questions related to Bitcoin block count predictions over time
     * @custom:timestamp Questions indexed by timestamp with bucketing for efficient storage
     * @custom:bucketing Uses LibOracleAdapter.getTimestampBucket for timestamp normalization
     */
    function getBlockCountQuestionsAtTimestamp(uint256 timestamp) external view returns (LibDoefinStorage.BlockCountQuestion[] memory) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        uint256 bucket = LibOracleAdapter.getTimestampBucket(timestamp);
        return ds.oracleAdapterStorage.timestampToBlockCountQuestions[bucket];
    }

    // ========================================
    // VIEW FUNCTIONS - STATISTICS
    // ========================================

    /**
     * @notice Retrieves the total number of Bitcoin prediction questions created in the system
     * @dev Returns cumulative count across all question types (threshold, range, duration, block count)
     * @dev Useful for analytics, monitoring question creation activity, and system usage metrics
     * @return The total count of all questions created since contract deployment
     * @custom:view Read-only access to oracle adapter statistics storage
     * @custom:analytics Provides system-wide question creation metrics
     * @custom:cumulative Running total of all questions ever created
     * @custom:monitoring Essential metric for protocol usage and activity tracking
     */
    function getTotalQuestionsCreated() external view returns (uint256) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        return ds.oracleAdapterStorage.totalQuestionsCreated;
    }

    /**
     * @notice Retrieves the total number of Bitcoin prediction questions resolved in the system
     * @dev Returns cumulative count of questions that have been answered and settled
     * @dev Essential for tracking oracle adapter performance and question resolution rate
     * @return The total count of all questions resolved since contract deployment
     * @custom:view Read-only access to oracle adapter resolution statistics
     * @custom:analytics Provides system-wide question resolution metrics
     * @custom:cumulative Running total of all questions ever resolved
     * @custom:oracle Essential metric for oracle adapter reliability and performance
     */
    function getTotalQuestionsResolved() external view returns (uint256) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        return ds.oracleAdapterStorage.totalQuestionsResolved;
    }

    // ========================================
    // VIEW FUNCTIONS - TIMESTAMP/BLOCK MAPPING
    // ========================================

    /**
     * @notice Retrieves the timestamp of a Bitcoin block by its block height
     * @dev Returns the recorded timestamp when the specified block was mined
     * @dev Essential for converting between block-based and time-based question resolution
     * @param blockHeight The Bitcoin block height to query timestamp for
     * @return The Unix timestamp of the block (0 if block height not found in records)
     * @custom:view Read-only access to block height to timestamp mapping storage
     * @custom:bitcoin Maps Bitcoin block heights to their corresponding timestamps
     * @custom:conversion Essential for time-based calculations and question resolution
     * @custom:oracle Enables block-to-time conversion for oracle adapter operations
     */
    function getBlockTimestamp(uint256 blockHeight) external view returns (uint256) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        return ds.oracleAdapterStorage.blockHeightToTimestamp[blockHeight];
    }

    /**
     * @notice Retrieves the Bitcoin block height closest to a given timestamp
     * @dev Returns the block height that was mined nearest to the specified time
     * @dev Essential for converting time-based questions to block-based resolution
     * @param timestamp The Unix timestamp to query for corresponding block height
     * @return The Bitcoin block height (0 if timestamp not found in records)
     * @custom:view Read-only access to timestamp to block height mapping storage
     * @custom:bitcoin Maps timestamps to their closest Bitcoin block heights
     * @custom:conversion Essential for time-to-block conversion for oracle adapter operations
     * @custom:oracle Enables timestamp-based question resolution using block data
     */
    function getTimestampBlock(uint256 timestamp) external view returns (uint256) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        return ds.oracleAdapterStorage.timestampToBlockHeight[timestamp];
    }

    /**
     * @notice Calculates the timestamp bucket for efficient storage and querying of time-based data
     * @dev Returns normalized timestamp rounded to the configured TIMESTAMP_BUCKET interval
     * @dev Delegates to LibOracleAdapter.getTimestampBucket for consistent bucketing logic
     * @dev Essential for understanding how timestamps are bucketed in storage mappings
     * @param timestamp The timestamp to normalize into a bucket
     * @return The bucketed timestamp (rounded to TIMESTAMP_BUCKET interval)
     * @custom:pure Pure function with no storage access for gas efficiency
     * @custom:bucketing Timestamp normalization for efficient storage organization
     * @custom:delegation Delegates to LibOracleAdapter for consistent bucketing implementation
     * @custom:storage Essential for understanding timestamp-based storage organization
     */
    function getTimestampBucket(uint256 timestamp) external pure returns (uint256) {
        return LibOracleAdapter.getTimestampBucket(timestamp);
    }
}
