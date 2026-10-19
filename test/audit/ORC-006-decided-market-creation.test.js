// PENTEST · ORC-006 (MEDIUM) — difficulty and duration markets can be created when their
// answer is already decided; oracle lag widens the window
// ----------------------------------------------------------------------------
// STATUS: NOT YET FIXED — the `DEMONSTRATES` tests assert that creation succeeds today and
// must be flipped by the fix commit (creation reverts under the epoch rule / freshness check).
//
// Scenario (market maker, or simply an uninformed one)
//
//   Bitcoin's nBits is constant for the 2016 blocks of an epoch and is fixed once block
//   ⌊T/2016⌋·2016 − 1 is mined. Validation only requires `targetBlockHeight > currentBlockHeight`
//   (the ORACLE's height), so:
//     - a DifficultyThreshold / DifficultyRange market whose target lies in the epoch the tip
//       is already in has a known answer at creation;
//     - while the oracle lags Bitcoin (e.g. the 2026-09-15..23 SEC-015 stall), heights Bitcoin
//       has already mined still pass, e.g. a MiningDuration whose blocks already exist.
//   Trading is only halted on-chain at resolution (T + 6), so informed takers fill resting
//   orders against uninformed makers in the meantime.
//
// Root cause
//
//   contracts/libraries/LibConditionMetadata.sol:102-104, :120-122, :191-193 (only
//   `> currentBlockHeight`); ConditionManagerFacet.sol:65 (validates against the oracle's
//   height, no freshness check).
//
// Evidence in the repo: scripts/admin-scripts/4b-create-condition-with-metadata.js creates
// T = 950905 "well under current 136.61T → resolves YES"; 950905 lies in epoch 471
// (949536–951551), whose difficulty was fixed at 949536.
//
// Data: DEMONSTRATES use the real mainnet headers 967110–967160
// (test/data/reorg_index_underflow/), all in epoch 479 (965664–967679, nBits 0x1702355e).
// The CONTROL uses a fresh synthetic chain (tip timestamp ≈ chain time) with targets in a
// future epoch, so it should keep passing under an epoch rule plus a freshness check.

const path = require("path");
const { expect } = require("chai");
const sc = require("../utils/syntheticChain.js");
const {
  snapshotFixture,
  deployOracleAuditDiamond,
  initSyntheticOracle,
  createThreshold,
  createRange,
  createDuration,
  payouts,
  submitEach,
  evmNow,
  loadRealHeaders,
} = require("../utils/oracleAuditFixture.js");

const REAL = loadRealHeaders(path.join(__dirname, "../data/reorg_index_underflow/blocks-mainchain-967110-967160.json"));
const INIT_FROM = 967110;
const TIP = 967126;
const STALENESS_LIMIT = 3 * 3600; // the review's example MAX_ORACLE_STALENESS

const loadReal = snapshotFixture(async () => {
  const ctx = await deployOracleAuditDiamond();
  await (await ctx.oracle.initializeBlockHeaderOracle(REAL.headers(INIT_FROM, TIP), INIT_FROM)).wait();
  return ctx;
});

/** The review's safe rule: undecided only while ⌊(tip+1)/2016⌋ < ⌊T/2016⌋. */
const alreadyDecided = (tip, target) => sc.epochOf(tip + 1) >= sc.epochOf(target);

describe("PENTEST · ORC-006 (MEDIUM) — markets can be created with an already-decided answer", function () {
  this.timeout(300_000);

  it("CONTROL — on a fresh oracle, Threshold and Range markets targeting the first block of the NEXT epoch are created", async function () {
    const ctx = await deployOracleAuditDiamond();
    const init = await initSyntheticOracle(ctx, { startTimestamp: (await evmNow()) - 17 * sc.TARGET_SPACING });
    const tip = init[init.length - 1].blockNumber;
    const target = (sc.epochOf(tip) + 1) * sc.EPOCH_LENGTH; // E·2016, the review's recommended target
    expect(alreadyDecided(tip, target)).to.equal(false);
    expect((await evmNow()) - init[init.length - 1].timestamp).to.be.lessThan(STALENESS_LIMIT);

    await createThreshold(ctx, 1, target);
    await createRange(ctx, target, [10, 20, 30]);

    const settlement = target + sc.SETTLEMENT_DELAY;
    expect((await ctx.oracleAdapter.getThresholdQuestionsAtBlock(settlement)).length).to.equal(1);
    expect((await ctx.oracleAdapter.getRangeQuestionsAtBlock(settlement)).length).to.equal(1);
  });

  it("DEMONSTRATES — a DifficultyThreshold targeting the tip's own epoch is created, and resolves exactly as predicted at creation", async function () {
    const ctx = await loadReal();
    const target = TIP + 4; // 967130, same epoch as the tip (479)
    expect(alreadyDecided(TIP, target)).to.equal(true);

    // Anyone can read the answer at creation time: same epoch ⇒ same nBits as the tip.
    const known = sc.contractDifficulty((await ctx.oracle.getLatestBlockHeader()).nBits);
    const { conditionId } = await createThreshold(ctx, known - 1n, target); // "difficulty > known − 1" ⇒ YES is certain

    await submitEach(ctx, REAL.headers(TIP + 1, target + sc.SETTLEMENT_DELAY));
    expect(sc.contractDifficulty(REAL.byHeight[target].nBits)).to.equal(known);
    expect(await payouts(ctx, conditionId)).to.deep.equal([0, 1]);
  });

  it("DEMONSTRATES — a DifficultyRange targeting the tip's own epoch is created, and resolves into the bucket known at creation", async function () {
    const ctx = await loadReal();
    const target = TIP + 4;
    expect(alreadyDecided(TIP, target)).to.equal(true);

    const known = sc.contractDifficulty((await ctx.oracle.getLatestBlockHeader()).nBits);
    const buckets = [known - 1000n, known + 1000n]; // known value sits in the middle outcome
    const { conditionId } = await createRange(ctx, target, buckets);

    await submitEach(ctx, REAL.headers(TIP + 1, target + sc.SETTLEMENT_DELAY));
    expect(await payouts(ctx, conditionId)).to.deep.equal([0, 1, 0]);
  });

  it("DEMONSTRATES — creation ignores oracle staleness: with the oracle > 30 days behind chain time, a MiningDuration over blocks Bitcoin already mined is created and resolves as precomputed", async function () {
    const ctx = await loadReal();
    const latest = await ctx.oracle.getLatestBlockHeader();
    expect((await evmNow()) - latest.timestamp).to.be.greaterThan(30 * 86400);

    // Blocks 967127..967133 were mined on 2026-09-15; their duration is public knowledge.
    const start = TIP + 1;
    const blockCount = 6;
    const knownDuration = REAL.byHeight[start + blockCount].timestamp - REAL.byHeight[start].timestamp;
    const buckets = [knownDuration, knownDuration + 1]; // outcome 1 is certain: duration ∈ [known, known+1)
    const { conditionId } = await createDuration(ctx, start, blockCount, buckets);

    await submitEach(ctx, REAL.headers(TIP + 1, start + blockCount + sc.SETTLEMENT_DELAY));
    expect(await payouts(ctx, conditionId)).to.deep.equal([0, 1, 0]);
  });
});
