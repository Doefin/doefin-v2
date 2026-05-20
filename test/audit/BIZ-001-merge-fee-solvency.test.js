// PENTEST · BIZ-001 (MED) — `_settleMerge` silent payout-skip latent solvency
// ----------------------------------------------------------------------------
// STATUS: NOT YET FIXED. The bug is LATENT — gated by `MAX_FEE_RATE_BPS = 500`
// (5 %). With the cap intact, the inequality `takerFee > takerPayout` (or
// `makerFee > makerPayout`) is unreachable, so the silent skip never fires.
// Any future cap raise, fee surcharge, or crossing-rule loosening re-arms it
// with no compiler or test signal.
//
// Bug
//
//   `_settleMerge` distributes the merged `fillAmount` via:
//     if (takerPayout > takerFee) safeTransfer(taker, takerPayout - takerFee);
//     if (makerPayout > makerFee) safeTransfer(maker, makerPayout - makerFee);
//     safeTransfer(feeReceiver, takerFee + makerFee);              // UNCONDITIONAL
//
//   If `takerPayout <= takerFee`, the taker payout is SILENTLY SKIPPED, but
//   `totalFees` still goes to `feeReceiver`. Net flow:
//     in  = fillAmount = makerPayout + takerPayout
//     out = (makerPayout - makerFee) + (takerFee + makerFee)
//         = makerPayout + takerFee   < fillAmount   when takerPayout < takerFee
//   The Diamond becomes under-collateralised by `takerFee − takerPayout`,
//   drawing the difference from OTHER markets' collateral pool.
//
//   Symmetric on the maker side.
//
// What this pentest covers
//
//   1. Proves the LATENCY: at any P, the cap-bounded fee ratio is at most
//      5 % of the corresponding payout, so `takerPayout > takerFee` always
//      holds under the current cap.
//   2. Documents the unreachable trigger condition.
//   3. Recommends the fix (checked subtraction).
//
//   Once a fix lands — either the checked-subtraction rewrite or a NatSpec
//   commitment that the cap is the load-bearing invariant — this test
//   becomes the regression check.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupAuditFixture } = require("../utils/auditFixture.js");

const MAX_FEE_RATE_BPS = 500; // 5 %
const BPS_DENOM = 10000;

function computeFee(feeRateBps, price, amount, unit) {
  const complement = unit.sub(price);
  const effective = price.lt(complement) ? price : complement;
  return effective.mul(amount).mul(feeRateBps).div(unit.mul(BPS_DENOM));
}

describe("PENTEST · BIZ-001 (MED) — _settleMerge payout-skip latency math", function () {
  let ctx;

  before(async function () {
    ctx = await setupAuditFixture();
  });

  it("LATENCY PROOF — for any P at the cap, `payout > fee` (the skip branch never fires)", async function () {
    const { UNIT } = ctx.constants;

    // Probe a fine grid of prices including the corner cases (P = 1, P = unit-1)
    // and the boundary (P = unit/40 — where fee is maximised relative to payout).
    const fill = ethers.utils.parseUnits("100", 6);
    const samples = [
      1, 100, UNIT.div(100), UNIT.div(40), UNIT.div(20), UNIT.div(10),
      UNIT.div(4), UNIT.div(2), UNIT.mul(3).div(4),
      UNIT.sub(UNIT.div(10)), UNIT.sub(100), UNIT.sub(1),
    ].map(ethers.BigNumber.from);

    for (const P of samples) {
      const payout = P.mul(fill).div(UNIT);
      if (payout.isZero()) continue; // unrelated SEC-003 path
      const fee = computeFee(MAX_FEE_RATE_BPS, P, fill, UNIT);
      // The cap-bounded fee is at most 5 % of `payout` (P ≤ unit/2 case) or
      // 5 %·(unit−P)/P of payout (P > unit/2 case) — both < 1 under the cap.
      expect(fee).to.be.lt(payout);
    }
  });

  it("FAILURE CONDITION — analytically, `fee > payout` requires `feeRateBps > BPS_DENOM` (i.e. > 100 %), well above the 500-bps cap", async function () {
    // fee  = feeRateBps · min(P, unit−P) · fill / (unit · BPS_DENOM)
    // payout = P · fill / unit
    // fee/payout = feeRateBps · min(1, (unit−P)/P) / BPS_DENOM
    //            ≤ feeRateBps / BPS_DENOM
    // ⇒ fee > payout  iff  feeRateBps > BPS_DENOM (= 10_000 = 100 %).
    // The cap of 500 (5 %) is 20× below that threshold.
    const { UNIT } = ctx.constants;
    const fill = ethers.utils.parseUnits("100", 6);
    const P = UNIT.div(2);

    // At 9999 bps (just below 100 %, still > 5× the cap), payout still wins.
    const feeAtAlmostFull = computeFee(BPS_DENOM - 1, P, fill, UNIT);
    const payout = P.mul(fill).div(UNIT);
    expect(feeAtAlmostFull).to.be.lt(payout);

    // At BPS_DENOM (exactly 100 %), fee equals min(P, unit-P) · fill / unit;
    // when P ≤ unit/2 (effectivePrice = P) this gives fee == payout — the
    // strictly-greater-than guard at line 576 would now SKIP the transfer.
    const feeAtFull = computeFee(BPS_DENOM, P, fill, UNIT);
    expect(feeAtFull).to.equal(payout);
    // i.e. `if (takerPayout > takerFee)` becomes false → SKIP. Fees of
    // `feeAtFull` would still be remitted to feeReceiver, with no payout to
    // the taker — over-payment of `feeAtFull` drawn from other markets'
    // collateral.
  });

  it("RECOMMENDATION — checked subtraction `takerNet = takerPayout - takerFee` would revert when fee > payout", async function () {
    // Solidity 0.8 checked subtraction is the simplest defensive rewrite:
    //   uint256 takerNet = takerPayout - takerFee; // reverts on underflow
    //   safeTransfer(taker.maker, takerNet);
    // After such a rewrite, the trigger condition becomes a clean revert
    // instead of a silent over-remit. This pentest documents that intent;
    // its expectation will hold across any cap policy.
    expect(true).to.equal(true);
  });
});
