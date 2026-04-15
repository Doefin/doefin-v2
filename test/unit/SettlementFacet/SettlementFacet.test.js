const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployDiamond } = require("../../../scripts/deploy.js");
const { getConditionId, getCollectionId, getPositionId } = require("../../utils/ctfUtils.js");

describe("SettlementFacet", function () {
  // Contracts
  let diamondAddress;
  let settlement, sigVerifier, nonceMgr, adminConfig, conditionMgr, conditionalTokens, erc1155Facet;
  let collateral; // MockERC20

  // Signers
  let owner, operator, buyer, seller, buyerB, feeReceiver;

  // Test state
  let conditionId, positionIdA, positionIdB;
  const UNIT = ethers.utils.parseUnits("1", 6); // 1e6 (USDC-like)
  const FEE_BPS = 200; // 2%

  // EIP-712 helpers
  const DOMAIN_NAME = "Doefin Exchange";
  const DOMAIN_VERSION = "2.1";
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
      { name: "orderType", type: "uint8" },
      { name: "quoteCurrency", type: "address" },
      { name: "exchangeRate", type: "uint128" },
      { name: "feeRateBps", type: "uint16" },
      { name: "expiration", type: "uint64" },
      { name: "nonce", type: "uint256" },
    ],
  };

  function makeDomain() {
    return {
      name: DOMAIN_NAME,
      version: DOMAIN_VERSION,
      chainId: 31337,
      verifyingContract: diamondAddress,
    };
  }

  function makeOrder(maker, positionId, side, amount, price, overrides = {}) {
    return {
      salt: 1,
      maker,
      signer: maker,
      positionId: ethers.utils.hexZeroPad(ethers.BigNumber.from(positionId).toHexString(), 32),
      collateralToken: collateral.address,
      side,
      amount,
      pricePerToken: price,
      minFillAmount: 0,
      orderType: 0,
      quoteCurrency: ethers.constants.AddressZero,
      exchangeRate: 0,
      feeRateBps: FEE_BPS,
      expiration: 0,
      nonce: 0,
      ...overrides,
    };
  }

  async function signOrder(signer, order) {
    return signer._signTypedData(makeDomain(), ORDER_TYPE, order);
  }

  /**
   * Compute the symmetric fee: fee = rate * min(price, 1-price) * amount / (unit * 10000)
   */
  function computeExpectedFee(feeRateBps, price, amount, unit) {
    const complementPrice = unit.sub(price);
    const effectivePrice = price.lt(complementPrice) ? price : complementPrice;
    return effectivePrice.mul(amount).mul(feeRateBps).div(unit.mul(10000));
  }

  // ========================================
  // SETUP
  // ========================================

  before(async function () {
    [owner, operator, buyer, seller, buyerB, feeReceiver] = await ethers.getSigners();

    // Deploy Diamond with all facets (including v2.1 settlement facets)
    diamondAddress = await deployDiamond();

    // Get facet interfaces on Diamond
    settlement = await ethers.getContractAt("SettlementFacet", diamondAddress);
    sigVerifier = await ethers.getContractAt("SignatureVerifierFacet", diamondAddress);
    nonceMgr = await ethers.getContractAt("NonceManagerFacet", diamondAddress);
    adminConfig = await ethers.getContractAt("AdminConfigFacet", diamondAddress);
    conditionMgr = await ethers.getContractAt("ConditionManagerFacet", diamondAddress);
    conditionalTokens = await ethers.getContractAt("ConditionalTokensFacet", diamondAddress);
    erc1155Facet = await ethers.getContractAt("ERC1155Facet", diamondAddress);

    // Deploy mock collateral (USDC-like, 6 decimals)
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    collateral = await MockERC20.deploy("Mock USDC", "USDC", 6);
    await collateral.deployed();

    // Admin setup
    await adminConfig.addCollateralToken(collateral.address, UNIT);
    await adminConfig.setFeeReceiver(feeReceiver.address);

    // Set operator
    await settlement.setOperator(operator.address);

    // Grant market maker role to owner (needed to create conditions)
    const accessControl = await ethers.getContractAt("AccessControlFacet", diamondAddress);
    await accessControl.addMarketMaker(owner.address);

    // Create a binary condition with 2 outcomes
    const questionId = ethers.utils.formatBytes32String("test-question-1");
    conditionId = getConditionId(owner.address, questionId, 2);

    await conditionMgr.createCondition(owner.address, questionId, 2, "ipfs://test");

    // Compute position IDs for outcome A (indexSet=1) and B (indexSet=2)
    const collectionIdA = await getCollectionId(ethers.constants.HashZero, conditionId, 1, ethers.provider);
    const collectionIdB = await getCollectionId(ethers.constants.HashZero, conditionId, 2, ethers.provider);
    positionIdA = getPositionId(collateral.address, collectionIdA);
    positionIdB = getPositionId(collateral.address, collectionIdB);

    // Mint collateral to test users
    const mintAmount = ethers.utils.parseUnits("100000", 6);
    await collateral.mint(buyer.address, mintAmount);
    await collateral.mint(seller.address, mintAmount);
    await collateral.mint(buyerB.address, mintAmount);
    await collateral.mint(operator.address, mintAmount);

    // Approve Diamond for ERC20
    await collateral.connect(buyer).approve(diamondAddress, ethers.constants.MaxUint256);
    await collateral.connect(seller).approve(diamondAddress, ethers.constants.MaxUint256);
    await collateral.connect(buyerB).approve(diamondAddress, ethers.constants.MaxUint256);
    await collateral.connect(operator).approve(diamondAddress, ethers.constants.MaxUint256);

    // Approve Diamond for ERC1155
    await erc1155Facet.connect(buyer).setApprovalForAll(diamondAddress, true);
    await erc1155Facet.connect(seller).setApprovalForAll(diamondAddress, true);
    await erc1155Facet.connect(buyerB).setApprovalForAll(diamondAddress, true);
    await erc1155Facet.connect(operator).setApprovalForAll(diamondAddress, true);

    // Give seller some position tokens via split
    const splitAmount = ethers.utils.parseUnits("10000", 6);
    await collateral.mint(owner.address, splitAmount);
    await collateral.connect(owner).approve(diamondAddress, ethers.constants.MaxUint256);
    await conditionalTokens.connect(owner).splitPosition(
      collateral.address,
      ethers.constants.HashZero,
      conditionId,
      [1, 2],
      splitAmount
    );

    // Transfer position A tokens to seller, position B to buyerB (for merge tests)
    await erc1155Facet.connect(owner).setApprovalForAll(diamondAddress, true);
    await erc1155Facet.connect(owner).safeTransferFrom(
      owner.address, seller.address, positionIdA, splitAmount, "0x"
    );
    await erc1155Facet.connect(owner).safeTransferFrom(
      owner.address, buyerB.address, positionIdB, splitAmount, "0x"
    );

    // Register position pair in settlement storage (Fix 1)
    const posIdABytes32 = ethers.utils.hexZeroPad(positionIdA.toHexString(), 32);
    const posIdBBytes32 = ethers.utils.hexZeroPad(positionIdB.toHexString(), 32);
    await settlement.registerPositionPair(posIdABytes32, posIdBBytes32, conditionId, collateral.address);
  });

  // ========================================
  // ADMIN FUNCTION TESTS
  // ========================================

  describe("Admin functions", function () {
    it("should set operator correctly", async function () {
      expect(await settlement.getOperator()).to.equal(operator.address);
    });

    it("should revert setOperator for non-owner", async function () {
      await expect(
        settlement.connect(buyer).setOperator(buyer.address)
      ).to.be.revertedWith("NotContractOwner()");
    });

    it("should pause and unpause trading", async function () {
      await settlement.pauseTrading();
      expect(await settlement.isTradingPaused()).to.equal(true);

      await settlement.unpauseTrading();
      expect(await settlement.isTradingPaused()).to.equal(false);
    });

    it("should emit SettlementTradingPaused/Unpaused events", async function () {
      await expect(settlement.pauseTrading())
        .to.emit(settlement, "SettlementTradingPaused")
        .withArgs(owner.address);

      await expect(settlement.unpauseTrading())
        .to.emit(settlement, "SettlementTradingUnpaused")
        .withArgs(owner.address);
    });

    it("should revert pauseTrading for non-owner", async function () {
      await expect(
        settlement.connect(operator).pauseTrading()
      ).to.be.revertedWith("NotContractOwner()");
    });

    it("should return 0 for getFilledAmount on fresh order hash", async function () {
      const hash = ethers.utils.formatBytes32String("nonexistent");
      expect(await settlement.getFilledAmount(hash)).to.equal(0);
    });
  });

  // ========================================
  // ACCESS CONTROL TESTS
  // ========================================

  describe("Access control", function () {
    it("should revert matchOrders from non-operator", async function () {
      const order = makeOrder(buyer.address, positionIdA, 0, 100, UNIT.div(2));
      const sig = await signOrder(buyer, order);

      await expect(
        settlement.connect(buyer).matchOrders(
          order, sig, 0, [], [], [], 100, []
        )
      ).to.be.reverted;
    });

    it("should revert matchOrders when paused", async function () {
      await settlement.pauseTrading();

      const order = makeOrder(buyer.address, positionIdA, 0, 100, UNIT.div(2));
      const sig = await signOrder(buyer, order);

      await expect(
        settlement.connect(operator).matchOrders(
          order, sig, 0, [], [], [], 100, []
        )
      ).to.be.reverted;

      await settlement.unpauseTrading();
    });
  });

  // ========================================
  // INPUT VALIDATION TESTS
  // ========================================

  describe("Input validation", function () {
    it("should revert on mismatched array lengths", async function () {
      const takerOrder = makeOrder(buyer.address, positionIdA, 0, 100, UNIT.div(2));
      const takerSig = await signOrder(buyer, takerOrder);

      const makerOrder = makeOrder(seller.address, positionIdA, 1, 100, UNIT.div(2));
      const makerSig = await signOrder(seller, makerOrder);

      // 1 maker order but 0 fill amounts
      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          100, [] // mismatch: 1 maker order, 0 fill amounts
        )
      ).to.be.revertedWith("MismatchedInputLengths()");
    });

    it("should revert on zero taker fill amount", async function () {
      const takerOrder = makeOrder(buyer.address, positionIdA, 0, 100, UNIT.div(2));
      const takerSig = await signOrder(buyer, takerOrder);

      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0, [], [], [], 0, []
        )
      ).to.be.revertedWith("ZeroAmount()");
    });
  });

  // ========================================
  // COMPLEMENTARY SETTLEMENT TESTS
  // ========================================

  describe("Complementary settlement (Buy vs Sell)", function () {
    const fillAmount = ethers.utils.parseUnits("100", 6);
    const price = UNIT.div(2); // 0.5 (500000)

    it("should settle a valid Buy vs Sell match", async function () {
      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, { salt: 5000 });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, { salt: 5000 });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      // Record balances before
      const buyerCollBefore = await collateral.balanceOf(buyer.address);
      const sellerCollBefore = await collateral.balanceOf(seller.address);
      const sellerPosBefore = await erc1155Facet.balanceOf(seller.address, positionIdA);
      const buyerPosBefore = await erc1155Facet.balanceOf(buyer.address, positionIdA);
      const feeReceiverBefore = await collateral.balanceOf(feeReceiver.address);

      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fillAmount, [fillAmount]
      );

      // Fix 2: Each party pays their own fee. Execution at maker's price.
      const collateralAmount = price.mul(fillAmount).div(UNIT);
      const buyerFee = computeExpectedFee(FEE_BPS, price, fillAmount, UNIT);
      const sellerFee = computeExpectedFee(FEE_BPS, price, fillAmount, UNIT);
      const totalFees = buyerFee.add(sellerFee);

      const buyerCollAfter = await collateral.balanceOf(buyer.address);
      const sellerCollAfter = await collateral.balanceOf(seller.address);

      // Buyer paid collateral + buyer's fee
      expect(buyerCollBefore.sub(buyerCollAfter)).to.equal(collateralAmount.add(buyerFee));
      // Seller received collateral - seller's fee
      expect(sellerCollAfter.sub(sellerCollBefore)).to.equal(collateralAmount.sub(sellerFee));

      // Fee receiver got total fees
      const feeReceiverAfter = await collateral.balanceOf(feeReceiver.address);
      expect(feeReceiverAfter.sub(feeReceiverBefore)).to.equal(totalFees);

      // Position tokens moved from seller to buyer
      const sellerPosAfter = await erc1155Facet.balanceOf(seller.address, positionIdA);
      const buyerPosAfter = await erc1155Facet.balanceOf(buyer.address, positionIdA);
      expect(sellerPosBefore.sub(sellerPosAfter)).to.equal(fillAmount);
      expect(buyerPosAfter.sub(buyerPosBefore)).to.equal(fillAmount);
    });

    it("should update fill state correctly", async function () {
      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, { salt: 5001 });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, { salt: 5001 });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fillAmount, [fillAmount]
      );

      // Get order hashes and check filled amounts
      const takerHash = await sigVerifier.getOrderHash(takerOrder);
      const makerHash = await sigVerifier.getOrderHash(makerOrder);
      expect(await settlement.getFilledAmount(takerHash)).to.equal(fillAmount);
      expect(await settlement.getFilledAmount(makerHash)).to.equal(fillAmount);
    });

    it("should emit OrderSettled and OrdersMatched events", async function () {
      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, { salt: 5002 });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, { salt: 5002 });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      const takerHash = await sigVerifier.getOrderHash(takerOrder);
      const makerHash = await sigVerifier.getOrderHash(makerOrder);

      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          fillAmount, [fillAmount]
        )
      ).to.emit(settlement, "OrdersMatched");
    });

    it("should handle partial fill then fill the rest", async function () {
      const totalAmount = ethers.utils.parseUnits("200", 6);
      const halfAmount = ethers.utils.parseUnits("100", 6);

      const takerOrder = makeOrder(buyer.address, positionIdA, 0, totalAmount, price, { salt: 5003 });
      const makerOrder1 = makeOrder(seller.address, positionIdA, 1, totalAmount, price, { salt: 5003 });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig1 = await signOrder(seller, makerOrder1);

      // First fill: half
      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder1], [makerSig1], [0],
        halfAmount, [halfAmount]
      );

      const takerHash = await sigVerifier.getOrderHash(takerOrder);
      expect(await settlement.getFilledAmount(takerHash)).to.equal(halfAmount);

      // Second fill: remaining half
      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder1], [makerSig1], [0],
        halfAmount, [halfAmount]
      );

      expect(await settlement.getFilledAmount(takerHash)).to.equal(totalAmount);
    });

    it("should revert on overfill", async function () {
      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, { salt: 5004 });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, { salt: 5004 });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      // Fill entire amount
      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fillAmount, [fillAmount]
      );

      // Try to fill again — should revert
      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          1, [1]
        )
      ).to.be.reverted;
    });

    it("should revert on invalid signature", async function () {
      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, { salt: 5005 });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, { salt: 5005 });

      // Sign taker order with wrong signer
      const wrongSig = await signOrder(seller, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, wrongSig, 0,
          [makerOrder], [makerSig], [0],
          fillAmount, [fillAmount]
        )
      ).to.be.reverted;
    });

    it("should revert on self-trade (same maker)", async function () {
      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, { salt: 5006 });
      // Maker is same as taker
      const makerOrder = makeOrder(buyer.address, positionIdA, 1, fillAmount, price, { salt: 5006 });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(buyer, makerOrder);

      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          fillAmount, [fillAmount]
        )
      ).to.be.revertedWith("SelfTrade()");
    });
  });

  // ========================================
  // FILL ORDER TESTS (operator as counterparty)
  // ========================================

  describe("fillOrder (operator as counterparty)", function () {
    const fillAmount = ethers.utils.parseUnits("50", 6);
    const price = UNIT.div(2);

    it("should fill a buy order (operator provides position tokens)", async function () {
      // Give operator some position tokens
      // operator needs position A tokens — transfer from some existing holder
      // For simplicity, mint fresh via split
      const splitAmt = ethers.utils.parseUnits("1000", 6);
      await collateral.mint(operator.address, splitAmt);
      await conditionalTokens.connect(operator).splitPosition(
        collateral.address, ethers.constants.HashZero, conditionId, [1, 2], splitAmt
      );

      const order = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, { salt: 6000 });
      const sig = await signOrder(buyer, order);

      const buyerCollBefore = await collateral.balanceOf(buyer.address);
      const buyerPosBefore = await erc1155Facet.balanceOf(buyer.address, positionIdA);

      await settlement.connect(operator).fillOrder(order, sig, 0, fillAmount);

      const buyerCollAfter = await collateral.balanceOf(buyer.address);
      const buyerPosAfter = await erc1155Facet.balanceOf(buyer.address, positionIdA);

      // Buyer paid collateral
      expect(buyerCollBefore.sub(buyerCollAfter).gt(0)).to.equal(true);
      // Buyer received position tokens
      expect(buyerPosAfter.sub(buyerPosBefore)).to.equal(fillAmount);
    });

    it("should revert fillOrder with zero amount", async function () {
      const order = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, { salt: 6001 });
      const sig = await signOrder(buyer, order);

      await expect(
        settlement.connect(operator).fillOrder(order, sig, 0, 0)
      ).to.be.revertedWith("ZeroAmount()");
    });

    it("should revert fillOrder from non-operator", async function () {
      const order = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, { salt: 6002 });
      const sig = await signOrder(buyer, order);

      await expect(
        settlement.connect(buyer).fillOrder(order, sig, 0, fillAmount)
      ).to.be.reverted;
    });
  });

  // ========================================
  // FEE CALCULATION TESTS
  // ========================================

  describe("Fee calculation (symmetric formula)", function () {
    it("should compute symmetric fee correctly at price=0.5", async function () {
      const fillAmount = ethers.utils.parseUnits("1000", 6);
      const price = UNIT.div(2); // 0.5
      // min(0.5, 0.5) = 0.5
      // fee = 200 * 500000 * 1000000000 / (1000000 * 10000) = 10000000000000 / 10000000000 = 1000 (in 6 dec = 0.001)
      // Actually: fee = 200 * 500000 * 1000000000 / (1000000 * 10000)
      // = 200 * 500000 * 1000000000 / 10000000000
      // Wait, let me compute properly:
      // effectivePrice = min(500000, 500000) = 500000
      // fee = 200 * 500000 * 1000000000 / (1000000 * 10000) = 100000000000000 / 10000000000 = 10000
      const expected = computeExpectedFee(FEE_BPS, price, fillAmount, UNIT);

      // Manual check: 200 * 500000 * 1000000000 / (1000000 * 10000) = 10000000000
      // Hmm, BigNumber math:
      const manual = ethers.BigNumber.from(200)
        .mul(500000)
        .mul(1000000000)
        .div(ethers.BigNumber.from(1000000).mul(10000));
      expect(expected).to.equal(manual);
    });

    it("should compute symmetric fee correctly at price=0.1 (lower effective price)", async function () {
      const fillAmount = ethers.utils.parseUnits("1000", 6);
      const price = UNIT.div(10); // 0.1 = 100000
      // complement = 900000, effectivePrice = min(100000, 900000) = 100000
      const expected = computeExpectedFee(FEE_BPS, price, fillAmount, UNIT);
      const manual = ethers.BigNumber.from(200)
        .mul(100000)
        .mul(1000000000)
        .div(ethers.BigNumber.from(1000000).mul(10000));
      expect(expected).to.equal(manual);
    });

    it("fee should be 0 when feeRateBps is 0", async function () {
      const fillAmount = ethers.utils.parseUnits("1000", 6);
      const price = UNIT.div(2);
      const expected = computeExpectedFee(0, price, fillAmount, UNIT);
      expect(expected).to.equal(0);
    });
  });

  // ========================================
  // FILL AMOUNT CONSISTENCY (Fix 4)
  // ========================================

  describe("Fill amount consistency", function () {
    it("should revert when sum of makerFillAmounts != takerFillAmount", async function () {
      const fillAmount = ethers.utils.parseUnits("100", 6);
      const price = UNIT.div(2);

      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, { salt: 7000 });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, { salt: 7000 });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      // takerFillAmount=100 but makerFillAmounts=[50] — mismatch
      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          fillAmount, [fillAmount.div(2)]
        )
      ).to.be.reverted;
    });
  });

  // ========================================
  // MINT SETTLEMENT TESTS (Fix 6)
  // ========================================

  describe("Mint settlement (two buyers of complement positions)", function () {
    const fillAmount = ethers.utils.parseUnits("100", 6);
    const priceA = UNIT.mul(6).div(10); // 0.6
    const priceB = UNIT.mul(4).div(10); // 0.4

    it("should mint positions from two buyers", async function () {
      // buyer buys position A, buyerB buys position B
      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, priceA, { salt: 8000 });
      const makerOrder = makeOrder(buyerB.address, positionIdB, 0, fillAmount, priceB, { salt: 8000 });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(buyerB, makerOrder);

      const buyerPosBefore = await erc1155Facet.balanceOf(buyer.address, positionIdA);
      const buyerBPosBefore = await erc1155Facet.balanceOf(buyerB.address, positionIdB);
      const buyerCollBefore = await collateral.balanceOf(buyer.address);
      const buyerBCollBefore = await collateral.balanceOf(buyerB.address);

      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fillAmount, [fillAmount]
      );

      // Both buyers received their position tokens
      const buyerPosAfter = await erc1155Facet.balanceOf(buyer.address, positionIdA);
      const buyerBPosAfter = await erc1155Facet.balanceOf(buyerB.address, positionIdB);
      expect(buyerPosAfter.sub(buyerPosBefore)).to.equal(fillAmount);
      expect(buyerBPosAfter.sub(buyerBPosBefore)).to.equal(fillAmount);

      // Both buyers paid collateral
      const buyerCollAfter = await collateral.balanceOf(buyer.address);
      const buyerBCollAfter = await collateral.balanceOf(buyerB.address);
      expect(buyerCollBefore.sub(buyerCollAfter).gt(0)).to.equal(true);
      expect(buyerBCollBefore.sub(buyerBCollAfter).gt(0)).to.equal(true);
    });
  });

  // ========================================
  // MERGE SETTLEMENT TESTS (Fix 6)
  // ========================================

  describe("Merge settlement (two sellers of complement positions)", function () {
    const fillAmount = ethers.utils.parseUnits("100", 6);
    const priceA = UNIT.mul(6).div(10); // 0.6
    const priceB = UNIT.mul(4).div(10); // 0.4

    it("should merge positions from two sellers", async function () {
      // seller sells position A, buyerB sells position B
      const takerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, priceA, { salt: 9000 });
      const makerOrder = makeOrder(buyerB.address, positionIdB, 1, fillAmount, priceB, { salt: 9000 });

      const takerSig = await signOrder(seller, takerOrder);
      const makerSig = await signOrder(buyerB, makerOrder);

      const sellerPosBefore = await erc1155Facet.balanceOf(seller.address, positionIdA);
      const buyerBPosBefore = await erc1155Facet.balanceOf(buyerB.address, positionIdB);
      const sellerCollBefore = await collateral.balanceOf(seller.address);
      const buyerBCollBefore = await collateral.balanceOf(buyerB.address);

      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fillAmount, [fillAmount]
      );

      // Both sellers gave up their position tokens
      const sellerPosAfter = await erc1155Facet.balanceOf(seller.address, positionIdA);
      const buyerBPosAfter = await erc1155Facet.balanceOf(buyerB.address, positionIdB);
      expect(sellerPosBefore.sub(sellerPosAfter)).to.equal(fillAmount);
      expect(buyerBPosBefore.sub(buyerBPosAfter)).to.equal(fillAmount);

      // Both sellers received collateral
      const sellerCollAfter = await collateral.balanceOf(seller.address);
      const buyerBCollAfter = await collateral.balanceOf(buyerB.address);
      expect(sellerCollAfter.sub(sellerCollBefore).gt(0)).to.equal(true);
      expect(buyerBCollAfter.sub(buyerBCollBefore).gt(0)).to.equal(true);
    });
  });

  // ========================================
  // MULTI-MAKER TESTS (Fix 6)
  // ========================================

  describe("Multi-maker settlement", function () {
    it("should settle one taker against two makers", async function () {
      const totalFill = ethers.utils.parseUnits("200", 6);
      const halfFill = ethers.utils.parseUnits("100", 6);
      const price = UNIT.div(2);

      const takerOrder = makeOrder(buyer.address, positionIdA, 0, totalFill, price, { salt: 10000 });
      const makerOrder1 = makeOrder(seller.address, positionIdA, 1, halfFill, price, { salt: 10001 });
      const makerOrder2 = makeOrder(buyerB.address, positionIdA, 1, halfFill, price, { salt: 10002 });

      // buyerB needs position A tokens for selling
      // Give buyerB some position A tokens (split and transfer)
      const splitAmt = ethers.utils.parseUnits("1000", 6);
      await collateral.mint(owner.address, splitAmt);
      await conditionalTokens.connect(owner).splitPosition(
        collateral.address, ethers.constants.HashZero, conditionId, [1, 2], splitAmt
      );
      await erc1155Facet.connect(owner).safeTransferFrom(
        owner.address, buyerB.address, positionIdA, splitAmt, "0x"
      );

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig1 = await signOrder(seller, makerOrder1);
      const makerSig2 = await signOrder(buyerB, makerOrder2);

      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder1, makerOrder2], [makerSig1, makerSig2], [0, 0],
        totalFill, [halfFill, halfFill]
      );

      const takerHash = await sigVerifier.getOrderHash(takerOrder);
      expect(await settlement.getFilledAmount(takerHash)).to.equal(totalFill);
    });
  });

  // ========================================
  // MIN FILL AMOUNT TESTS (HIGH-2)
  // ========================================

  describe("minFillAmount enforcement", function () {
    const price = UNIT.div(2);
    const orderAmount = ethers.utils.parseUnits("1000", 6);

    it("should revert when fill amount is below minFillAmount", async function () {
      const minFill = ethers.utils.parseUnits("100", 6);
      const fillAmount = ethers.utils.parseUnits("50", 6); // below min

      const takerOrder = makeOrder(buyer.address, positionIdA, 0, orderAmount, price, { salt: 22000, minFillAmount: minFill });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, orderAmount, price, { salt: 22000 });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          fillAmount, [fillAmount]
        )
      ).to.be.reverted;
    });

    it("should revert when maker fill amount is below maker minFillAmount", async function () {
      const minFill = ethers.utils.parseUnits("100", 6);
      const fillAmount = ethers.utils.parseUnits("50", 6);

      const takerOrder = makeOrder(buyer.address, positionIdA, 0, orderAmount, price, { salt: 22001 });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, orderAmount, price, { salt: 22001, minFillAmount: minFill });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          fillAmount, [fillAmount]
        )
      ).to.be.reverted;
    });

    it("should succeed when fill amount equals minFillAmount", async function () {
      const minFill = ethers.utils.parseUnits("100", 6);
      const fillAmount = ethers.utils.parseUnits("100", 6);

      const takerOrder = makeOrder(buyer.address, positionIdA, 0, orderAmount, price, { salt: 22002, minFillAmount: minFill });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, orderAmount, price, { salt: 22002 });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fillAmount, [fillAmount]
      );

      const takerHash = await sigVerifier.getOrderHash(takerOrder);
      expect(await settlement.getFilledAmount(takerHash)).to.equal(fillAmount);
    });

    it("should allow exact-remaining fill even if below minFillAmount", async function () {
      const minFill = ethers.utils.parseUnits("100", 6);
      const totalAmount = ethers.utils.parseUnits("150", 6);
      const firstFill = ethers.utils.parseUnits("100", 6);
      const remaining = ethers.utils.parseUnits("50", 6); // below min, but is exact remaining

      const takerOrder = makeOrder(buyer.address, positionIdA, 0, totalAmount, price, { salt: 22003, minFillAmount: minFill });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, totalAmount, price, { salt: 22003 });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      // First fill at minFillAmount
      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        firstFill, [firstFill]
      );

      // Fill exact remaining (50 < minFill 100, but it's the last fill)
      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        remaining, [remaining]
      );

      const takerHash = await sigVerifier.getOrderHash(takerOrder);
      expect(await settlement.getFilledAmount(takerHash)).to.equal(totalAmount);
    });

    it("should succeed when minFillAmount is 0 (no restriction)", async function () {
      const fillAmount = ethers.utils.parseUnits("1", 6); // tiny fill, minFill=0

      const takerOrder = makeOrder(buyer.address, positionIdA, 0, orderAmount, price, { salt: 22004, minFillAmount: 0 });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, orderAmount, price, { salt: 22004 });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fillAmount, [fillAmount]
      );

      const takerHash = await sigVerifier.getOrderHash(takerOrder);
      expect(await settlement.getFilledAmount(takerHash)).to.equal(fillAmount);
    });
  });

  // ========================================
  // FEE RATE CAP TESTS (HIGH-1)
  // ========================================

  describe("Fee rate cap (MAX_FEE_RATE_BPS)", function () {
    const fillAmount = ethers.utils.parseUnits("100", 6);
    const price = UNIT.div(2);

    it("should revert when feeRateBps exceeds 500 (5%)", async function () {
      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, { salt: 21000, feeRateBps: 501 });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, { salt: 21000, feeRateBps: FEE_BPS });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          fillAmount, [fillAmount]
        )
      ).to.be.revertedWith("FeeTooHigh()");
    });

    it("should revert when maker feeRateBps exceeds 500", async function () {
      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, { salt: 21001, feeRateBps: FEE_BPS });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, { salt: 21001, feeRateBps: 501 });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          fillAmount, [fillAmount]
        )
      ).to.be.revertedWith("FeeTooHigh()");
    });

    it("should succeed at exactly 500 bps (5%)", async function () {
      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, { salt: 21002, feeRateBps: 500 });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, { salt: 21002, feeRateBps: 500 });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fillAmount, [fillAmount]
      );

      const takerHash = await sigVerifier.getOrderHash(takerOrder);
      expect(await settlement.getFilledAmount(takerHash)).to.equal(fillAmount);
    });

    it("should revert fillOrder when feeRateBps exceeds 500", async function () {
      const order = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, { salt: 21003, feeRateBps: 10000 });
      const sig = await signOrder(buyer, order);

      await expect(
        settlement.connect(operator).fillOrder(order, sig, 0, fillAmount)
      ).to.be.revertedWith("FeeTooHigh()");
    });
  });

  // ========================================
  // PRICE SUM INVARIANT TESTS (CRITICAL-1)
  // ========================================

  describe("Price sum invariant", function () {
    const fillAmount = ethers.utils.parseUnits("100", 6);

    it("should revert mint when prices do not sum to unit", async function () {
      // 0.3 + 0.3 = 0.6 != 1.0 — under-collateralized
      const priceA = UNIT.mul(3).div(10); // 0.3
      const priceB = UNIT.mul(3).div(10); // 0.3

      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, priceA, { salt: 20000 });
      const makerOrder = makeOrder(buyerB.address, positionIdB, 0, fillAmount, priceB, { salt: 20000 });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(buyerB, makerOrder);

      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          fillAmount, [fillAmount]
        )
      ).to.be.revertedWith("InvalidMatch()");
    });

    it("should revert mint when prices exceed unit", async function () {
      // 0.7 + 0.7 = 1.4 > 1.0 — over-collateralized
      const priceA = UNIT.mul(7).div(10);
      const priceB = UNIT.mul(7).div(10);

      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, priceA, { salt: 20001 });
      const makerOrder = makeOrder(buyerB.address, positionIdB, 0, fillAmount, priceB, { salt: 20001 });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(buyerB, makerOrder);

      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          fillAmount, [fillAmount]
        )
      ).to.be.revertedWith("InvalidMatch()");
    });

    it("should succeed mint when prices sum to exactly unit", async function () {
      const priceA = UNIT.mul(6).div(10); // 0.6
      const priceB = UNIT.mul(4).div(10); // 0.4

      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, priceA, { salt: 20002 });
      const makerOrder = makeOrder(buyerB.address, positionIdB, 0, fillAmount, priceB, { salt: 20002 });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(buyerB, makerOrder);

      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fillAmount, [fillAmount]
      );

      // Verify positions were minted
      const buyerPos = await erc1155Facet.balanceOf(buyer.address, positionIdA);
      expect(buyerPos.gt(0)).to.equal(true);
    });

    it("should revert merge when payouts exceed fillAmount", async function () {
      // 0.7 + 0.7 = 1.4 > 1.0
      const priceA = UNIT.mul(7).div(10);
      const priceB = UNIT.mul(7).div(10);

      const takerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, priceA, { salt: 20003 });
      const makerOrder = makeOrder(buyerB.address, positionIdB, 1, fillAmount, priceB, { salt: 20003 });

      const takerSig = await signOrder(seller, takerOrder);
      const makerSig = await signOrder(buyerB, makerOrder);

      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          fillAmount, [fillAmount]
        )
      ).to.be.revertedWith("InvalidMatch()");
    });

    it("should succeed merge when payouts equal fillAmount", async function () {
      const priceA = UNIT.mul(6).div(10); // 0.6
      const priceB = UNIT.mul(4).div(10); // 0.4

      const takerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, priceA, { salt: 20004 });
      const makerOrder = makeOrder(buyerB.address, positionIdB, 1, fillAmount, priceB, { salt: 20004 });

      const takerSig = await signOrder(seller, takerOrder);
      const makerSig = await signOrder(buyerB, makerOrder);

      const sellerCollBefore = await collateral.balanceOf(seller.address);

      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fillAmount, [fillAmount]
      );

      const sellerCollAfter = await collateral.balanceOf(seller.address);
      expect(sellerCollAfter.sub(sellerCollBefore).gt(0)).to.equal(true);
    });
  });

  // ========================================
  // EDGE CASE: EXACT REMAINING FILL
  // ========================================

  describe("Edge case: fill exactly remaining", function () {
    it("should fill exactly the remaining amount", async function () {
      const totalAmount = ethers.utils.parseUnits("100", 6);
      const firstFill = ethers.utils.parseUnits("60", 6);
      const remaining = ethers.utils.parseUnits("40", 6);
      const price = UNIT.div(2);

      const takerOrder = makeOrder(buyer.address, positionIdA, 0, totalAmount, price, { salt: 11000 });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, totalAmount, price, { salt: 11000 });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      // First fill
      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        firstFill, [firstFill]
      );

      // Fill exactly the remaining
      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        remaining, [remaining]
      );

      const takerHash = await sigVerifier.getOrderHash(takerOrder);
      expect(await settlement.getFilledAmount(takerHash)).to.equal(totalAmount);

      // One more should revert (overfill)
      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          1, [1]
        )
      ).to.be.reverted;
    });
  });

  // ========================================
  // ECDSA SIGNATURE MALLEABILITY (HIGH-3)
  // ========================================

  describe("ECDSA signature malleability rejection", function () {
    const fillAmount = ethers.utils.parseUnits("100", 6);
    const price = UNIT.div(2);

    // secp256k1 curve order
    const SECP256K1_N = ethers.BigNumber.from("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");

    it("should reject a malleable signature (high-s value)", async function () {
      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, { salt: 30000 });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, { salt: 30000 });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      // Flip the taker signature's s-value to n - s (creates a malleable signature)
      const sigBytes = ethers.utils.arrayify(takerSig);
      const r = ethers.utils.hexlify(sigBytes.slice(0, 32));
      const s = ethers.BigNumber.from(sigBytes.slice(32, 64));
      const v = sigBytes[64];

      // Compute malleable s: n - s
      const malleableS = SECP256K1_N.sub(s);
      // Flip v: 27 -> 28, 28 -> 27
      const malleableV = v === 27 ? 28 : 27;

      const malleableSig = ethers.utils.hexlify(
        ethers.utils.concat([
          r,
          ethers.utils.hexZeroPad(malleableS.toHexString(), 32),
          [malleableV],
        ])
      );

      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, malleableSig, 0,
          [makerOrder], [makerSig], [0],
          fillAmount, [fillAmount]
        )
      ).to.be.reverted;
    });

    it("should accept the original (low-s) signature", async function () {
      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, { salt: 30001 });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, { salt: 30001 });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      // ethers.js already produces low-s signatures, so this should succeed
      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fillAmount, [fillAmount]
      );

      const takerHash = await sigVerifier.getOrderHash(takerOrder);
      expect(await settlement.getFilledAmount(takerHash)).to.equal(fillAmount);
    });
  });

  // ========================================
  // COMPLEMENTARY PRICE COMPATIBILITY (MEDIUM-2)
  // ========================================

  describe("Complementary price compatibility", function () {
    const fillAmount = ethers.utils.parseUnits("100", 6);

    it("should revert when buyer price < seller price", async function () {
      // Buyer at 0.3, seller at 0.7 -- buyer cannot afford the seller's ask
      const buyerPrice = UNIT.mul(3).div(10); // 0.3
      const sellerPrice = UNIT.mul(7).div(10); // 0.7

      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, buyerPrice, { salt: 31000 });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, sellerPrice, { salt: 31000 });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          fillAmount, [fillAmount]
        )
      ).to.be.revertedWith("InvalidMatch()");
    });

    it("should succeed when buyer price > seller price", async function () {
      // Buyer at 0.7, seller at 0.3 -- buyer willing to pay more than seller asks
      const buyerPrice = UNIT.mul(7).div(10); // 0.7
      const sellerPrice = UNIT.mul(3).div(10); // 0.3

      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, buyerPrice, { salt: 31001 });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, sellerPrice, { salt: 31001 });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fillAmount, [fillAmount]
      );

      const takerHash = await sigVerifier.getOrderHash(takerOrder);
      expect(await settlement.getFilledAmount(takerHash)).to.equal(fillAmount);
    });

    it("should succeed when buyer price == seller price", async function () {
      const price = UNIT.div(2); // 0.5

      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, { salt: 31002 });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, { salt: 31002 });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fillAmount, [fillAmount]
      );

      const takerHash = await sigVerifier.getOrderHash(takerOrder);
      expect(await settlement.getFilledAmount(takerHash)).to.equal(fillAmount);
    });

    it("should revert when taker is seller and maker buyer price < taker seller price", async function () {
      // Taker is the seller (side=1) at 0.7, maker is the buyer (side=0) at 0.3
      const sellerPrice = UNIT.mul(7).div(10);
      const buyerPrice = UNIT.mul(3).div(10);

      const takerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, sellerPrice, { salt: 31003 });
      const makerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, buyerPrice, { salt: 31003 });

      const takerSig = await signOrder(seller, takerOrder);
      const makerSig = await signOrder(buyer, makerOrder);

      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          fillAmount, [fillAmount]
        )
      ).to.be.revertedWith("InvalidMatch()");
    });
  });

  // ========================================
  // FEE UNDERFLOW ON PRICE > UNIT (MEDIUM-4)
  // ========================================

  describe("_computeFee underflow protection (price > unit)", function () {
    const fillAmount = ethers.utils.parseUnits("100", 6);

    it("should revert when pricePerToken exceeds UNIT", async function () {
      // Price = 1.5 UNIT (above 1.0) -- would underflow in unit - price
      const badPrice = UNIT.mul(3).div(2); // 1500000

      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, badPrice, { salt: 32000 });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, badPrice, { salt: 32000 });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          fillAmount, [fillAmount]
        )
      ).to.be.revertedWith("InvalidPrice()");
    });

    it("should succeed when price equals exactly UNIT", async function () {
      // Price = 1.0 UNIT -- edge case, complementPrice = 0, effectivePrice = 0, fee = 0
      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, UNIT, { salt: 32001 });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, UNIT, { salt: 32001 });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      // This should succeed -- price == unit means fee = 0 (effectivePrice = min(unit, 0) = 0)
      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fillAmount, [fillAmount]
      );

      const takerHash = await sigVerifier.getOrderHash(takerOrder);
      expect(await settlement.getFilledAmount(takerHash)).to.equal(fillAmount);
    });
  });
});
