// PENTEST · SEC-006 (MED) — fee recipient & cap mechanics
// ----------------------------------------------------------------------------
// STATUS: NOT YET FIXED (documentation + policy fix recommended).
//
// The audit found two issues bundled here:
//   (a) `.claude/CLAUDE.md` states "Operator is the fee recipient" — STALE.
//       Every fee transfer in `SettlementFacet` targets
//       `ds.adminConfigStorage.feeReceiver`. The operator is paid nothing.
//   (b) `MAX_FEE_RATE_BPS = 500` (5%). A maker UI-manipulated into signing
//       `feeRateBps = 500` is bound by it — recommended reduction to ~1%.
//
// This pentest asserts the on-chain truth that contradicts (a) and quantifies
// the maximum extractable fee under (b). No code change is needed for the
// test to pass — the fix is doc-and-policy. After the doc fix lands and (if
// adopted) the cap is lowered to 100, the second test's expected value
// should change to ~1%.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupAuditFixture } = require("../utils/auditFixture.js");

const MAX_FEE_RATE_BPS = 500; // 5 % — the current cap in SettlementFacet

function computeExpectedFee(feeRateBps, price, amount, unit) {
  const complementPrice = unit.sub(price);
  const effectivePrice = price.lt(complementPrice) ? price : complementPrice;
  return effectivePrice.mul(amount).mul(feeRateBps).div(unit.mul(10000));
}

describe("PENTEST · SEC-006 (MED) — fee recipient and cap", function () {
  let ctx;

  before(async function () {
    ctx = await setupAuditFixture();
  });

  it("DEMONSTRATES (a) — fees go to feeReceiver, NOT the operator (contradicts CLAUDE.md)", async function () {
    const { settlement, collateral } = ctx.contracts;
    const { buyer, seller, operator, feeReceiver } = ctx.signers;
    const { positionIdA } = ctx.market;
    const { UNIT, FEE_BPS } = ctx.constants;
    const { makeOrder, signOrder } = ctx.helpers;

    const fillAmount = ethers.utils.parseUnits("100", 6);
    const price = UNIT.div(2);

    const takerOrder = makeOrder(buyer.address,  positionIdA, 0, fillAmount, price, { salt: 93001 });
    const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, { salt: 93001 });
    const takerSig = await signOrder(buyer,  takerOrder);
    const makerSig = await signOrder(seller, makerOrder);

    const feeRcvBefore = await collateral.balanceOf(feeReceiver.address);
    const operatorColBefore = await collateral.balanceOf(operator.address);

    await settlement.connect(operator).matchOrders(
      takerOrder, takerSig, 0,
      [makerOrder], [makerSig], [0],
      fillAmount, [fillAmount],
    );

    const feeRcvAfter = await collateral.balanceOf(feeReceiver.address);
    const operatorColAfter = await collateral.balanceOf(operator.address);

    const expectedFeePerLeg = computeExpectedFee(FEE_BPS, price, fillAmount, UNIT);

    // Complementary settlement charges BOTH the buyer's and the seller's fee
    // — `feeReceiver` receives `2 * expectedFeePerLeg`.
    const feeReceiverDelta = feeRcvAfter.sub(feeRcvBefore);
    expect(feeReceiverDelta).to.equal(expectedFeePerLeg.mul(2));

    // The operator's collateral balance must NOT have grown by any fee. (It
    // is unchanged in a complementary match — the operator is just the
    // submitter, never a counterparty.)
    expect(operatorColAfter).to.equal(operatorColBefore);
  });

  it("DEMONSTRATES (b) — `feeRateBps = 500` (the cap) is honoured: a maker signing 5% pays 5% of effective notional", async function () {
    const { settlement, collateral } = ctx.contracts;
    const { buyer, seller, operator, feeReceiver } = ctx.signers;
    const { positionIdA } = ctx.market;
    const { UNIT } = ctx.constants;
    const { makeOrder, signOrder } = ctx.helpers;

    const fillAmount = ethers.utils.parseUnits("100", 6);
    const price = UNIT.div(2);

    const takerOrder = makeOrder(buyer.address,  positionIdA, 0, fillAmount, price, {
      salt: 93002, feeRateBps: MAX_FEE_RATE_BPS,
    });
    const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, {
      salt: 93002, feeRateBps: MAX_FEE_RATE_BPS,
    });
    const takerSig = await signOrder(buyer,  takerOrder);
    const makerSig = await signOrder(seller, makerOrder);

    const feeRcvBefore = await collateral.balanceOf(feeReceiver.address);

    await settlement.connect(operator).matchOrders(
      takerOrder, takerSig, 0,
      [makerOrder], [makerSig], [0],
      fillAmount, [fillAmount],
    );

    const feeRcvAfter = await collateral.balanceOf(feeReceiver.address);
    const expectedFeePerLeg = computeExpectedFee(MAX_FEE_RATE_BPS, price, fillAmount, UNIT);

    // 5% * min(0.5, 0.5) * 100 = 5% * 50 = 2.5 per leg × 2 legs = 5 USDC.
    const feeReceiverDelta = feeRcvAfter.sub(feeRcvBefore);
    expect(feeReceiverDelta).to.equal(expectedFeePerLeg.mul(2));
    expect(feeReceiverDelta).to.equal(ethers.utils.parseUnits("5", 6)); // sanity
  });

  it("CAP — feeRateBps > MAX_FEE_RATE_BPS reverts FeeTooHigh", async function () {
    const { settlement } = ctx.contracts;
    const { buyer, seller, operator } = ctx.signers;
    const { positionIdA } = ctx.market;
    const { UNIT } = ctx.constants;
    const { makeOrder, signOrder } = ctx.helpers;

    const fillAmount = ethers.utils.parseUnits("100", 6);
    const price = UNIT.div(2);

    const takerOrder = makeOrder(buyer.address,  positionIdA, 0, fillAmount, price, {
      salt: 93003, feeRateBps: MAX_FEE_RATE_BPS + 1,
    });
    const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, {
      salt: 93003, feeRateBps: 0,
    });
    const takerSig = await signOrder(buyer,  takerOrder);
    const makerSig = await signOrder(seller, makerOrder);

    await expect(
      settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fillAmount, [fillAmount],
      ),
    ).to.be.reverted; // FeeTooHigh
  });
});
