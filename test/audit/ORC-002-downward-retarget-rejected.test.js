// PENTEST · ORC-002 (HIGH) — PoW is checked against the OLD epoch's target, so the honest
// first block of every lower-difficulty epoch can be rejected, freezing the oracle
// ----------------------------------------------------------------------------
// STATUS: NOT YET FIXED — the `DEMONSTRATES` tests assert today's rejection of a real,
// valid Bitcoin block and must be flipped by the fix commit (block 689472 accepted).
//
// Failure scenario (no attacker needed)
//
//   The first header of epoch E (height E·2016) is verified against the target of header
//   E·2016 − 1, which belongs to the previous epoch. When difficulty DROPS the target
//   rises, an honest block's hash is uniform on [0, newTarget], and it fails
//   `hash < oldTarget` with probability 1 − D_new/D_old. The rejected block is the
//   canonical one; every later canonical block links to it, and a batch replay runs the
//   same check, so the oracle freezes permanently (as in SEC-015) until a diamondCut.
//
// Root cause
//
//   contracts/libraries/BlockHeaderUtils.sol:21-28 — `isValidBlockHeaderHash(prev, next)`
//   compares `next.blockHash` with `calculateDifficultyTarget(prev)` (the parent's nBits),
//   called from DoefinV1BlockHeaderOracleFacet.sol:260.
//
// Impact
//
//   Liveness of every market. ≈16% chance the mainnet oracle froze across the five downward
//   adjustments since 2026-05-25 (review §ORC-002); next adjustment 973728 (~2026-10-29).
//
// Real Bitcoin mainnet data (test/data/orc002_retarget_689472/, see its README)
//
//   - 689438–689475: block 689472 is the first block after the −27.94% adjustment of
//     2021-07-03 (nBits 0x170e1ef9 → 0x171398ce). Its hash 0x…124347f7… is above the old
//     target (mantissa 0x0e1ef9 at exponent 0x17) and below its own (0x1398ce).
//   - 971695–971713 (CONTROL): block 971712 is the first block after the +5.92%
//     adjustment of 2026-10-16. A harder new target lies below the old one, so today's
//     check happens to pass.

const path = require("path");
const { expect } = require("chai");
const sc = require("../utils/syntheticChain.js");
const { snapshotFixture, deployOracleAuditDiamond, submitEach, loadRealHeaders } = require("../utils/oracleAuditFixture.js");

const DOWN = loadRealHeaders(path.join(__dirname, "../data/orc002_retarget_689472/blocks-689438-689475.json"));
const UP = loadRealHeaders(path.join(__dirname, "../data/orc002_retarget_689472/blocks-971695-971713-upward.json"));

const DOWN_BOUNDARY = 689472;
const UP_BOUNDARY = 971712;
const RING = sc.NUM_OF_BLOCK_HEADERS;

/** Oracle initialised on the 17 real headers immediately before `boundary` (the review's regression setup). */
function bufferBefore(fixture, boundary) {
  return snapshotFixture(async () => {
    const ctx = await deployOracleAuditDiamond();
    const from = boundary - RING;
    await (await ctx.oracle.initializeBlockHeaderOracle(fixture.headers(from, boundary - 1), from)).wait();
    return ctx;
  });
}

const loadDown = bufferBefore(DOWN, DOWN_BOUNDARY); // 689455..689471
const loadUp = bufferBefore(UP, UP_BOUNDARY); // 971695..971711

describe("PENTEST · ORC-002 (HIGH) — honest first block of a lower-difficulty epoch is rejected", function () {
  this.timeout(300_000);

  describe("fixture sanity (real mainnet headers, hashes re-derived from the raw 80 bytes)", function () {
    it("689472 is a valid Bitcoin block that fails today's parent-target rule; every other header passes it", function () {
      const parent = DOWN.byHeight[DOWN_BOUNDARY - 1];
      const block = DOWN.byHeight[DOWN_BOUNDARY];
      expect(DOWN_BOUNDARY % sc.EPOCH_LENGTH).to.equal(0);
      expect(parent.nBits).to.equal(0x170e1ef9);
      expect(block.nBits).to.equal(0x171398ce);
      expect(block.blockHash).to.equal("0x000000000000000000124347f70edac39e58d972c79086d860929baf07e455aa");
      expect(block.prevBlockHash).to.equal(parent.blockHash);
      expect(sc.passesBitcoinPow(block)).to.equal(true); // hash <= its own target: valid on Bitcoin
      expect(sc.passesOracleCheck(parent, block)).to.equal(false); // hash >= the old epoch's target
      for (let h = 689439; h <= 689475; h++) {
        if (h !== DOWN_BOUNDARY) expect(sc.passesOracleCheck(DOWN.byHeight[h - 1], DOWN.byHeight[h]), `height ${h}`).to.equal(true);
      }
    });

    it("971712 raised difficulty and passes both Bitcoin's rule and today's parent-target rule", function () {
      const upParent = UP.byHeight[UP_BOUNDARY - 1];
      const upBlock = UP.byHeight[UP_BOUNDARY];
      expect(UP_BOUNDARY % sc.EPOCH_LENGTH).to.equal(0);
      expect(upParent.nBits).to.equal(0x17021ef0);
      expect(upBlock.nBits).to.equal(0x17020093);
      expect(sc.contractTarget(upBlock.nBits) < sc.contractTarget(upParent.nBits)).to.equal(true);
      expect(sc.passesBitcoinPow(upBlock)).to.equal(true);
      expect(sc.passesOracleCheck(upParent, upBlock)).to.equal(true);
    });
  });

  it("CONTROL — every real header of the old epoch, 689455..689471, is accepted one by one (buffer 689438..689454)", async function () {
    const ctx = await deployOracleAuditDiamond();
    await (await ctx.oracle.initializeBlockHeaderOracle(DOWN.headers(689438, 689454), 689438)).wait();

    await submitEach(ctx, DOWN.headers(689455, DOWN_BOUNDARY - 1));

    expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(DOWN_BOUNDARY - 1);
    expect((await ctx.oracle.getLatestBlockHeader()).blockHash).to.equal(DOWN.byHeight[DOWN_BOUNDARY - 1].blockHash);
  });

  it("DEMONSTRATES — real block 689472 is rejected BlockHeaderOracle_InvalidBlockHash on top of the real 689455..689471 buffer", async function () {
    const ctx = await loadDown();
    await expect(ctx.oracle.submitNextBlock(DOWN.byHeight[DOWN_BOUNDARY])).to.be.revertedWith("BlockHeaderOracle_InvalidBlockHash()");
    expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(DOWN_BOUNDARY - 1);
  });

  it("DEMONSTRATES — the batch path runs the same check: [689472..689475] reverts BlockHeaderOracle_InvalidBlockHash", async function () {
    const ctx = await loadDown();
    await expect(ctx.oracle.submitBatchBlocks(DOWN.headers(DOWN_BOUNDARY, 689475))).to.be.revertedWith(
      "BlockHeaderOracle_InvalidBlockHash()"
    );
    expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(DOWN_BOUNDARY - 1);
  });

  it("DEMONSTRATES — the oracle is frozen: after 689472 is rejected, the next canonical block 689473 cannot link either", async function () {
    const ctx = await loadDown();
    await expect(ctx.oracle.submitNextBlock(DOWN.byHeight[DOWN_BOUNDARY])).to.be.revertedWith("BlockHeaderOracle_InvalidBlockHash()");
    await expect(ctx.oracle.submitNextBlock(DOWN.byHeight[DOWN_BOUNDARY + 1])).to.be.revertedWith(
      "BlockHeaderOracle_PrevBlockHashMismatch()"
    );
    expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(DOWN_BOUNDARY - 1);
  });

  it("CONTROL — the upward-retarget boundary block 971712 (+5.92%) is accepted, and 971713 after it", async function () {
    const ctx = await loadUp();
    await submitEach(ctx, UP.headers(UP_BOUNDARY, UP_BOUNDARY + 1));
    expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(UP_BOUNDARY + 1);
    const stored = await ctx.oracle.getBlockHeaderByNumber(UP_BOUNDARY);
    expect(stored.blockHash).to.equal(UP.byHeight[UP_BOUNDARY].blockHash);
    expect(stored.nBits).to.equal(0x17020093);
  });
});
