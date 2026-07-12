// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.20;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";

interface IOracleAdapter {
    // ========================================
    // MUTATION FUNCTIONS
    // ========================================

    function reportOutcome(bytes32 conditionId, uint256[] calldata payouts) external;

    function linkConditionToFeed(bytes32 conditionId, bytes32 externalFeedId) external;

    // ========================================
    // VIEW FUNCTIONS - QUESTION QUERIES
    // ========================================

    /// @notice Get all threshold difficulty questions ready at a specific block height
    /// @param blockHeight The block height to query
    /// @return Array of DifficultyThresholdQuestion structs
    function getThresholdQuestionsAtBlock(uint256 blockHeight)
        external
        view
        returns (LibDoefinStorage.DifficultyThresholdQuestion[] memory);

    /// @notice Get all range difficulty questions ready at a specific block height
    /// @param blockHeight The block height to query
    /// @return Array of DifficultyRangeQuestion structs
    function getRangeQuestionsAtBlock(uint256 blockHeight)
        external
        view
        returns (LibDoefinStorage.DifficultyRangeQuestion[] memory);

    /// @notice Get all mining duration questions ready at a specific block height
    /// @param blockHeight The block height to query
    /// @return Array of MiningDurationQuestion structs
    function getDurationQuestionsAtBlock(uint256 blockHeight)
        external
        view
        returns (LibDoefinStorage.MiningDurationQuestion[] memory);

    /// @notice Get all block count questions ready at a specific timestamp
    /// @param timestamp The timestamp to query
    /// @return Array of BlockCountQuestion structs
    function getBlockCountQuestionsAtTimestamp(uint256 timestamp)
        external
        view
        returns (LibDoefinStorage.BlockCountQuestion[] memory);

    // ========================================
    // VIEW FUNCTIONS - STATISTICS
    // ========================================

    /// @notice Get total number of questions created
    /// @return The total count of questions created
    function getTotalQuestionsCreated() external view returns (uint256);

    /// @notice Get total number of questions resolved
    /// @return The total count of questions resolved
    function getTotalQuestionsResolved() external view returns (uint256);

    // ========================================
    // VIEW FUNCTIONS - TIMESTAMP/BLOCK MAPPING
    // ========================================

    /// @notice Get the timestamp of a block by its height
    /// @param blockHeight The block height
    /// @return The timestamp of the block (0 if not found)
    function getBlockTimestamp(uint256 blockHeight) external view returns (uint256);

    /// @notice Get the block height closest to a given timestamp
    /// @param timestamp The timestamp to query
    /// @return The block height (0 if not found)
    function getTimestampBlock(uint256 timestamp) external view returns (uint256);

    /// @notice Get the timestamp bucket for a given timestamp
    /// @param timestamp The timestamp to bucket
    /// @return The bucketed timestamp (rounded to TIMESTAMP_BUCKET)
    function getTimestampBucket(uint256 timestamp) external pure returns (uint256);
}
