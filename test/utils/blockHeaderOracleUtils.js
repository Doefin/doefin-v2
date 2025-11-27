/**
 * Block Header Oracle Test Utilities
 * Provides helper functions for testing the DoefinV1BlockHeaderOracle contract
 */

const { ethers } = require("hardhat");

// Load production blocks from the feed data file
let productionBlocksCache = null;

/**
 * Load production blocks from the feed data file
 * Uses first 17 blocks for initialization, remaining for testing
 */
function loadProductionBlocks() {
  if (productionBlocksCache) {
    return productionBlocksCache;
  }

  // Try to load from production data file first
  try {
    const productionData = require("../../test/data/blocks-production.json");
    const blocks = productionData.blocks;

    // Convert Bitcoin block format to contract format
    const contractBlocks = blocks
      .reverse() // Reverse because blocks are in descending height order
      .map((block) => ({
        version: block.version,
        prevBlockHash: "0x" + block.parentHash,
        merkleRootHash: "0x" + block.merkleRoot,
        timestamp: block.timestamp,
        nBits: block.bits,
        nonce: block.nonce,
        blockHash: "0x" + block.hash,
        blockNumber: block.height,
      }));

    // Split: first 17 for initialization, rest for testing
    const INIT_BLOCK_COUNT = 17;
    const initBlocks = contractBlocks.slice(0, INIT_BLOCK_COUNT);
    const testBlocks = contractBlocks.slice(INIT_BLOCK_COUNT);
    const initialHeight = contractBlocks[0].blockNumber;

    productionBlocksCache = {
      all: contractBlocks,
      init: initBlocks,
      test: testBlocks,
      initialHeight: initialHeight,
      totalCount: contractBlocks.length,
    };

    return productionBlocksCache;
  } catch (err) {
    console.warn(
      "Could not load production blocks, falling back to default",
      err.message
    );

    // Fallback to the old static data if available
    try {
      const blockHeadersData = require("../../scripts/block-headers-feed.json");
      return {
        all: [
          ...(blockHeadersData.initializationData?.blockHeaders || []),
          ...(blockHeadersData.testingData?.blockHeaders || []),
        ],
        init: blockHeadersData.initializationData?.blockHeaders || [],
        test: blockHeadersData.testingData?.blockHeaders || [],
        initialHeight:
          blockHeadersData.initializationData?.initialBlockHeight || 0,
        totalCount: 20,
      };
    } catch (fallbackErr) {
      throw new Error(
        `Failed to load blocks data: ${err.message}, ${fallbackErr.message}`
      );
    }
  }
}

/**
 * Submit a single block header to the oracle
 */
async function submitBlockHeader({ oracle, blockHeader, caller }) {
  return oracle
    .connect(caller)
    .submitNextBlock(blockHeader);
}

/**
 * Submit multiple block headers in a batch
 */
async function submitBatchBlocks({ oracle, blockHeaders, caller }) {
  return oracle
    .connect(caller)
    .submitBatchBlocks(blockHeaders);
}

/**
 * Get the current block height from the oracle
 */
async function getCurrentBlockHeight(oracle) {
  return oracle.getCurrentBlockHeight();
}

/**
 * Get the next index in the ring buffer
 */
async function getNextBlockIndex(oracle) {
  return oracle.getNextBlockIndex();
}

/**
 * Get a specific block header by index
 */
async function getBlockHeaderAt({ oracle, index }) {
  return oracle.getBlockHeaderAt(index);
}

/**
 * Get a block header by block number
 */
async function getBlockHeaderByNumber({ oracle, blockNumber }) {
  return oracle.getBlockHeaderByNumber(blockNumber);
}

/**
 * Get the latest block header
 */
async function getLatestBlockHeader(oracle) {
  return oracle.getLatestBlockHeader();
}

/**
 * Get all block headers in the buffer
 */
async function getAllBlockHeaders(oracle) {
  return oracle.getAllBlockHeaders();
}

/**
 * Get the median block time
 */
async function getMedianBlockTime(oracle) {
  return oracle.medianBlockTime();
}

/**
 * Get the buffer size
 */
async function getBufferSize(oracle) {
  return oracle.getBufferSize();
}

/**
 * Get the median buffer size
 */
async function getMedianBufferSize(oracle) {
  return oracle.getMedianBufferSize();
}

/**
 * Get initialization block headers (first 17 blocks from production data)
 */
function getInitializationBlocks() {
  return loadProductionBlocks().init;
}

/**
 * Get testing block headers (remaining blocks after initialization)
 */
function getTestingBlocks() {
  return loadProductionBlocks().test;
}

/**
 * Get the initial block height from production data
 */
function getInitialBlockHeight() {
  return loadProductionBlocks().initialHeight;
}

/**
 * Convert a block header object to the format expected by the contract
 */
function normalizeBlockHeader(header) {
  return {
    version: header.version,
    prevBlockHash: header.prevBlockHash,
    merkleRootHash: header.merkleRootHash,
    timestamp: header.timestamp,
    nBits: header.nBits,
    nonce: header.nonce,
    blockHash: header.blockHash,
    blockNumber: header.blockNumber,
  };
}

/**
 * Verify a block header structure
 */
function validateBlockHeader(header) {
  const required = [
    "version",
    "prevBlockHash",
    "merkleRootHash",
    "timestamp",
    "nBits",
    "nonce",
    "blockHash",
    "blockNumber",
  ];

  for (const field of required) {
    if (header[field] === undefined) {
      throw new Error(`Missing field: ${field}`);
    }
  }

  return true;
}

/**
 * Helper to compare two block headers for equality
 */
function compareBlockHeaders(header1, header2) {
  return (
    header1.version === header2.version &&
    header1.prevBlockHash === header2.prevBlockHash &&
    header1.merkleRootHash === header2.merkleRootHash &&
    header1.timestamp === header2.timestamp &&
    header1.nBits === header2.nBits &&
    header1.nonce === header2.nonce &&
    header1.blockHash === header2.blockHash &&
    header1.blockNumber === header2.blockNumber
  );
}

/**
 * Get information about block data for dynamic test setup
 * Allows tests to adjust their assertions based on available blocks
 */
function getBlockDataInfo() {
  const data = loadProductionBlocks();
  return {
    totalBlocks: data.totalCount,
    initBlocks: data.init.length,
    testBlocks: data.test.length,
    initialBlockHeight: data.initialHeight,
    highestBlockHeight: data.all[data.all.length - 1]?.blockNumber || 0,
    lowestBlockHeight: data.initialHeight,
  };
}

/**
 * Get a block by relative index from the current position
 * Useful for tests to get blocks relative to initialization without hardcoding block numbers
 */
function getBlockByRelativeIndex(relativeIndex) {
  const data = loadProductionBlocks();
  const actualIndex = relativeIndex;

  if (actualIndex < 0 || actualIndex >= data.all.length) {
    throw new Error(
      `Block index ${actualIndex} out of range (0-${data.all.length - 1})`
    );
  }

  return data.all[actualIndex];
}

/**
 * Get blocks from index range
 * Useful for batch operations in tests
 */
function getBlocksByRange(startIndex, endIndex) {
  const data = loadProductionBlocks();
  return data.all.slice(startIndex, endIndex);
}

/**
 * Get number of available blocks for testing (after initialization)
 */
function getAvailableTestBlocks() {
  return loadProductionBlocks().test;
}

/**
 * Get the block height for a test block at given offset
 * offset 0 = first test block, 1 = second test block, etc.
 */
function getTestBlockHeight(offset) {
  const testBlocks = getAvailableTestBlocks();
  if (offset < 0 || offset >= testBlocks.length) {
    throw new Error(
      `Test block offset ${offset} out of range (0-${testBlocks.length - 1})`
    );
  }
  return testBlocks[offset].blockNumber;
}

/**
 * Get the timestamp for a test block at given offset
 */
function getTestBlockTimestamp(offset) {
  const testBlocks = getAvailableTestBlocks();
  if (offset < 0 || offset >= testBlocks.length) {
    throw new Error(
      `Test block offset ${offset} out of range (0-${testBlocks.length - 1})`
    );
  }
  return testBlocks[offset].timestamp;
}

module.exports = {
  // Submission functions
  submitBlockHeader,
  submitBatchBlocks,

  // Getter functions
  getCurrentBlockHeight,
  getNextBlockIndex,
  getBlockHeaderAt,
  getBlockHeaderByNumber,
  getLatestBlockHeader,
  getAllBlockHeaders,
  getMedianBlockTime,
  getBufferSize,
  getMedianBufferSize,

  // Data helpers
  getInitializationBlocks,
  getTestingBlocks,
  getInitialBlockHeight,

  // Block data utilities
  getBlockDataInfo,
  getBlockByRelativeIndex,
  getBlocksByRange,
  getAvailableTestBlocks,
  getTestBlockHeight,
  getTestBlockTimestamp,

  // Utility functions
  normalizeBlockHeader,
  validateBlockHeader,
  compareBlockHeaders,
};
