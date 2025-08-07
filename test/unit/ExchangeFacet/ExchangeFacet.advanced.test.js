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
    mintAmount = ethers.utils.parseEther("1000");

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

  describe("Order Book Management", function () {
    it("should maintain correct order sorting with multiple orders", async () => {
      const amount = ethers.utils.parseEther("5");
      const prices = [
        ethers.utils.parseEther("0.3"),
        ethers.utils.parseEther("0.1"),
        ethers.utils.parseEther("0.5"),
        ethers.utils.parseEther("0.2"),
      ];

      // Create multiple SELL orders with different prices
      for (let i = 0; i < prices.length; i++) {
        await createLimitOrder(exchangeFacet, owner, {
          positionId: yesId,
          collateralToken: erc20.address,
          amount,
          pricePerToken: prices[i],
          minFillAmount: amount,
          expiry: 0,
          direction: sellDir,
        });
      }

      const book = await exchangeFacet.getOrderbook(yesId, sellDir);
      expect(book.length).to.equal(4);

      // Verify orders are sorted by price (ascending for SELL)
      for (let i = 0; i < book.length - 1; i++) {
        const order1 = await exchangeFacet.getOrder(book[i]);
        const order2 = await exchangeFacet.getOrder(book[i + 1]);
        expect(order1.pricePerToken.lte(order2.pricePerToken)).to.be.true;
      }
    });

    it("should handle order insertion at different positions", async () => {
      const amount = ethers.utils.parseEther("5");

      // Create orders in non-sorted order
      await createLimitOrder(exchangeFacet, owner, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: ethers.utils.parseEther("0.5"),
        minFillAmount: amount,
        expiry: 0,
        direction: sellDir,
      });

      await createLimitOrder(exchangeFacet, owner, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: ethers.utils.parseEther("0.1"), // Should be first
        minFillAmount: amount,
        expiry: 0,
        direction: sellDir,
      });

      await createLimitOrder(exchangeFacet, owner, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: ethers.utils.parseEther("0.3"), // Should be middle
        minFillAmount: amount,
        expiry: 0,
        direction: sellDir,
      });

      const book = await exchangeFacet.getOrderbook(yesId, sellDir);
      const order1 = await exchangeFacet.getOrder(book[0]);
      const order2 = await exchangeFacet.getOrder(book[1]);
      const order3 = await exchangeFacet.getOrder(book[2]);

      expect(order1.pricePerToken).to.equal(ethers.utils.parseEther("0.1"));
      expect(order2.pricePerToken).to.equal(ethers.utils.parseEther("0.3"));
      expect(order3.pricePerToken).to.equal(ethers.utils.parseEther("0.5"));
    });

    it("should handle BUY order sorting (descending by price)", async () => {
      const amount = ethers.utils.parseEther("5");
      const prices = [
        ethers.utils.parseEther("0.3"),
        ethers.utils.parseEther("0.7"),
        ethers.utils.parseEther("0.1"),
        ethers.utils.parseEther("0.5"),
      ];

      // Fund makers for BUY orders
      for (let i = 0; i < prices.length; i++) {
        const cost = amount.mul(prices[i]).div(ercUnit);
        const fee = cost.mul(feeConfig.makerBps).div(10000);
        const totalCost = cost.add(fee);

        await mintAndApproveERC20({
          token: erc20,
          minter: owner,
          to: owner,
          amount: totalCost,
          spender: diamondAddress,
        });

        await createLimitOrder(exchangeFacet, owner, {
          positionId: yesId,
          collateralToken: erc20.address,
          amount,
          pricePerToken: prices[i],
          minFillAmount: amount,
          expiry: 0,
          direction: buyDir,
        });
      }

      const book = await exchangeFacet.getOrderbook(yesId, buyDir);
      expect(book.length).to.equal(4);

      // Verify BUY orders are sorted by price (descending)
      for (let i = 0; i < book.length - 1; i++) {
        const order1 = await exchangeFacet.getOrder(book[i]);
        const order2 = await exchangeFacet.getOrder(book[i + 1]);
        expect(order1.pricePerToken.gte(order2.pricePerToken)).to.be.true;
      }
    });
  });

  describe("Order Validation and Edge Cases", function () {
    it("should revert when creating order with zero amount", async () => {
      await expect(
        createLimitOrder(exchangeFacet, owner, {
          positionId: yesId,
          collateralToken: erc20.address,
          amount: 0,
          pricePerToken: ethers.utils.parseEther("0.5"),
          minFillAmount: 0,
          expiry: 0,
          direction: sellDir,
        })
      ).to.be.revertedWith("InvalidAmounts()");
    });

    it("should revert when creating order with zero price", async () => {
      await expect(
        createLimitOrder(exchangeFacet, owner, {
          positionId: yesId,
          collateralToken: erc20.address,
          amount: ethers.utils.parseEther("5"),
          pricePerToken: 0,
          minFillAmount: ethers.utils.parseEther("1"),
          expiry: 0,
          direction: sellDir,
        })
      ).to.be.revertedWith("InvalidPrice()");
    });

    it("should revert when minFillAmount exceeds amount", async () => {
      await expect(
        createLimitOrder(exchangeFacet, owner, {
          positionId: yesId,
          collateralToken: erc20.address,
          amount: ethers.utils.parseEther("5"),
          pricePerToken: ethers.utils.parseEther("0.5"),
          minFillAmount: ethers.utils.parseEther("10"),
          expiry: 0,
          direction: sellDir,
        })
      ).to.be.revertedWith("InvalidAmounts()");
    });

    it("should handle orders with same price (FIFO ordering)", async () => {
      const amount = ethers.utils.parseEther("5");
      const price = ethers.utils.parseEther("0.5");

      // Create multiple orders with same price
      await createLimitOrder(exchangeFacet, owner, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: price,
        minFillAmount: amount,
        expiry: 0,
        direction: sellDir,
      });

      await createLimitOrder(exchangeFacet, owner, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: price,
        minFillAmount: amount,
        expiry: 0,
        direction: sellDir,
      });

      const book = await exchangeFacet.getOrderbook(yesId, sellDir);
      expect(book.length).to.equal(2);

      const order1 = await exchangeFacet.getOrder(book[0]);
      const order2 = await exchangeFacet.getOrder(book[1]);

      expect(order1.pricePerToken).to.equal(price);
      expect(order2.pricePerToken).to.equal(price);
      // First order should have lower ID (FIFO)
      expect(book[0].lt(book[1])).to.be.true;
    });

    it("should handle maximum price validation", async () => {
      const amount = ethers.utils.parseEther("5");
      const maxPrice = ercUnit.sub(1); // Just below unit price is the maximum

      // Should succeed just below unit price
      await createLimitOrder(exchangeFacet, owner, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: maxPrice,
        minFillAmount: amount,
        expiry: 0,
        direction: sellDir,
      });

      // Should fail at unit price (>= validation)
      await expect(
        createLimitOrder(exchangeFacet, owner, {
          positionId: yesId,
          collateralToken: erc20.address,
          amount,
          pricePerToken: ercUnit,
          minFillAmount: amount,
          expiry: 0,
          direction: sellDir,
        })
      ).to.be.revertedWith("InvalidPrice()");

      // Should fail above unit price
      await expect(
        createLimitOrder(exchangeFacet, owner, {
          positionId: yesId,
          collateralToken: erc20.address,
          amount,
          pricePerToken: ercUnit.add(1),
          minFillAmount: amount,
          expiry: 0,
          direction: sellDir,
        })
      ).to.be.revertedWith("InvalidPrice()");
    });
  });

  describe("Order Expiry Handling", function () {
    it("should create order with future expiry", async () => {
      const amount = ethers.utils.parseEther("5");
      const price = ethers.utils.parseEther("0.5");
      const futureExpiry = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

      await createLimitOrder(exchangeFacet, owner, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: price,
        minFillAmount: amount,
        expiry: futureExpiry,
        direction: sellDir,
      });

      const orderId = (await exchangeFacet.callStatic.getNextOrderId()) - 1;
      const order = await exchangeFacet.callStatic.getOrder(orderId);

      expect(order.expiry).to.equal(futureExpiry);
      expect(order.active).to.be.true;
    });

    it("should revert when creating order with past expiry", async () => {
      const amount = ethers.utils.parseEther("5");
      const price = ethers.utils.parseEther("0.5");
      const pastExpiry = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago

      await expect(
        createLimitOrder(exchangeFacet, owner, {
          positionId: yesId,
          collateralToken: erc20.address,
          amount,
          pricePerToken: price,
          minFillAmount: amount,
          expiry: pastExpiry,
          direction: sellDir,
        })
      ).to.be.revertedWith("OrderCreatedWithPastExpiry()");
    });

    it("should allow canceling expired order", async () => {
      const amount = ethers.utils.parseEther("5");
      const price = ethers.utils.parseEther("0.5");

      // Get current block timestamp and add a reasonable future time
      const currentBlock = await ethers.provider.getBlock("latest");
      const futureExpiry = currentBlock.timestamp + 10; // 10 seconds in the future

      await createLimitOrder(exchangeFacet, owner, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: price,
        minFillAmount: amount,
        expiry: futureExpiry,
        direction: sellDir,
      });

      const orderId = (await exchangeFacet.callStatic.getNextOrderId()) - 1;

      // Wait for expiry by increasing time beyond the expiry
      await ethers.provider.send("evm_increaseTime", [15]);
      await ethers.provider.send("evm_mine");

      const balanceBefore = await erc1155.balanceOf(owner.address, yesId);

      await exchangeFacet.connect(owner).cancelOrder(orderId);

      const balanceAfter = await erc1155.balanceOf(owner.address, yesId);
      const order = await exchangeFacet.callStatic.getOrder(orderId);

      expect(order.active).to.be.false;
      expect(balanceAfter.gt(balanceBefore)).to.be.true; // Tokens returned
    });
  });

  describe("Multi-User Order Scenarios", function () {
    it("should handle orders from multiple makers", async () => {
      const amount = ethers.utils.parseEther("5");
      const price1 = ethers.utils.parseEther("0.3");
      const price2 = ethers.utils.parseEther("0.7");

      // Setup maker2
      await mintAndApproveERC20({
        token: erc20,
        minter: owner,
        to: maker2,
        amount: mintAmount,
        spender: diamondAddress,
      });

      await erc1155
        .connect(owner)
        .safeTransferFrom(owner.address, maker2.address, yesId, amount, "0x");
      await erc1155.connect(maker2).setApprovalForAll(diamondAddress, true);

      // Create orders from different makers
      await createLimitOrder(exchangeFacet, owner, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: price1,
        minFillAmount: amount,
        expiry: 0,
        direction: sellDir,
      });

      await createLimitOrder(exchangeFacet, maker2, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: price2,
        minFillAmount: amount,
        expiry: 0,
        direction: sellDir,
      });

      const book = await exchangeFacet.getOrderbook(yesId, sellDir);
      expect(book.length).to.equal(2);

      const order1 = await exchangeFacet.getOrder(book[0]);
      const order2 = await exchangeFacet.getOrder(book[1]);

      expect(order1.maker).to.equal(owner.address);
      expect(order2.maker).to.equal(maker2.address);
      expect(order1.pricePerToken).to.equal(price1);
      expect(order2.pricePerToken).to.equal(price2);
    });

    it("should prevent non-maker from canceling order", async () => {
      const amount = ethers.utils.parseEther("5");
      const price = ethers.utils.parseEther("0.5");

      await createLimitOrder(exchangeFacet, owner, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: price,
        minFillAmount: amount,
        expiry: 0,
        direction: sellDir,
      });

      const orderId = (await exchangeFacet.callStatic.getNextOrderId()) - 1;

      await expect(
        exchangeFacet.connect(maker2).cancelOrder(orderId)
      ).to.be.revertedWith("NotAuthorizedToCancel()");
    });
  });

  describe("Order State Management", function () {
    it("should track order state correctly through lifecycle", async () => {
      const amount = ethers.utils.parseEther("5");
      const price = ethers.utils.parseEther("0.5");

      // Create order
      await createLimitOrder(exchangeFacet, owner, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: price,
        minFillAmount: amount,
        expiry: 0,
        direction: sellDir,
      });

      const orderId = (await exchangeFacet.callStatic.getNextOrderId()) - 1;

      // Validate initial state
      await validateOrderState(exchangeFacet, orderId, {
        amount,
        price,
        direction: sellDir,
      });

      // Cancel order
      await exchangeFacet.connect(owner).cancelOrder(orderId);

      const canceledOrder = await exchangeFacet.callStatic.getOrder(orderId);
      expect(canceledOrder.active).to.be.false;

      // Verify order removed from book
      const book = await exchangeFacet.getOrderbook(yesId, sellDir);
      expect(book).to.not.include(orderId);
    });

    it("should handle double cancellation attempt", async () => {
      const amount = ethers.utils.parseEther("5");
      const price = ethers.utils.parseEther("0.5");

      await createLimitOrder(exchangeFacet, owner, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: price,
        minFillAmount: amount,
        expiry: 0,
        direction: sellDir,
      });

      const orderId = (await exchangeFacet.callStatic.getNextOrderId()) - 1;

      // First cancellation should succeed
      await exchangeFacet.connect(owner).cancelOrder(orderId);

      // Second cancellation should fail
      await expect(
        exchangeFacet.connect(owner).cancelOrder(orderId)
      ).to.be.revertedWith("NotAuthorizedToCancel()");
    });
  });

  describe("Gas Optimization Tests", function () {
    it("should handle large orderbook efficiently", async () => {
      const amount = ethers.utils.parseEther("1");
      const numOrders = 20;

      // Create many orders
      for (let i = 0; i < numOrders; i++) {
        const price = ethers.utils.parseEther((0.1 + i * 0.01).toString());
        await createLimitOrder(exchangeFacet, owner, {
          positionId: yesId,
          collateralToken: erc20.address,
          amount,
          pricePerToken: price,
          minFillAmount: amount,
          expiry: 0,
          direction: sellDir,
        });
      }

      const book = await exchangeFacet.getOrderbook(yesId, sellDir);
      expect(book.length).to.equal(numOrders);

      // Verify sorting is maintained
      for (let i = 0; i < book.length - 1; i++) {
        const order1 = await exchangeFacet.getOrder(book[i]);
        const order2 = await exchangeFacet.getOrder(book[i + 1]);
        expect(order1.pricePerToken.lte(order2.pricePerToken)).to.be.true;
      }
    });

    it("should efficiently insert order in middle of large book", async () => {
      const amount = ethers.utils.parseEther("1");

      // Create orders with gaps
      const prices = ["0.1", "0.3", "0.5", "0.7", "0.9"];
      for (const priceStr of prices) {
        await createLimitOrder(exchangeFacet, owner, {
          positionId: yesId,
          collateralToken: erc20.address,
          amount,
          pricePerToken: ethers.utils.parseEther(priceStr),
          minFillAmount: amount,
          expiry: 0,
          direction: sellDir,
        });
      }

      // Insert order in middle
      const tx = await createLimitOrder(exchangeFacet, owner, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: ethers.utils.parseEther("0.4"), // Should go between 0.3 and 0.5
        minFillAmount: amount,
        expiry: 0,
        direction: sellDir,
      });

      const receipt = await tx.wait();
      console.log("Gas used for middle insertion:", receipt.gasUsed.toString());

      const book = await exchangeFacet.getOrderbook(yesId, sellDir);
      expect(book.length).to.equal(6);

      // Verify correct positioning - the new order (0.4) should be inserted correctly
      // Let's check all orders to understand the actual sorting
      const allOrders = [];
      for (let i = 0; i < book.length; i++) {
        const order = await exchangeFacet.getOrder(book[i]);
        allOrders.push(order.pricePerToken);
      }

      // Verify orders are sorted in ascending order (for SELL orders)
      for (let i = 0; i < allOrders.length - 1; i++) {
        expect(allOrders[i].lte(allOrders[i + 1])).to.be.true;
      }

      // Verify the 0.4 price order exists in the book
      const hasCorrectPrice = allOrders.some((price) =>
        price.eq(ethers.utils.parseEther("0.4"))
      );
      expect(hasCorrectPrice).to.be.true;

      // Gas usage can vary, so we'll just verify it's reasonable (less than 500k gas)
      expect(receipt.gasUsed.lt(ethers.BigNumber.from("500000"))).to.be.true;
    });
  });
});
