// PENTEST · ORC-009 (MEDIUM) — no limit on questions per settlement height; resolving them all
// inside the header's transaction exceeds Base's 16,777,216-gas per-transaction cap, so that
// height can never be submitted
// ----------------------------------------------------------------------------
// STATUS: NOT YET FIXED — the `DEMONSTRATES` tests assert today's behaviour and must be
// flipped by the fix commit (per-height cap at creation, or a resumable resolution queue).
//
// Failure / attack scenario (market maker — compromised, buggy, or just successful)
//
//   Every question registered at settlement height S is resolved in the same transaction that
//   accepts header S (`_resolveConditionsAtBlock`). Creation never bounds how many questions
//   share S, and they cannot be removed. Once their resolution needs more gas than one
//   transaction may carry, header S — and so every later header — can never be accepted.
//
// Root cause
//
//   contracts/libraries/LibOracleAdapter.sol:199-225 (resolve everything at the height in one
//   loop), :33 / :64 / :142 (unbounded push); ConditionManagerFacet.sol:49-126 (no per-height cap).
//
// Measured (this suite; Hardhat 2.28 / EDR, hardfork "osaka", which enforces EIP-7825's 2^24
// per-transaction gas cap exactly like Base). Gas used is net of the ≤20% SSTORE refund; the
// binding constraint is the GROSS gas, which is why the last fitting N uses ~13.2M net.
//
//   questions at one height        gas used (net) to submit the settlement header
//   none                           186,151
//   DifficultyThreshold  ×1        276,585      ×50  3,351,667      ×205 13,207,200 (last fit)
//   DifficultyRange(10)  ×1        310,946      ×50  6,646,853      ×100 13,120,748 (last fit)
//   MiningDuration(10)   ×1        319,913      ×50  6,921,556      ×96  13,134,101 (last fit)
//   ⇒ marginal ≈ 63k (threshold), 129k (range), 135k (duration) net per question,
//     i.e. ≈ 81k / 165k / 172k GROSS against the cap
//   ⇒ the header CANNOT be submitted at 206 threshold / 101 range / 97 duration questions.
//   (Exact figures are logged by the tests; they move by a few gas with header calldata.)
//
// Setup: fresh synthetic oracle (tip ~10 min behind chain time) 11 blocks before a retarget
// boundary B; threshold/range questions target B (next epoch), duration questions start at
// B − 1, so the CONTROL also holds under ORC-006's epoch/freshness rules and a per-height cap
// of 50.
//
//   (The review estimated 60–120k / 150–250k per question and 70–250 questions; the measured
//   threshold count is at the top of that range, range/duration questions lower.)
//
// Impact
//
//   A runaway or compromised market maker freezes the oracle for every market.

const { expect } = require("chai");
const sc = require("../utils/syntheticChain.js");
const {
  BASE_PER_TX_GAS_CAP,
  evmSnapshot,
  evmRevert,
  snapshotFixture,
  deployOracleAuditDiamond,
  initSyntheticOracle,
  createThreshold,
  createRange,
  createDuration,
  submitBatch,
  advanceEvmTimeTo,
} = require("../utils/oracleAuditFixture.js");

const TEN_BUCKETS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const TEN_DURATION_BUCKETS = [600, 1200, 1800, 2400, 3000, 3600, 4200, 4800, 5400, 6000];

// The oracle is fresh and its tip sits 11 blocks before a retarget boundary B. Threshold and
// range questions target B (first block of the NEXT epoch — valid under ORC-006's epoch rule);
// duration questions start at B − 1 (10 blocks past the tip) for 1 block. All settle at B + 6.
const BOUNDARY = sc.EPOCH_LENGTH * 401; // 808,416
const load = snapshotFixture(async () => {
  const ctx = await deployOracleAuditDiamond();
  const init = await initSyntheticOracle(ctx, { startHeight: BOUNDARY - 11 - sc.NUM_OF_BLOCK_HEADERS + 1, fresh: true });
  const tip = init[init.length - 1];
  const chain = sc.extendChain(tip, BOUNDARY + sc.SETTLEMENT_DELAY - tip.blockNumber, { tag: "orc009" });
  return { ...ctx, tip, chain, settlement: chain[chain.length - 1] };
});

const KINDS = {
  threshold: (ctx, i) => createThreshold(ctx, 1, BOUNDARY, { salt: sc.merkleFor("orc009-threshold", i) }),
  range: (ctx, i) => createRange(ctx, BOUNDARY, TEN_BUCKETS, { salt: sc.merkleFor("orc009-range", i) }),
  duration: (ctx, i) => createDuration(ctx, BOUNDARY - 1, 1, TEN_DURATION_BUCKETS, { salt: sc.merkleFor("orc009-duration", i) }),
};

async function addQuestions(ctx, kind, from, to) {
  for (let i = from; i < to; i++) await KINDS[kind](ctx, i);
}

/** Submit the settlement header under Base's cap; returns gasUsed. */
async function settleUnderCap(ctx) {
  await advanceEvmTimeTo(ctx.settlement.timestamp);
  const receipt = await (await ctx.oracle.submitNextBlock(sc.toContract(ctx.settlement), { gasLimit: BASE_PER_TX_GAS_CAP })).wait();
  return receipt.gasUsed.toNumber();
}

async function expectRejected(promise, substring) {
  try {
    await promise;
  } catch (e) {
    expect(String(e.message)).to.include(substring);
    return;
  }
  expect.fail(`expected rejection containing "${substring}"`);
}

/**
 * Register `lastFit + 1` questions of `kind` at one height: show that `lastFit` still settle
 * under the cap and that one more makes the settlement header impossible to submit.
 */
async function demonstrateBoundary(kind, lastFit) {
  const ctx = await load();
  await addQuestions(ctx, kind, 0, lastFit);

  // Boundary: with `lastFit` questions the settlement header still fits under the cap.
  const snap = await evmSnapshot();
  await submitBatch(ctx, ctx.chain.slice(0, -1));
  const gasAtLastFit = await settleUnderCap(ctx);
  await evmRevert(snap);

  // One more question (questions must exist before the oracle reaches their target height).
  await addQuestions(ctx, kind, lastFit, lastFit + 1);
  expect((await ctx.oracleAdapter.getTotalQuestionsCreated()).toNumber()).to.equal(lastFit + 1);
  await submitBatch(ctx, ctx.chain.slice(0, -1));
  const heightBefore = (await ctx.oracle.getCurrentBlockHeight()).toNumber();
  await advanceEvmTimeTo(ctx.settlement.timestamp);

  await expect(
    ctx.oracle.submitNextBlock(sc.toContract(ctx.settlement), { gasLimit: BASE_PER_TX_GAS_CAP })
  ).to.be.revertedWith("run out of gas");
  // The batch path settles the same height in the same transaction.
  await expect(
    ctx.oracle.submitBatchBlocks(ctx.chain.slice(-2).map(sc.toContract), { gasLimit: BASE_PER_TX_GAS_CAP })
  ).to.be.revertedWith("run out of gas");
  expect((await ctx.oracle.getCurrentBlockHeight()).toNumber()).to.equal(heightBefore);
  console.log(`      ${kind}: ${lastFit} questions settle with ${gasAtLastFit.toLocaleString("en-US")} gas (net); ${lastFit + 1} run out of gas at the 16,777,216 cap`);
  return { ctx, gasAtLastFit };
}

describe("PENTEST · ORC-009 (MEDIUM) — unbounded questions per settlement height vs the 2^24 per-tx gas cap", function () {
  this.timeout(600_000);

  it("CONTROL — up to 50 questions of each type at one height settle under the cap (measured, logged)", async function () {
    const rows = [];
    for (const kind of Object.keys(KINDS)) {
      for (const n of [0, 1, 10, 50]) {
        const ctx = await load();
        await addQuestions(ctx, kind, 0, n);
        await submitBatch(ctx, ctx.chain.slice(0, -1));
        const gas = await settleUnderCap(ctx);
        expect(gas).to.be.lessThan(BASE_PER_TX_GAS_CAP);
        expect((await ctx.oracleAdapter.getTotalQuestionsResolved()).toNumber()).to.equal(n);
        rows.push({ kind, n, gas });
      }
    }
    console.log("      ORC-009 settlement-header gas (net):");
    for (const kind of Object.keys(KINDS)) {
      const r = rows.filter((x) => x.kind === kind);
      const slope = Math.round((r[3].gas - r[1].gas) / 49);
      console.log(`        ${kind.padEnd(9)} ${r.map((x) => `N=${x.n}: ${x.gas.toLocaleString("en-US")}`).join("  ")}  (~${slope.toLocaleString("en-US")}/question)`);
    }
  });

  it("DEMONSTRATES — 206 DifficultyThreshold questions at one height: the settlement header cannot be submitted under the cap (205 still fit)", async function () {
    const { ctx, gasAtLastFit } = await demonstrateBoundary("threshold", 205);
    expect(gasAtLastFit).to.be.greaterThan(13_000_000);
    // No escape hatch: the network refuses any gas limit above the cap outright.
    await expectRejected(
      ctx.oracle.submitNextBlock(sc.toContract(ctx.settlement), { gasLimit: BASE_PER_TX_GAS_CAP + 1 }),
      "exceeds transaction gas cap of 16777216"
    );
  });

  it("DEMONSTRATES — 101 ten-bucket DifficultyRange questions at one height: the settlement header cannot be submitted (100 still fit)", async function () {
    const { gasAtLastFit } = await demonstrateBoundary("range", 100);
    expect(gasAtLastFit).to.be.greaterThan(13_000_000);
  });

  it("DEMONSTRATES — 97 ten-bucket MiningDuration questions at one height: the settlement header cannot be submitted (96 still fit)", async function () {
    const { gasAtLastFit } = await demonstrateBoundary("duration", 96);
    expect(gasAtLastFit).to.be.greaterThan(13_000_000);
  });
});
