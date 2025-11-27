// test/unit/facets/RouteSimulationFacet.sorting.test.js

const { expect } = require("chai");
const { ethers } = require("hardhat");

const { deployDiamond } = require("../../../scripts/deploy.js");
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

describe("RouteSimulationFacet - Sorting and Match Order", function () {
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

  it("should match best price first, regardless of creation order", async () => {
    const amount = ethers.utils.parseEther("5");
    const prices = ["0.9", "0.7", "0.8"];

    for (let i = 0; i < prices.length; i++) {
      const price = ethers.utils.parseEther(prices[i]);
      await mintAndApproveERC20({
        to: maker,
        minter: owner,
        token: erc20,
        amount: amount,
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
        direction: 1, // SELL
      });
    }

    const route = await simulateAndParseMatchRoute({
      routeSimFacet,
      positionId: yesId,
      amount,
      direction: 0, // BUY
    });

    expect(route.matches.length).to.equal(1);
    expect(route.matches[0].effectivePrice).to.equal(
      ethers.utils
        .parseEther("0.7")
        .add(ethers.utils.parseEther("0.7").mul(feeConfig.takerBps).div(10000))
    );
  });
});
