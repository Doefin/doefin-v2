const { deployDiamond } = require("../../../scripts/deploy.js");
const { expect } = require("chai");
const { ethers } = require("hardhat");

const {
  getConditionId,
  getCollectionId,
  getPositionId,
} = require("../../utils/ctfUtils.js");
const {
  createAndSplitCondition,
} = require("../../utils/conditionUtils.js");
const {
  takeSnapshot,
  revertToSnapshot,
} = require("../../utils/snapshotUtils.js");
const { deployMockERC20 } = require("../../mock/deployMocks");

describe("ConditionalTokensFacet Advanced", function () {
  let owner, oracle, oracle2, user1, user2, marketMaker;
  let diamondAddress,
    conditionalTokensFacet,
    conditionManagerFacet,
    accessControlFacet,
    adminConfigFacet,
    erc1155Facet;
  let mockToken, mockToken2;
  let snapshotId;

  before(async function () {
    [owner, oracle, oracle2, user1, user2, marketMaker] =
      await ethers.getSigners();

    // Deploy mock tokens
    mockToken = await deployMockERC20("MockToken", "MOCK");
    mockToken2 = await deployMockERC20("MockToken2", "MOCK2");

    diamondAddress = await deployDiamond();
    conditionalTokensFacet = await ethers.getContractAt(
      "ConditionalTokensFacet",
      diamondAddress
    );
    conditionManagerFacet = await ethers.getContractAt(
      "ConditionManagerFacet",
      diamondAddress
    );
    accessControlFacet = await ethers.getContractAt(
      "AccessControlFacet",
      diamondAddress
    );
    adminConfigFacet = await ethers.getContractAt(
      "AdminConfigFacet",
      diamondAddress
    );
    erc1155Facet = await ethers.getContractAt("ERC1155Facet", diamondAddress);

    // Setup collateral tokens
    await adminConfigFacet
      .connect(owner)
      .addCollateralToken(mockToken.address, ethers.utils.parseEther("1"));
    await adminConfigFacet
      .connect(owner)
      .addCollateralToken(mockToken2.address, ethers.utils.parseEther("0.1"));

    // Add market maker
    await accessControlFacet.connect(owner).addMarketMaker(marketMaker.address);
    await accessControlFacet.connect(owner).addMarketMaker(owner.address);
    await accessControlFacet.connect(owner).addMarketMaker(user1.address);

    // Mint tokens to users
    const mintAmount = ethers.utils.parseEther("1000");
    await mockToken.mint(user1.address, mintAmount);
    await mockToken.mint(user2.address, mintAmount);
    await mockToken.mint(marketMaker.address, mintAmount);
    await mockToken2.mint(user1.address, mintAmount);
    await mockToken2.mint(user2.address, mintAmount);
  });

  beforeEach(async () => {
    snapshotId = await takeSnapshot();
  });

  afterEach(async () => {
    await revertToSnapshot(snapshotId);
  });

  describe("Condition Preparation", function () {
    it("should prepare condition with owner authorization", async () => {
      const questionId = ethers.utils.id("owner-prep-test");
      const outcomeSlotCount = 2;
      const expectedConditionId = getConditionId(
        oracle.address,
        questionId,
        outcomeSlotCount
      );

      await expect(
        conditionalTokensFacet
          .connect(owner)
          .prepareCondition(oracle.address, questionId, outcomeSlotCount)
      )
        .to.emit(conditionalTokensFacet, "ConditionPreparation")
        .withArgs(
          expectedConditionId,
          oracle.address,
          questionId,
          outcomeSlotCount
        );
    });

    it("should revert if non-owner tries to prepare condition", async () => {
      const questionId = ethers.utils.id("unauthorized-prep");
      const outcomeSlotCount = 2;

      // SCRUM-230 / ARCH-02: prepareCondition's owner gate was standardized onto
      // LibDiamond.enforceIsContractOwner — revert is now NotContractOwner.
      await expect(
        conditionalTokensFacet
          .connect(user1)
          .prepareCondition(oracle.address, questionId, outcomeSlotCount)
      ).to.be.revertedWith("NotContractOwner()");
    });

    it("should handle multiple outcome slots", async () => {
      const questionId = ethers.utils.id("multi-outcome-prep");
      const outcomeSlotCount = 5;
      const expectedConditionId = getConditionId(
        oracle.address,
        questionId,
        outcomeSlotCount
      );

      await expect(
        conditionalTokensFacet
          .connect(owner)
          .prepareCondition(oracle.address, questionId, outcomeSlotCount)
      )
        .to.emit(conditionalTokensFacet, "ConditionPreparation")
        .withArgs(
          expectedConditionId,
          oracle.address,
          questionId,
          outcomeSlotCount
        );
    });
  });

  describe("Payout Reporting", function () {
    let testConditionId;
    const testQuestionId = ethers.utils.id("payout-test");
    const testOutcomeSlotCount = 3;

    beforeEach(async () => {
      testConditionId = getConditionId(
        oracle.address,
        testQuestionId,
        testOutcomeSlotCount
      );
      await conditionalTokensFacet
        .connect(owner)
        .prepareCondition(oracle.address, testQuestionId, testOutcomeSlotCount);
    });

    it("should report payouts with valid data", async () => {
      const payouts = [1, 0, 0]; // First outcome wins

      await expect(
        conditionalTokensFacet
          .connect(oracle)
          .reportPayouts(testQuestionId, payouts)
      )
        .to.emit(conditionalTokensFacet, "ConditionResolution")
        .withArgs(
          testConditionId,
          oracle.address,
          testQuestionId,
          testOutcomeSlotCount,
          payouts
        );

      // Verify payouts are stored
      const storedPayouts = await conditionalTokensFacet.getPayoutNumerators(
        testConditionId
      );
      expect(storedPayouts.map((p) => p.toNumber())).to.deep.equal(payouts);
    });

    it("should report partial payouts", async () => {
      const payouts = [3, 2, 5]; // Proportional payouts

      await conditionalTokensFacet
        .connect(oracle)
        .reportPayouts(testQuestionId, payouts);

      const storedPayouts = await conditionalTokensFacet.getPayoutNumerators(
        testConditionId
      );
      expect(storedPayouts.map((p) => p.toNumber())).to.deep.equal(payouts);
    });

    it("should revert with empty payouts array", async () => {
      await expect(
        conditionalTokensFacet.connect(oracle).reportPayouts(testQuestionId, [])
      ).to.be.revertedWith("InvalidPayoutLength()");
    });

    it("should revert with too many payouts", async () => {
      const tooManyPayouts = new Array(256).fill(1); // More than uint8 max

      await expect(
        conditionalTokensFacet
          .connect(oracle)
          .reportPayouts(testQuestionId, tooManyPayouts)
      ).to.be.revertedWith("InvalidPayoutLength()");
    });

    it("should revert if condition not prepared", async () => {
      const unpreparedQuestionId = ethers.utils.id("unprepared");
      const payouts = [1, 0];

      await expect(
        conditionalTokensFacet
          .connect(oracle)
          .reportPayouts(unpreparedQuestionId, payouts)
      ).to.be.revertedWith("ConditionNotPrepared()");
    });

    it("should revert if already resolved", async () => {
      const payouts = [1, 0, 0];

      // First resolution
      await conditionalTokensFacet
        .connect(oracle)
        .reportPayouts(testQuestionId, payouts);

      // Second resolution attempt
      await expect(
        conditionalTokensFacet
          .connect(oracle)
          .reportPayouts(testQuestionId, payouts)
      ).to.be.revertedWith("ConditionAlreadyResolved()");
    });

    it("should revert with all zero payouts", async () => {
      const zeroPayouts = [0, 0, 0];

      await expect(
        conditionalTokensFacet
          .connect(oracle)
          .reportPayouts(testQuestionId, zeroPayouts)
      ).to.be.revertedWith("AllZeroPayouts()");
    });

    it("should handle maximum payout values", async () => {
      const maxPayouts = [
        ethers.constants.MaxUint256,
        ethers.constants.Zero,
        ethers.constants.Zero,
      ];

      await conditionalTokensFacet
        .connect(oracle)
        .reportPayouts(testQuestionId, maxPayouts);

      const storedPayouts = await conditionalTokensFacet.getPayoutNumerators(
        testConditionId
      );
      expect(storedPayouts[0]).to.equal(ethers.constants.MaxUint256);
    });
  });

  describe("Position Splitting", function () {
    let testConditionId;
    const testQuestionId = ethers.utils.id("split-test");
    const testOutcomeSlotCount = 2;

    beforeEach(async () => {
      testConditionId = getConditionId(
        oracle.address,
        testQuestionId,
        testOutcomeSlotCount
      );
      await conditionalTokensFacet
        .connect(owner)
        .prepareCondition(oracle.address, testQuestionId, testOutcomeSlotCount);

      // Approve tokens for splitting
      await mockToken
        .connect(user1)
        .approve(diamondAddress, ethers.utils.parseEther("100"));
    });

    it("should split position into conditional tokens", async () => {
      const amount = ethers.utils.parseEther("10");
      const partition = [1, 2]; // YES and NO positions

      await expect(
        conditionalTokensFacet
          .connect(user1)
          .splitPosition(
            mockToken.address,
            ethers.constants.HashZero,
            testConditionId,
            partition,
            amount
          )
      )
        .to.emit(conditionalTokensFacet, "PositionSplit")
        .withArgs(
          user1.address,
          mockToken.address,
          ethers.constants.HashZero,
          testConditionId,
          partition,
          amount
        );

      // Verify conditional tokens were minted
      const yesCollectionId = await getCollectionId(
        ethers.constants.HashZero,
        testConditionId,
        1,
        ethers.provider
      );
      const noCollectionId = await getCollectionId(
        ethers.constants.HashZero,
        testConditionId,
        2,
        ethers.provider
      );
      const yesPositionId = getPositionId(mockToken.address, yesCollectionId);
      const noPositionId = getPositionId(mockToken.address, noCollectionId);

      expect(
        await erc1155Facet.balanceOf(user1.address, yesPositionId)
      ).to.equal(amount);
      expect(
        await erc1155Facet.balanceOf(user1.address, noPositionId)
      ).to.equal(amount);
    });

    it("should split position with multiple outcomes", async () => {
      const multiOutcomeQuestionId = ethers.utils.id("multi-split-test");
      const multiOutcomeSlotCount = 4;
      const multiConditionId = getConditionId(
        oracle.address,
        multiOutcomeQuestionId,
        multiOutcomeSlotCount
      );

      await conditionalTokensFacet
        .connect(owner)
        .prepareCondition(
          oracle.address,
          multiOutcomeQuestionId,
          multiOutcomeSlotCount
        );

      const amount = ethers.utils.parseEther("5");
      const partition = [1, 2, 4, 8]; // All four outcomes

      await expect(
        conditionalTokensFacet
          .connect(user1)
          .splitPosition(
            mockToken.address,
            ethers.constants.HashZero,
            multiConditionId,
            partition,
            amount
          )
      ).to.emit(conditionalTokensFacet, "PositionSplit");

      // Verify all positions were created
      for (let i = 0; i < partition.length; i++) {
        const collectionId = await getCollectionId(
          ethers.constants.HashZero,
          multiConditionId,
          partition[i],
          ethers.provider
        );
        const positionId = getPositionId(mockToken.address, collectionId);
        expect(
          await erc1155Facet.balanceOf(user1.address, positionId)
        ).to.equal(amount);
      }
    });

    it("should handle nested position splitting", async () => {
      const parentQuestionId = ethers.utils.id("parent-condition");
      const childQuestionId = ethers.utils.id("child-condition");
      const outcomeSlotCount = 2;

      const parentConditionId = getConditionId(
        oracle.address,
        parentQuestionId,
        outcomeSlotCount
      );
      const childConditionId = getConditionId(
        oracle2.address,
        childQuestionId,
        outcomeSlotCount
      );

      // Prepare both conditions
      await conditionalTokensFacet
        .connect(owner)
        .prepareCondition(oracle.address, parentQuestionId, outcomeSlotCount);
      await conditionalTokensFacet
        .connect(owner)
        .prepareCondition(oracle2.address, childQuestionId, outcomeSlotCount);

      const amount = ethers.utils.parseEther("8");

      // First split on parent condition
      await conditionalTokensFacet
        .connect(user1)
        .splitPosition(
          mockToken.address,
          ethers.constants.HashZero,
          parentConditionId,
          [1, 2],
          amount
        );

      // Get parent collection ID for YES outcome
      const parentCollectionId = await getCollectionId(
        ethers.constants.HashZero,
        parentConditionId,
        1,
        ethers.provider
      );

      // Split the YES position further on child condition
      await expect(
        conditionalTokensFacet
          .connect(user1)
          .splitPosition(
            mockToken.address,
            parentCollectionId,
            childConditionId,
            [1, 2],
            amount
          )
      )
        .to.emit(conditionalTokensFacet, "PositionSplit")
        .withArgs(
          user1.address,
          mockToken.address,
          parentCollectionId,
          childConditionId,
          [1, 2],
          amount
        );
    });
  });

  describe("Position Merging", function () {
    let testConditionId;
    const testQuestionId = ethers.utils.id("merge-test");
    const testOutcomeSlotCount = 2;

    beforeEach(async () => {
      const amount = ethers.utils.parseEther("10");
      await mockToken.connect(user1).approve(diamondAddress, amount);

      const { conditionId } = await createAndSplitCondition({
        conditionManagerFacet,
        conditionalFacet: conditionalTokensFacet,
        oracle,
        owner,
        splitter: user1,
        erc20: mockToken,
        questionId: testQuestionId,
        outcomeSlotCount: testOutcomeSlotCount,
        splitAmount: amount,
        partition: [1, 2],
      });

      testConditionId = conditionId;
    });

    it("should merge positions back to collateral", async () => {
      const amount = ethers.utils.parseEther("10");
      const partition = [1, 2];

      const initialBalance = await mockToken.balanceOf(user1.address);

      await expect(
        conditionalTokensFacet
          .connect(user1)
          .mergePositions(
            mockToken.address,
            ethers.constants.HashZero,
            testConditionId,
            partition,
            amount
          )
      )
        .to.emit(conditionalTokensFacet, "PositionsMerge")
        .withArgs(
          user1.address,
          mockToken.address,
          ethers.constants.HashZero,
          testConditionId,
          partition,
          amount
        );

      // Verify collateral was returned
      const finalBalance = await mockToken.balanceOf(user1.address);
      expect(finalBalance.sub(initialBalance)).to.equal(amount);

      // Verify conditional tokens were burned
      const yesCollectionId = await getCollectionId(
        ethers.constants.HashZero,
        testConditionId,
        1,
        ethers.provider
      );
      const noCollectionId = await getCollectionId(
        ethers.constants.HashZero,
        testConditionId,
        2,
        ethers.provider
      );
      const yesPositionId = getPositionId(mockToken.address, yesCollectionId);
      const noPositionId = getPositionId(mockToken.address, noCollectionId);

      expect(
        await erc1155Facet.balanceOf(user1.address, yesPositionId)
      ).to.equal(0);
      expect(
        await erc1155Facet.balanceOf(user1.address, noPositionId)
      ).to.equal(0);
    });

    it("should merge partial amounts", async () => {
      const mergeAmount = ethers.utils.parseEther("5");
      const partition = [1, 2];

      await conditionalTokensFacet
        .connect(user1)
        .mergePositions(
          mockToken.address,
          ethers.constants.HashZero,
          testConditionId,
          partition,
          mergeAmount
        );

      // Verify partial amounts remain
      const yesCollectionId = await getCollectionId(
        ethers.constants.HashZero,
        testConditionId,
        1,
        ethers.provider
      );
      const noCollectionId = await getCollectionId(
        ethers.constants.HashZero,
        testConditionId,
        2,
        ethers.provider
      );
      const yesPositionId = getPositionId(mockToken.address, yesCollectionId);
      const noPositionId = getPositionId(mockToken.address, noCollectionId);

      expect(
        await erc1155Facet.balanceOf(user1.address, yesPositionId)
      ).to.equal(mergeAmount);
      expect(
        await erc1155Facet.balanceOf(user1.address, noPositionId)
      ).to.equal(mergeAmount);
    });
  });

  describe("Position Redemption", function () {
    let testConditionId;
    const testQuestionId = ethers.utils.id("redemption-test");
    const testOutcomeSlotCount = 2;

    beforeEach(async () => {
      const amount = ethers.utils.parseEther("10");
      await mockToken.connect(user1).approve(diamondAddress, amount);

      const { conditionId } = await createAndSplitCondition({
        conditionManagerFacet,
        conditionalFacet: conditionalTokensFacet,
        oracle,
        owner,
        splitter: user1,
        erc20: mockToken,
        questionId: testQuestionId,
        outcomeSlotCount: testOutcomeSlotCount,
        splitAmount: amount,
        partition: [1, 2],
      });

      testConditionId = conditionId;

      // Resolve condition (YES wins)
      await conditionalTokensFacet
        .connect(oracle)
        .reportPayouts(testQuestionId, [1, 0]);
    });

    it("should redeem winning positions", async () => {
      const indexSets = [1]; // YES position
      const initialBalance = await mockToken.balanceOf(user1.address);

      await expect(
        conditionalTokensFacet
          .connect(user1)
          .redeemPositions(
            mockToken.address,
            ethers.constants.HashZero,
            testConditionId,
            indexSets
          )
      ).to.emit(conditionalTokensFacet, "PayoutRedemption");

      // Verify payout received (minus fees)
      const finalBalance = await mockToken.balanceOf(user1.address);
      expect(finalBalance).to.be.gt(initialBalance);
    });

    it("should handle losing positions with zero payout", async () => {
      const indexSets = [2]; // NO position (losing)
      const initialBalance = await mockToken.balanceOf(user1.address);

      await conditionalTokensFacet
        .connect(user1)
        .redeemPositions(
          mockToken.address,
          ethers.constants.HashZero,
          testConditionId,
          indexSets
        );

      // Balance should remain the same (no payout for losing position)
      const finalBalance = await mockToken.balanceOf(user1.address);
      expect(finalBalance).to.equal(initialBalance);
    });

    it("should revert if condition not resolved", async () => {
      const unresolvedQuestionId = ethers.utils.id("unresolved-test");
      const unresolvedConditionId = getConditionId(
        oracle.address,
        unresolvedQuestionId,
        2
      );

      await conditionalTokensFacet
        .connect(owner)
        .prepareCondition(oracle.address, unresolvedQuestionId, 2);

      await expect(
        conditionalTokensFacet
          .connect(user1)
          .redeemPositions(
            mockToken.address,
            ethers.constants.HashZero,
            unresolvedConditionId,
            [1]
          )
      ).to.be.revertedWith("ConditionNotResolved()");
    });

    it("should handle fee deduction correctly", async () => {
      const [, resolutionFeeBps] = await adminConfigFacet.getFees();
      const indexSets = [1]; // YES position
      const expectedPayout = ethers.utils.parseEther("10");
      const expectedFee = expectedPayout.mul(resolutionFeeBps).div(10000);
      const expectedNet = expectedPayout.sub(expectedFee);

      const initialUserBalance = await mockToken.balanceOf(user1.address);
      // SCRUM-236: the resolution fee now accrues into the in-Diamond bank
      // instead of moving to feeReceiver per-trade. PayoutRedemptionFeePaid
      // is still emitted for off-chain redemption analytics; we ALSO assert
      // FeeAccrued(token, fee, FEE_KIND_RESOLUTION) and the accruedFees ratchet.
      const initialAccrued = await adminConfigFacet.getAccruedFees(mockToken.address);

      const tx = conditionalTokensFacet
        .connect(user1)
        .redeemPositions(
          mockToken.address,
          ethers.constants.HashZero,
          testConditionId,
          indexSets
        );

      await expect(tx).to.emit(conditionalTokensFacet, "PayoutRedemptionFeePaid");
      // FEE_KIND_RESOLUTION = 1 (LibConstants.FEE_KIND_RESOLUTION).
      await expect(tx)
        .to.emit(conditionalTokensFacet, "FeeAccrued")
        .withArgs(mockToken.address, expectedFee, 1);

      const finalUserBalance = await mockToken.balanceOf(user1.address);
      const finalAccrued = await adminConfigFacet.getAccruedFees(mockToken.address);

      expect(finalUserBalance.sub(initialUserBalance)).to.equal(expectedNet);
      expect(finalAccrued.sub(initialAccrued)).to.equal(expectedFee);
    });

    it("should handle redemption with invalid index sets", async () => {
      const invalidIndexSets = [0]; // Invalid index set

      await expect(
        conditionalTokensFacet
          .connect(user1)
          .redeemPositions(
            mockToken.address,
            ethers.constants.HashZero,
            testConditionId,
            invalidIndexSets
          )
      ).to.be.revertedWith("InvalidIndexSet()");
    });
  });

  describe("Utility Functions", function () {
    it("should return correct condition ID", async () => {
      const questionId = ethers.utils.id("utility-test");
      const outcomeSlotCount = 3;
      const expectedConditionId = getConditionId(
        oracle.address,
        questionId,
        outcomeSlotCount
      );

      const contractConditionId = await conditionalTokensFacet.getConditionId(
        oracle.address,
        questionId,
        outcomeSlotCount
      );

      expect(contractConditionId).to.equal(expectedConditionId);
    });

    it("should return correct collection ID", async () => {
      const parentCollectionId = ethers.constants.HashZero;
      const conditionId = ethers.utils.id("test-condition");
      const indexSet = 5;

      const expectedCollectionId = await getCollectionId(
        parentCollectionId,
        conditionId,
        indexSet,
        ethers.provider
      );
      const contractCollectionId = await conditionalTokensFacet.getCollectionId(
        parentCollectionId,
        conditionId,
        indexSet
      );

      expect(contractCollectionId).to.equal(expectedCollectionId);
    });

    it("should return correct position ID", async () => {
      const collectionId = ethers.utils.id("test-collection");
      const expectedPositionId = getPositionId(mockToken.address, collectionId);

      const contractPositionId = await conditionalTokensFacet.getPositionId(
        mockToken.address,
        collectionId
      );

      expect(contractPositionId).to.equal(expectedPositionId);
    });
  });

  describe("Complex Scenarios", function () {
    it("should handle full lifecycle with multiple users", async () => {
      const questionId = ethers.utils.id("lifecycle-test");
      const outcomeSlotCount = 3;
      const conditionId = getConditionId(
        oracle.address,
        questionId,
        outcomeSlotCount
      );

      // Prepare condition
      await conditionalTokensFacet
        .connect(owner)
        .prepareCondition(oracle.address, questionId, outcomeSlotCount);

      // Multiple users split positions
      const amount = ethers.utils.parseEther("20");
      await mockToken.connect(user1).approve(diamondAddress, amount);
      await mockToken.connect(user2).approve(diamondAddress, amount);

      await conditionalTokensFacet
        .connect(user1)
        .splitPosition(
          mockToken.address,
          ethers.constants.HashZero,
          conditionId,
          [1, 2, 4],
          amount
        );

      await conditionalTokensFacet
        .connect(user2)
        .splitPosition(
          mockToken.address,
          ethers.constants.HashZero,
          conditionId,
          [1, 2, 4],
          amount
        );

      // Resolve condition (outcome 2 wins)
      await conditionalTokensFacet
        .connect(oracle)
        .reportPayouts(questionId, [0, 1, 0]);

      // Both users redeem winning positions
      await conditionalTokensFacet
        .connect(user1)
        .redeemPositions(
          mockToken.address,
          ethers.constants.HashZero,
          conditionId,
          [2]
        );

      await conditionalTokensFacet
        .connect(user2)
        .redeemPositions(
          mockToken.address,
          ethers.constants.HashZero,
          conditionId,
          [2]
        );

      // Verify both received payouts
      const collectionId = await getCollectionId(
        ethers.constants.HashZero,
        conditionId,
        2,
        ethers.provider
      );
      const positionId = getPositionId(mockToken.address, collectionId);

      expect(await erc1155Facet.balanceOf(user1.address, positionId)).to.equal(
        0
      );
      expect(await erc1155Facet.balanceOf(user2.address, positionId)).to.equal(
        0
      );
    });

    it("should handle cross-collateral operations", async () => {
      const questionId = ethers.utils.id("cross-collateral-test");
      const outcomeSlotCount = 2;
      const conditionId = getConditionId(
        oracle.address,
        questionId,
        outcomeSlotCount
      );

      await conditionalTokensFacet
        .connect(owner)
        .prepareCondition(oracle.address, questionId, outcomeSlotCount);

      // Split with different collateral tokens
      const amount1 = ethers.utils.parseEther("10");
      const amount2 = ethers.utils.parseEther("50"); // Different unit size

      await mockToken.connect(user1).approve(diamondAddress, amount1);
      await mockToken2.connect(user1).approve(diamondAddress, amount2);

      await conditionalTokensFacet
        .connect(user1)
        .splitPosition(
          mockToken.address,
          ethers.constants.HashZero,
          conditionId,
          [1, 2],
          amount1
        );

      await conditionalTokensFacet
        .connect(user1)
        .splitPosition(
          mockToken2.address,
          ethers.constants.HashZero,
          conditionId,
          [1, 2],
          amount2
        );

      // Verify different position IDs for different collaterals
      const collection1 = await getCollectionId(
        ethers.constants.HashZero,
        conditionId,
        1,
        ethers.provider
      );
      const position1Token1 = getPositionId(mockToken.address, collection1);
      const position1Token2 = getPositionId(mockToken2.address, collection1);

      expect(position1Token1).to.not.equal(position1Token2);
      expect(
        await erc1155Facet.balanceOf(user1.address, position1Token1)
      ).to.equal(amount1);
      expect(
        await erc1155Facet.balanceOf(user1.address, position1Token2)
      ).to.equal(amount2);
    });
  });
});
