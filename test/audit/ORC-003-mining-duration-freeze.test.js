// PENTEST · ORC-003 (HIGH) — MiningDuration resolution reverts inside header submission,
// freezing the oracle: blockCount ≥ 11 reads outside the 17-slot buffer, and an end
// timestamp below the start's underflows (any miner can force it when blockCount ≤ 5)
// ----------------------------------------------------------------------------
// STATUS: NOT YET FIXED — the `DEMONSTRATES` tests assert today's reverts/acceptances and
// must be flipped by the fix commit.
//
// Failure / attack scenario
//
//   A MiningDuration question (start S, blockCount n) resolves when the oracle accepts the
//   header at settlement height S + n + 6. Resolution runs INSIDE `submitNextBlock` /
//   `submitBatchBlocks`, so any revert there rejects the canonical header at that height,
//   and with it every later header (they link to it): the oracle is frozen for all markets
//   until a diamondCut. The question cannot be removed (`cancelCondition` does not
//   deregister it).
//     - Out-of-buffer read: at height S + n + 6 the start header is n + 6 blocks back; the
//       ring holds 17, so for n ≥ 11 `_getBlockHeaderByNumber(start)` reverts
//       `OracleAdapter_BlockNotInBuffer`. Validation allows 1 ≤ n ≤ 2016.
//     - Underflow: `endBlock.timestamp - startBlock.timestamp` is checked arithmetic.
//       Bitcoin only requires a timestamp above the median of the previous 11 blocks, so for
//       n ≤ 5 the miner of the end block can choose a timestamp below the start block's at no
//       cost → Panic(0x11). Only 6 ≤ n ≤ 10 is safe.
//
// Root cause
//
//   - contracts/libraries/LibOracleAdapter.sol:334-355 (`_resolveMiningDurationQuestion`):
//     ring-buffer reads at :336-337, unchecked-order subtraction at :340.
//   - LibOracleAdapter.sol:454-461 (`_getBlockHeaderByNumber` → OracleAdapter_BlockNotInBuffer).
//   - contracts/libraries/LibConditionMetadata.sol:194 + LibDoefinStorage.sol:24
//     (MAX_BLOCK_COUNT = 2016) — validation accepts any 1..2016.
//   - The revert propagates through DoefinV1BlockHeaderOracleFacet.sol:108 and :213.
//
// Impact
//
//   Any natural MiningDuration market of 11+ blocks, or any Bitcoin miner for markets of 5 or
//   fewer blocks, halts the oracle for every market. The market-maker role therefore holds an
//   oracle kill switch.
//
// Setup: synthetic regtest-style chain (test/utils/syntheticChain.js), 600 s spacing. The
// buffer is fresh (tip ~10 min behind chain time), every header is submitted with the EVM
// clock advanced to its timestamp, and questions start START_OFFSET blocks past the tip, so the
// CONTROLs also hold under the ORC-006 / ORC-010 fixes (freshness, lag margin, future limit).

const { expect } = require("chai");
const sc = require("../utils/syntheticChain.js");
const {
  snapshotFixture,
  deployOracleAuditDiamond,
  initSyntheticOracle,
  createDuration,
  payouts,
  submitEach,
  submitBatch,
  advanceEvmTimeTo,
} = require("../utils/oracleAuditFixture.js");

const BUCKETS = [3000, 6600]; // seconds: [<50 min) [50–110 min) [≥110 min)
const SPACING = sc.TARGET_SPACING;
const START_OFFSET = 10; // question start = tip + 10 (headroom for a creation-time lag margin)

const load = snapshotFixture(async () => {
  const ctx = await deployOracleAuditDiamond();
  const init = await initSyntheticOracle(ctx, { fresh: true });
  const tip = init[init.length - 1];
  return { ...ctx, init, tip, start: tip.blockNumber + START_OFFSET };
});

/** Direct submission with the EVM clock at the header's timestamp (for expect(...).revertedWith). */
async function submitAt(ctx, header) {
  await advanceEvmTimeTo(header.timestamp);
  return ctx.oracle.submitNextBlock(sc.toContract(header));
}

async function batchAt(ctx, headers) {
  await advanceEvmTimeTo(Math.max(...headers.map((h) => h.timestamp)));
  return ctx.oracle.submitBatchBlocks(headers.map(sc.toContract));
}

/** Natural chain on top of `parent`, 600 s apart. */
function natural(parent, count, tag = "orc003") {
  return sc.extendChain(parent, count, { tag });
}

/**
 * Chain tip+1 .. settlement where the END header (start + blockCount) carries the smallest
 * timestamp Bitcoin allows (median-time-past + 1); every other header is natural.
 * Returns { headers, start, end, endIndex, mtpAtEnd }.
 */
function chainWithMinimalEndTimestamp(base, blockCount, extraAfterEnd) {
  const pre = natural(base.tip, START_OFFSET - 1 + blockCount); // tip+1 .. end-1
  const history = [...base.init, ...pre];
  const mtpAtEnd = sc.honestMtp(history);
  const end = sc.nextHeader(pre[pre.length - 1], { timestamp: mtpAtEnd + 1, tag: "orc003-end" });
  const resume = Math.max(...history.map((h) => h.timestamp));
  const after = sc.extendChain(end, extraAfterEnd, { tag: "orc003", timestampAt: (i) => resume + i * SPACING });
  return { headers: [...pre, end, ...after], start: pre[START_OFFSET - 1], end, endIndex: pre.length, mtpAtEnd };
}

describe("PENTEST · ORC-003 (HIGH) — MiningDuration resolution freezes the oracle", function () {
  this.timeout(300_000);

  describe("creation-time validation", function () {
    it("DEMONSTRATES — validation accepts blockCount = 11, 144 and 2016 (MAX_BLOCK_COUNT), all beyond the 10 the buffer can resolve", async function () {
      const ctx = await load();
      for (const [i, n] of [11, 144, 2016].entries()) {
        const buckets = [n * 300, n * 900]; // stays under MAX_DURATION (30 days) for n = 2016
        await createDuration(ctx, ctx.start, n, buckets, { salt: sc.merkleFor("orc003-salt", i) });
        const registered = await ctx.oracleAdapter.getDurationQuestionsAtBlock(ctx.start + n + sc.SETTLEMENT_DELAY);
        expect(registered.length).to.equal(1);
        expect(registered[0].blockCount).to.equal(n);
      }
      expect(await ctx.oracleAdapter.getTotalQuestionsCreated()).to.equal(3);
    });

    it("CONTROL — validation still rejects blockCount 0 and 2017 with ValueOutOfRange", async function () {
      const ctx = await load();
      await expect(createDuration(ctx, ctx.start, 0, BUCKETS)).to.be.revertedWith("ValueOutOfRange()");
      await expect(createDuration(ctx, ctx.start, 2017, BUCKETS)).to.be.revertedWith("ValueOutOfRange()");
    });
  });

  describe("out-of-buffer read (blockCount >= 11)", function () {
    it("CONTROL — blockCount = 10 (the largest the buffer can serve) resolves at start+16 to the bucket of the 6000 s duration", async function () {
      const ctx = await load();
      const { conditionId } = await createDuration(ctx, ctx.start, 10, BUCKETS);
      const settlement = ctx.start + 10 + sc.SETTLEMENT_DELAY;
      const chain = natural(ctx.tip, settlement - ctx.tip.blockNumber);
      const at = (height) => chain[height - ctx.tip.blockNumber - 1];

      await submitEach(ctx, chain.slice(0, -1));
      expect(await payouts(ctx, conditionId)).to.deep.equal([0, 0, 0]); // pending until the settlement height
      await submitEach(ctx, chain.slice(-1));

      expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(settlement);
      expect(at(ctx.start + 10).timestamp - at(ctx.start).timestamp).to.equal(6000);
      expect(await payouts(ctx, conditionId)).to.deep.equal([0, 1, 0]); // 3000 <= 6000 < 6600
    });

    it("DEMONSTRATES — blockCount = 11: the canonical header at the settlement height reverts OracleAdapter_BlockNotInBuffer", async function () {
      const ctx = await load();
      const settlement = ctx.start + 11 + sc.SETTLEMENT_DELAY;
      await createDuration(ctx, ctx.start, 11, BUCKETS);
      const chain = natural(ctx.tip, settlement - ctx.tip.blockNumber);

      await submitEach(ctx, chain.slice(0, -1)); // up to settlement - 1: fine
      expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(settlement - 1);

      await expect(submitAt(ctx, chain[chain.length - 1])).to.be.revertedWith("OracleAdapter_BlockNotInBuffer()");
      expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(settlement - 1);
    });

    it("DEMONSTRATES — blockCount = 11: the oracle can never pass the settlement height (any header there, batch or replay, reverts)", async function () {
      const ctx = await load();
      const settlement = ctx.start + 11 + sc.SETTLEMENT_DELAY;
      await createDuration(ctx, ctx.start, 11, BUCKETS);
      const chain = natural(ctx.tip, settlement - ctx.tip.blockNumber + 1); // through settlement + 1
      const at = (height) => chain[height - ctx.tip.blockNumber - 1];
      await submitEach(ctx, chain.slice(0, settlement - 1 - ctx.tip.blockNumber));
      const parent = at(settlement - 1);

      // A different header at the same height (another miner's block) hits the same resolver.
      const sibling = sc.nextHeader(parent, { tag: "orc003-sibling", timestamp: parent.timestamp + 777 });
      await expect(submitAt(ctx, sibling)).to.be.revertedWith("OracleAdapter_BlockNotInBuffer()");
      // The batch path settles every height it applies.
      await expect(batchAt(ctx, [at(settlement), at(settlement + 1)])).to.be.revertedWith("OracleAdapter_BlockNotInBuffer()");
      // A reorg that replaces settlement-1 and reaches the settlement height again.
      const replay = sc.extendChain(at(settlement - 2), 2, { tag: "orc003-replay", spacing: 599 });
      await expect(batchAt(ctx, replay)).to.be.revertedWith("OracleAdapter_BlockNotInBuffer()");
      // Nothing above it can link.
      await expect(submitAt(ctx, at(settlement + 1))).to.be.revertedWith("BlockHeaderOracle_PrevBlockHashMismatch()");
      expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(settlement - 1);
    });

    it("DEMONSTRATES — a natural one-day market (blockCount = 144) freezes the oracle at start+150", async function () {
      const ctx = await load();
      const settlement = ctx.start + 144 + sc.SETTLEMENT_DELAY;
      await createDuration(ctx, ctx.start, 144, [144 * 500, 144 * 700]);
      const chain = natural(ctx.tip, settlement - ctx.tip.blockNumber);

      for (let i = 0; i < chain.length - 1; i += 50) await submitBatch(ctx, chain.slice(i, Math.min(i + 50, chain.length - 1)));
      expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(settlement - 1);

      await expect(submitAt(ctx, chain[chain.length - 1])).to.be.revertedWith("OracleAdapter_BlockNotInBuffer()");
    });
  });

  describe("timestamp underflow (blockCount <= 5)", function () {
    it("DEMONSTRATES — blockCount = 1: an end header at median-time-past + 1 (below the start's timestamp) panics 0x11 at settlement", async function () {
      const ctx = await load();
      const blockCount = 1;
      const { headers, start, end, endIndex, mtpAtEnd } = chainWithMinimalEndTimestamp(ctx, blockCount, sc.SETTLEMENT_DELAY);
      await createDuration(ctx, start.blockNumber, blockCount, BUCKETS);

      // The end header is valid on Bitcoin (strictly above MTP) yet earlier than the start header.
      expect(end.timestamp).to.be.greaterThan(mtpAtEnd);
      expect(end.timestamp).to.be.lessThan(start.timestamp);

      await submitEach(ctx, headers.slice(0, endIndex)); // through the start block
      expect(await ctx.oracle.medianBlockTime()).to.equal(mtpAtEnd); // the oracle agrees on the MTP
      await submitEach(ctx, headers.slice(endIndex, -1)); // end .. settlement-1: all accepted

      await expect(submitAt(ctx, headers[headers.length - 1])).to.be.revertedWith("panic code 0x11");
      expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(start.blockNumber + blockCount + sc.SETTLEMENT_DELAY - 1);
    });

    it("DEMONSTRATES — blockCount = 5 (the largest a miner can force): same Panic(0x11) at settlement", async function () {
      const ctx = await load();
      const blockCount = 5;
      const { headers, start, end, mtpAtEnd } = chainWithMinimalEndTimestamp(ctx, blockCount, sc.SETTLEMENT_DELAY);
      await createDuration(ctx, start.blockNumber, blockCount, BUCKETS);

      expect(end.timestamp).to.be.greaterThan(mtpAtEnd);
      expect(end.timestamp).to.be.lessThan(start.timestamp);

      await submitEach(ctx, headers.slice(0, -1));
      await expect(submitAt(ctx, headers[headers.length - 1])).to.be.revertedWith("panic code 0x11");
    });

    it("CONTROL — blockCount = 6: the earliest MTP-valid end timestamp is not below the start's, and the question resolves (bucket 0)", async function () {
      const ctx = await load();
      const blockCount = 6;
      const { headers, start, end, mtpAtEnd } = chainWithMinimalEndTimestamp(ctx, blockCount, sc.SETTLEMENT_DELAY);
      const { conditionId } = await createDuration(ctx, start.blockNumber, blockCount, BUCKETS);

      expect(mtpAtEnd).to.equal(start.timestamp); // the median already includes the start block
      expect(end.timestamp - start.timestamp).to.equal(1);

      await submitEach(ctx, headers);
      expect(await payouts(ctx, conditionId)).to.deep.equal([1, 0, 0]); // 1 s < 3000 s
    });
  });
});
