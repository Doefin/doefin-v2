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

describe("MarketExecutionFacet limit order matching", function () {
  let owner, maker1, maker2, taker, oracle;
  let diamondAddress,
    exchangeFacet,
    matchExecutionFacet,
    erc20,
    erc1155,
    conditionalFacet,
    conditionManagerFacet,
    adminConfig;
  let yesId, noId;
  const erc20Decimals = 6;
  let buyDir, sellDir, ercUnit, feeConfig;
  let snapshotId;

  before(async function () {
    [owner, maker1, maker2, taker, oracle] = await ethers.getSigners();

    erc20 = await deployMockERC20("MockToken", "MOCK", erc20Decimals);
    buyDir = 0;
    sellDir = 1;

    diamondAddress = await deployDiamond();
    exchangeFacet = await ethers.getContractAt("ExchangeFacet", diamondAddress);
    matchExecutionFacet = await ethers.getContractAt(
      "MarketExecutionFacet",
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
    const accessControlFacet = await ethers.getContractAt(
      "AccessControlFacet",
      diamondAddress
    );
    await accessControlFacet.addMarketMaker(owner.address);

    ercUnit = ethers.utils.parseUnits("1", erc20Decimals);
    await addCollateralToken({
      adminConfig,
      token: erc20,
      unit: ercUnit,
      caller: owner,
    });
    feeConfig = await getFees(adminConfig);

    const mintAmount = ethers.utils.parseUnits("100", erc20Decimals);
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

    const questionId = ethers.utils.id("limit-matching-question");
    const outcomeSlotCount = 2;
    const conditionId = getConditionId(
      oracle.address,
      questionId,
      outcomeSlotCount
    );
    await conditionManagerFacet
      .connect(owner)
      .createCondition(
        oracle.address,
        questionId,
        outcomeSlotCount,
        "ipfs://dummy"
      );

    const [positionIds, _amounts] = await splitConditionAndGetPositionIds({
      user: owner,
      amount: ercUnit.mul(30),
      conditionId,
      indexSets: [1, 2],
      erc20,
      conditionalFacet,
    });
    yesId = positionIds[0];
    noId = positionIds[1];

    await erc1155.connect(owner).setApprovalForAll(diamondAddress, true);

    const maker1Amount = ethers.utils.parseUnits("10", erc20Decimals);
    const maker2Amount = ethers.utils.parseUnits("10", erc20Decimals);
    await sendAndApproveERC1155({
      token: erc1155,
      sender: owner,
      to: maker1,
      tokenId: yesId,
      spender: diamondAddress,
      amount: maker1Amount,
    });
    await sendAndApproveERC1155({
      token: erc1155,
      sender: owner,
      to: maker2,
      tokenId: yesId,
      spender: diamondAddress,
      amount: maker2Amount,
    });
  });

  beforeEach(async () => {
    snapshotId = await takeSnapshot();
  });

  afterEach(async () => {
    await revertToSnapshot(snapshotId);
  });

  it("matches two crossing limit orders and removes them when filled", async () => {
    const priceSell = ethers.utils.parseUnits("0.4", erc20Decimals);
    const priceBuy = ethers.utils.parseUnits("0.5", erc20Decimals);
    const amount = ethers.utils.parseUnits("5", erc20Decimals);

    const takerFee = priceSell.mul(feeConfig.takerBps).div(10_000);
    const takerExpectedPrice = priceSell.add(takerFee);

    const makerOrderId = await exchangeFacet.getNextOrderId();
    await createLimitOrder(exchangeFacet, maker1, {
      positionId: yesId,
      collateralToken: erc20.address,
      amount,
      pricePerToken: priceSell,
      minFillAmount: amount,
      expiry: 0,
      direction: sellDir,
    });

    const takerOrderId = await exchangeFacet.getNextOrderId();
    const tx = await createLimitOrder(exchangeFacet, taker, {
      positionId: yesId,
      collateralToken: erc20.address,
      amount,
      pricePerToken: priceBuy,
      minFillAmount: amount,
      expiry: 0,
      direction: buyDir,
    });

    await expect(tx)
      .to.emit(matchExecutionFacet, "OrderCompletelyFilled")
      .withArgs(
        takerOrderId,
        taker.address,
        maker1.address,
        amount,
        takerExpectedPrice
      );
    await expect(tx)
      .to.emit(matchExecutionFacet, "OrderCompletelyFilled")
      .withArgs(
        makerOrderId,
        maker1.address,
        taker.address,
        amount,
        takerExpectedPrice
      );

    const buyBook = await exchangeFacet.getOrderbook(yesId, buyDir);
    const sellBook = await exchangeFacet.getOrderbook(yesId, sellDir);
    expect(buyBook.length).to.equal(0);
    expect(sellBook.length).to.equal(0);

    const takerOrder = await exchangeFacet.getOrder(takerOrderId);
    const makerOrder = await exchangeFacet.getOrder(makerOrderId);
    expect(takerOrder.active).to.equal(false);
    expect(makerOrder.active).to.equal(false);
  });

  it("batch matches taker order across multiple makers and updates remaining orders", async () => {
    const price1 = ethers.utils.parseUnits("0.4", erc20Decimals);
    const price2 = ethers.utils.parseUnits("0.45", erc20Decimals);
    const takerPrice = ethers.utils.parseUnits("0.5", erc20Decimals);

    const takerFeePrice1 = price1.mul(feeConfig.takerBps).div(10_000);
    const takerExpectedPrice1 = price1.add(takerFeePrice1);

    const takerFeePrice2 = price2.mul(feeConfig.takerBps).div(10_000);
    const takerExpectedPrice2 = price2.add(takerFeePrice2);

    const maker1Amount = ethers.utils.parseUnits("4", erc20Decimals);
    const maker2Amount = ethers.utils.parseUnits("5", erc20Decimals);
    const takerAmount = ethers.utils.parseUnits("6", erc20Decimals);

    const maker1OrderId = await exchangeFacet.getNextOrderId();
    await createLimitOrder(exchangeFacet, maker1, {
      positionId: yesId,
      collateralToken: erc20.address,
      amount: maker1Amount,
      pricePerToken: price1,
      minFillAmount: maker1Amount,
      expiry: 0,
      direction: sellDir,
    });

    const maker2OrderId = await exchangeFacet.getNextOrderId();
    await createLimitOrder(exchangeFacet, maker2, {
      positionId: yesId,
      collateralToken: erc20.address,
      amount: maker2Amount,
      pricePerToken: price2,
      minFillAmount: ethers.utils.parseUnits("1", erc20Decimals),
      expiry: 0,
      direction: sellDir,
    });

    const takerOrderId = await exchangeFacet.getNextOrderId();
    const tx = await createLimitOrder(exchangeFacet, taker, {
      positionId: yesId,
      collateralToken: erc20.address,
      amount: takerAmount,
      pricePerToken: takerPrice,
      minFillAmount: ethers.utils.parseUnits("1", erc20Decimals),
      expiry: 0,
      direction: buyDir,
    });

    const receipt = await tx.wait();

    // Inspect the decoded events
    for (const log of receipt.events || []) {
      console.log(`Event: ${log.event}`, log.args);
    }

    await expect(tx)
      .to.emit(matchExecutionFacet, "OrderCompletelyFilled")
      .withArgs(
        maker1OrderId,
        maker1.address,
        taker.address,
        maker1Amount,
        takerExpectedPrice1
      );

    await expect(tx)
      .to.emit(matchExecutionFacet, "OrderPartiallyFilled")
      .withArgs(
        maker2OrderId,
        maker2.address,
        taker.address,
        ethers.utils.parseUnits("2", erc20Decimals),
        maker2Amount.sub(ethers.utils.parseUnits("2", erc20Decimals)),
        takerExpectedPrice2
      );

    await expect(tx)
      .to.emit(matchExecutionFacet, "OrderCompletelyFilled")
      .withArgs(
        takerOrderId,
        taker.address,
        maker2.address,
        takerAmount,
        takerExpectedPrice2
      );

    const sellBook = await exchangeFacet.getOrderbook(yesId, sellDir);
    expect(sellBook.length).to.equal(1);
    expect(sellBook[0]).to.equal(maker2OrderId);

    const maker2Order = await exchangeFacet.getOrder(maker2OrderId);
    expect(maker2Order.active).to.equal(true);
    expect(maker2Order.remainingAmount).to.equal(
      maker2Amount.sub(ethers.utils.parseUnits("2", erc20Decimals))
    );

    const takerOrder = await exchangeFacet.getOrder(takerOrderId);
    expect(takerOrder.active).to.equal(false);
  });
});
