/* global ethers */
/**
 * SCRUM-521 — submit the reorg replay batch that block-indexer has been holding since
 * 2026-09-15 15:45 UTC, once the fixed `submitBatchBlocks` is live on the Diamond.
 *
 * Why a separate step: the diamondCut only swaps code. The oracle still sits on the
 * orphaned 967143 (`nextBlockIndex = 0`), and block-indexer's guard keeps holding the
 * batch while `nextBlockIndex <= depth`. Submitting the held batch here moves the tip
 * to 967146 (`nextBlockIndex = 3`); from there block-indexer's normal linear catch-up
 * (depth 0, never guarded) takes over.
 *
 * `submitBatchBlocks` is permissionless, so any funded EOA can send this.
 *
 * Safety: only submits when the on-chain state is exactly the incident state
 * (tip == the orphan 967143, `getNextBlockIndex() == 0`). Exits cleanly if the
 * oracle already holds the canonical 967143. Refuses anything else. Simulates the
 * batch first: a Panic(0x11) means the fix is not live yet.
 *
 * Env:
 *   DIAMOND_ADDRESS   optional on base / baseSepolia (per-network default)
 *   PRIVATE_KEY       sender EOA (gas only)
 *   REPLAY_THROUGH    last height to submit, 967146 (default, the exact held batch) … 967160
 *   DRY_RUN=true      simulate only
 */

const hre = require("hardhat");
const { networkConfig, resolveDiamond, readOracleState, printState } = require("./upgrades/upgrade-scrum521-oracle-reorg-underflow.js");
const { ORPHAN, ORPHAN_HEIGHT, CANONICAL_143, HELD_BATCH_TIP, FIXTURE_LAST, RING, headers, sameHash } = require("./lib/oracle-fixture.js");

const BLOCK_REORGED_TOPIC = ethers.utils.id("BlockReorged(bytes32)");
const BLOCK_SUBMITTED_TOPIC = ethers.utils.id("BlockSubmitted(bytes32,uint32)");

async function replayHeldBatch({ diamond, signer, through = HELD_BATCH_TIP, dryRun = false }) {
  if (!Number.isInteger(through) || through < HELD_BATCH_TIP || through > FIXTURE_LAST) {
    throw new Error(`REPLAY_THROUGH must be in ${HELD_BATCH_TIP}..${FIXTURE_LAST}, got ${through}`);
  }
  const oracle = (await ethers.getContractAt("IDoefinBlockHeaderOracle", diamond)).connect(signer);
  const before = await readOracleState(oracle);
  printState("Oracle before", before);

  if (before.height >= ORPHAN_HEIGHT) {
    // 967143 leaves the window exactly when getBlockHeaderByNumber would revert ValueOutOfRange:
    // blockNumber <= currentHeight - NUM_OF_BLOCK_HEADERS  <=>  height >= ORPHAN_HEIGHT + RING.
    if (before.height >= ORPHAN_HEIGHT + RING) {
      console.log(`  ${ORPHAN_HEIGHT} is outside the ${RING}-slot window (height ${before.height}) — the orphan was replaced; nothing to replay.`);
      return { recovered: true, before, after: before };
    }
    // In-window read: any error here (RPC timeout, rate limit, provider fault) must propagate.
    const held143 = (await oracle.getBlockHeaderByNumber(ORPHAN_HEIGHT)).blockHash;
    if (sameHash(held143, CANONICAL_143.blockHash)) {
      console.log(`  Oracle already holds the canonical chain (height ${before.height}) — nothing to replay.`);
      return { recovered: true, before, after: before };
    }
  }

  const stuck = before.height === ORPHAN_HEIGHT && before.nextBlockIndex === 0 && sameHash(before.tipHash, ORPHAN.blockHash);
  if (!stuck) {
    throw new Error(
      `Unrecognised oracle state (height ${before.height}, nextBlockIndex ${before.nextBlockIndex}, tip ${before.tipHash}). ` +
        `Expected the incident state: height ${ORPHAN_HEIGHT}, nextBlockIndex 0, tip ${ORPHAN.blockHash}. Refusing to submit.`
    );
  }

  const batch = headers(ORPHAN_HEIGHT, through);
  console.log(`  Replay batch: ${batch.length} headers, ${ORPHAN_HEIGHT} (canonical) .. ${through}`);

  try {
    const gas = await oracle.estimateGas.submitBatchBlocks(batch);
    console.log(`  Simulation OK — gas estimate ${gas.toString()}`);
  } catch (err) {
    const msg = String(err.message || err);
    if (/panic code 0x11|0x4e487b71/i.test(msg)) {
      throw new Error("Simulation reverted with Panic(0x11): the fixed submitBatchBlocks is NOT live on this Diamond. Run the SCRUM-521 upgrade first.");
    }
    throw new Error(`Simulation reverted: ${msg}`);
  }

  if (dryRun) {
    console.log("  DRY_RUN — not submitting.");
    return { recovered: false, dryRun: true, before, batch };
  }

  const tx = await oracle.submitBatchBlocks(batch);
  console.log(`  Sent ${tx.hash} — waiting…`);
  const receipt = await tx.wait();
  const reorged = receipt.logs.filter((l) => l.topics[0] === BLOCK_REORGED_TOPIC).length;
  const submitted = receipt.logs.filter((l) => l.topics[0] === BLOCK_SUBMITTED_TOPIC).length;
  console.log(`  Mined in block ${receipt.blockNumber}, gas ${receipt.gasUsed.toString()}; BlockReorged×${reorged}, BlockSubmitted×${submitted}`);

  const after = await readOracleState(oracle);
  printState("Oracle after ", after);
  const expectedIndex = (before.nextBlockIndex + RING - 1 + batch.length) % RING; // rewind depth 1, apply batch
  const problems = [];
  if (after.height !== through) problems.push(`height ${after.height} ≠ ${through}`);
  if (after.nextBlockIndex !== expectedIndex) problems.push(`nextBlockIndex ${after.nextBlockIndex} ≠ ${expectedIndex}`);
  if (reorged !== 1) problems.push(`BlockReorged emitted ${reorged}×, expected 1`);
  if (submitted !== batch.length) problems.push(`BlockSubmitted emitted ${submitted}×, expected ${batch.length}`);
  const now143 = (await oracle.getBlockHeaderByNumber(ORPHAN_HEIGHT)).blockHash;
  if (!sameHash(now143, CANONICAL_143.blockHash)) problems.push(`967143 is ${now143}, expected canonical ${CANONICAL_143.blockHash}`);
  if (problems.length) throw new Error(`Post-state mismatch: ${problems.join("; ")}`);
  console.log(`  ✔ tip advanced ${ORPHAN_HEIGHT} (orphan) → ${through}; 967143 is now canonical; nextBlockIndex ${after.nextBlockIndex}`);
  return { recovered: true, before, after, txHash: receipt.transactionHash, reorged, submitted, batch };
}

async function main() {
  const cfg = networkConfig();
  const net = await ethers.provider.getNetwork();
  if (cfg.chainId !== null && Number(net.chainId) !== cfg.chainId) {
    throw new Error(`Expected chainId ${cfg.chainId} for "${cfg.name}", provider reports ${net.chainId}`);
  }
  const diamond = await resolveDiamond(cfg);
  const [signer] = await ethers.getSigners();
  const through = Number(process.env.REPLAY_THROUGH || HELD_BATCH_TIP);

  console.log("==========================================================");
  console.log(`  SCRUM-521 — replay held reorg batch${cfg.mainnet ? "  (MAINNET)" : ""}`);
  console.log("==========================================================");
  console.log(`  Network:  ${cfg.name} (chainId ${net.chainId})`);
  console.log(`  Diamond:  ${diamond}`);
  console.log(`  Sender:   ${signer.address}`);
  const result = await replayHeldBatch({ diamond, signer, through, dryRun: process.env.DRY_RUN === "true" });
  if (result.txHash && cfg.explorer) console.log(`  Tx: ${cfg.explorer}/tx/${result.txHash}`);
  console.log("==========================================================\n");
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("\n❌ replay failed:", e.message || e);
      process.exit(1);
    });
}

module.exports = { replayHeldBatch };
