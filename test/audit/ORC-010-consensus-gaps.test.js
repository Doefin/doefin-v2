// PENTEST · ORC-010 (LOW) — remaining differences from Bitcoin consensus in header checks and
// nBits decoding: timestamp == median accepted, no future-timestamp limit, malformed nBits
// (zero / negative / overflowing) accepted
// ----------------------------------------------------------------------------
// STATUS: NOT YET FIXED — the `DEMONSTRATES` tests assert today's acceptance of headers Bitcoin
// rejects and must be flipped by the fix commit (folded into ORC-001 (d) + a SetCompact-style
// decodeTarget).
//
// Differences demonstrated
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

/** Submit a boundary header declaring `nBits` (its hash meets the parent's target, as the oracle requires). */
async function acceptMalformed(ctx, nBits) {
  const header = sc.nextHeader(ctx.tip, { nBits, tag: `orc010-${nBits.toString(16)}`, accept: (h) => h < sc.contractTarget(ctx.tip.nBits) });
  expect(header.blockNumber % sc.EPOCH_LENGTH).to.equal(0);
  await ctx.oracle.submitNextBlock(sc.toContract(header));
  expect((await ctx.oracle.getLatestBlockHeader()).nBits).to.equal(nBits);
  return header;
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

    it("DEMONSTRATES — a header whose timestamp EQUALS the median-time-past is accepted (Bitcoin requires >)", async function () {
      const ctx = await loadMid();
      const mtp = sc.honestMtp(ctx.init);
      expect(await ctx.oracle.medianBlockTime()).to.equal(mtp);
      const h = sc.nextHeader(ctx.tip, { timestamp: mtp, tag: "orc010-mtp" });
      await ctx.oracle.submitNextBlock(sc.toContract(h));
      expect((await ctx.oracle.getLatestBlockHeader()).timestamp).to.equal(mtp);
    });

    it("DEMONSTRATES — a header timestamped one year ahead of chain time is accepted (Bitcoin: at most +2 h)", async function () {
      const ctx = await loadMid();
      const future = (await evmNow()) + 365 * 86400;
      const h = sc.nextHeader(ctx.tip, { timestamp: future, tag: "orc010-future" });
      await ctx.oracle.submitNextBlock(sc.toContract(h));
      expect((await ctx.oracle.getLatestBlockHeader()).timestamp).to.equal(future);
      expect(future - (await evmNow())).to.be.greaterThan(2 * 3600);
    });
  });

  describe("malformed nBits (declared on a retarget boundary)", function () {
    it("DEMONSTRATES — exponent 0 (0x00123456 → target 0, invalid on Bitcoin) is accepted, and no child can ever follow it", async function () {
      const ctx = await loadBoundary();
      const nBits = 0x00123456;
      expect(sc.bitcoinDecodeCompact(nBits, sc.POW_LIMIT.REGTEST).valid).to.equal(false);
      expect(sc.contractTarget(nBits)).to.equal(0n);

      const header = await acceptMalformed(ctx, nBits);

      const child = sc.nextHeader(header, { tag: "orc010-dead-end", accept: () => true });
      await expect(ctx.oracle.submitNextBlock(sc.toContract(child))).to.be.revertedWith("BlockHeaderOracle_InvalidBlockHash()");
    });

    it("DEMONSTRATES — sign bit set (0x2080ffff, negative on Bitcoin) is accepted and decoded as a target above 2^255", async function () {
      const ctx = await loadBoundary();
      const nBits = 0x2080ffff;
      const decoded = sc.bitcoinDecodeCompact(nBits, sc.POW_LIMIT.REGTEST);
      expect(decoded.negative).to.equal(true);
      expect(decoded.valid).to.equal(false);
      expect(sc.contractTarget(nBits) > 1n << 255n).to.equal(true);

      const header = await acceptMalformed(ctx, nBits);

      // A child whose hash is >= 2^255 (above any valid regtest target) passes against it.
      const child = sc.nextHeader(header, {
        tag: "orc010-negative-child",
        accept: (h) => h >= 1n << 255n && h < sc.contractTarget(nBits),
      });
      await ctx.oracle.submitNextBlock(sc.toContract(child));
      expect((await ctx.oracle.getLatestBlockHeader()).blockHash).to.equal(child.blockHash);
    });

    it("DEMONSTRATES — overflowing exponent (0x2201ffff, overflow on Bitcoin) is accepted; the oracle silently truncates its target mod 2^256", async function () {
      const ctx = await loadBoundary();
      const nBits = 0x2201ffff; // 0x01ffff · 256^31 ≈ 2^265 — does not fit 256 bits
      const decoded = sc.bitcoinDecodeCompact(nBits, sc.POW_LIMIT.REGTEST);
      expect(decoded.overflow).to.equal(true);
      expect(decoded.valid).to.equal(false);
      expect(decoded.target > 1n << 256n).to.equal(true);
      const truncated = 0xffn << 248n; // what `coefficient << 248` leaves in a uint256
      expect(sc.contractTarget(nBits)).to.equal(truncated);

      const header = await acceptMalformed(ctx, nBits);

      // Proof the truncated value is what the oracle uses: a child above it is rejected, although
      // under the un-truncated target (> 2^256) every hash would qualify.
      const child = sc.nextHeader(header, { tag: "orc010-overflow-child", accept: (h) => h >= truncated });
      await expect(ctx.oracle.submitNextBlock(sc.toContract(child))).to.be.revertedWith("BlockHeaderOracle_InvalidBlockHash()");
    });
  });
});
