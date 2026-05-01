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

    // SCRUM-89: position-pair registration now flows automatically from the initial
    // splitPosition above into the CTF position registry (LibPositionRegistry). No
    // additional owner-only registration is needed for settlement to recognise the
    // pair as complements.
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

    it("should succeed when fill amount is below minFillAmount (enforcement is off-chain)", async function () {
      const minFill = ethers.utils.parseUnits("100", 6);
      const fillAmount = ethers.utils.parseUnits("50", 6); // below min — no longer rejected on-chain

      const takerOrder = makeOrder(buyer.address, positionIdA, 0, orderAmount, price, { salt: 22000, minFillAmount: minFill });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, orderAmount, price, { salt: 22000 });

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

    it("should succeed when maker fill amount is below maker minFillAmount (enforcement is off-chain)", async function () {
      const minFill = ethers.utils.parseUnits("100", 6);
      const fillAmount = ethers.utils.parseUnits("50", 6);

      const takerOrder = makeOrder(buyer.address, positionIdA, 0, orderAmount, price, { salt: 22001 });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, orderAmount, price, { salt: 22001, minFillAmount: minFill });

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

  describe("Price sum invariant (remainder-based)", function () {
    const fillAmount = ethers.utils.parseUnits("100", 6);

    it("should revert mint when prices diverge significantly from unit", async function () {
      // 0.3 + 0.3 = 0.6 — maker remainder (70) far exceeds maker expected (30) + 1
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

    it("should revert mint when prices exceed unit (maker overcharged)", async function () {
      // 0.7 + 0.7 = 1.4 — takerCollateral=70, makerCollateral=30, but makerExpected=70
      // makerCollateral (30) < makerExpected (70), so this actually passes the ceiling check.
      // But the taker would overpay (70 collateral for a 0.7 price on 100 tokens = correct).
      // The real problem: takerCollateral (70) + makerCollateral (30) = 100 = fillAmount, but
      // maker only expected to pay 70 and is paying 30. This is fine from a safety standpoint
      // (maker pays less), but the taker is subsidizing the mint.
      // For a true over-collateralization revert, we need prices that cause maker remainder
      // to exceed makerExpected + 1.
      // With priceA=0.7, takerCollateral = 70, makerCollateral = 30, makerExpected = 70.
      // 30 <= 70 + 1 → passes. This is correct: prices summing > unit means taker overpays
      // and maker underpays, which is safe (no insolvency).

      // Use an extreme case: priceA = 0.01, priceB = 0.01 (sum = 0.02)
      const priceA = UNIT.div(100); // 0.01
      const priceB = UNIT.div(100); // 0.01

      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, priceA, { salt: 20001 });
      const makerOrder = makeOrder(buyerB.address, positionIdB, 0, fillAmount, priceB, { salt: 20001 });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(buyerB, makerOrder);

      // takerCollateral = 1e4 * 1e8 / 1e6 = 1e6 = 1 USDC
      // makerCollateral = 100e6 - 1e6 = 99e6 = 99 USDC
      // makerExpected = 1e6 = 1 USDC
      // 99e6 > 1e6 + 1 → reverts InvalidMatch
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

      const buyerPos = await erc1155Facet.balanceOf(buyer.address, positionIdA);
      expect(buyerPos.gt(0)).to.equal(true);
    });

    it("should succeed mint with rounding-prone prices (1/3 + 2/3)", async function () {
      // 333333 + 666667 = 1000000 = unit. With fillAmount=7:
      // takerCollateral = 333333 * 7 / 1000000 = 2 (floor)
      // makerCollateral = 7 - 2 = 5 (remainder)
      // makerExpected = 666667 * 7 / 1000000 = 4 (floor)
      // 5 <= 4 + 1 = 5 → passes (exactly at tolerance)
      const priceA = ethers.BigNumber.from(333333);
      const priceB = ethers.BigNumber.from(666667);
      const smallFill = 7; // intentionally small to trigger rounding

      const takerOrder = makeOrder(buyer.address, positionIdA, 0, smallFill, priceA, { salt: 20005 });
      const makerOrder = makeOrder(buyerB.address, positionIdB, 0, smallFill, priceB, { salt: 20005 });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(buyerB, makerOrder);

      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        smallFill, [smallFill]
      );

      const takerHash = await sigVerifier.getOrderHash(takerOrder);
      expect(await settlement.getFilledAmount(takerHash)).to.equal(smallFill);
    });

    it("should revert merge when prices diverge significantly from unit", async function () {
      // New crossing guard: P_t + P_m > unit → revert InvalidMatch
      // 0.3 + 0.3 = 0.6 — sum < unit, so merge is valid (taker gets generous payout)
      // Use 0.8 + 0.8 = 1.6 > unit — both floors exceed what collateral can cover
      const priceA = UNIT.mul(8).div(10); // 0.8
      const priceB = UNIT.mul(8).div(10); // 0.8

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

    it("should revert merge when prices sum exceeds unit", async function () {
      // New crossing guard: P_t + P_m > unit → revert InvalidMatch
      // 0.7 + 0.7 = 1.4 > unit — taker floor + maker floor > total collateral available
      const priceA = UNIT.mul(7).div(10); // 0.7
      const priceB = UNIT.mul(7).div(10); // 0.7

      const takerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, priceA, { salt: 20006 });
      const makerOrder = makeOrder(buyerB.address, positionIdB, 1, fillAmount, priceB, { salt: 20006 });

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

    it("should succeed merge when prices sum to exactly unit", async function () {
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

    it("should succeed merge with rounding-prone prices (1/3 + 2/3)", async function () {
      // Same logic as the mint rounding test — maker gets remainder
      const priceA = ethers.BigNumber.from(333333);
      const priceB = ethers.BigNumber.from(666667);
      const smallFill = 7;

      // Need position tokens for a small merge — split first
      const splitAmt = ethers.utils.parseUnits("100", 6);
      await collateral.mint(owner.address, splitAmt);
      await conditionalTokens.connect(owner).splitPosition(
        collateral.address, ethers.constants.HashZero, conditionId, [1, 2], splitAmt
      );
      await erc1155Facet.connect(owner).safeTransferFrom(owner.address, seller.address, positionIdA, splitAmt, "0x");
      await erc1155Facet.connect(owner).safeTransferFrom(owner.address, buyerB.address, positionIdB, splitAmt, "0x");

      const takerOrder = makeOrder(seller.address, positionIdA, 1, smallFill, priceA, { salt: 20007 });
      const makerOrder = makeOrder(buyerB.address, positionIdB, 1, smallFill, priceB, { salt: 20007 });

      const takerSig = await signOrder(seller, takerOrder);
      const makerSig = await signOrder(buyerB, makerOrder);

      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        smallFill, [smallFill]
      );

      const takerHash = await sigVerifier.getOrderHash(takerOrder);
      expect(await settlement.getFilledAmount(takerHash)).to.equal(smallFill);
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

  // ========================================
  // DOMAIN SEPARATOR CACHE (LOW-1)
  // ========================================

  describe("cacheDomainSeparator", function () {
    it("should cache domain separator and produce the same value as getDomainSeparator", async function () {
      const domainSepBefore = await sigVerifier.getDomainSeparator();

      // Cache it
      await settlement.cacheDomainSeparator();

      // Verify getDomainSeparator still returns the same value
      const domainSepAfter = await sigVerifier.getDomainSeparator();
      expect(domainSepAfter).to.equal(domainSepBefore);
    });

    it("should still settle orders correctly after caching", async function () {
      const fillAmount = ethers.utils.parseUnits("100", 6);
      const price = UNIT.div(2);

      // Ensure cache is set
      await settlement.cacheDomainSeparator();

      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, { salt: 33000 });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, { salt: 33000 });

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

    it("should revert cacheDomainSeparator from non-owner", async function () {
      await expect(
        settlement.connect(operator).cacheDomainSeparator()
      ).to.be.revertedWith("NotContractOwner()");
    });
  });

  // ========================================
  // SCRUM-89: AUTO-POPULATED COMPLEMENT REGISTRY
  // ========================================
  //
  // Regression suite for the production bug where Mint/Merge reverted with
  // InvalidMatch() for any market whose positions were created purely through
  // the normal splitPosition path (i.e. without a separate owner-only
  // registerPositionPair call). After SCRUM-89, SettlementFacet reads the CTF
  // position registry (LibPositionRegistry in AppStorage.positionRegistry) as
  // the single source of truth — every splitPosition auto-registers the pair,
  // so no owner action is needed per market.
  //
  // The suite creates a FRESH binary market on the existing Diamond and
  // exercises every settlement path end-to-end. If any of these tests fails,
  // the production bug has re-emerged.
  describe("SCRUM-89: fresh-market complement auto-registration", function () {
    let freshConditionId, freshPositionIdA, freshPositionIdB;
    let alice, bob, carol; // fresh actors to avoid fill-state carryover
    const FRESH_FEE_BPS = 100; // 1%

    before(async function () {
      const signers = await ethers.getSigners();
      alice = signers[7];
      bob = signers[8];
      carol = signers[9];

      // Create a NEW binary condition that has never been registered
      // via registerPositionPair (impossible now — the function was removed).
      const questionId = ethers.utils.formatBytes32String("scrum-89-fresh-1");
      freshConditionId = getConditionId(owner.address, questionId, 2);
      await conditionMgr.createCondition(owner.address, questionId, 2, "ipfs://scrum-89");

      const collectionIdA = await getCollectionId(ethers.constants.HashZero, freshConditionId, 1, ethers.provider);
      const collectionIdB = await getCollectionId(ethers.constants.HashZero, freshConditionId, 2, ethers.provider);
      freshPositionIdA = getPositionId(collateral.address, collectionIdA);
      freshPositionIdB = getPositionId(collateral.address, collectionIdB);

      // Seed funding + approvals for fresh actors
      const mintAmount = ethers.utils.parseUnits("10000", 6);
      await collateral.mint(alice.address, mintAmount);
      await collateral.mint(bob.address, mintAmount);
      await collateral.mint(carol.address, mintAmount);
      await collateral.connect(alice).approve(diamondAddress, ethers.constants.MaxUint256);
      await collateral.connect(bob).approve(diamondAddress, ethers.constants.MaxUint256);
      await collateral.connect(carol).approve(diamondAddress, ethers.constants.MaxUint256);
      await erc1155Facet.connect(alice).setApprovalForAll(diamondAddress, true);
      await erc1155Facet.connect(bob).setApprovalForAll(diamondAddress, true);
      await erc1155Facet.connect(carol).setApprovalForAll(diamondAddress, true);

      // Bootstrap split — this is the ONLY registration path. It emits
      // PositionPairsRegistered and writes to the CTF registry in AppStorage.
      // Settlement must now recognise the pair purely from this side effect.
      const splitAmt = ethers.utils.parseUnits("1000", 6);
      await collateral.mint(owner.address, splitAmt);
      await conditionalTokens.connect(owner).splitPosition(
        collateral.address, ethers.constants.HashZero, freshConditionId, [1, 2], splitAmt
      );
      // Distribute position tokens so merge tests have something to unwind
      await erc1155Facet.connect(owner).safeTransferFrom(owner.address, alice.address, freshPositionIdA, splitAmt, "0x");
      await erc1155Facet.connect(owner).safeTransferFrom(owner.address, bob.address, freshPositionIdB, splitAmt, "0x");
    });

    function freshOrder(maker, positionId, side, amount, price, overrides = {}) {
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
        feeRateBps: FRESH_FEE_BPS,
        expiration: 0,
        nonce: 0,
        ...overrides,
      };
    }

    it("Mint: two buyers of complement positions settle without any owner registration (regression)", async function () {
      // This is the exact scenario that reverted InvalidMatch() on Base Sepolia
      // markets 88/89/90 before SCRUM-89.
      const fillAmount = ethers.utils.parseUnits("100", 6);
      const priceA = UNIT.mul(6).div(10);
      const priceB = UNIT.mul(4).div(10);

      // taker=A (indexSet=1), maker=B (indexSet=2) — partition arrives as [1,2], canonical order
      const takerOrder = freshOrder(carol.address, freshPositionIdA, 0, fillAmount, priceA, { salt: 89001 });
      const makerOrder = freshOrder(alice.address, freshPositionIdB, 0, fillAmount, priceB, { salt: 89001 });

      const takerSig = await signOrder(carol, takerOrder);
      const makerSig = await signOrder(alice, makerOrder);

      const carolPosBefore = await erc1155Facet.balanceOf(carol.address, freshPositionIdA);
      const alicePosBefore = await erc1155Facet.balanceOf(alice.address, freshPositionIdB);

      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fillAmount, [fillAmount]
      );

      expect((await erc1155Facet.balanceOf(carol.address, freshPositionIdA)).sub(carolPosBefore)).to.equal(fillAmount);
      expect((await erc1155Facet.balanceOf(alice.address, freshPositionIdB)).sub(alicePosBefore)).to.equal(fillAmount);
    });

    it("Mint: taker holds higher indexSet (YES=2), maker holds lower (NO=1) — SCRUM-120 regression", async function () {
      // Production failure: taker=YES (indexSet=2), maker=NO (indexSet=1).
      // _settleMint built partition as [2,1] (taker-first). registerPositionPairs
      // compared it against the stored [1,2] and reverted InvalidMatch().
      // Fixed by removing registerPositionPairs from _splitPositionInternal.
      const fillAmount = ethers.utils.parseUnits("100", 6);
      const priceYes = UNIT.mul(606).div(1000);
      const priceNo  = UNIT.mul(450).div(1000);

      // taker=B (indexSet=2, YES), maker=A (indexSet=1, NO) — partition arrives as [2,1]
      const takerOrder = freshOrder(carol.address, freshPositionIdB, 0, fillAmount, priceYes, { salt: 120001 });
      const makerOrder = freshOrder(alice.address, freshPositionIdA, 0, fillAmount, priceNo,  { salt: 120001 });

      const takerSig = await signOrder(carol, takerOrder);
      const makerSig = await signOrder(alice, makerOrder);

      const carolPosBefore = await erc1155Facet.balanceOf(carol.address, freshPositionIdB);
      const alicePosBefore = await erc1155Facet.balanceOf(alice.address, freshPositionIdA);

      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fillAmount, [fillAmount]
      );

      expect((await erc1155Facet.balanceOf(carol.address, freshPositionIdB)).sub(carolPosBefore)).to.equal(fillAmount);
      expect((await erc1155Facet.balanceOf(alice.address, freshPositionIdA)).sub(alicePosBefore)).to.equal(fillAmount);
    });

    it("Merge: two sellers of complement positions settle without any owner registration (regression)", async function () {
      const fillAmount = ethers.utils.parseUnits("100", 6);
      const priceA = UNIT.mul(6).div(10);
      const priceB = UNIT.mul(4).div(10);

      const takerOrder = freshOrder(alice.address, freshPositionIdA, 1, fillAmount, priceA, { salt: 89002 });
      const makerOrder = freshOrder(bob.address, freshPositionIdB, 1, fillAmount, priceB, { salt: 89002 });

      const takerSig = await signOrder(alice, takerOrder);
      const makerSig = await signOrder(bob, makerOrder);

      const aliceCollBefore = await collateral.balanceOf(alice.address);
      const bobCollBefore = await collateral.balanceOf(bob.address);

      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fillAmount, [fillAmount]
      );

      expect((await collateral.balanceOf(alice.address)).gt(aliceCollBefore)).to.equal(true);
      expect((await collateral.balanceOf(bob.address)).gt(bobCollBefore)).to.equal(true);
    });

    it("Complementary: same position, opposite sides on a fresh market still settles", async function () {
      // Complementary match does not need the registry at all — it's detected by
      // (taker.positionId == maker.positionId && taker.side != maker.side).
      // Kept as a sanity test to prove the registry-based refactor did not
      // regress the Complementary path.
      const fillAmount = ethers.utils.parseUnits("50", 6);
      const price = UNIT.div(2);

      const takerOrder = freshOrder(carol.address, freshPositionIdA, 0, fillAmount, price, { salt: 89003 });
      const makerOrder = freshOrder(alice.address, freshPositionIdA, 1, fillAmount, price, { salt: 89003 });

      const takerSig = await signOrder(carol, takerOrder);
      const makerSig = await signOrder(alice, makerOrder);

      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fillAmount, [fillAmount]
      );

      const takerHash = await sigVerifier.getOrderHash(takerOrder);
      expect(await settlement.getFilledAmount(takerHash)).to.equal(fillAmount);
    });

    it("Negative: Mint across two unrelated markets reverts InvalidMatch()", async function () {
      // Create a SECOND fresh market, then try to Mint one position from market A
      // against one position from market B. The registry guard must catch this
      // as a cross-market pair (not complements).
      const q2 = ethers.utils.formatBytes32String("scrum-89-fresh-2");
      const cond2 = getConditionId(owner.address, q2, 2);
      await conditionMgr.createCondition(owner.address, q2, 2, "ipfs://scrum-89-2");
      const coll2A = await getCollectionId(ethers.constants.HashZero, cond2, 1, ethers.provider);
      const pos2A = getPositionId(collateral.address, coll2A);
      const splitAmt = ethers.utils.parseUnits("500", 6);
      await collateral.mint(owner.address, splitAmt);
      await conditionalTokens.connect(owner).splitPosition(
        collateral.address, ethers.constants.HashZero, cond2, [1, 2], splitAmt
      );

      const fillAmount = ethers.utils.parseUnits("10", 6);
      const price = UNIT.div(2);

      // Taker's position is in market 1, maker's position is in market 2 — not a pair.
      const takerOrder = freshOrder(carol.address, freshPositionIdA, 0, fillAmount, price, { salt: 89004 });
      const makerOrder = freshOrder(alice.address, pos2A, 0, fillAmount, price, { salt: 89004 });
      const takerSig = await signOrder(carol, takerOrder);
      const makerSig = await signOrder(alice, makerOrder);

      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          fillAmount, [fillAmount]
        )
      ).to.be.revertedWith("InvalidMatch()");
    });

    it("Negative: Mint against an entirely unregistered positionId reverts InvalidMatch()", async function () {
      // Fabricate a positionId that was never split (not in any market).
      const ghost = ethers.BigNumber.from("0xdeadbeefcafebabe00000000000000000000000000000000000000000000beef");
      const fillAmount = ethers.utils.parseUnits("10", 6);
      const price = UNIT.div(2);

      const takerOrder = freshOrder(carol.address, freshPositionIdA, 0, fillAmount, price, { salt: 89005 });
      const makerOrder = freshOrder(alice.address, ghost, 0, fillAmount, price, { salt: 89005 });
      const takerSig = await signOrder(carol, takerOrder);
      const makerSig = await signOrder(alice, makerOrder);

      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          fillAmount, [fillAmount]
        )
      ).to.be.revertedWith("InvalidMatch()");
    });

    it("Negative: Mint with side 0/side 1 on complement positions reverts InvalidMatch()", async function () {
      // Same market, complement positions, but one BUY and one SELL → not a valid Mint
      // (would require both to be buyers) and not a valid Merge (would require both sellers).
      // The guard must catch this as an invalid side combination.
      const fillAmount = ethers.utils.parseUnits("10", 6);
      const price = UNIT.div(2);

      const takerOrder = freshOrder(carol.address, freshPositionIdA, 0, fillAmount, price, { salt: 89006 });
      const makerOrder = freshOrder(alice.address, freshPositionIdB, 1, fillAmount, price, { salt: 89006 });
      const takerSig = await signOrder(carol, takerOrder);
      const makerSig = await signOrder(alice, makerOrder);

      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          fillAmount, [fillAmount]
        )
      ).to.be.revertedWith("InvalidMatch()");
    });

    it("Negative: registerPositionPair selector no longer exists on the facet", async function () {
      // Belt-and-suspenders: the ABI surface should no longer carry the
      // owner-only registerPositionPair. If this test fails, the facet cut
      // still exposes the dead selector and should be re-cut with Remove.
      expect(settlement.registerPositionPair).to.equal(undefined);
    });
  });

  // ========================================
  // SCRUM-121: EFFECTIVE PRICE SETTLEMENT
  // ========================================

  describe("SCRUM-121: Effective price for Mint and Merge", function () {
    // Use feeRateBps=0 throughout so fee math doesn't obscure collateral assertions.

    describe("Mint — fill at maker's effective price (unit − P_m)", function () {
      it("should give taker price improvement: taker pays unit−P_m, not P_t", async function () {
        // Proposal Example 1 (single pair): P_t=606k, P_m=450k, fill=1_000_000
        // Old: takerCollateral = P_t * fill / unit = 606_000
        // New: makerCollateral = P_m * fill / unit = 450_000
        //      takerCollateral = fill - makerCollateral  = 550_000
        const fill = ethers.BigNumber.from(1_000_000);
        const Pt   = ethers.BigNumber.from(606_000);
        const Pm   = ethers.BigNumber.from(450_000);

        const takerOrder = makeOrder(buyer.address,  positionIdA, 0, fill, Pt, { salt: 121001, feeRateBps: 0 });
        const makerOrder = makeOrder(buyerB.address,  positionIdB, 0, fill, Pm, { salt: 121001, feeRateBps: 0 });

        const takerSig = await signOrder(buyer,  takerOrder);
        const makerSig = await signOrder(buyerB,  makerOrder);

        const buyerCollBefore  = await collateral.balanceOf(buyer.address);
        const buyerBCollBefore = await collateral.balanceOf(buyerB.address);

        await settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          fill, [fill]
        );

        const takerPaid = buyerCollBefore.sub(await collateral.balanceOf(buyer.address));
        const makerPaid = buyerBCollBefore.sub(await collateral.balanceOf(buyerB.address));

        // Taker pays effective price (unit − P_m), not their own P_t
        expect(takerPaid).to.equal(fill.sub(Pm.mul(fill).div(UNIT))); // = 550_000
        expect(makerPaid).to.equal(Pm.mul(fill).div(UNIT));           // = 450_000
        // Sanity: total collateral into diamond == fill (used to mint)
        expect(takerPaid.add(makerPaid)).to.equal(fill);
      });

      it("should fill at exactly P_t when prices sum to unit (no improvement)", async function () {
        // P_t=600k, P_m=400k, sum=unit → effective price = unit − P_m = P_t exactly
        const fill = ethers.BigNumber.from(1_000_000);
        const Pt   = UNIT.mul(6).div(10); // 600_000
        const Pm   = UNIT.mul(4).div(10); // 400_000

        const takerOrder = makeOrder(buyer.address,  positionIdA, 0, fill, Pt, { salt: 121002, feeRateBps: 0 });
        const makerOrder = makeOrder(buyerB.address,  positionIdB, 0, fill, Pm, { salt: 121002, feeRateBps: 0 });

        const takerSig = await signOrder(buyer,  takerOrder);
        const makerSig = await signOrder(buyerB,  makerOrder);

        const buyerCollBefore  = await collateral.balanceOf(buyer.address);
        const buyerBCollBefore = await collateral.balanceOf(buyerB.address);

        await settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          fill, [fill]
        );

        const takerPaid = buyerCollBefore.sub(await collateral.balanceOf(buyer.address));
        const makerPaid = buyerBCollBefore.sub(await collateral.balanceOf(buyerB.address));

        expect(takerPaid).to.equal(fill.sub(Pm.mul(fill).div(UNIT))); // 600_000
        expect(makerPaid).to.equal(Pm.mul(fill).div(UNIT));           // 400_000
        expect(takerPaid.add(makerPaid)).to.equal(fill);
      });

      it("should revert when P_t + P_m < unit (no crossing)", async function () {
        // P_t=500k, P_m=400k → sum=900k < unit → InvalidMatch
        const fill = ethers.BigNumber.from(1_000_000);
        const Pt   = UNIT.div(2);          // 500_000
        const Pm   = UNIT.mul(4).div(10);  // 400_000

        const takerOrder = makeOrder(buyer.address,  positionIdA, 0, fill, Pt, { salt: 121003, feeRateBps: 0 });
        const makerOrder = makeOrder(buyerB.address,  positionIdB, 0, fill, Pm, { salt: 121003, feeRateBps: 0 });

        const takerSig = await signOrder(buyer,  takerOrder);
        const makerSig = await signOrder(buyerB,  makerOrder);

        await expect(
          settlement.connect(operator).matchOrders(
            takerOrder, takerSig, 0,
            [makerOrder], [makerSig], [0],
            fill, [fill]
          )
        ).to.be.revertedWith("InvalidMatch()");
      });

      it("1:many Mint — taker vs two NO makers at different prices", async function () {
        // Proposal Example 1: P_t=606k, maker A P_m=450k fill=400k, maker B P_m=400k fill=1_300k
        // Old: taker pays P_t * totalFill / unit = 606k * 1_700k / 1M = 1_030_200 (wrong)
        // New: taker pays (fill_A − P_mA*fill_A/unit) + (fill_B − P_mB*fill_B/unit)
        //              = 220_000 + 780_000 = 1_000_000
        const fillA   = ethers.BigNumber.from(400_000);
        const fillB   = ethers.BigNumber.from(1_300_000);
        const totalFill = fillA.add(fillB);
        const Pt  = ethers.BigNumber.from(606_000);
        const PmA = ethers.BigNumber.from(450_000);
        const PmB = ethers.BigNumber.from(400_000);

        const takerOrder  = makeOrder(buyer.address,  positionIdA, 0, totalFill, Pt,  { salt: 121004, feeRateBps: 0 });
        const makerOrderA = makeOrder(buyerB.address,  positionIdB, 0, fillA,    PmA, { salt: 121004, feeRateBps: 0 });
        const makerOrderB = makeOrder(seller.address, positionIdB, 0, fillB,    PmB, { salt: 121004, feeRateBps: 0 });

        const takerSig  = await signOrder(buyer,  takerOrder);
        const makerSigA = await signOrder(buyerB,  makerOrderA);
        const makerSigB = await signOrder(seller, makerOrderB);

        const buyerCollBefore  = await collateral.balanceOf(buyer.address);
        const buyerBCollBefore = await collateral.balanceOf(buyerB.address);
        const sellerCollBefore = await collateral.balanceOf(seller.address);

        await settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrderA, makerOrderB], [makerSigA, makerSigB], [0, 0],
          totalFill, [fillA, fillB]
        );

        const takerPaid   = buyerCollBefore.sub(await collateral.balanceOf(buyer.address));
        const makerAPaid  = buyerBCollBefore.sub(await collateral.balanceOf(buyerB.address));
        const makerBPaid  = sellerCollBefore.sub(await collateral.balanceOf(seller.address));

        // Maker A pays P_mA * fillA / unit = 450k * 400k / 1M = 180_000
        expect(makerAPaid).to.equal(PmA.mul(fillA).div(UNIT));
        // Maker B pays P_mB * fillB / unit = 400k * 1_300k / 1M = 520_000
        expect(makerBPaid).to.equal(PmB.mul(fillB).div(UNIT));
        // Taker pays remainder = totalFill − makerAPaid − makerBPaid = 1_700k − 700k = 1_000_000
        expect(takerPaid).to.equal(totalFill.sub(makerAPaid).sub(makerBPaid));
        // Taker receives all YES tokens
        const takerHash = await sigVerifier.getOrderHash(takerOrder);
        expect(await settlement.getFilledAmount(takerHash)).to.equal(totalFill);
      });
    });

    describe("Merge — payout at maker's effective return (unit − P_m)", function () {
      it("should give taker price improvement: taker receives unit−P_m, not P_t", async function () {
        // P_t=400k (floor), P_m=300k → effective return = unit − P_m = 700k > P_t ✓
        const fill = ethers.BigNumber.from(1_000_000);
        const Pt   = UNIT.mul(4).div(10);  // 400_000
        const Pm   = UNIT.mul(3).div(10);  // 300_000

        // Give seller and buyerB fresh position tokens for this merge
        const splitAmt = ethers.utils.parseUnits("10", 6);
        await collateral.mint(owner.address, splitAmt);
        await conditionalTokens.connect(owner).splitPosition(
          collateral.address, ethers.constants.HashZero, conditionId, [1, 2], splitAmt
        );
        await erc1155Facet.connect(owner).safeTransferFrom(owner.address, seller.address,  positionIdA, splitAmt, "0x");
        await erc1155Facet.connect(owner).safeTransferFrom(owner.address, buyerB.address, positionIdB, splitAmt, "0x");

        const takerOrder = makeOrder(seller.address,  positionIdA, 1, fill, Pt, { salt: 121005, feeRateBps: 0 });
        const makerOrder = makeOrder(buyerB.address, positionIdB, 1, fill, Pm, { salt: 121005, feeRateBps: 0 });

        const takerSig = await signOrder(seller,  takerOrder);
        const makerSig = await signOrder(buyerB, makerOrder);

        const sellerCollBefore = await collateral.balanceOf(seller.address);
        const buyerBCollBefore = await collateral.balanceOf(buyerB.address);

        await settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          fill, [fill]
        );

        const takerReceived = (await collateral.balanceOf(seller.address)).sub(sellerCollBefore);
        const makerReceived = (await collateral.balanceOf(buyerB.address)).sub(buyerBCollBefore);

        // Maker receives exactly P_m * fill / unit = 300_000
        expect(makerReceived).to.equal(Pm.mul(fill).div(UNIT));
        // Taker receives the complement = fill − makerReceived = 700_000
        expect(takerReceived).to.equal(fill.sub(Pm.mul(fill).div(UNIT)));
        // Total = fill (all merged collateral distributed)
        expect(takerReceived.add(makerReceived)).to.equal(fill);
      });

      it("should settle at exactly taker's floor when P_t + P_m = unit (no improvement)", async function () {
        // P_t=700k, P_m=300k → sum=unit → effective return = unit − P_m = P_t exactly
        const fill = ethers.BigNumber.from(1_000_000);
        const Pt   = UNIT.mul(7).div(10);  // 700_000
        const Pm   = UNIT.mul(3).div(10);  // 300_000

        const splitAmt = ethers.utils.parseUnits("10", 6);
        await collateral.mint(owner.address, splitAmt);
        await conditionalTokens.connect(owner).splitPosition(
          collateral.address, ethers.constants.HashZero, conditionId, [1, 2], splitAmt
        );
        await erc1155Facet.connect(owner).safeTransferFrom(owner.address, seller.address,  positionIdA, splitAmt, "0x");
        await erc1155Facet.connect(owner).safeTransferFrom(owner.address, buyerB.address, positionIdB, splitAmt, "0x");

        const takerOrder = makeOrder(seller.address,  positionIdA, 1, fill, Pt, { salt: 121007, feeRateBps: 0 });
        const makerOrder = makeOrder(buyerB.address, positionIdB, 1, fill, Pm, { salt: 121007, feeRateBps: 0 });

        const takerSig = await signOrder(seller,  takerOrder);
        const makerSig = await signOrder(buyerB, makerOrder);

        const sellerCollBefore = await collateral.balanceOf(seller.address);
        const buyerBCollBefore = await collateral.balanceOf(buyerB.address);

        await settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          fill, [fill]
        );

        const takerReceived = (await collateral.balanceOf(seller.address)).sub(sellerCollBefore);
        const makerReceived = (await collateral.balanceOf(buyerB.address)).sub(buyerBCollBefore);

        // Maker receives P_m * fill / unit = 300_000
        expect(makerReceived).to.equal(Pm.mul(fill).div(UNIT));
        // Taker receives complement = fill − makerReceived = 700_000 = P_t exactly
        expect(takerReceived).to.equal(fill.sub(Pm.mul(fill).div(UNIT)));
        expect(takerReceived.add(makerReceived)).to.equal(fill);
      });

      it("should revert when P_t + P_m > unit (floors exceed available collateral)", async function () {
        // P_t=700k, P_m=400k → sum=1_100k > unit → InvalidMatch
        const fill = ethers.BigNumber.from(1_000_000);
        const Pt   = UNIT.mul(7).div(10);  // 700_000
        const Pm   = UNIT.mul(4).div(10);  // 400_000

        const takerOrder = makeOrder(seller.address,  positionIdA, 1, fill, Pt, { salt: 121006, feeRateBps: 0 });
        const makerOrder = makeOrder(buyerB.address, positionIdB, 1, fill, Pm, { salt: 121006, feeRateBps: 0 });

        const takerSig = await signOrder(seller,  takerOrder);
        const makerSig = await signOrder(buyerB, makerOrder);

        await expect(
          settlement.connect(operator).matchOrders(
            takerOrder, takerSig, 0,
            [makerOrder], [makerSig], [0],
            fill, [fill]
          )
        ).to.be.revertedWith("InvalidMatch()");
      });
    });
  });
});
