// PENTEST · ORC-005 (MEDIUM) — `_resolveConditionsAtTimestamp` pops the LAST array element,
// not the one it just resolved: one question is lost, and the resolved one stays behind to be
// resolved again, which reverts and freezes the oracle
// ----------------------------------------------------------------------------
// STATUS: FIXED (SCRUM-214) — `_resolveConditionsAtTimestamp` now swaps the resolved question
// with the last element before `pop()`. BlockCount creation is also disabled (ORC-004), so the fix
// is exercised through LibOracleAdapterHarness. Pre-fix text kept below. Was: NOT YET FIXED — the `DEMONSTRATES` tests assert today's behaviour and must be
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
const { ethers } = require("hardhat");
const sc = require("../utils/syntheticChain.js");
const { isolateChainState } = require("../utils/oracleAuditFixture.js");
const { snapshotFixture, deployOracleAuditDiamond, initSyntheticOracle, createBlockCount, evmNow } = require("../utils/oracleAuditFixture.js");

const BUCKET = sc.TIMESTAMP_BUCKET; // 600
const COUNT_BUCKETS = [5, 10, 15]; // outcomes: <5, 5–9, 10–14, ≥15
const B = BUCKET * 2_833_344; // a bucket start (1,700,006,400)
const A = B - 6000; // shared start timestamp
const START_HEIGHT = 1000;

async function deployHarness() {
  const bhu = await (await ethers.getContractFactory("BlockHeaderUtils")).deploy();
  await bhu.deployed();
  const H = await ethers.getContractFactory("LibOracleAdapterHarness", { libraries: { BlockHeaderUtils: bhu.address } });
  const harness = await H.deploy();
  await harness.deployed();
  return harness;
}

/** Make the harness's latest header (ring slot 16 with nextBlockIndex 0) carry `timestamp` at `height`. */
async function seedLatest(harness, height, timestamp) {
  await harness.setOracleState(height, 0);
  await harness.seedBlockHeader(16, {
    prevBlockHash: ethers.constants.HashZero,
    merkleRootHash: ethers.constants.HashZero,
    blockHash: ethers.constants.HashZero,
    blockNumber: height,
    version: 0,
    timestamp,
    nBits: 0x207fffff,
    nonce: 0,
  });
}

describe("PENTEST · ORC-005 (MEDIUM) — BlockCount bucket pop() removes the wrong question", function () {
  this.timeout(300_000);
  isolateChainState();

  const q0 = ethers.utils.id("orc005-q0");
  const q1 = ethers.utils.id("orc005-q1");
  let harness;
  const conditionIdOf = (questionId) =>
    ethers.utils.solidityKeccak256(["address", "bytes32", "uint8"], [harness.address, questionId, COUNT_BUCKETS.length + 1]);

  beforeEach(async function () {
    harness = await deployHarness();
    await harness.setTimestampToBlockHeight(A, START_HEIGHT);
    for (const [q, end] of [[q0, B + 300], [q1, B + 500]]) {
      await harness.prepareCondition(q, COUNT_BUCKETS.length + 1);
      await harness.createBlockCountQuestion(q, conditionIdOf(q), A, end, COUNT_BUCKETS);
    }
    expect(await harness.blockCountQuestionIdsAt(B)).to.deep.equal([q0, q1]); // both in bucket B, Q0 first
  });

  it("FIX VERIFIED — the header at B+360 resolves Q0 (due) and removes Q0; Q1 (not yet due) stays queued (pre-fix: Q1 was popped and lost)", async function () {
    await seedLatest(harness, START_HEIGHT + 12, B + 360);
    await harness.settleCondition();

    expect((await harness.payoutNumerators(conditionIdOf(q0))).map(Number)).to.deep.equal([0, 0, 1, 0]); // 12 blocks
    expect(await harness.payoutDenominator(conditionIdOf(q1))).to.equal(0);
    expect(await harness.blockCountQuestionIdsAt(B)).to.deep.equal([q1]);
  });

  it("FIX VERIFIED — the next header in the bucket resolves Q1 without reverting (pre-fix: re-resolved Q0, ConditionAlreadyResolved froze the oracle)", async function () {
    await seedLatest(harness, START_HEIGHT + 12, B + 360);
    await harness.settleCondition();

    await harness.setTimestampToBlockHeight(B + 500, START_HEIGHT + 13); // exact end hit (lookup issue is ORC-004)
    await seedLatest(harness, START_HEIGHT + 13, B + 540);
    await harness.settleCondition();

    expect((await harness.payoutNumerators(conditionIdOf(q1))).map(Number)).to.deep.equal([0, 0, 1, 0]); // 13 blocks
    expect(await harness.blockCountQuestionIdsAt(B)).to.deep.equal([]);
    expect(await harness.totalQuestionsResolved()).to.equal(2);
  });

  it("ATTACK BLOCKED — BlockCount markets can no longer be created through ConditionManagerFacet (ORC-004)", async function () {
    const load = snapshotFixture(async () => {
      const ctx = await deployOracleAuditDiamond();
      const now = await evmNow();
      await initSyntheticOracle(ctx, { startTimestamp: now - 18 * sc.TARGET_SPACING });
      return { ...ctx, now };
    });
    const ctx = await load();
    const start = Math.ceil((ctx.now + 3600) / BUCKET) * BUCKET;
    await expect(createBlockCount(ctx, start, start + 6300, COUNT_BUCKETS)).to.be.revertedWith(
      "OracleAdapter_QuestionTypeDisabled()"
    );
  });
});
