// PENTEST · ORC-010 (LOW) — remaining differences from Bitcoin consensus in header checks and
// nBits decoding: timestamp == median accepted, no future-timestamp limit, malformed nBits
// (zero / negative / overflowing) accepted
// ----------------------------------------------------------------------------
// STATUS: FIXED (SCRUM-214) — `_verifyBlockHeader` requires timestamp > median-time-past and
// <= block.timestamp + 2 h (BlockHeaderOracle_TimestampTooNew), and every nBits the oracle reads
// goes through `BlockHeaderUtils.decodeCompactStrict` (Bitcoin Core SetCompact: negative,
// overflowing and zero targets revert BlockHeaderOracle_InvalidTargetNBits). PoW is now
// `hash <= target` against the header's own target.
//
// Differences (pre-fix)
//
//   1. DoefinV1BlockHeaderOracleFacet.sol:256 — `timestamp < medianBlockTime()` reverts, so a
//      timestamp EQUAL to the median passes; Bitcoin requires it to be strictly greater.
//   2. No upper bound: Bitcoin rejects timestamps more than 2 h past network-adjusted time; the
//      oracle accepts any future timestamp (feeds ORC-004(c) and the retarget timing attack).
//   3. BlockHeaderUtils.sol:114-123 (`calculateDifficultyTarget`) mirrors none of Bitcoin's
//      SetCompact/DeriveTarget rejections:
//        - exponent 0 → target 0           (Bitcoin: zero target, invalid)
//        - sign bit 0x00800000 set          (Bitcoin: negative, invalid; oracle: huge positive target)
//        - exponent overflow (0x22, >0xff)  (Bitcoin: overflow, invalid; oracle: `<<` silently
//                                            truncates mod 2^256)
//      A header declaring such nBits is accepted (its own nBits is never decoded at acceptance).
//
//   Not demonstrable: BlockHeaderUtils.sol:27 uses `hash < target` where Bitcoin uses `<=`; a
//   hash exactly equal to a compact target (24 significant bits, 232 trailing zero bits) cannot
//   be produced.
//
// Impact: the oracle accepts headers Bitcoin rejects; mostly relevant to ORC-001's fix and to
// timestamp-based markets. Low.
//
// Isolation: every malformed-nBits header sits on a retarget boundary (height % 2016 == 0), where
// a changed nBits is legitimate in principle, so only the compact-decoding rules reject it on
// Bitcoin (not ORC-001's mid-epoch continuity rule). Synthetic regtest-style chain.

const { expect } = require("chai");
const sc = require("../utils/syntheticChain.js");
const { isolateChainState } = require("../utils/oracleAuditFixture.js");
const { snapshotFixture, deployOracleAuditDiamond, initSyntheticOracle, evmNow } = require("../utils/oracleAuditFixture.js");

const BOUNDARY = sc.EPOCH_LENGTH * 500; // 1,008,000

// Mid-epoch buffer for the timestamp checks (next header at 806517: no retarget involved).
const loadMid = snapshotFixture(async () => {
  const ctx = await deployOracleAuditDiamond();
  const init = await initSyntheticOracle(ctx);
  return { ...ctx, init, tip: init[init.length - 1] };
});

// Buffer ending right before a retarget boundary for the nBits checks (next header at 1,008,000).
const loadBoundary = snapshotFixture(async () => {
  const ctx = await deployOracleAuditDiamond();
  const init = await initSyntheticOracle(ctx, { startHeight: BOUNDARY - sc.NUM_OF_BLOCK_HEADERS });
  return { ...ctx, init, tip: init[init.length - 1] };
});

/** A boundary header declaring `nBits` (its hash meets the parent's target) is refused InvalidTargetNBits. */
async function rejectMalformed(ctx, nBits) {
  const header = sc.nextHeader(ctx.tip, { nBits, tag: `orc010-${nBits.toString(16)}`, accept: (h) => h < sc.contractTarget(ctx.tip.nBits) });
  expect(header.blockNumber % sc.EPOCH_LENGTH).to.equal(0);
  await expect(ctx.oracle.submitNextBlock(sc.toContract(header))).to.be.revertedWith("BlockHeaderOracle_InvalidTargetNBits()");
  expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(ctx.tip.blockNumber);
}

describe("PENTEST · ORC-010 (LOW) — remaining Bitcoin-consensus gaps in header checks", function () {
  this.timeout(300_000);
  isolateChainState();

  describe("timestamps", function () {
    it("CONTROL — a header one second above the median-time-past is accepted", async function () {
      const ctx = await loadMid();
      const mtp = sc.honestMtp(ctx.init);
      expect(await ctx.oracle.medianBlockTime()).to.equal(mtp);
      const h = sc.nextHeader(ctx.tip, { timestamp: mtp + 1, tag: "orc010-mtp+1" });
      await ctx.oracle.submitNextBlock(sc.toContract(h));
      expect((await ctx.oracle.getLatestBlockHeader()).timestamp).to.equal(mtp + 1);
    });

    it("CONTROL — a header one second below the median-time-past is rejected InvalidTimestamp", async function () {
      const ctx = await loadMid();
      const mtp = sc.honestMtp(ctx.init);
      const h = sc.nextHeader(ctx.tip, { timestamp: mtp - 1, tag: "orc010-mtp-1" });
      await expect(ctx.oracle.submitNextBlock(sc.toContract(h))).to.be.revertedWith("BlockHeaderOracle_InvalidTimestamp()");
    });

    it("ATTACK BLOCKED — a header whose timestamp EQUALS the median-time-past reverts InvalidTimestamp (Bitcoin requires >)", async function () {
      const ctx = await loadMid();
      const mtp = sc.honestMtp(ctx.init);
      expect(await ctx.oracle.medianBlockTime()).to.equal(mtp);
      const h = sc.nextHeader(ctx.tip, { timestamp: mtp, tag: "orc010-mtp" });
      await expect(ctx.oracle.submitNextBlock(sc.toContract(h))).to.be.revertedWith("BlockHeaderOracle_InvalidTimestamp()");
    });

    it("ATTACK BLOCKED — a header timestamped one year ahead of chain time reverts TimestampTooNew (Bitcoin: at most +2 h)", async function () {
      const ctx = await loadMid();
      const future = (await evmNow()) + 365 * 86400;
      const h = sc.nextHeader(ctx.tip, { timestamp: future, tag: "orc010-future" });
      await expect(ctx.oracle.submitNextBlock(sc.toContract(h))).to.be.revertedWith("BlockHeaderOracle_TimestampTooNew()");
    });

    it("CONTROL — a header one hour ahead of chain time (inside Bitcoin's 2 h allowance) is accepted", async function () {
      const ctx = await loadMid();
      const ahead = (await evmNow()) + 3600;
      const h = sc.nextHeader(ctx.tip, { timestamp: ahead, tag: "orc010-ahead-1h" });
      await ctx.oracle.submitNextBlock(sc.toContract(h));
      expect((await ctx.oracle.getLatestBlockHeader()).timestamp).to.equal(ahead);
    });
  });

  describe("malformed nBits (declared on a retarget boundary)", function () {
    it("ATTACK BLOCKED — exponent 0 (0x00123456 → target 0, invalid on Bitcoin) reverts InvalidTargetNBits", async function () {
      const ctx = await loadBoundary();
      const nBits = 0x00123456;
      expect(sc.bitcoinDecodeCompact(nBits, sc.POW_LIMIT.REGTEST).valid).to.equal(false);
      await rejectMalformed(ctx, nBits);
    });

    it("ATTACK BLOCKED — sign bit set (0x2080ffff, negative on Bitcoin) reverts InvalidTargetNBits", async function () {
      const ctx = await loadBoundary();
      const nBits = 0x2080ffff;
      const decoded = sc.bitcoinDecodeCompact(nBits, sc.POW_LIMIT.REGTEST);
      expect(decoded.negative).to.equal(true);
      expect(decoded.valid).to.equal(false);
      await rejectMalformed(ctx, nBits);
    });

    it("ATTACK BLOCKED — overflowing exponent (0x2201ffff, overflow on Bitcoin) reverts InvalidTargetNBits instead of truncating", async function () {
      const ctx = await loadBoundary();
      const nBits = 0x2201ffff; // 0x01ffff · 256^31 ≈ 2^265 — does not fit 256 bits
      const decoded = sc.bitcoinDecodeCompact(nBits, sc.POW_LIMIT.REGTEST);
      expect(decoded.overflow).to.equal(true);
      expect(decoded.valid).to.equal(false);
      await rejectMalformed(ctx, nBits);
    });
  });
});
