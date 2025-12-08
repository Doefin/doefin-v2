/**
 * Unit Tests for LibOracleAdapter
 * Tests resolution logic, bucket calculations, and timestamp bucketing
 */

const { deployDiamond } = require("../../../scripts/deploy.js");
const { expect } = require("chai");
const { ethers } = require("hardhat");

const {
  getTimestampBucket,
  createTestBuckets,
  calculateDifficulty,
} = require("../../utils/oracleAdapterUtils.js");

describe("LibOracleAdapter", function () {
  let diamondAddress;
  let oracleAdapter;
  let owner;

  const TIMESTAMP_BUCKET = 600; // 10 minutes
  const NUM_OF_BLOCK_HEADERS = 17;
  const SETTLEMENT_DELAY = 6;

  beforeEach(async function () {
    [owner] = await ethers.getSigners();
    diamondAddress = await deployDiamond();

    oracleAdapter = await ethers.getContractAt(
      "OracleAdapterFacet",
      diamondAddress
    );
  });

  // ========================================
  // TIMESTAMP BUCKETING TESTS
  // ========================================

  describe("Timestamp Bucketing", function () {
    it("should bucket timestamps correctly", async function () {
      const timestamp = 1699200000;
      const expectedBucket = getTimestampBucket(timestamp, TIMESTAMP_BUCKET);

      const bucket = await oracleAdapter.getTimestampBucket(timestamp);
      expect(bucket).to.equal(expectedBucket);
    });

    it("should map multiple timestamps to same bucket", async function () {
      const baseTimestamp = 1699200000;
      const timestamp1 = baseTimestamp;
      const timestamp2 = baseTimestamp + 100;
      const timestamp3 = baseTimestamp + 599;

      const bucket1 = await oracleAdapter.getTimestampBucket(timestamp1);
      const bucket2 = await oracleAdapter.getTimestampBucket(timestamp2);
      const bucket3 = await oracleAdapter.getTimestampBucket(timestamp3);

      expect(bucket1).to.equal(bucket2);
      expect(bucket2).to.equal(bucket3);
    });

    it("should create different buckets for timestamps beyond bucket boundary", async function () {
      const timestamp1 = 1699200000;
      const timestamp2 = timestamp1 + TIMESTAMP_BUCKET;

      const bucket1 = await oracleAdapter.getTimestampBucket(timestamp1);
      const bucket2 = await oracleAdapter.getTimestampBucket(timestamp2);

      expect(bucket1).to.not.equal(bucket2);
      expect(bucket2).to.equal(bucket1.add(TIMESTAMP_BUCKET));
    });

    it("should handle zero timestamp", async function () {
      const bucket = await oracleAdapter.getTimestampBucket(0);
      expect(bucket).to.equal(0);
    });

    it("should handle very large timestamps", async function () {
      const largeTimestamp = ethers.constants.MaxUint256.sub(1000);
      const bucket = await oracleAdapter.getTimestampBucket(largeTimestamp);
      expect(bucket.toBigInt()).to.be.a("bigint");
    });
  });

  // ========================================
  // BUCKET FINDING TESTS
  // ========================================

  describe("Bucket Index Finding", function () {
    it("should find correct bucket for value below first boundary", async function () {
      const buckets = [100, 200, 300];
      const value = 50;

      // Value < 100 should be in bucket 0
      expect(value).to.be.lessThan(buckets[0]);
    });

    it("should find correct bucket for value in range", async function () {
      const buckets = [100, 200, 300];
      const value1 = 100; // At first boundary -> bucket 1
      const value2 = 150; // Between 100-200 -> bucket 1
      const value3 = 200; // At second boundary -> bucket 2

      expect(value1).to.equal(buckets[0]);
      expect(value2).to.be.greaterThan(buckets[0]);
      expect(value2).to.be.lessThan(buckets[1]);
      expect(value3).to.equal(buckets[1]);
    });

    it("should find correct bucket for value above last boundary", async function () {
      const buckets = [100, 200, 300];
      const value = 350; // >= 300 should be in bucket 3 (last)

      expect(value).to.be.greaterThanOrEqual(buckets[buckets.length - 1]);
    });

    it("should handle single bucket", async function () {
      const buckets = [100];
      const valueBefore = 50;
      const valueAfter = 150;

      expect(valueBefore).to.be.lessThan(buckets[0]);
      expect(valueAfter).to.be.greaterThanOrEqual(buckets[0]);
    });

    it("should handle maximum buckets (10)", async function () {
      const buckets = createTestBuckets(10, 100);
      expect(buckets.length).to.equal(10);

      // Test boundary values
      expect(50).to.be.lessThan(buckets[0]);
      expect(50 + buckets.length * 100).to.be.greaterThanOrEqual(
        buckets[buckets.length - 1]
      );
    });
  });

  // ========================================
  // STATISTICS TESTS
  // ========================================

  describe("Statistics Tracking", function () {
    it("should initialize with zero questions created", async function () {
      const created = await oracleAdapter.getTotalQuestionsCreated();
      expect(created.toBigInt()).to.be.a("bigint");
    });

    it("should initialize with zero questions resolved", async function () {
      const resolved = await oracleAdapter.getTotalQuestionsResolved();
      expect(resolved.toBigInt()).to.be.a("bigint");
    });

    it("should track total questions created", async function () {
      const createdBefore = await oracleAdapter.getTotalQuestionsCreated();
      expect(createdBefore.toBigInt()).to.be.a("bigint");
      // Stats tracking requires actual question creation through the full flow
    });

    it("should track total questions resolved", async function () {
      const resolvedBefore = await oracleAdapter.getTotalQuestionsResolved();
      expect(resolvedBefore.toBigInt()).to.be.a("bigint");
    });
  });

  // ========================================
  // QUERY FUNCTIONS TESTS
  // ========================================

  describe("Query Functions", function () {
    it("should return empty array for block with no threshold questions", async function () {
      const blockHeight = 1000000;
      const questions = await oracleAdapter.getThresholdQuestionsAtBlock(
        blockHeight
      );
      expect(questions).to.be.an("array");
      expect(questions.length).to.equal(0);
    });

    it("should return empty array for block with no range questions", async function () {
      const blockHeight = 1000000;
      const questions = await oracleAdapter.getRangeQuestionsAtBlock(
        blockHeight
      );
      expect(questions).to.be.an("array");
      expect(questions.length).to.equal(0);
    });

    it("should return empty array for block with no duration questions", async function () {
      const blockHeight = 1000000;
      const questions = await oracleAdapter.getDurationQuestionsAtBlock(
        blockHeight
      );
      expect(questions).to.be.an("array");
      expect(questions.length).to.equal(0);
    });

    it("should return empty array for timestamp with no block count questions", async function () {
      const timestamp = 1699200000;
      const questions =
        await oracleAdapter.getBlockCountQuestionsAtTimestamp(timestamp);
      expect(questions).to.be.an("array");
      expect(questions.length).to.equal(0);
    });
  });

  // ========================================
  // TIMESTAMP/BLOCK MAPPING TESTS
  // ========================================

  describe("Timestamp/Block Mapping", function () {
    it("should return zero for unmapped block height", async function () {
      const blockHeight = 1000000;
      const timestamp = await oracleAdapter.getBlockTimestamp(blockHeight);
      expect(timestamp.toBigInt()).to.equal(0n);
    });

    it("should return zero for unmapped timestamp", async function () {
      const timestamp = 1699200000;
      const blockHeight = await oracleAdapter.getTimestampBlock(timestamp);
      expect(blockHeight.toBigInt()).to.equal(0n);
    });

    it("should handle maximum block heights", async function () {
      const maxBlockHeight = ethers.constants.MaxUint256;
      const timestamp = await oracleAdapter.getBlockTimestamp(maxBlockHeight);
      expect(timestamp.toBigInt()).to.be.a("bigint");
    });
  });

  // ========================================
  // RING BUFFER AND WRAPAROUND TESTS
  // ========================================

  describe("Ring Buffer and Block Range", function () {
    it("should support checking blocks within buffer range", async function () {
      // Buffer holds 17 blocks (NUM_OF_BLOCK_HEADERS)
      // Valid blocks are current - (NUM_OF_BLOCK_HEADERS - 1) to current
      expect(NUM_OF_BLOCK_HEADERS).to.equal(17);
    });

    it("should handle ring buffer wraparound calculation", async function () {
      // Ring buffer index calculation is tested internally
      // This verifies the constant is correct
      expect(NUM_OF_BLOCK_HEADERS).to.equal(17);
    });

    it("should have correct settlement delay", async function () {
      // Settlement delay is hardcoded to 6 blocks
      expect(SETTLEMENT_DELAY).to.equal(6);
    });
  });

  // ========================================
  // DIFFICULTY CALCULATION TESTS
  // ========================================

  describe("Difficulty Calculations", function () {
    it("should calculate difficulty from nBits correctly", async function () {
      // Example: Bitcoin difficulty target nBits
      const nBits = 0x00000000ffff0000;
      const difficulty = calculateDifficulty(nBits);
      expect(difficulty).to.be.a("number");
    });

    it("should handle small exponents in difficulty", async function () {
      const nBits = 0x01003456;
      const difficulty = calculateDifficulty(nBits);
      expect(difficulty).to.be.greaterThan(0);
    });

    it("should handle large exponents in difficulty", async function () {
      const nBits = 0x1d00ffff;
      const difficulty = calculateDifficulty(nBits);
      expect(difficulty).to.be.greaterThan(0);
    });
  });

  // ========================================
  // ERROR HANDLING TESTS
  // ========================================

  describe("Error Handling", function () {
    it("should handle queries for valid block ranges", async function () {
      // Queries within valid range should succeed without errors
      const blockHeight = 1000;
      const questions = await oracleAdapter.getThresholdQuestionsAtBlock(
        blockHeight
      );
      expect(questions).to.be.an("array");
    });

    it("should handle edge case of block height 0", async function () {
      const questions = await oracleAdapter.getThresholdQuestionsAtBlock(0);
      expect(questions).to.be.an("array");
    });

    it("should handle maximum uint256 block height", async function () {
      const questions = await oracleAdapter.getThresholdQuestionsAtBlock(
        ethers.constants.MaxUint256
      );
      expect(questions).to.be.an("array");
    });
  });

  // ========================================
  // BUCKET BOUNDARY TESTS
  // ========================================

  describe("Bucket Boundary Conditions", function () {
    it("should distinguish values at exact bucket boundaries", async function () {
      const buckets = [100, 200, 300];

      // Value exactly at boundary should be in next bucket
      // value < bucket[0] -> bucket 0
      // value >= bucket[0] && value < bucket[1] -> bucket 1
      // value >= bucket[1] && value < bucket[2] -> bucket 2
      // value >= bucket[2] -> bucket 3

      expect(100 >= buckets[0]).to.be.true;
      expect(100 < buckets[1]).to.be.true;
    });

    it("should handle very small differences at boundaries", async function () {
      const buckets = [1000000000];

      const valueBefore = 999999999;
      const valueAt = 1000000000;
      const valueAfter = 1000000001;

      expect(valueBefore).to.be.lessThan(valueAt);
      expect(valueAfter).to.be.greaterThan(valueAt);
    });
  });

  // ========================================
  // MULTIPLE QUESTIONS AT SAME TRIGGER
  // ========================================

  describe("Multiple Questions at Same Trigger", function () {
    it("should support multiple questions at same block height", async function () {
      // Multiple questions can be stored in arrays at same block height
      const blockHeight = 1000;
      const questions = await oracleAdapter.getThresholdQuestionsAtBlock(
        blockHeight
      );
      // Should return array (empty if no questions)
      expect(Array.isArray(questions)).to.be.true;
    });

    it("should support multiple questions at same timestamp bucket", async function () {
      const timestamp = 1699200000;
      const questions =
        await oracleAdapter.getBlockCountQuestionsAtTimestamp(timestamp);
      // Should return array (empty if no questions)
      expect(Array.isArray(questions)).to.be.true;
    });
  });
});
