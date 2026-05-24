// SettlementFacet — coverage follow-up
// ============================================================================
// Closes uncovered branches in `contracts/facets/SettlementFacet.sol` reported
// by the `npx hardhat coverage` run (the post-SCRUM-234 instrumented pass).
// Each `describe` block names the contract line(s) it pins.
//
//   matchOrders L95-100  — each individual array-length-mismatch clause
//   _settleAgainstMaker L194 — a per-leg `fillAmount == 0` in a multi-maker call
//   _settleMint L545     — the `takerCollateral == 0` operand of the BL-N2 guard
//   _settleMerge L629    — the `takerPayout == 0` operand of the BL-N2 guard
//   _executeOperatorFill L729-731 — the SELL-side live-fee branch
//   _isBinaryComplement L395 — an unregistered taker position
//   nonReentrant / LibReentrancyGuard L40 — a reentrant settlement call
//
// Tests are SPEC-FIRST: expected numbers are computed from the settlement
// formulae in `audit/business-logic/invariants.md`, not lifted from the
// contract.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupAuditFixture } = require("../../utils/auditFixture.js");

describe("SettlementFacet — coverage follow-up", function () {
  let ctx;

  beforeEach(async function () {
    ctx = await setupAuditFixture();
  });

  // ──────────────────────────────────────────────────────────────────────
  // matchOrders L95-100 — the input-validation `||` chain reverts
  // `MismatchedInputLengths` when ANY per-leg array length diverges from
  // `makerOrders.length`. The existing suite only ever trips the first
  // clause; these pin each clause as the deciding mismatch.
  // ──────────────────────────────────────────────────────────────────────
  describe("matchOrders — per-array length-mismatch clauses (L95-100)", function () {
    // Build a valid 1-maker complementary call, then override exactly one
    // array to length 2 so a single clause is the first to be true.
    async function buildOneMakerCall() {
      const { buyer, seller } = ctx.signers;
      const { positionIdA } = ctx.market;
      const { UNIT } = ctx.constants;
      const { makeOrder, signOrder } = ctx.helpers;

      const fill = ethers.utils.parseUnits("100", 6);
      const price = UNIT.div(2);
      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fill, price, { salt: 70001 });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, fill, price, { salt: 70001 });
      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);
      return {
        takerOrder, takerSig, makerOrder, makerSig, fill,
        // canonical length-1 arrays
        makerOrders: [makerOrder],
        makerSignatures: [makerSig],
        makerSignatureTypes: [0],
        makerFillAmounts: [fill],
        takerFees: [0],
        makerFees: [0],
      };
    }

    const cases = [
      ["makerFillAmounts", (a) => { a.makerFillAmounts = [a.fill, a.fill]; }],
      ["makerSignatures", (a) => { a.makerSignatures = [a.makerSig, a.makerSig]; }],
      ["makerSignatureTypes", (a) => { a.makerSignatureTypes = [0, 0]; }],
      ["takerFees", (a) => { a.takerFees = [0, 0]; }],
      ["makerFees", (a) => { a.makerFees = [0, 0]; }],
    ];

    for (const [name, mutate] of cases) {
      it(`reverts MismatchedInputLengths when ${name} is the diverging array`, async function () {
        const { settlement } = ctx.contracts;
        const { operator } = ctx.signers;
        const a = await buildOneMakerCall();
        mutate(a); // exactly one array becomes length 2; makerOrders stays length 1

        await expect(
          settlement.connect(operator).matchOrders(
            a.takerOrder, a.takerSig, 0,
            a.makerOrders, a.makerSignatures, a.makerSignatureTypes,
            a.fill, a.makerFillAmounts, a.takerFees, a.makerFees,
          ),
        ).to.be.revertedWith("MismatchedInputLengths()");
      });
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // _settleAgainstMaker L194 — `if (fillAmount == 0) revert ZeroAmount()`.
  // `matchOrders` L104 already rejects a zero TAKER fill; the per-leg guard
  // only fires when a maker leg is zero while the taker total is non-zero —
  // reachable only with >= 2 maker legs.
  // ──────────────────────────────────────────────────────────────────────
  describe("_settleAgainstMaker — a zero-fill maker leg (L194)", function () {
    it("reverts ZeroAmount when one maker leg of a multi-leg call has fillAmount 0", async function () {
      const { settlement } = ctx.contracts;
      const { buyer, seller, operator } = ctx.signers;
      const { positionIdA } = ctx.market;
      const { UNIT } = ctx.constants;
      const { makeOrder, signOrder } = ctx.helpers;

      const legFill = ethers.utils.parseUnits("100", 6);
      const price = UNIT.div(2);

      // Taker BUYs `legFill`; two SELL maker orders from the same seller
      // (distinct salts ⇒ distinct hashes — not a self-trade, taker != seller).
      const takerOrder = makeOrder(buyer.address, positionIdA, 0, legFill, price, { salt: 71001 });
      const maker1 = makeOrder(seller.address, positionIdA, 1, legFill, price, { salt: 71002 });
      const maker2 = makeOrder(seller.address, positionIdA, 1, legFill, price, { salt: 71003 });
      const takerSig = await signOrder(buyer, takerOrder);
      const maker1Sig = await signOrder(seller, maker1);
      const maker2Sig = await signOrder(seller, maker2);

      // makerFillAmounts = [legFill, 0]: leg 0 settles, leg 1 hits the
      // per-leg zero guard. totalMakerFill (legFill + 0) == takerFillAmount.
      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [maker1, maker2], [maker1Sig, maker2Sig], [0, 0],
          legFill, [legFill, 0], [0, 0], [0, 0],
        ),
      ).to.be.revertedWith("ZeroAmount()");
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // _settleMint L545 / _settleMerge L629 — the SECOND operand of the BL-N2
  // zero-collateral guard (`takerCollateral == 0` / `takerPayout == 0`).
  // SCRUM-234's Gap-8 tests trip the FIRST operand (maker leg == 0); these
  // trip the taker leg by setting the maker price to the full `unit`.
  // ──────────────────────────────────────────────────────────────────────
  describe("BL-N2 guard — the taker-leg operand (L545 / L629)", function () {
    it("mint: reverts ZeroAmount when takerCollateral truncates to 0 (maker price == unit)", async function () {
      const { settlement } = ctx.contracts;
      const { buyer, buyerB, operator } = ctx.signers;
      const { positionIdA, positionIdB } = ctx.market;
      const { UNIT } = ctx.constants;
      const { makeOrder, signOrder } = ctx.helpers;

      // Maker BUYs B at price == unit ⇒ makerCollateral = floorDiv(unit*f,unit)
      // = f (non-zero) ⇒ takerCollateral = f - f = 0. Crossing holds
      // (P_t + unit >= unit for any P_t). The guard's `|| takerCollateral==0`
      // operand rejects it.
      const fill = ethers.utils.parseUnits("100", 6);
      const takerOrder = makeOrder(buyer.address, positionIdA, 0, fill, ethers.constants.Zero, { salt: 72001 });
      const makerOrder = makeOrder(buyerB.address, positionIdB, 0, fill, UNIT, { salt: 72001 });
      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(buyerB, makerOrder);

      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          fill, [fill], [0], [0],
        ),
      ).to.be.revertedWith("ZeroAmount()");
    });

    it("merge: reverts ZeroAmount when takerPayout truncates to 0 (maker price == unit)", async function () {
      const { settlement } = ctx.contracts;
      const { seller, buyerB, operator } = ctx.signers;
      const { positionIdA, positionIdB } = ctx.market;
      const { UNIT } = ctx.constants;
      const { makeOrder, signOrder } = ctx.helpers;

      // Maker SELLs B at price == unit ⇒ makerPayout = f (non-zero) ⇒
      // takerPayout = 0. Merge crossing requires P_t + P_m <= unit, so the
      // taker price must be 0. The `|| takerPayout == 0` operand rejects it.
      const fill = ethers.utils.parseUnits("100", 6);
      const takerOrder = makeOrder(seller.address, positionIdA, 1, fill, ethers.constants.Zero, { salt: 72002 });
      const makerOrder = makeOrder(buyerB.address, positionIdB, 1, fill, UNIT, { salt: 72002 });
      const takerSig = await signOrder(seller, takerOrder);
      const makerSig = await signOrder(buyerB, makerOrder);

      await expect(
        settlement.connect(operator).matchOrders(
          takerOrder, takerSig, 0,
          [makerOrder], [makerSig], [0],
          fill, [fill], [0], [0],
        ),
      ).to.be.revertedWith("ZeroAmount()");
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // _executeOperatorFill — the SELL-side `if (fee > 0)` branch (SCRUM-236
  // migrated). The SEC-003 sell-side test fills with fee 0; this drives a
  // live fee so the operator-pays-bank leg and its FeeAccrued event are
  // exercised. Pre-SCRUM-236 this asserted `FeeCharged(feeReceiver, fee)` and
  // direct feeReceiver balance growth; post-SCRUM-236 fees credit the
  // in-Diamond bank and the FEE_KIND_TRADING discriminator is part of the event.
  // ──────────────────────────────────────────────────────────────────────
  describe("_executeOperatorFill — SELL-side fillOrder with a live fee", function () {
    it("credits the operator-supplied fee to accruedFees on a sell-side fill (SCRUM-236)", async function () {
      const { settlement, collateral, erc1155Facet, adminConfig } = ctx.contracts;
      const { seller, operator } = ctx.signers;
      const { positionIdA } = ctx.market;
      const { UNIT } = ctx.constants;
      const { makeOrder, signOrder, legFee } = ctx.helpers;

      const fill = ethers.utils.parseUnits("80", 6);
      const price = UNIT.div(2);
      // Spec: collateralAmount = price*fill/unit; fee within the fixture cap.
      const collateralAmount = price.mul(fill).div(UNIT);
      const fee = legFee(price, fill);
      const netCollateral = collateralAmount.sub(fee);

      const order = makeOrder(seller.address, positionIdA, 1, fill, price, { salt: 73001 });
      const sig = await signOrder(seller, order);

      const sellerCollBefore = await collateral.balanceOf(seller.address);
      const opCollBefore = await collateral.balanceOf(operator.address);
      const accruedBefore = await adminConfig.getAccruedFees(collateral.address);
      const sellerPosBefore = await erc1155Facet.balanceOf(seller.address, positionIdA);
      const opPosBefore = await erc1155Facet.balanceOf(operator.address, positionIdA);

      // FEE_KIND_TRADING = 0 (LibConstants.FEE_KIND_TRADING).
      await expect(settlement.connect(operator).fillOrder(order, sig, 0, fill, fee))
        .to.emit(settlement, "FeeAccrued")
        .withArgs(collateral.address, fee, 0);

      // Seller is paid the net (collateral minus fee); operator pays the full
      // collateral (net to seller + fee INTO Diamond). accruedFees grows by fee.
      expect((await collateral.balanceOf(seller.address)).sub(sellerCollBefore)).to.equal(netCollateral);
      expect(opCollBefore.sub(await collateral.balanceOf(operator.address))).to.equal(collateralAmount);
      expect((await adminConfig.getAccruedFees(collateral.address)).sub(accruedBefore)).to.equal(fee);

      // Position tokens move seller -> operator.
      expect(sellerPosBefore.sub(await erc1155Facet.balanceOf(seller.address, positionIdA))).to.equal(fill);
      expect((await erc1155Facet.balanceOf(operator.address, positionIdA)).sub(opPosBefore)).to.equal(fill);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // _isBinaryComplement L395 — `if (marketKey == bytes32(0)) return false`.
  // A taker order carrying a positionId that was never registered (never
  // split) has no market key; `_determineMatchType` then falls through to a
  // single InvalidMatch revert.
  // ──────────────────────────────────────────────────────────────────────
  describe("_isBinaryComplement — an unregistered taker position (L395)", function () {
    it("reverts InvalidMatch when the taker position is not in the CTF registry", async function () {
      const { settlement } = ctx.contracts;
      const { buyer, seller, operator } = ctx.signers;
      const { positionIdA } = ctx.market;
      const { UNIT } = ctx.constants;
      const { makeOrder, signOrder } = ctx.helpers;

      const fill = ethers.utils.parseUnits("50", 6);
      const price = UNIT.div(2);
      // A positionId never produced by splitPosition ⇒ no marketKey entry.
      const unregistered = ethers.utils.id("coverage-followup-unregistered-position");

      // Taker BUYs the unregistered position; maker BUYs the registered
      // positionIdA. Different positionIds ⇒ the complementary short-circuit
      // is skipped and `_isBinaryComplement(unregistered, positionIdA)` runs,
      // returning false at the `marketKey == 0` guard.
      //
      // Both sides are BUY so the test is mutation-strong: if the `marketKey
      // == 0` guard wrongly returned `true`, `_determineMatchType` would route
      // to MATCH_MINT and `_settleMint` would revert `InvalidPositionId`
      // (registry miss) — a DIFFERENT error than the `InvalidMatch` asserted
      // here, so the mutant is killed.
      const takerOrder = makeOrder(buyer.address, unregistered, 0, fill, price, { salt: 74001 });
      const makerOrder = makeOrder(seller.address, positionIdA, 0, fill, price, { salt: 74001 });
      const takerSig = await signOrder(buyer, takerOrder);
      const makerSig = await signOrder(seller, makerOrder);

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
  // nonReentrant / LibReentrancyGuard L40 — the `_status == _ENTERED` revert.
  //
  // `matchOrders` / `fillOrder` are BOTH `onlyOperator notPaused nonReentrant`,
  // with `onlyOperator` outermost. A reentrant call therefore only reaches
  // the reentrancy guard if it passes `onlyOperator` — i.e. only if the
  // reentrant caller IS the operator. This test makes the operator a
  // contract that reenters `fillOrder` from inside the `onERC1155Received`
  // callback fired by the sell-side position-token transfer. It is the worst
  // case for the guard and the only actor that can reach L40.
  //
  // The reentrant call's result is captured (not bubbled) so we can assert it
  // specifically reverted `ReentrantCall()`; the callback then returns the
  // ERC-1155 magic value, so the OUTER fill still settles — proving the guard
  // rejects the reentry without breaking the legitimate call.
  // ──────────────────────────────────────────────────────────────────────
  describe("nonReentrant — a reentrant settlement call is rejected (LibReentrancyGuard L40)", function () {
    it("a reentrant fillOrder from the operator's onERC1155Received reverts ReentrantCall", async function () {
      const { settlement, settlementAdmin, collateral, erc1155Facet } = ctx.contracts;
      const { owner, seller } = ctx.signers;
      const { positionIdA } = ctx.market;
      const { diamondAddress } = ctx;
      const { UNIT } = ctx.constants;
      const { makeOrder, signOrder } = ctx.helpers;

      // Deploy the malicious operator and install it as the settlement operator.
      const Mal = await ethers.getContractFactory("MaliciousReentrantOperator");
      const mal = await Mal.deploy();
      await mal.deployed();
      await mal.setSettlement(diamondAddress);
      await settlementAdmin.connect(owner).setOperator(mal.address);

      // Fund + approve the malicious operator so the sell-side fill's
      // operator-payment leg can complete after the (rejected) reentry.
      await collateral.mint(mal.address, ethers.utils.parseUnits("100000", 6));
      await mal.approveCollateral(collateral.address, diamondAddress);

      const fill = ethers.utils.parseUnits("100", 6);
      const price = UNIT.div(2);
      const collateralAmount = price.mul(fill).div(UNIT);

      // A valid SELL order from `seller` (holds positionIdA inventory).
      const order = makeOrder(seller.address, positionIdA, 1, fill, price, { salt: 75001 });
      const sig = await signOrder(seller, order);

      // The settlement call (fee 0 keeps the operator-payment math simple).
      const fillCalldata = settlement.interface.encodeFunctionData(
        "fillOrder", [order, sig, 0, fill, 0],
      );
      await mal.setReentryCalldata(fillCalldata);

      const sellerCollBefore = await collateral.balanceOf(seller.address);
      const sellerPosBefore = await erc1155Facet.balanceOf(seller.address, positionIdA);

      // `fire` runs the outer fillOrder. The sell-side ERC-1155 transfer to
      // the operator triggers onERC1155Received, which reenters fillOrder.
      await mal.fire(fillCalldata);

      // The reentrant call WAS attempted and WAS rejected by the guard.
      expect(await mal.reentryAttempted()).to.equal(true);
      expect(await mal.reentrySucceeded()).to.equal(false);

      // ...and it reverted specifically with ReentrantCall() — not some other
      // error. The captured returndata is the 4-byte custom-error selector.
      const reentryRet = await mal.reentryReturnData();
      const reentrantCallSelector = ethers.utils.id("ReentrantCall()").slice(0, 10);
      expect(reentryRet.slice(0, 10)).to.equal(reentrantCallSelector);

      // The OUTER (legitimate) fill still settled: seller delivered `fill`
      // position tokens and was paid the collateral.
      expect(sellerPosBefore.sub(await erc1155Facet.balanceOf(seller.address, positionIdA))).to.equal(fill);
      expect((await collateral.balanceOf(seller.address)).sub(sellerCollBefore)).to.equal(collateralAmount);
      expect(await erc1155Facet.balanceOf(mal.address, positionIdA)).to.equal(fill);
    });
  });
});
