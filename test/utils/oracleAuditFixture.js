// Shared fixture for the oracle security PoCs (`test/audit/ORC-*.test.js`).
//
// Stands up a fresh Diamond (scripts/deploy.js), grants a market-maker, and exposes
// the oracle / condition-manager / adapter / CTF facets plus small helpers for
// creating questions, reading payouts, driving the EVM clock and seeding the oracle
// with real or synthetic Bitcoin headers.
//
// Like test/utils/auditFixture.js, this file registers no tests.

const { ethers, network } = require("hardhat");
const { deployDiamond } = require("../../scripts/deploy.js");
const sc = require("./syntheticChain.js");
const {
  QuestionType,
  encodeDifficultyThreshold,
  encodeDifficultyRange,
  encodeBlockCount,
  encodeMiningDuration,
} = require("./oracleAdapterUtils.js");

const BASE_PER_TX_GAS_CAP = 16_777_216; // 2^24 — EIP-7825 per-transaction gas cap on Base

async function evmSnapshot() {
  return network.provider.send("evm_snapshot", []);
}

async function evmRevert(id) {
  return network.provider.send("evm_revert", [id]);
}

/**
 * `loadFixture` equivalent (hardhat-network-helpers is not installed): runs `setup`
 * once, snapshots, and on every later call reverts to that snapshot (re-snapshotting,
 * because evm_revert consumes the id). Each returned function owns its own snapshot.
 */
function snapshotFixture(setup) {
  let id = null;
  let ctx = null;
  return async function load() {
    if (id === null) {
      ctx = await setup();
    } else {
      await evmRevert(id);
    }
    id = await evmSnapshot();
    return ctx;
  };
}

/**
 * Call at the top of a `describe`: snapshot the chain before the file's tests and revert after
 * them, so deployments and — importantly — the EVM clock (these PoCs advance it to header
 * timestamps) do not leak into later test files.
 */
function isolateChainState() {
  let id;
  before(async function () {
    id = await evmSnapshot();
  });
  after(async function () {
    await evmRevert(id);
  });
}

async function evmNow() {
  return (await ethers.provider.getBlock("latest")).timestamp;
}

/** Move the EVM clock forward to at least `ts` (no-op if already there). */
async function advanceEvmTimeTo(ts) {
  const now = await evmNow();
  if (Number(ts) > now) {
    await network.provider.send("evm_setNextBlockTimestamp", [Number(ts)]);
    await network.provider.send("evm_mine", []);
  }
}

async function deployOracleAuditDiamond() {
  const [owner, marketMaker, attacker, outsider] = await ethers.getSigners();
  const diamondAddress = await deployDiamond();

  const oracle = await ethers.getContractAt("IDoefinBlockHeaderOracle", diamondAddress);
  const conditionManager = await ethers.getContractAt("ConditionManagerFacet", diamondAddress);
  const oracleAdapter = await ethers.getContractAt("OracleAdapterFacet", diamondAddress);
  const ctf = await ethers.getContractAt("ConditionalTokensFacet", diamondAddress);
  const accessControl = await ethers.getContractAt("AccessControlFacet", diamondAddress);

  await (await accessControl.connect(owner).addMarketMaker(marketMaker.address)).wait();

  return {
    diamondAddress,
    oracle,
    conditionManager,
    oracleAdapter,
    ctf,
    accessControl,
    signers: { owner, marketMaker, attacker, outsider },
  };
}

/** Create a question through `createConditionWithMetadata` as the market maker. */
async function createQuestion(ctx, questionType, metadata, outcomeSlotCount, { salt = ethers.constants.HashZero, uri = "ipfs://orc-poc" } = {}) {
  const cm = ctx.conditionManager.connect(ctx.signers.marketMaker);
  const [conditionId, questionId] = await cm.callStatic.createConditionWithMetadata(questionType, metadata, outcomeSlotCount, uri, salt);
  const receipt = await (await cm.createConditionWithMetadata(questionType, metadata, outcomeSlotCount, uri, salt)).wait();
  return { conditionId, questionId, receipt };
}

const createThreshold = (ctx, threshold, targetHeight, opts) =>
  createQuestion(ctx, QuestionType.DifficultyThreshold, encodeDifficultyThreshold(threshold, targetHeight), 2, opts);

const createRange = (ctx, targetHeight, buckets, opts) =>
  createQuestion(ctx, QuestionType.DifficultyRange, encodeDifficultyRange(targetHeight, buckets), buckets.length + 1, opts);

const createBlockCount = (ctx, startTs, endTs, buckets, opts) =>
  createQuestion(ctx, QuestionType.BlockCount, encodeBlockCount(startTs, endTs, buckets), buckets.length + 1, opts);

const createDuration = (ctx, startHeight, blockCount, buckets, opts) =>
  createQuestion(ctx, QuestionType.MiningDuration, encodeMiningDuration(startHeight, blockCount, buckets), buckets.length + 1, opts);

/** Payout numerators as numbers; all zeros ⇔ the condition is unresolved. */
async function payouts(ctx, conditionId) {
  return (await ctx.ctf.getPayoutNumerators(conditionId)).map((n) => n.toNumber());
}

/**
 * Initialise the oracle with a synthetic regtest-style buffer (see syntheticChain.js).
 * Defaults: owner calls; heights 806500..806516 (far from a 2016 boundary);
 * timestamps start 3 days before the EVM clock so later headers stay in the past.
 * `fresh: true` instead ends the buffer ~10 minutes behind the EVM clock, so a freshness
 * check on market creation (ORC-006's fix) is satisfied; later headers are then in the
 * future and must be submitted through `submitEach` / `submitBatch` (or after
 * `advanceEvmTimeTo`), which keep the EVM clock at or past each header's timestamp.
 */
async function initSyntheticOracle(ctx, { startHeight = 806500, startTimestamp, fresh = false, nBits = sc.NBITS.REGTEST, tag = "init", caller } = {}) {
  const now = await evmNow();
  const start = startTimestamp ?? (fresh ? now - sc.NUM_OF_BLOCK_HEADERS * sc.TARGET_SPACING : now - 3 * 86400);
  const init = sc.makeInitBuffer({ startHeight, startTimestamp: start, nBits, tag });
  await (await ctx.oracle.connect(caller ?? ctx.signers.owner).initializeBlockHeaderOracle(init.map(sc.toContract), startHeight)).wait();
  return init;
}

/** submitNextBlock each header in order, keeping the EVM clock at or past each header's timestamp. */
async function submitEach(ctx, headers, { caller } = {}) {
  const receipts = [];
  for (const h of headers) {
    await advanceEvmTimeTo(h.timestamp);
    receipts.push(await (await ctx.oracle.connect(caller ?? ctx.signers.owner).submitNextBlock(sc.toContract(h))).wait());
  }
  return receipts;
}

async function submitBatch(ctx, headers, { caller } = {}) {
  await advanceEvmTimeTo(Math.max(...headers.map((h) => Number(h.timestamp))));
  return (await ctx.oracle.connect(caller ?? ctx.signers.owner).submitBatchBlocks(headers.map(sc.toContract))).wait();
}

/** Real-header fixture loader: { byHeight, headers(from, to) } for a test/data JSON file. */
function loadRealHeaders(jsonPath) {
  const data = require(jsonPath);
  const byHeight = {};
  for (const b of data.blocks) {
    byHeight[b.blockNumber] = {
      prevBlockHash: b.prevBlockHash,
      merkleRootHash: b.merkleRootHash,
      blockHash: b.blockHash,
      blockNumber: b.blockNumber,
      version: b.version,
      timestamp: b.timestamp,
      nBits: b.nBits,
      nonce: b.nonce,
    };
  }
  function headers(from, to) {
    const out = [];
    for (let h = from; h <= to; h++) {
      if (!byHeight[h]) throw new Error(`fixture has no header for height ${h}`);
      out.push(byHeight[h]);
    }
    return out;
  }
  return { data, byHeight, headers };
}

module.exports = {
  BASE_PER_TX_GAS_CAP,
  QuestionType,
  evmSnapshot,
  evmRevert,
  isolateChainState,
  snapshotFixture,
  evmNow,
  advanceEvmTimeTo,
  deployOracleAuditDiamond,
  createQuestion,
  createThreshold,
  createRange,
  createBlockCount,
  createDuration,
  payouts,
  initSyntheticOracle,
  submitEach,
  submitBatch,
  loadRealHeaders,
};
