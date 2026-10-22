/* global ethers */
/**
 * Block-header oracle status — is the oracle live, and is its stored tip the real chain?
 *
 * Reads the Diamond's oracle views and cross-checks them against the public Bitcoin
 * chain (mempool.space by default):
 *   - stored tip: height, hash, timestamp (+ age), ring-buffer pointer
 *   - facet currently behind `submitBatchBlocks` (shows whether the SCRUM-521 cut is live)
 *   - lag behind the Bitcoin tip, and whether the stored tip is the canonical block at
 *     that height (an orphaned tip is the SEC-015 incident signature)
 *   - optionally the whole 17-slot window with its hash-chain links (ORACLE_STATUS_WINDOW=true)
 *
 * Exit codes (usable as a health check):
 *   0  healthy      1  stored tip is not canonical (orphan)      2  lag > ORACLE_STATUS_MAX_LAG
 *   3  unrecognised state (uninitialised oracle)                 4  read failure
 * The remote cross-check is best-effort: if the API is unreachable the script says so and
 * skips the canonical / lag verdicts (exit 0 unless another check fails).
 *
 * Env:
 *   DIAMOND_ADDRESS          optional on base / baseSepolia (per-network default); required elsewhere.
 *                            Read-only tool, so a DIAMOND_ADDRESS with no bytecode on the selected
 *                            chain (e.g. the Sepolia address left in .env while checking base) is
 *                            ignored with a warning and the per-network default is used instead.
 *   ORACLE_STATUS_MAX_LAG    blocks behind the Bitcoin tip before exit 2 (default 12 ≈ 2 h; block-indexer
 *                            polls every ~8 min and catches up in batches of 10)
 *   ORACLE_STATUS_WINDOW     "true" to print all 17 buffered headers
 *   ORACLE_STATUS_OFFLINE    "true" to skip the mempool.space cross-check
 *   MEMPOOL_API              base URL of a mempool.space-compatible API (default https://mempool.space/api)
 *
 * Usage:
 *   npm run oracle:status:baseSepolia
 *   npm run oracle:status:base
 */

const hre = require("hardhat");
const { networkConfig } = require("./upgrades/upgrade-scrum521-oracle-reorg-underflow.js");

const MEMPOOL_API = process.env.MEMPOOL_API || "https://mempool.space/api";
const MAX_LAG = Number(process.env.ORACLE_STATUS_MAX_LAG || 12);
const RING = 17;

function age(tsSeconds) {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - tsSeconds));
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} d`;
}

/** Per-network default unless DIAMOND_ADDRESS is set AND has bytecode on this chain. */
async function resolveDiamondForRead(cfg) {
  const override = process.env.DIAMOND_ADDRESS;
  if (override) {
    if (!ethers.utils.isAddress(override)) throw new Error(`Invalid DIAMOND_ADDRESS: ${override}`);
    if ((await ethers.provider.getCode(override)) !== "0x") {
      if (cfg.diamond && override.toLowerCase() !== cfg.diamond.toLowerCase()) {
        console.log(`  ⚠ DIAMOND_ADDRESS override in effect: ${override} (default for ${cfg.name} is ${cfg.diamond})`);
      }
      return override;
    }
    if (!cfg.diamond) throw new Error(`No bytecode at DIAMOND_ADDRESS ${override} on ${cfg.name}, and no default for this network`);
    console.log(`  ⚠ DIAMOND_ADDRESS=${override} has no bytecode on ${cfg.name} — ignoring it, using the ${cfg.name} default ${cfg.diamond}`);
  }
  if (!cfg.diamond) throw new Error(`No default Diamond for network "${cfg.name}" — set DIAMOND_ADDRESS`);
  if ((await ethers.provider.getCode(cfg.diamond)) === "0x") throw new Error(`No bytecode at ${cfg.diamond} on ${cfg.name}`);
  return cfg.diamond;
}

async function remote(path) {
  const res = await fetch(`${MEMPOOL_API}${path}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.text()).trim();
}

async function main() {
  const cfg = networkConfig();
  const net = await ethers.provider.getNetwork();
  if (cfg.chainId !== null && Number(net.chainId) !== cfg.chainId) {
    throw new Error(`Expected chainId ${cfg.chainId} for "${cfg.name}", provider reports ${net.chainId}`);
  }
  const diamond = await resolveDiamondForRead(cfg);
  const oracle = await ethers.getContractAt("IDoefinBlockHeaderOracle", diamond);
  const loupe = await ethers.getContractAt("IDiamondLoupe", diamond);
  const submitBatchSelector = oracle.interface.getSighash("submitBatchBlocks");

  let height, nextBlockIndex, tip, facet;
  try {
    [height, nextBlockIndex, tip, facet] = await Promise.all([
      oracle.getCurrentBlockHeight(),
      oracle.getNextBlockIndex(),
      oracle.getLatestBlockHeader(),
      loupe.facetAddress(submitBatchSelector),
    ]);
  } catch (err) {
    console.error(`❌ read failure: ${err.message || err}`);
    process.exit(4);
  }
  height = height.toNumber();
  nextBlockIndex = nextBlockIndex.toNumber();

  console.log("==========================================================");
  console.log(`  Block-header oracle status — ${cfg.name} (chainId ${net.chainId})`);
  console.log("==========================================================");
  console.log(`  Diamond:                 ${diamond}`);
  console.log(`  submitBatchBlocks facet: ${facet}`);
  if (height === 0) {
    console.log("  Oracle is NOT initialised (currentBlockHeight == 0).");
    process.exit(3);
  }
  console.log(`  Stored tip:              #${height}  ${tip.blockHash}`);
  console.log(`  Tip mined:               ${new Date(tip.timestamp * 1000).toISOString()}  (${age(tip.timestamp)} ago)`);
  console.log(`  nextBlockIndex:          ${nextBlockIndex}  (tip sits in slot ${(nextBlockIndex + RING - 1) % RING})`);

  if (process.env.ORACLE_STATUS_WINDOW === "true") {
    console.log("\n  Ring buffer (oldest → newest):");
    const oldest = Math.max(height - RING + 1, 1);
    let prev = null;
    for (let h = oldest; h <= height; h++) {
      const hdr = await oracle.getBlockHeaderByNumber(h);
      const link = prev === null ? "" : hdr.prevBlockHash.toLowerCase() === prev.toLowerCase() ? " ✔ links" : " ✘ BROKEN LINK";
      console.log(`    #${h}  ${hdr.blockHash}${link}`);
      prev = hdr.blockHash;
    }
  }

  let exitCode = 0;
  if (process.env.ORACLE_STATUS_OFFLINE === "true") {
    console.log("\n  Remote cross-check skipped (ORACLE_STATUS_OFFLINE=true).");
  } else {
    try {
      const btcTip = Number(await remote("/blocks/tip/height"));
      const canonical = await remote(`/block-height/${height}`);
      const lag = btcTip - height;
      const isCanonical = tip.blockHash.slice(2).toLowerCase() === canonical.toLowerCase();
      console.log(`\n  Bitcoin tip (${MEMPOOL_API}): #${btcTip}  → oracle is ${lag} block(s) behind${lag <= MAX_LAG ? "" : `  ✘ exceeds ORACLE_STATUS_MAX_LAG=${MAX_LAG}`}`);
      if (isCanonical) {
        console.log(`  Stored tip is CANONICAL ✔`);
      } else {
        console.log(`  Stored tip is NOT canonical ✘ — canonical #${height} is 0x${canonical}`);
        console.log(`  This is the SEC-015 signature (orphaned tip). Recovery: SCRUM-521 cut + npm run oracle:replay:${cfg.name === "base" ? "base" : "baseSepolia"}.`);
        exitCode = 1;
      }
      if (exitCode === 0 && lag > MAX_LAG) exitCode = 2;
    } catch (err) {
      console.log(`\n  Remote cross-check unavailable (${err.message || err}) — canonical / lag verdicts skipped.`);
    }
  }
  console.log("==========================================================");
  console.log(exitCode === 0 ? "  ✅ healthy" : `  ❌ unhealthy (exit ${exitCode})`);
  console.log("==========================================================\n");
  process.exit(exitCode);
}

main().catch((e) => {
  console.error("\n❌ oracle-status failed:", e.message || e);
  process.exit(4);
});
