const { deployDiamond } = require("../../../scripts/deploy.js");
const { expect } = require("chai");
const { ethers } = require("hardhat");

const { deployMockERC20 } = require("../../mock/deployMocks.js");
const { getConditionId } = require("../../utils/ctfUtils.js");
const { addCollateralToken } = require("../../utils/adminConfigUtils.js");
const { mintAndApproveERC20 } = require("../../utils/erc20Utils.js");
const { splitConditionAndGetPositionIds } = require("../../utils/conditionUtils.js");
const { createLimitOrder } = require("../../utils/orderUtils.js");
const { takeSnapshot, revertToSnapshot } = require("../../utils/snapshotUtils.js");

describe("ExchangeFacet - modifyLimitOrder", function () {
  let owner, maker, taker, oracle;
  let diamondAddress,
    orderCreationFacet,
    orderManagementFacet,
    exchangeViewFacet,
    erc20,
    erc1155,
    conditionalFacet,
    conditionManagerFacet,
    adminConfig;
  let yesId, unit, mintAmount, sellDir, buyDir;

  before(async function () {
    [owner, maker, taker, oracle] = await ethers.getSigners();
    erc20 = await deployMockERC20("MockToken", "MOCK");

    buyDir = 0;
    sellDir = 1;
    unit = ethers.utils.parseEther("1");
    mintAmount = ethers.utils.parseEther("100");

    diamondAddress = await deployDiamond();
    orderCreationFacet = await ethers.getContractAt(
      "OrderCreationFacet",
      diamondAddress
    );
    orderManagementFacet = await ethers.getContractAt(
      "OrderManagementFacet",
      diamondAddress
    );
    exchangeViewFacet = await ethers.getContractAt(
      "ExchangeViewFacet",
      diamondAddress
    );
    erc1155 = await ethers.getContractAt("ERC1155Facet", diamondAddress);
    conditionalFacet = await ethers.getContractAt("ConditionalTokensFacet", diamondAddress);
    conditionManagerFacet = await ethers.getContractAt("ConditionManagerFacet", diamondAddress);
    adminConfig = await ethers.getContractAt("AdminConfigFacet", diamondAddress);

    const accessControlFacet = await ethers.getContractAt("AccessControlFacet", diamondAddress);
    await accessControlFacet.addMarketMaker(owner.address);
    await addCollateralToken({ adminConfig, token: erc20, unit, caller: owner });

    const questionId = ethers.utils.id("modify-limit-test");
    const outcomeSlotCount = 2;
    const conditionId = getConditionId(oracle.address, questionId, outcomeSlotCount);
    await conditionManagerFacet.connect(owner).createCondition(oracle.address, questionId, outcomeSlotCount, "ipfs://dummy");

    await mintAndApproveERC20({ token: erc20, minter: owner, to: owner, amount: mintAmount, spender: diamondAddress });

    const [positionIds] = await splitConditionAndGetPositionIds({
      user: owner,
      amount: unit.mul(100),
      conditionId,
      indexSets: [1, 2],
      erc20,
      conditionalFacet,
    });

    yesId = positionIds[0];
    await erc1155.connect(owner).setApprovalForAll(diamondAddress, true);
  });

  let snapshotId;
  beforeEach(async () => { snapshotId = await takeSnapshot(); });
  afterEach(async () => { await revertToSnapshot(snapshotId); });

  it("should allow the maker to modify an active order", async function () {
    const amount = ethers.utils.parseEther("5");
    const price = ethers.utils.parseEther("0.5");

    await createLimitOrder(orderCreationFacet, owner, {
      positionId: yesId, collateralToken: erc20.address, amount,
      pricePerToken: price, minFillAmount: amount, expiry: 0, direction: sellDir,
    });

    const orderId = (await exchangeViewFacet.callStatic.getNextOrderId()) - 1;
    const newAmount = ethers.utils.parseEther("10");
    const newPrice = ethers.utils.parseEther("0.3");
    const newMinFill = ethers.utils.parseEther("5");
    const newExpiry = Math.floor(Date.now() / 1000) + 3600;

    await expect(orderManagementFacet.modifyLimitOrder(orderId, newAmount, newPrice, newMinFill, newExpiry))
      .to.emit(orderManagementFacet, "OrderModified")
      .withArgs(orderId, owner.address, amount, newAmount, price, newPrice, amount, newMinFill, 0, newExpiry);

    const modified = await exchangeViewFacet.getOrder(orderId);
    expect(modified.amount).to.equal(newAmount);
    expect(modified.pricePerToken).to.equal(newPrice);
    expect(modified.minFillAmount).to.equal(newMinFill);
    expect(modified.expiry).to.equal(newExpiry);
  });

  it("should revert if non-maker tries to modify the order", async function () {
    const amount = ethers.utils.parseEther("5");
    const price = ethers.utils.parseEther("0.5");
    await createLimitOrder(orderCreationFacet, owner, {
      positionId: yesId, collateralToken: erc20.address, amount,
      pricePerToken: price, minFillAmount: amount, expiry: 0, direction: sellDir,
    });
    const orderId = (await exchangeViewFacet.callStatic.getNextOrderId()) - 1;
    await expect(orderManagementFacet.connect(maker).modifyLimitOrder(orderId, amount, price, amount, 0))
      .to.be.revertedWith("NotAuthorizedToCancel()");
  });

  it("should revert if trying to modify an expired order", async function () {
    const amount = ethers.utils.parseEther("5");
    const price = ethers.utils.parseEther("0.5");
    const expiry = Math.floor(Date.now() / 1000) + 1000;
    await createLimitOrder(orderCreationFacet, owner, {
      positionId: yesId, collateralToken: erc20.address, amount,
      pricePerToken: price, minFillAmount: amount, expiry, direction: sellDir,
    });
    const orderId = (await exchangeViewFacet.callStatic.getNextOrderId()) - 1;
    await ethers.provider.send("evm_increaseTime", [2000]);
    await ethers.provider.send("evm_mine");
    await expect(orderManagementFacet.modifyLimitOrder(orderId, amount, price, amount, expiry + 100))
      .to.be.revertedWith("OrderExpired()");
  });

  it("should revert if order is partially filled", async function () {
    const amount = ethers.utils.parseEther("5");
    const sellPrice = ethers.utils.parseEther("0.5");
    const buyPrice = ethers.utils.parseEther("0.52");
    const buyAmount = ethers.utils.parseEther("2");

    await createLimitOrder(orderCreationFacet, owner, {
      positionId: yesId,
      collateralToken: erc20.address,
      amount,
      pricePerToken: sellPrice,
      minFillAmount: buyAmount,
      expiry: 0,
      direction: sellDir,
    });

    const orderId = (await exchangeViewFacet.callStatic.getNextOrderId()) - 1;

    await mintAndApproveERC20({
      token: erc20,
      minter: owner,
      to: taker,
      amount: buyAmount,
      spender: diamondAddress,
    });
    tx = await createLimitOrder(orderCreationFacet, taker, {
      positionId: yesId,
      collateralToken: erc20.address,
      amount: buyAmount,
      pricePerToken: buyPrice,
      minFillAmount: buyAmount,
      expiry: 0,
      direction: buyDir,
    });

    orderDetail = await exchangeViewFacet.getOrder(orderId);
    newPrice = ethers.utils.parseEther("0.61");
    await expect(orderManagementFacet.modifyLimitOrder(orderId, amount, newPrice, amount, 0))
      .to.be.revertedWith("PartiallyFilledOrdersNotModifiable()");
  });
});