/* global ethers */
/* eslint prefer-const: "off" */
/**
 * SCRUM-214 — oracle + CTF hardening cut (ORC-001 … ORC-011 and CTF-001 … CTF-008,
 * audit/findings-ledger.md "ORACLE" and "CTF").
 *
 * Ships six facets:
 *   - DoefinV1BlockHeaderOracle (linked to a fresh BlockHeaderUtils): Bitcoin header rules —
 *     PoW against the header's own target, nBits continuity + exact retarget, most-work fork
 *     choice, median-time-past by height, 2 h future limit, owner-only validated init,
 *     named empty-batch error; MiningDuration / BlockCount resolution no longer freezes it;
 *     already-resolved (voided) conditions are skipped at resolution.
 *   - ConditionManagerFacet: difficulty markets only for a period that has not begun,
 *     BlockCount creation disabled, oracle-staleness gate, ≤ 25 questions per height;
 *     legacy createCondition owner-only; adds voidCondition.
 *   - AdminConfigFacet: adds setMaxOracleStaleness / getMaxOracleStaleness and the per-condition
 *     getResolutionFeeBps view; resolution fee capped at 500 bps.
 *   - ConditionalTokensFacet, ERC1155Facet, SettlementFacet: the CTF library fixes they inline —
 *     only canonical root splits register markets, settlement fails closed on unregistered or
 *     partial markets, resolution fee snapshotted at resolution and charged on post-resolution
 *     merges, payout validation, no Diamond self-calls, lock enforced in the internal variants.
 * Storage: two fields appended to the AdminConfig EIP-7201 namespace (maxOracleStaleness,
 * resolutionFeeAtResolution) — nothing moves, so no migration. Conditions resolved before the
 * cut have no fee snapshot and are charged 0 (c1de64a). Every selector of the six facets is
 * moved to the new address (Replace if routed today, Add if new); selectors the new ABI no
 * longer has would be left on the old facet, so the script refuses to cut if any exist, and it
 * refuses any Add it does not expect (wrong Diamond).
 *
 * What this script does:
 *   1. Pre-flight (nothing is sent until all of it passes): network/chainId, Diamond, owner, git
 *      provenance, oracle state, fees, per-facet cut plan; refuses a cut that is already applied,
 *      new storage slots that are not empty, an oracle older than MAX_ORACLE_STALENESS, a
 *      deployer without gas money, and (Safe route) an unreachable Safe service or a queued
 *      Safe proposal.
 *   2. Deploys BlockHeaderUtils + DoefinV1BlockHeaderOracle and the five other facets (each
 *      reusable via env); every deployed or reused address must carry exactly the compiled
 *      bytecode (the oracle facet linked to the recorded BlockHeaderUtils).
 *   3. One diamondCut with every Replace/Add; optionally setMaxOracleStaleness in the same
 *      Safe MultiSend.
 *   4. Writes deployments/<network>/scrum214-hardening-<timestamp>.json as soon as the cut is
 *      mined (public nets), including the previous routing of every selector for a rollback.
 *   5. Post-check: every selector → its new facet; oracle state, question totals and fees
 *      compared at the blocks around the cut (live actors may advance them — only a regression
 *      is an error); staleness limit as requested. Results are added to the record; a failed
 *      check exits non-zero AFTER the record is written.
 *
 * Cut routing is the same as the SCRUM-521 script: impersonated owner on a local fork, Safe
 * MultiSend when owner() is a contract, direct when the deployer owns the Diamond.
 *
 * Env:
 *   DIAMOND_ADDRESS              optional on base / baseSepolia; required elsewhere
 *   SAFE_ADDRESS, PRIVATE_KEY    Safe ceremony (see upgrade-scrum521-oracle-reorg-underflow.js)
 *   BASE_MAINNET_RPC_ENDPOINT / BASE_SEPOLIA_RPC_ENDPOINT
 *   MAX_ORACLE_STALENESS         optional seconds — appended as setMaxOracleStaleness (e.g. 10800)
 *   BLOCK_HEADER_UTILS_ADDRESS and NEW_<FACET>_FACET_ADDRESS (see FACETS)   optional reuse
 *                                (BLOCK_HEADER_UTILS_ADDRESS is required with NEW_ORACLE_FACET_ADDRESS)
 *   SKIP_VERIFY=true, DRY_RUN=true
 *   ALLOW_DIRTY=true             mainnet only: permit uncommitted changes under contracts/ or scripts/
 *   FORCE_RECUT=true             re-run although the cut's new selectors are already routed
 *
 * Usage:
 *   npm run upgrade:scrum214:baseSepolia
 *   npm run upgrade:scrum214:base
 *   npm run upgrade:scrum214:rehearse   (mainnet fork, see rehearse-scrum214-fork.js)
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { proposeAndExecute, safePreflight, safeNetworkPrefix } = require("../lib/safe-multisend.js");
const { networkConfig, resolveDiamond, readOracleState, printState } = require("./upgrade-scrum521-oracle-reorg-underflow.js");

const { execSync } = require("child_process");

const FacetCutAction = { Add: 0, Replace: 1, Remove: 2 };
const BANNER_PAUSE_MS = 5000;
const MIN_DEPLOYER_BALANCE = ethers.utils.parseEther("0.002"); // 7 deployments + verification on Base
const POST_CHECK_ATTEMPTS = 10;
const POST_CHECK_DELAY_MS = 3000;
// AdminConfig EIP-7201 namespace (LibAdminConfigStorage): slot 5 = maxOracleStaleness, slot 6 = the
// resolutionFeeAtResolution mapping — both appended by this cut and empty before it.
const ADMIN_CONFIG_BASE = ethers.BigNumber.from(
  ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(["uint256"], [ethers.BigNumber.from(ethers.utils.id("doefin.admin-config.storage")).sub(1)]))
).and(ethers.BigNumber.from(2).pow(256).sub(256));
const MAX_RESOLUTION_FEE_BPS = 500; // AdminConfigFacet.MAX_RESOLUTION_FEE_BPS (CTF-007)

/** The facets this cut ships; `expectedAdds` are the only selectors allowed to be new. */
const FACETS = [
  { key: "oracle", label: "DoefinV1BlockHeaderOracle", env: "NEW_ORACLE_FACET_ADDRESS", expectedAdds: [] },
  { key: "conditionManager", label: "ConditionManagerFacet", env: "NEW_CONDITION_MANAGER_FACET_ADDRESS", expectedAdds: ["voidCondition"] },
  { key: "adminConfig", label: "AdminConfigFacet", env: "NEW_ADMIN_CONFIG_FACET_ADDRESS", expectedAdds: ["setMaxOracleStaleness", "getMaxOracleStaleness", "getResolutionFeeBps"] },
  { key: "conditionalTokens", label: "ConditionalTokensFacet", env: "NEW_CONDITIONAL_TOKENS_FACET_ADDRESS", expectedAdds: [] },
  { key: "erc1155", label: "ERC1155Facet", env: "NEW_ERC1155_FACET_ADDRESS", expectedAdds: [] },
  { key: "settlement", label: "SettlementFacet", env: "NEW_SETTLEMENT_FACET_ADDRESS", expectedAdds: [] },
];

function selectorsOf(factory) {
  return Object.values(factory.interface.functions)
    .filter((f) => f.type === "function")
    .map((f) => ({ name: f.name, selector: factory.interface.getSighash(f).toLowerCase() }));
}

async function impersonate(address) {
  await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [address] });
  await hre.network.provider.send("hardhat_setBalance", [address, "0x56BC75E2D63100000"]); // 100 ETH
  return ethers.getSigner(address);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

/** Runtime bytecode `name` must have at an address (libraries linked as given). */
async function expectedRuntimeCode(name, libraries) {
  const artifact = await hre.artifacts.readArtifact(name);
  let code = artifact.deployedBytecode.toLowerCase();
  for (const [file, libs] of Object.entries(artifact.deployedLinkReferences || {})) {
    for (const [lib, refs] of Object.entries(libs)) {
      const address = libraries && libraries[lib];
      if (!address) throw new Error(`${name} links ${file}:${lib}; no address given`);
      for (const r of refs) code = code.slice(0, 2 + r.start * 2) + address.toLowerCase().replace(/^0x/, "") + code.slice(2 + (r.start + r.length) * 2);
    }
  }
  return code;
}

/** An address must carry exactly the compiled runtime code of `name` — reused or freshly deployed. */
async function assertCode(name, address, libraries) {
  let [live, expected] = await Promise.all([ethers.provider.getCode(address), expectedRuntimeCode(name, libraries)]);
  // A library's runtime code starts with PUSH20 <its own address> (call protection), zero in the artifact.
  const placeholder = "0x73" + "0".repeat(40);
  if (expected.startsWith(placeholder)) expected = "0x73" + address.toLowerCase().replace(/^0x/, "") + expected.slice(placeholder.length);
  if (live.toLowerCase() !== expected) {
    throw new Error(`${address} does not carry the compiled ${name} bytecode${libraries ? ` linked to ${JSON.stringify(libraries)}` : ""} — wrong or stale address`);
  }
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

async function verifyOnExplorer({ address, libraries, skip }) {
  if (skip) return;
  try {
    await hre.run("verify:verify", { address, constructorArguments: [], ...(libraries ? { libraries } : {}) });
    console.log(`  ✔ verified ${address}`);
  } catch (err) {
    console.warn(`  ⚠ verification FAILED for ${address}: ${err.message} — verify manually (CR-HARDHAT-VERIFY)`);
  }
}

/** Deploy `name` (or reuse `reuse`), wait for confirmations on public networks. */
async function deployOrReuse(name, { libraries, reuse, local, skipVerify, contractName, resumeEnv }) {
  if (reuse) {
    await assertCode(contractName || name, reuse, libraries);
    console.log(`  Reusing ${name} at ${reuse} (bytecode matches the compiled ${contractName || name})`);
    return reuse;
  }
  const factory = await ethers.getContractFactory(contractName || name, libraries ? { libraries } : {});
  const c = await factory.deploy();
  await c.deployed();
  if (!local) await c.deployTransaction.wait(2);
  await pollUntil(() => ethers.provider.getCode(c.address), (code) => code !== "0x", local);
  await assertCode(contractName || name, c.address, libraries);
  console.log(`  Deployed ${name} at ${c.address}${resumeEnv ? `   (to resume: export ${resumeEnv}=${c.address})` : ""}`);
  await verifyOnExplorer({ address: c.address, libraries, skip: skipVerify });
  return c.address;
}

/** Replace / Add plan for one facet, plus any selectors the new ABI would strand on old facets. */
async function planFacet(loupe, label, factory) {
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
  return { label, selectors, replace, add, oldFacets: [...oldFacets], stranded, previous };
}

async function readFees(adminConfig, blockTag) {
  const o = blockTag === undefined ? {} : { blockTag };
  const [[feeReceiver, resolutionFeeBps], maxFeeRateBps] = await Promise.all([adminConfig.getFees(o), adminConfig.getMaxFeeRate(o)]);
  return { feeReceiver, resolutionFeeBps, maxFeeRateBps };
}

async function readQuestionTotals(adapter, blockTag) {
  const o = blockTag === undefined ? {} : { blockTag };
  const [created, resolved] = await Promise.all([adapter.getTotalQuestionsCreated(o), adapter.getTotalQuestionsResolved(o)]);
  return { created: created.toNumber(), resolved: resolved.toNumber() };
}

async function readOracleAt(oracle, blockTag) {
  const o = blockTag === undefined ? {} : { blockTag };
  const [height, nextBlockIndex, tip] = await Promise.all([oracle.getCurrentBlockHeight(o), oracle.getNextBlockIndex(o), oracle.getLatestBlockHeader(o)]);
  return { height: height.toNumber(), nextBlockIndex: nextBlockIndex.toNumber(), tipHash: tip.blockHash, tipTimestamp: Number(tip.timestamp) };
}

/**
 * Compare state around the cut. The cut itself writes none of it; live actors (block-indexer,
 * market makers, resolutions) can advance oracle height and question totals in the same window,
 * so only a regression — or a fee change, which only the owner Safe can make — is a problem.
 */
function compareAroundCut(before, after) {
  const notes = [];
  const problems = [];
  if (after.oracle.height < before.oracle.height) problems.push(`oracle height went DOWN ${before.oracle.height} → ${after.oracle.height}`);
  else if (after.oracle.height > before.oracle.height) notes.push(`oracle advanced ${before.oracle.height} → ${after.oracle.height} (block-indexer)`);
  else if (after.oracle.tipHash !== before.oracle.tipHash || after.oracle.nextBlockIndex !== before.oracle.nextBlockIndex) notes.push("oracle tip replaced at the same height (reorg handled by the block-indexer)");
  for (const k of ["created", "resolved"]) {
    if (after.totals[k] < before.totals[k]) problems.push(`questions ${k} went DOWN ${before.totals[k]} → ${after.totals[k]}`);
    else if (after.totals[k] > before.totals[k]) notes.push(`questions ${k} ${before.totals[k]} → ${after.totals[k]} (live activity)`);
  }
  if (JSON.stringify(after.fees) !== JSON.stringify(before.fees)) problems.push(`fee settings changed ${JSON.stringify(before.fees)} → ${JSON.stringify(after.fees)}`);
  return { notes, problems };
}

function writeRecord(file, summary) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(summary, null, 2) + "\n");
}

/**
 * @param {object} opts
 * @param {string}  [opts.diamond]
 * @param {boolean} [opts.impersonateOwner]  force owner impersonation (local/fork only)
 * @param {boolean} [opts.skipVerify]
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.record]            write deployments/<network>/…json (default: public networks)
 * @param {number}  [opts.maxOracleStaleness] seconds; appended as setMaxOracleStaleness
 * @param {string}  [opts.recordDir]         write the record here instead of deployments/<network>/
 * @param {Function} [opts.afterCut]         rehearsal hook: runs after the cut is mined, before the
 *                                           post-check (simulates live actors moving state)
 */
async function runUpgrade(opts = {}) {
  const cfg = networkConfig();
  const net = await ethers.provider.getNetwork();
  if (cfg.chainId !== null && Number(net.chainId) !== cfg.chainId) {
    throw new Error(`Expected chainId ${cfg.chainId} for network "${cfg.name}", provider reports ${net.chainId}`);
  }
  const diamond = opts.diamond || (await resolveDiamond(cfg));
  const skipVerify = opts.skipVerify ?? (cfg.local || process.env.SKIP_VERIFY === "true");
  const dryRun = opts.dryRun ?? process.env.DRY_RUN === "true";
  const record = opts.record ?? !cfg.local;
  const stalenessEnv = process.env.MAX_ORACLE_STALENESS;
  const maxOracleStaleness = opts.maxOracleStaleness ?? (stalenessEnv !== undefined && stalenessEnv !== "" ? Number(stalenessEnv) : null);
  if (maxOracleStaleness !== null && (!Number.isInteger(maxOracleStaleness) || maxOracleStaleness < 0 || maxOracleStaleness > 0xffffffff)) {
    throw new Error(`MAX_ORACLE_STALENESS must be a uint32 number of seconds, got ${stalenessEnv}`);
  }

  const provenance = gitProvenance();
  if (provenance.dirty.length && !cfg.local) {
    const msg = `uncommitted changes under contracts/ or scripts/:\n    ${provenance.dirty.join("\n    ")}`;
    if (cfg.mainnet && process.env.ALLOW_DIRTY !== "true") throw new Error(`Refusing a mainnet cut with ${msg}\n  Commit them (the record must name what was deployed) or set ALLOW_DIRTY=true.`);
    console.warn(`  ⚠ ${msg}`);
  }
  if (process.env.NEW_ORACLE_FACET_ADDRESS && !process.env.BLOCK_HEADER_UTILS_ADDRESS) {
    throw new Error("NEW_ORACLE_FACET_ADDRESS is reused: set BLOCK_HEADER_UTILS_ADDRESS to the library it is linked to");
  }

  const [deployer] = await ethers.getSigners();
  const ownership = await ethers.getContractAt("OwnershipFacet", diamond);
  const loupe = await ethers.getContractAt("IDiamondLoupe", diamond);
  const diamondCut = await ethers.getContractAt("IDiamondCut", diamond);
  const oracle = await ethers.getContractAt("IDoefinBlockHeaderOracle", diamond);
  const adapter = await ethers.getContractAt("OracleAdapterFacet", diamond);
  const adminConfig = await ethers.getContractAt("AdminConfigFacet", diamond);

  const owner = await ownership.owner();
  const ownerIsContract = (await ethers.provider.getCode(owner)) !== "0x";

  console.log("==========================================================");
  console.log(`  SCRUM-214 — oracle + CTF hardening cut${cfg.mainnet ? "  (MAINNET — REAL MONEY)" : ""}`);
  console.log("==========================================================");
  console.log(`  Network:   ${cfg.name} (chainId ${net.chainId})`);
  console.log(`  Diamond:   ${diamond}`);
  console.log(`  Owner:     ${owner} (${ownerIsContract ? "contract — Safe" : "EOA"})`);
  console.log(`  Deployer:  ${deployer.address}`);
  console.log(`  Code:      ${provenance.commit}${provenance.dirty.length ? " + UNCOMMITTED CHANGES" : ""}`);
  const stateBefore = await readOracleState(oracle);
  printState("Oracle before", stateBefore);
  const totalsBefore = await readQuestionTotals(adapter);
  console.log(`  Questions: created ${totalsBefore.created}, resolved ${totalsBefore.resolved}`);
  const feesBefore = await readFees(adminConfig);
  console.log(`  Fees:      receiver ${feesBefore.feeReceiver}, resolution ${feesBefore.resolutionFeeBps} bps, trading cap ${feesBefore.maxFeeRateBps} bps`);
  // The new setter caps the resolution fee; a live rate above the cap would still be snapshotted
  // into every condition resolved after the cut.
  if (feesBefore.resolutionFeeBps > MAX_RESOLUTION_FEE_BPS) {
    throw new Error(`resolutionFeeBps is ${feesBefore.resolutionFeeBps}, above the new ${MAX_RESOLUTION_FEE_BPS} bps cap — lower it before the cut`);
  }

  // Selector plans come from the ABIs; the library address does not change selectors.
  const plans = [];
  for (const spec of FACETS) {
    const factory =
      spec.key === "oracle"
        ? await ethers.getContractFactory(spec.label, { libraries: { BlockHeaderUtils: ethers.constants.AddressZero } })
        : await ethers.getContractFactory(spec.label);
    const plan = await planFacet(loupe, spec.label, factory);
    plans.push({ key: spec.key, ...plan });
    console.log(`  ${spec.label}: Replace ${plan.replace.length}, Add ${plan.add.length} (${plan.add.map((s) => s.name).join(", ") || "—"}); old facet(s) ${plan.oldFacets.join(", ") || "—"}`);
  }
  const stranded = plans.flatMap((p) => p.stranded.map((s) => ({ ...s, label: p.label })));
  if (stranded.length) {
    stranded.forEach((s) => console.log(`  ✘ ${s.label}: selector ${s.selector} on old facet ${s.facet} is not in the new ABI`));
    throw new Error("The cut would leave selectors on retired facets — resolve them (Remove) before cutting");
  }
  const unexpectedAdds = plans.flatMap((p) => {
    const allowed = FACETS.find((f) => f.key === p.key).expectedAdds;
    return p.add.filter((s) => !allowed.includes(s.name)).map((s) => `${p.label}.${s.name}`);
  });
  if (unexpectedAdds.length) throw new Error(`Selectors expected to be routed today are not (${unexpectedAdds.join(", ")}) — wrong Diamond?`);
  const pendingAdds = plans.flatMap((p) => p.add);
  if (pendingAdds.length === 0 && process.env.FORCE_RECUT !== "true") {
    throw new Error("Every selector this cut adds is already routed — the cut looks applied already. Check the deployment record; set FORCE_RECUT=true to cut again anyway.");
  }
  if (pendingAdds.length) {
    // The appended AdminConfig fields must start empty: nothing may be misread as a staleness limit
    // or a fee snapshot. Verified empty on Base mainnet and Sepolia on 2026-10-20.
    for (const i of [5, 6]) {
      const raw = await ethers.provider.getStorageAt(diamond, ethers.utils.hexZeroPad(ADMIN_CONFIG_BASE.add(i).toHexString(), 32));
      if (!ethers.BigNumber.from(raw).isZero()) throw new Error(`AdminConfig storage slot base+${i} is not empty (${raw}) — the appended field would misread it`);
    }
    console.log("  ✔ AdminConfig slots base+5 / base+6 (the appended fields) are empty");
  }
  if (maxOracleStaleness) {
    // ConditionManagerFacet refuses market creation once block.timestamp > tip header time + limit.
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const tipTime = Number((await oracle.getLatestBlockHeader()).timestamp);
    const age = now - tipTime;
    console.log(`  Oracle tip age: ${age} s (limit to set: ${maxOracleStaleness} s)`);
    if (age > maxOracleStaleness) throw new Error(`The oracle tip is ${age} s old, over MAX_ORACLE_STALENESS=${maxOracleStaleness}: market creation would stop the moment the cut lands. Bring the oracle up to date first.`);
    if (age > maxOracleStaleness / 2) console.warn(`  ⚠ the oracle tip is over half the staleness limit old — check the block-indexer before cutting`);
  }
  if (maxOracleStaleness !== null) {
    // setMaxOracleStaleness reverts NoChangeRequired on an unchanged value, and the Safe MultiSend is
    // atomic, so a no-op setter would revert the diamondCut with it — after the signers have signed.
    // Before the cut the getter is not routed and the appended slot is 0.
    const adminPlan = plans.find((p) => p.key === "adminConfig");
    const getterRouted = !adminPlan.add.some((s) => s.name === "getMaxOracleStaleness");
    const currentStaleness = getterRouted ? await adminConfig.getMaxOracleStaleness() : 0;
    if (maxOracleStaleness === currentStaleness) {
      throw new Error(
        `MAX_ORACLE_STALENESS=${maxOracleStaleness} equals the on-chain value — setMaxOracleStaleness would revert ` +
          "NoChangeRequired and take the cut with it. Omit MAX_ORACLE_STALENESS or pass a different value."
      );
    }
  }

  let mode;
  if (cfg.local || opts.impersonateOwner) {
    mode = "impersonate";
  } else if (ownerIsContract) {
    mode = "safe";
    const safeAddress = process.env.SAFE_ADDRESS;
    if (!safeAddress) throw new Error("Diamond owner is a contract (Safe) — set SAFE_ADDRESS");
    if (safeAddress.toLowerCase() !== owner.toLowerCase()) throw new Error(`SAFE_ADDRESS ${safeAddress} ≠ Diamond owner ${owner}`);
    if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY (a Safe signer) is required for the Safe ceremony");
    if (!cfg.rpcEnv || !process.env[cfg.rpcEnv]) throw new Error(`${cfg.rpcEnv} is required for the Safe SDK`);
    const safe = new ethers.Contract(owner, ["function getOwners() view returns (address[])"], ethers.provider);
    if (!(await safe.getOwners()).map((o) => o.toLowerCase()).includes(deployer.address.toLowerCase())) {
      throw new Error(`Deployer ${deployer.address} is not a signer on Safe ${owner}`);
    }
  } else if (owner.toLowerCase() === deployer.address.toLowerCase()) {
    mode = "direct";
  } else {
    throw new Error(`Diamond owner ${owner} is an EOA that is not the deployer ${deployer.address} — cannot cut`);
  }
  if (mode === "safe") {
    // Discover Safe service problems before deploying anything.
    const sp = await safePreflight({ safeAddress: owner, chainId: Number(net.chainId), signer: deployer.address });
    console.log(`  Safe:      ${sp.threshold}-of-${sp.owners.length}, nonce ${sp.nonce}, v${sp.version}, queued proposals ${sp.pending}`);
    if (!sp.isOwner) throw new Error(`Deployer ${deployer.address} is not an owner per the Safe service`);
    if (sp.pending > 0) throw new Error(`The Safe has ${sp.pending} queued proposal(s); execute or reject them first — a new proposal would share their nonce`);
  }
  if (mode !== "impersonate") {
    const balance = await deployer.getBalance();
    if (balance.lt(MIN_DEPLOYER_BALANCE)) throw new Error(`Deployer ${deployer.address} has ${ethers.utils.formatEther(balance)} ETH; need at least ${ethers.utils.formatEther(MIN_DEPLOYER_BALANCE)}`);
    console.log(`  Balance:   ${ethers.utils.formatEther(balance)} ETH`);
  }
  console.log(`  Cut route: ${mode}${maxOracleStaleness !== null ? ` · then setMaxOracleStaleness(${maxOracleStaleness})` : ""}`);
  console.log("==========================================================");

  if (dryRun) {
    console.log("\nDRY_RUN — stopping before any deployment or cut.");
    return { dryRun: true, diamond, owner, plans, stateBefore, totalsBefore };
  }
  if (cfg.mainnet) {
    console.log(`  Pausing ${BANNER_PAUSE_MS / 1000}s before deploying — Ctrl-C to abort.\n`);
    await new Promise((r) => setTimeout(r, BANNER_PAUSE_MS));
  }

  console.log("\n--- Step 1: deploy ---");
  const deployOpts = { local: cfg.local, skipVerify };
  const library = await deployOrReuse("BlockHeaderUtils", { ...deployOpts, reuse: process.env.BLOCK_HEADER_UTILS_ADDRESS, resumeEnv: "BLOCK_HEADER_UTILS_ADDRESS" });
  const facets = {};
  for (const spec of FACETS) {
    facets[spec.key] = await deployOrReuse(spec.label, {
      ...deployOpts,
      ...(spec.key === "oracle" ? { libraries: { BlockHeaderUtils: library } } : {}),
      reuse: process.env[spec.env],
      resumeEnv: spec.env,
    });
  }

  const cut = [];
  for (const p of plans) {
    if (p.replace.length) cut.push({ facetAddress: facets[p.key], action: FacetCutAction.Replace, functionSelectors: p.replace.map((s) => s.selector) });
    if (p.add.length) cut.push({ facetAddress: facets[p.key], action: FacetCutAction.Add, functionSelectors: p.add.map((s) => s.selector) });
  }
  const transactions = [{ to: diamond, data: diamondCut.interface.encodeFunctionData("diamondCut", [cut, ethers.constants.AddressZero, "0x"]) }];
  if (maxOracleStaleness !== null) {
    transactions.push({ to: diamond, data: adminConfig.interface.encodeFunctionData("setMaxOracleStaleness", [maxOracleStaleness]) });
  }

  console.log(`\n--- Step 2: diamondCut (${cut.length} entries, ${cut.reduce((n, c) => n + c.functionSelectors.length, 0)} selectors)${transactions.length > 1 ? " + setMaxOracleStaleness" : ""} ---`);
  let cutTxHash;
  let cutBlock;
  let safeTxHash = null;
  if (mode === "safe") {
    const result = await proposeAndExecute({
      safeAddress: owner,
      chainId: Number(net.chainId),
      rpcUrl: process.env[cfg.rpcEnv],
      signerKey: process.env.PRIVATE_KEY,
      transactions,
      label: "SCRUM-214 oracle + CTF hardening",
    });
    cutTxHash = result.executionTxHash;
    cutBlock = result.blockNumber;
    safeTxHash = result.safeTxHash;
  } else {
    const sender = mode === "impersonate" ? await impersonate(owner) : deployer;
    for (const t of transactions) {
      const receipt = await (await sender.sendTransaction({ to: t.to, data: t.data })).wait();
      if (receipt.status !== 1) throw new Error(`tx ${receipt.transactionHash} reverted`);
      cutTxHash = cutTxHash || receipt.transactionHash;
      cutBlock = cutBlock || receipt.blockNumber;
      console.log(`  tx ${receipt.transactionHash} (block ${receipt.blockNumber}, gas ${receipt.gasUsed.toString()})`);
    }
  }

  // Record first: whatever the post-check finds, the cut is on-chain and must be documented.
  const timestamp = new Date().toISOString();
  const recordFile = path.join(opts.recordDir || path.join(__dirname, "..", "..", "deployments", cfg.name), `scrum214-hardening-${timestamp.replace(/[:.]/g, "-")}.json`);
  const summary = {
    ticket: "SCRUM-214",
    findings: "ORC-001..ORC-011, CTF-001..CTF-008",
    network: cfg.name,
    chainId: Number(net.chainId),
    diamond,
    owner,
    cutRoute: mode,
    gitCommit: provenance.commit,
    gitUncommitted: provenance.dirty,
    blockHeaderUtils: library,
    facets,
    cut: cut.map((c) => ({ ...c, action: Object.keys(FacetCutAction).find((k) => FacetCutAction[k] === c.action) })),
    // Rollback: Replace each selector back to its previous facet; Remove the ones that were added (0x0).
    previousRouting: Object.assign({}, ...plans.map((p) => p.previous)),
    maxOracleStalenessRequested: maxOracleStaleness,
    cutTxHash,
    cutBlock,
    safeTxHash,
    preflight: { oracle: stateBefore, questionTotals: totalsBefore, fees: feesBefore },
    postCheck: "pending",
    timestamp,
  };
  if (record) {
    writeRecord(recordFile, summary);
    console.log(`  Record written: ${path.relative(process.cwd(), recordFile)}`);
  }
  if (opts.afterCut) await opts.afterCut();

  console.log("\n--- Step 3: post-check ---");
  const problems = [];
  // Public RPCs can answer from a lagging replica right after execution (SCRUM-521 post-check
  // false alarm) — poll the routing before concluding anything.
  for (const p of plans) {
    let wrong = 0;
    for (const s of p.selectors) {
      const want = facets[p.key].toLowerCase();
      const routed = (await pollUntil(() => loupe.facetAddress(s.selector), (a) => a.toLowerCase() === want, cfg.local)).toLowerCase();
      if (routed !== want) {
        wrong++;
        problems.push(`${p.label}.${s.name} ${s.selector} routes to ${routed}, expected ${facets[p.key]}`);
      }
    }
    console.log(`  ${wrong ? "✘" : "✔"} ${p.label}: ${p.selectors.length - wrong}/${p.selectors.length} selectors → ${facets[p.key]}`);
  }
  // State just before the cut block vs now. The cut writes none of it (no _init); see compareAroundCut.
  const snapshot = async (blockTag) => ({
    oracle: await readOracleAt(oracle, blockTag),
    totals: await readQuestionTotals(adapter, blockTag),
    fees: await readFees(adminConfig, blockTag),
  });
  let around;
  try {
    around = { before: await snapshot(cutBlock - 1), after: await snapshot() };
  } catch (e) {
    // An RPC without state at cutBlock − 1: fall back to the pre-flight reads (wider window).
    console.warn(`  ⚠ historical read at block ${cutBlock - 1} failed (${e.message.slice(0, 80)}); comparing with the pre-flight state`);
    const after = await snapshot();
    around = { before: { oracle: { ...after.oracle, ...stateBefore }, totals: totalsBefore, fees: feesBefore }, after };
  }
  printState("Oracle after ", { ...around.after.oracle, tipNumber: around.after.oracle.height });
  const cmp = compareAroundCut(around.before, around.after);
  cmp.notes.forEach((n) => console.log(`  · ${n}`));
  problems.push(...cmp.problems);
  if (!cmp.problems.length) console.log("  ✔ oracle state, question totals and fee settings: nothing regressed or changed by the cut");
  const stalenessAfter = await pollUntil(
    () => adminConfig.getMaxOracleStaleness(),
    (v) => maxOracleStaleness === null || v === maxOracleStaleness,
    cfg.local
  );
  if (maxOracleStaleness !== null && stalenessAfter !== maxOracleStaleness) problems.push(`maxOracleStaleness is ${stalenessAfter}, expected ${maxOracleStaleness}`);
  else console.log(`  ✔ maxOracleStaleness = ${stalenessAfter}${stalenessAfter === 0 ? " (disabled — set it with setMaxOracleStaleness)" : " s"}`);

  Object.assign(summary, {
    maxOracleStaleness: stalenessAfter,
    aroundCut: around,
    postCheck: problems.length ? { ok: false, problems, notes: cmp.notes } : { ok: true, notes: cmp.notes },
  });
  if (record) {
    writeRecord(recordFile, summary);
    console.log(`  Record updated with the post-check: ${path.relative(process.cwd(), recordFile)}`);
  }
  if (problems.length) {
    throw new Error(
      `The cut tx ${cutTxHash} is MINED, but the post-check found:\n    - ${problems.join("\n    - ")}\n` +
        `  Re-check with npm run oracle:status:${cfg.name} and the loupe before assuming failure; the record has the previous routing.`
    );
  }

  console.log("\n==========================================================");
  console.log("  ✅ SCRUM-214 oracle + CTF hardening cut applied");
  if (cfg.explorer) console.log(`  Cut tx:   ${cfg.explorer}/tx/${cutTxHash}`);
  if (safeTxHash) console.log(`  Safe UI:  https://app.safe.global/transactions/history?safe=${safeNetworkPrefix(net.chainId)}:${owner}`);
  if (!cfg.local) console.log(`  Next: npm run oracle:status:${cfg.name} — tip canonical, lag 0.`);
  console.log("==========================================================\n");
  return summary;
}

if (require.main === module) {
  runUpgrade()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("\n❌ SCRUM-214 hardening cut failed:", e);
      process.exit(1);
    });
}

module.exports = { runUpgrade, _test: { assertCode, compareAroundCut } };
