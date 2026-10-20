/**
 * SCRUM-521-AUDIT-SCOPE — the real-Bitcoin "worlds" driven by the oracle fuzz harness
 * (`contracts/audit/OracleInvariantHarness.sol`).
 *
 * A world is a canonical header chain plus ONE real orphan that is a sibling of one of
 * its blocks. The harness only ever submits these headers (random headers can never pass
 * PoW), and lets the fuzzer choose the shape of each submission.
 *
 * Single source of truth for:
 *   - `security/scripts/gen-oracle-fixtures.js`, which encodes the worlds into
 *     `contracts/audit/OracleHeaderFixtures.sol`;
 *   - `test/audit/OracleInvariantHarness.test.js`, which checks the generated contract
 *     against the JSON and re-verifies every header (double-SHA256, links, PoW, MTP).
 *
 * World 0 — Base-mainnet SEC-015 incident (test/data/reorg_index_underflow/):
 *   canonical 967110..967160, orphan 967143 (`…8e0c9e34…314c`), stored by the mainnet
 *   oracle on 2026-09-15 and orphaned 19 s later.
 * World 1 — the earlier reorg fixture (test/data/reorg_test/):
 *   canonical 935468..935496 from `blocks-initiation-till-reorged-block.json` followed by
 *   935497..935503 from `blocks-reorg-test.json`; orphan = the 935497 in
 *   `blocks-initiation-till-reorged-block.json` (`…19b9d899…798a`), which the six real
 *   blocks 935498..935503 do not build on.
 */

const path = require("path");

const DATA = path.join(__dirname, "..", "data");

/** Contract `LibDoefinStorage.BlockHeader` shape. */
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

function world(name, canonicalRaw, orphanRaw, sources) {
  const canonical = canonicalRaw.map(toHeader);
  const orphan = toHeader(orphanRaw);
  const firstHeight = canonical[0].blockNumber;
  return {
    name,
    sources,
    firstHeight,
    canonical,
    orphan,
    orphanIndex: orphan.blockNumber - firstHeight,
  };
}

function loadWorlds() {
  const main967 = require(path.join(DATA, "reorg_index_underflow", "blocks-mainchain-967110-967160.json")).blocks;
  const orphan967 = require(path.join(DATA, "reorg_index_underflow", "block-967143-orphan.json")).blocks[0];

  const init935 = require(path.join(DATA, "reorg_test", "blocks-initiation-till-reorged-block.json")).blocks;
  const alt935 = require(path.join(DATA, "reorg_test", "blocks-reorg-test.json")).blocks;
  const fork935 = alt935[0].blockNumber; // 935496, the common ancestor (identical in both files)
  const canonical935 = [...init935.filter((b) => b.blockNumber <= fork935), ...alt935.filter((b) => b.blockNumber > fork935)];
  const orphan935 = init935.find((b) => b.blockNumber === fork935 + 1);

  return [
    world("mainnet-967143 (SEC-015 incident)", main967, orphan967, [
      "test/data/reorg_index_underflow/blocks-mainchain-967110-967160.json",
      "test/data/reorg_index_underflow/block-967143-orphan.json",
    ]),
    world("reorg-935497", canonical935, orphan935, [
      "test/data/reorg_test/blocks-initiation-till-reorged-block.json",
      "test/data/reorg_test/blocks-reorg-test.json",
    ]),
  ];
}

module.exports = { RING: 17, toHeader, loadWorlds };
