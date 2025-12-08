/**
 * Oracle Adapter Test Utilities
 * Helper functions for testing LibOracleAdapter and Oracle-related functionality
 */

const { ethers } = require("hardhat");

// Question Type Enum
const QuestionType = {
  DifficultyThreshold: 0,
  DifficultyRange: 1,
  BlockCount: 2,
  MiningDuration: 3,
};

/**
 * Encode DifficultyThreshold question metadata
 */
function encodeDifficultyThreshold(threshold, targetBlockHeight) {
  const abiCoder = ethers.utils.defaultAbiCoder;
  return abiCoder.encode(["uint256", "uint256"], [threshold, targetBlockHeight]);
}

/**
 * Encode DifficultyRange question metadata
 */
function encodeDifficultyRange(targetBlockHeight, buckets) {
  const abiCoder = ethers.utils.defaultAbiCoder;
  return abiCoder.encode(["uint256", "uint256[]"], [targetBlockHeight, buckets]);
}

/**
 * Encode BlockCount question metadata
 */
function encodeBlockCount(startTimestamp, endTimestamp, countBuckets) {
  const abiCoder = ethers.utils.defaultAbiCoder;
  return abiCoder.encode(
    ["uint256", "uint256", "uint256[]"],
    [startTimestamp, endTimestamp, countBuckets]
  );
}

/**
 * Encode MiningDuration question metadata
 */
function encodeMiningDuration(startBlockHeight, blockCount, durationBuckets) {
  const abiCoder = ethers.utils.defaultAbiCoder;
  return abiCoder.encode(
    ["uint256", "uint256", "uint256[]"],
    [startBlockHeight, blockCount, durationBuckets]
  );
}

/**
 * Generate a deterministic question ID
 */
function generateQuestionId(
  conditionMetadataLib,
  questionType,
  metadata,
  salt = ethers.ZeroHash
) {
  return conditionMetadataLib.generateQuestionId(
    questionType,
    metadata,
    salt
  );
}

/**
 * Get timestamp bucket for a given timestamp
 */
function getTimestampBucket(timestamp, bucketSize = 600) {
  return Math.floor(timestamp / bucketSize) * bucketSize;
}

/**
 * Create test bucket values (sorted)
 */
function createTestBuckets(count, baseValue) {
  const buckets = [];
  for (let i = 1; i <= count; i++) {
    buckets.push(baseValue * i);
  }
  return buckets;
}

/**
 * Convert difficulty from compact nBits format to full value
 */
function calculateDifficulty(nBits) {
  const exponent = nBits >> 24;
  const mantissa = nBits & 0xffffff;

  if (exponent <= 3) {
    return mantissa / Math.pow(256, 3 - exponent);
  } else {
    return mantissa * Math.pow(256, exponent - 3);
  }
}

module.exports = {
  QuestionType,
  encodeDifficultyThreshold,
  encodeDifficultyRange,
  encodeBlockCount,
  encodeMiningDuration,
  generateQuestionId,
  getTimestampBucket,
  createTestBuckets,
  calculateDifficulty,
};
