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
const { createLimitOrder } = require("../../utils/orderUtils.js");
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
    erc20Decimals = 6; // Mock token with 6 decimals
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

    // ercUnit = ethers.utils.parseEther("1") // 18 Decimals
    ercUnit = ethers.utils.parseUnits("1", erc20Decimals); // 6 Decimals

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

  it("should execute a BUY market order using Complementary match route", async () => {
    const price = ethers.utils.parseUnits("0.7", erc20Decimals);
    const amount = ethers.utils.parseUnits("5", erc20Decimals);

    console.log("price per token", price.toString());
    console.log("ercUnit", ercUnit);
    console.log("amount", amount.toString());

    const baseCost = amount.mul(price).div(ercUnit);
    console.log("baseCosts", baseCost.toString());

    const makerFee = baseCost.mul(feeConfig.makerBps).div(10_000); // % fee in ERC20
    const makerRecieve = baseCost.sub(makerFee);
    console.log("makerRecieve", makerRecieve.toString());

    // Setup fee config
    const takerFee = baseCost.mul(feeConfig.takerBps).div(10_000);
    const totalCost = baseCost.add(takerFee);
    console.log("totalCost", totalCost.toString());

    // Fund maker and taker
    await mintAndApproveERC20({
      token: erc20,
      minter: owner,
      to: taker,
      amount: totalCost,
      spender: diamondAddress,
    });

    console.log(
      "taker balance",
      (await erc20.balanceOf(taker.address)).toString()
    );

    await mintAndApproveERC20({
      token: erc20,
      minter: owner,
      to: maker,
      amount: amount.mul(2),
      spender: diamondAddress,
    });

    console.log(
      "maker balance",
      (await erc20.balanceOf(maker.address)).toString()
    );

    await erc1155
      .connect(owner)
      .safeTransferFrom(
        owner.address,
        maker.address,
        yesId,
        ethers.utils.parseUnits("10", erc20Decimals),
        "0x"
      );
    await erc1155.connect(maker).setApprovalForAll(diamondAddress, true);

    console.log(
      "maker balance after transfer",
      (await erc1155.balanceOf(maker.address, yesId)).toString()
    );

    // Maker creates SELL order for YES (complementary)
    await createLimitOrder(orderCreationFacet, maker, {
      positionId: yesId,
      collateralToken: erc20.address,
      amount,
      pricePerToken: price,
      minFillAmount: amount,
      expiry: 0,
      direction: sellDir,
    });

    // Simulate route
    const route = await simulateAndParseMatchRoute({
      routeSimFacet,
      positionId: yesId,
      amount: totalCost,
      direction: buyDir,
    });

    // Balances before execution
    const taker1155Before = await erc1155.balanceOf(taker.address, yesId);
    const takerERC20Before = await erc20.balanceOf(taker.address);
    const makerERC20Before = await erc20.balanceOf(maker.address);

    const effectiveBuyPrice = route.totalOutputAmount
      .mul(ercUnit)
      .div(route.totalInputAmount);
    console.log("effectiveBuyPrice", effectiveBuyPrice.toString());

    console.log("Routes:", route);

    // Execute fill
    await matchExecutionFacet.connect(taker).fillMarketOrderWithRoute(
      yesId,
      amount,
      effectiveBuyPrice, // targetAvgPrice
      false, // fillOrKill
      buyDir,
      route.matches.map((m) => [
        m.matchedOrderId,
        m.amount,
        m.effectivePrice,
        m.matchType,
      ])
    );

    // Balances after execution
    const taker1155After = await erc1155.balanceOf(taker.address, yesId);
    const takerERC20After = await erc20.balanceOf(taker.address);
    const makerERC20After = await erc20.balanceOf(maker.address);

    console.log("taker1155After", taker1155After);
    console.log("taker1155Before", taker1155Before);

    console.log("takerERC20After", takerERC20After);
    console.log("takerERC20Before", takerERC20Before);

    console.log("makerERC20After", makerERC20After);
    console.log("makerERC20Before", makerERC20Before);

    console.log("amount", amount);
    console.log("makerRecieve", makerRecieve);

    // ✅ Taker receives YES tokens
    expect(taker1155After.sub(taker1155Before)).to.equal(amount);

    // ✅ Taker lost totalCost (including fee)
    console.log(
      "total retrieved cost:",
      takerERC20Before.sub(takerERC20After).toString()
    );
    console.log("totalCost", totalCost.toString());

    expect(takerERC20Before.sub(takerERC20After)).to.equal(totalCost);
    console.log("It's fine.");

    // ✅ Maker received price * amount (no fee deducted from maker)
    expect(makerERC20After.sub(makerERC20Before)).to.equal(makerRecieve);
  });

  it("should execute a SELL market order using Complementary match route", async () => {
    const price = ethers.utils.parseUnits("0.5", erc20Decimals);
    const amount = ethers.utils.parseUnits("4", erc20Decimals);

    const baseCost = amount.mul(price).div(ercUnit);

    const makerFee = baseCost.mul(feeConfig.makerBps).div(10_000); // % fee in ERC20
    const makerLocked = baseCost.add(makerFee);

    // Setup fee config
    const takerFee = baseCost.mul(feeConfig.takerBps).div(10_000);
    const totalReceive = baseCost.sub(takerFee);

    await erc1155
      .connect(owner)
      .safeTransferFrom(owner.address, taker.address, yesId, amount, "0x");
    await erc1155.connect(taker).setApprovalForAll(diamondAddress, true);

    // Fund maker with collateral and approve
    await mintAndApproveERC20({
      token: erc20,
      minter: owner,
      to: maker,
      amount: makerLocked,
      spender: diamondAddress,
    });

    const makerERC20Before = await erc20.balanceOf(maker.address);

    // Maker places BUY order for YES (complementary)
    await createLimitOrder(orderCreationFacet, maker, {
      positionId: yesId,
      collateralToken: erc20.address,
      amount,
      pricePerToken: price,
      minFillAmount: amount,
      expiry: 0,
      direction: buyDir,
    });

    // Approve taker's ERC1155
    await erc1155.connect(taker).setApprovalForAll(diamondAddress, true);

    // Simulate match
    const route = await simulateAndParseMatchRoute({
      routeSimFacet,
      positionId: yesId,
      amount,
      direction: sellDir,
    });

    // Balances before
    const takerERC20Before = await erc20.balanceOf(taker.address);
    const taker1155Before = await erc1155.balanceOf(taker.address, yesId);

    console.log("Route matches:", route);

    const effectiveSellPrice = route.totalOutputAmount
      .mul(ercUnit)
      .div(route.totalInputAmount);

    // Execute fill
    await matchExecutionFacet.connect(taker).fillMarketOrderWithRoute(
      yesId,
      amount,
      effectiveSellPrice, // target avg price
      false,
      sellDir,
      route.matches.map((m) => [
        m.matchedOrderId,
        m.amount,
        m.effectivePrice,
        m.matchType,
      ])
    );

    // Balances after
    const takerERC20After = await erc20.balanceOf(taker.address);
    const taker1155After = await erc1155.balanceOf(taker.address, yesId);
    const makerERC20After = await erc20.balanceOf(maker.address);

    // ✅ Taker loses YES tokens
    expect(taker1155Before.sub(taker1155After)).to.equal(amount);

    // ✅ Taker receives collateral minus taker fee
    expect(takerERC20After.sub(takerERC20Before)).to.equal(totalReceive);

    // ✅ Maker lost full locked amount (price * amount)
    expect(makerERC20Before.sub(makerERC20After)).to.equal(makerLocked);
  });
});
