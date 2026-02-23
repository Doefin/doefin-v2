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

  it("should execute a Sell market order using Merge match route", async () => {
    const price = ethers.utils.parseUnits("0.4", erc20Decimals); // Maker is Selling NO at 0.4
    const amount = ethers.utils.parseUnits("5", erc20Decimals); // Taker wants to sell 5 YES

    const baseCost = amount.mul(price).div(ercUnit);
    const makerFee = baseCost.mul(feeConfig.makerBps).div(10_000);
    const makerRecieve = baseCost.sub(makerFee); // e.g., 2.0 - makerFee

    const takerCost = ethers.utils
      .parseUnits("1", erc20Decimals)
      .sub(price)
      .mul(amount)
      .div(ercUnit); // 3.0
    const takerFee = takerCost.mul(feeConfig.takerBps).div(10_000);
    const takerReceive = takerCost.sub(takerFee);

    await sendAndApproveERC1155({
      token: erc1155,
      sender: owner,
      to: maker,
      tokenId: noId,
      spender: diamondAddress,
      amount: amount,
    });
    await sendAndApproveERC1155({
      token: erc1155,
      sender: owner,
      to: taker,
      tokenId: yesId,
      spender: diamondAddress,
      amount: amount,
    });

    // Balances before
    const makerNoBefore = await erc1155.balanceOf(maker.address, noId);
    const makerERC20Before = await erc20.balanceOf(maker.address);

    const takerYesBefore = await erc1155.balanceOf(taker.address, yesId);
    const takerERC20Before = await erc20.balanceOf(taker.address);

    // Maker places limit BUY for NO
    await createLimitOrder(orderCreationFacet, maker, {
      positionId: noId,
      collateralToken: erc20.address,
      amount,
      pricePerToken: price,
      minFillAmount: amount,
      expiry: 0,
      direction: sellDir,
    });

    // Execute market SELL order (automatically finds merge match)
    // For SELL order, price represents the target price
    const sellPrice = ethers.utils.parseUnits("1", erc20Decimals).sub(price);
    await createMarketOrder(orderCreationFacet, taker, {
      positionId: yesId,
      collateralToken: erc20.address,
      amount,
      pricePerToken: sellPrice,
      direction: sellDir,
      fillOrKill: false,
    });

    // Balances after
    const makerNoAfter = await erc1155.balanceOf(maker.address, noId);
    const takerYesAfter = await erc1155.balanceOf(taker.address, yesId);
    const makerERC20After = await erc20.balanceOf(maker.address);
    const takerERC20After = await erc20.balanceOf(taker.address);

    console.log("makerNoAfter", makerNoAfter);
    console.log("takerYesAfter", takerYesAfter);
    console.log("makerERC20After", makerERC20After);
    console.log("takerERC20After", takerERC20After);

    console.log("amount", amount);
    console.log("makerRecieve", makerRecieve);
    console.log("takerReceive", takerReceive);

    console.log("makerNoBefore", makerNoBefore);
    console.log("takerYesBefore", takerYesBefore);
    console.log("makerERC20Before", makerERC20Before);
    console.log("takerERC20Before", takerERC20Before);

    expect(takerYesBefore.sub(takerYesAfter)).to.equal(amount);
    expect(makerNoBefore.sub(makerNoAfter)).to.equal(amount);
    expect(makerERC20After.sub(makerERC20Before)).to.equal(makerRecieve);
    expect(takerERC20After.sub(takerERC20Before)).to.equal(takerReceive);
  });

  it("should execute a Sell market order using multiple Merge match orders", async () => {
    const firstSellPrice = ethers.utils.parseUnits("0.51", erc20Decimals);
    const secondSellPrice = ethers.utils.parseUnits("0.4555", erc20Decimals);

    const firstSellAmount = ethers.utils.parseUnits("4", erc20Decimals); // First order is for 4 NO
    const secondSellAmount = ethers.utils.parseUnits("2", erc20Decimals);

    const marketFillAmount = ethers.utils.parseUnits("4", erc20Decimals); // Ideal fill amount per order, sec is the best price
    var remainingAmountForMarketOrder = marketFillAmount;

    const worstOrderAmountNotMatched = firstSellAmount
      .add(secondSellAmount)
      .sub(marketFillAmount);

    // Cost and fee calculations
    const firstOrderFillableAmount = ethers.utils.parseUnits(
      "2",
      erc20Decimals
    ); // First order won't get fully matched.
    const firstOrderCost = firstOrderFillableAmount
      .mul(firstSellPrice)
      .div(ercUnit);
    const secondOrderCost = secondSellAmount.mul(secondSellPrice).div(ercUnit);
    const baseCost = firstOrderCost.add(secondOrderCost);
    const makerFee = baseCost.mul(feeConfig.makerBps).div(10_000);
    const makerRecieve = baseCost.sub(makerFee);

    const secondOrderTakerPayout = ethers.utils
      .parseUnits("1", erc20Decimals)
      .sub(secondSellPrice)
      .mul(secondSellAmount)
      .div(ercUnit);
    remainingAmountForMarketOrder = marketFillAmount.sub(secondSellAmount);
    const firstOrderTakerPayout = ethers.utils
      .parseUnits("1", erc20Decimals)
      .sub(firstSellPrice)
      .mul(remainingAmountForMarketOrder)
      .div(ercUnit);

    const totalTakerPayout = firstOrderTakerPayout.add(secondOrderTakerPayout);
    const takerFee = totalTakerPayout.mul(feeConfig.takerBps).div(10_000);
    const takerReceive = totalTakerPayout.sub(takerFee);

    // Fund maker
    await sendAndApproveERC1155({
      token: erc1155,
      sender: owner,
      to: maker,
      tokenId: yesId,
      spender: diamondAddress,
      amount: firstSellAmount.add(secondSellAmount),
    });
    await sendAndApproveERC1155({
      token: erc1155,
      sender: owner,
      to: taker,
      tokenId: noId,
      spender: diamondAddress,
      amount: marketFillAmount,
    });

    // Balances before
    const makerYesBefore = await erc1155.balanceOf(maker.address, yesId);
    const takerNoBefore = await erc1155.balanceOf(taker.address, noId);
    const takerERC20Before = await erc20.balanceOf(taker.address);
    const makerERC20Before = await erc20.balanceOf(maker.address);

    // Maker places Sell order for No (Merge match)
    await createLimitOrder(orderCreationFacet, maker, {
      positionId: yesId,
      collateralToken: erc20.address,
      amount: firstSellAmount,
      pricePerToken: firstSellPrice,
      minFillAmount: 0,
      expiry: 0,
      direction: sellDir,
    });

    await createLimitOrder(orderCreationFacet, maker, {
      positionId: yesId,
      collateralToken: erc20.address,
      amount: secondSellAmount,
      pricePerToken: secondSellPrice,
      minFillAmount: 0,
      expiry: 0,
      direction: sellDir,
    });

    // Execute market SELL NO order (automatically finds merge match with YES orders)
    // Use complement price of secondSellPrice (the better price)
    const noPrice = ethers.utils.parseUnits("1", erc20Decimals).sub(secondSellPrice);
    await createMarketOrder(orderCreationFacet, taker, {
      positionId: noId,
      collateralToken: erc20.address,
      amount: marketFillAmount,
      pricePerToken: noPrice,
      direction: sellDir,
      fillOrKill: false,
    });

    // Balances after
    const makerYesAfter = await erc1155.balanceOf(maker.address, yesId);
    const takerNoAfter = await erc1155.balanceOf(taker.address, noId);
    const makerERC20After = await erc20.balanceOf(maker.address);
    const takerERC20After = await erc20.balanceOf(taker.address);

    console.log("makerYesAfter", makerYesAfter);
    console.log("takerNoAfter", takerNoAfter);
    console.log("makerERC20After", makerERC20After);
    console.log("takerERC20After", takerERC20After);

    console.log("amount", marketFillAmount);
    console.log("makerRecieve", makerRecieve);
    console.log("takerReceive", takerReceive);

    console.log("makerYesBefore", makerYesBefore);
    console.log("takerNoBefore", takerNoBefore);
    console.log("makerERC20Before", makerERC20Before);
    console.log("takerERC20Before", takerERC20Before);

    expect(takerNoBefore.sub(takerNoAfter)).to.equal(marketFillAmount);
    expect(makerYesBefore.sub(worstOrderAmountNotMatched)).to.equal(
      marketFillAmount
    ); // the rest is still lock in the order.
    expect(makerERC20After.sub(makerERC20Before)).to.equal(makerRecieve);
    expect(takerERC20After.sub(takerERC20Before)).to.equal(takerReceive);
  });
});
