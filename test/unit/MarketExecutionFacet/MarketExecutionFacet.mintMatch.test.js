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
const {
  splitConditionAndGetPositionIds,
} = require("../../utils/conditionUtils.js");
const { createLimitOrder, createMarketOrder } = require("../../utils/orderUtils.js");
const {
  takeSnapshot,
  revertToSnapshot,
} = require("../../utils/snapshotUtils.js");
const {
  simulateAndParseMatchRoute,
} = require("../../utils/simulationUtils.js");

describe("Market Execution Facet", function () {
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

  it("should execute a BUY market order using Mint match route", async () => {
    const price = ethers.utils.parseUnits("0.4", erc20Decimals); // Maker is buying NO at 0.4
    const amount = ethers.utils.parseUnits("5", erc20Decimals); // Taker wants 5 YES

    const baseCost = amount.mul(price).div(ercUnit); // 2.0
    const makerFee = baseCost.mul(feeConfig.makerBps).div(10_000);
    const makerLocked = baseCost.add(makerFee); // e.g., 2.0 + makerFee

    const takerCost = ethers.utils
      .parseUnits("1", erc20Decimals)
      .sub(price)
      .mul(amount)
      .div(ercUnit); // 3.0
    const takerFee = takerCost.mul(feeConfig.takerBps).div(10_000);
    const takerTotal = takerCost.add(takerFee); // 3.0 + fee

    // Fund maker (collateral)
    await mintAndApproveERC20({
      token: erc20,
      minter: owner,
      to: maker,
      amount: makerLocked,
      spender: diamondAddress,
    });

    // const allowanceTaker = takerTotal.add(makerLocked)
    // console.log("Allowance tkaer;", allowanceTaker)
    // Fund taker (collateral)
    await mintAndApproveERC20({
      token: erc20,
      minter: owner,
      to: taker,
      amount: takerTotal,
      spender: diamondAddress,
    });

    const makerERC20Before = await erc20.balanceOf(maker.address);

    // Maker places limit BUY for NO
    await createLimitOrder(orderCreationFacet, maker, {
      positionId: noId,
      collateralToken: erc20.address,
      amount,
      pricePerToken: price,
      minFillAmount: amount,
      expiry: 0,
      direction: buyDir,
    });

    // Simulate taker BUY YES (should match with NO buy via mint)
    const route = await simulateAndParseMatchRoute({
      routeSimFacet,
      positionId: yesId,
      amount: takerTotal,
      direction: buyDir,
    });

    const effectiveBuyPrice = route.totalOutputAmount
      .mul(ercUnit)
      .div(route.totalInputAmount);

    await mintAndApproveERC20({
      token: erc20,
      minter: owner,
      to: taker,
      amount: takerTotal,
      spender: diamondAddress,
    });

    // Balances before
    const makerNoBefore = await erc1155.balanceOf(maker.address, noId);
    const takerYesBefore = await erc1155.balanceOf(taker.address, yesId);
    const takerERC20Before = await erc20.balanceOf(taker.address);

    // Execute market BUY order (automatically finds mint match)
    // Maker is buying NO at `price`, so taker buying YES should use complement
    const yesPrice = ethers.utils.parseUnits("1", erc20Decimals).sub(price);
    await createMarketOrder(orderCreationFacet, taker, {
      positionId: yesId,
      collateralToken: erc20.address,
      amount,
      pricePerToken: yesPrice,
      direction: buyDir,
      fillOrKill: false,
    });

    // Balances after
    const makerNoAfter = await erc1155.balanceOf(maker.address, noId);
    const takerYesAfter = await erc1155.balanceOf(taker.address, yesId);
    const makerERC20After = await erc20.balanceOf(maker.address);
    const takerERC20After = await erc20.balanceOf(taker.address);

    // ✅ Taker receives YES tokens
    expect(takerYesAfter.sub(takerYesBefore)).to.equal(amount);

    // ✅ Maker receives NO tokens
    expect(makerNoAfter.sub(makerNoBefore)).to.equal(amount);

    // ✅ Maker lost full locked collateral (price * amount + fee)
    expect(makerERC20Before.sub(makerERC20After)).to.equal(makerLocked);

    // ✅ Taker lost 1 - price * amount + fee
    expect(takerERC20Before.sub(takerERC20After)).to.equal(takerTotal);
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
    // Best match will be with secondBuyPrice (0.4 for YES), so NO complement = 0.6
    const noPrice = ethers.utils.parseUnits("1", erc20Decimals).sub(secondBuyPrice);
    const takerBudgetBase = marketFillAmount.mul(noPrice).div(ercUnit);
    const takerBudgetFee = takerBudgetBase.mul(feeConfig.takerBps).div(10_000);
    let takerBudget = takerBudgetBase.add(takerBudgetFee);
    if (!takerBudget.mod(ercUnit).eq(0)) {
      takerBudget = takerBudget.add(ercUnit.sub(takerBudget.mod(ercUnit)));
    }

    // Balances before
    const makerYesBefore = await erc1155.balanceOf(maker.address, yesId);
    const takerNoBefore = await erc1155.balanceOf(taker.address, noId);
    const takerERC20Before = await erc20.balanceOf(taker.address);

    // Execute market BUY NO order (automatically finds mint match with YES orders)
    await createMarketOrder(orderCreationFacet, taker, {
      positionId: noId,
      collateralToken: erc20.address,
      amount: marketFillAmount,
      pricePerToken: noPrice,
      direction: buyDir,
      fillOrKill: false,
    });

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
