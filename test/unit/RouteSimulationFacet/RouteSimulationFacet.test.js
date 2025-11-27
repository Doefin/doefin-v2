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
    exchangeFacet,
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

    exchangeFacet = await ethers.getContractAt("ExchangeFacet", diamondAddress);
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

  it("should simulate a BUY market order and return a match route", async () => {
    const price = ethers.utils.parseEther("0.7");
    const amount = ethers.utils.parseEther("5");

    const takerFee = price.mul(feeConfig.takerBps).div(10000);
    const expectedEffectivePrice = price.add(takerFee);

    await mintAndApproveERC20({
      to: maker,
      minter: owner,
      token: erc20,
      amount: amount.mul(2),
      spender: diamondAddress,
    });

    await erc1155
      .connect(owner)
      .safeTransferFrom(owner.address, maker.address, yesId, amount, "0x");
    await erc1155.connect(maker).setApprovalForAll(diamondAddress, true);

    await createLimitOrder(exchangeFacet, maker, {
      positionId: yesId,
      collateralToken: erc20.address,
      amount,
      pricePerToken: price,
      minFillAmount: amount,
      expiry: 0,
      direction: sellDir,
    });

    const expectedOrderId =
      (await exchangeFacet.callStatic.getNextOrderId()) - 1;

    const parsedRoute = await simulateAndParseMatchRoute({
      routeSimFacet,
      positionId: yesId,
      amount,
      direction: buyDir,
    });

    console.log("Parsed routes:", parsedRoute);

    const match = parsedRoute.matches[0];

    expect(match.matchedOrderId).to.equal(expectedOrderId);
    expect(match.amount).to.equal(amount);
    expect(match.effectivePrice).to.equal(expectedEffectivePrice);
    expect(match.matchType).to.equal(0);
  });
});
