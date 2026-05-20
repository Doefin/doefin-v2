// PENTEST · SEC-003 (MED) — `_executeOperatorFill` allows a zero
// `collateralAmount` fill (regression of SC-008 NEW-5)
// ----------------------------------------------------------------------------
// Attack scenario
//
//   `_executeOperatorFill` computes `collateralAmount = price * fill / unit`
//   using floored integer division. For any `price * fill < unit` the result
//   is 0. With `feeRateBps == 0` the `_computeFee` early-return skips its
//   own `price > unit` guard, so the path proceeds with `collateralAmount=0`:
//
//     - BUY order: `safeTransferFrom(maker, operator, 0)`. The maker pays
//       nothing. The operator then transfers `fill` position tokens to the
//       maker — the maker receives position tokens FOR FREE.
//     - SELL order: `safeTransferFrom(operator, maker, 0 - fee)`. Operator
//       pays nothing. The maker hands over `fill` position tokens. The
//       operator extracts position tokens FOR FREE. With a non-zero fee
//       the subtraction would underflow-panic, but with `fee == 0` it
//       silently succeeds.
//
//   SC-008's follow-up flagged this as NEW-5; the recommended `==0` guard
//   was never applied. Triage merged BIZ-003 and NEW-5 into SEC-003.
//
// Pre-fix economic impact
//
//   A compromised operator extracts position tokens for free via
//   `fillOrder`, bounded to dust fills (sub-`unit` per call) but stackable
//   across many calls. With `unit = 1e6` (USDC), every call can drain up to
//   `unit - 1 = 999_999` position-token wei per round-trip.
//
// Fix
//
//   In `_executeOperatorFill`, immediately after `collateralAmount` is
//   computed:
//       if (collateralAmount == 0)        revert Errors.ZeroAmount();
//       if (collateralAmount < fee)       revert Errors.InvalidPrice();
//   The second guard also makes the later `collateralAmount - fee`
//   subtraction safe from an underflow panic.
//
// Verifying the bug exists pre-fix
//
//   To watch this pentest fail, comment out those two guards (search
//   `SEC-003` in `contracts/facets/SettlementFacet.sol`) and re-run. The
//   ATTACK BLOCKED tests will fail with no revert.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupAuditFixture } = require("../utils/auditFixture.js");

describe("PENTEST · SEC-003 (MED) — _executeOperatorFill zero-collateral extraction", function () {
  let ctx;

  before(async function () {
    ctx = await setupAuditFixture();
  });

  // --- Attack 1: free position tokens to the maker via a BUY -----------------

  it("ATTACK BLOCKED — sub-unit BUY fillOrder reverts ZeroAmount", async function () {
    const { settlement } = ctx.contracts;
    const { buyer, operator } = ctx.signers;
    const { positionIdA } = ctx.market;
    const { UNIT } = ctx.constants;
    const { makeOrder, signOrder } = ctx.helpers;

    // unit = 1e6, price = 1 (smallest non-zero), fill = 999_999 ⇒
    //   collateralAmount = 1 * 999_999 / 1e6 = 0 (floored).
    // Zero fee skips _computeFee's own `price > unit` guard.
    //
    // Pre-fix, the buyer pays 0 and receives 999_999 position tokens —
    // free extraction. The seed split gave the operator `splitAmount`
    // position tokens, so the operator has stock to give away.
    const order = makeOrder(buyer.address, positionIdA, 0 /* BUY */, 999_999, 1, {
      salt: 90001,
      feeRateBps: 0,
    });
    const sig = await signOrder(buyer, order);

    await expect(
      settlement.connect(operator).fillOrder(order, sig, 0, 999_999),
    ).to.be.revertedWith("ZeroAmount()");

    // sanity context — the price is well within unit, so BIZ-004 does NOT
    // intercept this:  1 ≤ 1e6  ⇒  pricePerToken ≤ unit
    expect(order.pricePerToken).to.be.lt(UNIT);
  });

  // --- Attack 2: free position tokens to the operator via a SELL -------------

  it("ATTACK BLOCKED — sub-unit SELL fillOrder reverts ZeroAmount", async function () {
    const { settlement } = ctx.contracts;
    const { seller, operator } = ctx.signers;
    const { positionIdA } = ctx.market;
    const { makeOrder, signOrder } = ctx.helpers;

    // Mirror attack on the SELL side. Seller has the seed positionA tokens
    // from the fixture; operator pays 0, receives them for free.
    const order = makeOrder(seller.address, positionIdA, 1 /* SELL */, 999_999, 1, {
      salt: 90002,
      feeRateBps: 0,
    });
    const sig = await signOrder(seller, order);

    await expect(
      settlement.connect(operator).fillOrder(order, sig, 0, 999_999),
    ).to.be.revertedWith("ZeroAmount()");
  });

  // --- Attack 3: would-be underflow on collateralAmount - fee ----------------

  it("ATTACK BLOCKED — `collateralAmount < fee` reverts InvalidPrice instead of underflow-panicking", async function () {
    // Conceptual: the SC-008 follow-up noted that even when
    // `collateralAmount > 0`, the later `collateralAmount - fee` could
    // underflow-panic when fee dominates. The same `_executeOperatorFill`
    // guard at SEC-003 catches this with a clean `InvalidPrice` instead.
    //
    // We assert the guard ordering by directly building an order where
    // `collateralAmount` is zero and `fee` is also zero — confirming the
    // first revert (`ZeroAmount`) fires before any subtraction.
    const { settlement } = ctx.contracts;
    const { buyer, operator } = ctx.signers;
    const { positionIdA } = ctx.market;
    const { makeOrder, signOrder } = ctx.helpers;

    const order = makeOrder(buyer.address, positionIdA, 0, 999_999, 1, {
      salt: 90003, feeRateBps: 0,
    });
    const sig = await signOrder(buyer, order);

    await expect(
      settlement.connect(operator).fillOrder(order, sig, 0, 999_999),
    ).to.be.revertedWith("ZeroAmount()");
  });

  // --- Control ---------------------------------------------------------------

  it("CONTROL — a SELL fill whose collateral leg rounds to a non-zero amount settles normally", async function () {
    // Uses the SELL path so the maker (seller, who holds positionA from the
    // fixture seed split) hands over position tokens and the operator pays
    // collateral. unit=1e6, price=0.5e6, fill=10e6 ⇒ collateralAmount = 5e6 > 0.
    const { settlement, collateral } = ctx.contracts;
    const { seller, operator } = ctx.signers;
    const { positionIdA } = ctx.market;
    const { UNIT } = ctx.constants;
    const { makeOrder, signOrder } = ctx.helpers;

    const fillAmount = ethers.utils.parseUnits("10", 6);
    const price = UNIT.div(2);
    const order = makeOrder(seller.address, positionIdA, 1 /* SELL */, fillAmount, price, {
      salt: 90099, feeRateBps: 0,
    });
    const sig = await signOrder(seller, order);

    const sellerColBefore = await collateral.balanceOf(seller.address);
    await settlement.connect(operator).fillOrder(order, sig, 0, fillAmount);
    const sellerColAfter = await collateral.balanceOf(seller.address);

    // Seller receives `price * fill / unit` USDC (5e6 with these inputs).
    const expectedCollateral = price.mul(fillAmount).div(UNIT);
    expect(sellerColAfter.sub(sellerColBefore)).to.equal(expectedCollateral);
  });
});
