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

describe("Exchange Facet - Limit Orders", function () {
  let owner, user, maker, oracle, taker;
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
    console.log("Fee Config:", feeConfig);

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

  it("should create a BUY limit order", async () => {
    const amount = ethers.utils.parseEther("10");
    const price = ethers.utils.parseEther("0.5");
    const minFill = ethers.utils.parseEther("2");
    const expiry = 0;

    await mintAndApproveERC20({
      token: erc20,
      minter: maker,
      to: maker,
      amount: mintAmount,
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
      minFillAmount: minFill,
      expiry: expiry,
      direction: sellDir,
    });

    const orderId = (await exchangeFacet.callStatic.getNextOrderId()) - 1;
    const order = await exchangeFacet.callStatic.getOrder(orderId);

    expect(order.amount).to.equal(amount);
    console.log("Price per token:", order.pricePerToken, " Price: ", price);
    expect(order.pricePerToken).to.equal(price);
    expect(order.direction).to.equal(sellDir);
    expect(order.active).to.equal(true);
  });

  it("should insert a SELL order sorted by lowest price", async () => {
    const amount = ethers.utils.parseEther("5");

    await createLimitOrder(exchangeFacet, owner, {
      positionId: yesId,
      collateralToken: erc20.address,
      amount,
      pricePerToken: ethers.utils.parseEther("0.7"),
      minFillAmount: amount,
      expiry: 0,
      direction: sellDir,
    });

    await createLimitOrder(exchangeFacet, owner, {
      positionId: yesId,
      collateralToken: erc20.address,
      amount,
      pricePerToken: ethers.utils.parseEther("0.6"),
      minFillAmount: amount,
      expiry: 0,
      direction: sellDir,
    });

    const book = await exchangeFacet.getOrderbook(yesId, sellDir);
    expect(book.length).to.equal(2);

    const order1 = await exchangeFacet.getOrder(book[0]);
    const order2 = await exchangeFacet.getOrder(book[1]);

    expect(order1.pricePerToken.lt(order2.pricePerToken)).to.be.true;
  });

  it("should revert if user lacks enough ERC20 collateral", async () => {
    const amount = ethers.utils.parseEther("10000");
    const price = ethers.utils.parseEther("0.9");
    const makerFee = amount.mul(200).div(10000);
    const requiredTotal = amount.add(makerFee);

    await erc20.connect(maker).approve(diamondAddress, requiredTotal);

    await expect(
      createLimitOrder(exchangeFacet, maker, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: price,
        minFillAmount: amount,
        expiry: 0,
        direction: buyDir,
      })
    ).to.be.revertedWith("ERC20InsufficientBalance");
  });

  it("should revert if pricePerToken exceeds unit price set by admin", async () => {
    const amount = ethers.utils.parseEther("10");
    const overPrice = ethers.utils.parseEther("2"); // Higher than unit price of 1 set in before hook
    const minFill = amount;
    const expiry = 0;

    await erc20.mint(maker.address, mintAmount);
    await erc20.connect(maker).approve(diamondAddress, mintAmount);

    await expect(
      exchangeFacet.connect(maker).createLimitOrder(
        yesId,
        erc20.address,
        amount,
        overPrice,
        minFill,
        expiry,
        0 // BUY
      )
    ).to.be.revertedWith("InvalidPrice()");
  });

  it("should deduct ERC20 balance correctly with maker fee on BUY order", async () => {
    const price = ethers.utils.parseEther("0.5");
    const amount = ethers.utils.parseEther("4");

    const baseCost = amount.mul(price).div(ethers.constants.WeiPerEther);
    const makerFee = baseCost.mul(feeConfig.makerBps).div(10_000); // % fee in ERC20
    const totalCost = baseCost.add(makerFee);
    const minFill = ethers.utils.parseEther("2");

    await erc20.mint(maker.address, totalCost);
    await erc20.connect(maker).approve(diamondAddress, totalCost);

    const balanceBefore = await erc20.balanceOf(maker.address);

    await createLimitOrder(exchangeFacet, maker, {
      positionId: yesId,
      collateralToken: erc20.address,
      amount,
      pricePerToken: price,
      minFillAmount: minFill,
      expiry: 0,
      direction: buyDir,
    });

    const balanceAfter = await erc20.balanceOf(maker.address);

    console.log("Maker Balance before:", balanceBefore);
    console.log("Maker Balance after:", balanceAfter);

    expect(balanceBefore.sub(balanceAfter)).to.equal(totalCost);
  });

  it("should cancel a partially filled order", async () => {
    const amount = ethers.utils.parseEther("10");
    const price = ethers.utils.parseEther("0.9");

    await erc20.mint(user.address, mintAmount);
    await erc20.connect(user).approve(diamondAddress, mintAmount);

    const tx = await exchangeFacet.connect(user).createLimitOrder(
      yesId,
      erc20.address,
      amount,
      price,
      amount,
      0,
      0 // BUY
    );

    const balanceBefore = await erc20.balanceOf(user.address);

    const receipt = await tx.wait();
    const orderId = (await exchangeFacet.callStatic.getNextOrderId()) - 1;

    await exchangeFacet.connect(user).cancelOrder(orderId);

    const balanceAfter = await erc20.balanceOf(user.address);

    // const balanceAfter = await erc20.balanceOf(maker.address);
    const order = await exchangeFacet.callStatic.getOrder(orderId);

    expect(order.active).to.be.false;
    expect(balanceAfter.gt(balanceBefore)).to.be.true;

    const book = await exchangeFacet.getOrderbook(yesId, 0);
    expect(book).to.not.include(orderId);
  });

  it("should cancel an expired order", async () => {
    const amount = ethers.utils.parseEther("10");
    const price = ethers.utils.parseEther("0.8");

    const expiry = Math.floor(Date.now() / 1000) + 50; // 50 seconds

    await erc20.mint(maker.address, mintAmount);
    await erc20.connect(maker).approve(diamondAddress, mintAmount);

    const tx = await exchangeFacet.connect(maker).createLimitOrder(
      yesId,
      erc20.address,
      amount,
      price,
      amount,
      expiry,
      0 // BUY
    );

    const orderId = (await exchangeFacet.callStatic.getNextOrderId()) - 1;

    await ethers.provider.send("evm_increaseTime", [10]);
    await ethers.provider.send("evm_mine");

    const balanceBefore = await erc20.balanceOf(maker.address);

    await exchangeFacet.connect(maker).cancelOrder(orderId);

    const balanceAfter = await erc20.balanceOf(maker.address);
    const order = await exchangeFacet.callStatic.getOrder(orderId);

    expect(order.active).to.be.false;
    expect(balanceAfter.gt(balanceBefore)).to.be.true;

    const book = await exchangeFacet.getOrderbook(yesId, 0);
    expect(book).to.not.include(orderId);
  });

  it("should revert if non-maker tries to cancel the order", async () => {
    const amount = ethers.utils.parseEther("10");
    const price = ethers.utils.parseEther("0.5");

    await erc20.mint(maker.address, mintAmount);
    await erc20.connect(maker).approve(diamondAddress, mintAmount);

    const tx = await exchangeFacet.connect(maker).createLimitOrder(
      yesId,
      erc20.address,
      amount,
      price,
      amount,
      0,
      0 // BUY
    );

    const orderId = (await exchangeFacet.callStatic.getNextOrderId()) - 1;

    await expect(
      exchangeFacet.connect(taker).cancelOrder(orderId)
    ).to.be.revertedWith("NotAuthorizedToCancel()");
  });
});
