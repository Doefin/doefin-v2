// One-off: seed the block header oracle on the new Safe-owned Diamond.
// Uses /Users/reza/workspace/predexyo/doefin-v2/scripts/may-25-2026-blockdata/blocks.json
// First 17 blocks → initializeBlockHeaderOracle; remaining → submitNextBlock loop.
// initializeBlockHeaderOracle and submitNextBlock are both permissionless,
// so the deployer EOA can call them directly (no Safe ceremony needed).

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const DIAMOND = "0x2f03d47520fb8bc8aDAab392BF280D99De7cAe3f";
const BLOCKS_JSON = "/Users/reza/workspace/predexyo/doefin-v2/scripts/may-25-2026-blockdata/blocks.json";
const NUM_OF_BLOCK_HEADERS = 17;

// Map convert-blocks.js output to the on-chain BlockHeader struct field order:
//   { bytes32 prevBlockHash, bytes32 merkleRootHash, bytes32 blockHash,
//     uint256 blockNumber, uint32 version, uint32 timestamp, uint32 nBits, uint32 nonce }
// blockHash and blockNumber are overwritten by the contract; pass zeros.
function toStruct(b) {
  return {
    prevBlockHash: b.prevBlockHash,
    merkleRootHash: b.merkleRootHash,
    blockHash: "0x" + "0".repeat(64),
    blockNumber: 0,
    version: b.version,
    timestamp: b.timestamp,
    nBits: b.nBits,
    nonce: b.nonce,
  };
}

async function main() {
  const data = JSON.parse(fs.readFileSync(BLOCKS_JSON, "utf8"));
  const blocks = data.blocks; // already sorted ascending
  console.log(`Loaded ${blocks.length} blocks (${blocks[0].blockNumber} → ${blocks[blocks.length - 1].blockNumber})`);

  if (blocks.length < NUM_OF_BLOCK_HEADERS) {
    throw new Error(`Need at least ${NUM_OF_BLOCK_HEADERS} blocks for init; got ${blocks.length}`);
  }

  const [deployer] = await hre.ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Diamond:  ${DIAMOND}\n`);

  const oracle = await hre.ethers.getContractAt("DoefinV1BlockHeaderOracle", DIAMOND);

  // 1. Check current state — short-circuit if already initialized
  const latest = await oracle.getLatestBlockHeader();
  if (latest.timestamp !== 0) {
    console.log(`Oracle already seeded (latest timestamp=${latest.timestamp}, blockNumber=${latest.blockNumber}). Skipping init.`);
  } else {
    const initialHistory = blocks.slice(0, NUM_OF_BLOCK_HEADERS).map(toStruct);
    const initialHeight = blocks[0].blockNumber;
    console.log(`--- Phase 1: initializeBlockHeaderOracle(17 blocks, height=${initialHeight}) ---`);
    const tx = await oracle.initializeBlockHeaderOracle(initialHistory, initialHeight);
    console.log(`  tx: ${tx.hash}`);
    const rcpt = await tx.wait();
    console.log(`  ✔ confirmed in block ${rcpt.blockNumber} (gas ${rcpt.gasUsed.toString()})\n`);
  }

  // 2. Sequential submitNextBlock for the remaining blocks.
  // Resume-safe: skip any block whose number is <= the on-chain currentBlockHeight.
  const currentHeight = Number((await oracle.getCurrentBlockHeight()).toString());
  const startBlockNumber = currentHeight + 1;
  const resumeFrom = blocks.findIndex((b) => b.blockNumber === startBlockNumber);
  if (resumeFrom === -1) {
    console.log(`All blocks in dataset already on chain (currentHeight=${currentHeight}, dataset top=${blocks[blocks.length - 1].blockNumber}). Nothing more to submit.`);
  } else {
    const remaining = blocks.length - resumeFrom;
    console.log(`--- Phase 2: submitNextBlock for ${remaining} extension blocks (resuming from ${startBlockNumber}) ---`);
    for (let i = resumeFrom; i < blocks.length; i++) {
      const b = blocks[i];
      process.stdout.write(`  [${i - resumeFrom + 1}/${remaining}] block ${b.blockNumber} ... `);
      const tx = await oracle.submitNextBlock(toStruct(b));
      const rcpt = await tx.wait();
      console.log(`ok (tx ${tx.hash.slice(0, 10)}…, gas ${rcpt.gasUsed.toString()})`);
    }
  }

  // 3. Verify final state
  console.log(`\n--- Verification ---`);
  const finalLatest = await oracle.getLatestBlockHeader();
  console.log(`  latest blockNumber: ${finalLatest.blockNumber.toString()}`);
  console.log(`  latest blockHash:   ${finalLatest.blockHash}`);
  console.log(`  latest timestamp:   ${finalLatest.timestamp}`);
  console.log(`  expected blockNum:  ${blocks[blocks.length - 1].blockNumber}`);
  console.log(`  expected blockHash: ${blocks[blocks.length - 1].blockHash}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("❌", e);
    process.exit(1);
  });
