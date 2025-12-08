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
const {
  simulateAndParseMatchRoute,
} = require("../../utils/simulationUtils.js");

describe("Market Execution Facet - Mixed Matched tests", function () {
  let owner, user, maker, oracle, taker;
  let diamondAddress,
    matchExecutionFacet,
    routeSimFacet,
    orderCreationFacet,
    erc20,
    ercUnit,
    erc1155,
    conditionalFacet,
    conditionManagerFacet,
    adminConfig;
  let questionId, conditionId, yesId, noId;
  let mintAmount,
    unit,
    erc20Decimals = 6;
  let buyDir, sellDir, feeConfig;
  let snapshotId;

  before(async function () {
    [owner, user, maker, oracle, taker] = await ethers.getSigners();

    erc20 = await deployMockERC20("MockToken", "MOCK", erc20Decimals);

    buyDir = 0;
    sellDir = 1;

    diamondAddress = await deployDiamond();

    orderCreationFacet = await ethers.getContractAt(
      "OrderCreationFacet",
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
    matchExecutionFacet = await ethers.getContractAt(
      "MarketExecutionFacet",
      diamondAddress
    );
    adminConfig = await ethers.getContractAt(
      "AdminConfigFacet",
      diamondAddress
    );
    routeSimFacet = await ethers.getContractAt(
      "RouteSimulationFacet",
      diamondAddress
    );
    const accessControlFacet = await ethers.getContractAt(
      "AccessControlFacet",
      diamondAddress
    );

    await accessControlFacet.addMarketMaker(owner.address);

    ercUnit = ethers.utils.parseUnits("1", erc20Decimals);

    // await addCollateralToken(adminConfig, erc20.address, ercUnit, owner);
    await addCollateralToken({
      adminConfig: adminConfig,
      token: erc20,
      unit: ercUnit,
      caller: owner,
    });
    feeConfig = await getFees(adminConfig);

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

    unit = ethers.utils.parseUnits("1", erc20Decimals);
    mintAmount = ethers.utils.parseUnits("120", erc20Decimals);

    await mintAndApproveERC20({
      token: erc20,
      minter: owner,
      to: owner,
      amount: mintAmount,
      spender: diamondAddress,
    });

    await mintAndApproveERC20({
      token: erc20,
      minter: owner,
      to: taker,
      amount: mintAmount,
      spender: diamondAddress,
    });

    const [positionIds, _amounts] = await splitConditionAndGetPositionIds({
      user: owner,
      amount: unit.mul(20),
      conditionId,
      indexSets: [1, 2],
      erc20,
      conditionalFacet,
    });

    yesId = positionIds[0];
    noId = positionIds[1];

    await erc1155.connect(owner).setApprovalForAll(diamondAddress, true);
  });

  beforeEach(async () => {
    snapshotId = await takeSnapshot();
  });

  afterEach(async () => {
    await revertToSnapshot(snapshotId);
  });

  it("should execute a BUY market order using Mint and Complementary match routes", async () => {
    const firstOrderDir = buyDir;
    const secondOrderDir = sellDir;
    const marketOrderDir = buyDir;

    const firstBuyYesLimitOrderPrice = ethers.utils.parseUnits(
      "0.3",
      erc20Decimals
    ); // Maker wants to buy Yes at 0.3 - Taker pays 0.7 per No Unit - Mint
    const secondSellNoLimitOrderPrice = ethers.utils.parseUnits(
      "0.4",
      erc20Decimals
    ); // Maker wants to sell No at 0.4 - Taker pays 0.4 per No unit - Comp

    const firstBuyYesLimitOrderAmount = ethers.utils.parseUnits(
      "4",
      erc20Decimals
    );
    const secondSellNoLimitOrderAmount = ethers.utils.parseUnits(
      "2",
      erc20Decimals
    );

    const marketBuyNoFillAmount = ethers.utils.parseUnits("4", erc20Decimals); // Taker gonna buy No, Fill 2 of them using best

    const firstOrderCost = firstBuyYesLimitOrderAmount
      .mul(firstBuyYesLimitOrderPrice)
      .div(ercUnit);
    const firstOrderMakerFee = firstOrderCost
      .mul(feeConfig.makerBps)
      .div(10_000);
    const firstOrderMakerLocked = firstOrderCost.add(firstOrderMakerFee); // Maker is buying so he lock cost + fee upfront

    const secOrderCost = secondSellNoLimitOrderAmount
      .mul(secondSellNoLimitOrderPrice)
      .div(ercUnit);
    const secondOrderMakerFee = secOrderCost
      .mul(feeConfig.makerBps)
      .div(10_000);
    const secondOrderReceive = secOrderCost.sub(secondOrderMakerFee); // Maker is selling so he gets cost - fee

    const secondOrderTakerFee = secOrderCost
      .mul(feeConfig.takerBps)
      .div(10_000);
    const secondOrderTakerCost = secOrderCost.add(secondOrderTakerFee);

    const remainingAmountForMarketOrder = marketBuyNoFillAmount.sub(
      secondSellNoLimitOrderAmount
    ); // Second order is offering a better price

    const firstOrderTakerPrice = ethers.utils
      .parseUnits("1", erc20Decimals)
      .sub(firstBuyYesLimitOrderPrice); // 1 - 0.3 = 0.7 taker has to pay per unit of no
    const firstOrderMintCost = remainingAmountForMarketOrder
      .mul(firstOrderTakerPrice)
      .div(ercUnit);
    const firstOrderTakerFee = firstOrderMintCost
      .mul(feeConfig.takerBps)
      .div(10_000);
    const firstOrderTakerCost = firstOrderMintCost.add(firstOrderTakerFee);

    const totalTakerPays = firstOrderTakerCost.add(secondOrderTakerCost);

    // Fund maker for first order buy yes (collateral)
    await mintAndApproveERC20({
      token: erc20,
      minter: owner,
      to: maker,
      amount: firstOrderMakerLocked,
      spender: diamondAddress,
    });

    // For the second sell limit order - owner is already funded and approved the diamond contract

    // Fund taker for limit order
    await mintAndApproveERC20({
      token: erc20,
      minter: owner,
      to: taker,
      amount: totalTakerPays,
      spender: diamondAddress,
    });

    // Balances before
    const makerYesBefore = await erc1155.balanceOf(maker.address, yesId);
    const ownerNoBefore = await erc1155.balanceOf(owner.address, noId);
    const takerNoBefore = await erc1155.balanceOf(taker.address, noId);
    const takerERC20Before = await erc20.balanceOf(taker.address);
    const ownerErC20Before = await erc20.balanceOf(owner.address);
    const makerERC20Before = await erc20.balanceOf(maker.address);

    // Maker places limit buy for yes token
    await createLimitOrder(orderCreationFacet, maker, {
      positionId: yesId,
      collateralToken: erc20.address,
      amount: firstBuyYesLimitOrderAmount,
      pricePerToken: firstBuyYesLimitOrderPrice,
      minFillAmount: 0,
      expiry: 0,
      direction: firstOrderDir,
    });

    // Maker (owner address) places limit sell order for no
    await createLimitOrder(orderCreationFacet, owner, {
      positionId: noId,
      collateralToken: erc20.address,
      amount: secondSellNoLimitOrderAmount,
      pricePerToken: secondSellNoLimitOrderPrice,
      minFillAmount: 0,
      expiry: 0,
      direction: secondOrderDir,
    });

    // Simulate taker BUY YES (should match with NO buy via mint)
    const route = await simulateAndParseMatchRoute({
      routeSimFacet,
      positionId: noId,
      amount: totalTakerPays,
      direction: marketOrderDir,
    });

    console.log("Route:", route);

    const effectiveBuyPrice = route.totalOutputAmount
      .mul(ercUnit)
      .div(route.totalInputAmount);

    // Fill the market order
    await matchExecutionFacet.connect(taker).fillMarketOrderWithRoute(
      noId,
      marketBuyNoFillAmount,
      effectiveBuyPrice,
      false, // fillOrKill
      marketOrderDir,
      route.matches.map((m) => [
        m.matchedOrderId,
        m.amount,
        m.effectivePrice,
        m.matchType,
      ])
    );

    // Balances after
    const makerYesAfter = await erc1155.balanceOf(maker.address, yesId);
    const ownerNoAfter = await erc1155.balanceOf(owner.address, noId);
    const takerNoAfter = await erc1155.balanceOf(taker.address, noId);
    const takerERC20After = await erc20.balanceOf(taker.address);
    const ownerErC20After = await erc20.balanceOf(owner.address);
    const makerERC20After = await erc20.balanceOf(maker.address);

    console.log("takerNoAfter: ", takerNoAfter);
    console.log("takerNoBefore: ", takerNoBefore);
    console.log("takerERC20Before: ", takerERC20Before);
    console.log("takerERC20After: ", takerERC20After);

    console.log("makerYesAfter: ", makerYesAfter);
    console.log("makerYesBefore: ", makerYesBefore);
    console.log("makerERC20Before: ", takerERC20Before);
    console.log("makerERC20After: ", takerERC20After);

    console.log("ownerNoBefore: ", ownerNoBefore);
    console.log("ownerNoAfter: ", ownerNoAfter);
    console.log("ownerErC20Before: ", ownerErC20Before);
    console.log("ownerErC20After: ", ownerErC20After);

    console.log("marketBuyNoFillAmount", marketBuyNoFillAmount);
    console.log("firstOrderMakerLocked", firstOrderMakerLocked);
    console.log("secondOrderReceive", secondOrderReceive);
    console.log("totalTakerPays", totalTakerPays);
    console.log("remainingAmountForMarketOrder", remainingAmountForMarketOrder);

    // ✅ Taker receives No tokens
    expect(takerNoAfter.sub(takerNoBefore)).to.equal(marketBuyNoFillAmount);

    // ✅ Maker receives NO tokens
    expect(makerYesAfter.sub(makerYesBefore)).to.equal(
      remainingAmountForMarketOrder
    );

    // // ✅ Maker lost full locked collateral (price * amount + fee)
    expect(makerERC20Before.sub(makerERC20After)).to.equal(
      firstOrderMakerLocked
    );

    expect(ownerErC20After.sub(ownerErC20Before)).to.equal(secondOrderReceive);

    // ✅ Taker lost 1 - price * amount + fee
    expect(takerERC20Before.sub(takerERC20After)).to.equal(totalTakerPays);
  });

  it("should execute a BUY market order using multiple Mint match orders", async () => {
    const firstBuyPrice = ethers.utils.parseUnits("0.3", erc20Decimals);
    const secondBuyPrice = ethers.utils.parseUnits("0.4", erc20Decimals);

    const firstBuyAmount = ethers.utils.parseUnits("4", erc20Decimals);
    const secondBuyAmount = ethers.utils.parseUnits("2", erc20Decimals);

    const marketFillAmount = ethers.utils.parseUnits("4", erc20Decimals); // Ideal fill amount per order, sec is the best price,
    var remainingAmountForMarketOrder = marketFillAmount;

    // Cost and fee calculations
    const firstOrderCost = firstBuyAmount.mul(firstBuyPrice).div(ercUnit);
    const secondOrderCost = secondBuyAmount.mul(secondBuyPrice).div(ercUnit);
    const baseCost = firstOrderCost.add(secondOrderCost);
    const makerFee = baseCost.mul(feeConfig.makerBps).div(10_000);
    const makerLocked = baseCost.add(makerFee);

    const secondOrderTakerPayout = ethers.utils
      .parseUnits("1", erc20Decimals)
      .sub(secondBuyPrice)
      .mul(secondBuyAmount)
      .div(ercUnit);
    remainingAmountForMarketOrder = marketFillAmount.sub(secondBuyAmount);
    const firstOrderTakerPayout = ethers.utils
      .parseUnits("1", erc20Decimals)
      .sub(firstBuyPrice)
      .mul(remainingAmountForMarketOrder)
      .div(ercUnit);

    const totalTakerPayout = firstOrderTakerPayout.add(secondOrderTakerPayout);
    const takerFee = totalTakerPayout.mul(feeConfig.takerBps).div(10_000);
    const takerReceive = totalTakerPayout.add(takerFee);

    // Fund maker
    await mintAndApproveERC20({
      token: erc20,
      minter: owner,
      to: maker,
      amount: makerLocked,
      spender: diamondAddress,
    });

    const makerERC20Before = await erc20.balanceOf(maker.address);

    // Maker places BUY order for YES (Mint match)
    await createLimitOrder(orderCreationFacet, maker, {
      positionId: yesId,
      collateralToken: erc20.address,
      amount: firstBuyAmount,
      pricePerToken: firstBuyPrice,
      minFillAmount: 0,
      expiry: 0,
      direction: buyDir,
    });

    await createLimitOrder(orderCreationFacet, maker, {
      positionId: yesId,
      collateralToken: erc20.address,
      amount: secondBuyAmount,
      pricePerToken: secondBuyPrice,
      minFillAmount: 0,
      expiry: 0,
      direction: buyDir,
    });

    // Calculate budget for taker BUY NO order
    // Best match will be with secondBuyPrice (for YES), so NO complement price
    const noPrice = ethers.utils.parseUnits("1", erc20Decimals).sub(secondBuyPrice);
    const takerBudgetBase = marketFillAmount.mul(noPrice).div(ercUnit);
    const takerBudgetFee = takerBudgetBase.mul(feeConfig.takerBps).div(10_000);
    let takerBudget = takerBudgetBase.add(takerBudgetFee);
    if (!takerBudget.mod(ercUnit).eq(0)) {
      takerBudget = takerBudget.add(ercUnit.sub(takerBudget.mod(ercUnit)));
    }

    // Simulate taker Buy NO (should match with YES buy via mint)
    const route = await simulateAndParseMatchRoute({
      routeSimFacet,
      positionId: noId,
      amount: takerBudget,
      direction: buyDir,
    });

    const effectiveSellPrice = route.totalOutputAmount
      .mul(ercUnit)
      .div(route.totalInputAmount);

    // Balances before
    const makerYesBefore = await erc1155.balanceOf(maker.address, yesId);
    const takerNoBefore = await erc1155.balanceOf(taker.address, noId);
    const takerERC20Before = await erc20.balanceOf(taker.address);

    // Execute fill
    await matchExecutionFacet.connect(taker).fillMarketOrderWithRoute(
      noId,
      marketFillAmount,
      effectiveSellPrice,
      false, // fillOrKill
      buyDir,
      route.matches.map((m) => [
        m.matchedOrderId,
        m.amount,
        m.effectivePrice,
        m.matchType,
      ])
    );

    // Balances after
    const makerYesAfter = await erc1155.balanceOf(maker.address, yesId);
    const takerNoAfter = await erc1155.balanceOf(taker.address, noId);
    const makerERC20After = await erc20.balanceOf(maker.address);
    const takerERC20After = await erc20.balanceOf(taker.address);

    // ✅ Taker NO (balance increased)
    expect(takerNoAfter.sub(takerNoBefore)).to.equal(marketFillAmount);

    // ✅ Maker received YES tokens
    expect(makerYesAfter.sub(makerYesBefore)).to.equal(marketFillAmount);

    // ✅ Maker lost expected collateral
    expect(makerERC20Before.sub(makerERC20After)).to.equal(makerLocked);

    // ✅ Taker received correct collateral payout minus fee
    expect(takerERC20Before.sub(takerERC20After)).to.equal(takerReceive);
  });
});
