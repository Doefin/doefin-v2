/**
 * SCRUM-521 — `submitBatchBlocks` reorg replay must work from every ring-buffer slot.
 *
 * Production incident (Base mainnet Diamond 0x71C424Ef79819c852952e517c082C4d17f89Fdf9,
 * 2026-09-15 15:36 UTC): block-indexer stored a Bitcoin block 967143 that the network
 * orphaned 19 s later. That block landed in ring slot 16 and wrapped `nextBlockIndex`
 * to 0. The depth-1 replay `[967143 canonical, 967144, 967145, 967146]` then reverted
 * with Panic(0x11), because the rewind arithmetic in `submitBatchBlocks`
 *
 *     (nextBlockIndex + forkHeight - currentBlockHeight - 1) % 17   // prev-header slot
 *     (nextBlockIndex + forkHeight - currentBlockHeight)     % 17   // pointer rewind
 *
 * is evaluated left-to-right in checked uint256 math and underflows whenever
 * `nextBlockIndex <= depth`. Nothing else can move the pointer, so the oracle froze.
 *
 * Fix: add `NUM_OF_BLOCK_HEADERS` before subtracting, as `_findForkPoint` and
 * `LibDoefinBlockHeaderOracle.getBlockHeaderByNumber` already do.
 *
 * This suite drives the real headers 967110-967160 (`test/data/reorg_index_underflow/`)
 * so that the orphan sits in each of the 17 ring slots, then replays:
 *   - the exact production batch (depth 1) from every slot               17 cases
 *   - deeper replacement chains (depth 2, 3, 6) from every slot           51 cases
 *   - the negative cases: NewChainNotLonger / CannotFindForkPoint / PrevBlockHashMismatch
 *   - recovery from the production state followed by linear catch-up across the wrap
 *
 * Pre-fix facet: the depth-d replay panics in every slot where nextBlockIndex <= d —
 * 16 of the 68 replay cases here (at depth 1: slots 16 and 0, i.e. nextBlockIndex 0
 * and 1). `ComprehensiveReorgTest` only ever replays at nextBlockIndex 13, which is
 * why the defect escaped.
 *
 * Depths above 6 are deliberately not replayed with real headers: after rewinding by
 * d the buffer holds only 17 - d verified predecessors, so for d >= 7 the 11-block
 * median-time window (`medianBlockTime`) wraps into stale post-fork slots. That is a
 * separate, pre-existing limitation of the 17-slot buffer (tracked in
 * audit/follow-ups.md), not the SCRUM-521 arithmetic defect, which the fix removes
 * for every depth the buffer can express (< 17).
 */

const { deployDiamond } = require("../../scripts/deploy.js");
const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const {
  RING,
  ORPHAN_HEIGHT,
  FIXTURE_FIRST,
  FIXTURE_LAST,
  ORPHAN,
  CANONICAL_143,
  HELD_BATCH_TIP,
  matrix,
  byHeight,
  headers,
  sameHash,
} = require("../../scripts/lib/oracle-fixture.js");

const BLOCK_REORGED_TOPIC = ethers.utils.id("BlockReorged(bytes32)");
const BLOCK_SUBMITTED_TOPIC = ethers.utils.id("BlockSubmitted(bytes32,uint32)");

// Depth-1 is the production batch; 2, 3 and 6 anchor the replacement chain deeper.
// 6 is the deepest replay whose median-time window is still made entirely of
// verified predecessors (17 - 6 = 11), see the header comment.
const EXTRA_DEPTHS = [2, 3, 6];

const snapshot = () => network.provider.send("evm_snapshot");
const revertTo = (id) => network.provider.send("evm_revert", [id]);
const countLogs = (receipt, topic) => receipt.logs.filter((l) => l.topics[0] === topic).length;
const expectHash = (actual, expected) => expect(String(actual).toLowerCase()).to.equal(String(expected).toLowerCase());

describe("SCRUM-521 — submitBatchBlocks reorg replay at every ring-buffer slot", function () {
  this.timeout(300_000);

  let oracle;
  let deploySnapshot;

  before(async function () {
    const diamondAddress = await deployDiamond();
    oracle = await ethers.getContractAt("IDoefinBlockHeaderOracle", diamondAddress);
    expect(await oracle.getBufferSize()).to.equal(RING);
    deploySnapshot = await snapshot();
  });

  /** Fresh Diamond state (oracle uninitialised). */
  async function resetToDeploy() {
    await revertTo(deploySnapshot);
    deploySnapshot = await snapshot();
  }

  /**
   * Drive the oracle into "orphan 967143 in slot s": init with the scenario's 17
   * canonical headers, extend the canonical chain `s` blocks with submitNextBlock,
   * then submit the orphan. Asserts the exact pre-state the scenario documents.
   */
  async function driveToOrphanState(sc) {
    await oracle.initializeBlockHeaderOracle(headers(sc.init.from, sc.init.to), sc.init.initialBlockHeight);
    expect(await oracle.getCurrentBlockHeight()).to.equal(sc.init.to);
    expect(await oracle.getNextBlockIndex()).to.equal(0);

    if (sc.extendMainChain.count > 0) {
      for (const header of headers(sc.extendMainChain.from, sc.extendMainChain.to)) {
        await oracle.submitNextBlock(header);
      }
    }
    await oracle.submitNextBlock(ORPHAN);

    expect(await oracle.getCurrentBlockHeight()).to.equal(sc.stateWithOrphan.currentBlockHeight);
    expect(await oracle.getNextBlockIndex()).to.equal(sc.stateWithOrphan.nextBlockIndex);
    expectHash((await oracle.getBlockHeaderAt(sc.orphanSlot)).blockHash, ORPHAN.blockHash);
    expectHash((await oracle.getLatestBlockHeader()).blockHash, ORPHAN.blockHash);
  }

  /** Post-replay assertions shared by every depth: the scenario's `expectedAfterFix`. */
  async function assertReplayed(sc, receipt, batch) {
    expect(countLogs(receipt, BLOCK_REORGED_TOPIC), "BlockReorged emitted once").to.equal(1);
    expect(countLogs(receipt, BLOCK_SUBMITTED_TOPIC), "BlockSubmitted per header").to.equal(batch.length);

    const after = sc.expectedAfterFix;
    expect(await oracle.getCurrentBlockHeight()).to.equal(after.currentBlockHeight);
    expect(await oracle.getNextBlockIndex()).to.equal(after.nextBlockIndex);

    const replaced = await oracle.getBlockHeaderByNumber(ORPHAN_HEIGHT);
    expectHash(replaced.blockHash, after.blockHeaderByNumber_967143);
    expectHash(replaced.blockHash, CANONICAL_143.blockHash);
    expectHash((await oracle.getBlockHeaderAt(after.slotNowHolding967143)).blockHash, CANONICAL_143.blockHash);

    const latest = await oracle.getLatestBlockHeader();
    expect(latest.blockNumber).to.equal(HELD_BATCH_TIP);
    expectHash(latest.blockHash, byHeight[HELD_BATCH_TIP].blockHash);

    // The orphan is gone from the buffer entirely.
    for (const header of await oracle.getAllBlockHeaders()) {
      expect(sameHash(header.blockHash, ORPHAN.blockHash)).to.equal(false);
    }

    // The whole 17-slot window (967130..967146) is the canonical chain and links.
    const oldest = HELD_BATCH_TIP - RING + 1;
    for (let h = oldest; h <= HELD_BATCH_TIP; h++) {
      const header = await oracle.getBlockHeaderByNumber(h);
      expect(header.blockNumber).to.equal(h);
      expectHash(header.blockHash, byHeight[h].blockHash);
      if (h > oldest) {
        expectHash(header.prevBlockHash, (await oracle.getBlockHeaderByNumber(h - 1)).blockHash);
      }
    }
  }

  describe("fixture sanity", function () {
    it("is a contiguous, linked canonical chain 967110..967160 with the orphan as a sibling of 967143", function () {
      expect(FIXTURE_FIRST).to.equal(967110);
      expect(FIXTURE_LAST).to.equal(967160);
      for (let h = FIXTURE_FIRST + 1; h <= FIXTURE_LAST; h++) {
        expectHash(byHeight[h].prevBlockHash, byHeight[h - 1].blockHash);
      }
      expectHash(ORPHAN.prevBlockHash, CANONICAL_143.prevBlockHash);
      expect(sameHash(ORPHAN.blockHash, CANONICAL_143.blockHash)).to.equal(false);
      expect(matrix.scenarios.map((s) => s.orphanSlot)).to.deep.equal([...Array(RING).keys()]);
      expect(matrix.scenarios.filter((s) => s.matchesProductionIncident).map((s) => s.orphanSlot)).to.deep.equal([16]);
    });
  });

  for (const sc of matrix.scenarios) {
    const slot = sc.orphanSlot;
    const indexAtReplay = sc.stateWithOrphan.nextBlockIndex;
    const label = sc.matchesProductionIncident ? " — production incident state" : "";

    describe(`orphan in slot ${slot} (nextBlockIndex ${indexAtReplay} at replay)${label}`, function () {
      let slotSnapshot;

      before(async function () {
        await resetToDeploy();
        await driveToOrphanState(sc);
        slotSnapshot = await snapshot();
      });

      beforeEach(async function () {
        await revertTo(slotSnapshot);
        slotSnapshot = await snapshot();
      });

      it(`depth-1 replay of the held production batch [${sc.replayBatch.blocks.join(", ")}] succeeds`, async function () {
        expect(sc.replayBatch.depth).to.equal(1);
        const batch = sc.replayBatch.blocks.map((h) => byHeight[h]);
        const receipt = await (await oracle.submitBatchBlocks(batch)).wait();
        await assertReplayed(sc, receipt, batch);
      });

      for (const depth of EXTRA_DEPTHS) {
        const from = ORPHAN_HEIGHT + 1 - depth;
        it(`depth-${depth} replay (replacement chain ${from}..${HELD_BATCH_TIP}) succeeds`, async function () {
          const batch = headers(from, HELD_BATCH_TIP);
          const receipt = await (await oracle.submitBatchBlocks(batch)).wait();
          await assertReplayed(sc, receipt, batch);
        });
      }
    });
  }

  describe("negative cases still revert as before (production state: orphan in slot 16, nextBlockIndex 0)", function () {
    const sc = matrix.scenarios.find((s) => s.matchesProductionIncident);
    let stateSnapshot;

    before(async function () {
      await resetToDeploy();
      await driveToOrphanState(sc);
      stateSnapshot = await snapshot();
    });

    beforeEach(async function () {
      await revertTo(stateSnapshot);
      stateSnapshot = await snapshot();
    });

    afterEach(async function () {
      // A rejected batch must leave the oracle exactly where it was.
      expect(await oracle.getCurrentBlockHeight()).to.equal(ORPHAN_HEIGHT);
      expect(await oracle.getNextBlockIndex()).to.equal(0);
      expectHash((await oracle.getLatestBlockHeader()).blockHash, ORPHAN.blockHash);
    });

    it("an equal-length replacement [967143 canonical] reverts NewChainNotLonger", async function () {
      await expect(oracle.submitBatchBlocks([CANONICAL_143])).to.be.revertedWith("BlockHeaderOracle_NewChainNotLonger");
    });

    it("a fork deeper than the buffer (anchored at 967127; parent 967126 already evicted) reverts CannotFindForkPoint", async function () {
      const tooDeep = headers(ORPHAN_HEIGHT - RING + 1, HELD_BATCH_TIP); // 967127..967146, depth 17
      await expect(oracle.submitBatchBlocks(tooDeep)).to.be.revertedWith("BlockHeaderOracle_CannotFindForkPoint");
    });

    it("a first header whose blockNumber disagrees with its parent's height reverts CannotFindForkPoint", async function () {
      const misnumbered = { ...CANONICAL_143, blockNumber: ORPHAN_HEIGHT + 1 };
      const batch = [misnumbered, ...headers(ORPHAN_HEIGHT + 1, HELD_BATCH_TIP)];
      await expect(oracle.submitBatchBlocks(batch)).to.be.revertedWith("BlockHeaderOracle_CannotFindForkPoint");
    });

    it("a batch that breaks linkage after the fork point reverts PrevBlockHashMismatch (rewind itself no longer panics)", async function () {
      // 967145 does not link to 967143: the rewind succeeds, _applyChain rejects the second header.
      const broken = [CANONICAL_143, byHeight[ORPHAN_HEIGHT + 2], byHeight[ORPHAN_HEIGHT + 3]];
      await expect(oracle.submitBatchBlocks(broken)).to.be.revertedWith("BlockHeaderOracle_PrevBlockHashMismatch");
    });
  });

  describe("recovery from the production state and catch-up across the wrap", function () {
    const sc = matrix.scenarios.find((s) => s.matchesProductionIncident);
    let stateSnapshot;

    before(async function () {
      await resetToDeploy();
      await driveToOrphanState(sc);
      stateSnapshot = await snapshot();
    });

    beforeEach(async function () {
      await revertTo(stateSnapshot);
      stateSnapshot = await snapshot();
    });

    it("replays the held batch, then submitNextBlock 967147..967160 walks the pointer 3 -> 16 -> 0 cleanly", async function () {
      const batch = sc.replayBatch.blocks.map((h) => byHeight[h]);
      const receipt = await (await oracle.submitBatchBlocks(batch)).wait();
      await assertReplayed(sc, receipt, batch);

      let expectedIndex = sc.expectedAfterFix.nextBlockIndex; // 3
      let wrapped = false;
      for (let h = HELD_BATCH_TIP + 1; h <= FIXTURE_LAST; h++) {
        await oracle.submitNextBlock(byHeight[h]);
        expectedIndex = (expectedIndex + 1) % RING;
        if (expectedIndex === 0) wrapped = true;
        expect(await oracle.getCurrentBlockHeight()).to.equal(h);
        expect(await oracle.getNextBlockIndex()).to.equal(expectedIndex);
      }
      expect(wrapped, "the pointer wrapped 16 -> 0 during catch-up").to.equal(true);
      expect(await oracle.getNextBlockIndex()).to.equal((3 + (FIXTURE_LAST - HELD_BATCH_TIP)) % RING); // 0

      for (let h = FIXTURE_LAST - RING + 1; h <= FIXTURE_LAST; h++) {
        expectHash((await oracle.getBlockHeaderByNumber(h)).blockHash, byHeight[h].blockHash);
      }
    });

    it("after the replay, a depth-0 batch [967147, 967148] still takes the plain-extension path", async function () {
      const batch = sc.replayBatch.blocks.map((h) => byHeight[h]);
      await (await oracle.submitBatchBlocks(batch)).wait();

      const extension = headers(HELD_BATCH_TIP + 1, HELD_BATCH_TIP + 2);
      const receipt = await (await oracle.submitBatchBlocks(extension)).wait();
      expect(countLogs(receipt, BLOCK_REORGED_TOPIC), "no BlockReorged on a plain extension").to.equal(0);
      expect(countLogs(receipt, BLOCK_SUBMITTED_TOPIC)).to.equal(extension.length);
      expect(await oracle.getCurrentBlockHeight()).to.equal(HELD_BATCH_TIP + 2);
      expect(await oracle.getNextBlockIndex()).to.equal((sc.expectedAfterFix.nextBlockIndex + extension.length) % RING);
      expectHash((await oracle.getLatestBlockHeader()).blockHash, byHeight[HELD_BATCH_TIP + 2].blockHash);
    });
  });
});
