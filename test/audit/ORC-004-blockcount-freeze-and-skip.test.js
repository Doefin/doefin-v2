// PENTEST · ORC-004 (HIGH) — BlockCount questions cannot resolve correctly: the exact-second
// timestamp lookup reverts (freezing the oracle), and the 600 s bucket gate skips questions
// (never resolved, collateral locked)
// ----------------------------------------------------------------------------
// STATUS: NOT YET FIXED — the `DEMONSTRATES` tests assert today's behaviour and must be
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
// No CONTROL here: the review's immediate fix disables BlockCount creation, so no BlockCount
// behaviour is expected to survive the fix unchanged.

const { expect } = require("chai");
const sc = require("../utils/syntheticChain.js");
const { isolateChainState } = require("../utils/oracleAuditFixture.js");
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
    async function setupLookupMiss() {
      const ctx = await load();
      const start = ctx.anchor;
      const end = ctx.anchor + 6000 + 120;
      const { conditionId } = await createBlockCount(ctx, start, end, COUNT_BUCKETS);
      const triggerTs = ctx.anchor + 6150; // first header in [end, bucketStart+600); ≡ 30 (mod 60)
      const chain = withTimestamps(ctx.tip, approach(ctx.tip.timestamp, triggerTs + 600), "orc004a");
      const trigger = chain.findIndex((h) => h.timestamp === triggerTs);
      return { ctx, start, end, conditionId, chain, trigger };
    }

    it("DEMONSTRATES — no header timestamp lies at start ± 60·k s (k ≤ 10), so the triggering header reverts OracleAdapter_BlockNotFoundForTimestamp", async function () {
      const { ctx, start, end, chain, trigger } = await setupLookupMiss();
      // Precondition: every probed key misses, and only the trigger header enters the window.
      const probes = [start, ...Array.from({ length: 10 }, (_, i) => [start + 60 * (i + 1), start - 60 * (i + 1)]).flat()];
      expect(probes.length).to.equal(21);
      for (const h of chain) expect(probes.includes(h.timestamp)).to.equal(false);
      expect(chain.filter((h) => h.timestamp >= end && sc.timestampBucket(h.timestamp) === sc.timestampBucket(end)).length).to.equal(1);

      await submitEach(ctx, chain.slice(0, trigger)); // everything before the window: accepted
      const heightBefore = await ctx.oracle.getCurrentBlockHeight();

      await advanceEvmTimeTo(chain[trigger].timestamp);
      await expect(ctx.oracle.submitNextBlock(sc.toContract(chain[trigger]))).to.be.revertedWith(
        "OracleAdapter_BlockNotFoundForTimestamp()"
      );
      expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(heightBefore);
    });

    it("DEMONSTRATES — the canonical chain is frozen: the batch [trigger, next] reverts the same way and the next header cannot link", async function () {
      const { ctx, conditionId, chain, trigger } = await setupLookupMiss();
      await submitEach(ctx, chain.slice(0, trigger));
      await advanceEvmTimeTo(chain[trigger + 1].timestamp);

      await expect(ctx.oracle.submitBatchBlocks(chain.slice(trigger, trigger + 2).map(sc.toContract))).to.be.revertedWith(
        "OracleAdapter_BlockNotFoundForTimestamp()"
      );
      await expect(ctx.oracle.submitNextBlock(sc.toContract(chain[trigger + 1]))).to.be.revertedWith(
        "BlockHeaderOracle_PrevBlockHashMismatch()"
      );
      expect(await payouts(ctx, conditionId)).to.deep.equal([0, 0, 0, 0]);
    });
  });

  describe("(b) 600 s bucket gate", function () {
    it("DEMONSTRATES — headers jump from end−10 s to the next bucket; the question is never examined and can never resolve", async function () {
      const ctx = await load();
      const start = ctx.anchor;
      const end = ctx.anchor + 6000 + 300; // bucket A+6000, window [A+6300, A+6600)
      const bucket = sc.timestampBucket(end);
      const { conditionId } = await createBlockCount(ctx, start, end, COUNT_BUCKETS);

      // Natural 600 s spacing: ..., A+6290 (in the bucket, before end), A+6890 (next bucket), ...
      const lastBefore = end - 10;
      const chain = withTimestamps(ctx.tip, approach(ctx.tip.timestamp, lastBefore + 6 * sc.TARGET_SPACING), "orc004b");
      expect(chain.some((h) => h.timestamp === lastBefore)).to.equal(true);
      expect(chain.some((h) => h.timestamp >= end && h.timestamp < bucket + BUCKET)).to.equal(false); // window skipped

      await submitEach(ctx, chain); // every header accepted; nothing resolves

      // The median time is now past the bucket: no valid header can ever land in the window again.
      const mtp = (await ctx.oracle.medianBlockTime()).toNumber();
      expect(mtp).to.be.at.least(bucket + BUCKET);
      const late = sc.nextHeader(chain[chain.length - 1], { timestamp: end, tag: "orc004b-late" });
      await expect(ctx.oracle.submitNextBlock(sc.toContract(late))).to.be.revertedWith("BlockHeaderOracle_InvalidTimestamp()");

      // ...so the question stays registered and unresolved forever.
      const pending = await ctx.oracleAdapter.getBlockCountQuestionsAtTimestamp(end);
      expect(pending.length).to.equal(1);
      expect(pending[0].conditionId).to.equal(conditionId);
      expect(await payouts(ctx, conditionId)).to.deep.equal([0, 0, 0, 0]);
      expect(await ctx.oracleAdapter.getTotalQuestionsResolved()).to.equal(0);
    });
  });
});
