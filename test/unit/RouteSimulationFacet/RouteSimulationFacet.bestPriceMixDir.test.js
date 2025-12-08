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

describe("RouteSimulationFacet", function () {
  let owner, user, maker, oracle, taker;
  let diamondAddress,
    routeSimFacet,
    orderCreationFacet,
    erc20,
    ercUnit,
    erc1155,
    conditionalFacet,
    conditionManagerFacet,
    adminConfig;
  let questionId, conditionId, yesId, noId;
  let mintAmount, unit;
  let buyDir, sellDir, feeConfig;
  let snapshotId;

  before(async function () {
    [owner, user, maker, oracle, taker] = await ethers.getSigners();

    erc20 = await deployMockERC20("MockToken", "MOCK");

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

    ercUnit = ethers.utils.parseEther("1");

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

    unit = ethers.utils.parseEther("1");
    mintAmount = ethers.utils.parseEther("120");

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

  it("should match across Complementary and Mint orders for Sell Market Order", async () => {
    const compPrice = ethers.utils.parseEther("0.65"); // Complementary (Sell YES)
    const mintPrice = ethers.utils.parseEther("0.66"); // Limit Buy No at 0.65, means could be matched with Buy Y at 0.35
    const mergePrice = ethers.utils.parseEther("0.67"); // Merge (Buy YES, Sell NO)
    const amount = ethers.utils.parseEther("3");
    const simAmount = amount.mul(2);

    // Fund maker for multiple orders
    await mintAndApproveERC20({
      to: maker,
      minter: owner,
      token: erc20,
      amount: amount.mul(10),
      spender: diamondAddress,
    });

    await erc1155
      .connect(owner)
      .safeTransferFrom(owner.address, maker.address, yesId, amount, "0x");

    await erc1155.connect(maker).setApprovalForAll(diamondAddress, true);
    // Complementary: Sell YES
    await createLimitOrder(orderCreationFacet, maker, {
      positionId: yesId,
      collateralToken: erc20.address,
      amount,
      pricePerToken: compPrice,
      minFillAmount: amount,
      expiry: 0,
      direction: sellDir,
    });

    // Mint: Buy No
    await createLimitOrder(orderCreationFacet, maker, {
      positionId: noId,
      collateralToken: erc20.address,
      amount,
      pricePerToken: mintPrice,
      minFillAmount: amount,
      expiry: 0,
      direction: buyDir,
    });

    const route = await simulateAndParseMatchRoute({
      routeSimFacet,
      positionId: yesId,
      amount: amount.mul(2),
      direction: buyDir,
    });

    expect(route.totalInputAmount).to.equal(amount.mul(2));
    expect(route.matches.length).to.equal(2);

    // Assert the order of execution by price
    const prices = route.matches.map((m) => m.effectivePrice.toString());
    const sorted = [...prices].sort((a, b) =>
      BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0
    );
    expect(prices).to.deep.equal(sorted);
    const matchTypes = route.matches.map((m) => m.matchTypeLabel);
    expect(matchTypes).to.deep.equal(["Mint", "Complementary"]);
  });

  it("should match across Complementary and Merge orders for Sell Market Order", async () => {
    const compPrice = ethers.utils.parseEther("0.72"); // Complementary (Buy YES)
    const mintPrice = ethers.utils.parseEther("0.69"); // Mint (Sell NO)
    const amount = ethers.utils.parseEther("3");

    // Fund maker for multiple orders
    await mintAndApproveERC20({
      to: maker,
      minter: owner,
      token: erc20,
      amount: amount.mul(10),
      spender: diamondAddress,
    });

    // Complementary: Buy YES
    await createLimitOrder(orderCreationFacet, maker, {
      positionId: yesId,
      collateralToken: erc20.address,
      amount,
      pricePerToken: compPrice,
      minFillAmount: amount,
      expiry: 0,
      direction: buyDir,
    });

    await erc1155
      .connect(owner)
      .safeTransferFrom(owner.address, maker.address, yesId, amount, "0x");

    await erc1155
      .connect(owner)
      .safeTransferFrom(owner.address, maker.address, noId, amount, "0x");
    await erc1155.connect(maker).setApprovalForAll(diamondAddress, true);

    // Mint: Sell NO
    await createLimitOrder(orderCreationFacet, maker, {
      positionId: noId,
      collateralToken: erc20.address,
      amount,
      pricePerToken: mintPrice,
      minFillAmount: amount,
      expiry: 0,
      direction: sellDir,
    });

    const simulationAmount = amount.mul(2);
    // Simulate selling YES (market sell)
    const route = await simulateAndParseMatchRoute({
      routeSimFacet,
      positionId: yesId,
      amount: simulationAmount,
      direction: sellDir,
    });

    expect(route.totalInputAmount).to.equal(simulationAmount);
    expect(route.matches.length).to.equal(2);

    // Assert price ordering
    const prices = route.matches.map((m) => m.effectivePrice.toString());
    const sorted = [...prices].sort((a, b) =>
      BigInt(a) > BigInt(b) ? -1 : BigInt(a) < BigInt(b) ? 1 : 0
    );
    expect(prices).to.deep.equal(sorted);

    // Assert match types
    const matchTypes = route.matches.map((m) => m.matchTypeLabel);
    expect(matchTypes).to.deep.equal(["Complementary", "Merge"]);
  });
});
