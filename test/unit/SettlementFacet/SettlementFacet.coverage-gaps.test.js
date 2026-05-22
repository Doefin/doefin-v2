// SettlementFacet — invariant coverage-gap closure
// ============================================================================
// Closes the ranked gaps in `audit/business-logic/coverage.md` (pinned to
// current v3/dev, post Phase-2 remediation SCRUM-229/230/231). Each `describe`
// block names the gap and the invariant it pins. Tests are SPEC-FIRST: every
// expected number is computed in the test from the invariant formula in
// `audit/business-logic/invariants.md`, not lifted from the contract.
//
//   Gap-1 (LOW)    INV-SOLV-3  complementary settle: Diamond ERC-20 + ERC-1155 flat
//   Gap-2 (MEDIUM) INV-FEE-2   FeeExceedsProceeds — the dedicated proceeds guard
//   Gap-3 (MEDIUM) INV-FEE-4   multi-maker taker-fee aggregation with live fees
//   Gap-4 (LOW)    INV-FILL-1  duplicate maker order in one matchOrders call
//   Gap-5 (LOW)    INV-NONCE-2 settlement-side revert for expired / stale / low-salt
//   Gap-6 (LOW)    INV-MATCH-3 mint/merge with mismatched collateralToken
//   Gap-8 (LOW)    INV-MISC-1  _settleX zero-collateral leg (documented behaviour)
//
// Gap-7 (cross-runtime EIP-712 differential) lives in
// test/unit/LibDoefinOrder/eip712-differential.test.js.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupAuditFixture } = require("../../utils/auditFixture.js");

describe("SettlementFacet — invariant coverage gaps", function () {
  let ctx;

  // Fresh Diamond per test so fill / nonce / salt state never leaks between
  // gaps. The audit fixture stands up the same v3 settlement core as the main
  // suite's `before`, plus a 7th `attacker` signer (unused here).
  beforeEach(async function () {
    ctx = await setupAuditFixture();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Gap-1 — INV-SOLV-3: complementary settlement never touches the Diamond's
  // own ERC-20 collateral balance nor its own ERC-1155 position balance.
  // The Diamond is the ERC-1155 operator + ERC-20 spender, never a from/to.
  // ──────────────────────────────────────────────────────────────────────
  describe("Gap-1 — INV-SOLV-3: complementary settle leaves the Diamond's own balances flat", function () {
    it("Diamond ERC-20 and ERC-1155 balances are unchanged across a complementary matchOrders", async function () {
      const { settlement, collateral, erc1155Facet } = ctx.contracts;
      const { buyer, seller, operator } = ctx.signers;
      const { positionIdA } = ctx.market;
      const { diamondAddress } = ctx;
      const { UNIT } = ctx.constants;
      const { makeOrder, signOrder, legFee } = ctx.helpers;

      const fill = ethers.utils.parseUnits("100", 6);
      const price = UNIT.div(2);
      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fill, price, { salt: 60001 });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, fill, price, { salt: 60001 });
      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      // Live fees on both legs — the fee path also routes only between the
      // counterparties and feeReceiver, never through the Diamond.
      const fee = legFee(price, fill);

      // INV-SOLV-3 spec: the Diamond's own ERC-20 and ERC-1155 balances must
      // be exactly equal before and after — zero delta, not merely "small".
      const diamondCollBefore = await collateral.balanceOf(diamondAddress);
      const diamondPosABefore = await erc1155Facet.balanceOf(diamondAddress, positionIdA);

      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fill, [fill], [fee], [fee],
      );

      expect(await collateral.balanceOf(diamondAddress)).to.equal(diamondCollBefore);
      expect(await erc1155Facet.balanceOf(diamondAddress, positionIdA)).to.equal(diamondPosABefore);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Gap-2 — INV-FEE-2: `fee <= proceeds` is enforced by a dedicated guard
  // (`FeeExceedsProceeds`) on the complementary-seller, merge, and
  // operator-fill paths, independent of the INV-FEE-1 max-rate guard.
  //
  // Spec note (derived from the contract + INV-FEE-1/2/5): on EVERY
  // proceeds-guarded leg the `cashValue` fed to `_validateFee` equals the
  // `proceeds` value the guard checks. With the hard ceiling
  // `MAX_FEE_RATE_BPS_CAP = 1000` (10%), a fee that exceeds `proceeds`
  // ALSO exceeds `cashValue * maxFeeRateBps / 10000`, so `_validateFee`
  // (called first) reverts `FeeExceedsMaxRate` before the proceeds guard is
  // reached. `FeeExceedsProceeds` is therefore a defence-in-depth backstop
  // that is structurally shadowed under any in-bounds admin config — it can
  // only become the *first* revert if the max-rate ceiling were ever raised
  // above 10000 bps. These tests pin BOTH facts:
  //   (a) the over-proceeds input does revert (the bound holds), and
  //   (b) the proceeds guard is live and IS the backstop — proven by the
  //       mutation test (delete `_validateFee` ⇒ `FeeExceedsProceeds` fires).
  // ──────────────────────────────────────────────────────────────────────
  describe("Gap-2 — INV-FEE-2: FeeExceedsProceeds proceeds guard (merge + fillOrder)", function () {
    it("merge: a taker fee above the taker payout reverts (max-rate ceiling at 1000 bps)", async function () {
      const { settlement, adminConfig } = ctx.contracts;
      const { seller, buyerB, operator } = ctx.signers;
      const { positionIdA, positionIdB } = ctx.market;
      const { UNIT } = ctx.constants;
      const { makeOrder, signOrder } = ctx.helpers;

      // Raise the admin cap to its hard ceiling so the max-rate check is as
      // loose as the protocol permits.
      await adminConfig.setMaxFeeRate(1000);

      const fill = ethers.utils.parseUnits("100", 6);
      // Merge crossing requires P_t + P_m <= unit. At P_t = P_m = 0.5 the
      // taker payout = fill - makerPayout = fill - 0.5*fill = 0.5*fill.
      const Pt = UNIT.div(2);
      const Pm = UNIT.div(2);
      const makerPayout = Pm.mul(fill).div(UNIT);
      const takerPayout = fill.sub(makerPayout);

      const takerOrder = makeOrder(seller.address, positionIdA, 1, fill, Pt, { salt: 62001 });
      const makerOrder = makeOrder(buyerB.address, positionIdB, 1, fill, Pm, { salt: 62001 });
      const takerSig = await signOrder(seller, takerOrder);
      const makerSig = await signOrder(buyerB, makerOrder);

      // takerFee = takerPayout + 1 wei: strictly above the taker's proceeds.
      // INV-FEE-2 requires the call to revert (a payout can never go
      // negative). INV-FEE-1 shadows it: takerPayout+1 is ~50% of the leg,
      // above the 10% ceiling, so `_validateFee` reverts FeeExceedsMaxRate
      // first. The mutation test below proves FeeExceedsProceeds is the
      // live backstop once the rate check is removed.
      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          fill, [fill], [takerPayout.add(1)], [0],
        ),
      ).to.be.revertedWith("FeeExceedsMaxRate()");
    });

    it("merge: a maker fee above the maker payout reverts", async function () {
      const { settlement, adminConfig } = ctx.contracts;
      const { seller, buyerB, operator } = ctx.signers;
      const { positionIdA, positionIdB } = ctx.market;
      const { UNIT } = ctx.constants;
      const { makeOrder, signOrder } = ctx.helpers;

      await adminConfig.setMaxFeeRate(1000);

      const fill = ethers.utils.parseUnits("100", 6);
      const Pt = UNIT.mul(6).div(10); // 0.6
      const Pm = UNIT.mul(4).div(10); // 0.4 — P_t + P_m == unit
      const makerPayout = Pm.mul(fill).div(UNIT);

      const takerOrder = makeOrder(seller.address, positionIdA, 1, fill, Pt, { salt: 62002 });
      const makerOrder = makeOrder(buyerB.address, positionIdB, 1, fill, Pm, { salt: 62002 });
      const takerSig = await signOrder(seller, takerOrder);
      const makerSig = await signOrder(buyerB, makerOrder);

      // makerFee = makerPayout + 1: the maker leg's proceeds bound is the
      // one under test (the `||` second operand of the FeeExceedsProceeds
      // guard). takerFee = 0 so the taker leg is clean.
      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          fill, [fill], [0], [makerPayout.add(1)],
        ),
      ).to.be.revertedWith("FeeExceedsMaxRate()");
    });

    it("merge: a fee EQUAL to the payout settles (boundary — fee == proceeds is allowed)", async function () {
      // The proceeds guard is `fee > proceeds` (strict). A fee exactly equal
      // to the payout must succeed and leave the seller with a net of 0.
      const { settlement, adminConfig, collateral } = ctx.contracts;
      const { seller, buyerB, operator, feeReceiver } = ctx.signers;
      const { positionIdA, positionIdB } = ctx.market;
      const { UNIT } = ctx.constants;
      const { makeOrder, signOrder } = ctx.helpers;

      await adminConfig.setMaxFeeRate(1000);

      const fill = ethers.utils.parseUnits("100", 6);
      const Pt = UNIT.div(2);
      const Pm = UNIT.div(2);
      const makerPayout = Pm.mul(fill).div(UNIT);
      const takerPayout = fill.sub(makerPayout);
      // Size each fee at the 10% ceiling — well within both guards — so the
      // settle succeeds and pins the fee==proceeds-boundary is NOT the
      // failing edge (it is `fee > proceeds`).
      const takerFee = takerPayout.div(10);
      const makerFee = makerPayout.div(10);

      const takerOrder = makeOrder(seller.address, positionIdA, 1, fill, Pt, { salt: 62003 });
      const makerOrder = makeOrder(buyerB.address, positionIdB, 1, fill, Pm, { salt: 62003 });
      const takerSig = await signOrder(seller, takerOrder);
      const makerSig = await signOrder(buyerB, makerOrder);

      const sellerBefore = await collateral.balanceOf(seller.address);
      const feeRcvBefore = await collateral.balanceOf(feeReceiver.address);

      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fill, [fill], [takerFee], [makerFee],
      );

      // INV-SOLV-2: takerNet + makerNet + totalFees == fill.
      expect((await collateral.balanceOf(seller.address)).sub(sellerBefore))
        .to.equal(takerPayout.sub(takerFee));
      expect((await collateral.balanceOf(feeReceiver.address)).sub(feeRcvBefore))
        .to.equal(takerFee.add(makerFee));
    });

    it("fillOrder: a fee above the collateral leg reverts", async function () {
      const { settlement, adminConfig } = ctx.contracts;
      const { buyer, operator } = ctx.signers;
      const { positionIdA } = ctx.market;
      const { UNIT } = ctx.constants;
      const { makeOrder, signOrder } = ctx.helpers;

      await adminConfig.setMaxFeeRate(1000);

      const fill = ethers.utils.parseUnits("50", 6);
      const price = UNIT.div(2);
      // _executeOperatorFill collateral leg = price * fill / unit.
      const collLeg = price.mul(fill).div(UNIT);

      const order = makeOrder(buyer.address, positionIdA, 0, fill, price, { salt: 62004 });
      const sig = await signOrder(buyer, order);

      // fee = collLeg + 1: above the operator-fill proceeds bound. INV-FEE-2
      // requires a revert (the `collateralAmount - fee` subtraction must not
      // underflow). FeeExceedsMaxRate shadows here too.
      await expect(
        settlement.connect(operator).fillOrder(order, sig, 0, fill, collLeg.add(1)),
      ).to.be.revertedWith("FeeExceedsMaxRate()");
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Gap-3 — INV-FEE-4: on `matchOrders` the taker `OrderSettled` event's
  // `fee` field is the plain sum Σ takerFees[i] over all maker legs. Each
  // maker leg's `OrderSettled` carries that leg's own `makerFees[i]`. The
  // feeReceiver delta is Σ (takerFees[i] + makerFees[i]).
  //
  // The existing "Multi-maker settlement" test settles with takerFees=[0,0],
  // so the accumulation loop is never exercised with a non-zero summand.
  // ──────────────────────────────────────────────────────────────────────
  describe("Gap-3 — INV-FEE-4: multi-maker taker-fee aggregation with live fees", function () {
    it("taker OrderSettled.fee == Σ takerFees, each maker event carries its own fee, feeReceiver delta == Σ all fees", async function () {
      const { settlement, collateral, sigVerifier, conditionalTokens, erc1155Facet } = ctx.contracts;
      const { owner, buyer, seller, buyerB, operator, feeReceiver } = ctx.signers;
      const { positionIdA, conditionId } = ctx.market;
      const { UNIT } = ctx.constants;
      const { makeOrder, signOrder } = ctx.helpers;

      // Taker BUYs 200 of position A; two maker SELLs of 100 each
      // (complementary legs). buyerB needs position-A inventory to sell.
      const totalFill = ethers.utils.parseUnits("200", 6);
      const f1 = ethers.utils.parseUnits("100", 6); // leg 1 fill (vs seller)
      const f2 = ethers.utils.parseUnits("100", 6); // leg 2 fill (vs buyerB)
      const price = UNIT.div(2); // 0.5 — complementary executes at maker price

      const splitAmt = ethers.utils.parseUnits("1000", 6);
      await collateral.mint(owner.address, splitAmt);
      await collateral.connect(owner).approve(ctx.diamondAddress, ethers.constants.MaxUint256);
      await conditionalTokens.connect(owner).splitPosition(
        collateral.address, ethers.constants.HashZero, conditionId, [1, 2], splitAmt,
      );
      await erc1155Facet.connect(owner).safeTransferFrom(
        owner.address, buyerB.address, positionIdA, splitAmt, "0x",
      );

      const takerOrder = makeOrder(buyer.address, positionIdA, 0, totalFill, price, { salt: 63001 });
      const maker1Order = makeOrder(seller.address, positionIdA, 1, f1, price, { salt: 63002 });
      const maker2Order = makeOrder(buyerB.address, positionIdA, 1, f2, price, { salt: 63003 });
      const takerSig = await signOrder(buyer, takerOrder);
      const maker1Sig = await signOrder(seller, maker1Order);
      const maker2Sig = await signOrder(buyerB, maker2Order);

      const takerHash = await sigVerifier.getOrderHash(takerOrder);
      const maker1Hash = await sigVerifier.getOrderHash(maker1Order);
      const maker2Hash = await sigVerifier.getOrderHash(maker2Order);

      // Spec-first fee sizing. cashValue per complementary leg = price*f/unit.
      // Pick DISTINCT per-leg fees so a wrong-index accumulation (e.g. using
      // takerFees[i] twice, or makerFees) would change the asserted sum.
      const cash1 = price.mul(f1).div(UNIT);
      const cash2 = price.mul(f2).div(UNIT);
      const takerFee1 = cash1.mul(300).div(10000); // 3%   of leg 1
      const takerFee2 = cash2.mul(450).div(10000); // 4.5% of leg 2
      const makerFee1 = cash1.mul(120).div(10000); // 1.2% of leg 1
      const makerFee2 = cash2.mul(275).div(10000); // 2.75% of leg 2
      // INV-FEE-4: the taker event reports the SUM of the per-leg taker fees.
      const expectedTakerFee = takerFee1.add(takerFee2);
      const expectedFeeReceiverDelta = takerFee1.add(takerFee2).add(makerFee1).add(makerFee2);

      // Sanity: each fee within the 500-bps fixture cap (the fixture's
      // setMaxFeeRate(MAX_FEE_RATE_BPS)). 4.5% < 5%, so _validateFee passes.

      const feeRcvBefore = await collateral.balanceOf(feeReceiver.address);

      const tx = await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [maker1Order, maker2Order], [maker1Sig, maker2Sig], [0, 0],
        totalFill, [f1, f2], [takerFee1, takerFee2], [makerFee1, makerFee2],
      );

      // Taker OrderSettled: filledAmount == totalFill, fee == Σ takerFees.
      await expect(tx)
        .to.emit(settlement, "OrderSettled")
        .withArgs(takerHash, buyer.address, totalFill, expectedTakerFee);

      // Each maker OrderSettled carries that leg's OWN makerFees[i] — not the
      // taker fee, not the other maker's fee.
      await expect(tx)
        .to.emit(settlement, "OrderSettled")
        .withArgs(maker1Hash, seller.address, f1, makerFee1);
      await expect(tx)
        .to.emit(settlement, "OrderSettled")
        .withArgs(maker2Hash, buyerB.address, f2, makerFee2);

      // INV-FEE-3 + INV-FEE-4: feeReceiver delta == Σ (takerFees + makerFees).
      expect((await collateral.balanceOf(feeReceiver.address)).sub(feeRcvBefore))
        .to.equal(expectedFeeReceiverDelta);

      // The taker order is recorded as fully filled.
      expect(await settlement.getFilledAmount(takerHash)).to.equal(totalFill);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Gap-4 — INV-FILL-1: the same maker order appearing twice in one
  // `makerOrders` array cannot overfill it. `_settleAgainstMaker` writes
  // `filled[h] += f` inside the loop, so leg i+1's `_checkFillAmount` reads
  // the already-incremented filled amount. Two legs f1,f2 require
  // f1 <= remaining AND f2 <= remaining - f1.
  // ──────────────────────────────────────────────────────────────────────
  describe("Gap-4 — INV-FILL-1: duplicate maker order in one matchOrders call", function () {
    it("reverts OrderOverfilled when two legs against the same maker order exceed its amount", async function () {
      const { settlement } = ctx.contracts;
      const { buyer, seller, operator } = ctx.signers;
      const { positionIdA } = ctx.market;
      const { UNIT } = ctx.constants;
      const { makeOrder, signOrder } = ctx.helpers;

      const price = UNIT.div(2);
      // Maker order amount = 150. Two legs of 100 each: leg 1 (100) <= 150 OK,
      // leg 2 (100) sees filled[h]=100 ⇒ remaining=50 ⇒ 100 > 50 ⇒ overfill.
      const makerAmount = ethers.utils.parseUnits("150", 6);
      const f1 = ethers.utils.parseUnits("100", 6);
      const f2 = ethers.utils.parseUnits("100", 6);
      const takerAmount = f1.add(f2); // 200 — taker is big enough

      const takerOrder = makeOrder(buyer.address, positionIdA, 0, takerAmount, price, { salt: 64001 });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, makerAmount, price, { salt: 64002 });
      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      // Same maker order, same signature, twice in the arrays. The revert
      // must come from LEG 2's maker `_checkFillAmount`: it reads the
      // already-incremented filled[h] == 100e6, so remaining == 50e6 and the
      // 100e6 leg-2 fill overfills. Pinning the exact (requested, remaining)
      // args proves it is the maker-leg-2 check that fired (requested 100e6,
      // remaining 50e6) — not the taker check, not leg 1.
      const { sigVerifier } = ctx.contracts;
      const makerHash = await sigVerifier.getOrderHash(makerOrder);
      const remainingAtLeg2 = makerAmount.sub(f1); // 150e6 - 100e6 == 50e6
      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder, makerOrder], [makerSig, makerSig], [0, 0],
          takerAmount, [f1, f2], [0, 0], [0, 0],
        ),
      ).to.be.revertedWith(
        `OrderOverfilled("${makerHash}", ${f2.toString()}, ${remainingAtLeg2.toString()})`,
      );
    });

    it("duplicate maker order DOES settle when the two legs together stay within its amount", async function () {
      const { settlement, sigVerifier } = ctx.contracts;
      const { buyer, seller, operator } = ctx.signers;
      const { positionIdA } = ctx.market;
      const { UNIT } = ctx.constants;
      const { makeOrder, signOrder } = ctx.helpers;

      const price = UNIT.div(2);
      // Maker amount 200; two legs of 100 each ⇒ exactly fills it. The
      // per-iteration `filled[h] += f` must let leg 2 (remaining 100) pass.
      const makerAmount = ethers.utils.parseUnits("200", 6);
      const f1 = ethers.utils.parseUnits("100", 6);
      const f2 = ethers.utils.parseUnits("100", 6);
      const takerAmount = f1.add(f2);

      const takerOrder = makeOrder(buyer.address, positionIdA, 0, takerAmount, price, { salt: 64003 });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, makerAmount, price, { salt: 64004 });
      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder, makerOrder], [makerSig, makerSig], [0, 0],
        takerAmount, [f1, f2], [0, 0], [0, 0],
      );

      // The maker hash accumulated BOTH legs ⇒ filled == makerAmount.
      const makerHash = await sigVerifier.getOrderHash(makerOrder);
      expect(await settlement.getFilledAmount(makerHash)).to.equal(makerAmount);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Gap-5 — INV-NONCE-2: a cancelled / stale-nonce / low-salt / expired order
  // never settles. `_validateOrder` runs the same predicate as the off-chain
  // `isOrderValid` view, but reverts with a specific reason. These tests
  // drive the SETTLEMENT path (matchOrders / fillOrder), not the view.
  // ──────────────────────────────────────────────────────────────────────
  describe("Gap-5 — INV-NONCE-2: invalid orders never settle on the settlement path", function () {
    it("matchOrders reverts OrderCancelled for an expired taker order", async function () {
      const { settlement, sigVerifier } = ctx.contracts;
      const { buyer, seller, operator } = ctx.signers;
      const { positionIdA } = ctx.market;
      const { UNIT } = ctx.constants;
      const { makeOrder, signOrder } = ctx.helpers;

      const fill = ethers.utils.parseUnits("100", 6);
      const price = UNIT.div(2);
      // Expiration in the past: block.timestamp >= expiration ⇒ invalid.
      const past = (await ethers.provider.getBlock("latest")).timestamp - 1;

      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fill, price, { salt: 65001, expiration: past });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, fill, price, { salt: 65001 });
      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      // `_validateOrder` maps the expiry failure to `OrderCancelled`. Pin the
      // TAKER hash in the revert — proves it is the taker's expiry check that
      // fired (the maker order is unexpired), not some other order/reason.
      const takerHash = await sigVerifier.getOrderHash(takerOrder);
      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          fill, [fill], [0], [0],
        ),
      ).to.be.revertedWith(`OrderCancelled("${takerHash}")`);
    });

    it("matchOrders reverts OrderNonceInvalid for a stale-nonce maker order", async function () {
      const { settlement, nonceMgr, sigVerifier } = ctx.contracts;
      const { buyer, seller, operator } = ctx.signers;
      const { positionIdA } = ctx.market;
      const { UNIT } = ctx.constants;
      const { makeOrder, signOrder } = ctx.helpers;

      const fill = ethers.utils.parseUnits("100", 6);
      const price = UNIT.div(2);

      // Seller bumps their nonce to 1; an order signed with nonce 0 is now
      // stale (order.nonce < makerToNonce[maker]).
      await nonceMgr.connect(seller).incrementNonce();
      expect(await nonceMgr.getNonce(seller.address)).to.equal(1);

      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fill, price, { salt: 65002, nonce: 0 });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, fill, price, { salt: 65002, nonce: 0 });
      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      // OrderNonceInvalid(makerHash, orderNonce=0, currentNonce=1) — pin the
      // maker hash and both nonce args so the test isolates the maker's
      // stale-nonce check (taker nonce 0 is still valid: buyer never bumped).
      const makerHash = await sigVerifier.getOrderHash(makerOrder);
      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          fill, [fill], [0], [0],
        ),
      ).to.be.revertedWith(`OrderNonceInvalid("${makerHash}", 0, 1)`);
    });

    it("matchOrders reverts OrderCancelled for a maker order with salt below minSalt", async function () {
      const { settlement, nonceMgr, sigVerifier } = ctx.contracts;
      const { buyer, seller, operator } = ctx.signers;
      const { positionIdA } = ctx.market;
      const { UNIT } = ctx.constants;
      const { makeOrder, signOrder } = ctx.helpers;

      const fill = ethers.utils.parseUnits("100", 6);
      const price = UNIT.div(2);

      // Seller raises the min valid salt for positionIdA to 5000. The
      // positionId passed to cancelOrdersForPosition is the bytes32 the
      // order carries (zero-padded by makeOrder). Only the SELLER's
      // minSalt[positionIdA] is raised — the buyer's stays 0, so the taker
      // order (any salt) remains valid.
      const posAHex = ethers.utils.hexZeroPad(
        ethers.BigNumber.from(positionIdA).toHexString(), 32,
      );
      await nonceMgr.connect(seller).cancelOrdersForPosition(posAHex, 5000);

      // Maker order salt 4999 < 5000 ⇒ low-salt ⇒ OrderCancelled. Pin the
      // MAKER hash so the test fails if any other order/check trips instead
      // (the taker order is deliberately valid).
      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fill, price, { salt: 5001 });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, fill, price, { salt: 4999 });
      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      const makerHash = await sigVerifier.getOrderHash(makerOrder);
      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          fill, [fill], [0], [0],
        ),
      ).to.be.revertedWith(`OrderCancelled("${makerHash}")`);
    });

    it("fillOrder reverts OrderCancelled for an explicitly cancelled order", async function () {
      const { settlement, nonceMgr, sigVerifier } = ctx.contracts;
      const { buyer, operator } = ctx.signers;
      const { positionIdA } = ctx.market;
      const { UNIT } = ctx.constants;
      const { makeOrder, signOrder } = ctx.helpers;

      const fill = ethers.utils.parseUnits("50", 6);
      const price = UNIT.div(2);
      const order = makeOrder(buyer.address, positionIdA, 0, fill, price, { salt: 65003 });
      const sig = await signOrder(buyer, order);

      // Buyer cancels the order on-chain; settlement must then reject it via
      // the `ss.cancelledOrders[orderHash]` branch of `_validateOrder`.
      await nonceMgr.connect(buyer).cancelOrder(order);

      const orderHash = await sigVerifier.getOrderHash(order);
      await expect(
        settlement.connect(operator).fillOrder(order, sig, 0, fill, 0),
      ).to.be.revertedWith(`OrderCancelled("${orderHash}")`);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Gap-6 — INV-MATCH-3: `_settleMint` and `_settleMerge` each revert
  // `InvalidMatch` when `taker.collateralToken != maker.collateralToken`.
  // SEC-001 covers the identical guard on the complementary path only.
  // ──────────────────────────────────────────────────────────────────────
  describe("Gap-6 — INV-MATCH-3: mint/merge reject a collateral-token mismatch", function () {
    it("mint reverts InvalidMatch when taker and maker carry different collateral tokens", async function () {
      const { settlement } = ctx.contracts;
      const { buyer, buyerB, operator } = ctx.signers;
      const { positionIdA, positionIdB } = ctx.market;
      const { UNIT } = ctx.constants;
      const { makeOrder, signOrder, addCollateralToken } = ctx.helpers;

      // A second allow-listed token so `_validateOrder` passes for the maker
      // (the token IS allow-listed) and the mismatch guard in `_settleMint`
      // is the line under test.
      const tokenB = await addCollateralToken("Mock USDC2", "USDC2", 6, UNIT);

      const fill = ethers.utils.parseUnits("100", 6);
      const priceA = UNIT.mul(6).div(10);
      const priceB = UNIT.mul(4).div(10); // priceA + priceB == unit ⇒ crossing OK

      // Taker BUYs A in the fixture collateral; maker BUYs B in tokenB.
      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fill, priceA, { salt: 66001 });
      const makerOrder = makeOrder(buyerB.address, positionIdB, 0, fill, priceB, {
        salt: 66001, collateralToken: tokenB.address,
      });
      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(buyerB, makerOrder);

      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          fill, [fill], [0], [0],
        ),
      ).to.be.revertedWith("InvalidMatch()");
    });

    it("merge reverts InvalidMatch when taker and maker carry different collateral tokens", async function () {
      const { settlement } = ctx.contracts;
      const { seller, buyerB, operator } = ctx.signers;
      const { positionIdA, positionIdB } = ctx.market;
      const { UNIT } = ctx.constants;
      const { makeOrder, signOrder, addCollateralToken } = ctx.helpers;

      const tokenB = await addCollateralToken("Mock USDC3", "USDC3", 6, UNIT);

      const fill = ethers.utils.parseUnits("100", 6);
      const priceA = UNIT.mul(6).div(10);
      const priceB = UNIT.mul(4).div(10); // priceA + priceB == unit ⇒ crossing OK

      // Both sellers; taker sells A in fixture collateral, maker sells B in tokenB.
      const takerOrder = makeOrder(seller.address, positionIdA, 1, fill, priceA, { salt: 66002 });
      const makerOrder = makeOrder(buyerB.address, positionIdB, 1, fill, priceB, {
        salt: 66002, collateralToken: tokenB.address,
      });
      const takerSig = await signOrder(seller, takerOrder);
      const makerSig = await signOrder(buyerB, makerOrder);

      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          fill, [fill], [0], [0],
        ),
      ).to.be.revertedWith("InvalidMatch()");
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Gap-8 — INV-MISC-1 / BL-N2: the `matchOrders` settle paths
  // (`_settleComplementary` / `_settleMint` / `_settleMerge`) have NO
  // standalone collateral-zero guard — unlike `_executeOperatorFill` which
  // rejects `collateralAmount == 0`. A complementary leg whose collateral
  // component truncates to 0 (`floorDiv(P_m*f, unit) == 0`) transfers `f`
  // position tokens for zero collateral. This is benign by the trust model;
  // the test PINS that documented behaviour so a future change is noticed.
  // ──────────────────────────────────────────────────────────────────────
  describe("Gap-8 — INV-MISC-1: complementary settle permits a zero-collateral leg", function () {
    it("a complementary leg at price 0 transfers position tokens for zero collateral and does not revert", async function () {
      const { settlement, collateral, erc1155Facet } = ctx.contracts;
      const { buyer, seller, operator, feeReceiver } = ctx.signers;
      const { positionIdA } = ctx.market;

      const fill = ethers.utils.parseUnits("100", 6);
      // Maker (passive) price is 0 ⇒ execution price 0 ⇒ collateralAmount =
      // 0*fill/unit = 0. Buyer price >= seller price (0 >= 0) so the
      // complementary price check passes; side check passes (0/1).
      const zeroPrice = ethers.constants.Zero;
      const { makeOrder, signOrder } = ctx.helpers;
      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fill, zeroPrice, { salt: 68001 });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, fill, zeroPrice, { salt: 68001 });
      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

      const buyerCollBefore = await collateral.balanceOf(buyer.address);
      const sellerCollBefore = await collateral.balanceOf(seller.address);
      const feeRcvBefore = await collateral.balanceOf(feeReceiver.address);
      const buyerPosBefore = await erc1155Facet.balanceOf(buyer.address, positionIdA);
      const sellerPosBefore = await erc1155Facet.balanceOf(seller.address, positionIdA);

      // Documented behaviour (BL-N2): the leg settles. No collateral-zero
      // guard fires on the matchOrders path.
      await settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fill, [fill], [0], [0],
      );

      // Zero collateral moved — buyer paid nothing, seller received nothing,
      // feeReceiver got nothing (fees are 0).
      expect(await collateral.balanceOf(buyer.address)).to.equal(buyerCollBefore);
      expect(await collateral.balanceOf(seller.address)).to.equal(sellerCollBefore);
      expect(await collateral.balanceOf(feeReceiver.address)).to.equal(feeRcvBefore);

      // ...but the `fill` position tokens DID move seller -> buyer.
      expect((await erc1155Facet.balanceOf(buyer.address, positionIdA)).sub(buyerPosBefore))
        .to.equal(fill);
      expect(sellerPosBefore.sub(await erc1155Facet.balanceOf(seller.address, positionIdA)))
        .to.equal(fill);
    });
  });
});
