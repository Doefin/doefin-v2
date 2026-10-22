/* global ethers */
/**
 * SCRUM-521 — full rehearsal against a fork of Base mainnet's REAL stuck state.
 *
 * Runs the exact production sequence end to end on a fork:
 *   1. reads the live incident state (height 967143, nextBlockIndex 0, tip = orphan)
 *   2. applies the single-selector Replace cut with the owner Safe impersonated
 *   3. submits the batch block-indexer has been holding ([967143 canonical .. 967146])
 *   4. asserts height 967146 / nextBlockIndex 3 / canonical 967143 / one BlockReorged
 *   5. keeps submitting 967147..967160 (submitNextBlock) and checks the pointer walks
 *      4 → 16 → 0 without incident
 *
 * Run (in-process fork — the script forks Base mainnet itself via `hardhat_reset`,
 * so it needs no fork entry in hardhat.config.js):
 *   npm run upgrade:scrum521:rehearse
 *   (= npx hardhat run scripts/upgrades/rehearse-scrum521-fork.js)
 * It also works against an external hardhat node that already forks Base mainnet
 * (`--network localhost` / `baseFork`); it then skips the reset.
 *
 * Needs BASE_MAINNET_RPC_ENDPOINT (optionally FORK_BLOCK_NUMBER to pin the fork).
 * Never touches mainnet.
 */

const hre = require("hardhat");
const { runUpgrade, readOracleState, printState, BASE_MAINNET_DIAMOND } = require("./upgrade-scrum521-oracle-reorg-underflow.js");
const { replayHeldBatch } = require("../oracle-replay-batch.js");
const { ORPHAN, ORPHAN_HEIGHT, CANONICAL_143, HELD_BATCH_TIP, FIXTURE_LAST, RING, byHeight, sameHash } = require("../lib/oracle-fixture.js");

function check(cond, msg, failures) {
  if (cond) console.log(`  ✔ ${msg}`);
  else {
    console.log(`  ✘ ${msg}`);
    failures.push(msg);
  }
}

async function forkBaseMainnet() {
  const rpc = process.env.BASE_MAINNET_RPC_ENDPOINT;
  if (!rpc) throw new Error("BASE_MAINNET_RPC_ENDPOINT is required to fork Base mainnet");
  const forking = { jsonRpcUrl: rpc };
  if (process.env.FORK_BLOCK_NUMBER) forking.blockNumber = Number(process.env.FORK_BLOCK_NUMBER);
  await hre.network.provider.request({ method: "hardhat_reset", params: [{ forking }] });
  // EDR has no hardfork-activation history for chain 8453, so an eth_call at the fork
  // block itself ("historical block") fails. Mining one empty local block makes `latest`
  // a local block, which runs under the configured local hardfork. No config change needed.
  await hre.network.provider.send("evm_mine");
}

async function main() {
  const name = hre.network.name;
  if (!["hardhat", "localhost", "baseFork"].includes(name)) {
    throw new Error(`This rehearsal only runs on a local fork (hardhat / localhost / baseFork). Refusing on "${name}".`);
  }
  if (name === "hardhat") {
    console.log("  Forking Base mainnet in-process (hardhat_reset)…");
    await forkBaseMainnet();
  }

  const diamond = process.env.DIAMOND_ADDRESS && process.env.DIAMOND_ADDRESS.toLowerCase() !== BASE_MAINNET_DIAMOND.toLowerCase()
    ? (console.log(`  ⚠ ignoring DIAMOND_ADDRESS=${process.env.DIAMOND_ADDRESS} — the rehearsal always targets the mainnet Diamond`), BASE_MAINNET_DIAMOND)
    : BASE_MAINNET_DIAMOND;
  if ((await ethers.provider.getCode(diamond)) === "0x") {
    throw new Error(`No bytecode at ${diamond} — the node is not forking Base mainnet`);
  }
  const net = await ethers.provider.getNetwork();
  const oracle = await ethers.getContractAt("IDoefinBlockHeaderOracle", diamond);
  const [sender] = await ethers.getSigners();
  const failures = [];

  console.log("==========================================================");
  console.log("  SCRUM-521 — mainnet-fork rehearsal");
  console.log("==========================================================");
  console.log(`  Network: ${name} (chainId ${net.chainId})  Fork block: ${await ethers.provider.getBlockNumber()}  Diamond: ${diamond}`);

  const live = await readOracleState(oracle);
  printState("Live state", live);
  const stuck = live.height === ORPHAN_HEIGHT && live.nextBlockIndex === 0 && sameHash(live.tipHash, ORPHAN.blockHash);
  check(stuck, `fork shows the incident state (height ${ORPHAN_HEIGHT}, nextBlockIndex 0, tip = orphan ${ORPHAN.blockHash})`, failures);
  if (!stuck) {
    console.log("  The live oracle is not in the incident state any more — the replay part of this rehearsal does not apply.");
  }

  // Proof the defect is live: the held batch panics on the current facet.
  if (stuck) {
    let panicked = false;
    try {
      await oracle.estimateGas.submitBatchBlocks([CANONICAL_143, byHeight[967144], byHeight[967145], byHeight[967146]]);
    } catch (err) {
      panicked = /panic code 0x11|0x4e487b71/i.test(String(err.message || err));
    }
    check(panicked, "held batch reverts Panic(0x11) on the CURRENT mainnet facet (defect reproduced on the fork)", failures);
  }

  console.log("\n>>> Applying the cut (owner impersonated)\n");
  const cut = await runUpgrade({ diamond, impersonateOwner: true, skipVerify: true, record: false });
  check(cut.newFacet && cut.cutTxHash, `cut applied: submitBatchBlocks → ${cut.newFacet}`, failures);

  if (stuck) {
    console.log("\n>>> Replaying the held batch\n");
    const replay = await replayHeldBatch({ diamond, signer: sender, through: HELD_BATCH_TIP });
    check(replay.after.height === HELD_BATCH_TIP, `height ${replay.after.height} == ${HELD_BATCH_TIP}`, failures);
    check(replay.after.nextBlockIndex === 3, `nextBlockIndex ${replay.after.nextBlockIndex} == 3`, failures);
    check(replay.reorged === 1, "BlockReorged emitted exactly once", failures);
    const h143 = (await oracle.getBlockHeaderByNumber(ORPHAN_HEIGHT)).blockHash;
    check(sameHash(h143, CANONICAL_143.blockHash), `getBlockHeaderByNumber(967143) == canonical ${CANONICAL_143.blockHash}`, failures);

    console.log("\n>>> Linear catch-up 967147..967160 via submitNextBlock\n");
    let idx = replay.after.nextBlockIndex;
    let wrapped = false;
    for (let h = HELD_BATCH_TIP + 1; h <= FIXTURE_LAST; h++) {
      await (await oracle.connect(sender).submitNextBlock(byHeight[h])).wait();
      idx = (idx + 1) % RING;
      if (idx === 0) wrapped = true;
      const s = await readOracleState(oracle);
      if (s.height !== h || s.nextBlockIndex !== idx) {
        failures.push(`after ${h}: height ${s.height} / nextBlockIndex ${s.nextBlockIndex}, expected ${h} / ${idx}`);
      }
    }
    const final = await readOracleState(oracle);
    printState("Final state", final);
    check(final.height === FIXTURE_LAST, `height ${final.height} == ${FIXTURE_LAST}`, failures);
    check(wrapped && final.nextBlockIndex === (3 + (FIXTURE_LAST - HELD_BATCH_TIP)) % RING, `pointer wrapped 16 → 0 and ended at ${final.nextBlockIndex}`, failures);
  }

  console.log("\n==========================================================");
  if (failures.length) {
    console.log(`  ❌ REHEARSAL FAILED — ${failures.length} check(s):`);
    failures.forEach((f) => console.log(`     - ${f}`));
    console.log("==========================================================\n");
    process.exit(1);
  }
  console.log("  ✅ REHEARSAL PASSED — the cut + replay recover the mainnet oracle on the fork");
  console.log("==========================================================\n");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\n❌ rehearsal errored:", e);
    process.exit(1);
  });
