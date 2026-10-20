/* global ethers */
/**
 * SCRUM-214 — oracle hardening cut, rehearsed against a fork of Base mainnet.
 *
 * Forks Base mainnet LOOKBACK blocks in the past (default 3600 ≈ 2 h) so real Bitcoin blocks
 * exist beyond the oracle's tip at the fork point, then:
 *   1. records the live oracle state and every pending question at the known settlement heights;
 *   2. applies upgrade-scrum214-oracle-hardening.js with the owner impersonated, including
 *      setMaxOracleStaleness(10800) in the same batch;
 *   3. asserts routing, oracle state and pending questions are untouched;
 *   4. submits the real headers mined after the fork tip (mempool.space) — one by one, then the
 *      rest as one batch — through the new facet;
 *   5. checks the new market rules on the live state as a real market maker: a difficulty
 *      market for the current period reverts DifficultyAlreadyDecided, one for the next period
 *      is created, BlockCount reverts QuestionTypeDisabled, and creation reverts OracleStale
 *      once the oracle is older than the limit;
 *   6. checks the exact-retarget input for the next boundary (the period's first-block
 *      timestamp) is recorded on-chain.
 *
 * Run:  npm run upgrade:scrum214-oracle:rehearse
 * Needs BASE_MAINNET_RPC_ENDPOINT (archive-capable); FORK_BLOCK_NUMBER pins the fork instead of
 * LOOKBACK. Reads mempool.space (MEMPOOL_API). Never sends anything to mainnet.
 */

const hre = require("hardhat");
const { runUpgrade } = require("./upgrade-scrum214-oracle-hardening.js");
const { readOracleState, printState, BASE_MAINNET_DIAMOND } = require("./upgrade-scrum521-oracle-reorg-underflow.js");
const { tipHeight, headersRange } = require("../lib/bitcoin-headers.js");

const QuestionType = { DifficultyThreshold: 0, DifficultyRange: 1, BlockCount: 2, MiningDuration: 3 };
const MARKET_MAKER = process.env.REHEARSAL_MARKET_MAKER || "0xd0500c4c09fc3f33d3470d647b94294d6259a74c"; // created 22 of the mainnet markets
const STALENESS = 10800;
const PERIOD = 2016;

function check(cond, msg, failures) {
  console.log(`  ${cond ? "✔" : "✘"} ${msg}`);
  if (!cond) failures.push(msg);
}

async function expectRevert(promise, errorName) {
  try {
    await promise;
    return `succeeded (expected ${errorName})`;
  } catch (err) {
    const text = `${err.errorName || ""} ${err.message || err}`;
    return text.includes(errorName) ? null : `reverted with something else: ${text.slice(0, 200)}`;
  }
}

async function forkBaseMainnet() {
  const rpc = process.env.BASE_MAINNET_RPC_ENDPOINT;
  if (!rpc) throw new Error("BASE_MAINNET_RPC_ENDPOINT is required to fork Base mainnet");
  let blockNumber = process.env.FORK_BLOCK_NUMBER ? Number(process.env.FORK_BLOCK_NUMBER) : null;
  if (!blockNumber) {
    const live = await new ethers.providers.JsonRpcProvider(rpc).getBlockNumber();
    blockNumber = live - Number(process.env.LOOKBACK || 3600);
  }
  await hre.network.provider.request({ method: "hardhat_reset", params: [{ forking: { jsonRpcUrl: rpc, blockNumber } }] });
  await hre.network.provider.send("evm_mine"); // see rehearse-scrum521-fork.js: run on a local block
  return blockNumber;
}

const encode = {
  threshold: (threshold, target) => ethers.utils.defaultAbiCoder.encode(["uint256", "uint256"], [threshold, target]),
  blockCount: (start, end, buckets) => ethers.utils.defaultAbiCoder.encode(["uint256", "uint256", "uint256[]"], [start, end, buckets]),
};

async function main() {
  if (hre.network.name !== "hardhat") throw new Error("Run on the in-process hardhat network (the script forks Base mainnet itself)");
  const forkBlock = await forkBaseMainnet();
  const diamond = BASE_MAINNET_DIAMOND;
  if ((await ethers.provider.getCode(diamond)) === "0x") throw new Error("No Diamond bytecode — fork failed");

  const oracle = await ethers.getContractAt("IDoefinBlockHeaderOracle", diamond);
  const adapter = await ethers.getContractAt("OracleAdapterFacet", diamond);
  const failures = [];

  console.log("==========================================================");
  console.log("  SCRUM-214 — oracle hardening, mainnet-fork rehearsal");
  console.log("==========================================================");
  console.log(`  Fork block ${forkBlock}  Diamond ${diamond}`);
  const before = await readOracleState(oracle);
  printState("Oracle at fork", before);

  // Pending threshold questions at the settlement heights live today (audit/findings-ledger.md ORACLE).
  const settlementHeights = (process.env.REHEARSAL_SETTLEMENTS || "977766,979782,987846").split(",").map(Number);
  const pendingBefore = {};
  for (const h of settlementHeights) pendingBefore[h] = (await adapter.getThresholdQuestionsAtBlock(h)).map((q) => q.questionId);
  console.log(`  Pending threshold questions: ${settlementHeights.map((h) => `${h}: ${pendingBefore[h].length}`).join(", ")}`);

  // Every pending question must be accounted for (created − resolved == block-keyed questions found at
  // the listed heights). The cut only disables BlockCount CREATION: a BlockCount question registered
  // before it still resolves through the exact-second timestamp lookup and can freeze the oracle (ORC-004).
  // Anything unaccounted for (a BlockCount question, or a market at a height not listed in
  // REHEARSAL_SETTLEMENTS) fails the rehearsal closed.
  const [createdTotal, resolvedTotal] = (await Promise.all([adapter.getTotalQuestionsCreated(), adapter.getTotalQuestionsResolved()])).map((x) => x.toNumber());
  let blockKeyed = 0;
  for (const h of settlementHeights) {
    const found = await Promise.all([adapter.getThresholdQuestionsAtBlock(h), adapter.getRangeQuestionsAtBlock(h), adapter.getDurationQuestionsAtBlock(h)]);
    blockKeyed += found.reduce((n, qs) => n + qs.length, 0);
  }
  check(
    createdTotal - resolvedTotal === blockKeyed,
    `all ${createdTotal - resolvedTotal} pending question(s) are block-keyed at the listed heights (found ${blockKeyed}); no legacy BlockCount question can freeze the oracle`,
    failures
  );

  console.log("\n>>> Applying the cut (owner impersonated) with setMaxOracleStaleness(10800)\n");
  await runUpgrade({ diamond, impersonateOwner: true, skipVerify: true, record: false, maxOracleStaleness: STALENESS });

  for (const h of settlementHeights) {
    const now = (await adapter.getThresholdQuestionsAtBlock(h)).map((q) => q.questionId);
    check(JSON.stringify(now) === JSON.stringify(pendingBefore[h]), `pending questions at ${h} unchanged (${now.length})`, failures);
  }

  // --- real headers past the fork tip ------------------------------------------------
  const btcTip = await tipHeight();
  const from = before.height + 1;
  const to = Math.min(btcTip, from + 11);
  check(to >= from + 1, `Bitcoin has mined ${btcTip - before.height} block(s) past the fork tip #${before.height}`, failures);
  if (to >= from + 1) {
    const headers = await headersRange(from, to);
    // Move the fork's clock to now so the 2-hour future-timestamp rule sees real time.
    const now = Math.floor(Date.now() / 1000);
    const latest = (await ethers.provider.getBlock("latest")).timestamp;
    if (now > latest) await hre.network.provider.send("evm_setNextBlockTimestamp", [now]);
    const [sender] = await ethers.getSigners();
    const single = headers.slice(0, Math.min(3, headers.length - 1));
    for (const h of single) await (await oracle.connect(sender).submitNextBlock(h)).wait();
    await (await oracle.connect(sender).submitBatchBlocks(headers.slice(single.length))).wait();
    const after = await readOracleState(oracle);
    printState("Oracle after real headers", after);
    check(after.height === to, `real headers ${from}..${to} accepted (${single.length} single + ${headers.length - single.length} batched)`, failures);
    check(after.tipHash.toLowerCase() === headers[headers.length - 1].blockHash.toLowerCase(), "stored tip is the canonical Bitcoin block", failures);
  }

  // --- market rules on the live state -----------------------------------------------------
  await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [MARKET_MAKER] });
  await hre.network.provider.send("hardhat_setBalance", [MARKET_MAKER, "0x56BC75E2D63100000"]);
  const mm = await ethers.getSigner(MARKET_MAKER);
  const cm = (await ethers.getContractAt("ConditionManagerFacet", diamond)).connect(mm);
  const tip = (await oracle.getCurrentBlockHeight()).toNumber();
  const nextPeriod = (Math.floor((tip + 1) / PERIOD) + 1) * PERIOD;
  const salt = ethers.utils.id(`scrum214-rehearsal-${Date.now()}`);

  let err = await expectRevert(cm.callStatic.createConditionWithMetadata(QuestionType.DifficultyThreshold, encode.threshold(1, tip + 2), 2, "rehearsal://current", salt), "OracleAdapter_DifficultyAlreadyDecided");
  check(err === null, `difficulty market in the current period (target ${tip + 2}) is refused${err ? `: ${err}` : ""}`, failures);
  await (await cm.createConditionWithMetadata(QuestionType.DifficultyThreshold, encode.threshold(1, nextPeriod), 2, "rehearsal://next", salt)).wait();
  check((await adapter.getThresholdQuestionsAtBlock(nextPeriod + 6)).length >= 1, `difficulty market for the next period (target ${nextPeriod}) is created`, failures);

  const t = (await ethers.provider.getBlock("latest")).timestamp;
  err = await expectRevert(cm.callStatic.createConditionWithMetadata(QuestionType.BlockCount, encode.blockCount(t + 3600, t + 7200, [100]), 2, "rehearsal://blockcount", salt), "OracleAdapter_QuestionTypeDisabled");
  check(err === null, `BlockCount market is refused${err ? `: ${err}` : ""}`, failures);

  await hre.network.provider.send("evm_increaseTime", [STALENESS + 3600]);
  await hre.network.provider.send("evm_mine");
  err = await expectRevert(cm.callStatic.createConditionWithMetadata(QuestionType.DifficultyThreshold, encode.threshold(2, nextPeriod), 2, "rehearsal://stale", ethers.utils.id("stale")), "OracleAdapter_OracleStale");
  check(err === null, `market creation is refused once the oracle is > ${STALENESS} s stale${err ? `: ${err}` : ""}`, failures);

  // --- exact-retarget input for the next boundary -----------------------------------------
  const boundary = (Math.floor(tip / PERIOD) + 1) * PERIOD;
  const periodStart = boundary - PERIOD;
  const recorded = (await adapter.getBlockTimestamp(periodStart)).toNumber();
  check(recorded > 0, `first-block timestamp of the current period (${periodStart}) is recorded (${recorded}) — boundary ${boundary} will use the exact retarget rule`, failures);

  console.log("\n==========================================================");
  if (failures.length) {
    console.log(`  ❌ REHEARSAL FAILED — ${failures.length} check(s):`);
    failures.forEach((f) => console.log(`     - ${f}`));
    console.log("==========================================================\n");
    process.exit(1);
  }
  console.log("  ✅ REHEARSAL PASSED — the oracle hardening cut is safe on the live mainnet state");
  console.log("==========================================================\n");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\n❌ rehearsal errored:", e);
    process.exit(1);
  });
