// PENTEST · SEC-006 (MED) — fee recipient & cap mechanics
// ----------------------------------------------------------------------------
// STATUS: ADDRESSED by SCRUM-224 (operator-supplied fee model).
//
// The original audit found two issues bundled here:
//   (a) Stale doc claiming "Operator is the fee recipient" — every fee transfer
//       in `SettlementFacet` targets `ds.adminConfigStorage.feeReceiver`. The
//       operator is paid nothing.
//   (b) A maker UI-manipulated into signing a high `feeRateBps` was bound only
//       by a contract constant.
//
// SCRUM-224 removed the maker-signed `feeRateBps` entirely. The operator now
// supplies the fee amount at settlement, and the contract enforces an
// admin-settable maximum rate (`maxFeeRateBps`) plus a `fee <= proceeds` bound.
// This pentest now asserts the post-fix on-chain truth:
//   - fees still flow to `feeReceiver`, never the operator;
//   - an operator fee within the admin cap settles;
//   - an operator fee above the admin cap reverts FeeExceedsMaxRate.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupAuditFixture } = require("../utils/auditFixture.js");

describe("PENTEST · SEC-006 (MED) — fee recipient and operator fee cap", function () {
  let ctx;

  before(async function () {
    ctx = await setupAuditFixture();
  });

  it("DEMONSTRATES (a) — fees go to feeReceiver, NOT the operator", async function () {
    const { settlement, collateral } = ctx.contracts;
    const { buyer, seller, operator, feeReceiver } = ctx.signers;
    const { positionIdA } = ctx.market;
    const { UNIT } = ctx.constants;
    const { makeOrder, signOrder, legFee } = ctx.helpers;

    const fillAmount = ethers.utils.parseUnits("100", 6);
    const price = UNIT.div(2);

    const takerOrder = makeOrder(buyer.address,  positionIdA, 0, fillAmount, price, { salt: 93001 });
    const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, { salt: 93001 });
    const takerSig = await signOrder(buyer,  takerOrder);
    const makerSig = await signOrder(seller, makerOrder);

    // Operator-supplied per-leg fee, sized within the admin cap.
    const fee = legFee(price, fillAmount);

    const feeRcvBefore = await collateral.balanceOf(feeReceiver.address);
    const operatorColBefore = await collateral.balanceOf(operator.address);

    await settlement.connect(operator).matchOrders(
      takerOrder, takerSig, 0,
      [makerOrder], [makerSig], [0],
      fillAmount, [fillAmount], [fee], [fee],
    );

    // Complementary settlement charges BOTH the buyer's and the seller's fee
    // — `feeReceiver` receives `2 * fee`.
    expect((await collateral.balanceOf(feeReceiver.address)).sub(feeRcvBefore))
      .to.equal(fee.mul(2));

    // The operator's collateral balance must NOT have grown by any fee.
    expect(await collateral.balanceOf(operator.address)).to.equal(operatorColBefore);
  });

  it("CAP — an operator fee within `maxFeeRateBps` settles", async function () {
    const { settlement, collateral } = ctx.contracts;
    const { buyer, seller, operator, feeReceiver } = ctx.signers;
    const { positionIdA } = ctx.market;
    const { UNIT, MAX_FEE_RATE_BPS } = ctx.constants;
    const { makeOrder, signOrder } = ctx.helpers;

    const fillAmount = ethers.utils.parseUnits("100", 6);
    const price = UNIT.div(2);
    const cashValue = price.mul(fillAmount).div(UNIT);
    const feeAtCap = cashValue.mul(MAX_FEE_RATE_BPS).div(10000);

    const takerOrder = makeOrder(buyer.address,  positionIdA, 0, fillAmount, price, { salt: 93002 });
    const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, { salt: 93002 });
    const takerSig = await signOrder(buyer,  takerOrder);
    const makerSig = await signOrder(seller, makerOrder);

    const feeRcvBefore = await collateral.balanceOf(feeReceiver.address);

    await settlement.connect(operator).matchOrders(
      takerOrder, takerSig, 0,
      [makerOrder], [makerSig], [0],
      fillAmount, [fillAmount], [feeAtCap], [feeAtCap],
    );

    expect((await collateral.balanceOf(feeReceiver.address)).sub(feeRcvBefore))
      .to.equal(feeAtCap.mul(2));
  });

  it("CAP — an operator fee above `maxFeeRateBps` reverts FeeExceedsMaxRate", async function () {
    const { settlement } = ctx.contracts;
    const { buyer, seller, operator } = ctx.signers;
    const { positionIdA } = ctx.market;
    const { UNIT, MAX_FEE_RATE_BPS } = ctx.constants;
    const { makeOrder, signOrder } = ctx.helpers;

    const fillAmount = ethers.utils.parseUnits("100", 6);
    const price = UNIT.div(2);
    const cashValue = price.mul(fillAmount).div(UNIT);
    const overCap = cashValue.mul(MAX_FEE_RATE_BPS).div(10000).add(1);

    const takerOrder = makeOrder(buyer.address,  positionIdA, 0, fillAmount, price, { salt: 93003 });
    const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, { salt: 93003 });
    const takerSig = await signOrder(buyer,  takerOrder);
    const makerSig = await signOrder(seller, makerOrder);

    await expect(
      settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fillAmount, [fillAmount], [overCap], [0],
      ),
    ).to.be.revertedWith("FeeExceedsMaxRate()");
  });
});
