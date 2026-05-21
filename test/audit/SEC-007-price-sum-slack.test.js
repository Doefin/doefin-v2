// PENTEST · SEC-007 (MED, defer) — Mint/Merge crossing checks allow off-`unit`
// price sums (intentional price improvement vs unfair settlement)
// ----------------------------------------------------------------------------
// STATUS: NOT YET FIXED — pending team confirmation that the slack is
// intentional. SCRUM-121's "effective price = unit − P_m" makes the slack
// plausibly deliberate. If confirmed intentional → downgrade to LOW/info
// + NatSpec. If not → tighten the crossing checks at lines 476 / 567 from
// `<` / `>` to `!=` (require sum == unit exactly).
//
// What the checks do today
//
//   _settleMint  (line 476): `if (P_t + P_m  < unit) revert InvalidMatch();`
//   _settleMerge (line 567): `if (P_t + P_m  > unit) revert InvalidMatch();`
//
//   So Mint accepts any sum ≥ unit (over-collateralised relative to the
//   signed prices); Merge accepts any sum ≤ unit. Off-`unit` sums settle.
//
// Why fuzzing didn't find this
//
//   The remainder construction at lines 480 (mint) and 571 (merge):
//      takerCollateral = fill − makerCollateral
//      takerPayout     = fill − makerPayout
//   keeps Diamond solvency a STRUCTURAL identity (in == out == fill). Both
//   `echidna_collateral_conserved` and `echidna_diamond_solvent` pass under
//   any combination of P_t / P_m. The remaining freedom — how `fill`
//   collateral is split between the two parties — is price *fairness*, not
//   solvency.
//
// What this pentest covers
//
//   We construct off-`unit` matched orders that SHOULD revert under a
//   strict `!=` rule, and assert the contract accepts them today. After a
//   tightening fix the assertions will flip (the matchOrders calls will
//   revert), making these tests fail — which is the post-fix signal.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupAuditFixture } = require("../utils/auditFixture.js");

describe("PENTEST · SEC-007 (MED, defer) — off-`unit` price-sum slack", function () {
  let ctx;
  const fillAmount = ethers.utils.parseUnits("100", 6);

  before(async function () {
    ctx = await setupAuditFixture();
  });

  it("DEMONSTRATES — Mint accepts P_t + P_m > unit (taker pays more than their share of `unit`)", async function () {
    // Both BUY orders, complement positions ⇒ Mint path.
    // P_t = 0.7·unit, P_m = 0.4·unit, sum = 1.1·unit ⇒ over-`unit`.
    // Today this settles cleanly. Under a strict `==` rule it would revert.
    const { settlement, erc1155Facet } = ctx.contracts;
    const { buyer, buyerB, operator } = ctx.signers;
    const { positionIdA, positionIdB } = ctx.market;
    const { UNIT } = ctx.constants;
    const { makeOrder, signOrder } = ctx.helpers;

    const P_t = UNIT.mul(7).div(10);   // 0.7e6
    const P_m = UNIT.mul(4).div(10);   // 0.4e6

    const takerOrder = makeOrder(buyer.address,  positionIdA, 0 /* BUY */, fillAmount, P_t, { salt: 94001 });
    const makerOrder = makeOrder(buyerB.address, positionIdB, 0 /* BUY */, fillAmount, P_m, { salt: 94001 });
    const takerSig = await signOrder(buyer,  takerOrder);
    const makerSig = await signOrder(buyerB, makerOrder);

    const takerPosBefore = await erc1155Facet.balanceOf(buyer.address,  positionIdA);
    const makerPosBefore = await erc1155Facet.balanceOf(buyerB.address, positionIdB);

    // sum = 1.1*unit > unit ⇒ slack permitted (only sum < unit reverts).
    await settlement.connect(operator).matchOrders(
      takerOrder, takerSig, 0,
      [makerOrder], [makerSig], [0],
      fillAmount, [fillAmount], [0], [0],
    );

    // Each buyer GAINED `fill` of their respective positions — assert deltas
    // so the test is robust against any pre-existing inventory the fixture
    // happens to leave in place.
    const takerPosAfter = await erc1155Facet.balanceOf(buyer.address,  positionIdA);
    const makerPosAfter = await erc1155Facet.balanceOf(buyerB.address, positionIdB);
    expect(takerPosAfter.sub(takerPosBefore)).to.equal(fillAmount);
    expect(makerPosAfter.sub(makerPosBefore)).to.equal(fillAmount);
    // The remainder math made each pay their share of `fill` (not their
    // signed prices) — taker paid `fill - (P_m * fill / unit)` = 60e6,
    // maker paid `(P_m * fill / unit)` = 40e6. Maker's signed P_m IS
    // honoured; taker pays the complement. Solvency intact.
  });

  it("DEMONSTRATES — Merge accepts P_t + P_m < unit (taker receives more than their share of `unit`)", async function () {
    // Both SELL orders, complement positions ⇒ Merge path.
    // P_t = 0.5·unit, P_m = 0.3·unit, sum = 0.8·unit ⇒ under-`unit`.
    // Today this settles; the taker receives `fill - makerPayout` and
    // benefits over their signed P_t.
    const { settlement, conditionalTokens, collateral } = ctx.contracts;
    const { conditionId } = ctx.market;
    const { buyer, seller, operator } = ctx.signers;
    const { positionIdA, positionIdB } = ctx.market;
    const { UNIT } = ctx.constants;
    const { makeOrder, signOrder } = ctx.helpers;

    // Set up the sellers so they each own the position they will SELL.
    // The fixture gave `seller` positionA inventory; we need a second
    // actor with positionB inventory. Use `buyer` as the positionB seller
    // here: split fresh collateral to give them tokens.
    const setupAmount = ethers.utils.parseUnits("200", 6);
    await collateral.connect(buyer).approve(ctx.diamondAddress, ethers.constants.MaxUint256);
    await conditionalTokens.connect(buyer).splitPosition(
      collateral.address,
      ethers.constants.HashZero,
      conditionId,
      [1, 2],
      setupAmount,
    );
    // After split, buyer holds setupAmount of positionA AND positionB. We
    // only need positionB for the SELL leg here.

    const P_t = UNIT.div(2);            // 0.5e6
    const P_m = UNIT.mul(3).div(10);    // 0.3e6

    const takerOrder = makeOrder(seller.address, positionIdA, 1 /* SELL */, fillAmount, P_t, { salt: 94002 });
    const makerOrder = makeOrder(buyer.address,  positionIdB, 1 /* SELL */, fillAmount, P_m, { salt: 94002 });
    const takerSig = await signOrder(seller, takerOrder);
    const makerSig = await signOrder(buyer,  makerOrder);

    const takerColBefore = await collateral.balanceOf(seller.address);

    await settlement.connect(operator).matchOrders(
      takerOrder, takerSig, 0,
      [makerOrder], [makerSig], [0],
      fillAmount, [fillAmount], [0], [0],
    );

    const takerColAfter = await collateral.balanceOf(seller.address);
    const takerPayout = takerColAfter.sub(takerColBefore);

    // SCRUM-224: the operator supplied a zero fee for this leg, so the taker's
    // net payout equals their gross payout.
    const takerFee = ethers.BigNumber.from(0);

    // Signed/net (what the taker thought they'd receive after fees):
    //   signed_gross  = P_t * fill / unit                       = 50e6
    //   signed_net    = signed_gross - takerFee
    // Actual/net (the slack pays them the complement of P_m, post-fee):
    //   actual_gross  = fill - makerPayout = fill - P_m*fill/unit = 70e6
    //   actual_net    = actual_gross - takerFee
    const signedGross = P_t.mul(fillAmount).div(UNIT);
    const signedNet = signedGross.sub(takerFee);
    const actualGross = fillAmount.sub(P_m.mul(fillAmount).div(UNIT));
    const actualNet = actualGross.sub(takerFee);

    expect(takerPayout).to.equal(actualNet);

    // Slack benefit: the taker received MORE collateral than the price they
    // signed (P_t) would imply. With sum = 0.8·unit and fill = 100, the
    // benefit is fill * (unit - P_t - P_m) / unit = 20e6.
    expect(takerPayout).to.be.gt(signedNet);
    expect(takerPayout.sub(signedNet)).to.equal(fillAmount.sub(P_t.mul(fillAmount).div(UNIT)).sub(P_m.mul(fillAmount).div(UNIT)));
  });

  it("CONTROL — sum exactly == unit settles (the in-rule case)", async function () {
    // Same Mint setup as test 1 but with P_t = 0.4·unit and P_m = 0.6·unit,
    // sum = unit. This is the "intended" matched-price case and settles
    // identically under either rule.
    const { settlement, erc1155Facet } = ctx.contracts;
    const { buyer, buyerB, operator } = ctx.signers;
    const { positionIdA, positionIdB } = ctx.market;
    const { UNIT } = ctx.constants;
    const { makeOrder, signOrder } = ctx.helpers;

    const P_t = UNIT.mul(4).div(10);
    const P_m = UNIT.mul(6).div(10);

    const takerOrder = makeOrder(buyer.address,  positionIdA, 0, fillAmount, P_t, { salt: 94003 });
    const makerOrder = makeOrder(buyerB.address, positionIdB, 0, fillAmount, P_m, { salt: 94003 });
    const takerSig = await signOrder(buyer,  takerOrder);
    const makerSig = await signOrder(buyerB, makerOrder);

    await settlement.connect(operator).matchOrders(
      takerOrder, takerSig, 0,
      [makerOrder], [makerSig], [0],
      fillAmount, [fillAmount], [0], [0],
    );

    // (Deltas asserted in test 1; here we only need the matchOrders to settle
    // cleanly — the gte check would re-include any pre-existing inventory.)
  });

  it("BOUND — Mint REVERTS when sum < unit (under-collateralisation would otherwise occur)", async function () {
    // The single bound the contract currently enforces: sum must be ≥ unit
    // for Mint. Below unit, both buyers' total payment would be less than
    // the minted `fill` of each position, breaking solvency. The check at
    // line 476 catches this.
    const { settlement } = ctx.contracts;
    const { buyer, buyerB, operator } = ctx.signers;
    const { positionIdA, positionIdB } = ctx.market;
    const { UNIT } = ctx.constants;
    const { makeOrder, signOrder } = ctx.helpers;

    const P_t = UNIT.mul(3).div(10);    // 0.3
    const P_m = UNIT.mul(4).div(10);    // 0.4   ⇒ sum 0.7 < unit
    const takerOrder = makeOrder(buyer.address,  positionIdA, 0, fillAmount, P_t, { salt: 94004 });
    const makerOrder = makeOrder(buyerB.address, positionIdB, 0, fillAmount, P_m, { salt: 94004 });
    const takerSig = await signOrder(buyer,  takerOrder);
    const makerSig = await signOrder(buyerB, makerOrder);

    await expect(
      settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fillAmount, [fillAmount], [0], [0],
      ),
    ).to.be.reverted; // InvalidMatch — preserves solvency
  });
});
