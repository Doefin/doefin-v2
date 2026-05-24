// SCRUM-235 — Cancelled / resolved condition settlement-order validation
// ============================================================================
// Closes the missing-invariant finding surfaced by the SCRUM-234 dead-code
// review (see `audit/findings/manual-review-dead-code-A2-A3to6.md`):
// `SettlementFacet._validateOrder` previously checked the order's signature,
// nonce, salt, expiration, side, collateral allow-list, unit and price — but
// NOT the **state of the CTF condition** the order's positionId belongs to.
//
// Without the gate a compromised operator could:
//   (1) route still-validly-signed orders against a CANCELLED market
//       (`Condition.active == false` after `ConditionManagerFacet.cancelCondition`)
//       and drain buyers' collateral in exchange for position tokens that no
//       longer represent any settleable claim;
//   (2) settle losers' open orders POST-RESOLUTION (after `_reportPayouts`
//       set `payoutDenominator != 0`) at their pre-resolution prices, before
//       the losing side has a chance to cancel.
//
// The fix wires `LibCTFCondition.enforceConditionIsActive(conditionId)` and a
// `payoutDenominator[conditionId] == 0` guard into `_validateOrder`, where
// `conditionId` is derived from `positionRegistry.conditionIdByPositionId
// [order.positionId]` (the same lookup `_conditionAndPartition` already uses).
//
// The gate runs in `_validateOrder` so it fires for matchOrders AND fillOrder,
// and for the taker leg AND every maker leg, regardless of the eventual
// settlement path (Complementary / Mint / Merge).

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupAuditFixture } = require("../utils/auditFixture.js");

// The fixture creates the binary condition with this questionId (oracle = owner).
const FIXTURE_QUESTION_ID = ethers.utils.formatBytes32String("audit-pentest-q1");

describe("SCRUM-235 — settlement rejects cancelled / resolved conditions", function () {
  let ctx;

  beforeEach(async function () {
    ctx = await setupAuditFixture();
  });

  // Build a valid 1-taker / 1-maker complementary pair against the fixture's
  // active+unresolved condition. The orders are valid at sign time; what
  // changes between the cases below is the on-chain CONDITION STATE.
  async function complementaryPair(salt) {
    const { buyer, seller } = ctx.signers;
    const { positionIdA } = ctx.market;
    const { UNIT } = ctx.constants;
    const { makeOrder, signOrder } = ctx.helpers;

    const fill = ethers.utils.parseUnits("100", 6);
    const price = UNIT.div(2);
    const takerOrder = makeOrder(buyer.address, positionIdA, 0, fill, price, { salt });
    const makerOrder = makeOrder(seller.address, positionIdA, 1, fill, price, { salt });
    return {
      takerOrder,
      takerSig: await signOrder(buyer, takerOrder),
      makerOrder,
      makerSig: await signOrder(seller, makerOrder),
      fill,
    };
  }

  async function singleBuyOrder(salt) {
    const { buyer } = ctx.signers;
    const { positionIdA } = ctx.market;
    const { UNIT } = ctx.constants;
    const { makeOrder, signOrder } = ctx.helpers;

    const fill = ethers.utils.parseUnits("50", 6);
    const price = UNIT.div(2);
    const order = makeOrder(buyer.address, positionIdA, 0, fill, price, { salt });
    return { order, sig: await signOrder(buyer, order), fill };
  }

  // ──────────────────────────────────────────────────────────────────────
  // Attack 1 — cancelled condition
  // ──────────────────────────────────────────────────────────────────────
  describe("cancelled condition (Condition.active == false)", function () {
    it("matchOrders reverts ConditionNotActive once cancelCondition has run", async function () {
      const { settlement, conditionMgr } = ctx.contracts;
      const { owner, operator } = ctx.signers;
      const { conditionId } = ctx.market;
      const a = await complementaryPair(101001);

      // Pre-attack baseline — orders are signed BEFORE the cancellation, exactly
      // the worst-case operator-as-attacker scenario.
      await conditionMgr.connect(owner).cancelCondition(conditionId);

      await expect(
        settlement.connect(operator).matchOrders(
          a.takerOrder, a.takerSig, 0,
          [a.makerOrder], [a.makerSig], [0],
          a.fill, [a.fill], [0], [0],
        ),
      ).to.be.revertedWith("ConditionNotActive()");
    });

    it("fillOrder reverts ConditionNotActive once cancelCondition has run", async function () {
      const { settlement, conditionMgr } = ctx.contracts;
      const { owner, operator } = ctx.signers;
      const { conditionId } = ctx.market;
      const o = await singleBuyOrder(101002);

      await conditionMgr.connect(owner).cancelCondition(conditionId);

      await expect(
        settlement.connect(operator).fillOrder(o.order, o.sig, 0, o.fill, 0),
      ).to.be.revertedWith("ConditionNotActive()");
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Attack 2 — resolved condition (payoutDenominator != 0)
  // ──────────────────────────────────────────────────────────────────────
  describe("resolved condition (payoutDenominator != 0)", function () {
    it("matchOrders reverts ConditionAlreadyResolved once reportPayouts has run", async function () {
      const { settlement, conditionalTokens } = ctx.contracts;
      const { owner, operator } = ctx.signers;
      const a = await complementaryPair(102001);

      // owner is the fixture's oracle; report a YES outcome.
      await conditionalTokens.connect(owner).reportPayouts(FIXTURE_QUESTION_ID, [1, 0]);

      await expect(
        settlement.connect(operator).matchOrders(
          a.takerOrder, a.takerSig, 0,
          [a.makerOrder], [a.makerSig], [0],
          a.fill, [a.fill], [0], [0],
        ),
      ).to.be.revertedWith("ConditionAlreadyResolved()");
    });

    it("fillOrder reverts ConditionAlreadyResolved once reportPayouts has run", async function () {
      const { settlement, conditionalTokens } = ctx.contracts;
      const { owner, operator } = ctx.signers;
      const o = await singleBuyOrder(102002);

      await conditionalTokens.connect(owner).reportPayouts(FIXTURE_QUESTION_ID, [1, 0]);

      await expect(
        settlement.connect(operator).fillOrder(o.order, o.sig, 0, o.fill, 0),
      ).to.be.revertedWith("ConditionAlreadyResolved()");
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Control — the gate does NOT mis-fire on the active + unresolved state
  // ──────────────────────────────────────────────────────────────────────
  describe("CONTROL — active + unresolved condition still settles", function () {
    it("matchOrders settles normally when the condition is active and unresolved", async function () {
      const { settlement } = ctx.contracts;
      const { operator } = ctx.signers;
      const a = await complementaryPair(103001);

      // No cancel, no resolve — the gate is in the "skip" path and the orders
      // settle through `_settleComplementary`.
      await settlement.connect(operator).matchOrders(
        a.takerOrder, a.takerSig, 0,
        [a.makerOrder], [a.makerSig], [0],
        a.fill, [a.fill], [0], [0],
      );
    });
  });
});
