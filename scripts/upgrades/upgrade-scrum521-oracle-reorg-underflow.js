/* global ethers */
/* eslint prefer-const: "off" */
/**
 * SCRUM-521 — DoefinV1BlockHeaderOracle: `submitBatchBlocks` reorg-rewind index underflow.
 *
 * Incident: Base mainnet oracle frozen since 2026-09-15 15:45 UTC on an orphaned
 * Bitcoin block 967143 held in ring slot 16 (`nextBlockIndex = 0`). The depth-1
 * replay reverts Panic(0x11) because the rewind arithmetic underflows whenever
 * `nextBlockIndex <= depth`. Only a facet replacement clears it.
 *
 * What this script does — a SINGLE-SELECTOR Replace cut:
 *   1. Pre-flight: network/chainId, Diamond bytecode, owner, oracle state
 *      (height / nextBlockIndex / tip), facet currently behind `submitBatchBlocks`.
 *   2. Deploys BlockHeaderUtils (or reuses BLOCK_HEADER_UTILS_ADDRESS) and the fixed
 *      DoefinV1BlockHeaderOracle linked against it (or reuses NEW_ORACLE_FACET_ADDRESS).
 *   3. diamondCut([{ Replace, newFacet, [submitBatchBlocks] }], 0x0, "0x").
 *      Only that selector moves. The facet's other 11 selectors keep routing to the
 *      old facet — same Diamond storage, unchanged code, so nothing else changes.
 *   4. Routing of the cut, decided from `owner()`:
 *        - local / fork network  → impersonate the owner (hardhat_impersonateAccount)
 *        - owner is a contract   → Gnosis Safe MultiSend ceremony (proposeAndExecute);
 *                                  SAFE_ADDRESS must equal owner(), PRIVATE_KEY must be
 *                                  a Safe signer (1-of-1 auto-executes)
 *        - owner is the deployer → direct diamondCut from the EOA
 *   5. Post-check via DiamondLoupe: `submitBatchBlocks` → new facet, every other
 *      oracle selector still → old facet, oracle state untouched by the cut.
 *   6. Writes deployments/<network>/scrum521-oracle-upgrade-<timestamp>.json
 *      (public networks only).
 *
 * The cut does NOT advance the oracle. Afterwards run `scripts/oracle-replay-batch.js`
 * (or let block-indexer resubmit once its guard is relaxed) to replay the held batch.
 *
 * Env:
 *   DIAMOND_ADDRESS              optional on base / baseSepolia (per-network default); required elsewhere
 *   SAFE_ADDRESS                 required when owner() is a contract; must equal owner()
 *   PRIVATE_KEY                  deployer EOA (pays the facet deploy; Safe signer when Safe-routed)
 *   BASE_MAINNET_RPC_ENDPOINT    RPC for the Safe SDK on base
 *   BASE_SEPOLIA_RPC_ENDPOINT    RPC for the Safe SDK on baseSepolia
 *   BLOCK_HEADER_UTILS_ADDRESS   optional — reuse an existing BlockHeaderUtils library
 *   NEW_ORACLE_FACET_ADDRESS     optional — reuse an already-deployed fixed facet
 *   SKIP_VERIFY=true             skip Basescan verification of the new contracts
 *   DRY_RUN=true                 pre-flight + cut plan only; no deploy, no cut
 *
 * Usage:
 *   npm run upgrade:scrum521:baseSepolia
 *   npm run upgrade:scrum521:base
 *   npm run upgrade:scrum521:rehearse      (mainnet-fork rehearsal, see rehearse-scrum521-fork.js)
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { proposeAndExecute, safeNetworkPrefix } = require("../lib/safe-multisend.js");

const BASE_MAINNET_DIAMOND = "0x71C424Ef79819c852952e517c082C4d17f89Fdf9";
const BASE_SEPOLIA_DIAMOND = "0x2f03d47520fb8bc8aDAab392BF280D99De7cAe3f";

const NETWORKS = {
  base: { chainId: 8453, diamond: BASE_MAINNET_DIAMOND, rpcEnv: "BASE_MAINNET_RPC_ENDPOINT", explorer: "https://basescan.org", mainnet: true, local: false },
  baseSepolia: { chainId: 84532, diamond: BASE_SEPOLIA_DIAMOND, rpcEnv: "BASE_SEPOLIA_RPC_ENDPOINT", explorer: "https://sepolia.basescan.org", mainnet: false, local: false },
  // Local networks: the in-process hardhat network (the rehearsal forks Base mainnet
  // into it at runtime), an external hardhat node, or a `baseFork` entry if the config
  // defines one. chainId is not asserted for these — a runtime fork keeps 31337.
  baseFork: { chainId: null, diamond: BASE_MAINNET_DIAMOND, rpcEnv: null, explorer: null, mainnet: false, local: true },
  hardhat: { chainId: null, diamond: null, rpcEnv: null, explorer: null, mainnet: false, local: true },
  localhost: { chainId: null, diamond: null, rpcEnv: null, explorer: null, mainnet: false, local: true },
};

const FacetCutAction = { Add: 0, Replace: 1, Remove: 2 };
const BANNER_PAUSE_MS = 5000;

function networkConfig() {
  const name = hre.network.name;
  const cfg = NETWORKS[name];
  if (!cfg) throw new Error(`Unsupported network "${name}". Supported: ${Object.keys(NETWORKS).join(", ")}`);
  return { name, ...cfg };
}

async function resolveDiamond(cfg) {
  const diamond = process.env.DIAMOND_ADDRESS || cfg.diamond;
  if (!diamond) throw new Error(`No default Diamond for network "${cfg.name}" — set DIAMOND_ADDRESS`);
  if (!ethers.utils.isAddress(diamond)) throw new Error(`Invalid DIAMOND_ADDRESS: ${diamond}`);
  if (process.env.DIAMOND_ADDRESS && cfg.diamond && process.env.DIAMOND_ADDRESS.toLowerCase() !== cfg.diamond.toLowerCase()) {
    console.log(`  ⚠ DIAMOND_ADDRESS override in effect: ${diamond} (default for ${cfg.name} is ${cfg.diamond})`);
  }
  if ((await ethers.provider.getCode(diamond)) === "0x") {
    throw new Error(`No bytecode at Diamond ${diamond} on ${cfg.name} — is a stale DIAMOND_ADDRESS leaking from .env?`);
  }
  return diamond;
}

async function readOracleState(oracle) {
  const [height, nextBlockIndex, tip] = await Promise.all([
    oracle.getCurrentBlockHeight(),
    oracle.getNextBlockIndex(),
    oracle.getLatestBlockHeader(),
  ]);
  return {
    height: height.toNumber(),
    nextBlockIndex: nextBlockIndex.toNumber(),
    tipNumber: tip.blockNumber.toNumber(),
    tipHash: tip.blockHash,
  };
}

function printState(label, s) {
  console.log(`  ${label}: height=${s.height} nextBlockIndex=${s.nextBlockIndex} tip=#${s.tipNumber} ${s.tipHash}`);
}

function selectorTable(factory) {
  return Object.values(factory.interface.functions)
    .filter((f) => f.type === "function")
    .map((f) => ({ name: f.name, selector: factory.interface.getSighash(f) }));
}

async function verifyOnExplorer({ address, libraries, skip }) {
  if (skip) return;
  try {
    await hre.run("verify:verify", { address, constructorArguments: [], ...(libraries ? { libraries } : {}) });
    console.log(`  ✔ verified ${address}`);
  } catch (err) {
    console.warn(`  ⚠ verification skipped for ${address}: ${err.message}`);
  }
}

async function impersonate(address) {
  await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [address] });
  await hre.network.provider.send("hardhat_setBalance", [address, "0x56BC75E2D63100000"]); // 100 ETH
  return ethers.getSigner(address);
}

/**
 * Runs the upgrade. Returns the addresses and tx hashes involved.
 *
 * @param {object} opts
 * @param {string}  [opts.diamond]            Diamond address (default per network / DIAMOND_ADDRESS)
 * @param {boolean} [opts.impersonateOwner]   force owner impersonation (local/fork only)
 * @param {boolean} [opts.skipVerify]
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.record]             write deployments/<network>/…json (default: public networks)
 * @param {string}  [opts.libraryAddress]     reuse BlockHeaderUtils
 * @param {string}  [opts.facetAddress]       reuse fixed facet
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
  const libraryAddress = opts.libraryAddress || process.env.BLOCK_HEADER_UTILS_ADDRESS || null;
  const facetAddress = opts.facetAddress || process.env.NEW_ORACLE_FACET_ADDRESS || null;

  const [deployer] = await ethers.getSigners();
  const ownership = await ethers.getContractAt("OwnershipFacet", diamond);
  const loupe = await ethers.getContractAt("IDiamondLoupe", diamond);
  const diamondCut = await ethers.getContractAt("IDiamondCut", diamond);
  const oracle = await ethers.getContractAt("IDoefinBlockHeaderOracle", diamond);

  const owner = await ownership.owner();
  const ownerIsContract = (await ethers.provider.getCode(owner)) !== "0x";

  // ---------------------------------------------------------------- pre-flight
  console.log("==========================================================");
  console.log(`  SCRUM-521 — submitBatchBlocks Replace cut${cfg.mainnet ? "  (MAINNET — REAL MONEY)" : ""}`);
  console.log("==========================================================");
  console.log(`  Network:   ${cfg.name} (chainId ${net.chainId})`);
  console.log(`  Diamond:   ${diamond}`);
  console.log(`  Owner:     ${owner} (${ownerIsContract ? "contract — Safe" : "EOA"})`);
  console.log(`  Deployer:  ${deployer.address}`);

  const stateBefore = await readOracleState(oracle);
  printState("Oracle before", stateBefore);

  const OracleFactory = await ethers.getContractFactory("DoefinV1BlockHeaderOracle", {
    libraries: { BlockHeaderUtils: libraryAddress || ethers.constants.AddressZero },
  });
  const selectors = selectorTable(OracleFactory);
  const target = selectors.find((s) => s.name === "submitBatchBlocks");
  if (!target) throw new Error("submitBatchBlocks not found in the DoefinV1BlockHeaderOracle ABI");
  const others = selectors.filter((s) => s.selector !== target.selector);

  const oldFacet = await loupe.facetAddress(target.selector);
  if (oldFacet === ethers.constants.AddressZero) {
    throw new Error(`Diamond ${diamond} does not route submitBatchBlocks ${target.selector} — wrong Diamond?`);
  }
  const oldFacetSelectors = (await loupe.facetFunctionSelectors(oldFacet)).map((s) => s.toLowerCase());
  const strayOthers = others.filter((s) => !oldFacetSelectors.includes(s.selector.toLowerCase()));
  console.log(`  Current facet behind submitBatchBlocks (${target.selector}): ${oldFacet}`);
  console.log(`  That facet serves ${oldFacetSelectors.length} selectors; ${others.length} other oracle selectors stay on it.`);
  if (strayOthers.length) {
    console.log(`  ⚠ ${strayOthers.length} oracle selector(s) are NOT on that facet (fine, informational): ${strayOthers.map((s) => s.name).join(", ")}`);
  }

  let mode;
  if (cfg.local || opts.impersonateOwner) {
    mode = "impersonate";
  } else if (ownerIsContract) {
    mode = "safe";
    const safeAddress = process.env.SAFE_ADDRESS;
    if (!safeAddress) throw new Error("Diamond owner is a contract (Safe) — set SAFE_ADDRESS");
    if (safeAddress.toLowerCase() !== owner.toLowerCase()) {
      throw new Error(`SAFE_ADDRESS ${safeAddress} ≠ Diamond owner ${owner}`);
    }
    if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY (a Safe signer) is required for the Safe ceremony");
    if (!cfg.rpcEnv || !process.env[cfg.rpcEnv]) throw new Error(`${cfg.rpcEnv} is required for the Safe SDK`);
    const safe = new ethers.Contract(owner, ["function getOwners() view returns (address[])"], ethers.provider);
    const signers = (await safe.getOwners()).map((o) => o.toLowerCase());
    if (!signers.includes(deployer.address.toLowerCase())) {
      throw new Error(`Deployer ${deployer.address} is not a signer on Safe ${owner}`);
    }
  } else if (owner.toLowerCase() === deployer.address.toLowerCase()) {
    mode = "direct";
  } else {
    throw new Error(`Diamond owner ${owner} is an EOA that is not the deployer ${deployer.address} — cannot cut`);
  }
  console.log(`  Cut route: ${mode}`);
  console.log("==========================================================");

  if (dryRun) {
    console.log("\nDRY_RUN — stopping before any deployment or cut.");
    return { dryRun: true, diamond, owner, oldFacet, selector: target.selector, stateBefore };
  }

  if (cfg.mainnet) {
    console.log(`  Pausing ${BANNER_PAUSE_MS / 1000}s before deploying — Ctrl-C to abort.\n`);
    await new Promise((r) => setTimeout(r, BANNER_PAUSE_MS));
  }

  // ---------------------------------------------------------------- deploy
  console.log("\n--- Step 1: BlockHeaderUtils library ---");
  let library = libraryAddress;
  if (library) {
    if ((await ethers.provider.getCode(library)) === "0x") throw new Error(`No bytecode at BLOCK_HEADER_UTILS_ADDRESS ${library}`);
    console.log(`  Reusing BlockHeaderUtils at ${library}`);
  } else {
    const Lib = await ethers.getContractFactory("BlockHeaderUtils");
    const lib = await Lib.deploy();
    await lib.deployed();
    if (!cfg.local) await lib.deployTransaction.wait(2);
    library = lib.address;
    console.log(`  Deployed BlockHeaderUtils at ${library}`);
    await verifyOnExplorer({ address: library, skip: skipVerify });
  }

  console.log("\n--- Step 2: fixed DoefinV1BlockHeaderOracle facet ---");
  const LinkedFactory = await ethers.getContractFactory("DoefinV1BlockHeaderOracle", {
    libraries: { BlockHeaderUtils: library },
  });
  let newFacet = facetAddress;
  if (newFacet) {
    if ((await ethers.provider.getCode(newFacet)) === "0x") throw new Error(`No bytecode at NEW_ORACLE_FACET_ADDRESS ${newFacet}`);
    console.log(`  Reusing fixed facet at ${newFacet}`);
  } else {
    const facet = await LinkedFactory.deploy();
    await facet.deployed();
    if (!cfg.local) await facet.deployTransaction.wait(2);
    newFacet = facet.address;
    console.log(`  Deployed fixed facet at ${newFacet}`);
    console.log(`  (reuse with NEW_ORACLE_FACET_ADDRESS=${newFacet} BLOCK_HEADER_UTILS_ADDRESS=${library})`);
    await verifyOnExplorer({ address: newFacet, libraries: { BlockHeaderUtils: library }, skip: skipVerify });
  }
  if (newFacet.toLowerCase() === oldFacet.toLowerCase()) throw new Error("New facet address equals the current one — nothing to replace");

  // ---------------------------------------------------------------- cut
  const cut = [{ facetAddress: newFacet, action: FacetCutAction.Replace, functionSelectors: [target.selector] }];
  const cutCalldata = diamondCut.interface.encodeFunctionData("diamondCut", [cut, ethers.constants.AddressZero, "0x"]);

  console.log("\n--- Step 3: diamondCut (Replace, 1 selector) ---");
  console.log(`  Replace ${target.selector} submitBatchBlocks: ${oldFacet} → ${newFacet}`);

  let cutTxHash;
  let safeTxHash = null;
  if (mode === "safe") {
    const result = await proposeAndExecute({
      safeAddress: owner,
      chainId: Number(net.chainId),
      rpcUrl: process.env[cfg.rpcEnv],
      signerKey: process.env.PRIVATE_KEY,
      transactions: [{ to: diamond, data: cutCalldata }],
      label: "SCRUM-521 submitBatchBlocks Replace",
    });
    cutTxHash = result.executionTxHash;
    safeTxHash = result.safeTxHash;
  } else {
    const cutter = mode === "impersonate" ? await impersonate(owner) : deployer;
    if (mode === "impersonate") console.log(`  Impersonating owner ${owner}`);
    const gas = await diamondCut.connect(cutter).estimateGas.diamondCut(cut, ethers.constants.AddressZero, "0x");
    console.log(`  Gas estimate: ${gas.toString()}`);
    const tx = await diamondCut.connect(cutter).diamondCut(cut, ethers.constants.AddressZero, "0x");
    const receipt = await tx.wait();
    cutTxHash = receipt.transactionHash;
    console.log(`  Cut tx: ${cutTxHash} (block ${receipt.blockNumber}, gas ${receipt.gasUsed.toString()})`);
  }

  // ---------------------------------------------------------------- post-check
  console.log("\n--- Step 4: post-check ---");
  const routed = await loupe.facetAddress(target.selector);
  if (routed.toLowerCase() !== newFacet.toLowerCase()) {
    throw new Error(`submitBatchBlocks routes to ${routed}, expected ${newFacet}`);
  }
  console.log(`  ✔ submitBatchBlocks → ${routed}`);
  for (const s of others) {
    const where = await loupe.facetAddress(s.selector);
    const expected = oldFacetSelectors.includes(s.selector.toLowerCase()) ? oldFacet : where;
    if (where.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`${s.name} ${s.selector} moved to ${where} — expected ${expected}`);
    }
  }
  console.log(`  ✔ the other ${others.length} oracle selectors still route as before`);
  const stateAfter = await readOracleState(oracle);
  printState("Oracle after ", stateAfter);
  if (JSON.stringify(stateAfter) !== JSON.stringify(stateBefore)) {
    throw new Error("Oracle state changed during the cut — investigate before continuing");
  }
  console.log("  ✔ oracle state untouched by the cut (the replay is a separate step)");

  const summary = {
    ticket: "SCRUM-521",
    network: cfg.name,
    chainId: Number(net.chainId),
    diamond,
    owner,
    cutRoute: mode,
    selector: target.selector,
    oldFacet,
    newFacet,
    blockHeaderUtils: library,
    cutTxHash,
    safeTxHash,
    oracleStateBefore: stateBefore,
    oracleStateAfter: stateAfter,
    timestamp: new Date().toISOString(),
  };

  if (record) {
    const dir = path.join(__dirname, "..", "..", "deployments", cfg.name);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `scrum521-oracle-upgrade-${summary.timestamp.replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(file, JSON.stringify(summary, null, 2) + "\n");
    console.log(`  Record written: ${path.relative(process.cwd(), file)}`);
  }

  console.log("\n==========================================================");
  console.log("  ✅ SCRUM-521 cut applied");
  if (cfg.explorer) console.log(`  Cut tx:   ${cfg.explorer}/tx/${cutTxHash}`);
  if (safeTxHash) console.log(`  Safe UI:  https://app.safe.global/transactions/history?safe=${safeNetworkPrefix(net.chainId)}:${owner}`);
  if (!cfg.local) {
    console.log(`  Next: replay the held batch — npm run oracle:replay:${cfg.name} (or let block-indexer resubmit once its guard is relaxed).`);
  }
  console.log("==========================================================\n");
  return summary;
}

async function main() {
  await runUpgrade();
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("\n❌ SCRUM-521 upgrade failed:", e);
      process.exit(1);
    });
}

module.exports = { runUpgrade, networkConfig, resolveDiamond, readOracleState, printState, NETWORKS, BASE_MAINNET_DIAMOND, BASE_SEPOLIA_DIAMOND };
