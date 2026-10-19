// PENTEST · ORC-004 (HIGH) — BlockCount questions cannot resolve correctly: the exact-second
// timestamp lookup reverts (freezing the oracle), and the 600 s bucket gate skips questions
// (never resolved, collateral locked)
// ----------------------------------------------------------------------------
// STATUS: FIXED (SCRUM-214) — BlockCount creation reverts OracleAdapter_QuestionTypeDisabled
// (ConditionManagerFacet); pre-fix text kept below. Was: NOT YET FIXED — the `DEMONSTRATES` tests assert today's behaviour and must be
// flipped by the fix commit (the review's immediate fix rejects BlockCount at creation).
//
// Failure scenario (no attacker needed; any miner can additionally bias it)
//
//   (a) Lookup. When a header's timestamp first reaches a question's `endTimestamp` inside
//       its 600 s bucket, `_resolveBlockCountQuestion` maps start/end timestamps to heights
//       through `timestampToBlockHeight`, which is keyed by EXACT block timestamps. It tries
//       only 21 keys, target ± 60·k s for k ≤ 10 (±10 min; the comment says ±100 min). A real
//       block matches only if its offset from the target is a multiple of 60 s (~3%). On a miss
//       it reverts `OracleAdapter_BlockNotFoundForTimestamp` INSIDE header acceptance, so the
//       canonical header is rejected forever and the oracle freezes for every market.
//   (b) Trigger. A question is examined only when the current header's timestamp falls in the
//       SAME 600 s bucket as `endTimestamp` and is ≥ it: a window [end, bucketStart+600) of at
//       most 600 s. Bitcoin blocks skip such a window with probability ≥ e^-1 ≈ 37%; the
//       question is never examined again, never resolves, and its collateral stays locked.
//
// Root cause
//
//   contracts/libraries/LibOracleAdapter.sol:89-120 (registration under bucket(end)),
//   :229-247 (only the current header's bucket is examined), :299-330 (lookups :303-312),
//   :414-441 (`_findBlockByTimestamp`: 21 exact-second probes, revert on miss).
//
// Impact
//
//   Every BlockCount market either never resolves or, once triggered, freezes the oracle.
//
// Setup: synthetic regtest-style chain whose tip is just behind the EVM clock; questions are
// anchored at a 600 s-aligned time A in the EVM future (validation requires start > now) and
// headers are submitted with the EVM clock advanced to each header's timestamp, so no header
// is ever ahead of chain time. For (a) every header timestamp is ≡ 30 (mod 60) while the
// question's timestamps are ≡ 0 (mod 60), making the miss deterministic.
//
// The fix disables BlockCount creation, so the tests below show creation is refused and the
// header sequences that used to freeze or strand the oracle now pass straight through.

const { expect } = require("chai");
const sc = require("../utils/syntheticChain.js");
const { isolateChainState } = require("../utils/oracleAuditFixture.js");
const {
  snapshotFixture,
  deployOracleAuditDiamond,
  initSyntheticOracle,
  createBlockCount,
  submitEach,
  evmNow,
  advanceEvmTimeTo,
} = require("../utils/oracleAuditFixture.js");

const BUCKET = sc.TIMESTAMP_BUCKET; // 600
const COUNT_BUCKETS = [5, 10, 15];

const load = snapshotFixture(async () => {
  const ctx = await deployOracleAuditDiamond();
  const now = await evmNow();
  const init = await initSyntheticOracle(ctx, { startTimestamp: now - 18 * sc.TARGET_SPACING });
  const tip = init[init.length - 1];
  const anchor = Math.ceil((now + 3600) / BUCKET) * BUCKET; // A: bucket-aligned, ≥ 1 h in the EVM future
  return { ...ctx, init, tip, anchor };
});

/** Headers on top of `parent` with exactly the given timestamps. */
function withTimestamps(parent, timestamps, tag) {
  const out = [];
  let prev = parent;
  for (const timestamp of timestamps) {
    prev = sc.nextHeader(prev, { timestamp, tag });
    out.push(prev);
  }
  return out;
}

/** Timestamps lastTs - k·600, …, lastTs: every step strictly after `afterTs`. */
function approach(afterTs, lastTs, step = sc.TARGET_SPACING) {
  const out = [];
  for (let t = lastTs; t > afterTs; t -= step) out.unshift(t);
  return out;
}

describe("PENTEST · ORC-004 (HIGH) — BlockCount: lookup revert freezes the oracle; bucket gate skips questions", function () {
  this.timeout(300_000);
  isolateChainState();

  describe("(a) exact-second timestamp lookup", function () {
    // start = A, end = A + 6120 → bucket(end) = A + 6000, trigger window [A+6120, A+6600).
    function lookupMissChain(ctx) {
      const triggerTs = ctx.anchor + 6150; // ≡ 30 (mod 60): never on a probed second
      const chain = withTimestamps(ctx.tip, approach(ctx.tip.timestamp, triggerTs + 600), "orc004a");
      return { chain, trigger: chain.findIndex((h) => h.timestamp === triggerTs) };
    }

    it("ATTACK BLOCKED — creating a BlockCount market reverts OracleAdapter_QuestionTypeDisabled; nothing is registered", async function () {
      const ctx = await load();
      const start = ctx.anchor;
      const end = ctx.anchor + 6000 + 120;
      await expect(createBlockCount(ctx, start, end, COUNT_BUCKETS)).to.be.revertedWith("OracleAdapter_QuestionTypeDisabled()");
      expect((await ctx.oracleAdapter.getBlockCountQuestionsAtTimestamp(end)).length).to.equal(0);
      expect(await ctx.oracleAdapter.getTotalQuestionsCreated()).to.equal(0);
    });

    it("FIX VERIFIED — the header sequence that used to freeze the oracle (trigger + next, single and batch) is accepted", async function () {
      const ctx = await load();
      const { chain, trigger } = lookupMissChain(ctx);
      await submitEach(ctx, chain.slice(0, trigger));
      await advanceEvmTimeTo(chain[trigger + 1].timestamp);
      await ctx.oracle.submitBatchBlocks(chain.slice(trigger, trigger + 2).map(sc.toContract));
      expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(chain[trigger + 1].blockNumber);
    });
  });

  describe("(b) 600 s bucket gate", function () {
    it("ATTACK BLOCKED — no BlockCount question can be stranded: creation is refused and the bucket-skipping chain is accepted", async function () {
      const ctx = await load();
      const end = ctx.anchor + 6000 + 300;
      await expect(createBlockCount(ctx, ctx.anchor, end, COUNT_BUCKETS)).to.be.revertedWith("OracleAdapter_QuestionTypeDisabled()");

      const lastBefore = end - 10;
      const chain = withTimestamps(ctx.tip, approach(ctx.tip.timestamp, lastBefore + 6 * sc.TARGET_SPACING), "orc004b");
      await submitEach(ctx, chain);
      expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(chain[chain.length - 1].blockNumber);
      expect((await ctx.oracleAdapter.getBlockCountQuestionsAtTimestamp(end)).length).to.equal(0);
    });
  });
});
