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
  const FEE_BPS = 200; // 2% — operator fee rate used to size per-leg fees off-chain
  const MAX_FEE_RATE_BPS = 500; // 5% — admin-set on-chain ceiling

  // EIP-712 helpers — SCRUM-224: 11-field struct, `feeRateBps` removed.
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
    // SCRUM-224: `feeRateBps` is no longer part of the signed order. A legacy
    // `feeRateBps` key in `overrides` is dropped (back-compat with older specs).
    const { feeRateBps, ...rest } = overrides;
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
      expiration: 0,
      nonce: 0,
      ...rest,
    };
  }

  async function signOrder(signer, order) {
    return signer._signTypedData(makeDomain(), ORDER_TYPE, order);
  }

  /**
   * SCRUM-224: the fee is operator-supplied. This is the off-chain sizing the
   * operator uses — `feeRateBps` of the contract-derived collateral leg
   * (`price * amount / unit`). It is always within the on-chain max-rate cap.
   */
  function legFee(price, amount, feeRateBps = FEE_BPS, unit = UNIT) {
    const cashValue = ethers.BigNumber.from(price).mul(amount).div(unit);
    return cashValue.mul(feeRateBps).div(10000);
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
    await adminConfig.setMaxFeeRate(MAX_FEE_RATE_BPS);

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
          order, sig, 0, [], [], [], 100, [], [], []
        )
      ).to.be.reverted;
    });

    it("should revert matchOrders when paused", async function () {
      await settlement.pauseTrading();

      const order = makeOrder(buyer.address, positionIdA, 0, 100, UNIT.div(2));
      const sig = await signOrder(buyer, order);

      await expect(
        settlement.connect(operator).matchOrders(
          order, sig, 0, [], [], [], 100, [], [], []
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
          100, [], [0], [0] // mismatch: 1 maker order, 0 fill amounts
        )
      ).to.be.revertedWith("MismatchedInputLengths()");
    });

    it("should revert on zero taker fill amount", async function () {
      const takerOrder = makeOrder(buyer.address, positionIdA, 0, 100, UNIT.div(2));
      const takerSig = await signOrder(buyer, takerOrder);

      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0, [], [], [], 0, [], [], []
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

    it("should settle a valid Buy vs Sell match with operator-supplied fees", async function () {
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

      // SCRUM-224: operator supplies the per-leg fee. Execution is at the maker's
      // price, so cashValue = price * fill / UNIT. The taker is the buyer.
      const buyerFee = legFee(price, fillAmount);
      const sellerFee = legFee(price, fillAmount);

      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fillAmount, [fillAmount], [buyerFee], [sellerFee]
      );

      // Each party pays their own fee. Execution at maker's price.
      const collateralAmount = price.mul(fillAmount).div(UNIT);
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
        fillAmount, [fillAmount], [0], [0]
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
          fillAmount, [fillAmount], [0], [0]
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
        halfAmount, [halfAmount], [0], [0]
      );

      const takerHash = await sigVerifier.getOrderHash(takerOrder);
      expect(await settlement.getFilledAmount(takerHash)).to.equal(halfAmount);

      // Second fill: remaining half
      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder1], [makerSig1], [0],
        halfAmount, [halfAmount], [0], [0]
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
        fillAmount, [fillAmount], [0], [0]
      );

      // Try to fill again — should revert
      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          1, [1], [0], [0]
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
          fillAmount, [fillAmount], [0], [0]
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
          fillAmount, [fillAmount], [0], [0]
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

      await settlement.connect(operator).fillOrder(order, sig, 0, fillAmount, 0);

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
        settlement.connect(operator).fillOrder(order, sig, 0, 0, 0)
      ).to.be.revertedWith("ZeroAmount()");
    });

    it("should revert fillOrder from non-operator", async function () {
      const order = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, { salt: 6002 });
      const sig = await signOrder(buyer, order);

      await expect(
        settlement.connect(buyer).fillOrder(order, sig, 0, fillAmount, 0)
      ).to.be.reverted;
    });
  });

  // ========================================
  // (SCRUM-224) The off-chain symmetric-fee-formula tests were removed: the
  // fee formula is no longer on-chain logic. The operator supplies the fee
  // amount and the contract only validates it — see the "Operator-supplied
  // fee model" describe block below.
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
          fillAmount, [fillAmount.div(2)], [0], [0]
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
        fillAmount, [fillAmount], [0], [0]
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

    it("should route operator-supplied fees to feeReceiver (SCRUM-224)", async function () {
      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, priceA, { salt: 8001 });
      const makerOrder = makeOrder(buyerB.address, positionIdB, 0, fillAmount, priceB, { salt: 8001 });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(buyerB, makerOrder);

      // Mint: taker pays effective price (unit - P_m), maker pays P_m. Size the
      // operator fee from each buyer's own collateral leg.
      const makerCollateral = priceB.mul(fillAmount).div(UNIT);
      const takerCollateral = fillAmount.sub(makerCollateral);
      const takerFee = takerCollateral.mul(FEE_BPS).div(10000);
      const makerFee = makerCollateral.mul(FEE_BPS).div(10000);

      const buyerCollBefore = await collateral.balanceOf(buyer.address);
      const buyerBCollBefore = await collateral.balanceOf(buyerB.address);
      const feeReceiverBefore = await collateral.balanceOf(feeReceiver.address);

      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fillAmount, [fillAmount], [takerFee], [makerFee]
      );

      // Each buyer paid their collateral leg + their fee.
      expect(buyerCollBefore.sub(await collateral.balanceOf(buyer.address)))
        .to.equal(takerCollateral.add(takerFee));
      expect(buyerBCollBefore.sub(await collateral.balanceOf(buyerB.address)))
        .to.equal(makerCollateral.add(makerFee));
      // feeReceiver got both fees.
      expect((await collateral.balanceOf(feeReceiver.address)).sub(feeReceiverBefore))
        .to.equal(takerFee.add(makerFee));
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
        fillAmount, [fillAmount], [0], [0]
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

    it("should route operator-supplied fees to feeReceiver and deduct them from payouts (SCRUM-224)", async function () {
      const takerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, priceA, { salt: 9001 });
      const makerOrder = makeOrder(buyerB.address, positionIdB, 1, fillAmount, priceB, { salt: 9001 });

      const takerSig = await signOrder(seller, takerOrder);
      const makerSig = await signOrder(buyerB, makerOrder);

      // Merge: maker receives P_m, taker receives the complement (unit - P_m).
      // The operator fee is deducted from each seller's payout.
      const makerPayout = priceB.mul(fillAmount).div(UNIT);
      const takerPayout = fillAmount.sub(makerPayout);
      const takerFee = takerPayout.mul(FEE_BPS).div(10000);
      const makerFee = makerPayout.mul(FEE_BPS).div(10000);

      const sellerCollBefore = await collateral.balanceOf(seller.address);
      const buyerBCollBefore = await collateral.balanceOf(buyerB.address);
      const feeReceiverBefore = await collateral.balanceOf(feeReceiver.address);

      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fillAmount, [fillAmount], [takerFee], [makerFee]
      );

      // Each seller received payout - fee.
      expect((await collateral.balanceOf(seller.address)).sub(sellerCollBefore))
        .to.equal(takerPayout.sub(takerFee));
      expect((await collateral.balanceOf(buyerB.address)).sub(buyerBCollBefore))
        .to.equal(makerPayout.sub(makerFee));
      // feeReceiver got both fees.
      expect((await collateral.balanceOf(feeReceiver.address)).sub(feeReceiverBefore))
        .to.equal(takerFee.add(makerFee));
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
        totalFill, [halfFill, halfFill], [0, 0], [0, 0]
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
        fillAmount, [fillAmount], [0], [0]
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
        fillAmount, [fillAmount], [0], [0]
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
        fillAmount, [fillAmount], [0], [0]
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
        firstFill, [firstFill], [0], [0]
      );

      // Fill exact remaining (50 < minFill 100, but it's the last fill)
      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        remaining, [remaining], [0], [0]
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
        fillAmount, [fillAmount], [0], [0]
      );

      const takerHash = await sigVerifier.getOrderHash(takerOrder);
      expect(await settlement.getFilledAmount(takerHash)).to.equal(fillAmount);
    });
  });

  // ========================================
  // OPERATOR-SUPPLIED FEE MODEL TESTS (SCRUM-224)
  // ========================================

  // SCRUM-224 — the maker no longer signs `feeRateBps`. The operator supplies
  // the per-leg fee amount; the contract enforces `fee <= cashValue *
  // maxFeeRateBps / 10000` (FeeExceedsMaxRate) and, where a fee is taken out of
  // a payout, `fee <= proceeds` (FeeExceedsProceeds). `maxFeeRateBps` is
  // configured to MAX_FEE_RATE_BPS (500) in the fixture's `before`.
  describe("Operator-supplied fee model (SCRUM-224)", function () {
    const fillAmount = ethers.utils.parseUnits("100", 6);
    const price = UNIT.div(2); // 0.5 — complementary executes at maker's price
    // cashValue for a complementary leg at this price/fill = price * fill / unit
    const cashValue = price.mul(fillAmount).div(UNIT);
    // Fee exactly at the 500-bps cap.
    const feeAtCap = cashValue.mul(MAX_FEE_RATE_BPS).div(10000);

    it("should settle when the operator fee is exactly at the max-rate cap", async function () {
      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, { salt: 21000 });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, { salt: 21000 });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      const feeReceiverBefore = await collateral.balanceOf(feeReceiver.address);

      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fillAmount, [fillAmount], [feeAtCap], [feeAtCap]
      );

      const takerHash = await sigVerifier.getOrderHash(takerOrder);
      expect(await settlement.getFilledAmount(takerHash)).to.equal(fillAmount);
      // Both legs' fees routed to feeReceiver.
      const feeReceiverAfter = await collateral.balanceOf(feeReceiver.address);
      expect(feeReceiverAfter.sub(feeReceiverBefore)).to.equal(feeAtCap.mul(2));
    });

    it("should revert when the taker fee is one wei over the max-rate cap", async function () {
      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, { salt: 21001 });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, { salt: 21001 });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          fillAmount, [fillAmount], [feeAtCap.add(1)], [0]
        )
      ).to.be.revertedWith("FeeExceedsMaxRate()");
    });

    it("should revert when the maker fee is one wei over the max-rate cap", async function () {
      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, { salt: 21002 });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, { salt: 21002 });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          fillAmount, [fillAmount], [0], [feeAtCap.add(1)]
        )
      ).to.be.revertedWith("FeeExceedsMaxRate()");
    });

    it("should settle with a zero fee on every leg", async function () {
      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, { salt: 21003 });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, { salt: 21003 });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      const feeReceiverBefore = await collateral.balanceOf(feeReceiver.address);

      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fillAmount, [fillAmount], [0], [0]
      );

      const takerHash = await sigVerifier.getOrderHash(takerOrder);
      expect(await settlement.getFilledAmount(takerHash)).to.equal(fillAmount);
      expect(await collateral.balanceOf(feeReceiver.address)).to.equal(feeReceiverBefore);
    });

    it("should revert merge when the operator fee exceeds a seller's proceeds", async function () {
      // Merge at P_t = P_m = 0.5: each seller's payout = 0.5 * fill. Set the
      // taker fee above that payout — caught by FeeExceedsProceeds. The fee is
      // also above the max-rate cap, but the proceeds guard is the relevant one.
      const sellPrice = UNIT.div(2);
      const takerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, sellPrice, { salt: 21004 });
      const makerOrder = makeOrder(buyerB.address, positionIdB, 1, fillAmount, sellPrice, { salt: 21004 });

      const takerSig = await signOrder(seller, takerOrder);
      const makerSig = await signOrder(buyerB, makerOrder);

      const takerPayout = sellPrice.mul(fillAmount).div(UNIT);

      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          fillAmount, [fillAmount], [takerPayout.add(1)], [0]
        )
      ).to.be.reverted; // FeeExceedsMaxRate or FeeExceedsProceeds
    });

    it("should revert fillOrder when the operator fee exceeds the collateral leg", async function () {
      // fillOrder collateral leg = price * fill / unit. A fee above that leg is
      // caught by the FeeExceedsProceeds / FeeExceedsMaxRate guards.
      const order = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, { salt: 21005 });
      const sig = await signOrder(buyer, order);
      const collLeg = price.mul(fillAmount).div(UNIT);

      await expect(
        settlement.connect(operator).fillOrder(order, sig, 0, fillAmount, collLeg.add(1))
      ).to.be.reverted; // FeeExceedsMaxRate (fee above cap) or FeeExceedsProceeds
    });

    it("should settle fillOrder with an operator fee at the cap and route it to feeReceiver", async function () {
      const order = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, { salt: 21006 });
      const sig = await signOrder(buyer, order);
      const collLeg = price.mul(fillAmount).div(UNIT);
      const fee = collLeg.mul(MAX_FEE_RATE_BPS).div(10000);

      const feeReceiverBefore = await collateral.balanceOf(feeReceiver.address);
      await settlement.connect(operator).fillOrder(order, sig, 0, fillAmount, fee);
      const feeReceiverAfter = await collateral.balanceOf(feeReceiver.address);
      expect(feeReceiverAfter.sub(feeReceiverBefore)).to.equal(fee);
    });

    it("should revert with FeeExceedsMaxRate when maxFeeRateBps is unset (fail-closed)", async function () {
      // Stand up a fresh Diamond where setMaxFeeRate is never called — maxFeeRateBps
      // defaults to 0. Fail-closed: any non-zero fee must revert FeeExceedsMaxRate.
      const freshDiamond = await deployDiamond();
      const freshSettlement = await ethers.getContractAt("SettlementFacet", freshDiamond);
      const freshAdmin = await ethers.getContractAt("AdminConfigFacet", freshDiamond);
      const freshAccess = await ethers.getContractAt("AccessControlFacet", freshDiamond);
      const freshCondMgr = await ethers.getContractAt("ConditionManagerFacet", freshDiamond);
      const freshCtf = await ethers.getContractAt("ConditionalTokensFacet", freshDiamond);
      const freshErc1155 = await ethers.getContractAt("ERC1155Facet", freshDiamond);
      const freshSigVerifier = await ethers.getContractAt("SignatureVerifierFacet", freshDiamond);

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const freshColl = await MockERC20.deploy("Mock USDC", "USDC", 6);
      await freshColl.deployed();

      await freshAdmin.addCollateralToken(freshColl.address, UNIT);
      await freshAdmin.setFeeReceiver(feeReceiver.address);
      // NB: setMaxFeeRate intentionally NOT called — maxFeeRateBps stays 0.
      await freshSettlement.setOperator(operator.address);
      await freshAccess.addMarketMaker(owner.address);

      const qId = ethers.utils.formatBytes32String("scrum-224-failclosed");
      const condId = getConditionId(owner.address, qId, 2);
      await freshCondMgr.createCondition(owner.address, qId, 2, "ipfs://failclosed");
      const collA = await getCollectionId(ethers.constants.HashZero, condId, 1, ethers.provider);
      const posA = getPositionId(freshColl.address, collA);

      const mintAmount = ethers.utils.parseUnits("100000", 6);
      for (const a of [owner, buyer, seller]) {
        await freshColl.mint(a.address, mintAmount);
        await freshColl.connect(a).approve(freshDiamond, ethers.constants.MaxUint256);
        await freshErc1155.connect(a).setApprovalForAll(freshDiamond, true);
      }

      const splitAmt = ethers.utils.parseUnits("10000", 6);
      await freshCtf.connect(owner).splitPosition(
        freshColl.address, ethers.constants.HashZero, condId, [1, 2], splitAmt
      );
      await freshErc1155.connect(owner).safeTransferFrom(owner.address, seller.address, posA, splitAmt, "0x");

      const freshDomain = {
        name: DOMAIN_NAME,
        version: DOMAIN_VERSION,
        chainId: 31337,
        verifyingContract: freshDiamond,
      };
      const posAHex = ethers.utils.hexZeroPad(ethers.BigNumber.from(posA).toHexString(), 32);
      const freshTaker = {
        salt: 50000, maker: buyer.address, signer: buyer.address, positionId: posAHex,
        collateralToken: freshColl.address, side: 0, amount: fillAmount,
        pricePerToken: price, minFillAmount: 0, expiration: 0, nonce: 0,
      };
      const freshMaker = {
        salt: 50000, maker: seller.address, signer: seller.address, positionId: posAHex,
        collateralToken: freshColl.address, side: 1, amount: fillAmount,
        pricePerToken: price, minFillAmount: 0, expiration: 0, nonce: 0,
      };
      const freshTakerSig = await buyer._signTypedData(freshDomain, ORDER_TYPE, freshTaker);
      const freshMakerSig = await seller._signTypedData(freshDomain, ORDER_TYPE, freshMaker);

      // Any non-zero fee must revert — maxFeeRateBps == 0 => maxAllowed == 0.
      await expect(
        freshSettlement.connect(operator).matchOrders(
          freshTaker, freshTakerSig, 0,
          [freshMaker], [freshMakerSig], [0],
          fillAmount, [fillAmount], [1], [0]
        )
      ).to.be.revertedWith("FeeExceedsMaxRate()");

      // A zero fee still settles even with maxFeeRateBps unset.
      await freshSettlement.connect(operator).matchOrders(
        freshTaker, freshTakerSig, 0,
        [freshMaker], [freshMakerSig], [0],
        fillAmount, [fillAmount], [0], [0]
      );
      const freshTakerHash = await freshSigVerifier.getOrderHash(freshTaker);
      expect(await freshSettlement.getFilledAmount(freshTakerHash)).to.equal(fillAmount);
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
          fillAmount, [fillAmount], [0], [0]
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
          fillAmount, [fillAmount], [0], [0]
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
        fillAmount, [fillAmount], [0], [0]
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
        smallFill, [smallFill], [0], [0]
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
          fillAmount, [fillAmount], [0], [0]
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
          fillAmount, [fillAmount], [0], [0]
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
        fillAmount, [fillAmount], [0], [0]
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
        smallFill, [smallFill], [0], [0]
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
        firstFill, [firstFill], [0], [0]
      );

      // Fill exactly the remaining
      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        remaining, [remaining], [0], [0]
      );

      const takerHash = await sigVerifier.getOrderHash(takerOrder);
      expect(await settlement.getFilledAmount(takerHash)).to.equal(totalAmount);

      // One more should revert (overfill)
      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          1, [1], [0], [0]
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
          fillAmount, [fillAmount], [0], [0]
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
        fillAmount, [fillAmount], [0], [0]
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
          fillAmount, [fillAmount], [0], [0]
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
        fillAmount, [fillAmount], [0], [0]
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
        fillAmount, [fillAmount], [0], [0]
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
          fillAmount, [fillAmount], [0], [0]
        )
      ).to.be.revertedWith("InvalidMatch()");
    });
  });

  // ========================================
  // PRICE > UNIT REJECTION (MEDIUM-4 / BIZ-004)
  // ========================================

  describe("price > unit rejection in _validateOrder (BIZ-004)", function () {
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
          fillAmount, [fillAmount], [0], [0]
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
        fillAmount, [fillAmount], [0], [0]
      );

      const takerHash = await sigVerifier.getOrderHash(takerOrder);
      expect(await settlement.getFilledAmount(takerHash)).to.equal(fillAmount);
    });
  });

  // ========================================
  // DOMAIN SEPARATOR PARITY (SEC-004)
  // ========================================
  //
  // SEC-004 (mainnet audit) — the cached `domainSeparator` field and the
  // `cacheDomainSeparator()` selector were removed. All three v2.1 facets now
  // recompute the separator on every call. This block keeps a regression test
  // for the parity property (Settlement <-> SignatureVerifier <-> NonceManager).

  describe("domain separator parity (SEC-004)", function () {
    it("should produce the same domain separator across all three facets", async function () {
      const fromSigVerifier = await sigVerifier.getDomainSeparator();
      // Re-derived locally with the same name/version/chainId/diamond
      const expected = ethers.utils._TypedDataEncoder.hashDomain({
        name: "Doefin Exchange",
        version: "3",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: diamondAddress,
      });
      expect(fromSigVerifier).to.equal(expected);
    });

    it("should still settle orders correctly with no separator cache", async function () {
      const fillAmount = ethers.utils.parseUnits("100", 6);
      const price = UNIT.div(2);

      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, { salt: 33000 });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, { salt: 33000 });

      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fillAmount, [fillAmount], [0], [0]
      );

      const takerHash = await sigVerifier.getOrderHash(takerOrder);
      expect(await settlement.getFilledAmount(takerHash)).to.equal(fillAmount);
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
        fillAmount, [fillAmount], [0], [0]
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
        fillAmount, [fillAmount], [0], [0]
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
        fillAmount, [fillAmount], [0], [0]
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
        fillAmount, [fillAmount], [0], [0]
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
          fillAmount, [fillAmount], [0], [0]
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
          fillAmount, [fillAmount], [0], [0]
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
          fillAmount, [fillAmount], [0], [0]
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
          fill, [fill], [0], [0]
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
          fill, [fill], [0], [0]
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
            fill, [fill], [0], [0]
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
          totalFill, [fillA, fillB], [0, 0], [0, 0]
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
          fill, [fill], [0], [0]
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
          fill, [fill], [0], [0]
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
            fill, [fill], [0], [0]
          )
        ).to.be.revertedWith("InvalidMatch()");
      });
    });
  });

  // ========================================
  // MAINNET AUDIT — SETTLEMENT-INPUT HARDENING
  // ========================================
  //
  // Regression suite for the Phase 5 mainnet-audit fixes. Each test below
  // fails against the pre-fix SettlementFacet and passes after:
  //   SEC-001  — _settleComplementary collateral-token equality guard
  //   SEC-002  — _validateOrder collateral allow-list + non-zero unit gate
  //   SEC-003  — _executeOperatorFill zero/underflow guards
  //   BIZ-004  — _validateOrder pricePerToken <= unit cap
  //   BIZ-006  — _validateOrder side ∈ {0,1} constraint
  describe("Mainnet audit — settlement-input hardening", function () {
    // SEC-001: a second allow-listed collateral token. Both orders in the
    // SEC-001 pair must pass _validateOrder (which since SEC-002 requires an
    // allow-listed, non-zero-unit token), so the differing-token revert is
    // isolated to the new _settleComplementary guard rather than the gate.
    let altCollateral;

    before(async function () {
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      altCollateral = await MockERC20.deploy("Mock USDT", "USDT", 6);
      await altCollateral.deployed();
      await adminConfig.addCollateralToken(altCollateral.address, UNIT);

      // Fund + approve so the SEC-001 pair would settle if the guard were absent.
      const mintAmount = ethers.utils.parseUnits("100000", 6);
      await altCollateral.mint(buyer.address, mintAmount);
      await altCollateral.mint(seller.address, mintAmount);
      await altCollateral.connect(buyer).approve(diamondAddress, ethers.constants.MaxUint256);
      await altCollateral.connect(seller).approve(diamondAddress, ethers.constants.MaxUint256);
    });

    // --- SEC-001 -----------------------------------------------------------
    describe("SEC-001: _settleComplementary collateral-token mismatch", function () {
      const fillAmount = ethers.utils.parseUnits("100", 6);
      const price = UNIT.div(2);

      it("should revert a complementary match when taker and maker collateral tokens differ", async function () {
        // Taker BUY in altCollateral, maker SELL in collateral — both tokens are
        // allow-listed with a non-zero unit, so _validateOrder passes for each.
        // The mismatch must be caught by _settleComplementary itself.
        const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, {
          salt: 40000,
          collateralToken: altCollateral.address,
        });
        const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, {
          salt: 40000,
          collateralToken: collateral.address,
        });

        const takerSig = await signOrder(buyer, takerOrder);
        const makerSig = await signOrder(seller, makerOrder);

        await expect(
          settlement.connect(operator).matchOrders(
            takerOrder, takerSig, 0,
            [makerOrder], [makerSig], [0],
            fillAmount, [fillAmount], [0], [0]
          )
        ).to.be.revertedWith("InvalidMatch()");
      });

      it("should still settle a complementary match when both collateral tokens match", async function () {
        // Control: identical tokens (the alt token) settle normally — proves the
        // guard rejects only genuine mismatches.
        const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, {
          salt: 40001,
          collateralToken: altCollateral.address,
        });
        const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, {
          salt: 40001,
          collateralToken: altCollateral.address,
        });

        const takerSig = await signOrder(buyer, takerOrder);
        const makerSig = await signOrder(seller, makerOrder);

        await settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          fillAmount, [fillAmount], [0], [0]
        );

        const takerHash = await sigVerifier.getOrderHash(takerOrder);
        expect(await settlement.getFilledAmount(takerHash)).to.equal(fillAmount);
      });
    });

    // --- SEC-002 -----------------------------------------------------------
    describe("SEC-002: collateral allow-list gate in _validateOrder", function () {
      const fillAmount = ethers.utils.parseUnits("100", 6);
      const price = UNIT.div(2);

      it("should revert settlement against a never-allow-listed collateral token", async function () {
        // Deploy a token that is never passed to addCollateralToken — isAllowed
        // is false and unitPerPair is 0.
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        const rogue = await MockERC20.deploy("Rogue", "RGE", 6);
        await rogue.deployed();
        await rogue.mint(buyer.address, fillAmount.mul(10));
        await rogue.mint(seller.address, fillAmount.mul(10));
        await rogue.connect(buyer).approve(diamondAddress, ethers.constants.MaxUint256);
        await rogue.connect(seller).approve(diamondAddress, ethers.constants.MaxUint256);

        const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, {
          salt: 41000,
          collateralToken: rogue.address,
        });
        const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, {
          salt: 41000,
          collateralToken: rogue.address,
        });

        const takerSig = await signOrder(buyer, takerOrder);
        const makerSig = await signOrder(seller, makerOrder);

        await expect(
          settlement.connect(operator).matchOrders(
            takerOrder, takerSig, 0,
            [makerOrder], [makerSig], [0],
            fillAmount, [fillAmount], [0], [0]
          )
        ).to.be.revertedWith("TokenNotAllowed()");
      });

      it("should revert settlement against a token after it is removed from the allow-list", async function () {
        // removeCollateralToken sets isAllowed=false AND deletes unitPerPair, so a
        // removed token can never again clear the _validateOrder gate.
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        const removable = await MockERC20.deploy("Removable", "RMV", 6);
        await removable.deployed();
        await removable.mint(buyer.address, fillAmount.mul(10));
        await removable.mint(seller.address, fillAmount.mul(10));
        await removable.connect(buyer).approve(diamondAddress, ethers.constants.MaxUint256);
        await removable.connect(seller).approve(diamondAddress, ethers.constants.MaxUint256);

        await adminConfig.addCollateralToken(removable.address, UNIT);
        await adminConfig.removeCollateralToken(removable.address);

        const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, {
          salt: 41001,
          collateralToken: removable.address,
        });
        const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, {
          salt: 41001,
          collateralToken: removable.address,
        });

        const takerSig = await signOrder(buyer, takerOrder);
        const makerSig = await signOrder(seller, makerOrder);

        await expect(
          settlement.connect(operator).matchOrders(
            takerOrder, takerSig, 0,
            [makerOrder], [makerSig], [0],
            fillAmount, [fillAmount], [0], [0]
          )
        ).to.be.revertedWith("TokenNotAllowed()");
      });

      it("should revert fillOrder against a non-allow-listed collateral token", async function () {
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        const rogue = await MockERC20.deploy("Rogue2", "RG2", 6);
        await rogue.deployed();
        await rogue.mint(buyer.address, fillAmount.mul(10));
        await rogue.connect(buyer).approve(diamondAddress, ethers.constants.MaxUint256);

        const order = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, {
          salt: 41002,
          collateralToken: rogue.address,
        });
        const sig = await signOrder(buyer, order);

        await expect(
          settlement.connect(operator).fillOrder(order, sig, 0, fillAmount, 0)
        ).to.be.revertedWith("TokenNotAllowed()");
      });
    });

    // --- SEC-003 -----------------------------------------------------------
    describe("SEC-003: _executeOperatorFill zero/underflow guards", function () {
      const price = UNIT.div(2); // 500000

      it("should revert a fillOrder whose collateral leg rounds down to zero", async function () {
        // collateralAmount = price * fill / unit = 500000 * 1 / 1000000 = 0 (floored).
        // Pre-fix: maker receives the position token for no payment.
        const order = makeOrder(buyer.address, positionIdA, 0, 1, price, {
          salt: 42000,
          feeRateBps: 0,
        });
        const sig = await signOrder(buyer, order);

        await expect(
          settlement.connect(operator).fillOrder(order, sig, 0, 1, 0)
        ).to.be.revertedWith("ZeroAmount()");
      });

      it("should revert a sub-unit sell fillOrder that rounds the collateral leg to zero", async function () {
        // Same truncation on the sell side: operator would receive position
        // tokens while paying nothing.
        const order = makeOrder(seller.address, positionIdA, 1, 1, price, {
          salt: 42001,
          feeRateBps: 0,
        });
        const sig = await signOrder(seller, order);

        await expect(
          settlement.connect(operator).fillOrder(order, sig, 0, 1, 0)
        ).to.be.revertedWith("ZeroAmount()");
      });

      it("should still fill an order whose collateral leg is non-zero", async function () {
        // Control: a fill large enough that price*fill/unit > 0 settles normally.
        const fillAmount = ethers.utils.parseUnits("10", 6);
        const order = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, {
          salt: 42002,
          feeRateBps: 0,
        });
        const sig = await signOrder(buyer, order);

        const buyerPosBefore = await erc1155Facet.balanceOf(buyer.address, positionIdA);
        await settlement.connect(operator).fillOrder(order, sig, 0, fillAmount, 0);
        const buyerPosAfter = await erc1155Facet.balanceOf(buyer.address, positionIdA);
        expect(buyerPosAfter.sub(buyerPosBefore)).to.equal(fillAmount);
      });
    });

    // --- BIZ-004 -----------------------------------------------------------
    describe("BIZ-004: pricePerToken <= unit cap in _validateOrder", function () {
      const fillAmount = ethers.utils.parseUnits("100", 6);

      it("should revert an order whose pricePerToken exceeds unit", async function () {
        // SCRUM-224 — with zero operator fees, the revert must come purely from
        // the _validateOrder BIZ-004 cap (no fee math runs on this path).
        const badPrice = UNIT.add(1); // 1000001 > unit

        const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, badPrice, {
          salt: 43000,
          feeRateBps: 0,
        });
        const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, badPrice, {
          salt: 43000,
          feeRateBps: 0,
        });

        const takerSig = await signOrder(buyer, takerOrder);
        const makerSig = await signOrder(seller, makerOrder);

        await expect(
          settlement.connect(operator).matchOrders(
            takerOrder, takerSig, 0,
            [makerOrder], [makerSig], [0],
            fillAmount, [fillAmount], [0], [0]
          )
        ).to.be.revertedWith("InvalidPrice()");
      });

      it("should accept an order whose pricePerToken equals unit exactly", async function () {
        const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, UNIT, {
          salt: 43001,
          feeRateBps: 0,
        });
        const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, UNIT, {
          salt: 43001,
          feeRateBps: 0,
        });

        const takerSig = await signOrder(buyer, takerOrder);
        const makerSig = await signOrder(seller, makerOrder);

        await settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          fillAmount, [fillAmount], [0], [0]
        );

        const takerHash = await sigVerifier.getOrderHash(takerOrder);
        expect(await settlement.getFilledAmount(takerHash)).to.equal(fillAmount);
      });
    });

    // --- BIZ-006 -----------------------------------------------------------
    describe("BIZ-006: side constrained to {0,1} in _validateOrder", function () {
      const fillAmount = ethers.utils.parseUnits("100", 6);
      const price = UNIT.div(2);

      it("should revert a matchOrders pair whose taker order has side = 2", async function () {
        // Pre-fix: side=2 != maker.side=1 reaches the complementary path.
        const takerOrder = makeOrder(buyer.address, positionIdA, 2, fillAmount, price, { salt: 44000 });
        const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, { salt: 44000 });

        const takerSig = await signOrder(buyer, takerOrder);
        const makerSig = await signOrder(seller, makerOrder);

        await expect(
          settlement.connect(operator).matchOrders(
            takerOrder, takerSig, 0,
            [makerOrder], [makerSig], [0],
            fillAmount, [fillAmount], [0], [0]
          )
        ).to.be.revertedWith("InvalidMatch()");
      });

      it("should revert when a maker order has side = 2", async function () {
        const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, { salt: 44001 });
        const makerOrder = makeOrder(seller.address, positionIdA, 2, fillAmount, price, { salt: 44001 });

        const takerSig = await signOrder(buyer, takerOrder);
        const makerSig = await signOrder(seller, makerOrder);

        await expect(
          settlement.connect(operator).matchOrders(
            takerOrder, takerSig, 0,
            [makerOrder], [makerSig], [0],
            fillAmount, [fillAmount], [0], [0]
          )
        ).to.be.revertedWith("InvalidMatch()");
      });

      it("should revert a fillOrder whose order has side = 255", async function () {
        const order = makeOrder(buyer.address, positionIdA, 255, fillAmount, price, { salt: 44002 });
        const sig = await signOrder(buyer, order);

        await expect(
          settlement.connect(operator).fillOrder(order, sig, 0, fillAmount, 0)
        ).to.be.revertedWith("InvalidMatch()");
      });
    });
  });
});
