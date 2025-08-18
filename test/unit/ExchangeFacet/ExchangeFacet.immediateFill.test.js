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
const {
  createLimitOrder,
  validateOrderState,
} = require("../../utils/orderUtils.js");
const {
  takeSnapshot,
  revertToSnapshot,
} = require("../../utils/snapshotUtils.js");

describe("Exchange Facet - Advanced Test Cases", function () {
  let owner, user, maker, oracle, taker, maker2, maker3;
  let diamondAddress,
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
    [owner, user, maker, oracle, taker, maker2, maker3] =
      await ethers.getSigners();

    erc20 = await deployMockERC20("MockToken", "MOCK");

    buyDir = 0; // LibDoefinStorage.OrderDirection.Buy
    sellDir = 1; // LibDoefinStorage.OrderDirection.Sell

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
    const accessControlFacet = await ethers.getContractAt(
      "AccessControlFacet",
      diamondAddress
    );

    await accessControlFacet.addMarketMaker(owner.address);

    ercUnit = ethers.utils.parseEther("1");

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
    mintAmount = ethers.utils.parseEther("100");

    await mintAndApproveERC20({
      token: erc20,
      minter: owner,
      to: owner,
      amount: mintAmount,
      spender: diamondAddress,
    });

    const [positionIds, _amounts] = await splitConditionAndGetPositionIds({
      user: owner,
      amount: unit.mul(100),
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

  it("should immediately match with complementary order when prices cross", async () => {
    const amount = ethers.utils.parseEther("1");
    const sellPrice = ethers.utils.parseEther("0.5");
    const buyPrice = ethers.utils.parseEther("0.51");
    const takerToPay = amount.mul(2)

    await erc1155
      .connect(owner)
      .safeTransferFrom(owner.address, taker.address, yesId, amount, "0x");
    await erc1155.connect(taker).setApprovalForAll(diamondAddress, true);

    await createLimitOrder(exchangeFacet, taker, {
      positionId: yesId,
      collateralToken: erc20.address,
      amount,
      pricePerToken: sellPrice,
      minFillAmount: amount,
      expiry: 0,
      direction: sellDir,
    });

    await mintAndApproveERC20({
      token: erc20,
      minter: owner,
      to: maker,
      amount: takerToPay,
      spender: diamondAddress,
    });

    const sellOrderId = (await exchangeFacet.callStatic.getNextOrderId()) - 1;

    tx = await createLimitOrder(exchangeFacet, maker, {
      positionId: yesId,
      collateralToken: erc20.address,
      amount,
      pricePerToken: buyPrice,
      minFillAmount: amount,
      expiry: 0,
      direction: buyDir,
    });

    // 3. Wait for transaction receipt (optional, for event/logs)
    const receipt = await tx.wait();

    // 4. (Optional) Check for RefundSurplus event
    const refundEvents = receipt.events.filter(e => e.event === "RefundSurplus");
    refundEvents.forEach(e => {
      console.log("RefundSurplus:", e.args);
    });
    
    const buyOrderId = (await exchangeFacet.callStatic.getNextOrderId()) - 1;

    const buyOrder = await exchangeFacet.getOrder(buyOrderId);
    const sellOrder = await exchangeFacet.getOrder(sellOrderId);

    expect(buyOrder.active).to.equal(false);
    expect(buyOrder.remainingAmount).to.equal(0);
    expect(sellOrder.active).to.equal(false);
    expect(sellOrder.remainingAmount).to.equal(0);

    const buyBook = await exchangeFacet.getOrderbook(yesId, buyDir);
    const sellBook = await exchangeFacet.getOrderbook(yesId, sellDir);
    expect(buyBook.length).to.equal(0);
    expect(sellBook.length).to.equal(0);
  });
  
  it("should leave order on book when no matching orders exist", async () => {
    const amount = ethers.utils.parseEther("2");
    const price = ethers.utils.parseEther("0.5");

    await mintAndApproveERC20({
      token: erc20,
      minter: owner,
      to: maker,
      amount: mintAmount,
      spender: diamondAddress,
    });

    await createLimitOrder(exchangeFacet, maker, {
      positionId: yesId,
      collateralToken: erc20.address,
      amount,
      pricePerToken: price,
      minFillAmount: amount,
      expiry: 0,
      direction: buyDir,
    });

    const orderId = (await exchangeFacet.callStatic.getNextOrderId()) - 1;
    const order = await exchangeFacet.getOrder(orderId);

    expect(order.active).to.equal(true);
    expect(order.remainingAmount).to.equal(amount);
  });
});