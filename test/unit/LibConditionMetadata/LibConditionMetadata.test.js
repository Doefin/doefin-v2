/**
 * Unit Tests for LibConditionMetadata
 * Tests encoding, decoding, and validation of question metadata
 */

const { deployDiamond } = require("../../../scripts/deploy.js");
const { expect } = require("chai");
const { ethers } = require("hardhat");

const {
  QuestionType,
  encodeDifficultyThreshold,
  encodeDifficultyRange,
  encodeBlockCount,
  encodeMiningDuration,
} = require("../../utils/oracleAdapterUtils.js");

describe("LibConditionMetadata", function () {
  let diamondAddress, conditionManager, owner;
  let libConditionMetadata;

  beforeEach(async function () {
    [owner] = await ethers.getSigners();
    diamondAddress = await deployDiamond();
    conditionManager = await ethers.getContractAt(
      "IConditionManager",
      diamondAddress
    );

    // Get LibConditionMetadata from a facet or get it directly
    const artifact = await ethers.getContractFactory("LibConditionMetadata");
    libConditionMetadata = artifact;
  });

  // ========================================
  // DIFFICULTY THRESHOLD TESTS
  // ========================================

  describe("DifficultyThreshold Encoding/Decoding", function () {
    it("should encode and decode threshold correctly", async function () {
      const threshold = ethers.parseUnits("50", "gwei"); // 50G difficulty
      const targetBlockHeight = 100;

      const encoded = encodeDifficultyThreshold(threshold, targetBlockHeight);
      const abiCoder = ethers.AbiCoder.defaultAbiCoder();
      const [decodedThreshold, decodedHeight] = abiCoder.decode(
        ["uint256", "uint256"],
        encoded
      );

      expect(decodedThreshold).to.equal(threshold);
      expect(decodedHeight).to.equal(targetBlockHeight);
    });

    it("should handle zero threshold", async function () {
      const threshold = 0n;
      const targetBlockHeight = 100;

      const encoded = encodeDifficultyThreshold(threshold, targetBlockHeight);
      const abiCoder = ethers.AbiCoder.defaultAbiCoder();
      const [decodedThreshold] = abiCoder.decode(
        ["uint256", "uint256"],
        encoded
      );

      expect(decodedThreshold).to.equal(0n);
    });

    it("should handle very large threshold", async function () {
      const threshold = ethers.MaxUint256;
      const targetBlockHeight = 100;

      const encoded = encodeDifficultyThreshold(threshold, targetBlockHeight);
      const abiCoder = ethers.AbiCoder.defaultAbiCoder();
      const [decodedThreshold] = abiCoder.decode(
        ["uint256", "uint256"],
        encoded
      );

      expect(decodedThreshold).to.equal(threshold);
    });
  });

  // ========================================
  // DIFFICULTY RANGE TESTS
  // ========================================

  describe("DifficultyRange Encoding/Decoding", function () {
    it("should encode and decode range buckets correctly", async function () {
      const targetBlockHeight = 100;
      const buckets = [
        ethers.parseUnits("40", "gwei"),
        ethers.parseUnits("50", "gwei"),
        ethers.parseUnits("60", "gwei"),
      ];

      const encoded = encodeDifficultyRange(targetBlockHeight, buckets);
      const abiCoder = ethers.AbiCoder.defaultAbiCoder();
      const [decodedHeight, decodedBuckets] = abiCoder.decode(
        ["uint256", "uint256[]"],
        encoded
      );

      expect(decodedHeight).to.equal(targetBlockHeight);
      expect(decodedBuckets.length).to.equal(buckets.length);
      for (let i = 0; i < buckets.length; i++) {
        expect(decodedBuckets[i]).to.equal(buckets[i]);
      }
    });

    it("should handle single bucket", async function () {
      const targetBlockHeight = 100;
      const buckets = [ethers.parseUnits("50", "gwei")];

      const encoded = encodeDifficultyRange(targetBlockHeight, buckets);
      const abiCoder = ethers.AbiCoder.defaultAbiCoder();
      const [, decodedBuckets] = abiCoder.decode(
        ["uint256", "uint256[]"],
        encoded
      );

      expect(decodedBuckets.length).to.equal(1);
      expect(decodedBuckets[0]).to.equal(buckets[0]);
    });

    it("should handle maximum buckets (10)", async function () {
      const targetBlockHeight = 100;
      const buckets = [];
      for (let i = 1; i <= 10; i++) {
        buckets.push(ethers.parseUnits((40 + i * 2).toString(), "gwei"));
      }

      const encoded = encodeDifficultyRange(targetBlockHeight, buckets);
      const abiCoder = ethers.AbiCoder.defaultAbiCoder();
      const [, decodedBuckets] = abiCoder.decode(
        ["uint256", "uint256[]"],
        encoded
      );

      expect(decodedBuckets.length).to.equal(10);
    });
  });

  // ========================================
  // BLOCK COUNT TESTS
  // ========================================

  describe("BlockCount Encoding/Decoding", function () {
    it("should encode and decode block count correctly", async function () {
      const startTimestamp = 1000000;
      const endTimestamp = 1010000;
      const countBuckets = [100, 150, 200];

      const encoded = encodeBlockCount(
        startTimestamp,
        endTimestamp,
        countBuckets
      );
      const abiCoder = ethers.AbiCoder.defaultAbiCoder();
      const [decodedStart, decodedEnd, decodedBuckets] = abiCoder.decode(
        ["uint256", "uint256", "uint256[]"],
        encoded
      );

      expect(decodedStart).to.equal(startTimestamp);
      expect(decodedEnd).to.equal(endTimestamp);
      expect(decodedBuckets.length).to.equal(3);
    });

    it("should handle same start and end timestamp", async function () {
      const timestamp = 1000000;
      const countBuckets = [50];

      const encoded = encodeBlockCount(timestamp, timestamp, countBuckets);
      const abiCoder = ethers.AbiCoder.defaultAbiCoder();
      const [decodedStart, decodedEnd] = abiCoder.decode(
        ["uint256", "uint256", "uint256[]"],
        encoded
      );

      expect(decodedStart).to.equal(decodedEnd);
    });
  });

  // ========================================
  // MINING DURATION TESTS
  // ========================================

  describe("MiningDuration Encoding/Decoding", function () {
    it("should encode and decode mining duration correctly", async function () {
      const startBlockHeight = 100;
      const blockCount = 144; // ~1 day
      const durationBuckets = [3600, 7200, 10800]; // 1, 2, 3 hours

      const encoded = encodeMiningDuration(
        startBlockHeight,
        blockCount,
        durationBuckets
      );
      const abiCoder = ethers.AbiCoder.defaultAbiCoder();
      const [decodedStart, decodedCount, decodedBuckets] = abiCoder.decode(
        ["uint256", "uint256", "uint256[]"],
        encoded
      );

      expect(decodedStart).to.equal(startBlockHeight);
      expect(decodedCount).to.equal(blockCount);
      expect(decodedBuckets.length).to.equal(3);
    });

    it("should handle single block duration", async function () {
      const startBlockHeight = 100;
      const blockCount = 1;
      const durationBuckets = [600]; // 10 minutes

      const encoded = encodeMiningDuration(
        startBlockHeight,
        blockCount,
        durationBuckets
      );
      const abiCoder = ethers.AbiCoder.defaultAbiCoder();
      const [, decodedCount] = abiCoder.decode(
        ["uint256", "uint256", "uint256[]"],
        encoded
      );

      expect(decodedCount).to.equal(1);
    });

    it("should handle maximum block count (2016)", async function () {
      const startBlockHeight = 100;
      const blockCount = 2016; // Max difficulty adjustment period
      const durationBuckets = [
        86400 * 7,
        86400 * 8,
        86400 * 9,
      ]; // 1-3 weeks

      const encoded = encodeMiningDuration(
        startBlockHeight,
        blockCount,
        durationBuckets
      );
      const abiCoder = ethers.AbiCoder.defaultAbiCoder();
      const [, decodedCount] = abiCoder.decode(
        ["uint256", "uint256", "uint256[]"],
        encoded
      );

      expect(decodedCount).to.equal(2016);
    });
  });

  // ========================================
  // QUESTION ID GENERATION TESTS
  // ========================================

  describe("Question ID Generation", function () {
    it("should generate deterministic question IDs", async function () {
      const threshold = ethers.parseUnits("50", "gwei");
      const targetBlockHeight = 100;
      const metadata = encodeDifficultyThreshold(threshold, targetBlockHeight);
      const salt = ethers.constants.HashZero;

      // Get transaction data for question ID generation
      const calldata = conditionManager.interface.encodeFunctionData(
        "createConditionWithMetadata",
        [QuestionType.DifficultyThreshold, metadata, 2, "test://", salt]
      );

      // Same inputs should produce same output
      const encoded1 = encodeDifficultyThreshold(threshold, targetBlockHeight);
      const encoded2 = encodeDifficultyThreshold(threshold, targetBlockHeight);

      expect(encoded1).to.equal(encoded2);
    });

    it("should generate different IDs for different thresholds", async function () {
      const threshold1 = ethers.parseUnits("50", "gwei");
      const threshold2 = ethers.parseUnits("60", "gwei");
      const targetBlockHeight = 100;

      const encoded1 = encodeDifficultyThreshold(
        threshold1,
        targetBlockHeight
      );
      const encoded2 = encodeDifficultyThreshold(
        threshold2,
        targetBlockHeight
      );

      expect(encoded1).to.not.equal(encoded2);
    });

    it("should generate different IDs for different block heights", async function () {
      const threshold = ethers.parseUnits("50", "gwei");
      const height1 = 100;
      const height2 = 200;

      const encoded1 = encodeDifficultyThreshold(threshold, height1);
      const encoded2 = encodeDifficultyThreshold(threshold, height2);

      expect(encoded1).to.not.equal(encoded2);
    });
  });

  // ========================================
  // EDGE CASES AND BOUNDARY CONDITIONS
  // ========================================

  describe("Edge Cases", function () {
    it("should handle empty bucket arrays gracefully", async function () {
      const targetBlockHeight = 100;
      const buckets = [];

      // Empty buckets should encode without error
      const encoded = encodeDifficultyRange(targetBlockHeight, buckets);
      expect(encoded).to.not.be.null;
    });

    it("should handle very large timestamp values", async function () {
      const startTimestamp = ethers.MaxUint256 - 1000000n;
      const endTimestamp = ethers.MaxUint256;
      const countBuckets = [100];

      const encoded = encodeBlockCount(
        startTimestamp,
        endTimestamp,
        countBuckets
      );
      const abiCoder = ethers.AbiCoder.defaultAbiCoder();
      const [decodedStart, decodedEnd] = abiCoder.decode(
        ["uint256", "uint256", "uint256[]"],
        encoded
      );

      expect(decodedStart).to.equal(startTimestamp);
      expect(decodedEnd).to.equal(endTimestamp);
    });

    it("should handle very large block heights", async function () {
      const blockHeight = 1000000000; // Extremely far future
      const blockCount = 100;
      const durationBuckets = [3600];

      const encoded = encodeMiningDuration(
        blockHeight,
        blockCount,
        durationBuckets
      );
      expect(encoded).to.not.be.null;
    });
  });
});
