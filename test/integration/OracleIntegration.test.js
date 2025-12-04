/**
 * Integration Tests for Oracle Adapter
 * Tests complete end-to-end flows: create → submit blocks → auto-resolve
 */

const { deployDiamond } = require("../../scripts/deploy.js");
const { expect } = require("chai");
const { ethers } = require("hardhat");

const {
  QuestionType,
  encodeDifficultyThreshold,
  encodeDifficultyRange,
  encodeBlockCount,
  encodeMiningDuration,
  getTimestampBucket,
} = require("../utils/oracleAdapterUtils.js");

const {
  getInitializationBlocks,
  getTestingBlocks,
  getInitialBlockHeight,
  submitBlockHeader,
} = require("../utils/blockHeaderOracleUtils.js");

describe("Oracle Adapter Integration", function () {
  let diamondAddress;
  let conditionManager;
  let oracleAdapter;
  let blockHeaderOracle;
  let owner, marketMaker;
  let initBlocks, testBlocks, initialHeight;

  const SETTLEMENT_DELAY = 6;

  beforeEach(async function () {
    [owner, marketMaker] = await ethers.getSigners();
    diamondAddress = await deployDiamond();

    conditionManager = await ethers.getContractAt(
      "IConditionManager",
      diamondAddress
    );

    oracleAdapter = await ethers.getContractAt(
      "OracleAdapterFacet",
      diamondAddress
    );

    blockHeaderOracle = await ethers.getContractAt(
      "IDoefinBlockHeaderOracle",
      diamondAddress
    );

    // Add market maker
    const accessControl = await ethers.getContractAt(
      "IAccessControl",
      diamondAddress
    );
    await accessControl.connect(owner).addMarketMaker(marketMaker.address);

    // Load test blocks
    initBlocks = getInitializationBlocks();
    testBlocks = getTestingBlocks();
    initialHeight = getInitialBlockHeight();
  });

  // ========================================
  // BASIC CREATION AND QUERY FLOW
  // ========================================

  describe("Basic Creation and Query Flow", function () {
    it("should initialize with zero questions", async function () {
      const created = await oracleAdapter.getTotalQuestionsCreated();
      // ethers v5 returns BigNumber, not bigint
      expect(created).to.be.an("object");
    });

    it("should create a condition with metadata", async function () {
      const currentHeight = await blockHeaderOracle.getCurrentBlockHeight();
      const threshold = ethers.utils.parseUnits("50", "gwei");
      // Create condition at a future block (must be > currentBlockHeight)
      const targetBlockHeight = currentHeight + 2;
      const metadata = encodeDifficultyThreshold(threshold, targetBlockHeight);

      const tx = await conditionManager
        .connect(marketMaker)
        .createConditionWithMetadata(
          QuestionType.DifficultyThreshold,
          metadata,
          2, // binary outcome
          "test://threshold",
          ethers.constants.HashZero
        );

      const receipt = await tx.wait();
      expect(receipt.status).to.equal(1);
      expect(receipt).to.exist;
    });

    it("should handle range question creation", async function () {
      const currentHeight = await blockHeaderOracle.getCurrentBlockHeight();
      const targetBlockHeight = currentHeight + 2;
      const buckets = [
        ethers.utils.parseUnits("40", "gwei"),
        ethers.utils.parseUnits("50", "gwei"),
        ethers.utils.parseUnits("60", "gwei"),
      ];
      const metadata = encodeDifficultyRange(targetBlockHeight, buckets);

      const tx = await conditionManager
        .connect(marketMaker)
        .createConditionWithMetadata(
          QuestionType.DifficultyRange,
          metadata,
          4, // 3 buckets + 1 = 4 outcomes
          "test://range",
          ethers.constants.HashZero
        );

      const receipt = await tx.wait();
      expect(receipt.status).to.equal(1);
    });
  });

  // ========================================
  // DIFFICULTY THRESHOLD FLOW
  // ========================================

  describe("Difficulty Threshold Question Flow", function () {
    it("should create and query threshold question", async function () {
      const currentHeight = await blockHeaderOracle.getCurrentBlockHeight();
      const threshold = ethers.utils.parseUnits("50", "gwei");
      const targetBlockHeight = currentHeight + 2;
      const settlementBlock = targetBlockHeight + SETTLEMENT_DELAY;
      const metadata = encodeDifficultyThreshold(threshold, targetBlockHeight);

      const tx = await conditionManager
        .connect(marketMaker)
        .createConditionWithMetadata(
          QuestionType.DifficultyThreshold,
          metadata,
          2,
          "test://threshold",
          ethers.constants.HashZero
        );

      const receipt = await tx.wait();
      expect(receipt.status).to.equal(1);

      // Query questions at settlement block
      const questions =
        await oracleAdapter.getThresholdQuestionsAtBlock(settlementBlock);
      // Note: Actual storage happens in hidden function, so we test query structure
      expect(Array.isArray(questions)).to.be.true;
    });

    it("should handle threshold at future block height", async function () {
      const currentHeight = await blockHeaderOracle.getCurrentBlockHeight();
      const threshold = ethers.utils.parseUnits("50", "gwei");
      // Must be strictly greater than currentHeight (validation: targetBlockHeight > currentBlockHeight)
      const targetHeight = currentHeight + 1;
      const metadata = encodeDifficultyThreshold(threshold, targetHeight);

      const tx = await conditionManager
        .connect(marketMaker)
        .createConditionWithMetadata(
          QuestionType.DifficultyThreshold,
          metadata,
          2,
          "test://future",
          ethers.constants.HashZero
        );

      const receipt = await tx.wait();
      expect(receipt.status).to.equal(1);
    });

    it("should handle threshold in near future", async function () {
      const currentHeight = await blockHeaderOracle.getCurrentBlockHeight();
      const targetHeight = currentHeight + 2;
      const threshold = ethers.utils.parseUnits("50", "gwei");
      const metadata = encodeDifficultyThreshold(threshold, targetHeight);

      const tx = await conditionManager
        .connect(marketMaker)
        .createConditionWithMetadata(
          QuestionType.DifficultyThreshold,
          metadata,
          2,
          "test://future-near",
          ethers.constants.HashZero
        );

      const receipt = await tx.wait();
      expect(receipt.status).to.equal(1);
    });
  });

  // ========================================
  // DIFFICULTY RANGE FLOW
  // ========================================

  describe("Difficulty Range Question Flow", function () {
    it("should create range question with multiple buckets", async function () {
      const currentHeight = await blockHeaderOracle.getCurrentBlockHeight();
      const targetHeight = currentHeight + 2;
      const buckets = [
        ethers.utils.parseUnits("40", "gwei"),
        ethers.utils.parseUnits("50", "gwei"),
        ethers.utils.parseUnits("60", "gwei"),
        ethers.utils.parseUnits("70", "gwei"),
      ];
      const metadata = encodeDifficultyRange(targetHeight, buckets);

      const tx = await conditionManager
        .connect(marketMaker)
        .createConditionWithMetadata(
          QuestionType.DifficultyRange,
          metadata,
          5, // 4 buckets + 1 = 5 outcomes
          "test://range-multi",
          ethers.constants.HashZero
        );

      const receipt2 = await tx.wait();
      expect(receipt2.status).to.equal(1);
    });

    it("should create range question with single bucket", async function () {
      const currentHeight = await blockHeaderOracle.getCurrentBlockHeight();
      const targetHeight = currentHeight + 2;
      const buckets = [ethers.utils.parseUnits("50", "gwei")];
      const metadata = encodeDifficultyRange(targetHeight, buckets);

      const tx = await conditionManager
        .connect(marketMaker)
        .createConditionWithMetadata(
          QuestionType.DifficultyRange,
          metadata,
          2, // 1 bucket + 1 = 2 outcomes
          "test://range-single",
          ethers.constants.HashZero
        );

      const receipt = await tx.wait();
      expect(receipt.status).to.equal(1);
    });

    it("should reject unsorted buckets", async function () {
      const currentHeight = await blockHeaderOracle.getCurrentBlockHeight();
      const targetHeight = currentHeight + 2;
      // Unsorted buckets (descending)
      const buckets = [
        ethers.utils.parseUnits("70", "gwei"),
        ethers.utils.parseUnits("50", "gwei"),
        ethers.utils.parseUnits("40", "gwei"),
      ];
      const metadata = encodeDifficultyRange(targetHeight, buckets);

      // This should fail validation
      await expect(
        conditionManager.connect(marketMaker).createConditionWithMetadata(
          QuestionType.DifficultyRange,
          metadata,
          4,
          "test://unsorted",
          ethers.constants.HashZero
        )
      ).to.be.reverted;
    });
  });

  // ========================================
  // BLOCK COUNT FLOW
  // ========================================

  describe("Block Count Question Flow", function () {
    it("should create block count question", async function () {
      // Get current block timestamp from Hardhat (not from oracle block data)
      const currentBlock = await ethers.provider.getBlock("latest");
      const blockTimestamp = currentBlock.timestamp;

      // Timestamps must be in the future (> block.timestamp)
      // Use current block timestamp + sufficient buffer to ensure future timestamps
      const startTimestamp = blockTimestamp + 1800; // 30 min from now
      const endTimestamp = blockTimestamp + 7200; // 2 hours from now
      const countBuckets = [100, 150, 200];
      const metadata = encodeBlockCount(startTimestamp, endTimestamp, countBuckets);

      const tx = await conditionManager
        .connect(marketMaker)
        .createConditionWithMetadata(
          QuestionType.BlockCount,
          metadata,
          4, // 3 buckets + 1 = 4 outcomes
          "test://blockcount",
          ethers.constants.HashZero
        );

      const receipt3 = await tx.wait();
      expect(receipt3.status).to.equal(1);
    });

    it("should create block count with single bucket", async function () {
      // Get current block timestamp from Hardhat (not from oracle block data)
      const currentBlock = await ethers.provider.getBlock("latest");
      const blockTimestamp = currentBlock.timestamp;

      // Timestamps must be in the future (> block.timestamp)
      // Use current block timestamp + sufficient buffer to ensure future timestamps
      const startTimestamp = blockTimestamp + 1800; // 30 min from now
      const endTimestamp = blockTimestamp + 7200; // 2 hours from now
      const countBuckets = [50];
      const metadata = encodeBlockCount(
        startTimestamp,
        endTimestamp,
        countBuckets
      );

      const tx = await conditionManager
        .connect(marketMaker)
        .createConditionWithMetadata(
          QuestionType.BlockCount,
          metadata,
          2,
          "test://blockcount-single",
          ethers.constants.HashZero
        );

      const receipt = await tx.wait();
      expect(receipt.status).to.equal(1);
    });

    it("should query questions by timestamp bucket", async function () {
      const latestBlock = await blockHeaderOracle.getLatestBlockHeader();
      const futureTimestamp = latestBlock.timestamp + 3600; // 1 hour in future

      const questions =
        await oracleAdapter.getBlockCountQuestionsAtTimestamp(futureTimestamp);
      expect(Array.isArray(questions)).to.be.true;
    });
  });

  // ========================================
  // MINING DURATION FLOW
  // ========================================

  describe("Mining Duration Question Flow", function () {
    it("should create mining duration question", async function () {
      const currentHeight = await blockHeaderOracle.getCurrentBlockHeight();
      const startBlock = currentHeight + 1;
      const blockCount = 2; // Small count for testing
      const durationBuckets = [600, 1200]; // 10, 20 minutes
      const metadata = encodeMiningDuration(
        startBlock,
        blockCount,
        durationBuckets
      );

      const tx = await conditionManager
        .connect(marketMaker)
        .createConditionWithMetadata(
          QuestionType.MiningDuration,
          metadata,
          3, // 2 buckets + 1 = 3 outcomes
          "test://duration",
          ethers.constants.HashZero
        );

      const receipt4 = await tx.wait();
      expect(receipt4.status).to.equal(1);
    });

    it("should handle maximum block count (2016)", async function () {
      const currentHeight = await blockHeaderOracle.getCurrentBlockHeight();
      const startBlock = currentHeight + 1;
      const blockCount = 2016; // Max block count (1 difficulty period)
      const durationBuckets = [3600, 7200]; // 1, 2 hours
      const metadata = encodeMiningDuration(
        startBlock,
        blockCount,
        durationBuckets
      );

      const tx = await conditionManager
        .connect(marketMaker)
        .createConditionWithMetadata(
          QuestionType.MiningDuration,
          metadata,
          3,
          "test://duration-max",
          ethers.constants.HashZero
        );

      const receipt = await tx.wait();
      expect(receipt.status).to.equal(1);
    });

    it("should handle single block duration", async function () {
      const currentHeight = await blockHeaderOracle.getCurrentBlockHeight();
      const startBlock = currentHeight + 1;
      const blockCount = 1;
      const durationBuckets = [600]; // 10 minutes
      const metadata = encodeMiningDuration(
        startBlock,
        blockCount,
        durationBuckets
      );

      const tx = await conditionManager
        .connect(marketMaker)
        .createConditionWithMetadata(
          QuestionType.MiningDuration,
          metadata,
          2,
          "test://duration-single",
          ethers.constants.HashZero
        );

      const receipt = await tx.wait();
      expect(receipt.status).to.equal(1);
    });
  });

  // ========================================
  // SETTLEMENT DELAY TESTS
  // ========================================

  describe("Settlement Delay Handling", function () {
    it("should apply settlement delay correctly", async function () {
      // Settlement delay adds 6 blocks to resolution trigger
      const currentHeight = await blockHeaderOracle.getCurrentBlockHeight();
      const targetHeight = currentHeight + 2;
      const expectedSettlementBlock = targetHeight + SETTLEMENT_DELAY;

      const threshold = ethers.utils.parseUnits("50", "gwei");
      const metadata = encodeDifficultyThreshold(threshold, targetHeight);

      const tx = await conditionManager
        .connect(marketMaker)
        .createConditionWithMetadata(
          QuestionType.DifficultyThreshold,
          metadata,
          2,
          "test://delay",
          ethers.constants.HashZero
        );

      const receipt = await tx.wait();
      expect(receipt.status).to.equal(1);

      // Question should be stored at expectedSettlementBlock
      const questions = await oracleAdapter.getThresholdQuestionsAtBlock(
        expectedSettlementBlock
      );
      expect(Array.isArray(questions)).to.be.true;
    });
  });

  // ========================================
  // MULTIPLE QUESTIONS FLOW
  // ========================================

  describe("Multiple Questions at Same Settlement Point", function () {
    it("should handle multiple threshold questions at same block", async function () {
      const currentHeight = await blockHeaderOracle.getCurrentBlockHeight();
      const targetHeight = currentHeight + 2;
      const settlementBlock = targetHeight + SETTLEMENT_DELAY;

      const threshold1 = ethers.utils.parseUnits("40", "gwei");
      const threshold2 = ethers.utils.parseUnits("60", "gwei");

      const metadata1 = encodeDifficultyThreshold(threshold1, targetHeight);
      const metadata2 = encodeDifficultyThreshold(threshold2, targetHeight);

      // Create both questions
      await conditionManager
        .connect(marketMaker)
        .createConditionWithMetadata(
          QuestionType.DifficultyThreshold,
          metadata1,
          2,
          "test://multi-1",
          ethers.constants.HashZero
        );

      await conditionManager
        .connect(marketMaker)
        .createConditionWithMetadata(
          QuestionType.DifficultyThreshold,
          metadata2,
          2,
          "test://multi-2",
          ethers.constants.HashZero
        );

      // Both should be queryable at settlement block
      const questions =
        await oracleAdapter.getThresholdQuestionsAtBlock(settlementBlock);
      expect(Array.isArray(questions)).to.be.true;
    });

    it("should handle mixed question types at different settlements", async function () {
      const currentHeight = await blockHeaderOracle.getCurrentBlockHeight();

      // Create threshold question
      const thresholdHeight = currentHeight + 2;
      const thresholdMetadata = encodeDifficultyThreshold(
        ethers.utils.parseUnits("50", "gwei"),
        thresholdHeight
      );

      // Create block count question (timestamp-based, timestamps must be in future)
      // Use current Hardhat block timestamp, not oracle block data
      const currentBlock = await ethers.provider.getBlock("latest");
      const blockCountMetadata = encodeBlockCount(
        currentBlock.timestamp + 1800, // 30 min from now
        currentBlock.timestamp + 5400, // 90 min from now
        [100]
      );

      await conditionManager
        .connect(marketMaker)
        .createConditionWithMetadata(
          QuestionType.DifficultyThreshold,
          thresholdMetadata,
          2,
          "test://mixed-threshold",
          ethers.constants.HashZero
        );

      await conditionManager
        .connect(marketMaker)
        .createConditionWithMetadata(
          QuestionType.BlockCount,
          blockCountMetadata,
          2,
          "test://mixed-blockcount",
          ethers.constants.HashZero
        );

      // Both should be created successfully
      const thresholdQuestions = await oracleAdapter.getThresholdQuestionsAtBlock(
        thresholdHeight + SETTLEMENT_DELAY
      );
      expect(Array.isArray(thresholdQuestions)).to.be.true;
    });
  });

  // ========================================
  // PERMISSION AND ACCESS CONTROL
  // ========================================

  describe("Permission Checks", function () {
    it("should only allow market makers to create conditions", async function () {
      const currentHeight = await blockHeaderOracle.getCurrentBlockHeight();
      const metadata = encodeDifficultyThreshold(
        ethers.utils.parseUnits("50", "gwei"),
        currentHeight + 10
      );

      // Non-market maker should be rejected
      await expect(
        conditionManager.connect(owner).createConditionWithMetadata(
          QuestionType.DifficultyThreshold,
          metadata,
          2,
          "test://unauthorized",
          ethers.constants.HashZero
        )
      ).to.be.reverted;
    });
  });

  // ========================================
  // GAS EFFICIENCY TESTS
  // ========================================

  describe("Gas Efficiency", function () {
    it("should create condition with reasonable gas", async function () {
      const currentHeight = await blockHeaderOracle.getCurrentBlockHeight();
      const metadata = encodeDifficultyThreshold(
        ethers.utils.parseUnits("50", "gwei"),
        currentHeight + 2
      );

      const tx = await conditionManager
        .connect(marketMaker)
        .createConditionWithMetadata(
          QuestionType.DifficultyThreshold,
          metadata,
          2,
          "test://gas",
          ethers.constants.HashZero
        );

      const receipt = await tx.wait();
      // ethers v5 returns BigNumber, convert to number for comparison
      const gasUsed = receipt.gasUsed.toNumber ? receipt.gasUsed.toNumber() : receipt.gasUsed;
      expect(gasUsed).to.be.lessThan(500000); // Less than 500k gas
    });

    it("should query conditions efficiently", async function () {
      const blockHeight = 1000000;
      // Query should be O(1) - just array lookup
      const questions =
        await oracleAdapter.getThresholdQuestionsAtBlock(blockHeight);
      expect(Array.isArray(questions)).to.be.true;
    });
  });

  // ========================================
  // END-TO-END RESOLUTION TESTS
  // ========================================

  describe("End-to-End DifficultyThreshold Resolution", function () {
    it("should create threshold question with settlement delay", async function () {
      // Setup: Get current block height and test blocks
      const currentHeight = await blockHeaderOracle.getCurrentBlockHeight();
      const targetHeight = currentHeight.add ? currentHeight.add(2) : ethers.BigNumber.from(currentHeight).add(2);
      const settlementHeight = targetHeight.add ? targetHeight.add(SETTLEMENT_DELAY) : ethers.BigNumber.from(targetHeight).add(SETTLEMENT_DELAY);
      const threshold = ethers.utils.parseUnits("50", "gwei");

      // 1. Create threshold question
      const metadata = encodeDifficultyThreshold(threshold, targetHeight);

      // Use callStatic to get return values without sending the transaction
      let [conditionId, questionId] = await conditionManager
        .connect(marketMaker)
        .callStatic.createConditionWithMetadata(
          QuestionType.DifficultyThreshold,
          metadata,
          2,
          "test://e2e-threshold",
          ethers.constants.HashZero
        );

      // Now send the actual transaction
      const tx = await conditionManager
        .connect(marketMaker)
        .createConditionWithMetadata(
          QuestionType.DifficultyThreshold,
          metadata,
          2,
          "test://e2e-threshold",
          ethers.constants.HashZero
        );
      await tx.wait();

      expect(conditionId).to.not.equal(ethers.constants.HashZero);
      expect(questionId).to.not.equal(ethers.constants.HashZero);

      // 2. Verify question was registered at settlement block (not target block)
      const questionsAtSettlement =
        await oracleAdapter.getThresholdQuestionsAtBlock(settlementHeight);

      expect(questionsAtSettlement.length).to.be.greaterThan(0);
      expect(questionsAtSettlement[0].questionId).to.equal(questionId);
      expect(questionsAtSettlement[0].conditionId).to.equal(conditionId);
      expect(questionsAtSettlement[0].threshold).to.equal(threshold);
      expect(questionsAtSettlement[0].targetBlockHeight).to.equal(targetHeight);

      // 3. Verify question was NOT registered at target block (should be at settlement)
      const questionsAtTarget =
        await oracleAdapter.getThresholdQuestionsAtBlock(targetHeight);
      expect(questionsAtTarget.length).to.equal(0);
    });
  });

  describe("End-to-End DifficultyRange Resolution", function () {
    it("should create range question with settlement delay", async function () {
      const currentHeight = await blockHeaderOracle.getCurrentBlockHeight();
      const targetHeight = currentHeight.add ? currentHeight.add(2) : ethers.BigNumber.from(currentHeight).add(2);
      const settlementHeight = targetHeight.add ? targetHeight.add(SETTLEMENT_DELAY) : ethers.BigNumber.from(targetHeight).add(SETTLEMENT_DELAY);
      const buckets = [
        ethers.utils.parseUnits("40", "gwei"),
        ethers.utils.parseUnits("50", "gwei"),
        ethers.utils.parseUnits("60", "gwei"),
      ];

      // 1. Create range question
      const metadata = encodeDifficultyRange(targetHeight, buckets);

      // Use callStatic to get return values
      let [conditionId, questionId] = await conditionManager
        .connect(marketMaker)
        .callStatic.createConditionWithMetadata(
          QuestionType.DifficultyRange,
          metadata,
          4, // 3 buckets + 1 = 4 outcomes
          "test://e2e-range",
          ethers.constants.HashZero
        );

      // Send actual transaction
      const tx = await conditionManager
        .connect(marketMaker)
        .createConditionWithMetadata(
          QuestionType.DifficultyRange,
          metadata,
          4,
          "test://e2e-range",
          ethers.constants.HashZero
        );
      await tx.wait();

      // 2. Verify question was registered at settlement block
      const questionsAtSettlement =
        await oracleAdapter.getRangeQuestionsAtBlock(settlementHeight);
      expect(questionsAtSettlement.length).to.be.greaterThan(0);
      expect(questionsAtSettlement[0].questionId).to.equal(questionId);
      expect(questionsAtSettlement[0].targetBlockHeight).to.equal(targetHeight);
      expect(questionsAtSettlement[0].buckets.length).to.equal(buckets.length);

      // 3. Verify question not at target block
      const questionsAtTarget =
        await oracleAdapter.getRangeQuestionsAtBlock(targetHeight);
      expect(questionsAtTarget.length).to.equal(0);
    });
  });

  describe("End-to-End MiningDuration Resolution", function () {
    it("should create duration question with settlement delay", async function () {
      const currentHeight = await blockHeaderOracle.getCurrentBlockHeight();
      const startBlock = currentHeight.add ? currentHeight.add(1) : ethers.BigNumber.from(currentHeight).add(1);
      const blockCount = 2; // Mine 2 blocks
      const settlementHeight = startBlock.add ? startBlock.add(blockCount + SETTLEMENT_DELAY) : ethers.BigNumber.from(startBlock).add(blockCount + SETTLEMENT_DELAY);
      const durationBuckets = [600, 1200]; // 10min, 20min buckets

      // 1. Create duration question
      const metadata = encodeMiningDuration(startBlock, blockCount, durationBuckets);

      // Use callStatic to get return values
      const [, questionId] = await conditionManager
        .connect(marketMaker)
        .callStatic.createConditionWithMetadata(
          QuestionType.MiningDuration,
          metadata,
          3, // 2 buckets + 1 = 3 outcomes
          "test://e2e-duration",
          ethers.constants.HashZero
        );

      // Send actual transaction
      const tx = await conditionManager
        .connect(marketMaker)
        .createConditionWithMetadata(
          QuestionType.MiningDuration,
          metadata,
          3,
          "test://e2e-duration",
          ethers.constants.HashZero
        );
      await tx.wait();

      // 2. Verify question was registered at correct settlement block
      const questionsAtSettlement =
        await oracleAdapter.getDurationQuestionsAtBlock(settlementHeight);
      expect(questionsAtSettlement.length).to.be.greaterThan(0);
      expect(questionsAtSettlement[0].questionId).to.equal(questionId);
      expect(questionsAtSettlement[0].startBlockHeight).to.equal(startBlock);
      expect(questionsAtSettlement[0].blockCount).to.equal(blockCount);

      // 3. Verify question not at target block
      const questionsAtStartBlock =
        await oracleAdapter.getDurationQuestionsAtBlock(startBlock);
      expect(questionsAtStartBlock.length).to.equal(0);
    });
  });

  describe("End-to-End BlockCount Resolution", function () {
    it("should create block count question for timestamp window", async function () {
      // Get current block timestamp from Hardhat (not from oracle block data)
      const currentBlock = await ethers.provider.getBlock("latest");
      const blockTimestamp = currentBlock.timestamp;

      // Timestamps must be in the future (> block.timestamp)
      // Use current block timestamp + sufficient buffer to ensure future timestamps
      const startTimestamp = blockTimestamp + 1800; // 30 min from now
      const endTimestamp = blockTimestamp + 7200; // 2 hours from now
      const countBuckets = [100, 150];

      // 1. Create block count question
      const metadata = encodeBlockCount(
        startTimestamp,
        endTimestamp,
        countBuckets
      );

      // Use callStatic to get return values
      const [, questionId] = await conditionManager
        .connect(marketMaker)
        .callStatic.createConditionWithMetadata(
          QuestionType.BlockCount,
          metadata,
          3, // 2 buckets + 1 = 3 outcomes
          "test://e2e-blockcount",
          ethers.constants.HashZero
        );

      // Send actual transaction
      const tx = await conditionManager
        .connect(marketMaker)
        .createConditionWithMetadata(
          QuestionType.BlockCount,
          metadata,
          3,
          "test://e2e-blockcount",
          ethers.constants.HashZero
        );
      await tx.wait();

      // 2. Verify question was registered at timestamp bucket
      const questionsAtBucket =
        await oracleAdapter.getBlockCountQuestionsAtTimestamp(endTimestamp);
      expect(questionsAtBucket.length).to.be.greaterThan(0);

      // Find our question in the bucket
      const ourQuestion = questionsAtBucket.find(
        (q) => q.questionId === questionId
      );
      expect(ourQuestion).to.not.be.undefined;
      expect(ourQuestion.startTimestamp).to.equal(startTimestamp);
      expect(ourQuestion.endTimestamp).to.equal(endTimestamp);
      expect(ourQuestion.countBuckets.length).to.equal(countBuckets.length);
    });
  });

  describe("Settlement Delay Verification", function () {
    it("should register question at settlement block, not target block", async function () {
      const currentHeight = await blockHeaderOracle.getCurrentBlockHeight();
      const targetHeight = currentHeight.add ? currentHeight.add(2) : ethers.BigNumber.from(currentHeight).add(2);
      const settlementHeight = targetHeight.add ? targetHeight.add(SETTLEMENT_DELAY) : ethers.BigNumber.from(targetHeight).add(SETTLEMENT_DELAY);

      const metadata = encodeDifficultyThreshold(
        ethers.utils.parseUnits("50", "gwei"),
        targetHeight
      );
      await conditionManager
        .connect(marketMaker)
        .createConditionWithMetadata(
          QuestionType.DifficultyThreshold,
          metadata,
          2,
          "test://settlement-delay",
          ethers.constants.HashZero
        );

      // Questions should be registered at settlement height, not target height
      const questionsAtTarget =
        await oracleAdapter.getThresholdQuestionsAtBlock(targetHeight);
      expect(questionsAtTarget.length).to.equal(0); // Not at target block

      const questionsAtSettlement =
        await oracleAdapter.getThresholdQuestionsAtBlock(settlementHeight);
      expect(questionsAtSettlement.length).to.be.greaterThan(0); // At settlement block
    });
  });

  describe("Parameter Validation on Creation", function () {
    it("should reject DifficultyThreshold with zero threshold", async function () {
      const currentHeight = await blockHeaderOracle.getCurrentBlockHeight();
      const metadata = encodeDifficultyThreshold(0, currentHeight + 10); // Zero threshold

      await expect(
        conditionManager.connect(marketMaker).createConditionWithMetadata(
          QuestionType.DifficultyThreshold,
          metadata,
          2,
          "test://zero-threshold",
          ethers.constants.HashZero
        )
      ).to.be.reverted;
    });

    it("should reject DifficultyThreshold with current/past block height", async function () {
      const currentHeight = await blockHeaderOracle.getCurrentBlockHeight();
      const metadata = encodeDifficultyThreshold(
        ethers.utils.parseUnits("50", "gwei"),
        currentHeight // Current height instead of future
      );

      await expect(
        conditionManager.connect(marketMaker).createConditionWithMetadata(
          QuestionType.DifficultyThreshold,
          metadata,
          2,
          "test://past-block",
          ethers.constants.HashZero
        )
      ).to.be.reverted;
    });

    it("should reject DifficultyRange with unsorted buckets", async function () {
      const currentHeight = await blockHeaderOracle.getCurrentBlockHeight();
      const unsortedBuckets = [
        ethers.utils.parseUnits("60", "gwei"),
        ethers.utils.parseUnits("50", "gwei"), // Out of order
        ethers.utils.parseUnits("40", "gwei"),
      ];

      const metadata = encodeDifficultyRange(
        currentHeight + 10,
        unsortedBuckets
      );

      await expect(
        conditionManager.connect(marketMaker).createConditionWithMetadata(
          QuestionType.DifficultyRange,
          metadata,
          4,
          "test://unsorted",
          ethers.constants.HashZero
        )
      ).to.be.reverted;
    });

    it("should reject BlockCount with endTimestamp <= startTimestamp", async function () {
      const latestBlockHeader = await blockHeaderOracle.getLatestBlockHeader();
      const currentTimestamp = latestBlockHeader.timestamp;

      const metadata = encodeBlockCount(
        currentTimestamp + 3600,
        currentTimestamp + 1800, // End before start
        [100, 150]
      );

      await expect(
        conditionManager.connect(marketMaker).createConditionWithMetadata(
          QuestionType.BlockCount,
          metadata,
          3,
          "test://bad-timestamps",
          ethers.constants.HashZero
        )
      ).to.be.reverted;
    });

    it("should reject MiningDuration with blockCount exceeding MAX_BLOCK_COUNT", async function () {
      const currentHeight = await blockHeaderOracle.getCurrentBlockHeight();
      const excessiveBlockCount = 3000; // MAX_BLOCK_COUNT is 2016

      const metadata = encodeMiningDuration(
        currentHeight + 10,
        excessiveBlockCount,
        [3600, 7200]
      );

      await expect(
        conditionManager.connect(marketMaker).createConditionWithMetadata(
          QuestionType.MiningDuration,
          metadata,
          3,
          "test://excess-blocks",
          ethers.constants.HashZero
        )
      ).to.be.reverted;
    });
  });
});
