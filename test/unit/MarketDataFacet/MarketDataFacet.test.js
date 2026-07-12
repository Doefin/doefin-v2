const { deployDiamond } = require("../../../scripts/deploy.js");
const { expect } = require("chai");
const { ethers } = require("hardhat");

const { deployMockERC20 } = require("../../mock/deployMocks.js");
const { getConditionId } = require("../../utils/ctfUtils.js");
const { addCollateralToken } = require("../../utils/adminConfigUtils.js");
const { mintAndApproveERC20 } = require("../../utils/erc20Utils.js");
const {
  splitConditionAndGetPositionIds,
} = require("../../utils/conditionUtils.js");
const {
  takeSnapshot,
  revertToSnapshot,
} = require("../../utils/snapshotUtils.js");

describe("MarketDataFacet", function () {
  let owner, oracle, user;
  let diamondAddress,
    marketDataFacet,
    conditionalFacet,
    conditionManagerFacet,
    adminConfig,
    accessControlFacet;
  let erc20, questionId, conditionId, yesId, noId;
  let ercUnit;
  let snapshotId;

  before(async function () {
    [owner, oracle, user] = await ethers.getSigners();

    // Deploy mock ERC20
    erc20 = await deployMockERC20("MockToken", "MOCK");

    // Deploy diamond
    diamondAddress = await deployDiamond();

    // Get facet instances
    marketDataFacet = await ethers.getContractAt(
      "MarketDataFacet",
      diamondAddress
    );
    conditionalFacet = await ethers.getContractAt(
      "ConditionalTokensFacet",
      diamondAddress
    );
    conditionManagerFacet = await ethers.getContractAt(
      "ConditionManagerFacet",
      diamondAddress
    );
    adminConfig = await ethers.getContractAt(
      "AdminConfigFacet",
      diamondAddress
    );
    accessControlFacet = await ethers.getContractAt(
      "AccessControlFacet",
      diamondAddress
    );

    // Setup permissions
    await accessControlFacet.addMarketMaker(owner.address);

    // Add collateral token
    ercUnit = ethers.utils.parseEther("1");
    await addCollateralToken({
      adminConfig: adminConfig,
      token: erc20,
      unit: ercUnit,
      caller: owner,
    });

    // Create condition
    questionId = ethers.utils.id("will-hashrate-increase?");
    const outcomeSlotCount = 2;
    conditionId = getConditionId(oracle.address, questionId, outcomeSlotCount);

    await conditionManagerFacet
      .connect(owner)
      .createCondition(
        oracle.address,
        questionId,
        outcomeSlotCount,
        "ipfs://dummy"
      );

    // Mint and approve ERC20
    const mintAmount = ethers.utils.parseEther("100");
    await mintAndApproveERC20({
      token: erc20,
      minter: owner,
      to: owner,
      amount: mintAmount,
      spender: diamondAddress,
    });

    // Split condition to create position tokens
    const splitAmount = ethers.utils.parseEther("10");
    const [positionIds, _amounts] = await splitConditionAndGetPositionIds({
      user: owner,
      amount: splitAmount,
      conditionId,
      indexSets: [1, 2],
      erc20,
      conditionalFacet,
    });

    yesId = positionIds[0];
    noId = positionIds[1];
  });

  beforeEach(async () => {
    snapshotId = await takeSnapshot();
  });

  afterEach(async () => {
    await revertToSnapshot(snapshotId);
  });

  describe("getMarketsByCondition", function () {
    it("should return market metadata entries for a valid condition", async () => {
      const markets = await marketDataFacet.getMarketsByCondition(conditionId);

      expect(markets).to.have.lengthOf(1);
      const [market] = markets;
      expect(market.collateralToken).to.equal(erc20.address);
      expect(market.parentCollectionId).to.equal(ethers.constants.HashZero);
      expect(market.positionIds).to.have.lengthOf(2);
      expect(market.positionIds[0]).to.equal(yesId);
      expect(market.positionIds[1]).to.equal(noId);
      expect(market.partitions.map((p) => p.toNumber())).to.deep.equal([1, 2]);
    });

    it("should return an empty array for non-existent condition", async () => {
      const invalidConditionId = ethers.utils.id("invalid-condition");

      const markets = await marketDataFacet.getMarketsByCondition(
        invalidConditionId
      );
      expect(markets).to.have.lengthOf(0);
    });
  });

  describe("getMarketMetadata", function () {
    it("should return complete metadata for valid position", async () => {
      const metadata = await marketDataFacet.getMarketMetadata(yesId);

      expect(metadata.collateralToken).to.equal(erc20.address);
      expect(metadata.parentCollectionId).to.equal(ethers.constants.HashZero);
      expect(metadata.positionIds).to.have.lengthOf(2);
      expect(metadata.positionIds[0]).to.equal(yesId);
      expect(metadata.positionIds[1]).to.equal(noId);
      expect(metadata.partitions).to.have.lengthOf(2);
      expect(metadata.partitions[0]).to.equal(1);
      expect(metadata.partitions[1]).to.equal(2);
    });

    it("should revert for invalid position ID", async () => {
      const invalidPositionId = ethers.utils.parseEther("999999");

      await expect(
        marketDataFacet.getMarketMetadata(invalidPositionId)
      ).to.be.revertedWith("InvalidPositionId");
    });

    it("should return same metadata for both positions in same condition", async () => {
      const yesMetadata = await marketDataFacet.getMarketMetadata(yesId);
      const noMetadata = await marketDataFacet.getMarketMetadata(noId);

      expect(yesMetadata.collateralToken).to.equal(noMetadata.collateralToken);
      expect(yesMetadata.parentCollectionId).to.equal(
        noMetadata.parentCollectionId
      );
      expect(yesMetadata.positionIds.length).to.equal(
        noMetadata.positionIds.length
      );
      expect(yesMetadata.partitions.length).to.equal(
        noMetadata.partitions.length
      );
    });
  });

  describe("getMarketMetadataByMarket", function () {
    it("should return metadata for a market key", async () => {
      const metadata = await marketDataFacet.getMarketMetadataByMarket(
        conditionId,
        ethers.constants.HashZero,
        erc20.address
      );

      expect(metadata.collateralToken).to.equal(erc20.address);
      expect(metadata.parentCollectionId).to.equal(ethers.constants.HashZero);
      expect(metadata.positionIds).to.have.lengthOf(2);
      expect(metadata.partitions).to.have.lengthOf(2);
    });

    it("should return same data as getMarketMetadata", async () => {
      const metadataByMarket = await marketDataFacet.getMarketMetadataByMarket(
        conditionId,
        ethers.constants.HashZero,
        erc20.address
      );
      const metadataByPosition = await marketDataFacet.getMarketMetadata(yesId);

      expect(metadataByMarket.collateralToken).to.equal(
        metadataByPosition.collateralToken
      );
      expect(metadataByMarket.parentCollectionId).to.equal(
        metadataByPosition.parentCollectionId
      );
      expect(metadataByMarket.positionIds.length).to.equal(
        metadataByPosition.positionIds.length
      );
      expect(metadataByMarket.partitions.length).to.equal(
        metadataByPosition.partitions.length
      );
    });

    it("should revert for non-existent market", async () => {
      const invalidConditionId = ethers.utils.id("invalid-condition");

      await expect(
        marketDataFacet.getMarketMetadataByMarket(
          invalidConditionId,
          ethers.constants.HashZero,
          erc20.address
        )
      ).to.be.revertedWith("ConditionDoesNotExist()");
    });
  });

  describe("getCollateralToken", function () {
    it("should return correct collateral token for position", async () => {
      const collateralToken = await marketDataFacet.getCollateralToken(yesId);
      expect(collateralToken).to.equal(erc20.address);
    });

    it("should return same collateral token for both positions", async () => {
      const yesCollateral = await marketDataFacet.getCollateralToken(yesId);
      const noCollateral = await marketDataFacet.getCollateralToken(noId);
      expect(yesCollateral).to.equal(noCollateral);
    });

    it("should revert for invalid position ID", async () => {
      const invalidPositionId = ethers.utils.parseEther("999999");

      await expect(
        marketDataFacet.getCollateralToken(invalidPositionId)
      ).to.be.revertedWith("InvalidPositionId");
    });
  });

  describe("getCollateralUnit", function () {
    it("should return correct unit for position", async () => {
      const unit = await marketDataFacet.getCollateralUnit(yesId);
      expect(unit).to.equal(ercUnit);
    });

    it("should return same unit for both positions", async () => {
      const yesUnit = await marketDataFacet.getCollateralUnit(yesId);
      const noUnit = await marketDataFacet.getCollateralUnit(noId);
      expect(yesUnit).to.equal(noUnit);
    });

    it("should revert for invalid position ID", async () => {
      const invalidPositionId = ethers.utils.parseEther("999999");

      await expect(
        marketDataFacet.getCollateralUnit(invalidPositionId)
      ).to.be.revertedWith("InvalidPositionId");
    });
  });

  describe("getConditionId", function () {
    it("should return correct condition ID for position", async () => {
      const returnedConditionId = await marketDataFacet.getConditionId(yesId);
      expect(returnedConditionId).to.equal(conditionId);
    });

    it("should return same condition ID for both positions", async () => {
      const yesConditionId = await marketDataFacet.getConditionId(yesId);
      const noConditionId = await marketDataFacet.getConditionId(noId);
      expect(yesConditionId).to.equal(noConditionId);
    });

    it("should revert for invalid position ID", async () => {
      const invalidPositionId = ethers.utils.parseEther("999999");

      await expect(
        marketDataFacet.getConditionId(invalidPositionId)
      ).to.be.revertedWith("InvalidPositionId");
    });
  });

  describe("getComplement", function () {
    it("should return correct complement for YES position", async () => {
      const complement = await marketDataFacet.getComplement(yesId);
      expect(complement).to.equal(noId);
    });

    it("should return correct complement for NO position", async () => {
      const complement = await marketDataFacet.getComplement(noId);
      expect(complement).to.equal(yesId);
    });

    it("should be symmetric (complement of complement is original)", async () => {
      const yesComplement = await marketDataFacet.getComplement(yesId);
      const complementOfComplement = await marketDataFacet.getComplement(
        yesComplement
      );
      expect(complementOfComplement).to.equal(yesId);
    });

    it("should revert for invalid position ID", async () => {
      const invalidPositionId = ethers.utils.parseEther("999999");

      await expect(
        marketDataFacet.getComplement(invalidPositionId)
      ).to.be.revertedWith("InvalidPositionId");
    });
  });

  describe("getPositionInfo", function () {
    it("should return all position information in one call", async () => {
      const [
        returnedConditionId,
        collateralToken,
        unit,
        complementId,
        metadata,
      ] = await marketDataFacet.getPositionInfo(yesId);

      expect(returnedConditionId).to.equal(conditionId);
      expect(collateralToken).to.equal(erc20.address);
      expect(unit).to.equal(ercUnit);
      expect(complementId).to.equal(noId);
      expect(metadata.collateralToken).to.equal(erc20.address);
      expect(metadata.positionIds).to.have.lengthOf(2);
    });

    it("should be consistent with individual function calls", async () => {
      const [
        returnedConditionId,
        collateralToken,
        unit,
        complementId,
        metadata,
      ] = await marketDataFacet.getPositionInfo(yesId);

      // Compare with individual calls
      const individualConditionId = await marketDataFacet.getConditionId(yesId);
      const individualCollateralToken =
        await marketDataFacet.getCollateralToken(yesId);
      const individualUnit = await marketDataFacet.getCollateralUnit(yesId);
      const individualComplement = await marketDataFacet.getComplement(yesId);
      const individualMetadata = await marketDataFacet.getMarketMetadata(yesId);

      expect(returnedConditionId).to.equal(individualConditionId);
      expect(collateralToken).to.equal(individualCollateralToken);
      expect(unit).to.equal(individualUnit);
      expect(complementId).to.equal(individualComplement);
      expect(metadata.collateralToken).to.equal(
        individualMetadata.collateralToken
      );
    });

    it("should revert for invalid position ID", async () => {
      const invalidPositionId = ethers.utils.parseEther("999999");

      await expect(
        marketDataFacet.getPositionInfo(invalidPositionId)
      ).to.be.revertedWith("InvalidPositionId");
    });
  });

  describe("Integration with multiple conditions", function () {
    let secondConditionId, secondYesId, secondNoId;

    beforeEach(async () => {
      // Create second condition
      const questionId2 = ethers.utils.id("second-question");
      secondConditionId = getConditionId(oracle.address, questionId2, 2);

      await conditionManagerFacet
        .connect(owner)
        .createCondition(oracle.address, questionId2, 2, "ipfs://second-dummy");

      // Split second condition
      const [positionIds2, _] = await splitConditionAndGetPositionIds({
        user: owner,
        amount: ethers.utils.parseEther("5"),
        conditionId: secondConditionId,
        indexSets: [1, 2],
        erc20,
        conditionalFacet,
      });

      secondYesId = positionIds2[0];
      secondNoId = positionIds2[1];
    });

    it("should handle multiple conditions correctly", async () => {
      // Test both conditions
      const markets1 = await marketDataFacet.getMarketsByCondition(conditionId);
      const markets2 = await marketDataFacet.getMarketsByCondition(
        secondConditionId
      );

      expect(markets1).to.have.lengthOf(1);
      expect(markets2).to.have.lengthOf(1);
      expect(markets1[0].positionIds.map((p) => p.toString())).to.include.members([
        yesId.toString(),
        noId.toString(),
      ]);
      expect(markets2[0].positionIds.map((p) => p.toString())).to.include.members([
        secondYesId.toString(),
        secondNoId.toString(),
      ]);
      expect(markets1[0].positionIds[0]).to.not.equal(
        markets2[0].positionIds[0]
      );
    });

    it("should return correct condition IDs for different positions", async () => {
      const condition1 = await marketDataFacet.getConditionId(yesId);
      const condition2 = await marketDataFacet.getConditionId(secondYesId);

      expect(condition1).to.equal(conditionId);
      expect(condition2).to.equal(secondConditionId);
      expect(condition1).to.not.equal(condition2);
    });

    it("should return correct complements within same condition only", async () => {
      const yesComplement = await marketDataFacet.getComplement(yesId);
      const secondYesComplement = await marketDataFacet.getComplement(
        secondYesId
      );

      expect(yesComplement).to.equal(noId);
      expect(secondYesComplement).to.equal(secondNoId);
      expect(yesComplement).to.not.equal(secondYesComplement);
    });
  });
});
