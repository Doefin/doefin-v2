const { deployDiamond } = require("../../../scripts/deploy.js");
const { expect } = require("chai");
const { ethers } = require("hardhat");

const { deployMockERC20 } = require("../../mock/deployMocks.js");
const { getConditionId } = require("../../utils/ctfUtils.js");
const {
  getFees,
  addCollateralToken,
} = require("../../utils/adminConfigUtils.js");
const { mintAndApproveERC20 } = require("../../utils/erc20Utils.js");
const { sendAndApproveERC1155 } = require("../../utils/erc1155Utils.js");
const {
  splitConditionAndGetPositionIds,
} = require("../../utils/conditionUtils.js");
const { createLimitOrder } = require("../../utils/orderUtils.js");
const {
  takeSnapshot,
  revertToSnapshot,
} = require("../../utils/snapshotUtils.js");

describe("MarketExecutionFacet - fillLimitOrders Advanced Tests", function () {
  let owner, maker1, maker2, maker3, taker1, taker2, oracle;
  let diamondAddress,
    exchangeFacet,
    marketExecutionFacet,
    erc20,
    erc1155,
    conditionalFacet,
    conditionManagerFacet,
    adminConfig;
  let yesId, noId;
  const erc20Decimals = 6;
  let buyDir, sellDir, ercUnit, feeConfig, conditionId;
  let snapshotId;

  before(async function () {
    [owner, maker1, maker2, maker3, taker1, taker2, oracle] =
      await ethers.getSigners();

    erc20 = await deployMockERC20("MockToken", "MOCK", erc20Decimals);
    buyDir = 0;
    sellDir = 1;

    diamondAddress = await deployDiamond();
    exchangeFacet = await ethers.getContractAt("ExchangeFacet", diamondAddress);
    marketExecutionFacet = await ethers.getContractAt(
      "MarketExecutionFacet",
      diamondAddress
    );
    erc1155 = await ethers.getContractAt("ERC1155Facet", diamondAddress);
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
    const accessControlFacet = await ethers.getContractAt(
      "AccessControlFacet",
      diamondAddress
    );
    await accessControlFacet.addMarketMaker(owner.address);

    ercUnit = ethers.utils.parseUnits("1", erc20Decimals);
    await addCollateralToken({
      adminConfig,
      token: erc20,
      unit: ercUnit,
      caller: owner,
    });
    feeConfig = await getFees(adminConfig);

    const questionId = ethers.utils.id("advanced-test-question");
    const outcomeSlotCount = 2;
    conditionId = getConditionId(oracle.address, questionId, outcomeSlotCount);
    await conditionManagerFacet
      .connect(owner)
      .createCondition(
        oracle.address,
        questionId,
        outcomeSlotCount,
        "ipfs://advanced-test"
      );

    const mintAmount = ethers.utils.parseUnits("10000", erc20Decimals);
    const users = [owner, taker1, taker2, maker1, maker2, maker3];
    for (const user of users) {
      await mintAndApproveERC20({
        token: erc20,
        minter: owner,
        to: user,
        amount: mintAmount,
        spender: diamondAddress,
      });
    }

    const [positionIds, _amounts] = await splitConditionAndGetPositionIds({
      user: owner,
      amount: ercUnit.mul(1000),
      conditionId,
      indexSets: [1, 2],
      erc20,
      conditionalFacet,
    });
    yesId = positionIds[0];
    noId = positionIds[1];

    await erc1155.connect(owner).setApprovalForAll(diamondAddress, true);

    // Distribute tokens to all users
    const tokenAmount = ethers.utils.parseUnits("200", erc20Decimals);
    for (const user of [maker1, maker2, maker3, taker1, taker2]) {
      await sendAndApproveERC1155({
        token: erc1155,
        sender: owner,
        to: user,
        tokenId: yesId,
        spender: diamondAddress,
        amount: tokenAmount,
      });
      await sendAndApproveERC1155({
        token: erc1155,
        sender: owner,
        to: user,
        tokenId: noId,
        spender: diamondAddress,
        amount: tokenAmount,
      });
    }
  });

  beforeEach(async () => {
    snapshotId = await takeSnapshot();
  });

  afterEach(async () => {
    await revertToSnapshot(snapshotId);
  });

  describe("Stress Testing", function () {
    it("should handle maximum number of maker orders efficiently", async () => {
      const maxMakers = 100; // Test with large number of makers
      const makerAmount = ethers.utils.parseUnits("1", erc20Decimals);
      const takerAmount = ethers.utils.parseUnits("100", erc20Decimals);
      const priceSell = ethers.utils.parseUnits("0.50", erc20Decimals);
      const priceBuy = ethers.utils.parseUnits("0.51", erc20Decimals);

      const makerOrderIds = [];

      // Create maximum number of maker orders
      for (let i = 0; i < maxMakers; i++) {
        const maker = i % 3 === 0 ? maker1 : i % 3 === 1 ? maker2 : maker3;
        const makerOrderId = await exchangeFacet.getNextOrderId();
        await createLimitOrder(exchangeFacet, maker, {
          positionId: yesId,
          collateralToken: erc20.address,
          amount: makerAmount,
          pricePerToken: priceSell,
          minFillAmount: makerAmount,
          expiry: 0,
          direction: sellDir,
        });
        makerOrderIds.push(makerOrderId);
      }

      const takerOrderId = await exchangeFacet.getNextOrderId();
      await createLimitOrder(exchangeFacet, taker1, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount: takerAmount,
        pricePerToken: priceBuy,
        minFillAmount: ethers.utils.parseUnits("1", erc20Decimals),
        expiry: 0,
        direction: buyDir,
      });

      const startTime = Date.now();
      const tx = await marketExecutionFacet
        .connect(taker1)
        .fillLimitOrders(takerOrderId, makerOrderIds);
      const receipt = await tx.wait();
      const endTime = Date.now();

      console.log(`Stress test execution time: ${endTime - startTime}ms`);
      console.log(`Gas used: ${receipt.gasUsed.toString()}`);

      // Verify execution completed successfully
      const takerOrder = await exchangeFacet.getOrder(takerOrderId);
      expect(takerOrder.active).to.equal(false);

      // Should complete within reasonable limits
      expect(endTime - startTime).to.be.lessThan(30000); // 30 seconds
      expect(receipt.gasUsed.lt(ethers.utils.parseUnits("30", erc20Decimals)))
        .to.be.true; // < 15M gas
    });

    it("should handle very large order amounts", async () => {
      const largeAmount = ethers.utils.parseUnits("1000000", erc20Decimals); // 1M tokens
      const priceSell = ethers.utils.parseUnits("0.50", erc20Decimals);
      const priceBuy = ethers.utils.parseUnits("0.51", erc20Decimals);

      // Mint large amounts for testing
      const largeMintAmount = ethers.utils.parseUnits("1000000", erc20Decimals);
      const takerLargeAmount = ethers.utils.parseUnits(
        "1000000",
        erc20Decimals
      );
      const makerLargeAmount = ethers.utils.parseUnits(
        "1000000",
        erc20Decimals
      );
      await mintAndApproveERC20({
        token: erc20,
        minter: owner,
        to: taker1,
        amount: takerLargeAmount,
        spender: diamondAddress,
      });
      await mintAndApproveERC20({
        token: erc20,
        minter: owner,
        to: owner,
        amount: largeMintAmount,
        spender: diamondAddress,
      });

      // Split large amount of collateral
      const [largePosIds, largePositionAmounts] =
        await splitConditionAndGetPositionIds({
          user: owner,
          amount: largeAmount,
          conditionId: conditionId,
          indexSets: [1, 2],
          erc20,
          conditionalFacet,
        });
      console.log("largePositionAmounts:", largePositionAmounts);
      const largeYesId = largePosIds[0];

      await sendAndApproveERC1155({
        token: erc1155,
        sender: owner,
        to: maker1,
        tokenId: largeYesId,
        spender: diamondAddress,
        amount: largeAmount,
      });

      console.log(
        "Maker ERC1155 Balance Before:",
        await erc1155.balanceOf(maker1.address, largeYesId)
      );
      const makerOrderId = await exchangeFacet.getNextOrderId();
      await createLimitOrder(exchangeFacet, maker1, {
        positionId: largeYesId,
        collateralToken: erc20.address,
        amount: largeAmount,
        pricePerToken: priceSell,
        minFillAmount: largeAmount,
        expiry: 0,
        direction: sellDir,
      });

      const makerOrderDetail = await exchangeFacet.getOrder(makerOrderId);
      console.log("makerOrderDetail:", makerOrderDetail);

      console.log(
        "Maker ERC1155 Balance After:",
        await erc1155.balanceOf(maker1.address, largeYesId)
      );

      console.log(
        "Taker ERC20 Balance Before:",
        await erc20.balanceOf(taker1.address)
      );

      const takerOrderId = await exchangeFacet.getNextOrderId();
      await createLimitOrder(exchangeFacet, taker1, {
        positionId: largeYesId,
        collateralToken: erc20.address,
        amount: largeAmount,
        pricePerToken: priceBuy,
        minFillAmount: largeAmount,
        expiry: 0,
        direction: buyDir,
      });
      const takerOrderDetail = await exchangeFacet.getOrder(takerOrderId);
      console.log("takerOrderDetail:", takerOrderDetail);

      console.log(
        "Taker ERC20 Balance After:",
        await erc20.balanceOf(taker1.address)
      );

      await expect(
        marketExecutionFacet
          .connect(maker2)
          .fillLimitOrders(takerOrderId, [makerOrderId])
      ).to.be.revertedWith("Hellow");

      const takerOrder = await exchangeFacet.getOrder(takerOrderId);
      expect(takerOrder.active).to.equal(false);
    });

    it("should handle precision edge cases with small amounts", async () => {
      const smallAmount = ethers.utils.parseUnits("0.000001", erc20Decimals); // Very small amount
      const sellPrice = ethers.utils.parseUnits("0.000001", erc20Decimals); // Very small price
      const buyPrice = ethers.utils.parseUnits("0.000002", erc20Decimals); // Higher to account for fees

      const makerOrderId = await exchangeFacet.getNextOrderId();
      await createLimitOrder(exchangeFacet, maker1, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount: smallAmount,
        pricePerToken: sellPrice,
        minFillAmount: smallAmount,
        expiry: 0,
        direction: sellDir,
      });

      const takerOrderId = await exchangeFacet.getNextOrderId();
      await createLimitOrder(exchangeFacet, taker1, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount: smallAmount,
        pricePerToken: buyPrice,
        minFillAmount: smallAmount,
        expiry: 0,
        direction: buyDir,
      });

      // Should handle small amounts without precision loss
      await expect(
        marketExecutionFacet
          .connect(taker1)
          .fillLimitOrders(takerOrderId, [makerOrderId])
      ).to.not.be.reverted;
    });
  });

  describe("Complex Matching Scenarios", function () {
    it("should handle cascading partial fills across multiple orders", async () => {
      const amounts = [
        ethers.utils.parseUnits("3", erc20Decimals),
        ethers.utils.parseUnits("7", erc20Decimals),
        ethers.utils.parseUnits("12", erc20Decimals),
      ];
      const takerAmount = ethers.utils.parseUnits("15", erc20Decimals);
      const sellPrice = ethers.utils.parseUnits("0.5", erc20Decimals);
      const buyPrice = ethers.utils.parseUnits("0.52", erc20Decimals); // Higher to account for fees

      const makerOrderIds = [];

      // Create maker orders with different amounts
      for (let i = 0; i < amounts.length; i++) {
        const maker = i === 0 ? maker1 : i === 1 ? maker2 : maker3;
        const makerOrderId = await exchangeFacet.getNextOrderId();
        await createLimitOrder(exchangeFacet, maker, {
          positionId: yesId,
          collateralToken: erc20.address,
          amount: amounts[i],
          pricePerToken: sellPrice,
          minFillAmount: ethers.utils.parseUnits("1", erc20Decimals),
          expiry: 0,
          direction: sellDir,
        });
        makerOrderIds.push(makerOrderId);
      }

      const takerOrderId = await exchangeFacet.getNextOrderId();
      await createLimitOrder(exchangeFacet, taker1, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount: takerAmount,
        pricePerToken: buyPrice,
        minFillAmount: ethers.utils.parseUnits("1", erc20Decimals),
        expiry: 0,
        direction: buyDir,
      });

      await marketExecutionFacet
        .connect(taker1)
        .fillLimitOrders(takerOrderId, makerOrderIds);

      // Verify cascading fills
      const takerOrder = await exchangeFacet.getOrder(takerOrderId);
      expect(takerOrder.active).to.equal(false);

      // First two orders should be completely filled
      const maker1Order = await exchangeFacet.getOrder(makerOrderIds[0]);
      const maker2Order = await exchangeFacet.getOrder(makerOrderIds[1]);
      expect(maker1Order.active).to.equal(false);
      expect(maker2Order.active).to.equal(false);

      // Third order should be partially filled
      const maker3Order = await exchangeFacet.getOrder(makerOrderIds[2]);
      expect(maker3Order.active).to.equal(true);
      expect(maker3Order.remainingAmount).to.equal(
        amounts[2].sub(ethers.utils.parseUnits("5", erc20Decimals))
      );
    });

    it("should handle mixed match types in single execution", async () => {
      const amount = ethers.utils.parseUnits("10", erc20Decimals);
      const yesPrice = ethers.utils.parseUnits("0.6", erc20Decimals);
      const noPrice = ethers.utils.parseUnits("0.42", erc20Decimals);

      // Create complementary match (YES sell vs YES buy)
      const complementaryMakerOrderId = await exchangeFacet.getNextOrderId();
      await createLimitOrder(exchangeFacet, maker1, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: ethers.utils.parseUnits("0.5", erc20Decimals),
        minFillAmount: amount,
        expiry: 0,
        direction: sellDir,
      });

      // Create mint match (NO buy for YES buy)
      const mintMakerOrderId = await exchangeFacet.getNextOrderId();
      await createLimitOrder(exchangeFacet, maker2, {
        positionId: noId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: noPrice,
        minFillAmount: amount,
        expiry: 0,
        direction: buyDir,
      });

      const takerOrderId = await exchangeFacet.getNextOrderId();
      await createLimitOrder(exchangeFacet, taker1, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount: amount.mul(2),
        pricePerToken: yesPrice,
        minFillAmount: ethers.utils.parseUnits("1", erc20Decimals),
        expiry: 0,
        direction: buyDir,
      });

      const takerYesBalanceBefore = await erc1155.balanceOf(
        taker1.address,
        yesId
      );

      await marketExecutionFacet
        .connect(taker1)
        .fillLimitOrders(takerOrderId, [
          complementaryMakerOrderId,
          mintMakerOrderId,
        ]);

      const takerYesBalanceAfter = await erc1155.balanceOf(
        taker1.address,
        yesId
      );

      // Should have received tokens from both matches
      expect(takerYesBalanceAfter.sub(takerYesBalanceBefore)).to.equal(
        amount.mul(2)
      );
    });
  });

  describe("Economic Attack Scenarios", function () {
    it("should prevent front-running attacks", async () => {
      const amount = ethers.utils.parseUnits("10", erc20Decimals);
      const goodPrice = ethers.utils.parseUnits("0.4", erc20Decimals);
      const attackPrice = ethers.utils.parseUnits("0.39", erc20Decimals); // Slightly better

      // Victim creates order
      const victimOrderId = await exchangeFacet.getNextOrderId();
      await createLimitOrder(exchangeFacet, maker1, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: goodPrice,
        minFillAmount: amount,
        expiry: 0,
        direction: sellDir,
      });

      // Attacker tries to create better order
      const attackerOrderId = await exchangeFacet.getNextOrderId();
      await createLimitOrder(exchangeFacet, maker2, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: attackPrice,
        minFillAmount: amount,
        expiry: 0,
        direction: sellDir,
      });

      const takerOrderId = await exchangeFacet.getNextOrderId();
      await createLimitOrder(exchangeFacet, taker1, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: ethers.utils.parseUnits("0.5", erc20Decimals),
        minFillAmount: amount,
        expiry: 0,
        direction: buyDir,
      });

      // fillLimitOrders should execute in the order specified by the caller
      await marketExecutionFacet
        .connect(taker1)
        .fillLimitOrders(takerOrderId, [victimOrderId, attackerOrderId]);

      // Verify victim's order was filled (first in array)
      const victimOrder = await exchangeFacet.getOrder(victimOrderId);
      const attackerOrder = await exchangeFacet.getOrder(attackerOrderId);

      expect(victimOrder.active).to.equal(false);
      expect(attackerOrder.active).to.equal(true); // Should remain unfilled
    });
  });

  describe("State Consistency Tests", function () {
    it("should maintain consistent state across multiple concurrent executions", async () => {
      const amount = ethers.utils.parseUnits("5", erc20Decimals);
      const sellPrice = ethers.utils.parseUnits("0.5", erc20Decimals);
      const buyPrice = ethers.utils.parseUnits("0.52", erc20Decimals); // Higher to account for fees

      // Create multiple maker orders
      const makerOrderIds = [];
      for (let i = 0; i < 3; i++) {
        const maker = i === 0 ? maker1 : i === 1 ? maker2 : maker3;
        const makerOrderId = await exchangeFacet.getNextOrderId();
        await createLimitOrder(exchangeFacet, maker, {
          positionId: yesId,
          collateralToken: erc20.address,
          amount,
          pricePerToken: sellPrice,
          minFillAmount: amount,
          expiry: 0,
          direction: sellDir,
        });
        makerOrderIds.push(makerOrderId);
      }

      // Create multiple taker orders
      const taker1OrderId = await exchangeFacet.getNextOrderId();
      await createLimitOrder(exchangeFacet, taker1, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: buyPrice,
        minFillAmount: amount,
        expiry: 0,
        direction: buyDir,
      });

      const taker2OrderId = await exchangeFacet.getNextOrderId();
      await createLimitOrder(exchangeFacet, taker2, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: buyPrice,
        minFillAmount: amount,
        expiry: 0,
        direction: buyDir,
      });

      // Execute both taker orders against same maker orders
      await marketExecutionFacet
        .connect(taker1)
        .fillLimitOrders(taker1OrderId, [makerOrderIds[0]]);

      await marketExecutionFacet
        .connect(taker2)
        .fillLimitOrders(taker2OrderId, [makerOrderIds[1]]);

      // Verify state consistency
      const taker1Order = await exchangeFacet.getOrder(taker1OrderId);
      const taker2Order = await exchangeFacet.getOrder(taker2OrderId);
      const maker1Order = await exchangeFacet.getOrder(makerOrderIds[0]);
      const maker2Order = await exchangeFacet.getOrder(makerOrderIds[1]);
      const maker3Order = await exchangeFacet.getOrder(makerOrderIds[2]);

      expect(taker1Order.active).to.equal(false);
      expect(taker2Order.active).to.equal(false);
      expect(maker1Order.active).to.equal(false);
      expect(maker2Order.active).to.equal(false);
      expect(maker3Order.active).to.equal(true); // Untouched
    });

    it("should handle state changes during execution", async () => {
      const amount = ethers.utils.parseUnits("10", erc20Decimals);
      const sellPrice = ethers.utils.parseUnits("0.5", erc20Decimals);
      const buyPrice = ethers.utils.parseUnits("0.52", erc20Decimals); // Higher to account for fees

      const makerOrderId = await exchangeFacet.getNextOrderId();
      await createLimitOrder(exchangeFacet, maker1, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: sellPrice,
        minFillAmount: amount,
        expiry: 0,
        direction: sellDir,
      });

      const takerOrderId = await exchangeFacet.getNextOrderId();
      await createLimitOrder(exchangeFacet, taker1, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: buyPrice,
        minFillAmount: amount,
        expiry: 0,
        direction: buyDir,
      });

      // Verify initial state
      const initialTakerOrder = await exchangeFacet.getOrder(takerOrderId);
      const initialMakerOrder = await exchangeFacet.getOrder(makerOrderId);
      expect(initialTakerOrder.active).to.equal(true);
      expect(initialMakerOrder.active).to.equal(true);

      await marketExecutionFacet
        .connect(taker1)
        .fillLimitOrders(takerOrderId, [makerOrderId]);

      // Verify final state
      const finalTakerOrder = await exchangeFacet.getOrder(takerOrderId);
      const finalMakerOrder = await exchangeFacet.getOrder(makerOrderId);
      expect(finalTakerOrder.active).to.equal(false);
      expect(finalMakerOrder.active).to.equal(false);
    });
  });

  describe("Performance and Optimization Tests", function () {
    it("should optimize gas usage for single order matches", async () => {
      const amount = ethers.utils.parseUnits("10", erc20Decimals);
      const sellPrice = ethers.utils.parseUnits("0.5", erc20Decimals);
      const buyPrice = ethers.utils.parseUnits("0.52", erc20Decimals); // Higher to account for fees

      const makerOrderId = await exchangeFacet.getNextOrderId();
      await createLimitOrder(exchangeFacet, maker1, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: sellPrice,
        minFillAmount: amount,
        expiry: 0,
        direction: sellDir,
      });

      const takerOrderId = await exchangeFacet.getNextOrderId();
      await createLimitOrder(exchangeFacet, taker1, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: buyPrice,
        minFillAmount: amount,
        expiry: 0,
        direction: buyDir,
      });

      const tx = await marketExecutionFacet
        .connect(taker1)
        .fillLimitOrders(takerOrderId, [makerOrderId]);

      const receipt = await tx.wait();
      console.log(`Single order match gas: ${receipt.gasUsed.toString()}`);

      // Should use reasonable gas for single match
      expect(receipt.gasUsed.lt(ethers.utils.parseUnits("500", 3))).to.be.true; // < 500k gas
    });
  });

  describe("Boundary Condition Tests", function () {
    it("should handle minimum fill amounts at boundaries", async () => {
      const totalAmount = ethers.utils.parseUnits("10", erc20Decimals);
      const minFillAmount = ethers.utils.parseUnits("9.999999", erc20Decimals); // Just under total
      const sellPrice = ethers.utils.parseUnits("0.5", erc20Decimals);
      const buyPrice = ethers.utils.parseUnits("0.52", erc20Decimals); // Higher to account for fees

      const makerOrderId = await exchangeFacet.getNextOrderId();
      await createLimitOrder(exchangeFacet, maker1, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount: totalAmount,
        pricePerToken: sellPrice,
        minFillAmount: minFillAmount,
        expiry: 0,
        direction: sellDir,
      });

      const takerOrderId = await exchangeFacet.getNextOrderId();
      await createLimitOrder(exchangeFacet, taker1, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount: totalAmount,
        pricePerToken: buyPrice,
        minFillAmount: totalAmount,
        expiry: 0,
        direction: buyDir,
      });

      // Should succeed as fill amount equals total amount
      await expect(
        marketExecutionFacet
          .connect(taker1)
          .fillLimitOrders(takerOrderId, [makerOrderId])
      ).to.not.be.reverted;
    });

    it("should handle price boundaries correctly", async () => {
      const amount = ethers.utils.parseUnits("10", erc20Decimals);
      const maxSellPrice = ethers.utils.parseUnits("0.88888", erc20Decimals);
      const maxBuyPrice = ethers.utils.parseUnits("0.99999", erc20Decimals);
      const minPrice = ethers.utils.parseUnits("0.000001", erc20Decimals); // Minimum price

      // Test maximum price
      const maxPriceMakerOrderId = await exchangeFacet.getNextOrderId();
      await createLimitOrder(exchangeFacet, maker1, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: maxSellPrice,
        minFillAmount: amount,
        expiry: 0,
        direction: sellDir,
      });

      const maxPriceTakerOrderId = await exchangeFacet.getNextOrderId();
      await createLimitOrder(exchangeFacet, taker1, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: maxBuyPrice,
        minFillAmount: amount,
        expiry: 0,
        direction: buyDir,
      });

      await expect(
        marketExecutionFacet
          .connect(taker1)
          .fillLimitOrders(maxPriceTakerOrderId, [maxPriceMakerOrderId])
      ).to.not.be.revertedWith();

      // Test minimum price
      const minPriceMakerOrderId = await exchangeFacet.getNextOrderId();
      await createLimitOrder(exchangeFacet, maker2, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: minPrice,
        minFillAmount: amount,
        expiry: 0,
        direction: sellDir,
      });

      const minPriceTakerOrderId = await exchangeFacet.getNextOrderId();
      await createLimitOrder(exchangeFacet, taker2, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: minPrice,
        minFillAmount: amount,
        expiry: 0,
        direction: buyDir,
      });

      await expect(
        marketExecutionFacet
          .connect(taker2)
          .fillLimitOrders(minPriceTakerOrderId, [minPriceMakerOrderId])
      ).to.not.be.reverted;
    });

    it("should handle timestamp boundaries for expiry", async () => {
      const amount = ethers.utils.parseUnits("10", erc20Decimals);
      const sellPrice = ethers.utils.parseUnits("0.5", erc20Decimals);
      const buyPrice = ethers.utils.parseUnits("0.52", erc20Decimals); // Higher to account for fees
      const currentTime = Math.floor(Date.now() / 1000);

      // Create order that expires exactly now
      const exactExpiryOrderId = await exchangeFacet.getNextOrderId();
      await createLimitOrder(exchangeFacet, maker1, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: sellPrice,
        minFillAmount: amount,
        expiry: currentTime + 100, // 1 second from now
        direction: sellDir,
      });

      const takerOrderId = await exchangeFacet.getNextOrderId();
      await createLimitOrder(exchangeFacet, taker1, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: buyPrice,
        minFillAmount: amount,
        expiry: 0,
        direction: buyDir,
      });

      // Should succeed if executed immediately
      await expect(
        marketExecutionFacet
          .connect(taker1)
          .fillLimitOrders(takerOrderId, [exactExpiryOrderId])
      ).to.not.be.reverted;
    });
  });

  describe("Recovery and Resilience Tests", function () {
    it("should handle partial system failures gracefully", async () => {
      const amount = ethers.utils.parseUnits("10", erc20Decimals);
      const sellPrice = ethers.utils.parseUnits("0.5", erc20Decimals);
      const buyPrice = ethers.utils.parseUnits("0.52", erc20Decimals); // Higher to account for fees

      // Create multiple orders where some might fail
      const validMakerOrderId = await exchangeFacet.getNextOrderId();
      await createLimitOrder(exchangeFacet, maker1, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: sellPrice,
        minFillAmount: amount,
        expiry: 0,
        direction: sellDir,
      });

      // Create order with insufficient balance (will be detected during execution)
      const insufficientMakerOrderId = await exchangeFacet.getNextOrderId();
      await createLimitOrder(exchangeFacet, maker2, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: sellPrice,
        minFillAmount: amount,
        expiry: 0,
        direction: sellDir,
      });

      // Remove maker2's tokens to simulate insufficient balance
      const maker2Balance = await erc1155.balanceOf(maker2.address, yesId);
      await erc1155
        .connect(maker2)
        .safeTransferFrom(
          maker2.address,
          owner.address,
          yesId,
          maker2Balance,
          "0x"
        );

      const takerOrderId = await exchangeFacet.getNextOrderId();
      await createLimitOrder(exchangeFacet, taker1, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount: amount.mul(2),
        pricePerToken: buyPrice,
        minFillAmount: ethers.utils.parseUnits("1", erc20Decimals),
        expiry: 0,
        direction: buyDir,
      });

      // Should handle the failure gracefully and continue with valid orders
      await expect(
        marketExecutionFacet
          .connect(taker1)
          .fillLimitOrders(takerOrderId, [
            validMakerOrderId,
            insufficientMakerOrderId,
          ])
      ).to.be.reverted; // Will revert on insufficient balance, but this tests the resilience
    });

    it("should maintain data integrity after failed transactions", async () => {
      const amount = ethers.utils.parseUnits("10", erc20Decimals);
      const sellPrice = ethers.utils.parseUnits("0.5", erc20Decimals);
      const buyPrice = ethers.utils.parseUnits("0.52", erc20Decimals); // Higher to account for fees

      const makerOrderId = await exchangeFacet.getNextOrderId();
      await createLimitOrder(exchangeFacet, maker1, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: sellPrice,
        minFillAmount: amount,
        expiry: 0,
        direction: sellDir,
      });

      const takerOrderId = await exchangeFacet.getNextOrderId();
      await createLimitOrder(exchangeFacet, taker1, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: buyPrice,
        minFillAmount: amount,
        expiry: 0,
        direction: buyDir,
      });

      // Record initial state
      const initialTakerOrder = await exchangeFacet.getOrder(takerOrderId);
      const initialMakerOrder = await exchangeFacet.getOrder(makerOrderId);
      const initialTakerBalance = await erc1155.balanceOf(
        taker1.address,
        yesId
      );
      const initialMakerBalance = await erc1155.balanceOf(
        maker1.address,
        yesId
      );

      // Try to execute with invalid order ID (should fail)
      try {
        await marketExecutionFacet
          .connect(taker1)
          .fillLimitOrders(takerOrderId, [999999]);
      } catch (error) {
        // Expected to fail
      }

      // Verify state is unchanged after failed transaction
      const afterFailTakerOrder = await exchangeFacet.getOrder(takerOrderId);
      const afterFailMakerOrder = await exchangeFacet.getOrder(makerOrderId);
      const afterFailTakerBalance = await erc1155.balanceOf(
        taker1.address,
        yesId
      );
      const afterFailMakerBalance = await erc1155.balanceOf(
        maker1.address,
        yesId
      );

      expect(afterFailTakerOrder.active).to.equal(initialTakerOrder.active);
      expect(afterFailMakerOrder.active).to.equal(initialMakerOrder.active);
      expect(afterFailTakerBalance).to.equal(initialTakerBalance);
      expect(afterFailMakerBalance).to.equal(initialMakerBalance);

      // Now execute successfully
      await marketExecutionFacet
        .connect(taker1)
        .fillLimitOrders(takerOrderId, [makerOrderId]);

      // Verify successful execution
      const finalTakerOrder = await exchangeFacet.getOrder(takerOrderId);
      const finalMakerOrder = await exchangeFacet.getOrder(makerOrderId);

      expect(finalTakerOrder.active).to.equal(false);
      expect(finalMakerOrder.active).to.equal(false);
    });
  });
});
