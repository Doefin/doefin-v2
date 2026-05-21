// PENTEST · BIZ-001 (MED) — `_settleMerge` payout-skip latent solvency
// ----------------------------------------------------------------------------
// STATUS: FIXED by SCRUM-224 (operator-supplied fee model).
//
// Original bug
//
//   `_settleMerge` distributed the merged `fillAmount` via:
//     if (takerPayout > takerFee) safeTransfer(taker, takerPayout - takerFee);
//     if (makerPayout > makerFee) safeTransfer(maker, makerPayout - makerFee);
//     safeTransfer(feeReceiver, takerFee + makerFee);              // UNCONDITIONAL
//
//   If `payout <= fee`, the payout was SILENTLY SKIPPED while the fee was still
//   remitted — the Diamond drew the shortfall from other markets' collateral.
//   The bug was latent: gated by the old contract fee cap, the inequality was
//   unreachable, so a future cap raise would re-arm it with no test signal.
//
// SCRUM-224 fix
//
//   The fee is now operator-supplied and `_settleMerge` enforces, BEFORE any
//   transfer, `fee <= payout` for each seller — reverting `FeeExceedsProceeds`.
//   The silent-skip branch is gone: an over-fee merge is a clean revert. This
//   pentest is now the regression check for that guard.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupAuditFixture } = require("../utils/auditFixture.js");

describe("PENTEST · BIZ-001 (MED) — _settleMerge fee-vs-payout solvency guard", function () {
  let ctx;

  before(async function () {
    ctx = await setupAuditFixture();
  });

  it("REGRESSION — a merge with an operator fee above the taker payout reverts", async function () {
    const { settlement } = ctx.contracts;
    const { seller, buyerB, operator } = ctx.signers;
    const { positionIdA, positionIdB } = ctx.market;
    const { UNIT } = ctx.constants;
    const { makeOrder, signOrder } = ctx.helpers;

    const fill = ethers.utils.parseUnits("100", 6);
    // Merge crossing requires P_t + P_m <= unit. Maker payout = P_m * fill,
    // taker payout = fill - makerPayout.
    const Pt = UNIT.div(2);
    const Pm = UNIT.div(2);
    const makerPayout = Pm.mul(fill).div(UNIT);
    const takerPayout = fill.sub(makerPayout);

    const takerOrder = makeOrder(seller.address,  positionIdA, 1, fill, Pt, { salt: 94001 });
    const makerOrder = makeOrder(buyerB.address, positionIdB, 1, fill, Pm, { salt: 94001 });
    const takerSig = await signOrder(seller,  takerOrder);
    const makerSig = await signOrder(buyerB, makerOrder);

    // Operator supplies a taker fee strictly above the taker payout. The merge
    // must revert instead of silently skipping the taker payout.
    await expect(
      settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fill, [fill], [takerPayout.add(1)], [0],
      ),
    ).to.be.reverted; // FeeExceedsMaxRate or FeeExceedsProceeds
  });

  it("CONTROL — a merge with operator fees within payout settles and conserves collateral", async function () {
    const { settlement, collateral } = ctx.contracts;
    const { seller, buyerB, operator, feeReceiver } = ctx.signers;
    const { positionIdA, positionIdB } = ctx.market;
    const { UNIT } = ctx.constants;
    const { makeOrder, signOrder, legFee } = ctx.helpers;

    const fill = ethers.utils.parseUnits("100", 6);
    const Pt = UNIT.mul(6).div(10);
    const Pm = UNIT.mul(4).div(10);
    const makerPayout = Pm.mul(fill).div(UNIT);
    const takerPayout = fill.sub(makerPayout);
    const takerFee = legFee(Pt, fill);
    const makerFee = legFee(Pm, fill);

    const takerOrder = makeOrder(seller.address,  positionIdA, 1, fill, Pt, { salt: 94002 });
    const makerOrder = makeOrder(buyerB.address, positionIdB, 1, fill, Pm, { salt: 94002 });
    const takerSig = await signOrder(seller,  takerOrder);
    const makerSig = await signOrder(buyerB, makerOrder);

    const sellerBefore = await collateral.balanceOf(seller.address);
    const buyerBBefore = await collateral.balanceOf(buyerB.address);
    const feeRcvBefore = await collateral.balanceOf(feeReceiver.address);

    await settlement.connect(operator).matchOrders(
      takerOrder, takerSig, 0,
      [makerOrder], [makerSig], [0],
      fill, [fill], [takerFee], [makerFee],
    );

    // Each seller received payout - fee; feeReceiver got both fees.
    expect((await collateral.balanceOf(seller.address)).sub(sellerBefore))
      .to.equal(takerPayout.sub(takerFee));
    expect((await collateral.balanceOf(buyerB.address)).sub(buyerBBefore))
      .to.equal(makerPayout.sub(makerFee));
    expect((await collateral.balanceOf(feeReceiver.address)).sub(feeRcvBefore))
      .to.equal(takerFee.add(makerFee));

    // Total out (both net payouts + fees) equals the merged fill — no shortfall.
    const totalOut = takerPayout.sub(takerFee)
      .add(makerPayout.sub(makerFee))
      .add(takerFee).add(makerFee);
    expect(totalOut).to.equal(fill);
  });
});
