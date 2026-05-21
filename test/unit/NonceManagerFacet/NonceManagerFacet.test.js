const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("NonceManagerFacet", function () {
  let nonceMgr;
  let owner, maker, otherUser;

  const DOMAIN_NAME = "Doefin Exchange";
  const DOMAIN_VERSION = "3";

  const ORDER_TYPE = {
    DoefinOrder: [
      { name: "salt", type: "uint256" },
      { name: "maker", type: "address" },
      { name: "signer", type: "address" },
      { name: "positionId", type: "bytes32" },
      { name: "collateralToken", type: "address" },
      { name: "side", type: "uint8" },
      { name: "amount", type: "uint128" },
      { name: "pricePerToken", type: "uint128" },
      { name: "minFillAmount", type: "uint128" },
      { name: "feeRateBps", type: "uint16" },
      { name: "expiration", type: "uint64" },
      { name: "nonce", type: "uint256" },
    ],
  };

  function makeOrder(makerAddr, overrides = {}) {
    return {
      salt: 1,
      maker: makerAddr,
      signer: makerAddr,
      positionId: ethers.utils.formatBytes32String("pos1"),
      collateralToken: "0x3333333333333333333333333333333333333333",
      side: 0,
      amount: 1000,
      pricePerToken: 500,
      minFillAmount: 100,
      feeRateBps: 200,
      expiration: 0,
      nonce: 0,
      ...overrides,
    };
  }

  /**
   * Compute the EIP-712 order hash the same way the contract does,
   * using ethers _TypedDataEncoder.
   */
  function computeOrderHash(order, verifyingContract) {
    const domain = {
      name: DOMAIN_NAME,
      version: DOMAIN_VERSION,
      chainId: 31337,
      verifyingContract,
    };
    return ethers.utils._TypedDataEncoder.hash(domain, ORDER_TYPE, order);
  }

  before(async function () {
    [owner, maker, otherUser] = await ethers.getSigners();

    const NonceMgr = await ethers.getContractFactory("NonceManagerFacet");
    nonceMgr = await NonceMgr.deploy();
    await nonceMgr.deployed();
  });

  // ========================================
  // NONCE MANAGEMENT
  // ========================================

  describe("Nonce management", function () {
    it("should return 0 for a fresh address", async function () {
      const nonce = await nonceMgr.getNonce(maker.address);
      expect(nonce).to.equal(0);
    });

    it("should increment nonce by 1", async function () {
      const tx = await nonceMgr.connect(maker).incrementNonce();
      const receipt = await tx.wait();
      const nonce = await nonceMgr.getNonce(maker.address);
      expect(nonce).to.equal(1);
    });

    it("should emit NonceBumped event with correct values", async function () {
      // maker nonce is currently 1, will become 2
      await expect(nonceMgr.connect(maker).incrementNonce())
        .to.emit(nonceMgr, "NonceBumped")
        .withArgs(maker.address, 2);
    });

    it("should accumulate multiple increments correctly", async function () {
      // Currently at 2, increment twice more
      await nonceMgr.connect(maker).incrementNonce(); // 3
      await nonceMgr.connect(maker).incrementNonce(); // 4
      const nonce = await nonceMgr.getNonce(maker.address);
      expect(nonce).to.equal(4);
    });

    it("should track nonces independently per maker", async function () {
      const makerNonce = await nonceMgr.getNonce(maker.address);
      const otherNonce = await nonceMgr.getNonce(otherUser.address);
      expect(makerNonce).to.equal(4);
      expect(otherNonce).to.equal(0);
    });
  });

  // ========================================
  // INDIVIDUAL CANCELLATION
  // ========================================

  describe("Individual cancellation", function () {
    let order, orderHash;

    before(async function () {
      // Reset: use otherUser as maker so nonce is 0
      order = makeOrder(otherUser.address);
      orderHash = computeOrderHash(order, nonceMgr.address);
    });

    it("should return false for isCancelled on a non-cancelled order", async function () {
      const cancelled = await nonceMgr.isCancelled(orderHash);
      expect(cancelled).to.equal(false);
    });

    it("should cancel an order and mark it as cancelled", async function () {
      await nonceMgr.connect(otherUser).cancelOrder(order);
      const cancelled = await nonceMgr.isCancelled(orderHash);
      expect(cancelled).to.equal(true);
    });

    it("should emit OrderCancelledOnChain event", async function () {
      const order2 = makeOrder(otherUser.address, { salt: 99 });
      const hash2 = computeOrderHash(order2, nonceMgr.address);

      await expect(nonceMgr.connect(otherUser).cancelOrder(order2))
        .to.emit(nonceMgr, "OrderCancelledOnChain")
        .withArgs(hash2, otherUser.address);
    });

    it("should revert if msg.sender != order.maker", async function () {
      const order3 = makeOrder(otherUser.address, { salt: 200 });
      await expect(
        nonceMgr.connect(maker).cancelOrder(order3)
      ).to.be.revertedWith("NotOrderMaker()");
    });

    it("should revert when cancelling an already cancelled order", async function () {
      const order4 = makeOrder(otherUser.address, { salt: 300 });
      await nonceMgr.connect(otherUser).cancelOrder(order4);
      await expect(
        nonceMgr.connect(otherUser).cancelOrder(order4)
      ).to.be.reverted;
    });
  });

  // ========================================
  // BATCH CANCELLATION
  // ========================================

  describe("Batch cancellation", function () {
    it("should cancel multiple orders in one tx", async function () {
      const order1 = makeOrder(maker.address, { salt: 1000, nonce: 4 });
      const order2 = makeOrder(maker.address, { salt: 1001, nonce: 4 });
      const order3 = makeOrder(maker.address, { salt: 1002, nonce: 4 });

      await nonceMgr.connect(maker).cancelOrders([order1, order2, order3]);

      const hash1 = computeOrderHash(order1, nonceMgr.address);
      const hash2 = computeOrderHash(order2, nonceMgr.address);
      const hash3 = computeOrderHash(order3, nonceMgr.address);

      expect(await nonceMgr.isCancelled(hash1)).to.equal(true);
      expect(await nonceMgr.isCancelled(hash2)).to.equal(true);
      expect(await nonceMgr.isCancelled(hash3)).to.equal(true);
    });

    it("should revert if any order in batch has wrong maker", async function () {
      const goodOrder = makeOrder(maker.address, { salt: 2000, nonce: 4 });
      const badOrder = makeOrder(otherUser.address, { salt: 2001 });

      await expect(
        nonceMgr.connect(maker).cancelOrders([goodOrder, badOrder])
      ).to.be.revertedWith("NotOrderMaker()");
    });
  });

  // ========================================
  // SALT-BASED CANCELLATION
  // ========================================

  describe("Salt-based cancellation", function () {
    const positionId = ethers.utils.formatBytes32String("pos-salt");

    it("should set minimum salt for a position", async function () {
      await expect(
        nonceMgr.connect(maker).cancelOrdersForPosition(positionId, 50)
      )
        .to.emit(nonceMgr, "PositionOrdersCancelled")
        .withArgs(maker.address, positionId, 50);
    });

    it("should invalidate orders with salt below minimum", async function () {
      const order = makeOrder(maker.address, {
        salt: 10,
        positionId,
        nonce: 4,
      });
      const valid = await nonceMgr.isOrderValid(order);
      expect(valid).to.equal(false);
    });

    it("should revert when setting minValidSalt to a lower or equal value", async function () {
      const posId = ethers.utils.formatBytes32String("pos-salt-guard");
      await nonceMgr.connect(maker).cancelOrdersForPosition(posId, 100);
      // Try setting to same value
      await expect(
        nonceMgr.connect(maker).cancelOrdersForPosition(posId, 100)
      ).to.be.revertedWith("InvalidSaltThreshold()");
      // Try setting to lower value
      await expect(
        nonceMgr.connect(maker).cancelOrdersForPosition(posId, 50)
      ).to.be.revertedWith("InvalidSaltThreshold()");
      // Higher value should succeed
      await expect(
        nonceMgr.connect(maker).cancelOrdersForPosition(posId, 200)
      ).to.not.be.reverted;
    });

    it("should accept orders with salt at or above minimum", async function () {
      const orderAt = makeOrder(maker.address, {
        salt: 50,
        positionId,
        nonce: 4,
      });
      const orderAbove = makeOrder(maker.address, {
        salt: 100,
        positionId,
        nonce: 4,
      });
      expect(await nonceMgr.isOrderValid(orderAt)).to.equal(true);
      expect(await nonceMgr.isOrderValid(orderAbove)).to.equal(true);
    });
  });

  // ========================================
  // isOrderValid() COMPREHENSIVE
  // ========================================

  describe("isOrderValid() comprehensive", function () {
    it("should return true for a fresh valid order", async function () {
      // Use owner who has nonce 0 and no cancellations
      const order = makeOrder(owner.address);
      expect(await nonceMgr.isOrderValid(order)).to.equal(true);
    });

    it("should return false for a cancelled order", async function () {
      const order = makeOrder(owner.address, { salt: 500 });
      await nonceMgr.connect(owner).cancelOrder(order);
      expect(await nonceMgr.isOrderValid(order)).to.equal(false);
    });

    it("should return false for an order with stale nonce", async function () {
      // maker has nonce 4, order has nonce 2
      const order = makeOrder(maker.address, { nonce: 2 });
      expect(await nonceMgr.isOrderValid(order)).to.equal(false);
    });

    it("should return true for an order with current nonce", async function () {
      // maker has nonce 4
      const order = makeOrder(maker.address, { nonce: 4 });
      expect(await nonceMgr.isOrderValid(order)).to.equal(true);
    });

    it("should return false for an expired order", async function () {
      const block = await ethers.provider.getBlock("latest");
      const order = makeOrder(owner.address, {
        salt: 600,
        expiration: block.timestamp - 1, // already expired
      });
      expect(await nonceMgr.isOrderValid(order)).to.equal(false);
    });

    it("should return true for an order with expiration == 0 (no expiry)", async function () {
      const order = makeOrder(owner.address, { salt: 601, expiration: 0 });
      expect(await nonceMgr.isOrderValid(order)).to.equal(true);
    });

    it("should return true for an order with future expiration", async function () {
      const block = await ethers.provider.getBlock("latest");
      const order = makeOrder(owner.address, {
        salt: 602,
        expiration: block.timestamp + 3600,
      });
      expect(await nonceMgr.isOrderValid(order)).to.equal(true);
    });

    it("should return false when multiple invalidity reasons apply", async function () {
      // maker has nonce 4; order has stale nonce AND low salt for its position
      const positionId = ethers.utils.formatBytes32String("pos-salt");
      const order = makeOrder(maker.address, {
        salt: 5,
        positionId,
        nonce: 1,
      });
      expect(await nonceMgr.isOrderValid(order)).to.equal(false);
    });
  });
});
