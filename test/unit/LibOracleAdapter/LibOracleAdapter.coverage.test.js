// LibOracleAdapter — coverage
// ============================================================================
// Raises coverage of `contracts/libraries/LibOracleAdapter.sol` — specifically
// the question-RESOLUTION paths, which the existing `LibOracleAdapter.test.js`
// (view-function only) never exercises.
//
// In production the library resolves questions inside `settleCondition`, which
// `DoefinV1BlockHeaderOracleFacet` calls after each PoW-validated block
// submission. Reproducing that for an arbitrary timestamp window would need a
// full Bitcoin block-header simulation. `LibOracleAdapterHarness` instead wraps
// the `internal` entrypoints and seeds the block-header ring buffer + the
// timestamp→height map directly, so the resolution LOGIC is unit-tested in
// isolation from block-header VALIDATION (a `BlockHeaderUtils` concern).
//
// Covers: `_resolveBlockCountQuestion`, `_findBlockByTimestamp` (exact-miss /
// forward / backward / not-found), `_findBucketIndex` (empty / below-first /
// middle-range), the `endTimestamp`-reached gate, the difficulty-≤-threshold
// branch, and the out-of-ring-buffer revert.
//
// One branch is unreachable BY CONSTRUCTION and intentionally untested:
// `_findBlockByTimestamp`'s own exact-match early return — its only caller
// (`_resolveBlockCountQuestion`) invokes it precisely WHEN the exact lookup
// returned 0, so the re-check inside can never be non-zero. Dead-defensive.

const { expect } = require("chai");
const { ethers } = require("hardhat");

const NUM_OF_BLOCK_HEADERS = 17;

// Ring-buffer index of the latest header, and of an arbitrary block number.
const latestIndex = (nextBlockIndex) => (nextBlockIndex + NUM_OF_BLOCK_HEADERS - 1) % NUM_OF_BLOCK_HEADERS;
const indexForBlock = (blockNumber, currentHeight, nextBlockIndex) => {
  const offset = currentHeight - blockNumber;
  return (nextBlockIndex + NUM_OF_BLOCK_HEADERS - offset - 1) % NUM_OF_BLOCK_HEADERS;
};

// Build a BlockHeader struct; only timestamp / blockNumber / nBits matter here.
function header({ blockNumber = 0, timestamp = 0, nBits = 0 }) {
  return {
    prevBlockHash: ethers.constants.HashZero,
    merkleRootHash: ethers.constants.HashZero,
    blockHash: ethers.constants.HashZero,
    blockNumber,
    version: 0,
    timestamp,
    nBits,
    nonce: 0,
  };
}

describe("LibOracleAdapter — coverage", function () {
  let harness;

  beforeEach(async function () {
    // BlockHeaderUtils is a deployed (non-inlined) library — link it explicitly.
    const BHU = await ethers.getContractFactory("BlockHeaderUtils");
    const bhu = await BHU.deploy();
    await bhu.deployed();

    const H = await ethers.getContractFactory("LibOracleAdapterHarness", {
      libraries: { BlockHeaderUtils: bhu.address },
    });
    harness = await H.deploy();
    await harness.deployed();
  });

  // conditionId == keccak256(abi.encodePacked(oracle, questionId, outcomeSlotCount))
  const conditionIdOf = (questionId, slots) =>
    ethers.utils.solidityKeccak256(["address", "bytes32", "uint8"], [harness.address, questionId, slots]);

  const META = ethers.utils.id("oracle-coverage-condition-meta");

  // ──────────────────────────────────────────────────────────────────────
  // BlockCount question resolution
  // ──────────────────────────────────────────────────────────────────────
  describe("_resolveBlockCountQuestion", function () {
    // A timestamp on a 600s bucket boundary keeps the bucket arithmetic exact.
    const END_TS = 1700000400;
    const START_TS = END_TS - 3600;
    const CURRENT_HEIGHT = 1000;

    // Seed the harness so `settleCondition`'s latest-header read yields END_TS.
    async function seedLatest(timestamp = END_TS) {
      await harness.setOracleState(CURRENT_HEIGHT, 0);
      await harness.seedBlockHeader(
        latestIndex(0), header({ blockNumber: CURRENT_HEIGHT, timestamp }),
      );
    }

    it("resolves a count at/above the last bucket boundary to the top outcome", async function () {
      await seedLatest();
      await harness.setTimestampToBlockHeight(START_TS, 900); // count = 1000 - 900 = 100
      const qId = ethers.utils.id("bc-top");
      await harness.prepareCondition(qId, 2); // countBuckets [50] => 2 outcomes
      await harness.createBlockCountQuestion(qId, META, START_TS, END_TS, [50]);

      await harness.settleCondition();

      const cId = conditionIdOf(qId, 2);
      // 100 >= buckets[last]=50 => winningIndex = buckets.length = 1
      expect((await harness.payoutNumerators(cId)).map((x) => x.toNumber())).to.deep.equal([0, 1]);
      expect(await harness.payoutDenominator(cId)).to.equal(1);
      expect(await harness.totalQuestionsResolved()).to.equal(1);
    });

    it("resolves a count below the first bucket boundary to outcome 0 (_findBucketIndex L378)", async function () {
      await seedLatest();
      await harness.setTimestampToBlockHeight(START_TS, 970); // count = 30
      const qId = ethers.utils.id("bc-below");
      await harness.prepareCondition(qId, 2);
      await harness.createBlockCountQuestion(qId, META, START_TS, END_TS, [50]);

      await harness.settleCondition();

      const cId = conditionIdOf(qId, 2);
      // 30 < buckets[0]=50 => winningIndex 0
      expect((await harness.payoutNumerators(cId)).map((x) => x.toNumber())).to.deep.equal([1, 0]);
    });

    it("resolves a count inside a mid bucket range (_findBucketIndex L389)", async function () {
      await seedLatest();
      await harness.setTimestampToBlockHeight(START_TS, 900); // count = 100
      const qId = ethers.utils.id("bc-mid");
      await harness.prepareCondition(qId, 3); // countBuckets [50,150] => 3 outcomes
      await harness.createBlockCountQuestion(qId, META, START_TS, END_TS, [50, 150]);

      await harness.settleCondition();

      const cId = conditionIdOf(qId, 3);
      // 50 <= 100 < 150 => winningIndex 1
      expect((await harness.payoutNumerators(cId)).map((x) => x.toNumber())).to.deep.equal([0, 1, 0]);
    });

    it("reverts OracleAdapter_InvalidBucketConfiguration for empty countBuckets (_findBucketIndex L373)", async function () {
      await seedLatest();
      await harness.setTimestampToBlockHeight(START_TS, 900);
      const qId = ethers.utils.id("bc-empty");
      await harness.prepareCondition(qId, 1); // 0 buckets => 1 outcome slot
      await harness.createBlockCountQuestion(qId, META, START_TS, END_TS, []);

      await expect(harness.settleCondition()).to.be.revertedWith(
        "OracleAdapter_InvalidBucketConfiguration()",
      );
    });

    it("finds the start block by a FORWARD timestamp search when the exact slot is empty", async function () {
      await seedLatest();
      // START_TS itself is unmapped; START_TS + 60 is.
      await harness.setTimestampToBlockHeight(START_TS + 60, 900);
      const qId = ethers.utils.id("bc-fwd");
      await harness.prepareCondition(qId, 2);
      await harness.createBlockCountQuestion(qId, META, START_TS, END_TS, [50]);

      await harness.settleCondition();

      const cId = conditionIdOf(qId, 2);
      expect((await harness.payoutNumerators(cId)).map((x) => x.toNumber())).to.deep.equal([0, 1]);
    });

    it("finds the start block by a BACKWARD timestamp search when the exact slot is empty", async function () {
      await seedLatest();
      // Only START_TS - 120 is mapped (i = 2 backward).
      await harness.setTimestampToBlockHeight(START_TS - 120, 900);
      const qId = ethers.utils.id("bc-bwd");
      await harness.prepareCondition(qId, 2);
      await harness.createBlockCountQuestion(qId, META, START_TS, END_TS, [50]);

      await harness.settleCondition();

      const cId = conditionIdOf(qId, 2);
      expect((await harness.payoutNumerators(cId)).map((x) => x.toNumber())).to.deep.equal([0, 1]);
    });

    it("reverts OracleAdapter_BlockNotFoundForTimestamp when no block is near the start timestamp", async function () {
      await seedLatest();
      // Nothing mapped within +/- 10 minutes of START_TS.
      const qId = ethers.utils.id("bc-notfound");
      await harness.prepareCondition(qId, 2);
      await harness.createBlockCountQuestion(qId, META, START_TS, END_TS, [50]);

      await expect(harness.settleCondition()).to.be.revertedWith(
        "OracleAdapter_BlockNotFoundForTimestamp()",
      );
    });

    it("does NOT resolve a question whose endTimestamp has not been reached", async function () {
      // END and CURRENT timestamps share a 600s bucket, but current < end.
      const bucket = 1700000400;
      const endTs = bucket + 599;
      const currentTs = bucket + 100;
      await harness.setOracleState(CURRENT_HEIGHT, 0);
      await harness.seedBlockHeader(
        latestIndex(0), header({ blockNumber: CURRENT_HEIGHT, timestamp: currentTs }),
      );
      await harness.setTimestampToBlockHeight(START_TS, 900);
      const qId = ethers.utils.id("bc-early");
      await harness.prepareCondition(qId, 2);
      await harness.createBlockCountQuestion(qId, META, START_TS, endTs, [50]);

      await harness.settleCondition(); // current bucket matches, but currentTs < endTs

      expect(await harness.totalQuestionsResolved()).to.equal(0);
      expect(await harness.payoutDenominator(conditionIdOf(qId, 2))).to.equal(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Difficulty-threshold resolution — the `<= threshold` branch
  // ──────────────────────────────────────────────────────────────────────
  describe("_resolveDifficultyThresholdQuestion", function () {
    it("reports the NO outcome when actual difficulty does not exceed the threshold", async function () {
      const CURRENT_HEIGHT = 1000;
      const TARGET = CURRENT_HEIGHT - 6; // question settles at TARGET + SETTLEMENT_DELAY
      await harness.setOracleState(CURRENT_HEIGHT, 0);
      // Latest header — only needed so settleCondition can read a timestamp.
      await harness.seedBlockHeader(latestIndex(0), header({ blockNumber: CURRENT_HEIGHT, timestamp: 1700000000 }));
      // Target header carries a valid Bitcoin nBits (genesis difficulty bits).
      await harness.seedBlockHeader(
        indexForBlock(TARGET, CURRENT_HEIGHT, 0), header({ blockNumber: TARGET, nBits: 0x1d00ffff }),
      );

      const qId = ethers.utils.id("dt-le");
      await harness.prepareCondition(qId, 2);
      // Threshold at the uint256 max => actual difficulty can never exceed it.
      await harness.createDifficultyThresholdQuestion(qId, META, ethers.constants.MaxUint256, TARGET);

      await harness.settleCondition();

      const cId = conditionIdOf(qId, 2);
      // difficulty <= threshold => payouts [No=1, Yes=0]
      expect((await harness.payoutNumerators(cId)).map((x) => x.toNumber())).to.deep.equal([1, 0]);
      expect(await harness.totalQuestionsResolved()).to.equal(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // MiningDuration happy path — exercises full _resolveMiningDurationQuestion
  // (including the stats increment) without the ring-buffer revert.
  // ──────────────────────────────────────────────────────────────────────
  describe("_resolveMiningDurationQuestion (happy path)", function () {
    it("resolves a MiningDuration question whose start block is inside the ring buffer", async function () {
      // blockCount 5 ⇒ startBlock offset 11 from the head — still in buffer.
      const START_BLOCK = 89;
      const BLOCK_COUNT = 5;
      const END_BLOCK = START_BLOCK + BLOCK_COUNT; // 94
      const CURRENT_HEIGHT = END_BLOCK + 6;        // 100 — settlement block
      const startTs = 1000;
      const endTs = 4000; // actualDuration = 3000
      await harness.setOracleState(CURRENT_HEIGHT, 0);
      // Latest header — its timestamp drives _updateAuxiliaryMappings; not load-bearing here.
      await harness.seedBlockHeader(latestIndex(0), header({ blockNumber: CURRENT_HEIGHT, timestamp: 5000 }));
      // Start and end headers carry the timestamps the resolver subtracts.
      await harness.seedBlockHeader(
        indexForBlock(START_BLOCK, CURRENT_HEIGHT, 0), header({ blockNumber: START_BLOCK, timestamp: startTs }),
      );
      await harness.seedBlockHeader(
        indexForBlock(END_BLOCK, CURRENT_HEIGHT, 0), header({ blockNumber: END_BLOCK, timestamp: endTs }),
      );

      const qId = ethers.utils.id("md-happy");
      await harness.prepareCondition(qId, 2); // durationBuckets [2000] => 2 outcomes
      await harness.createMiningDurationQuestion(qId, META, START_BLOCK, BLOCK_COUNT, [2000]);

      await harness.settleCondition();

      const cId = conditionIdOf(qId, 2);
      // duration 3000 >= buckets[last]=2000 => winningIndex 1
      expect((await harness.payoutNumerators(cId)).map((x) => x.toNumber())).to.deep.equal([0, 1]);
      expect(await harness.totalQuestionsResolved()).to.equal(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Ring-buffer bounds — _getBlockHeaderByNumber out-of-buffer revert
  // ──────────────────────────────────────────────────────────────────────
  describe("_getBlockHeaderByNumber", function () {
    it("reverts OracleAdapter_BlockNotInBuffer when a resolution reads a block outside the ring buffer", async function () {
      // A MiningDuration question whose start block is `blockCount + SETTLEMENT_DELAY`
      // behind the head — with blockCount 11 that offset (17) falls off the
      // 17-slot ring buffer.
      const START_BLOCK = 1000;
      const BLOCK_COUNT = 11;
      const CURRENT_HEIGHT = START_BLOCK + BLOCK_COUNT + 6; // 1017 — settlement block
      await harness.setOracleState(CURRENT_HEIGHT, 0);
      await harness.seedBlockHeader(latestIndex(0), header({ blockNumber: CURRENT_HEIGHT, timestamp: 1700000000 }));

      const qId = ethers.utils.id("md-oob");
      await harness.prepareCondition(qId, 2);
      await harness.createMiningDurationQuestion(qId, META, START_BLOCK, BLOCK_COUNT, [100]);

      await expect(harness.settleCondition()).to.be.revertedWith("OracleAdapter_BlockNotInBuffer()");
    });
  });
});
