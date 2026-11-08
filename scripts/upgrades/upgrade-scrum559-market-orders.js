/* global ethers */
/* eslint prefer-const: "off" */
/**
 * SCRUM-560 — ship the SCRUM-559 market-order SettlementFacet to Base Sepolia.
 *
 * The change: a taker whose signed salt carries the market-order marker has its signed price
 * enforced as the all-in average for the settlement. Limit takers keep the per-fill check. A marked
 * order can never be a maker or go through fillOrder. A Complementary seller's fee comes out of
 * proceeds, so no seller allowance is needed. No new function, event, view, type or storage, so no
 * _init and no migration.
 *
 * The cut: Replace 3 selectors (fillOrder, getFilledAmount, matchOrders), Add 0. That is the facet's
 * whole ABI, and the script refuses any other plan.
 *
 * Base Sepolia only. Base mainnet is refused by network name, chain ID and Diamond address: this
 * ticket does not cover it, and mainnet needs SCRUM-214 there first and a delta audit.
 *
 * RUNBOOK (the live run is a separate decision; none of these steps have been run live)
 *
 * Nothing on-chain checks the facet version. A facet not yet upgraded settles a marked order and
 * overcharges it (signed 400000, charged 401600) instead of reverting. So MARKET_ORDERS_ENABLED stays
 * "false" on staging until every step below is done. It is MarketOrdersEnabled in
 * cloudformation-templates environments/ApiServiceEcsConfig-194722425547.json and
 * MatchEngineServiceConfig-194722425547.json. Trading does not need pausing: the cut is one atomic
 * transaction, and a limit order signed before it settles after it.
 *
 *   1. Commit the contracts and these scripts, so the record names the code. In .env:
 *      BASE_SEPOLIA_RPC_ENDPOINT, ETHERSCAN_API_KEY, SAFE_ADDRESS=0x01249C1cCb65d67f6490D6FC45ee0592d5c3cC37
 *      and PRIVATE_KEY, which must be a signer on that Safe (1-of-1 when this was written, signer
 *      0x4EB98f6284C41142f8bEc04Bdb08A75f37592894) and pays for the deployment and the execution.
 *   2. npm run upgrade:scrum559:rehearse:sepolia
 *      Every check must PASS. Note the printed build id and facet runtime keccak.
 *   3. DRY_RUN=true npm run upgrade:scrum559:baseSepolia
 *      Sends nothing but does query the Safe service. Confirm Replace 3, Add 0, the old facet
 *      0x67BeccD695B7725AC16ee0f0279b94d75c950402, no queued Safe proposal, and the same build id and
 *      runtime keccak as step 2.
 *   4. npm run upgrade:scrum559:baseSepolia
 *      Deploys the facet, verifies it, then proposes and executes the cut through the Safe. Above a
 *      threshold of 1 it waits for the other signers to confirm in the Safe app. It writes the record
 *      and the kept build-info under deployments/baseSepolia/ as soon as the cut is mined, and exits
 *      non-zero after that if the post-check finds a problem. To resume after a failure between the
 *      deployment and the cut, export the printed NEW_SETTLEMENT_FACET_ADDRESS.
 *   5. Confirm the routing with a tool other than this script:
 *        cast call 0x2f03d47520fb8bc8aDAab392BF280D99De7cAe3f "facetAddress(bytes4)(address)" 0xe81d20c4 \
 *          --rpc-url https://base-sepolia-rpc.publicnode.com
 *      It must print facets.settlement from the record, and not 0x67Be...0402.
 *   6. Commit the record and the build-info.
 *   7. Only now may MARKET_ORDERS_ENABLED be switched on, in SCRUM-569, after that ticket's scans of
 *      open orders and active makers.
 *
 * ROLLBACK, in this order, because reversing it overcharges market orders still in flight
 * (rollback-scrum559-market-orders.js has the detail):
 *   1. Switch MARKET_ORDERS_ENABLED off on the API and the match engine.
 *   2. Wait out expiry plus a margin: MARKET_ORDER_TTL_SECONDS (default 60 s) plus 5 minutes.
 *   3. Close every marked order still open, in any open status and at expiry 0 too (the query is in
 *      the rollback script's header).
 *   4. Export the open sellers to a file (query in the rollback script's header). The previous facet
 *      takes a seller's fee from the seller's own balance, so the rollback refuses while an open
 *      seller has no ERC-20 allowance, unless SELLERS_WITHOUT_ALLOWANCE_ACCEPTED=true.
 *   5. ROLLBACK_RECORD=deployments/baseSepolia/scrum559-market-orders-<timestamp>.json \
 *      ROLLBACK_SELLERS=sellers.csv MARKET_ORDERS_OFF_CONFIRMED=true npm run upgrade:scrum559:rollback:baseSepolia
 *   6. The cast call in step 5 must print the previous facet again. Commit the rollback record.
 *
 * What the script does:
 *   1. Pre-flight, with nothing sent until all of it passes: network and chain ID, Diamond, owner, git
 *      provenance, a clean build, the cut plan, the cut not already applied, the settlement state,
 *      and on the Safe route the Safe service and the deployer's balance.
 *   2. Deploys SettlementFacet, or reuses NEW_SETTLEMENT_FACET_ADDRESS. Either way the address must
 *      carry exactly the compiled runtime code.
 *   3. One diamondCut with no _init. Route, the same as the SCRUM-214 script: impersonated owner on a
 *      local fork, Safe MultiSend when owner() is a contract, direct when the deployer owns the Diamond.
 *   4. On a real run only, writes deployments/<network>/scrum559-market-orders-<timestamp>.json as soon
 *      as the cut is mined, with previousRouting for a rollback and the build-info kept beside it.
 *   5. Post-check: the three selectors route to the new facet and no other selector moved; operator,
 *      pause flag, fee settings, units and domain are unchanged; accrued fees may only rise (a live
 *      settlement can land during the ceremony). Results go in the record, and a failed check exits
 *      non-zero AFTER the record is written.
 *
 * Why a clean build: compile scope changes the bytes for identical source, so a partial compile
 * deploys a facet nobody can reproduce or audit. `npx hardhat run` recompiles only what changed, so
 * the npm scripts clean first and run with --no-compile, and the pre-flight refuses anything else:
 * exactly one build-info, covering every source under contracts/, matching the files on disk and the
 * compiler settings in hardhat.config.js.
 *
 * Env:
 *   BASE_SEPOLIA_RPC_ENDPOINT
 *   SAFE_ADDRESS, PRIVATE_KEY       Safe route (see upgrade-scrum521-oracle-reorg-underflow.js)
 *   NEW_SETTLEMENT_FACET_ADDRESS    optional, reuse a deployed facet of this exact build
 *   SKIP_VERIFY=true, DRY_RUN=true
 *
 * Usage:
 *   npm run upgrade:scrum559:rehearse:sepolia   (local fork, see rehearse-scrum559-fork.js)
 *   npm run upgrade:scrum559:baseSepolia
 */

const hre = require("hardhat");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { execSync } = require("child_process");
const { proposeAndExecute, safePreflight, safeNetworkPrefix } = require("../lib/safe-multisend.js");
const { networkConfig, resolveDiamond, BASE_MAINNET_DIAMOND, BASE_SEPOLIA_DIAMOND } = require("./upgrade-scrum521-oracle-reorg-underflow.js");

const FacetCutAction = { Add: 0, Replace: 1, Remove: 2 };
const FACET_NAME = "SettlementFacet";
const BASE_MAINNET_CHAIN_ID = 8453;
const MAX_RUNTIME_BYTES = 24576; // EIP-170
const MIN_DEPLOYER_BALANCE = ethers.utils.parseEther("0.001"); // one deployment and the Safe execution on Base
const POST_CHECK_ATTEMPTS = 10;
const POST_CHECK_DELAY_MS = 3000;

/** SettlementFacet's whole ABI, and everything this cut moves. */
const CUT_SELECTORS = { fillOrder: "0xe3fe8744", getFilledAmount: "0xcc527775", matchOrders: "0xe81d20c4" };
/** The collaterals allow-listed on the Base Sepolia Diamond. There is no on-chain list to read. */
const COLLATERALS = { mUSDT: "0x290F9Aa4641E58A5E098e8860161Ab6B5df5C557", mWBTC: "0x41f8d70aC28C340c5D3038FB987ab2CC985b13A9" };

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function impersonate(address) {
  await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [address] });
  await hre.network.provider.send("hardhat_setBalance", [address, "0x56BC75E2D63100000"]); // 100 ETH
  return ethers.getSigner(address);
}

/** Read `fn` at the latest block until `accept` holds (RPC replicas lag a few hundred ms behind). */
async function pollUntil(fn, accept, local) {
  let value = await fn();
  for (let attempt = 1; !accept(value) && !local && attempt <= POST_CHECK_ATTEMPTS; attempt++) {
    await sleep(POST_CHECK_DELAY_MS);
    value = await fn();
  }
  return value;
}

function refuseMainnet({ name, chainId, diamond }) {
  const hits = [];
  if (name === "base") hits.push(`network "${name}"`);
  if (chainId !== undefined && Number(chainId) === BASE_MAINNET_CHAIN_ID) hits.push(`chain ID ${BASE_MAINNET_CHAIN_ID}`);
  if (diamond && diamond.toLowerCase() === BASE_MAINNET_DIAMOND.toLowerCase()) hits.push(`Diamond ${BASE_MAINNET_DIAMOND}`);
  if (hits.length) {
    throw new Error(`Refusing Base mainnet (${hits.join(", ")}). SCRUM-560 covers Base Sepolia only: mainnet needs SCRUM-214 there first and a delta audit.`);
  }
}

/** Network, chain ID and Diamond. The name is checked first: that needs no RPC, so it holds before anything can be sent. */
async function resolveTarget(opts = {}) {
  const cfg = networkConfig();
  refuseMainnet({ name: cfg.name });
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  refuseMainnet({ name: cfg.name, chainId });
  if (cfg.chainId !== null && chainId !== cfg.chainId) {
    throw new Error(`Expected chainId ${cfg.chainId} for network "${cfg.name}", provider reports ${chainId}`);
  }
  const diamond = opts.diamond || (await resolveDiamond(cfg));
  refuseMainnet({ name: cfg.name, chainId, diamond });
  // One Diamond is in scope. A stale DIAMOND_ADDRESS leaking from .env must not redirect a live cut.
  if (!cfg.local && diamond.toLowerCase() !== BASE_SEPOLIA_DIAMOND.toLowerCase()) {
    throw new Error(`SCRUM-560 cuts only the Base Sepolia Diamond ${BASE_SEPOLIA_DIAMOND}, not ${diamond}. Is a stale DIAMOND_ADDRESS leaking from .env?`);
  }
  if ((await ethers.provider.getCode(diamond)) === "0x") throw new Error(`No bytecode at Diamond ${diamond} on ${cfg.name}`);
  return { cfg, chainId, diamond };
}

/** Git provenance of the code being deployed (the record must say exactly what went on-chain). */
function gitProvenance() {
  try {
    const commit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    const dirty = execSync("git status --porcelain -- contracts scripts hardhat.config.js package.json", { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    return { commit, dirty };
  } catch (e) {
    return { commit: "unknown", dirty: [`git unavailable: ${e.message}`] };
  }
}

/** Every Solidity file under `dir`, named the way a build's input names it. */
function listSources(dir = hre.config.paths.sources, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listSources(full, out);
    else if (entry.name.endsWith(".sol")) out.push(path.relative(hre.config.paths.root, full).split(path.sep).join("/"));
  }
  return out;
}

/** A build input's source as it is on disk today, or null if it is gone. */
function readSource(sourceName) {
  const root = hre.config.paths.root;
  const file = sourceName.startsWith("contracts/") ? path.join(root, sourceName) : path.join(root, "node_modules", sourceName);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

const configuredCompiler = () => hre.config.solidity.compilers[0];

/** Why this build cannot be deployed from. Empty means it is clean. */
function buildProblems({ buildInfoCount, info, artifact, onDisk, readSource: read, compiler }) {
  const problems = [];
  if (buildInfoCount !== 1) problems.push(`${buildInfoCount} build-info files, a clean build leaves exactly one`);
  if (info.solcVersion !== compiler.version) problems.push(`built with solc ${info.solcVersion}, hardhat.config.js has ${compiler.version}`);
  if (JSON.stringify(info.input.settings) !== JSON.stringify(compiler.settings)) problems.push("compiler settings differ from hardhat.config.js");
  const inBuild = info.input.sources;
  const left = onDisk.filter((s) => !inBuild[s]);
  if (left.length) problems.push(`sources left out of the build (a partial compile): ${left.join(", ")}`);
  const stale = Object.keys(inBuild).filter((s) => read(s) !== inBuild[s].content);
  if (stale.length) problems.push(`sources changed since the build: ${stale.join(", ")}`);
  const built = info.output.contracts[artifact.sourceName]?.[artifact.contractName];
  if (!built) problems.push(`${artifact.sourceName}:${artifact.contractName} is not in the build's output`);
  else if (`0x${built.evm.deployedBytecode.object}` !== artifact.deployedBytecode) problems.push(`the ${artifact.contractName} artifact does not match the build's output`);
  return problems;
}

/** The clean build to deploy from, or a refusal naming what is wrong with what is there. */
async function readCleanBuild() {
  const remedy = "Run: npx hardhat clean && npx hardhat compile (the npm scripts do this), then run with --no-compile.";
  const dir = path.join(hre.config.paths.artifacts, "build-info");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
  if (files.length !== 1) throw new Error(`Not a clean build: ${files.length} build-info files, a clean build leaves exactly one. ${remedy}`);
  const file = path.join(dir, files[0]);
  const raw = fs.readFileSync(file);
  const info = JSON.parse(raw);
  const artifact = await hre.artifacts.readArtifact(FACET_NAME);
  const problems = buildProblems({ buildInfoCount: files.length, info, artifact, onDisk: listSources(), readSource, compiler: configuredCompiler() });
  if (problems.length) throw new Error(`Not a clean build:\n    - ${problems.join("\n    - ")}\n  ${remedy}`);
  const facetBytes = (artifact.deployedBytecode.length - 2) / 2;
  if (facetBytes > MAX_RUNTIME_BYTES) throw new Error(`${FACET_NAME} is ${facetBytes} bytes, over the ${MAX_RUNTIME_BYTES} byte limit`);
  return {
    id: info.id,
    file,
    solc: info.solcLongVersion,
    sources: Object.keys(info.input.sources).length,
    sha256: crypto.createHash("sha256").update(raw).digest("hex"),
    facetBytes,
    facetInitBytes: (artifact.bytecode.length - 2) / 2,
    facetRuntimeKeccak: ethers.utils.keccak256(artifact.deployedBytecode),
  };
}

function selectorsOf(factory) {
  return Object.values(factory.interface.functions)
    .filter((f) => f.type === "function")
    .map((f) => ({ name: f.name, selector: factory.interface.getSighash(f).toLowerCase() }));
}

/** Replace / Add plan for the facet, plus any selector the new ABI would strand on the old facet. */
async function planCut(loupe, factory) {
  const selectors = selectorsOf(factory);
  const replace = [];
  const add = [];
  const oldFacets = new Set();
  const previous = {};
  for (const s of selectors) {
    const current = (await loupe.facetAddress(s.selector)).toLowerCase();
    previous[s.selector] = current;
    if (current === ethers.constants.AddressZero) add.push(s);
    else {
      replace.push(s);
      oldFacets.add(current);
    }
  }
  const mine = new Set(selectors.map((s) => s.selector));
  const stranded = [];
  for (const f of oldFacets) {
    for (const sel of await loupe.facetFunctionSelectors(f)) {
      if (!mine.has(sel.toLowerCase())) stranded.push({ facet: f, selector: sel.toLowerCase() });
    }
  }
  return { selectors, replace, add, oldFacets: [...oldFacets], stranded, previous };
}

/** How a plan differs from Replace 3, Add 0. Empty means it is the planned cut. */
function planProblems(plan) {
  const label = (s) => `${s.name} ${s.selector}`;
  const want = Object.entries(CUT_SELECTORS).map(([name, selector]) => label({ name, selector })).sort().join(", ");
  const got = plan.replace.map(label).sort().join(", ");
  const problems = [];
  if (got !== want) problems.push(`Replace is [${got}], expected [${want}]`);
  if (plan.add.length) problems.push(`Add ${plan.add.length} [${plan.add.map(label).join(", ")}], expected 0`);
  if (plan.oldFacets.length !== 1) problems.push(`the selectors sit on ${plan.oldFacets.length} facets, expected one`);
  if (plan.stranded.length) problems.push(`${plan.stranded.length} selector(s) on the old facet are not in the new ABI: ${plan.stranded.map((s) => s.selector).join(", ")}`);
  return problems;
}

/** selector → facet for every selector the Diamond routes, independent of the loupe's ordering. */
async function readRouting(loupe) {
  const routing = {};
  for (const facet of await loupe.facets()) {
    for (const sel of facet.functionSelectors) routing[sel.toLowerCase()] = facet.facetAddress.toLowerCase();
  }
  return routing;
}

/** The selectors whose route differs between two readRouting results. */
function routingDiff(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((sel) => before[sel] !== after[sel]).sort();
}

/** What a cut must not touch, plus accrued fees, read at one block when `blockTag` is given. */
async function readState(diamond, blockTag) {
  const o = blockTag === undefined ? {} : { blockTag };
  const [admin, config, verifier] = await Promise.all(["SettlementAdminFacet", "AdminConfigFacet", "SignatureVerifierFacet"].map((n) => ethers.getContractAt(n, diamond)));
  const [operator, paused, maxFeeRateBps, [feeReceiver, resolutionFeeBps], domainSeparator] = await Promise.all([
    admin.getOperator(o),
    admin.isTradingPaused(o),
    config.getMaxFeeRate(o),
    config.getFees(o),
    verifier.getDomainSeparator(o),
  ]);
  const units = {};
  const accruedFees = {};
  for (const [symbol, token] of Object.entries(COLLATERALS)) {
    units[symbol] = (await config.getCollateralUnit(token, o)).toString();
    accruedFees[symbol] = (await config.getAccruedFees(token, o)).toString();
  }
  return { operator, paused, maxFeeRateBps, feeReceiver, resolutionFeeBps, domainSeparator, units, accruedFees };
}

/**
 * Compare state around a cut. The cut has no _init, so it writes none of this. Only the owner Safe can
 * change the settings, while a live settlement can raise accrued fees in the same window, so a rise is
 * noted, and a fall (owner-only withdrawFees) or a changed setting is a problem.
 */
function compareAroundCut(before, after) {
  const notes = [];
  const problems = [];
  for (const k of ["operator", "paused", "maxFeeRateBps", "feeReceiver", "resolutionFeeBps", "domainSeparator"]) {
    if (before[k] !== after[k]) problems.push(`${k} changed ${before[k]} → ${after[k]}`);
  }
  if (JSON.stringify(before.units) !== JSON.stringify(after.units)) problems.push(`collateral units changed ${JSON.stringify(before.units)} → ${JSON.stringify(after.units)}`);
  for (const symbol of Object.keys(before.accruedFees)) {
    const [was, now] = [BigInt(before.accruedFees[symbol]), BigInt(after.accruedFees[symbol])];
    if (now < was) problems.push(`accrued ${symbol} fees went DOWN ${was} → ${now}`);
    else if (now > was) notes.push(`accrued ${symbol} fees rose ${was} → ${now} (live settlement)`);
  }
  return { notes, problems };
}

/** State just before the cut block against now, falling back to the pre-flight read on an RPC without that history. */
async function compareStateAroundCut(diamond, cutBlock, preflight) {
  let before;
  try {
    before = await readState(diamond, cutBlock - 1);
  } catch (e) {
    console.warn(`  ⚠ historical read at block ${cutBlock - 1} failed (${e.message.slice(0, 80)}); comparing with the pre-flight state`);
    before = preflight;
  }
  const after = await readState(diamond);
  return { around: { before, after }, ...compareAroundCut(before, after) };
}

function writeRecord(file, summary) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(summary, null, 2) + "\n");
}

/**
 * How the cut reaches the Diamond, checked before anything is sent. `opts.safeClient` is the
 * rehearsal's hook: { preflight, proposeAndExecute } running against the fork, so the Safe route's
 * code runs without the Safe service.
 */
async function chooseRoute({ cfg, chainId, owner, deployer, minBalance, safeClient }) {
  let mode;
  if (safeClient) mode = "safe";
  else if (cfg.local) mode = "impersonate";
  else if ((await ethers.provider.getCode(owner)) !== "0x") {
    mode = "safe";
    const safeAddress = process.env.SAFE_ADDRESS;
    if (!safeAddress) throw new Error("Diamond owner is a contract (Safe) — set SAFE_ADDRESS");
    if (safeAddress.toLowerCase() !== owner.toLowerCase()) throw new Error(`SAFE_ADDRESS ${safeAddress} ≠ Diamond owner ${owner}`);
    if (!process.env.PRIVATE_KEY || !deployer) throw new Error("PRIVATE_KEY (a Safe signer) is required for the Safe ceremony");
    if (!process.env[cfg.rpcEnv]) throw new Error(`${cfg.rpcEnv} is required for the Safe SDK`);
    const safe = new ethers.Contract(owner, ["function getOwners() view returns (address[])"], ethers.provider);
    if (!(await safe.getOwners()).map((o) => o.toLowerCase()).includes(deployer.address.toLowerCase())) {
      throw new Error(`Deployer ${deployer.address} is not a signer on Safe ${owner}`);
    }
  } else if (deployer && owner.toLowerCase() === deployer.address.toLowerCase()) {
    mode = "direct";
  } else {
    throw new Error(`Diamond owner ${owner} is an EOA that is not the deployer ${deployer ? deployer.address : "(no PRIVATE_KEY)"} — cannot cut`);
  }
  if (mode === "safe") {
    // Discover Safe service problems before deploying anything.
    const preflight = safeClient ? safeClient.preflight : safePreflight;
    const sp = await preflight({ safeAddress: owner, chainId, signer: deployer.address });
    console.log(`  Safe:      ${sp.threshold}-of-${sp.owners.length}, nonce ${sp.nonce}, v${sp.version}, queued proposals ${sp.pending}`);
    if (!sp.isOwner) throw new Error(`Deployer ${deployer.address} is not an owner per the Safe service`);
    if (sp.pending > 0) throw new Error(`The Safe has ${sp.pending} queued proposal(s); execute or reject them first — a new proposal would share their nonce`);
  }
  if (!cfg.local) {
    const balance = await deployer.getBalance();
    if (balance.lt(minBalance)) throw new Error(`Deployer ${deployer.address} has ${ethers.utils.formatEther(balance)} ETH; need at least ${ethers.utils.formatEther(minBalance)}`);
    console.log(`  Balance:   ${ethers.utils.formatEther(balance)} ETH`);
  }
  return mode;
}

/** Send one diamondCut by the chosen route. Returns once it is mined. */
async function sendCut({ mode, cfg, chainId, owner, deployer, transaction, label, safeClient }) {
  if (mode === "safe") {
    const result = safeClient
      ? await safeClient.proposeAndExecute({ safeAddress: owner, transactions: [transaction], label })
      : await proposeAndExecute({ safeAddress: owner, chainId, rpcUrl: process.env[cfg.rpcEnv], signerKey: process.env.PRIVATE_KEY, transactions: [transaction], label });
    return { cutTxHash: result.executionTxHash, cutBlock: result.blockNumber, safeTxHash: result.safeTxHash };
  }
  const sender = mode === "impersonate" ? await impersonate(owner) : deployer;
  const receipt = await (await sender.sendTransaction(transaction)).wait();
  if (receipt.status !== 1) throw new Error(`tx ${receipt.transactionHash} reverted`);
  console.log(`  tx ${receipt.transactionHash} (block ${receipt.blockNumber}, gas ${receipt.gasUsed.toString()})`);
  return { cutTxHash: receipt.transactionHash, cutBlock: receipt.blockNumber, safeTxHash: null };
}

/** An address must carry exactly the compiled runtime code — reused or freshly deployed. */
async function assertFacetCode(address) {
  const [live, artifact] = await Promise.all([ethers.provider.getCode(address), hre.artifacts.readArtifact(FACET_NAME)]);
  if (live.toLowerCase() !== artifact.deployedBytecode.toLowerCase()) {
    throw new Error(`${address} does not carry the compiled ${FACET_NAME} bytecode — wrong or stale address`);
  }
}

async function verifyOnExplorer(address) {
  try {
    await hre.run("verify:verify", { address, constructorArguments: [] });
    console.log(`  ✔ verified ${address}`);
  } catch (err) {
    console.warn(`  ⚠ verification FAILED for ${address}: ${err.message} — verify manually (CR-HARDHAT-VERIFY)`);
  }
}

async function deployFacet(factory, { reuse, local, skipVerify }) {
  if (reuse) {
    await assertFacetCode(reuse);
    console.log(`  Reusing ${FACET_NAME} at ${reuse} (bytecode matches this build)`);
    return reuse;
  }
  const c = await factory.deploy();
  await c.deployed();
  if (!local) await c.deployTransaction.wait(2);
  await pollUntil(() => ethers.provider.getCode(c.address), (code) => code !== "0x", local);
  await assertFacetCode(c.address);
  console.log(`  Deployed ${FACET_NAME} at ${c.address}   (to resume: export NEW_SETTLEMENT_FACET_ADDRESS=${c.address})`);
  if (!skipVerify) await verifyOnExplorer(c.address);
  return c.address;
}

/**
 * @param {object} opts
 * @param {string}   [opts.diamond]
 * @param {string}   [opts.facetAddress]  reuse a deployed facet (default: NEW_SETTLEMENT_FACET_ADDRESS)
 * @param {boolean}  [opts.skipVerify]
 * @param {boolean}  [opts.dryRun]
 * @param {string}   [opts.recordDir]     rehearsal only: write the record here. On a local network with
 *                                        no recordDir nothing is written; a public network always records.
 * @param {object}   [opts.safeClient]    rehearsal only, see chooseRoute
 * @param {Function} [opts.afterCut]      rehearsal hook: runs after the cut is mined, before the
 *                                        post-check (simulates a live settlement moving state)
 */
async function runUpgrade(opts = {}) {
  const { cfg, chainId, diamond } = await resolveTarget(opts);
  const skipVerify = opts.skipVerify ?? (cfg.local || process.env.SKIP_VERIFY === "true");
  const dryRun = opts.dryRun ?? process.env.DRY_RUN === "true";
  const record = Boolean(opts.recordDir) || !cfg.local;
  const reuse = opts.facetAddress ?? process.env.NEW_SETTLEMENT_FACET_ADDRESS;

  const provenance = gitProvenance();
  if (provenance.dirty.length && !cfg.local) console.warn(`  ⚠ uncommitted changes under contracts/ or scripts/:\n    ${provenance.dirty.join("\n    ")}`);
  const build = await readCleanBuild();

  const [deployer] = await ethers.getSigners();
  const ownership = await ethers.getContractAt("OwnershipFacet", diamond);
  const loupe = await ethers.getContractAt("IDiamondLoupe", diamond);
  const diamondCut = await ethers.getContractAt("IDiamondCut", diamond);
  const adminConfig = await ethers.getContractAt("AdminConfigFacet", diamond);
  const owner = await ownership.owner();
  const ownerIsContract = (await ethers.provider.getCode(owner)) !== "0x";

  console.log("==========================================================");
  console.log("  SCRUM-560 — market-order SettlementFacet cut (SCRUM-559)");
  console.log("==========================================================");
  console.log(`  Network:   ${cfg.name} (chainId ${chainId})`);
  console.log(`  Diamond:   ${diamond}`);
  console.log(`  Owner:     ${owner} (${ownerIsContract ? "contract — Safe" : "EOA"})`);
  console.log(`  Deployer:  ${deployer ? deployer.address : "(no PRIVATE_KEY)"}`);
  console.log(`  Code:      ${provenance.commit}${provenance.dirty.length ? " + UNCOMMITTED CHANGES" : ""}`);
  console.log(`  Build:     ${build.id} (clean: one build-info, ${build.sources} sources, solc ${build.solc})`);
  console.log(`  Facet:     ${build.facetBytes} bytes (init ${build.facetInitBytes}), runtime keccak ${build.facetRuntimeKeccak}`);

  const factory = await ethers.getContractFactory(FACET_NAME);
  const plan = await planCut(loupe, factory);
  console.log(`  Plan:      Replace ${plan.replace.length} (${plan.replace.map((s) => s.name).join(", ") || "—"}), Add ${plan.add.length} (${plan.add.map((s) => s.name).join(", ") || "—"})`);
  console.log(`  Old facet: ${plan.oldFacets.join(", ") || "—"}`);
  const refused = planProblems(plan);
  if (refused.length) throw new Error(`The cut must be Replace 3 and Add 0. Refusing:\n    - ${refused.join("\n    - ")}`);
  const [liveFacetCode, artifact] = await Promise.all([ethers.provider.getCode(plan.oldFacets[0]), hre.artifacts.readArtifact(FACET_NAME)]);
  if (liveFacetCode.toLowerCase() === artifact.deployedBytecode.toLowerCase()) {
    throw new Error(`The Diamond already routes these selectors to this build's facet (${plan.oldFacets[0]}) — the cut looks applied already. Check the deployment record.`);
  }

  const routingBefore = await readRouting(loupe);
  const stateBefore = await readState(diamond);
  for (const [symbol, token] of Object.entries(COLLATERALS)) {
    if (!(await adminConfig.isAllowedCollateral(token))) throw new Error(`${symbol} ${token} is not allow-listed on ${diamond} — wrong Diamond?`);
  }
  console.log(`  Operator:  ${stateBefore.operator}, trading ${stateBefore.paused ? "PAUSED" : "not paused"}`);
  console.log(`  Fees:      receiver ${stateBefore.feeReceiver}, trading cap ${stateBefore.maxFeeRateBps} bps, accrued ${JSON.stringify(stateBefore.accruedFees)}`);

  const mode = await chooseRoute({ cfg, chainId, owner, deployer, minBalance: MIN_DEPLOYER_BALANCE, safeClient: opts.safeClient });
  console.log(`  Cut route: ${mode}`);
  console.log("  Switch:    MARKET_ORDERS_ENABLED stays off until this cut has landed and facetAddress(matchOrders) is confirmed");
  console.log("==========================================================");

  if (dryRun) {
    console.log("\nDRY_RUN — stopping before any deployment or cut.");
    return { dryRun: true, diamond, owner, plan, build, stateBefore, routingBefore };
  }

  console.log("\n--- Step 1: deploy ---");
  const facet = await deployFacet(factory, { reuse, local: cfg.local, skipVerify });

  const cut = [{ facetAddress: facet, action: FacetCutAction.Replace, functionSelectors: plan.replace.map((s) => s.selector) }];
  const transaction = { to: diamond, data: diamondCut.interface.encodeFunctionData("diamondCut", [cut, ethers.constants.AddressZero, "0x"]) };

  console.log("\n--- Step 2: diamondCut (Replace 3, Add 0) ---");
  const { cutTxHash, cutBlock, safeTxHash } = await sendCut({ mode, cfg, chainId, owner, deployer, transaction, label: "SCRUM-559 market-order SettlementFacet", safeClient: opts.safeClient });

  // Record first: whatever the post-check finds, the cut is on-chain and must be documented.
  const timestamp = new Date().toISOString();
  const recordFile = path.join(opts.recordDir || path.join(__dirname, "..", "..", "deployments", cfg.name), `scrum559-market-orders-${timestamp.replace(/[:.]/g, "-")}.json`);
  const keptBuildInfo = recordFile.replace(/\.json$/, ".build-info.json.gz");
  const summary = {
    ticket: "SCRUM-560",
    contractChange: "SCRUM-559",
    network: cfg.name,
    chainId,
    diamond,
    owner,
    cutRoute: mode,
    gitCommit: provenance.commit,
    gitUncommitted: provenance.dirty,
    build: {
      id: build.id,
      solc: build.solc,
      sources: build.sources,
      sha256: build.sha256,
      kept: path.basename(keptBuildInfo),
      facetBytes: build.facetBytes,
      facetInitBytes: build.facetInitBytes,
      facetRuntimeKeccak: build.facetRuntimeKeccak,
    },
    facets: { settlement: facet },
    cut: cut.map((c) => ({ ...c, action: "Replace" })),
    // Rollback: Replace each selector back to this facet (rollback-scrum559-market-orders.js).
    previousRouting: plan.previous,
    cutTxHash,
    cutBlock,
    safeTxHash,
    preflight: stateBefore,
    postCheck: "pending",
    timestamp,
  };
  if (record) {
    writeRecord(recordFile, summary);
    console.log(`  Record written: ${path.relative(process.cwd(), recordFile)}`);
    // A later `hardhat clean` deletes artifacts/build-info, and a delta audit rebuilds from this.
    fs.writeFileSync(keptBuildInfo, zlib.gzipSync(fs.readFileSync(build.file)));
    console.log(`  Build-info kept: ${path.relative(process.cwd(), keptBuildInfo)}`);
  }
  if (opts.afterCut) await opts.afterCut();

  console.log("\n--- Step 3: post-check ---");
  const problems = [];
  const want = facet.toLowerCase();
  // Public RPCs can answer from a lagging replica right after execution — poll before concluding anything.
  const routingAfter = await pollUntil(() => readRouting(loupe), (r) => plan.selectors.every((s) => r[s.selector] === want), cfg.local);
  for (const s of plan.selectors) {
    const ok = routingAfter[s.selector] === want;
    console.log(`  ${ok ? "✔" : "✘"} facetAddress(${s.name} ${s.selector}) = ${routingAfter[s.selector]}`);
    if (!ok) problems.push(`${s.name} ${s.selector} routes to ${routingAfter[s.selector]}, expected ${want}`);
  }
  const movedOthers = routingDiff(routingBefore, routingAfter).filter((sel) => !plan.selectors.some((s) => s.selector === sel));
  if (movedOthers.length) problems.push(`selectors outside this cut moved: ${movedOthers.join(", ")}`);
  else console.log(`  ✔ the other ${Object.keys(routingAfter).length - plan.selectors.length} selectors on the Diamond did not move`);
  const cmp = await compareStateAroundCut(diamond, cutBlock, stateBefore);
  cmp.notes.forEach((n) => console.log(`  · ${n}`));
  problems.push(...cmp.problems);
  if (!cmp.problems.length) console.log("  ✔ operator, pause flag, fee settings, units and domain unchanged; accrued fees did not fall");

  Object.assign(summary, {
    aroundCut: cmp.around,
    postCheck: problems.length ? { ok: false, problems, notes: cmp.notes } : { ok: true, notes: cmp.notes },
  });
  if (record) {
    writeRecord(recordFile, summary);
    console.log(`  Record updated with the post-check: ${path.relative(process.cwd(), recordFile)}`);
  }
  if (problems.length) {
    throw new Error(
      `The cut tx ${cutTxHash} is MINED, but the post-check found:\n    - ${problems.join("\n    - ")}\n` +
        "  Keep MARKET_ORDERS_ENABLED off. Re-check the loupe before assuming failure; the record has the previous routing."
    );
  }

  console.log("\n==========================================================");
  console.log("  ✅ SCRUM-559 market-order facet cut applied");
  if (cfg.explorer) console.log(`  Cut tx:   ${cfg.explorer}/tx/${cutTxHash}`);
  if (safeTxHash && !opts.safeClient) console.log(`  Safe UI:  https://app.safe.global/transactions/history?safe=${safeNetworkPrefix(chainId)}:${owner}`);
  console.log(`  Facet:    ${facet}`);
  if (!cfg.local) {
    console.log("  Next:");
    console.log(`    1. cast call ${diamond} "facetAddress(bytes4)(address)" ${CUT_SELECTORS.matchOrders} --rpc-url <rpc>   must print ${facet}`);
    console.log("    2. commit the record and the kept build-info");
    console.log("    3. only then may MARKET_ORDERS_ENABLED be switched on (SCRUM-569)");
  }
  console.log("==========================================================\n");
  return { ...summary, recordFile: record ? recordFile : null, keptBuildInfo: record ? keptBuildInfo : null };
}

if (require.main === module) {
  runUpgrade()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("\n❌ SCRUM-559 market-order cut failed:", e);
      process.exit(1);
    });
}

module.exports = {
  runUpgrade,
  CUT_SELECTORS,
  COLLATERALS,
  FacetCutAction,
  refuseMainnet,
  resolveTarget,
  gitProvenance,
  chooseRoute,
  sendCut,
  impersonate,
  pollUntil,
  readRouting,
  routingDiff,
  readState,
  compareStateAroundCut,
  writeRecord,
  _test: { planProblems, buildProblems, configuredCompiler, listSources, readSource },
};
