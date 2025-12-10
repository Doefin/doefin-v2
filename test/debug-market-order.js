const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  deployContractViaScript,
  getERC20,
  getERC1155,
  getDiamondAddress,
} = require("./setup");
const {
  createCondition,
  prepareCondition,
} = require("./utils/conditionUtils");
const { mintAndApproveERC20 } = require("./utils/mockTokens");
const {
  createLimitOrder,
  createMarketOrder,
} = require("./utils/orderUtils");

describe("Debug Market Order Matching", function () {
  let diamondAddress;
  let owner, maker, taker;
  let erc20, erc1155;
  let orderCreationFacet, exchangeViewFacet;
  let yesId, noId;
  let conditionId;
  const erc20Decimals = 6;
  const ercUnit = ethers.utils.parseUnits("1", erc20Decimals);

  before(async function () {
    [owner, maker, taker] = await ethers.getSigners();
    diamondAddress = await deployContractViaScript();
    erc20 = await getERC20();
    erc1155 = await getERC1155();

    orderCreationFacet = await ethers.getContractAt(
      "OrderCreationFacet",
      diamondAddress
    );
    exchangeViewFacet = await ethers.getContractAt(
      "ExchangeViewFacet",
      diamondAddress
    );

    // Prepare condition
    const oracleAddress = "0x0000000000000000000000000000000000000001";
    const questionId = ethers.utils.formatBytes32String("test-question");
    const conditionPrep = await prepareCondition({
      oracle: oracleAddress,
      questionId,
      outcomeSlotCount: 2,
    });
    conditionId = conditionPrep.conditionId;

    // Create condition
    const createResult = await createCondition({
      conditionId,
      collateralToken: erc20.address,
    });
    yesId = createResult.yesId;
    noId = createResult.noId;

    console.log("Setup complete:");
    console.log("- yesId:", yesId.toString());
    console.log("- noId:", noId.toString());
    console.log("- Diamond:", diamondAddress);
  });

  it("should match market order against limit order", async function () {
    const amount = ethers.utils.parseUnits("5", erc20Decimals);
    const price = ethers.utils.parseUnits("0.7", erc20Decimals);
    const baseCost = amount.mul(price).div(ercUnit);
    const fee = baseCost.mul(300).div(10_000); // 3% fee
    const totalCost = baseCost.add(fee);

    console.log("\n=== Step 1: Fund accounts ===");
    // Fund taker (market order buyer)
    await mintAndApproveERC20({
      token: erc20,
      minter: owner,
      to: taker,
      amount: totalCost,
      spender: diamondAddress,
    });
    console.log("Taker funded:", totalCost.toString());
    console.log("Taker balance:", (await erc20.balanceOf(taker.address)).toString());
    console.log("Taker allowance:", (await erc20.allowance(taker.address, diamondAddress)).toString());

    // Fund maker (limit order seller) - needs position tokens
    await mintAndApproveERC20({
      token: erc20,
      minter: owner,
      to: maker,
      amount: amount.mul(2),
      spender: diamondAddress,
    });

    // Transfer YES tokens to maker
    await erc1155
      .connect(owner)
      .safeTransferFrom(
        owner.address,
        maker.address,
        yesId,
        amount,
        "0x"
      );
    await erc1155.connect(maker).setApprovalForAll(diamondAddress, true);
    console.log("Maker YES balance:", (await erc1155.balanceOf(maker.address, yesId)).toString());

    console.log("\n=== Step 2: Create limit order (maker sells YES) ===");
    const tx1 = await createLimitOrder(orderCreationFacet, maker, {
      positionId: yesId,
      collateralToken: erc20.address,
      amount,
      pricePerToken: price,
      minFillAmount: 0,
      expiry: 0,
      direction: 1, // SELL
    });
    await tx1.wait();
    console.log("Limit order created");

    // Check orderbook
    const orders = await exchangeViewFacet.getOrdersByPosition(yesId, 1); // SELL orders
    console.log("Orderbook SELL orders count:", orders.length);
    if (orders.length > 0) {
      console.log("First order:", {
        orderId: orders[0].orderId.toString(),
        amount: orders[0].amount.toString(),
        remaining: orders[0].remainingAmount.toString(),
        price: orders[0].pricePerToken.toString(),
        active: orders[0].active,
      });
    }

    console.log("\n=== Step 3: Create market order (taker buys YES) ===");
    const takerBalanceBefore = await erc20.balanceOf(taker.address);
    const takerYesBalanceBefore = await erc1155.balanceOf(taker.address, yesId);
    
    console.log("Before market order:");
    console.log("- Taker ERC20:", takerBalanceBefore.toString());
    console.log("- Taker YES:", takerYesBalanceBefore.toString());

    const tx2 = await createMarketOrder(orderCreationFacet, taker, {
      positionId: yesId,
      collateralToken: erc20.address,
      amount,
      pricePerToken: price,
      direction: 0, // BUY
      fillOrKill: false,
    });
    const receipt = await tx2.wait();
    console.log("Market order created, gas used:", receipt.gasUsed.toString());

    // Check events
    console.log("\n=== Events emitted ===");
    for (const event of receipt.events || []) {
      if (event.event) {
        console.log(`- ${event.event}`);
        if (event.event === "OrderCreated" || event.event === "OrderFilled") {
          console.log("  Args:", event.args);
        }
      }
    }

    console.log("\n=== Step 4: Check balances after ===");
    const takerBalanceAfter = await erc20.balanceOf(taker.address);
    const takerYesBalanceAfter = await erc1155.balanceOf(taker.address, yesId);
    
    console.log("After market order:");
    console.log("- Taker ERC20:", takerBalanceAfter.toString());
    console.log("- Taker YES:", takerYesBalanceAfter.toString());
    console.log("- ERC20 spent:", takerBalanceBefore.sub(takerBalanceAfter).toString());
    console.log("- YES received:", takerYesBalanceAfter.sub(takerYesBalanceBefore).toString());

    // Check if match happened
    const ordersAfter = await exchangeViewFacet.getOrdersByPosition(yesId, 1); // SELL orders
    console.log("\n=== Orderbook after ===");
    console.log("SELL orders count:", ordersAfter.length);
    if (ordersAfter.length > 0 && ordersAfter[0].orderId.eq(orders[0].orderId)) {
      console.log("Original order remaining:", ordersAfter[0].remainingAmount.toString());
    }

    // Assert match happened
    expect(takerYesBalanceAfter).to.be.gt(takerYesBalanceBefore, "Taker should have received YES tokens");
    expect(takerBalanceBefore).to.be.gt(takerBalanceAfter, "Taker should have spent ERC20");
  });
});
