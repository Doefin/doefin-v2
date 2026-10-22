// PENTEST BATCH · LOW + INFO findings
// ============================================================================
// Consolidated coverage for the LOW / INFO / GAS items of
// `audit/findings-ledger.md` that have observable on-chain behaviour. Each
// describe-block names its ledger ID; per-finding detail (location,
// recommendation) lives in the ledger.
//
// Already covered elsewhere (under test/unit and the FIXED pentests):
//   BIZ-004 (FIXED, SEC-002 file)   BIZ-006 (FIXED, SEC-002 file)
//
// Runnable in this file:
//   SEC-011, SEC-014                 — fixes verified
//   SEC-008, CPX-005, SEC-012, SEC-013 — removed v2.0 surface stays removed
//   SEC-009, SEC-010                 — accept-risk behaviour pinned
//   BIZ-002                          — merge crossing check precedes any token movement
//   BIZ-005                          — operator-fee ceiling at asymmetric prices + multi-maker
//   BIZ-008, GAS-001                 — the signed struct is the 10-field form
//   CPX-003                          — isOrderValid and settlement agree; one order hash
//
// Not represented here — no observable behaviour to assert (refactor / gas /
// cosmetic); status is tracked in the ledger only:
//   CPX-006, CPX-007 (refactors — done: `_settleAgainstMaker`, `_conditionAndPartition`)
//   GAS-002, GAS-004, GAS-005, GAS-006, GAS-007 (done)   GAS-003 (down-scoped, open)
//   CPX-A2, CPX-A4567 (residual types / cosmetic nits, open)

const { expect } = require("chai");
const { ethers, artifacts } = require("hardhat");
const { setupAuditFixture, ORDER_TYPE } = require("../utils/auditFixture.js");

describe("PENTEST BATCH · LOW + INFO", function () {
  let ctx;
  const ONE = ethers.utils.parseUnits("1", 6);

  before(async function () {
    ctx = await setupAuditFixture();
  });

  // Hash an order exactly as an off-chain signer does (EIP-712, 10-field struct).
  function typedDataHash(order) {
    return ethers.utils._TypedDataEncoder.hash(ctx.helpers.makeDomain(), ORDER_TYPE, order);
  }

  // ==========================================================================
  // FIXES VERIFIED
  // ==========================================================================

  describe("SEC-011 (LOW, FIXED) — setOperator zero-address guard + OperatorUpdated event", function () {
    it("FIX VERIFIED — setOperator(address(0)) reverts ZeroAddress()", async function () {
      const { settlementAdmin } = ctx.contracts;
      const { owner } = ctx.signers;

      // Pre-fix: silently accepted, bricking settlement with no on-chain trace.
      // Post-fix: a clean, named revert.
      await expect(
        settlementAdmin.connect(owner).setOperator(ethers.constants.AddressZero),
      ).to.be.revertedWith("ZeroAddress()");
    });

    it("FIX VERIFIED — setOperator(non-zero) emits OperatorUpdated(old, new)", async function () {
      const { settlementAdmin } = ctx.contracts;
      const { owner, operator, attacker } = ctx.signers;

      const oldOperator = await settlementAdmin.getOperator();

      // Change to a new operator and watch for the event.
      await expect(settlementAdmin.connect(owner).setOperator(attacker.address))
        .to.emit(settlementAdmin, "OperatorUpdated")
        .withArgs(oldOperator, attacker.address);

      expect(await settlementAdmin.getOperator()).to.equal(attacker.address);

      // Restore the fixture operator so subsequent tests aren't impacted.
      await settlementAdmin.connect(owner).setOperator(operator.address);
    });
  });

  describe("SEC-014 (INFO, FIXED) — ERC1155Facet.setApprovalForAll emits ApprovalForAll exactly once", function () {
    it("FIX VERIFIED — calling setApprovalForAll emits the event exactly once per call", async function () {
      const { erc1155Facet } = ctx.contracts;
      const { attacker } = ctx.signers;

      const tx = await erc1155Facet.connect(attacker).setApprovalForAll(ctx.diamondAddress, true);
      const receipt = await tx.wait();

      const approvalEvents = receipt.events.filter((e) => e.event === "ApprovalForAll");
      // Pre-fix: the facet emitted AND `LibERC1155.setApprovalForAll` emitted
      // — two identical logs per call confused indexers. The facet emit was
      // removed; only the library emission remains.
      expect(approvalEvents.length).to.equal(1);
    });
  });

  // ==========================================================================
  // REMOVED v2.0 SURFACE — must stay removed
  // ==========================================================================

  describe("SEC-008 / CPX-005 / SEC-013 / SEC-012 (RESOLVED) — dead v2.0 surface is gone", function () {
    const REMOVED_SELECTORS = [
      // SEC-008 (SCRUM-223): OracleManagerFacet permissionless keeper.
      "updatePrice(bytes32)",
      // CPX-005 (SCRUM-223): cross-currency conversion-path machinery on AdminConfigFacet.
      "setConversionPath(address,address,bytes32[])",
      "removeConversionPath(address,address)",
      "getConfiguredConversionPath(address,address)",
      "getCrossCurrencyConversionPath(address,address)",
      // SEC-013 (SCRUM-224): non-functional maker/taker trading-fee config.
      "setTradingFeesBps(uint16,uint16)",
    ];

    for (const signature of REMOVED_SELECTORS) {
      it(`RESOLVED — ${signature} is not routed by the Diamond`, async function () {
        const loupe = await ethers.getContractAt("DiamondLoupeFacet", ctx.diamondAddress);
        const selector = ethers.utils.id(signature).slice(0, 10);
        expect(await loupe.facetAddress(selector)).to.equal(ethers.constants.AddressZero);
      });
    }

    it("RESOLVED — no compiled contract declares OracleManagerFacet or the orphaned ProtocolFeesWithdrawn event", async function () {
      const names = await artifacts.getAllFullyQualifiedNames();
      // SEC-008: the facet itself no longer exists.
      expect(names.filter((n) => n.endsWith(":OracleManagerFacet"))).to.deep.equal([]);

      // SEC-012: `ProtocolFeesWithdrawn` had zero emit sites; the declaration is deleted.
      const declaring = [];
      for (const name of names) {
        const { abi } = await artifacts.readArtifact(name);
        if (abi.some((e) => e.type === "event" && e.name === "ProtocolFeesWithdrawn")) declaring.push(name);
      }
      expect(declaring).to.deep.equal([]);
    });
  });

  // ==========================================================================
  // ACCEPT-RISK — behaviour pinned so a change is a deliberate decision
  // ==========================================================================

  describe("SEC-009 (LOW, accept-risk) — cancellation keys off msg.sender, not the registered signer", function () {
    it("PINNED — a registered signer cannot cancel the SCW maker's order; the maker can", async function () {
      const { sigVerifier, nonceMgr } = ctx.contracts;
      const { buyer, attacker } = ctx.signers;
      const { positionIdA } = ctx.market;
      const { makeOrder } = ctx.helpers;

      // `buyer` plays the SCW maker and registers `attacker` as its order signer.
      await sigVerifier.connect(buyer).registerOrderSigner(attacker.address, true);
      const order = makeOrder(buyer.address, positionIdA, 0, ONE.mul(10), ONE.div(2), {
        signer: attacker.address,
        salt: 91001,
      });

      await expect(nonceMgr.connect(attacker).cancelOrder(order)).to.be.revertedWith("NotOrderMaker()");

      await nonceMgr.connect(buyer).cancelOrder(order);
      expect(await nonceMgr.isCancelled(typedDataHash(order))).to.equal(true);

      await sigVerifier.connect(buyer).registerOrderSigner(attacker.address, false);
    });
  });

  describe("SEC-010 (LOW, accept-risk) — the uint256 filled accumulator is capped at the uint128 order amount", function () {
    it("PINNED — once an order is fully filled, any further fill reverts OrderOverfilled(hash, requested, 0)", async function () {
      const { settlement, sigVerifier } = ctx.contracts;
      const { buyer, seller, operator } = ctx.signers;
      const { positionIdA } = ctx.market;
      const { makeOrder, signOrder } = ctx.helpers;

      const price = ONE.div(2);
      const makerAmount = ONE.mul(10);
      const takerOrder = makeOrder(buyer.address, positionIdA, 0, ONE.mul(20), price, { salt: 92001 });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, makerAmount, price, { salt: 92002 });
      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0, [makerOrder], [makerSig], [0], makerAmount, [makerAmount], [0], [0],
      );

      const makerHash = await sigVerifier.getOrderHash(makerOrder);
      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0, [makerOrder], [makerSig], [0], ONE, [ONE], [0], [0],
        ),
      ).to.be.revertedWith(`OrderOverfilled("${makerHash}", ${ONE.toString()}, 0)`);
    });
  });

  // ==========================================================================
  // BUSINESS LOGIC
  // ==========================================================================

  describe("BIZ-002 (LOW, FIXED) — _settleMerge checks the price crossing before moving any token", function () {
    it("FIX VERIFIED — an over-unit merge reverts InvalidMatch even when a seller holds none of the position", async function () {
      const { settlement, erc1155Facet } = ctx.contracts;
      const { buyer, seller, operator } = ctx.signers;
      const { positionIdA, positionIdB } = ctx.market;
      const { makeOrder, signOrder } = ctx.helpers;

      // Precondition: `buyer` owns no positionB, so the first token pull would fail.
      expect(await erc1155Facet.balanceOf(buyer.address, positionIdB)).to.equal(0);

      // P_t + P_m = 1.2·unit > unit. Pre-fix the CTF transfer/burn ran first and the
      // call reverted on the missing balance; post-fix the crossing check fires first.
      const fill = ONE.mul(10);
      const takerOrder = makeOrder(seller.address, positionIdA, 1, fill, ONE.mul(6).div(10), { salt: 93001 });
      const makerOrder = makeOrder(buyer.address, positionIdB, 1, fill, ONE.mul(6).div(10), { salt: 93002 });
      const takerSig = await signOrder(seller, takerOrder);
      const makerSig = await signOrder(buyer, makerOrder);

      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0, [makerOrder], [makerSig], [0], fill, [fill], [0], [0],
        ),
      ).to.be.revertedWith("InvalidMatch()");
    });
  });

  describe("BIZ-005 (LOW) — operator-fee ceiling at asymmetric prices and across makers", function () {
    // SCRUM-224 replaced the on-chain `_computeFee` with operator-supplied per-leg fees
    // bounded by `_validateFee`: fee <= cashValue * maxFeeRateBps / 10000. The original
    // finding (fee asserted only at price 0.5) is re-pointed at that ceiling.
    const fill = ONE.mul(100);

    function cap(cashValue) {
      return cashValue.mul(ctx.constants.MAX_FEE_RATE_BPS).div(10000);
    }

    async function accrued() {
      return ctx.contracts.adminConfig.getAccruedFees(ctx.contracts.collateral.address);
    }

    for (const [label, priceTenths, salt] of [["0.1·unit", 1, 95001], ["0.9·unit", 9, 95011]]) {
      it(`complementary at ${label}: a fee exactly at the ceiling accrues; one unit above reverts FeeExceedsMaxRate`, async function () {
        const { settlement, collateral } = ctx.contracts;
        const { buyer, seller, operator } = ctx.signers;
        const { positionIdA } = ctx.market;
        const { makeOrder, signOrder } = ctx.helpers;

        const price = ONE.mul(priceTenths).div(10);
        const cashValue = price.mul(fill).div(ONE);
        const fee = cap(cashValue);

        const takerOrder = makeOrder(buyer.address, positionIdA, 0, fill.mul(2), price, { salt });
        const makerOrder = makeOrder(seller.address, positionIdA, 1, fill.mul(2), price, { salt: salt + 1 });
        const takerSig = await signOrder(buyer, takerOrder);
        const makerSig = await signOrder(seller, makerOrder);

        await expect(
          settlement.connect(operator).matchOrders(
            takerOrder, takerSig, 0, [makerOrder], [makerSig], [0], fill, [fill], [fee.add(1)], [0],
          ),
        ).to.be.revertedWith("FeeExceedsMaxRate()");

        const accruedBefore = await accrued();
        const buyerBefore = await collateral.balanceOf(buyer.address);
        const sellerBefore = await collateral.balanceOf(seller.address);

        await settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0, [makerOrder], [makerSig], [0], fill, [fill], [fee], [fee],
        );

        expect((await accrued()).sub(accruedBefore)).to.equal(fee.mul(2));
        expect(buyerBefore.sub(await collateral.balanceOf(buyer.address))).to.equal(cashValue.add(fee));
        expect((await collateral.balanceOf(seller.address)).sub(sellerBefore)).to.equal(cashValue.sub(fee));
      });
    }

    it("mint at P_t = 0.9 / P_m = 0.1: each leg is capped on its own collateral, not the trade's", async function () {
      const { settlement } = ctx.contracts;
      const { buyer, buyerB, operator } = ctx.signers;
      const { positionIdA, positionIdB } = ctx.market;
      const { makeOrder, signOrder } = ctx.helpers;

      const takerPrice = ONE.mul(9).div(10);
      const makerPrice = ONE.div(10);
      const makerCollateral = makerPrice.mul(fill).div(ONE); // 10
      const takerCollateral = fill.sub(makerCollateral);     // 90
      const takerCap = cap(takerCollateral);
      const makerCap = cap(makerCollateral);

      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fill.mul(2), takerPrice, { salt: 95021 });
      const makerOrder = makeOrder(buyerB.address, positionIdB, 0, fill.mul(2), makerPrice, { salt: 95022 });
      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(buyerB, makerOrder);

      // The taker's ceiling applied to the maker's smaller leg is rejected.
      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0, [makerOrder], [makerSig], [0], fill, [fill], [takerCap], [takerCap],
        ),
      ).to.be.revertedWith("FeeExceedsMaxRate()");

      const before = await accrued();
      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0, [makerOrder], [makerSig], [0], fill, [fill], [takerCap], [makerCap],
      );
      expect((await accrued()).sub(before)).to.equal(takerCap.add(makerCap));
    });

    it("multi-maker matchOrders: every leg's fee accrues and the total equals their sum", async function () {
      const { settlement, conditionalTokens, collateral } = ctx.contracts;
      const { owner, buyer, seller, operator } = ctx.signers;
      const { conditionId, positionIdA } = ctx.market;
      const { makeOrder, signOrder } = ctx.helpers;

      // A second positionA seller: the owner splits fresh inventory.
      await conditionalTokens.connect(owner).splitPosition(
        collateral.address, ethers.constants.HashZero, conditionId, [1, 2], fill,
      );

      const half = fill.div(2);
      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fill, ONE.div(2), { salt: 95031 });
      const maker1 = makeOrder(seller.address, positionIdA, 1, half, ONE.mul(4).div(10), { salt: 95032 });
      const maker2 = makeOrder(owner.address, positionIdA, 1, half, ONE.mul(45).div(100), { salt: 95033 });
      const takerSig = await signOrder(buyer, takerOrder);
      const sig1 = await signOrder(seller, maker1);
      const sig2 = await signOrder(owner, maker2);

      const takerFees = [ONE.div(5), ONE.mul(3).div(10)];     // 0.20, 0.30
      const makerFees = [ONE.div(4), ONE.mul(35).div(100)];   // 0.25, 0.35
      const total = [...takerFees, ...makerFees].reduce((a, b) => a.add(b), ethers.BigNumber.from(0));

      const before = await accrued();
      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0, [maker1, maker2], [sig1, sig2], [0, 0], fill, [half, half], takerFees, makerFees,
      );
      expect((await accrued()).sub(before)).to.equal(total);
    });
  });

  describe("BIZ-008 / GAS-001 (RESOLVED, SCRUM-226) — the signed DoefinOrder is the 10-field struct", function () {
    it("RESOLVED — the contract's order hash equals the EIP-712 hash of the 10-field type, with no removed field", async function () {
      const { sigVerifier } = ctx.contracts;
      const { buyer } = ctx.signers;
      const { positionIdA } = ctx.market;

      const fields = ORDER_TYPE.DoefinOrder.map((f) => f.name);
      expect(fields).to.have.lengthOf(10);
      for (const removed of ["minFillAmount", "orderType", "quoteCurrency", "exchangeRate", "feeRateBps"]) {
        expect(fields).to.not.include(removed);
      }

      const order = ctx.helpers.makeOrder(buyer.address, positionIdA, 0, ONE.mul(5), ONE.div(3), { salt: 96001 });
      expect(await sigVerifier.getOrderHash(order)).to.equal(typedDataHash(order));
    });
  });

  // ==========================================================================
  // MAINTAINABILITY
  // ==========================================================================

  describe("CPX-003 (LOW, FIXED) — one order hash and one validity rule across NonceManager and settlement", function () {
    async function matchAgainstSeller(takerOrder, takerSigner, salt) {
      const { settlement } = ctx.contracts;
      const { seller, operator } = ctx.signers;
      const { makeOrder, signOrder } = ctx.helpers;
      const makerOrder = makeOrder(seller.address, ctx.market.positionIdA, 1, ONE, takerOrder.pricePerToken, { salt });
      const takerSig = await signOrder(takerSigner, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);
      return settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0, [makerOrder], [makerSig], [0], ONE, [ONE], [0], [0],
      );
    }

    it("valid order — isOrderValid is true and settlement accepts it", async function () {
      const { nonceMgr } = ctx.contracts;
      const { buyer } = ctx.signers;
      const order = ctx.helpers.makeOrder(buyer.address, ctx.market.positionIdA, 0, ONE, ONE.div(2), { salt: 97001 });
      expect(await nonceMgr.isOrderValid(order)).to.equal(true);
      await matchAgainstSeller(order, buyer, 97002);
    });

    it("cancelled order — NonceManager cancels the same hash settlement checks: isOrderValid false, OrderCancelled", async function () {
      const { nonceMgr } = ctx.contracts;
      const { buyer } = ctx.signers;
      const order = ctx.helpers.makeOrder(buyer.address, ctx.market.positionIdA, 0, ONE, ONE.div(2), { salt: 97011 });
      await nonceMgr.connect(buyer).cancelOrder(order);

      const hash = typedDataHash(order);
      expect(await nonceMgr.isCancelled(hash)).to.equal(true);
      expect(await nonceMgr.isOrderValid(order)).to.equal(false);
      await expect(matchAgainstSeller(order, buyer, 97012)).to.be.revertedWith(`OrderCancelled("${hash}")`);
    });

    it("expired order — isOrderValid false, settlement reverts OrderCancelled", async function () {
      const { nonceMgr } = ctx.contracts;
      const { buyer } = ctx.signers;
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      const order = ctx.helpers.makeOrder(buyer.address, ctx.market.positionIdA, 0, ONE, ONE.div(2), {
        salt: 97021,
        expiration: now - 1,
      });
      expect(await nonceMgr.isOrderValid(order)).to.equal(false);
      await expect(matchAgainstSeller(order, buyer, 97022)).to.be.revertedWith(`OrderCancelled("${typedDataHash(order)}")`);
    });

    it("stale nonce — isOrderValid false, settlement reverts OrderNonceInvalid(hash, 0, 1)", async function () {
      const { nonceMgr } = ctx.contracts;
      const { attacker } = ctx.signers;
      // `attacker` places no other order in this file, so bumping its nonce is local to this test.
      const order = ctx.helpers.makeOrder(attacker.address, ctx.market.positionIdA, 0, ONE, ONE.div(2), { salt: 97031 });
      await nonceMgr.connect(attacker).incrementNonce();

      expect(await nonceMgr.isOrderValid(order)).to.equal(false);
      await expect(matchAgainstSeller(order, attacker, 97032)).to.be.revertedWith(
        `OrderNonceInvalid("${typedDataHash(order)}", 0, 1)`,
      );
    });
  });
});
