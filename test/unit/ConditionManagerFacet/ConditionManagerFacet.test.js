const { deployDiamond } = require("../../../scripts/deploy.js");
const { expect } = require("chai");
const { ethers } = require("hardhat");

const { getConditionId } = require("../../utils/ctfUtils.js");
const {
  takeSnapshot,
  revertToSnapshot,
} = require("../../utils/snapshotUtils.js");
const {
  QuestionType,
  encodeDifficultyThreshold,
  encodeDifficultyRange,
  encodeBlockCount,
  encodeMiningDuration,
} = require("../../utils/oracleAdapterUtils.js");

describe("ConditionManagerFacet", function () {
  let owner, oracle, oracle2, user1, marketMaker;
  let diamondAddress, conditionManagerFacet, accessControlFacet, blockHeaderOracle;
  let snapshotId;

  before(async function () {
    [owner, oracle, oracle2, user1, marketMaker] =
      await ethers.getSigners();

    diamondAddress = await deployDiamond();
    conditionManagerFacet = await ethers.getContractAt(
      "ConditionManagerFacet",
      diamondAddress
    );
    accessControlFacet = await ethers.getContractAt(
      "AccessControlFacet",
      diamondAddress
    );
    blockHeaderOracle = await ethers.getContractAt(
      "IDoefinBlockHeaderOracle",
      diamondAddress
    );

    // Add market maker for condition creation
    await accessControlFacet.connect(owner).addMarketMaker(marketMaker.address);
  });

  beforeEach(async () => {
    snapshotId = await takeSnapshot();
  });

  afterEach(async () => {
    await revertToSnapshot(snapshotId);
  });

  describe("Condition Creation", function () {
    it("should create a basic binary condition", async () => {
      const questionId = ethers.utils.id("will-btc-reach-100k?");
      const outcomeSlotCount = 2;
      const ipfsHash = "ipfs://QmTest123";

      const expectedConditionId = getConditionId(
        oracle.address,
        questionId,
        outcomeSlotCount
      );

      await expect(
        conditionManagerFacet
          .connect(marketMaker)
          .createCondition(
            oracle.address,
            questionId,
            outcomeSlotCount,
            ipfsHash
          )
      )
        .to.emit(conditionManagerFacet, "ConditionCreated")
        .withArgs(
          expectedConditionId,
          oracle.address,
          questionId,
          outcomeSlotCount,
          ipfsHash,
          marketMaker.address
        );

      // Verify condition exists
      const [
        conditionOracle,
        conditionQuestionId,
        conditionOutcomeSlotCount,
        conditionMetadataURI,
      ] = await conditionManagerFacet.getCondition(expectedConditionId);
      expect(conditionOracle).to.equal(oracle.address);
      expect(conditionQuestionId).to.equal(questionId);
      expect(conditionOutcomeSlotCount).to.equal(outcomeSlotCount);
      expect(conditionMetadataURI).to.equal(ipfsHash);
    });

    it("should create condition with multiple outcomes", async () => {
      const questionId = ethers.utils.id("election-winner?");
      const outcomeSlotCount = 5; // 5 candidates
      const ipfsHash = "ipfs://QmElection123";

      const expectedConditionId = getConditionId(
        oracle.address,
        questionId,
        outcomeSlotCount
      );

      await expect(
        conditionManagerFacet
          .connect(marketMaker)
          .createCondition(
            oracle.address,
            questionId,
            outcomeSlotCount,
            ipfsHash
          )
      )
        .to.emit(conditionManagerFacet, "ConditionCreated")
        .withArgs(
          expectedConditionId,
          oracle.address,
          questionId,
          outcomeSlotCount,
          ipfsHash,
          marketMaker.address
        );

      const [, , conditionOutcomeSlotCount] =
        await conditionManagerFacet.getCondition(expectedConditionId);
      expect(conditionOutcomeSlotCount).to.equal(outcomeSlotCount);
    });

    it("should create conditions with different oracles", async () => {
      const questionId1 = ethers.utils.id("oracle1-question");
      const questionId2 = ethers.utils.id("oracle2-question");
      const outcomeSlotCount = 2;

      const conditionId1 = getConditionId(
        oracle.address,
        questionId1,
        outcomeSlotCount
      );
      const conditionId2 = getConditionId(
        oracle2.address,
        questionId2,
        outcomeSlotCount
      );

      await conditionManagerFacet
        .connect(marketMaker)
        .createCondition(
          oracle.address,
          questionId1,
          outcomeSlotCount,
          "ipfs://oracle1"
        );

      await conditionManagerFacet
        .connect(marketMaker)
        .createCondition(
          oracle2.address,
          questionId2,
          outcomeSlotCount,
          "ipfs://oracle2"
        );

      const [oracle1, , ,] = await conditionManagerFacet.getCondition(
        conditionId1
      );
      const [oracle2Addr, , ,] = await conditionManagerFacet.getCondition(
        conditionId2
      );

      expect(oracle1).to.equal(oracle.address);
      expect(oracle2Addr).to.equal(oracle2.address);
      expect(conditionId1).to.not.equal(conditionId2);
    });

    it("should revert if non-market-maker tries to create condition", async () => {
      const questionId = ethers.utils.id("unauthorized-question");
      const outcomeSlotCount = 2;

      await expect(
        conditionManagerFacet
          .connect(user1)
          .createCondition(
            oracle.address,
            questionId,
            outcomeSlotCount,
            "ipfs://unauthorized"
          )
      ).to.be.revertedWith("NotMarketMaker()");
    });

    it("should revert when creating duplicate condition", async () => {
      const questionId = ethers.utils.id("duplicate-question");
      const outcomeSlotCount = 2;

      // Create first condition
      await conditionManagerFacet
        .connect(marketMaker)
        .createCondition(
          oracle.address,
          questionId,
          outcomeSlotCount,
          "ipfs://first"
        );

      // Try to create duplicate
      await expect(
        conditionManagerFacet
          .connect(marketMaker)
          .createCondition(
            oracle.address,
            questionId,
            outcomeSlotCount,
            "ipfs://duplicate"
          )
      ).to.be.revertedWith("ConditionAlreadyPrepared()");
    });

    it("should revert with invalid outcome slot count", async () => {
      const questionId = ethers.utils.id("invalid-outcomes");

      // Zero outcomes
      await expect(
        conditionManagerFacet
          .connect(marketMaker)
          .createCondition(oracle.address, questionId, 0, "ipfs://zero")
      ).to.be.revertedWith("InvalidOutcomeSlotCount()");

      // One outcome (not meaningful)
      await expect(
        conditionManagerFacet
          .connect(marketMaker)
          .createCondition(oracle.address, questionId, 1, "ipfs://one")
      ).to.be.revertedWith("InvalidOutcomeSlotCount()");
    });

    it("should revert with zero oracle address", async () => {
      const questionId = ethers.utils.id("zero-oracle");
      const outcomeSlotCount = 2;

      // LibCTFCondition.prepareCondition validates oracle address and throws InvalidOracleAddress
      await expect(
        conditionManagerFacet
          .connect(marketMaker)
          .createCondition(
            ethers.constants.AddressZero,
            questionId,
            outcomeSlotCount,
            "ipfs://zero-oracle"
          )
      ).to.be.revertedWith("InvalidOracleAddress()");
    });
  });

  describe("Create Condition With Metadata and Events", function () {
    const SETTLEMENT_DELAY = 6;

    it("should emit DifficultyThresholdQuestionCreated event with all parameters", async () => {
      const currentHeight = await blockHeaderOracle.getCurrentBlockHeight();
      const targetBlockHeight = currentHeight.add ? currentHeight.add(2) : ethers.BigNumber.from(currentHeight).add(2);
      const settlementBlock = targetBlockHeight.add ? targetBlockHeight.add(SETTLEMENT_DELAY) : ethers.BigNumber.from(targetBlockHeight).add(SETTLEMENT_DELAY);
      const threshold = ethers.utils.parseUnits("50", "gwei");
      const metadata = encodeDifficultyThreshold(threshold, targetBlockHeight);

      // Get return values
      const [conditionId, questionId] = await conditionManagerFacet
        .connect(marketMaker)
        .callStatic.createConditionWithMetadata(
          QuestionType.DifficultyThreshold,
          metadata,
          2,
          "ipfs://test-threshold",
          ethers.constants.HashZero
        );

      const tx = await conditionManagerFacet
        .connect(marketMaker)
        .createConditionWithMetadata(
          QuestionType.DifficultyThreshold,
          metadata,
          2,
          "ipfs://test-threshold",
          ethers.constants.HashZero
        );

      // Verify the specialized event is emitted with all parameters
      await expect(tx)
        .to.emit(conditionManagerFacet, "DifficultyThresholdQuestionCreated")
        .withArgs(
          questionId,
          conditionId,
          threshold,
          targetBlockHeight,
          settlementBlock,
          marketMaker.address
        );

      // Also verify QuestionCreated generic event
      await expect(tx)
        .to.emit(conditionManagerFacet, "QuestionCreated")
        .withArgs(
          questionId,
          conditionId,
          QuestionType.DifficultyThreshold,
          settlementBlock,
          marketMaker.address
        );

      // Verify ConditionCreated event
      await expect(tx).to.emit(conditionManagerFacet, "ConditionCreated");
    });

    it("should emit DifficultyRangeQuestionCreated event with buckets", async () => {
      const currentHeight = await blockHeaderOracle.getCurrentBlockHeight();
      const targetBlockHeight = currentHeight.add ? currentHeight.add(2) : ethers.BigNumber.from(currentHeight).add(2);
      const settlementBlock = targetBlockHeight.add ? targetBlockHeight.add(SETTLEMENT_DELAY) : ethers.BigNumber.from(targetBlockHeight).add(SETTLEMENT_DELAY);
      const buckets = [
        ethers.utils.parseUnits("40", "gwei"),
        ethers.utils.parseUnits("50", "gwei"),
        ethers.utils.parseUnits("60", "gwei"),
      ];
      const metadata = encodeDifficultyRange(targetBlockHeight, buckets);

      const [conditionId, questionId] = await conditionManagerFacet
        .connect(marketMaker)
        .callStatic.createConditionWithMetadata(
          QuestionType.DifficultyRange,
          metadata,
          4, // 3 buckets + 1 = 4 outcomes
          "ipfs://test-range",
          ethers.constants.HashZero
        );

      const tx = await conditionManagerFacet
        .connect(marketMaker)
        .createConditionWithMetadata(
          QuestionType.DifficultyRange,
          metadata,
          4,
          "ipfs://test-range",
          ethers.constants.HashZero
        );

      await expect(tx)
        .to.emit(conditionManagerFacet, "DifficultyRangeQuestionCreated")
        .withArgs(
          questionId,
          conditionId,
          targetBlockHeight,
          buckets,
          settlementBlock,
          marketMaker.address
        );
    });

    it("should emit BlockCountQuestionCreated event with timestamps", async () => {
      const currentBlock = await ethers.provider.getBlock("latest");
      const blockTimestamp = currentBlock.timestamp;
      const startTimestamp = blockTimestamp + 1800; // 30 min from now
      const endTimestamp = blockTimestamp + 7200; // 2 hours from now
      const settlementBucket = Math.floor(endTimestamp / 600) * 600; // 10-minute bucket
      const countBuckets = [100, 150, 200];
      const metadata = encodeBlockCount(
        startTimestamp,
        endTimestamp,
        countBuckets
      );

      const [conditionId, questionId] = await conditionManagerFacet
        .connect(marketMaker)
        .callStatic.createConditionWithMetadata(
          QuestionType.BlockCount,
          metadata,
          4, // 3 buckets + 1 = 4 outcomes
          "ipfs://test-blockcount",
          ethers.constants.HashZero
        );

      const tx = await conditionManagerFacet
        .connect(marketMaker)
        .createConditionWithMetadata(
          QuestionType.BlockCount,
          metadata,
          4,
          "ipfs://test-blockcount",
          ethers.constants.HashZero
        );

      await expect(tx)
        .to.emit(conditionManagerFacet, "BlockCountQuestionCreated")
        .withArgs(
          questionId,
          conditionId,
          startTimestamp,
          endTimestamp,
          countBuckets,
          settlementBucket,
          marketMaker.address
        );
    });

    it("should emit MiningDurationQuestionCreated event with duration buckets", async () => {
      const currentHeight = await blockHeaderOracle.getCurrentBlockHeight();
      const startBlockHeight = currentHeight.add ? currentHeight.add(1) : ethers.BigNumber.from(currentHeight).add(1);
      const blockCount = 2;
      const settlementBlock = startBlockHeight.add ? startBlockHeight.add(blockCount + SETTLEMENT_DELAY) : ethers.BigNumber.from(startBlockHeight).add(blockCount + SETTLEMENT_DELAY);
      const durationBuckets = [600, 1200]; // 10, 20 minutes
      const metadata = encodeMiningDuration(
        startBlockHeight,
        blockCount,
        durationBuckets
      );

      const [conditionId, questionId] = await conditionManagerFacet
        .connect(marketMaker)
        .callStatic.createConditionWithMetadata(
          QuestionType.MiningDuration,
          metadata,
          3, // 2 buckets + 1 = 3 outcomes
          "ipfs://test-duration",
          ethers.constants.HashZero
        );

      const tx = await conditionManagerFacet
        .connect(marketMaker)
        .createConditionWithMetadata(
          QuestionType.MiningDuration,
          metadata,
          3,
          "ipfs://test-duration",
          ethers.constants.HashZero
        );

      await expect(tx)
        .to.emit(conditionManagerFacet, "MiningDurationQuestionCreated")
        .withArgs(
          questionId,
          conditionId,
          startBlockHeight,
          blockCount,
          durationBuckets,
          settlementBlock,
          marketMaker.address
        );
    });

    it("should emit both generic and specialized events", async () => {
      const currentHeight = await blockHeaderOracle.getCurrentBlockHeight();
      const targetBlockHeight = currentHeight.add ? currentHeight.add(2) : ethers.BigNumber.from(currentHeight).add(2);
      const settlementBlock = targetBlockHeight.add ? targetBlockHeight.add(SETTLEMENT_DELAY) : ethers.BigNumber.from(targetBlockHeight).add(SETTLEMENT_DELAY);
      const threshold = ethers.utils.parseUnits("50", "gwei");
      const metadata = encodeDifficultyThreshold(threshold, targetBlockHeight);

      const [conditionId, questionId] = await conditionManagerFacet
        .connect(marketMaker)
        .callStatic.createConditionWithMetadata(
          QuestionType.DifficultyThreshold,
          metadata,
          2,
          "ipfs://test-both-events",
          ethers.constants.HashZero
        );

      const tx = await conditionManagerFacet
        .connect(marketMaker)
        .createConditionWithMetadata(
          QuestionType.DifficultyThreshold,
          metadata,
          2,
          "ipfs://test-both-events",
          ethers.constants.HashZero
        );

      // Both events should be emitted
      const receipt = await tx.wait();
      expect(receipt.events.length).to.be.greaterThanOrEqual(3); // At least 3 events: ConditionCreated, QuestionCreated, DifficultyThresholdQuestionCreated

      // Verify generic QuestionCreated
      const genericEvent = receipt.events.find(
        (e) => e.event === "QuestionCreated"
      );
      expect(genericEvent).to.exist;
      expect(genericEvent.args.questionId).to.equal(questionId);
      expect(genericEvent.args.conditionId).to.equal(conditionId);
      expect(genericEvent.args.questionType).to.equal(
        QuestionType.DifficultyThreshold
      );
      expect(genericEvent.args.settlementTrigger).to.equal(settlementBlock);

      // Verify specialized event
      const specializedEvent = receipt.events.find(
        (e) => e.event === "DifficultyThresholdQuestionCreated"
      );
      expect(specializedEvent).to.exist;
      expect(specializedEvent.args.questionId).to.equal(questionId);
      expect(specializedEvent.args.threshold).to.equal(threshold);
      expect(specializedEvent.args.targetBlockHeight).to.equal(targetBlockHeight);
    });
  });

  describe("Condition Queries", function () {
    let testConditionId;
    const testQuestionId = ethers.utils.id("test-query-question");
    const testOutcomeSlotCount = 3;

    beforeEach(async () => {
      testConditionId = getConditionId(
        oracle.address,
        testQuestionId,
        testOutcomeSlotCount
      );
      await conditionManagerFacet
        .connect(marketMaker)
        .createCondition(
          oracle.address,
          testQuestionId,
          testOutcomeSlotCount,
          "ipfs://test-query"
        );
    });

    it("should return correct condition details", async () => {
      const [
        conditionOracle,
        conditionQuestionId,
        conditionOutcomeSlotCount,
        conditionMetadataURI,
      ] = await conditionManagerFacet.getCondition(testConditionId);

      expect(conditionOracle).to.equal(oracle.address);
      expect(conditionQuestionId).to.equal(testQuestionId);
      expect(conditionOutcomeSlotCount).to.equal(testOutcomeSlotCount);
      expect(conditionMetadataURI).to.equal("ipfs://test-query");
    });

    it("should verify condition exists by checking oracle address", async () => {
      // Check if condition exists by verifying oracle is not zero
      const [conditionOracle, , ,] = await conditionManagerFacet.getCondition(
        testConditionId
      );
      expect(conditionOracle).to.not.equal(ethers.constants.AddressZero);
    });

    it("should return empty data for non-existent condition", async () => {
      const nonExistentId = ethers.utils.id("non-existent");
      const [
        conditionOracle,
        conditionQuestionId,
        conditionOutcomeSlotCount,
        conditionMetadataURI,
      ] = await conditionManagerFacet.getCondition(nonExistentId);

      // Non-existent conditions return default values (zero address, zero bytes32, 0, empty string)
      expect(conditionOracle).to.equal(ethers.constants.AddressZero);
      expect(conditionQuestionId).to.equal(ethers.constants.HashZero);
      expect(conditionOutcomeSlotCount).to.equal(0);
      expect(conditionMetadataURI).to.equal("");
    });

    it("should handle condition ID edge cases", async () => {
      // Test with maximum bytes32 value - should return default values
      const maxConditionId = ethers.constants.MaxUint256.toHexString();
      const [oracle1, questionId1, outcomeSlotCount1, metadataURI1] =
        await conditionManagerFacet.getCondition(maxConditionId);
      expect(oracle1).to.equal(ethers.constants.AddressZero);

      // Test with zero condition ID - should return default values
      const [oracle2, questionId2, outcomeSlotCount2, metadataURI2] =
        await conditionManagerFacet.getCondition(ethers.constants.HashZero);
      expect(oracle2).to.equal(ethers.constants.AddressZero);
    });
  });

  describe("Condition Cancellation", function () {
    let testConditionId;
    const testQuestionId = ethers.utils.id("cancellation-test");
    const testOutcomeSlotCount = 2;

    beforeEach(async () => {
      testConditionId = getConditionId(
        oracle.address,
        testQuestionId,
        testOutcomeSlotCount
      );
      await conditionManagerFacet
        .connect(marketMaker)
        .createCondition(
          oracle.address,
          testQuestionId,
          testOutcomeSlotCount,
          "ipfs://cancellation-test"
        );
    });

    it("should allow creator to cancel condition", async () => {
      await expect(
        conditionManagerFacet
          .connect(marketMaker)
          .cancelCondition(testConditionId)
      )
        .to.emit(conditionManagerFacet, "ConditionCancelled")
        .withArgs(testConditionId, marketMaker.address);
    });

    it("should allow owner to cancel any condition", async () => {
      await expect(
        conditionManagerFacet.connect(owner).cancelCondition(testConditionId)
      )
        .to.emit(conditionManagerFacet, "ConditionCancelled")
        .withArgs(testConditionId, owner.address);
    });

    it("should revert if non-creator/non-owner tries to cancel", async () => {
      await expect(
        conditionManagerFacet.connect(user1).cancelCondition(testConditionId)
      ).to.be.revertedWith("NotAuthorizedToCancel()");
    });

    it("should revert when canceling non-existent condition", async () => {
      const nonExistentId = ethers.utils.id("non-existent");
      await expect(
        conditionManagerFacet
          .connect(marketMaker)
          .cancelCondition(nonExistentId)
      ).to.be.revertedWith("ConditionDoesNotExist()");
    });

    it("should revert when canceling already cancelled condition", async () => {
      // First cancellation
      await conditionManagerFacet
        .connect(marketMaker)
        .cancelCondition(testConditionId);

      // Second cancellation attempt
      await expect(
        conditionManagerFacet
          .connect(marketMaker)
          .cancelCondition(testConditionId)
      ).to.be.revertedWith("ConditionAlreadyInactive()");
    });
  });

  describe("Multiple Conditions Management", function () {
    it("should handle multiple conditions from same oracle", async () => {
      const questions = [
        ethers.utils.id("question-1"),
        ethers.utils.id("question-2"),
        ethers.utils.id("question-3"),
      ];
      const outcomeSlotCount = 2;

      const conditionIds = [];
      for (const questionId of questions) {
        const conditionId = getConditionId(
          oracle.address,
          questionId,
          outcomeSlotCount
        );
        conditionIds.push(conditionId);

        await conditionManagerFacet
          .connect(marketMaker)
          .createCondition(
            oracle.address,
            questionId,
            outcomeSlotCount,
            `ipfs://${questionId}`
          );
      }

      // Verify all conditions exist
      for (const conditionId of conditionIds) {
        const [conditionOracle, , ,] = await conditionManagerFacet.getCondition(
          conditionId
        );
        expect(conditionOracle).to.not.equal(ethers.constants.AddressZero);
      }

      // Cancel some conditions
      await conditionManagerFacet
        .connect(marketMaker)
        .cancelCondition(conditionIds[0]);
      await conditionManagerFacet
        .connect(marketMaker)
        .cancelCondition(conditionIds[2]);

      // Verify cancellation doesn't affect other conditions
      const [oracle1, , ,] = await conditionManagerFacet.getCondition(
        conditionIds[1]
      );
      expect(oracle1).to.equal(oracle.address);
    });

    it("should handle conditions from multiple oracles", async () => {
      const questionId = ethers.utils.id("multi-oracle-question");
      const outcomeSlotCount = 2;

      const conditionId1 = getConditionId(
        oracle.address,
        questionId,
        outcomeSlotCount
      );
      const conditionId2 = getConditionId(
        oracle2.address,
        questionId,
        outcomeSlotCount
      );

      // Same question ID but different oracles create different conditions
      await conditionManagerFacet
        .connect(marketMaker)
        .createCondition(
          oracle.address,
          questionId,
          outcomeSlotCount,
          "ipfs://oracle1"
        );

      await conditionManagerFacet
        .connect(marketMaker)
        .createCondition(
          oracle2.address,
          questionId,
          outcomeSlotCount,
          "ipfs://oracle2"
        );

      expect(conditionId1).to.not.equal(conditionId2);

      const [oracle1, , ,] = await conditionManagerFacet.getCondition(
        conditionId1
      );
      const [oracle2Addr, , ,] = await conditionManagerFacet.getCondition(
        conditionId2
      );

      expect(oracle1).to.equal(oracle.address);
      expect(oracle2Addr).to.equal(oracle2.address);
    });
  });

  describe("Edge Cases and Security", function () {
    it("should handle very large outcome slot counts", async () => {
      const questionId = ethers.utils.id("large-outcomes");
      const largeOutcomeCount = 255; // Maximum uint8

      await conditionManagerFacet
        .connect(marketMaker)
        .createCondition(
          oracle.address,
          questionId,
          largeOutcomeCount,
          "ipfs://large-outcomes"
        );

      const conditionId = getConditionId(
        oracle.address,
        questionId,
        largeOutcomeCount
      );
      const [, , conditionOutcomeSlotCount] =
        await conditionManagerFacet.getCondition(conditionId);
      expect(conditionOutcomeSlotCount).to.equal(largeOutcomeCount);
    });

    it("should handle rapid condition creation and cancellation", async () => {
      const numConditions = 10;
      const conditionIds = [];

      // Rapid creation
      for (let i = 0; i < numConditions; i++) {
        const questionId = ethers.utils.id(`rapid-${i}`);
        const conditionId = getConditionId(oracle.address, questionId, 2);
        conditionIds.push({ questionId, conditionId });

        await conditionManagerFacet
          .connect(marketMaker)
          .createCondition(oracle.address, questionId, 2, `ipfs://rapid-${i}`);
      }

      // Rapid cancellation
      for (const { conditionId } of conditionIds) {
        await conditionManagerFacet
          .connect(marketMaker)
          .cancelCondition(conditionId);
      }

      // Verify all are cancelled (should revert when trying to cancel again)
      for (const { conditionId } of conditionIds) {
        await expect(
          conditionManagerFacet
            .connect(marketMaker)
            .cancelCondition(conditionId)
        ).to.be.revertedWith("ConditionAlreadyInactive()");
      }
    });

    it("should maintain data integrity under concurrent operations", async () => {
      const questionIds = [
        ethers.utils.id("concurrent-1"),
        ethers.utils.id("concurrent-2"),
        ethers.utils.id("concurrent-3"),
      ];

      // Create conditions concurrently (simulated)
      const createPromises = questionIds.map((questionId) =>
        conditionManagerFacet
          .connect(marketMaker)
          .createCondition(
            oracle.address,
            questionId,
            2,
            `ipfs://${questionId}`
          )
      );

      await Promise.all(createPromises);

      // Verify all conditions exist and have correct data
      for (const questionId of questionIds) {
        const conditionId = getConditionId(oracle.address, questionId, 2);
        const [
          conditionOracle,
          conditionQuestionId,
          conditionOutcomeSlotCount,
          conditionMetadataURI,
        ] = await conditionManagerFacet.getCondition(conditionId);

        expect(conditionOracle).to.equal(oracle.address);
        expect(conditionQuestionId).to.equal(questionId);
        expect(conditionOutcomeSlotCount).to.equal(2);
        expect(conditionMetadataURI).to.equal(`ipfs://${questionId}`);
      }
    });
  });

  describe("Gas Optimization", function () {
    it("should have consistent gas costs for condition operations", async () => {
      const numConditions = 5;
      const createGasCosts = [];
      const cancelGasCosts = [];

      for (let i = 0; i < numConditions; i++) {
        const questionId = ethers.utils.id(`gas-test-${i}`);
        const conditionId = getConditionId(oracle.address, questionId, 2);

        // Measure creation gas
        const createTx = await conditionManagerFacet
          .connect(marketMaker)
          .createCondition(
            oracle.address,
            questionId,
            2,
            `ipfs://gas-test-${i}`
          );
        const createReceipt = await createTx.wait();
        createGasCosts.push(createReceipt.gasUsed);

        // Measure cancellation gas
        const cancelTx = await conditionManagerFacet
          .connect(marketMaker)
          .cancelCondition(conditionId);
        const cancelReceipt = await cancelTx.wait();
        cancelGasCosts.push(cancelReceipt.gasUsed);
      }

      console.log(
        "Create gas costs:",
        createGasCosts.map((g) => g.toString())
      );
      console.log(
        "Cancel gas costs:",
        cancelGasCosts.map((g) => g.toString())
      );

      // Gas costs should be relatively consistent
      const createGasNumbers = createGasCosts.map((cost) => cost.toNumber());
      const cancelGasNumbers = cancelGasCosts.map((cost) => cost.toNumber());

      const createVariance =
        Math.max(...createGasNumbers) - Math.min(...createGasNumbers);
      const cancelVariance =
        Math.max(...cancelGasNumbers) - Math.min(...cancelGasNumbers);

      const avgCreateGas =
        createGasNumbers.reduce((sum, cost) => sum + cost, 0) /
        createGasNumbers.length;
      const avgCancelGas =
        cancelGasNumbers.reduce((sum, cost) => sum + cost, 0) /
        cancelGasNumbers.length;

      // Variance should be minimal
      expect(createVariance).to.be.lessThan(avgCreateGas / 10); // Less than 10% variance
      expect(cancelVariance).to.be.lessThan(avgCancelGas / 10); // Less than 10% variance
    });
  });
});
