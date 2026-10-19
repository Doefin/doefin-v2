/* global ethers */
/* eslint prefer-const: "off" */
/**
 * SCRUM-214 — oracle hardening cut (ORC-001 … ORC-011, audit/findings-ledger.md "ORACLE").
 *
 * Ships three facets:
 *   - DoefinV1BlockHeaderOracle (linked to a fresh BlockHeaderUtils): Bitcoin header rules —
 *     PoW against the header's own target, nBits continuity + exact retarget, most-work fork
 *     choice, median-time-past by height, 2 h future limit, owner-only validated init,
 *     named empty-batch error; MiningDuration / BlockCount resolution no longer freezes it.
 *   - ConditionManagerFacet: difficulty markets only for a period that has not begun,
 *     BlockCount creation disabled, oracle-staleness gate, ≤ 25 questions per height.
 *   - AdminConfigFacet: adds setMaxOracleStaleness / getMaxOracleStaleness.
 * Storage: one field appended to the AdminConfig EIP-7201 namespace (maxOracleStaleness) —
 * nothing moves, so no migration. Every selector of the three facets is moved to the new
 * address (Replace if routed today, Add if new); selectors the new ABI no longer has would be
 * left on the old facet, so the script refuses to cut if any exist.
 *
 * What this script does:
 *   1. Pre-flight: network/chainId, Diamond, owner, oracle state, per-facet cut plan.
 *   2. Deploys BlockHeaderUtils + DoefinV1BlockHeaderOracle, ConditionManagerFacet and
 *      AdminConfigFacet (each reusable via env).
 *   3. One diamondCut with every Replace/Add; optionally setMaxOracleStaleness in the same
 *      Safe MultiSend.
 *   4. Post-check: every selector → its new facet; oracle height / pointer / tip unchanged;
 *      question totals unchanged; staleness limit as requested.
 *   5. Writes deployments/<network>/scrum214-oracle-hardening-<timestamp>.json (public nets).
 *
 * Cut routing is the same as the SCRUM-521 script: impersonated owner on a local fork, Safe
 * MultiSend when owner() is a contract, direct when the deployer owns the Diamond.
 *
 * Env:
 *   DIAMOND_ADDRESS              optional on base / baseSepolia; required elsewhere
 *   SAFE_ADDRESS, PRIVATE_KEY    Safe ceremony (see upgrade-scrum521-oracle-reorg-underflow.js)
 *   BASE_MAINNET_RPC_ENDPOINT / BASE_SEPOLIA_RPC_ENDPOINT
 *   MAX_ORACLE_STALENESS         optional seconds — appended as setMaxOracleStaleness (e.g. 10800)
 *   BLOCK_HEADER_UTILS_ADDRESS, NEW_ORACLE_FACET_ADDRESS,
 *   NEW_CONDITION_MANAGER_FACET_ADDRESS, NEW_ADMIN_CONFIG_FACET_ADDRESS   optional reuse
 *   SKIP_VERIFY=true, DRY_RUN=true
 *
 * Usage:
 *   npm run upgrade:scrum214-oracle:baseSepolia
 *   npm run upgrade:scrum214-oracle:base
 *   npm run upgrade:scrum214-oracle:rehearse   (mainnet fork, see rehearse-scrum214-oracle-fork.js)
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { proposeAndExecute, safeNetworkPrefix } = require("../lib/safe-multisend.js");
const { networkConfig, resolveDiamond, readOracleState, printState } = require("./upgrade-scrum521-oracle-reorg-underflow.js");

const FacetCutAction = { Add: 0, Replace: 1, Remove: 2 };
const BANNER_PAUSE_MS = 5000;

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
async function deployOrReuse(name, { libraries, reuse, local, skipVerify, contractName }) {
  if (reuse) {
    if ((await ethers.provider.getCode(reuse)) === "0x") throw new Error(`No bytecode at the ${name} address to reuse: ${reuse}`);
    console.log(`  Reusing ${name} at ${reuse}`);
    return reuse;
  }
  const factory = await ethers.getContractFactory(contractName || name, libraries ? { libraries } : {});
  const c = await factory.deploy();
  await c.deployed();
  if (!local) await c.deployTransaction.wait(2);
  console.log(`  Deployed ${name} at ${c.address}`);
  await verifyOnExplorer({ address: c.address, libraries, skip: skipVerify });
  return c.address;
}

/** Replace / Add plan for one facet, plus any selectors the new ABI would strand on old facets. */
async function planFacet(loupe, label, factory) {
  const selectors = selectorsOf(factory);
  const replace = [];
  const add = [];
  const oldFacets = new Set();
  for (const s of selectors) {
    const current = (await loupe.facetAddress(s.selector)).toLowerCase();
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
  return { label, selectors, replace, add, oldFacets: [...oldFacets], stranded };
}

async function readQuestionTotals(adapter) {
  const [created, resolved] = await Promise.all([adapter.getTotalQuestionsCreated(), adapter.getTotalQuestionsResolved()]);
  return { created: created.toNumber(), resolved: resolved.toNumber() };
}

/**
 * @param {object} opts
 * @param {string}  [opts.diamond]
 * @param {boolean} [opts.impersonateOwner]  force owner impersonation (local/fork only)
 * @param {boolean} [opts.skipVerify]
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.record]            write deployments/<network>/…json (default: public networks)
 * @param {number}  [opts.maxOracleStaleness] seconds; appended as setMaxOracleStaleness
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
  console.log(`  SCRUM-214 — oracle hardening cut${cfg.mainnet ? "  (MAINNET — REAL MONEY)" : ""}`);
  console.log("==========================================================");
  console.log(`  Network:   ${cfg.name} (chainId ${net.chainId})`);
  console.log(`  Diamond:   ${diamond}`);
  console.log(`  Owner:     ${owner} (${ownerIsContract ? "contract — Safe" : "EOA"})`);
  console.log(`  Deployer:  ${deployer.address}`);
  const stateBefore = await readOracleState(oracle);
  printState("Oracle before", stateBefore);
  const totalsBefore = await readQuestionTotals(adapter);
  console.log(`  Questions: created ${totalsBefore.created}, resolved ${totalsBefore.resolved}`);

  // Selector plans come from the ABIs; the library address does not change selectors.
  const factories = {
    oracle: await ethers.getContractFactory("DoefinV1BlockHeaderOracle", { libraries: { BlockHeaderUtils: ethers.constants.AddressZero } }),
    conditionManager: await ethers.getContractFactory("ConditionManagerFacet"),
    adminConfig: await ethers.getContractFactory("AdminConfigFacet"),
  };
  const plans = [];
  for (const [key, label] of [["oracle", "DoefinV1BlockHeaderOracle"], ["conditionManager", "ConditionManagerFacet"], ["adminConfig", "AdminConfigFacet"]]) {
    const plan = await planFacet(loupe, label, factories[key]);
    plans.push({ key, ...plan });
    console.log(`  ${label}: Replace ${plan.replace.length}, Add ${plan.add.length} (${plan.add.map((s) => s.name).join(", ") || "—"}); old facet(s) ${plan.oldFacets.join(", ") || "—"}`);
  }
  const stranded = plans.flatMap((p) => p.stranded.map((s) => ({ ...s, label: p.label })));
  if (stranded.length) {
    stranded.forEach((s) => console.log(`  ✘ ${s.label}: selector ${s.selector} on old facet ${s.facet} is not in the new ABI`));
    throw new Error("The cut would leave selectors on retired facets — resolve them (Remove) before cutting");
  }
  const oraclePlan = plans.find((p) => p.key === "oracle");
  if (oraclePlan.add.length) throw new Error(`Oracle selectors not routed today (${oraclePlan.add.map((s) => s.name)}) — wrong Diamond?`);
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
  const library = await deployOrReuse("BlockHeaderUtils", { ...deployOpts, reuse: process.env.BLOCK_HEADER_UTILS_ADDRESS });
  const facets = {
    oracle: await deployOrReuse("DoefinV1BlockHeaderOracle", {
      ...deployOpts,
      libraries: { BlockHeaderUtils: library },
      reuse: process.env.NEW_ORACLE_FACET_ADDRESS,
    }),
    conditionManager: await deployOrReuse("ConditionManagerFacet", { ...deployOpts, reuse: process.env.NEW_CONDITION_MANAGER_FACET_ADDRESS }),
    adminConfig: await deployOrReuse("AdminConfigFacet", { ...deployOpts, reuse: process.env.NEW_ADMIN_CONFIG_FACET_ADDRESS }),
  };

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
  let safeTxHash = null;
  if (mode === "safe") {
    const result = await proposeAndExecute({
      safeAddress: owner,
      chainId: Number(net.chainId),
      rpcUrl: process.env[cfg.rpcEnv],
      signerKey: process.env.PRIVATE_KEY,
      transactions,
      label: "SCRUM-214 oracle hardening",
    });
    cutTxHash = result.executionTxHash;
    safeTxHash = result.safeTxHash;
  } else {
    const sender = mode === "impersonate" ? await impersonate(owner) : deployer;
    for (const t of transactions) {
      const receipt = await (await sender.sendTransaction({ to: t.to, data: t.data })).wait();
      cutTxHash = cutTxHash || receipt.transactionHash;
      console.log(`  tx ${receipt.transactionHash} (block ${receipt.blockNumber}, gas ${receipt.gasUsed.toString()})`);
    }
  }

  console.log("\n--- Step 3: post-check ---");
  // Public RPCs can answer from a lagging replica right after execution (SCRUM-521 post-check
  // false alarm) — poll the routing a few times before failing.
  for (const p of plans) {
    for (const s of p.selectors) {
      let routed;
      for (let attempt = 0; attempt < 6; attempt++) {
        routed = (await loupe.facetAddress(s.selector)).toLowerCase();
        if (routed === facets[p.key].toLowerCase() || cfg.local) break;
        await new Promise((r) => setTimeout(r, 5000));
      }
      if (routed !== facets[p.key].toLowerCase()) throw new Error(`${p.label}.${s.name} ${s.selector} routes to ${routed}, expected ${facets[p.key]}`);
    }
    console.log(`  ✔ ${p.label}: all ${p.selectors.length} selectors → ${facets[p.key]}`);
  }
  const stateAfter = await readOracleState(oracle);
  printState("Oracle after ", stateAfter);
  if (JSON.stringify(stateAfter) !== JSON.stringify(stateBefore)) throw new Error("Oracle state changed during the cut — investigate");
  const totalsAfter = await readQuestionTotals(adapter);
  if (JSON.stringify(totalsAfter) !== JSON.stringify(totalsBefore)) throw new Error("Question totals changed during the cut — investigate");
  console.log("  ✔ oracle state and question totals untouched");
  const stalenessAfter = await adminConfig.getMaxOracleStaleness();
  if (maxOracleStaleness !== null && stalenessAfter !== maxOracleStaleness) {
    throw new Error(`maxOracleStaleness is ${stalenessAfter}, expected ${maxOracleStaleness}`);
  }
  console.log(`  ✔ maxOracleStaleness = ${stalenessAfter}${stalenessAfter === 0 ? " (disabled — set it with setMaxOracleStaleness)" : " s"}`);

  const summary = {
    ticket: "SCRUM-214",
    findings: "ORC-001..ORC-011",
    network: cfg.name,
    chainId: Number(net.chainId),
    diamond,
    owner,
    cutRoute: mode,
    blockHeaderUtils: library,
    facets,
    cut: cut.map((c) => ({ ...c, action: Object.keys(FacetCutAction).find((k) => FacetCutAction[k] === c.action) })),
    maxOracleStaleness: stalenessAfter,
    cutTxHash,
    safeTxHash,
    oracleStateBefore: stateBefore,
    oracleStateAfter: stateAfter,
    questionTotals: totalsAfter,
    timestamp: new Date().toISOString(),
  };
  if (record) {
    const dir = path.join(__dirname, "..", "..", "deployments", cfg.name);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `scrum214-oracle-hardening-${summary.timestamp.replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(file, JSON.stringify(summary, null, 2) + "\n");
    console.log(`  Record written: ${path.relative(process.cwd(), file)}`);
  }

  console.log("\n==========================================================");
  console.log("  ✅ SCRUM-214 oracle hardening cut applied");
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
      console.error("\n❌ SCRUM-214 oracle hardening cut failed:", e);
      process.exit(1);
    });
}

module.exports = { runUpgrade };
