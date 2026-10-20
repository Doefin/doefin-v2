/* global ethers */
/**
 * SCRUM-214 — oracle + CTF hardening cut, rehearsed against a fork of Base mainnet or Base Sepolia.
 *
 * Forks the network LOOKBACK blocks in the past (default 3600 ≈ 2 h) so real Bitcoin blocks
 * exist beyond the oracle's tip at the fork point, then:
 *   1. records the live oracle state and every pending question at the known settlement heights;
 *   2. applies upgrade-scrum214-hardening.js with the owner impersonated, including
 *      setMaxOracleStaleness(10800) in the same batch;
 *   3. asserts routing, oracle state, pending questions and the live market's registry entry
 *      are untouched;
 *   4. submits the real headers mined after the fork tip (mempool.space) — one by one, then the
 *      rest as one batch — through the new facet;
 *   5. trades on a live pending market through the new SettlementFacet as the real operator:
 *      a Mint match then a Merge match between two fresh wallets, the Diamond ending with no
 *      outcome tokens and its collateral back where it started; a reordered split mints but
 *      leaves the registry unchanged; voidCondition, legacy createCondition and the resolution
 *      fee cap enforce their new access rules; getResolutionFeeBps reads the live rate for the
 *      live market and 0 for a condition resolved before the cut, even after a fee raise;
 *   6. checks the new market rules on the live state as a real market maker: a difficulty
 *      market for the current period reverts DifficultyAlreadyDecided, one for the next period
 *      is created, BlockCount reverts QuestionTypeDisabled, and creation reverts OracleStale
 *      once the oracle is older than the limit;
 *   7. checks the exact-retarget input for the next boundary (the period's first-block
 *      timestamp) is recorded on-chain.
 *
 * Run:  npm run upgrade:scrum214:rehearse            (Base mainnet fork)
 *       npm run upgrade:scrum214:rehearse:sepolia    (Base Sepolia fork; REHEARSAL_NETWORK=baseSepolia)
 * Needs BASE_MAINNET_RPC_ENDPOINT / BASE_SEPOLIA_RPC_ENDPOINT (archive-capable); FORK_BLOCK_NUMBER
 * pins the fork instead of LOOKBACK. Reads mempool.space (MEMPOOL_API). Never sends anything to a
 * live network.
 */

const hre = require("hardhat");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runUpgrade } = require("./upgrade-scrum214-hardening.js");
const { readOracleState, printState, BASE_MAINNET_DIAMOND, BASE_SEPOLIA_DIAMOND } = require("./upgrade-scrum521-oracle-reorg-underflow.js");
const { tipHeight, headersRange, headerAt } = require("../lib/bitcoin-headers.js");

const QuestionType = { DifficultyThreshold: 0, DifficultyRange: 1, BlockCount: 2, MiningDuration: 3 };
// Per-network inputs; each is overridable by env. `settlements`: the settlement heights of the
// questions pending at the time of writing; `preCutResolved`: a condition resolved while the live
// resolution fee was still 500 bps (each network's only ResolutionFeeUpdated is 500 → 0).
const PROFILES = {
  base: {
    label: "Base mainnet",
    rpcEnv: "BASE_MAINNET_RPC_ENDPOINT",
    diamond: BASE_MAINNET_DIAMOND,
    settlements: "977766,979782,987846",
    preCutResolved: "0xe545b4aa8dbd32aec096d1ad68c36d5acaac545c2ccf0ce78adf2a261dc0e5e2", // resolved at block 50329355
  },
  baseSepolia: {
    label: "Base Sepolia",
    rpcEnv: "BASE_SEPOLIA_RPC_ENDPOINT",
    diamond: BASE_SEPOLIA_DIAMOND,
    settlements: "973734",
    preCutResolved: "0x3d631445aeeada05fd2a09193205dbea9c4f1f36324a574c019ce219fe8829f8", // resolved at block 41959620
  },
};
const NETWORK = process.env.REHEARSAL_NETWORK || "base";
const PROFILE = PROFILES[NETWORK];
if (!PROFILE) throw new Error(`REHEARSAL_NETWORK must be one of ${Object.keys(PROFILES).join(", ")}`);
const MARKET_MAKER = process.env.REHEARSAL_MARKET_MAKER || "0xd0500c4c09fc3f33d3470d647b94294d6259a74c"; // market maker on both networks
const PRE_CUT_RESOLVED = process.env.REHEARSAL_RESOLVED_CONDITION || PROFILE.preCutResolved;
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

async function forkNetwork() {
  const rpc = process.env[PROFILE.rpcEnv];
  if (!rpc) throw new Error(`${PROFILE.rpcEnv} is required to fork ${PROFILE.label}`);
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

// EIP-712 order (CLAUDE.md "EIP-712 Order Signing"; LibDoefinOrder).
const ORDER_TYPE = {
  DoefinOrder: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "positionId", type: "bytes32" },
    { name: "collateralToken", type: "address" },
    { name: "side", type: "uint8" },
    { name: "amount", type: "uint128" },
    { name: "pricePerToken", type: "uint128" },
    { name: "expiration", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
};
const Side = { Buy: 0, Sell: 1 };
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"];

async function impersonate(address) {
  await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [address] });
  await hre.network.provider.send("hardhat_setBalance", [address, "0x56BC75E2D63100000"]);
  return ethers.getSigner(address);
}

/** Set `holder`'s balance of a standard ERC-20 by finding its balance mapping slot (fork only). */
async function deal(tokenAddress, holder, amount) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, ethers.provider);
  const value = ethers.utils.hexZeroPad(amount.toHexString(), 32);
  for (let slot = 0; slot < 100; slot++) {
    for (const [a, b] of [[["address", "uint256"], [holder, slot]], [["uint256", "address"], [slot, holder]]]) {
      const key = ethers.utils.hexStripZeros(ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(a, b)));
      const original = await ethers.provider.send("eth_getStorageAt", [tokenAddress, key, "latest"]);
      await ethers.provider.send("hardhat_setStorageAt", [tokenAddress, key, value]);
      if ((await token.balanceOf(holder)).eq(amount)) return;
      await ethers.provider.send("hardhat_setStorageAt", [tokenAddress, key, ethers.utils.hexZeroPad(original, 32)]);
    }
  }
  throw new Error(`Could not find the balance slot of ${tokenAddress}`);
}

/**
 * CTF fixes on the live state: trade on a real pending market through the new SettlementFacet,
 * check the registry ignores a reordered split, and check the new access rules.
 */
async function ctfChecks({ diamond, conditionId, marketBefore, failures }) {
  const marketData = await ethers.getContractAt("MarketDataFacet", diamond);
  const markets = await marketData.getMarketsByCondition(conditionId);
  check(JSON.stringify(markets) === JSON.stringify(marketBefore), `registry entry of live condition ${conditionId.slice(0, 10)}… unchanged by the cut`, failures);
  const canonical =
    markets.length === 1 && markets[0].parentCollectionId === ethers.constants.HashZero && markets[0].partitions.map(Number).join() === "1,2";
  check(canonical, "live market is a canonical root binary market", failures);
  if (!canonical) return;

  const { collateralToken, positionIds } = markets[0];
  const adminConfig = await ethers.getContractAt("AdminConfigFacet", diamond);
  const unit = await adminConfig.getCollateralUnit(collateralToken);
  const operatorAddress = await (await ethers.getContractAt("SettlementAdminFacet", diamond)).getOperator();
  const settlement = (await ethers.getContractAt("SettlementFacet", diamond)).connect(await impersonate(operatorAddress));
  const erc1155 = await ethers.getContractAt("ERC1155Facet", diamond);
  const ctf = await ethers.getContractAt("ConditionalTokensFacet", diamond);
  const token = new ethers.Contract(collateralToken, ERC20_ABI, ethers.provider);
  const funding = unit.mul(10);
  console.log(`\n  CTF checks on condition ${conditionId} (collateral ${collateralToken}, unit ${unit})`);

  const [alice, bob] = [0, 1].map(() => ethers.Wallet.createRandom().connect(ethers.provider));
  for (const w of [alice, bob]) {
    await hre.network.provider.send("hardhat_setBalance", [w.address, "0x56BC75E2D63100000"]);
    await deal(collateralToken, w.address, funding);
    await (await token.connect(w).approve(diamond, ethers.constants.MaxUint256)).wait();
    // A Merge moves the sellers' outcome tokens with the Diamond as operator.
    await (await erc1155.connect(w).setApprovalForAll(diamond, true)).wait();
  }

  const { chainId } = await ethers.provider.getNetwork();
  const domain = { name: "Doefin Exchange", version: "3", chainId, verifyingContract: diamond };
  const onChainDomain = await (await ethers.getContractAt("SignatureVerifierFacet", diamond)).getDomainSeparator();
  check(ethers.utils._TypedDataEncoder.hashDomain(domain) === onChainDomain, "EIP-712 domain matches the Diamond's", failures);

  let salt = Date.now();
  const order = (maker, positionId, side) => ({
    salt: salt++,
    maker: maker.address,
    signer: maker.address,
    positionId: ethers.utils.hexZeroPad(ethers.BigNumber.from(positionId).toHexString(), 32),
    collateralToken,
    side,
    amount: unit,
    pricePerToken: unit.div(2),
    expiration: 0,
    nonce: 0,
  });
  const match = async (takerOrder, taker, makerOrder, maker) =>
    (
      await settlement.matchOrders(
        takerOrder, await taker._signTypedData(domain, ORDER_TYPE, takerOrder), 0,
        [makerOrder], [await maker._signTypedData(domain, ORDER_TYPE, makerOrder)], [0],
        unit, [unit], [0], [0]
      )
    ).wait();
  const positionsOf = (who) => Promise.all(positionIds.map((id) => erc1155.balanceOf(who, id)));

  const diamondCollateral = await token.balanceOf(diamond);
  const diamondPositions = (await positionsOf(diamond)).map(String);
  let err = null;
  try {
    await match(order(alice, positionIds[0], Side.Buy), alice, order(bob, positionIds[1], Side.Buy), bob);
  } catch (e) {
    err = e.errorName || e.message;
  }
  check(err === null, `Mint match (two buyers, one pair) settles on the live market${err ? `: ${err}` : ""}`, failures);
  if (err === null) {
    const [a0] = await positionsOf(alice.address);
    const [, b1] = await positionsOf(bob.address);
    check(a0.eq(unit) && b1.eq(unit), "each buyer received one pair's worth of its outcome", failures);
    check((await token.balanceOf(diamond)).sub(diamondCollateral).eq(unit), "the Diamond holds the pair's collateral", failures);

    err = null;
    try {
      await match(order(alice, positionIds[0], Side.Sell), alice, order(bob, positionIds[1], Side.Sell), bob);
    } catch (e) {
      err = e.errorName || e.message;
    }
    check(err === null, `Merge match (two sellers, one pair) settles on the live market${err ? `: ${err}` : ""}`, failures);
    const balances = await Promise.all([alice, bob].map((w) => token.balanceOf(w.address)));
    check(balances.every((b) => b.eq(funding)), "both wallets are back to their starting collateral", failures);
    check((await token.balanceOf(diamond)).eq(diamondCollateral), "the Diamond's collateral is back where it started", failures);
    check((await positionsOf(diamond)).map(String).join() === diamondPositions.join(), "the Diamond kept no outcome tokens", failures);
  }

  // A reordered split mints the same tokens but must not rewrite the market (CTF-002).
  await (await ctf.connect(alice).splitPosition(collateralToken, ethers.constants.HashZero, conditionId, [2, 1], unit)).wait();
  const afterReordered = await marketData.getMarketsByCondition(conditionId);
  check(JSON.stringify(afterReordered) === JSON.stringify(marketBefore), "a reordered [2, 1] split leaves the registry unchanged", failures);
  await (await ctf.connect(alice).mergePositions(collateralToken, ethers.constants.HashZero, conditionId, [1, 2], unit)).wait();

  // New access rules (CTF-005 / CTF-006 / CTF-007).
  const owner = await impersonate(await (await ethers.getContractAt("OwnershipFacet", diamond)).owner());
  const cm = await ethers.getContractAt("ConditionManagerFacet", diamond);
  err = await expectRevert(cm.connect(alice).callStatic.voidCondition(conditionId), "NotContractOwner");
  check(err === null, `voidCondition is owner-only${err ? `: ${err}` : ""}`, failures);
  err = await expectRevert(cm.connect(owner).callStatic.voidCondition(conditionId), "ConditionStillActive");
  check(err === null, `voidCondition refuses a live (not cancelled) condition${err ? `: ${err}` : ""}`, failures);
  const mm = await impersonate(MARKET_MAKER);
  err = await expectRevert(cm.connect(mm).callStatic.createCondition(mm.address, ethers.utils.id("rehearsal-legacy"), 2, "rehearsal://legacy"), "NotContractOwner");
  check(err === null, `legacy createCondition (resolver of the caller's choice) is owner-only${err ? `: ${err}` : ""}`, failures);
  err = await expectRevert(adminConfig.connect(owner).callStatic.setResolutionFeeBps(501), "FeeTooHigh");
  check(err === null, `resolution fee above 500 bps is refused${err ? `: ${err}` : ""}`, failures);

  // Per-condition fee (CTF-007): a pre-cut resolution has no snapshot and is charged 0 — also after a raise.
  const [, liveFee] = await adminConfig.getFees();
  check((await adminConfig.getResolutionFeeBps(conditionId)) === liveFee, `getResolutionFeeBps(live market) = the live rate (${liveFee} bps)`, failures);
  const raised = liveFee === 500 ? 400 : 500;
  await (await adminConfig.connect(owner).setResolutionFeeBps(raised)).wait();
  const preCutFee = await adminConfig.getResolutionFeeBps(PRE_CUT_RESOLVED);
  check(preCutFee === 0, `a condition resolved before the cut (${PRE_CUT_RESOLVED.slice(0, 10)}…) is charged 0 after the fee is raised to ${raised} bps (got ${preCutFee})`, failures);
  check((await adminConfig.getResolutionFeeBps(conditionId)) === raised, `the unresolved live market would capture the raised rate (${raised} bps)`, failures);
  await (await adminConfig.connect(owner).setResolutionFeeBps(liveFee)).wait();
}

async function main() {
  if (hre.network.name !== "hardhat") throw new Error(`Run on the in-process hardhat network (the script forks ${PROFILE.label} itself)`);
  const forkBlock = await forkNetwork();
  const diamond = PROFILE.diamond;
  if ((await ethers.provider.getCode(diamond)) === "0x") throw new Error("No Diamond bytecode — fork failed");

  const oracle = await ethers.getContractAt("IDoefinBlockHeaderOracle", diamond);
  const adapter = await ethers.getContractAt("OracleAdapterFacet", diamond);
  const failures = [];

  console.log("==========================================================");
  console.log(`  SCRUM-214 — oracle + CTF hardening, ${PROFILE.label} fork rehearsal`);
  console.log("==========================================================");
  console.log(`  Fork block ${forkBlock}  Diamond ${diamond}`);
  const before = await readOracleState(oracle);
  printState("Oracle at fork", before);

  // The new facet validates every header against data the old facet stored (MTP window, retarget
  // period start): every stored header must be on the real chain with its real timestamp recorded.
  const ring = await (await ethers.getContractAt("DoefinV1BlockHeaderOracle", diamond)).getAllBlockHeaders();
  let ringBad = 0;
  for (const h of ring.filter((x) => x.blockNumber.toNumber() > 0)) {
    const real = await headerAt(h.blockNumber.toNumber());
    const recordedTs = (await adapter.getBlockTimestamp(h.blockNumber)).toNumber();
    if (real.blockHash.toLowerCase() !== h.blockHash.toLowerCase() || recordedTs !== Number(real.timestamp)) ringBad++;
  }
  check(ringBad === 0, `all ${ring.length} stored headers are canonical Bitcoin blocks with their real timestamps recorded (${ringBad} mismatched)`, failures);

  // Pending threshold questions at the settlement heights live today (audit/findings-ledger.md ORACLE).
  const settlementHeights = (process.env.REHEARSAL_SETTLEMENTS || PROFILE.settlements).split(",").map(Number);
  const pendingBefore = {};
  for (const h of settlementHeights) pendingBefore[h] = (await adapter.getThresholdQuestionsAtBlock(h)).map((q) => q.questionId);
  console.log(`  Pending threshold questions: ${settlementHeights.map((h) => `${h}: ${pendingBefore[h].length}`).join(", ")}`);

  // Live market for the CTF checks: a pending question with a registered (seeded) market, taken
  // from the latest settlement height first so it stays unresolved throughout.
  const marketData = await ethers.getContractAt("MarketDataFacet", diamond);
  let liveQuestion;
  let marketBefore;
  for (const h of [...settlementHeights].sort((a, b) => b - a)) {
    for (const q of await adapter.getThresholdQuestionsAtBlock(h)) {
      const markets = await marketData.getMarketsByCondition(q.conditionId);
      if (markets.length) [liveQuestion, marketBefore] = [q, markets];
      if (liveQuestion) break;
    }
    if (liveQuestion) break;
  }
  if (!liveQuestion) throw new Error("No pending question with a registered market at the listed heights — set REHEARSAL_SETTLEMENTS");

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
  // Real headers past the fork tip, fetched now: the first lands between the cut and the
  // post-check — as the block-indexer's would during a live ceremony — to exercise the post-check's
  // tolerance; the record is written to a temp dir and read back.
  const btcTip = await tipHeight();
  const from = before.height + 1;
  const to = Math.min(btcTip, from + 11);
  const headers = to >= from + 1 ? await headersRange(from, to) : [];
  const [sender] = await ethers.getSigners();
  const syncClock = async () => {
    // Move the fork's clock to now so the 2-hour future-timestamp rule sees real time.
    const now = Math.floor(Date.now() / 1000);
    if (now > (await ethers.provider.getBlock("latest")).timestamp) await hre.network.provider.send("evm_setNextBlockTimestamp", [now]);
  };
  const recordDir = fs.mkdtempSync(path.join(os.tmpdir(), "scrum214-rehearsal-"));
  await runUpgrade({
    diamond,
    impersonateOwner: true,
    skipVerify: true,
    record: true,
    recordDir,
    maxOracleStaleness: STALENESS,
    afterCut: async () => {
      if (!headers.length) return;
      await syncClock();
      await (await oracle.connect(sender).submitNextBlock(headers[0])).wait();
      console.log(`  (rehearsal: a header #${from} lands between the cut and the post-check, as the block-indexer's would)`);
    },
  });
  const rec = JSON.parse(fs.readFileSync(path.join(recordDir, fs.readdirSync(recordDir)[0]), "utf8"));
  check(rec.postCheck && rec.postCheck.ok === true, `deployment record written, post-check passed (${((rec.postCheck && rec.postCheck.notes) || []).join("; ") || "no live activity"})`, failures);
  check(!headers.length || (rec.postCheck.notes || []).some((n) => n.includes("oracle advanced")), "the post-check tolerated the oracle advancing during the ceremony", failures);
  check(Object.keys(rec.previousRouting).length === 51 && rec.gitCommit && rec.cutBlock, `record carries commit ${String(rec.gitCommit).slice(0, 7)}, cut block ${rec.cutBlock} and the previous routing of ${Object.keys(rec.previousRouting).length} selectors`, failures);

  for (const h of settlementHeights) {
    const now = (await adapter.getThresholdQuestionsAtBlock(h)).map((q) => q.questionId);
    check(JSON.stringify(now) === JSON.stringify(pendingBefore[h]), `pending questions at ${h} unchanged (${now.length})`, failures);
  }

  // --- real headers past the fork tip ------------------------------------------------
  check(to >= from + 1, `Bitcoin has mined ${btcTip - before.height} block(s) past the fork tip #${before.height}`, failures);
  if (to >= from + 1) {
    // headers[0] was submitted inside the ceremony (afterCut); the rest go one by one, then batched.
    await syncClock();
    const rest = headers.slice(1);
    const single = rest.slice(0, Math.min(2, rest.length - 1));
    for (const h of single) await (await oracle.connect(sender).submitNextBlock(h)).wait();
    await (await oracle.connect(sender).submitBatchBlocks(rest.slice(single.length))).wait();
    const after = await readOracleState(oracle);
    printState("Oracle after real headers", after);
    check(after.height === to, `real headers ${from}..${to} accepted (${single.length + 1} single + ${rest.length - single.length} batched)`, failures);
    check(after.tipHash.toLowerCase() === headers[headers.length - 1].blockHash.toLowerCase(), "stored tip is the canonical Bitcoin block", failures);
  }

  // --- CTF fixes on the live state ----------------------------------------------------------
  await ctfChecks({ diamond, conditionId: liveQuestion.conditionId, marketBefore, failures });

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
  const realStart = Number((await headerAt(periodStart)).timestamp);
  check(
    recorded === realStart,
    `first-block timestamp of the current period (${periodStart}) is recorded and equals the real header (${recorded} vs ${realStart}) — boundary ${boundary} will retarget from correct data`,
    failures
  );

  console.log("\n==========================================================");
  if (failures.length) {
    console.log(`  ❌ REHEARSAL FAILED — ${failures.length} check(s):`);
    failures.forEach((f) => console.log(`     - ${f}`));
    console.log("==========================================================\n");
    process.exit(1);
  }
  console.log(`  ✅ REHEARSAL PASSED — the oracle + CTF hardening cut is safe on the live ${PROFILE.label} state`);
  console.log("==========================================================\n");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\n❌ rehearsal errored:", e);
    process.exit(1);
  });
