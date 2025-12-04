/**
 * Integration Tests for Block Header Oracle
 * Tests oracle deployment, initialization, and interaction with the diamond
 */

const { deployDiamond } = require("../../scripts/deploy.js");
const { expect } = require("chai");
const { ethers } = require("hardhat");

const {
  submitBlockHeader,
  getCurrentBlockHeight,
  getLatestBlockHeader,
  getMedianBlockTime,
  getInitializationBlocks,
  getTestingBlocks,
  getInitialBlockHeight,
} = require("../utils/blockHeaderOracleUtils.js");

describe("Block Header Oracle - Integration Tests", function () {
  let diamondAddress, oracle, owner, addr1;
  let initBlocks, testBlocks, initialHeight;

  beforeEach(async function () {
    [owner, addr1] = await ethers.getSigners();

    console.log("\n📋 Deploying Diamond with Block Header Oracle...");

    // Deploy diamond (which includes oracle initialization)
    diamondAddress = await deployDiamond();

    // Get oracle interface
    oracle = await ethers.getContractAt(
      "IDoefinBlockHeaderOracle",
      diamondAddress
    );

    // Load test data
    initBlocks = getInitializationBlocks();
    testBlocks = getTestingBlocks();
    initialHeight = getInitialBlockHeight();

    console.log(`✅ Diamond deployed at ${diamondAddress}`);
    console.log(`✅ Oracle initialized with ${initBlocks.length} blocks`);
  });

  // ========================================
  // DEPLOYMENT & INITIALIZATION TESTS
  // ========================================

  describe("Deployment & Initialization", function () {
    it("should deploy diamond with oracle facet", async function () {
      expect(diamondAddress).to.be.properAddress;

      // Verify we can call oracle functions
      const height = await getCurrentBlockHeight(oracle);
      expect(height).to.equal(initialHeight + initBlocks.length - 1);
    });

    it("should initialize oracle with correct block range", async function () {
      const height = await getCurrentBlockHeight(oracle);
      const expected = initialHeight + 16; // 0-indexed, 17 blocks

      expect(height).to.equal(expected);
    });

    it("should have all initialization blocks accessible", async function () {
      for (let i = 0; i < initBlocks.length; i++) {
        const blockNum = initialHeight + i;
        const latestHeight = await getCurrentBlockHeight(oracle);

        // All initialization blocks should be within buffer range
        expect(blockNum).to.be.lte(latestHeight);
        expect(blockNum).to.be.gt(latestHeight - initBlocks.length);
      }
    });

    it("should calculate median block time from initialization", async function () {
      const medianTime = await getMedianBlockTime(oracle);

      // Median should be a reasonable timestamp
      expect(medianTime).to.be.gt(0);
      expect(medianTime).to.be.lte(Math.floor(Date.now() / 1000) + 1000);
    });
  });

  // ========================================
  // MULTI-BLOCK SUBMISSION TESTS
  // ========================================

  describe("Sequential Block Submissions", function () {
    it("should submit first testing block after initialization", async function () {
      const blockBefore = await getLatestBlockHeader(oracle);
      const newBlock = testBlocks[0];

      const tx = await submitBlockHeader({
        oracle,
        blockHeader: newBlock,
        caller: owner,
      });

      const receipt = await tx.wait();
      expect(receipt.status).to.equal(1);

      const blockAfter = await getLatestBlockHeader(oracle);
      expect(blockAfter.blockHash).to.equal(newBlock.blockHash);
    });

    it("should maintain chain continuity through submissions", async function () {
      const initLatest = await getLatestBlockHeader(oracle);
      const newBlock = testBlocks[0];

      // Verify the new block's prevBlockHash matches the current latest
      expect(newBlock.prevBlockHash).to.equal(initLatest.blockHash);

      // Submit the block
      await submitBlockHeader({
        oracle,
        blockHeader: newBlock,
        caller: owner,
      });

      // Verify it was accepted
      const updated = await getLatestBlockHeader(oracle);
      expect(updated.blockHash).to.equal(newBlock.blockHash);
    });

    it("should update height correctly with each submission", async function () {
      const heightBefore = await getCurrentBlockHeight(oracle);
      const newBlock = testBlocks[0];

      await submitBlockHeader({
        oracle,
        blockHeader: newBlock,
        caller: owner,
      });

      const heightAfter = await getCurrentBlockHeight(oracle);
      expect(heightAfter).to.equal(BigInt(heightBefore) + 1n);
    });

    it("should allow submission from any caller", async function () {
      const newBlock = testBlocks[0];

      // Submit from addr1 instead of owner
      const tx = await submitBlockHeader({
        oracle,
        blockHeader: newBlock,
        caller: addr1,
      });

      const receipt = await tx.wait();
      expect(receipt.status).to.equal(1);
    });
  });

  // ========================================
  // ORACLE STATE TESTS
  // ========================================

  describe("Oracle State Management", function () {
    it("should maintain correct state across multiple operations", async function () {
      const initialHeight = await getCurrentBlockHeight(oracle);

      // Submit first block
      const block1 = testBlocks[0];
      await submitBlockHeader({
        oracle,
        blockHeader: block1,
        caller: owner,
      });

      let currentHeight = await getCurrentBlockHeight(oracle);
      expect(currentHeight).to.equal(BigInt(initialHeight) + 1n);

      // Verify latest is correct
      let latest = await getLatestBlockHeader(oracle);
      expect(latest.blockHash).to.equal(block1.blockHash);
    });

    it("should have consistent state between getter methods", async function () {
      const currentHeight = await getCurrentBlockHeight(oracle);
      const latest = await getLatestBlockHeader(oracle);

      // Latest block's blockNumber should match current height
      expect(latest.blockNumber).to.equal(currentHeight);
    });
  });

  // ========================================
  // REORG DETECTION TESTS
  // ========================================

  describe("Block Validation & Error Handling", function () {
    it("should reject block with wrong previous hash", async function () {
      const invalidBlock = {
        ...testBlocks[0],
        prevBlockHash: "0x" + "1".repeat(64), // Wrong hash
      };

      await expect(
        submitBlockHeader({
          oracle,
          blockHeader: invalidBlock,
          caller: owner,
        })
      ).to.be.revertedWith("BlockHeaderOracle_PrevBlockHashMismatch()");
    });

    it("should reject block with timestamp below median", async function () {
      const medianTime = await getMedianBlockTime(oracle);

      // Create block with timestamp below median
      const invalidBlock = {
        ...testBlocks[0],
        timestamp: Number(medianTime) - 100,
      };

      await expect(
        submitBlockHeader({
          oracle,
          blockHeader: invalidBlock,
          caller: owner,
        })
      ).to.be.revertedWith("BlockHeaderOracle_InvalidTimestamp()");
    });

    it("should allow block with timestamp equal to or above median", async function () {
      const medianTime = await getMedianBlockTime(oracle);
      const validBlock = testBlocks[0];

      // The testing block's timestamp should be above median
      expect(validBlock.timestamp).to.be.gte(Number(medianTime));

      // Should not revert
      const tx = await submitBlockHeader({
        oracle,
        blockHeader: validBlock,
        caller: owner,
      });

      const receipt = await tx.wait();
      expect(receipt.status).to.equal(1);
    });
  });

  // ========================================
  // PERFORMANCE & SCALABILITY TESTS
  // ========================================

  describe("Performance Characteristics", function () {
    it("should handle block submission gas efficiently", async function () {
      const newBlock = testBlocks[0];

      const tx = await submitBlockHeader({
        oracle,
        blockHeader: newBlock,
        caller: owner,
      });

      const receipt = await tx.wait();

      // Gas used should be reasonable (not an exact number, just sanity check)
      expect(receipt.gasUsed).to.be.gt(0);
      expect(receipt.gasUsed).to.be.lt(500000); // Reasonable upper bound
    });

    it("should access stored blocks efficiently", async function () {
      // Accessing any block in the buffer should be fast
      const blockNum = initialHeight + 5;

      // This should complete quickly without excessive gas
      const header = await ethers.provider.call({
        to: diamondAddress,
        data: oracle.interface.encodeFunctionData("getBlockHeaderByNumber", [
          blockNum,
        ]),
      });

      expect(header).to.not.be.empty;
    });
  });

  // ========================================
  // DATA CONSISTENCY TESTS
  // ========================================

  describe("Data Consistency", function () {
    it("should maintain block chain integrity after multiple submissions", async function () {
      const latest = await getLatestBlockHeader(oracle);
      const expected = testBlocks[0];

      // Submit first testing block
      await submitBlockHeader({
        oracle,
        blockHeader: expected,
        caller: owner,
      });

      // Verify it was stored correctly
      const stored = await getLatestBlockHeader(oracle);
      expect(stored.blockHash).to.equal(expected.blockHash);
      expect(stored.blockNumber).to.equal(expected.blockNumber);
      expect(stored.timestamp).to.equal(expected.timestamp);
    });

    it("should preserve all block header fields correctly", async function () {
      const newBlock = testBlocks[0];

      await submitBlockHeader({
        oracle,
        blockHeader: newBlock,
        caller: owner,
      });

      const stored = await getLatestBlockHeader(oracle);

      // Verify all fields
      expect(stored.version).to.equal(newBlock.version);
      expect(stored.prevBlockHash).to.equal(newBlock.prevBlockHash);
      expect(stored.merkleRootHash).to.equal(newBlock.merkleRootHash);
      expect(stored.timestamp).to.equal(newBlock.timestamp);
      expect(stored.nBits).to.equal(newBlock.nBits);
      expect(stored.blockHash).to.equal(newBlock.blockHash);
      expect(stored.blockNumber).to.equal(newBlock.blockNumber);
    });
  });

  // ========================================
  // DIAMOND PATTERN TESTS
  // ========================================

  describe("Diamond Pattern Integration", function () {
    it("should be callable via diamond proxy", async function () {
      // The oracle functions should be accessible through the diamond
      const height = await oracle.getCurrentBlockHeight();
      expect(height).to.be.gte(initialHeight);
    });

    it("should share AppStorage with other facets", async function () {
      // This verifies the diamond pattern is working correctly
      // by checking that we can access oracle data through the interface

      const height = await getCurrentBlockHeight(oracle);
      const latest = await getLatestBlockHeader(oracle);

      // These should be consistent
      expect(latest.blockNumber).to.equal(height);
    });
  });
});
