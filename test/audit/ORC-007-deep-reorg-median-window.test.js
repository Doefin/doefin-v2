// PENTEST · ORC-007 (LOW) — deep-reorg replays compute the median-time-past over stale
// post-fork ring slots; from depth ≈ 12 the canonical chain is rejected and the oracle freezes
// (confirms and refines SCRUM-521-DEEP-REORG-MTP)
// ----------------------------------------------------------------------------
// STATUS: NOT YET FIXED — the `DEMONSTRATES` tests assert today's rejections and must be
// flipped by the fix commit (explicit `ReorgTooDeep` cap for d > 6, or a larger timestamp ring).
//
// Failure scenario (honest Bitcoin reorg, no attacker)
//
//   The oracle sits on a branch that Bitcoin orphans d blocks deep (fork height f). The
//   canonical replay `submitBatchBlocks([C1..C_{d+1}])` rewinds the ring pointer by d and
//   verifies C1 against `medianBlockTime()`, which reads the 11 slots before the pointer. Only
//   17 − d of them hold verified headers (f, f−1, …); the other d − 6 still hold ORPHANS
//   f+d, f+d−1, …, f+7, whose timestamps are ~1 h+ later than t_f. The median therefore moves
//   later:
//
//     depth d   median for C1                      canonical chain
//     ≤ 6       exact (t_{f−5})                    accepted
//     7–10      a real entry, but newer            rejected only on unusual timestamps
//     11        t_f                                rejected whenever t_{f+1} < t_f
//     ≥ 12      an orphan's timestamp (t_{f+7}…)   rejected InvalidTimestamp almost always
//
//   The rejection is permanent (any longer canonical branch replays the same first header).
//
// Root cause
//
//   contracts/facets/DoefinV1BlockHeaderOracleFacet.sol:160-175 (`medianBlockTime` window),
//   :146-156 / :197-215 (rewind + replay), :256 (timestamp check).
//
// Impact
//
//   A ≥ 12-deep Bitcoin reorg freezes the oracle permanently (none since 2013). Low.
//
// Setup: synthetic regtest-style chains (orphan and canonical branches share 600 s spacing
// and differ only in content), plus a real-data variant that re-submits genuine canonical
// headers 967110–967160 from 12 blocks deep (same mechanism: stale later slots in the window).

const path = require("path");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const sc = require("../utils/syntheticChain.js");
const {
  snapshotFixture,
  deployOracleAuditDiamond,
  initSyntheticOracle,
  submitEach,
  submitBatch,
  loadRealHeaders,
} = require("../utils/oracleAuditFixture.js");

const REAL = loadRealHeaders(path.join(__dirname, "../data/reorg_index_underflow/blocks-mainchain-967110-967160.json"));
const BLOCK_REORGED_TOPIC = ethers.utils.id("BlockReorged(bytes32)");

const load = snapshotFixture(async () => {
  const ctx = await deployOracleAuditDiamond();
  const init = await initSyntheticOracle(ctx);
  return { ...ctx, init, fork: init[init.length - 1] };
});

/**
 * Put the oracle on a d-deep orphan branch from the fork point, then build the canonical
 * branch C1..C_{d+1+extra}. `c1Timestamp` optionally overrides C1's timestamp.
 */
async function orphanThenCanonical(d, { c1Timestamp, extra = 0 } = {}) {
  const ctx = await load();
  const orphans = sc.extendChain(ctx.fork, d, { tag: `orc007-orphan-${d}` });
  await submitBatch(ctx, orphans);
  expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(ctx.fork.blockNumber + d);

  const c1 = sc.nextHeader(ctx.fork, { tag: `orc007-canonical-${d}`, timestamp: c1Timestamp ?? ctx.fork.timestamp + sc.TARGET_SPACING });
  const rest = sc.extendChain(c1, d + extra, {
    tag: `orc007-canonical-${d}`,
    timestampAt: (i) => ctx.fork.timestamp + (i + 1) * sc.TARGET_SPACING,
  });
  const canonical = [c1, ...rest];

  // What the oracle's window holds when it verifies C1 (spec model from the review):
  // verified f, f-1, …, f+d-16 plus orphans f+d, …, f+7.
  const verified = ctx.init.slice(-(sc.NUM_OF_BLOCK_HEADERS - d)).map((h) => h.timestamp);
  const stale = orphans.slice(6).map((h) => h.timestamp);
  const window = [...verified, ...stale].slice(-sc.MEDIAN_WINDOW);
  const corruptedMedian = d > 6 ? sc.medianOf(window) : sc.honestMtp(ctx.init);
  const honestMedian = sc.honestMtp(ctx.init); // Bitcoin's MTP for C1: t_{f-5}

  return { ctx, orphans, canonical, corruptedMedian, honestMedian };
}

describe("PENTEST · ORC-007 (LOW) — deep reorg replays use a median window full of orphans", function () {
  this.timeout(300_000);

  describe("synthetic orphan branch replaced by the canonical branch", function () {
    it("CONTROL — depth 1: the canonical branch replaces a 1-block orphan", async function () {
      const { ctx, canonical } = await orphanThenCanonical(1);
      const receipt = await submitBatch(ctx, canonical);
      expect(receipt.logs.filter((l) => l.topics[0] === BLOCK_REORGED_TOPIC).length).to.equal(1);
      expect((await ctx.oracle.getLatestBlockHeader()).blockHash).to.equal(canonical[canonical.length - 1].blockHash);
    });

    it("CONTROL — depth 6: the window is exact and the canonical branch replaces the orphans", async function () {
      const { ctx, canonical } = await orphanThenCanonical(6);
      await submitBatch(ctx, canonical);
      expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(ctx.fork.blockNumber + 7);
      expect((await ctx.oracle.getBlockHeaderByNumber(ctx.fork.blockNumber + 1)).blockHash).to.equal(canonical[0].blockHash);
    });

    it("CONTROL — depth 6 with an out-of-order C1 (t_f − 60 s, above Bitcoin's MTP t_{f−5}) is accepted", async function () {
      const c1Timestamp = (await load()).fork.timestamp - 60;
      const { ctx, canonical, honestMedian } = await orphanThenCanonical(6, { c1Timestamp });
      expect(c1Timestamp).to.be.greaterThan(honestMedian);
      await submitBatch(ctx, canonical);
      expect((await ctx.oracle.getBlockHeaderByNumber(ctx.fork.blockNumber + 1)).blockHash).to.equal(canonical[0].blockHash);
    });

    it("DEMONSTRATES — depth 11: the same Bitcoin-valid out-of-order C1 (t_f − 60 s) is rejected InvalidTimestamp (median moved to t_f)", async function () {
      const c1Timestamp = (await load()).fork.timestamp - 60;
      const { ctx, canonical, honestMedian, corruptedMedian, orphans } = await orphanThenCanonical(11, { c1Timestamp });
      expect(c1Timestamp).to.be.greaterThan(honestMedian); // valid on Bitcoin
      expect(corruptedMedian).to.equal(ctx.fork.timestamp); // the oracle's window median
      expect(c1Timestamp).to.be.lessThan(corruptedMedian);

      await expect(ctx.oracle.submitBatchBlocks(canonical.map(sc.toContract))).to.be.revertedWith("BlockHeaderOracle_InvalidTimestamp()");
      expect((await ctx.oracle.getLatestBlockHeader()).blockHash).to.equal(orphans[orphans.length - 1].blockHash);
    });

    it("DEMONSTRATES — depth 12: the natural canonical branch is rejected InvalidTimestamp (median = orphan f+7's timestamp)", async function () {
      const { ctx, canonical, corruptedMedian, orphans } = await orphanThenCanonical(12);
      expect(corruptedMedian).to.equal(orphans[6].timestamp); // orphan at f+7, ~70 min after t_f
      expect(canonical[0].timestamp).to.be.lessThan(corruptedMedian);

      await expect(ctx.oracle.submitBatchBlocks(canonical.map(sc.toContract))).to.be.revertedWith("BlockHeaderOracle_InvalidTimestamp()");
      expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(ctx.fork.blockNumber + 12);
      expect((await ctx.oracle.getLatestBlockHeader()).blockHash).to.equal(orphans[11].blockHash); // stays on the orphan tip
    });

    it("DEMONSTRATES — depth 12 is permanent: a longer canonical branch (d + 6 headers) fails identically", async function () {
      const { ctx, canonical } = await orphanThenCanonical(12, { extra: 5 });
      expect(canonical.length).to.equal(18);
      await expect(ctx.oracle.submitBatchBlocks(canonical.map(sc.toContract))).to.be.revertedWith("BlockHeaderOracle_InvalidTimestamp()");
    });

    it("DEMONSTRATES — depth 16 (the deepest fork point the buffer holds): rejected InvalidTimestamp", async function () {
      const { ctx, canonical, corruptedMedian } = await orphanThenCanonical(16);
      expect(canonical[0].timestamp).to.be.lessThan(corruptedMedian);
      await expect(ctx.oracle.submitBatchBlocks(canonical.map(sc.toContract))).to.be.revertedWith("BlockHeaderOracle_InvalidTimestamp()");
    });
  });

  describe("real Bitcoin timestamps (headers 967110–967160)", function () {
    const loadReal = snapshotFixture(async () => {
      const ctx = await deployOracleAuditDiamond();
      await (await ctx.oracle.initializeBlockHeaderOracle(REAL.headers(967110, 967126), 967110)).wait();
      await submitEach(ctx, REAL.headers(967127, 967140));
      return ctx;
    });

    it("CONTROL — re-anchoring the real canonical chain 6 deep (batch 967135..967141) is accepted", async function () {
      const ctx = await loadReal();
      await submitBatch(ctx, REAL.headers(967135, 967141));
      expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(967141);
    });

    it("DEMONSTRATES — re-anchoring the real canonical chain 12 deep (batch 967129..967141) is rejected InvalidTimestamp", async function () {
      const ctx = await loadReal();
      // Window for 967129: verified 967124..967128 plus stale slots 967135..967140.
      const window = [...REAL.headers(967124, 967128), ...REAL.headers(967135, 967140)].map((h) => h.timestamp);
      const corruptedMedian = sc.medianOf(window);
      const honestMedian = sc.medianOf(REAL.headers(967118, 967128).map((h) => h.timestamp));
      const first = REAL.byHeight[967129].timestamp;
      expect(first).to.be.greaterThan(honestMedian); // valid on Bitcoin (it IS Bitcoin)
      expect(first).to.be.lessThan(corruptedMedian);

      await expect(ctx.oracle.submitBatchBlocks(REAL.headers(967129, 967141))).to.be.revertedWith("BlockHeaderOracle_InvalidTimestamp()");
      expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(967140);
    });
  });
});
