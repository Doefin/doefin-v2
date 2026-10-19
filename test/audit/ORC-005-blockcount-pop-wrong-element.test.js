// PENTEST · ORC-005 (MEDIUM) — `_resolveConditionsAtTimestamp` pops the LAST array element,
// not the one it just resolved: one question is lost, and the resolved one stays behind to be
// resolved again, which reverts and freezes the oracle
// ----------------------------------------------------------------------------
// STATUS: NOT YET FIXED — the `DEMONSTRATES` tests assert today's behaviour and must be
// flipped by the fix commit (swap-and-pop, or BlockCount creation disabled with ORC-004).
//
// Failure scenario (no attacker needed)
//
//   Two BlockCount questions share the 600 s bucket B: Q0 (end B+300) then Q1 (end B+500).
//   A header at B+360 walks the bucket array downward: Q1 (index 1) is not yet due and is
//   skipped; Q0 (index 0) is due, is resolved, and then `pop()` removes index 1 — Q1.
//     - Q1 is gone without ever being resolved (its collateral stays locked).
//     - Q0 is still in the array. The next header in [B+300, B+600) resolves it again;
//       `_reportPayouts` reverts `ConditionAlreadyResolved`, inside header acceptance, so the
//       canonical header is rejected and the oracle freezes.
//
// Root cause
//
//   contracts/libraries/LibOracleAdapter.sol:238-245 — `blockCountQuestions.pop()` after
//   resolving `blockCountQuestions[i - 1]`; LibCTFCondition.sol:224-226 (ConditionAlreadyResolved).
//
// Impact
//
//   A market silently loses its resolution, and a second route to an oracle freeze. Breaks
//   INV-ORC-4 (resolved + pending == created).
//
// Isolation from ORC-004(a): the timestamp lookups are made to HIT — one header sits exactly
// at the questions' start timestamp, and the trigger header sits exactly 60 s after Q0's end
// (the first key `_findBlockByTimestamp` probes). Every header is accepted on its own merits.
//
// No CONTROL here (see ORC-004: the immediate fix disables BlockCount creation).

const { expect } = require("chai");
const sc = require("../utils/syntheticChain.js");
const {
  snapshotFixture,
  deployOracleAuditDiamond,
  initSyntheticOracle,
  createBlockCount,
  payouts,
  submitEach,
  evmNow,
  advanceEvmTimeTo,
} = require("../utils/oracleAuditFixture.js");

const BUCKET = sc.TIMESTAMP_BUCKET;
const COUNT_BUCKETS = [5, 10, 15]; // outcomes: <5, 5–9, 10–14, ≥15

const load = snapshotFixture(async () => {
  const ctx = await deployOracleAuditDiamond();
  const now = await evmNow();
  const init = await initSyntheticOracle(ctx, { startTimestamp: now - 18 * sc.TARGET_SPACING });
  const tip = init[init.length - 1];
  const A = Math.ceil((now + 3600) / BUCKET) * BUCKET; // shared start timestamp, in the EVM future
  const B = A + 6000; // the shared bucket

  const q0 = await createBlockCount(ctx, A, B + 300, COUNT_BUCKETS, { salt: sc.merkleFor("orc005", 0) });
  const q1 = await createBlockCount(ctx, A, B + 500, COUNT_BUCKETS, { salt: sc.merkleFor("orc005", 1) });

  // A-k·600 … A (exact start hit) … B (in the bucket, before either end), B+360 (trigger), B+420.
  const timestamps = [];
  for (let t = A; t > tip.timestamp; t -= sc.TARGET_SPACING) timestamps.unshift(t);
  for (let t = A + sc.TARGET_SPACING; t <= B; t += sc.TARGET_SPACING) timestamps.push(t);
  timestamps.push(B + 360, B + 420);
  const chain = [];
  let prev = tip;
  for (const timestamp of timestamps) {
    prev = sc.nextHeader(prev, { timestamp, tag: "orc005" });
    chain.push(prev);
  }
  const startIdx = chain.findIndex((h) => h.timestamp === A);
  const triggerIdx = chain.findIndex((h) => h.timestamp === B + 360);
  return { ...ctx, A, B, q0, q1, chain, startIdx, triggerIdx };
});

describe("PENTEST · ORC-005 (MEDIUM) — BlockCount bucket pop() removes the wrong question", function () {
  this.timeout(300_000);

  async function upToTrigger() {
    const ctx = await load();
    // Both questions sit in the same bucket, Q0 first.
    const before = await ctx.oracleAdapter.getBlockCountQuestionsAtTimestamp(ctx.B);
    expect(before.map((q) => q.questionId)).to.deep.equal([ctx.q0.questionId, ctx.q1.questionId]);

    await submitEach(ctx, ctx.chain.slice(0, ctx.triggerIdx + 1)); // includes the trigger at B+360
    return ctx;
  }

  it("DEMONSTRATES — the header at B+360 resolves Q0 (due) but pops Q1 (not yet due): Q1 is lost, Q0 stays in the bucket", async function () {
    const ctx = await upToTrigger();

    // Q0 resolved correctly: 11 blocks from the start header to the trigger → outcome "10–14".
    expect(ctx.triggerIdx - ctx.startIdx).to.equal(11);
    expect(await payouts(ctx, ctx.q0.conditionId)).to.deep.equal([0, 0, 1, 0]);
    // Q1 was removed without being resolved...
    expect(await payouts(ctx, ctx.q1.conditionId)).to.deep.equal([0, 0, 0, 0]);
    // ...and the already-resolved Q0 is the one left behind.
    const after = await ctx.oracleAdapter.getBlockCountQuestionsAtTimestamp(ctx.B);
    expect(after.map((q) => q.questionId)).to.deep.equal([ctx.q0.questionId]);
    // INV-ORC-4 broken: created 2 = resolved 1 + genuinely pending 0.
    expect(await ctx.oracleAdapter.getTotalQuestionsCreated()).to.equal(2);
    expect(await ctx.oracleAdapter.getTotalQuestionsResolved()).to.equal(1);
  });

  it("DEMONSTRATES — the next header in the bucket (B+420) re-resolves Q0 and reverts ConditionAlreadyResolved: the oracle freezes", async function () {
    const ctx = await upToTrigger();
    const next = ctx.chain[ctx.triggerIdx + 1];
    expect(next.timestamp).to.equal(ctx.B + 420);
    await advanceEvmTimeTo(next.timestamp);

    await expect(ctx.oracle.submitNextBlock(sc.toContract(next))).to.be.revertedWith("ConditionAlreadyResolved()");

    // Any other header there (e.g. one at B+540, past Q1's end) hits the same stale Q0 first.
    const sibling = sc.nextHeader(ctx.chain[ctx.triggerIdx], { timestamp: ctx.B + 540, tag: "orc005-sibling" });
    await advanceEvmTimeTo(sibling.timestamp);
    await expect(ctx.oracle.submitNextBlock(sc.toContract(sibling))).to.be.revertedWith("ConditionAlreadyResolved()");

    expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(ctx.chain[ctx.triggerIdx].blockNumber);
    expect(await payouts(ctx, ctx.q1.conditionId)).to.deep.equal([0, 0, 0, 0]); // Q1 can never resolve
  });
});
