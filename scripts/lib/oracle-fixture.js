/**
 * SCRUM-521 — loader for the reorg-index-underflow fixture
 * (`test/data/reorg_index_underflow/`, see its README for the incident write-up).
 *
 * Shared by the regression suite (`test/integration/OracleReorgIndexUnderflow.test.js`),
 * the one-off replay script (`scripts/oracle-replay-batch.js`) and the mainnet-fork
 * rehearsal (`scripts/upgrades/rehearse-scrum521-fork.js`), so all three submit
 * byte-identical headers.
 *
 * Every header is exposed in the contract's `LibDoefinStorage.BlockHeader` field shape.
 * `blockNumber` matters: `submitBatchBlocks` → `_findForkPoint` validates the FIRST
 * header's `blockNumber` against the height of the parent it finds in the ring buffer.
 */

const path = require("path");

const FIXTURE_DIR = path.join(__dirname, "..", "..", "test", "data", "reorg_index_underflow");

const mainchainFixture = require(path.join(FIXTURE_DIR, "blocks-mainchain-967110-967160.json"));
const orphanFixture = require(path.join(FIXTURE_DIR, "block-967143-orphan.json"));
const matrix = require(path.join(FIXTURE_DIR, "scenarios.json"));

function toHeader(b) {
  return {
    prevBlockHash: b.prevBlockHash,
    merkleRootHash: b.merkleRootHash,
    blockHash: b.blockHash,
    blockNumber: b.blockNumber,
    version: b.version,
    timestamp: b.timestamp,
    nBits: b.nBits,
    nonce: b.nonce,
  };
}

const byHeight = Object.fromEntries(mainchainFixture.blocks.map((b) => [b.blockNumber, toHeader(b)]));
const heightsAvailable = mainchainFixture.blocks.map((b) => b.blockNumber);

const RING = matrix.ringBufferSize; // 17
const ORPHAN_HEIGHT = matrix.orphanHeight; // 967143
const FIXTURE_FIRST = Math.min(...heightsAvailable); // 967110
const FIXTURE_LAST = Math.max(...heightsAvailable); // 967160

const ORPHAN = toHeader(orphanFixture.blocks[0]);
const CANONICAL_143 = byHeight[ORPHAN_HEIGHT];

// The exact batch block-indexer has been holding since 2026-09-15 15:45 UTC.
const HELD_BATCH_HEIGHTS = matrix.scenarios[0].replayBatch.blocks; // [967143, 967144, 967145, 967146]
const HELD_BATCH_TIP = HELD_BATCH_HEIGHTS[HELD_BATCH_HEIGHTS.length - 1]; // 967146

/** Canonical headers `from..to` (inclusive), in height order. Throws on a gap. */
function headers(from, to) {
  const out = [];
  for (let h = from; h <= to; h++) {
    if (!byHeight[h]) throw new Error(`fixture has no canonical header for height ${h}`);
    out.push(byHeight[h]);
  }
  return out;
}

function sameHash(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

module.exports = {
  FIXTURE_DIR,
  RING,
  ORPHAN_HEIGHT,
  FIXTURE_FIRST,
  FIXTURE_LAST,
  ORPHAN,
  CANONICAL_143,
  HELD_BATCH_HEIGHTS,
  HELD_BATCH_TIP,
  matrix,
  byHeight,
  headers,
  toHeader,
  sameHash,
};
