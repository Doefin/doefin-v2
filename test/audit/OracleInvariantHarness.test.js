/**
 * SCRUM-521-AUDIT-SCOPE — validation of the block-header oracle fuzz harness
 * (`contracts/audit/OracleInvariantHarness.sol`) without the Docker fuzz toolchain.
 *
 * Echidna / Medusa drive the harness's `fuzz_*` actions in random order and check its
 * `echidna_*` properties after every call. This suite does the same deterministically:
 *
 *   1. Fixtures — the generated `OracleHeaderFixtures` contract holds exactly the JSON
 *      headers of the two real forks in the repo, and every header is independently
 *      re-verified here (double-SHA256, linkage, PoW against the parent's target,
 *      median-time-past; each orphan is a valid sibling with no child).
 *   2. Deterministic sequences on the PRODUCTION facet — linear extension across the ring
 *      wrap, the orphan in ring slot 16 (production incident) and slot 0 followed by the
 *      reorg replay, all 17 slots against `scenarios.json`'s "After fix" column, a
 *      pointer x depth replay matrix, overlapping / stale / gapped / too-deep batches,
 *      caller-supplied metadata, tampered consensus fields, re-initialisation, and the
 *      empty batch. Every property must hold after every step, including the empty-batch
 *      property (ORC-011: the production facet reverts BlockHeaderOracle_EmptyBatch).
 *   3. Negative control — the same sequences against `OracleInvariantHarnessPreFix`
 *      (verbatim pre-SCRUM-521 facet): the harness must flag SEC-015 exactly where
 *      `scenarios.json`'s "Before fix" column says it panics, and exactly where the
 *      general rule `nextBlockIndex <= depth` says it panics.
 *   4. Seeded random walks over every action — the production harness never fails a
 *      property; the pre-fix harness is caught.
 *
 * Every harness transaction is sent with an explicit gas limit: the harness catches
 * reverts of the oracle call, so `eth_estimateGas` could otherwise settle on a limit at
 * which the inner call runs out of gas while the outer transaction still succeeds.
 */

const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const crypto = require("crypto");
const fs = require("fs");

const { RING, loadWorlds } = require("../utils/oracleHarnessWorlds.js");
const { render, OUT: FIXTURE_SOL } = require("../../security/scripts/gen-oracle-fixtures.js");
const matrix = require("../data/reorg_index_underflow/scenarios.json");

const WORLDS = loadWorlds();
const W967 = 0;
const W935 = 1;
const GAS = { gasLimit: 16_000_000 }; // under EDR's EIP-7825 per-transaction cap (2^24)
const PANIC_ARITHMETIC = 0x11;
const MTP_SAFE_DEPTH = 6;

// Action ids recorded by the harness with each violation (OracleInvariantHarnessBase A_*).
const A = { RESET: 1, NEXT: 2, ANY: 3, ORPHAN: 4, BATCH: 5, REORG: 6, ORPHAN_BATCH: 7, SKEWED: 8, TAMPERED: 9, EMPTY: 10, REINIT: 11 };

// Must match OracleInvariantHarnessBase.propertySelectors() (checked below).
const PROPS = [
  "echidna_next_index_in_range",
  "echidna_pointer_tracks_height",
  "echidna_buffer_is_linked_chain",
  "echidna_tip_is_fixture_header",
  "echidna_window_matches_model",
  "echidna_height_never_decreases",
  "echidna_orphan_never_returns",
  "echidna_views_never_panic",
  "echidna_no_panic_nonempty",
  "echidna_empty_batch_no_panic",
  "echidna_only_declared_errors",
  "echidna_valid_chains_accepted",
  "echidna_invalid_chains_rejected",
  "echidna_accepted_postconditions",
  "echidna_init_is_one_shot",
];
const bit = (name) => {
  const i = PROPS.indexOf(name);
  if (i < 0) throw new Error(`unknown property ${name}`);
  return 1 << i;
};
const EMPTY_BATCH_BIT = bit("echidna_empty_batch_no_panic");
const SEC015_BITS = bit("echidna_no_panic_nonempty") | bit("echidna_valid_chains_accepted");
const namesOf = (mask) => PROPS.filter((_, i) => mask & (1 << i));

const lc = (x) => String(x).toLowerCase();

/**
 * The call reverts with exactly `name(args)`. Waffle 3.4 has no `revertedWithCustomError`, and a bare
 * `to.be.reverted` also passes on a Panic — the failure class this harness exists to catch.
 */
async function expectCustomError(promise, iface, name, args) {
  let data = null;
  try {
    await promise;
  } catch (err) {
    data = String(err.data || (err.error && err.error.data) || "");
  }
  expect(data, `expected a revert with ${name}`).to.not.equal(null);
  expect(lc(data), `revert data of ${name}`).to.equal(lc(iface.encodeErrorResult(name, args)));
}

// ---------------------------------------------------------------------------
// Snapshot-based fixtures (hardhat-network-helpers is not a dependency here).
// ---------------------------------------------------------------------------
const fixtureStack = [];
async function loadFixture(fn) {
  const i = fixtureStack.findIndex((f) => f.fn === fn);
  if (i === -1) {
    const value = await fn();
    fixtureStack.push({ fn, value, id: await network.provider.send("evm_snapshot") });
    return value;
  }
  const f = fixtureStack[i];
  await network.provider.send("evm_revert", [f.id]);
  fixtureStack.splice(i + 1); // later snapshots died with the revert
  f.id = await network.provider.send("evm_snapshot");
  return f.value;
}

async function deployHarness(name) {
  const lib = await (await ethers.getContractFactory("BlockHeaderUtils")).deploy();
  await lib.deployed();
  const factory = await ethers.getContractFactory(name, { libraries: { BlockHeaderUtils: lib.address } });
  const harness = await factory.deploy(GAS);
  await harness.deployed();
  return harness;
}
const fixedHarness = () => deployHarness("OracleInvariantHarness");
const preFixHarness = () => deployHarness("OracleInvariantHarnessPreFix");

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------
async function send(txPromise) {
  const receipt = await (await txPromise).wait();
  expect(receipt.status, "fuzz actions must never revert (a reverted action hides its call from the fuzzer)").to.equal(1);
  return receipt;
}

const act = {
  reset: (h, w, offset, orphanTip = false) => send(h.fuzz_reset(w, offset, orphanTip, GAS)),
  next: (h, w) => send(h.fuzz_submitNext(w, GAS)),
  any: (h, w, idx, junk = 0) => send(h.fuzz_submitAny(w, idx, junk, GAS)),
  orphan: (h, w) => send(h.fuzz_submitOrphan(w, GAS)),
  batch: (h, w, start, len) => send(h.fuzz_submitBatch(w, start, len, GAS)),
  reorg: (h, w, depth, extra) => send(h.fuzz_reorgFromTip(w, depth, extra, GAS)),
  orphanBatch: (h, w, pre) => send(h.fuzz_submitOrphanBatch(w, pre, GAS)),
  skewed: (h, w, start, len, skew, junk) => send(h.fuzz_submitBatchSkewed(w, start, len, skew, junk, GAS)),
  tampered: (h, w, depth, pos, field, delta, viaNext) => send(h.fuzz_submitTampered(w, depth, pos, field, delta, viaNext, GAS)),
  empty: (h, w) => send(h.fuzz_submitEmptyBatch(w, GAS)),
  reinit: (h, w, offset) => send(h.fuzz_reinitialize(w, offset, GAS)),
};

async function mask(h) {
  return (await h.failedProperties()).toNumber();
}

/** All properties hold, except those in `allowed` (which must then be exactly failing). */
async function expectProperties(h, expectedMask = 0, context = "") {
  const m = await mask(h);
  expect(namesOf(m), `failing properties ${context}`).to.deep.equal(namesOf(expectedMask));
}

async function stats(h) {
  return h.getStats();
}

async function oracleOf(h, w) {
  const world = await h.getWorld(w);
  return ethers.getContractAt("IDoefinBlockHeaderOracle", world.oracle);
}

async function state(h, w) {
  const oracle = await oracleOf(h, w);
  return {
    oracle,
    height: (await oracle.getCurrentBlockHeight()).toNumber(),
    next: (await oracle.getNextBlockIndex()).toNumber(),
    tip: await oracle.getLatestBlockHeader(),
  };
}

/** Advance world `w` with submitNextBlock until its tip is canonical index `index`. */
async function nextUntil(h, w, index) {
  for (;;) {
    const world = await h.getWorld(w);
    if (world.tipIndex.toNumber() >= index) return;
    await act.next(h, w);
  }
}

/**
 * Put the orphan of world `w` into ring slot `slot` (the scenarios.json recipe):
 * initialise with canonical window k = orphanIndex - 17 - slot, extend to the orphan's
 * parent, submit the orphan. Leaves nextBlockIndex = (slot + 1) mod 17.
 */
async function driveOrphanIntoSlot(h, w, slot) {
  const wd = WORLDS[w];
  const k = wd.orphanIndex - RING - slot;
  expect(k, `world ${w} cannot place its orphan in slot ${slot}`).to.be.at.least(0);
  await act.reset(h, w, k);
  await nextUntil(h, w, wd.orphanIndex - 1);
  await act.orphan(h, w);
}

// ---------------------------------------------------------------------------
// Independent Bitcoin header verification (no contract code involved)
// ---------------------------------------------------------------------------
const sha256 = (b) => crypto.createHash("sha256").update(b).digest();
const le32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
const rev32 = (hex) => Buffer.from(hex.slice(2), "hex").reverse();
function bitcoinHash(h) {
  const raw = Buffer.concat([le32(h.version), rev32(h.prevBlockHash), rev32(h.merkleRootHash), le32(h.timestamp), le32(h.nBits), le32(h.nonce)]);
  expect(raw.length).to.equal(80);
  return "0x" + sha256(sha256(raw)).reverse().toString("hex");
}
function target(nBits) {
  const e = BigInt(nBits >>> 24);
  const c = BigInt(nBits & 0xffffff);
  return e <= 3n ? c >> (8n * (3n - e)) : c << (8n * (e - 3n));
}
const median11 = (ts) => [...ts].sort((a, b) => a - b)[5];

// ===========================================================================

describe("OracleInvariantHarness — block-header oracle fuzz harness (SCRUM-521-AUDIT-SCOPE)", function () {
  this.timeout(600_000);

  // -------------------------------------------------------------------------
  describe("fixtures", function () {
    it("every fixture header is a real Bitcoin header: hash, links, PoW vs parent target, median-time-past", function () {
      for (const wd of WORLDS) {
        const c = wd.canonical;
        c.forEach((h, i) => {
          expect(lc(bitcoinHash(h)), `${wd.name} hash ${h.blockNumber}`).to.equal(lc(h.blockHash));
          expect(h.blockNumber).to.equal(wd.firstHeight + i);
          if (i > 0) {
            expect(lc(h.prevBlockHash), `${wd.name} link ${h.blockNumber}`).to.equal(lc(c[i - 1].blockHash));
            expect(BigInt(h.blockHash) < target(c[i - 1].nBits), `${wd.name} PoW ${h.blockNumber}`).to.equal(true);
          }
          if (i >= 11) {
            expect(h.timestamp, `${wd.name} MTP ${h.blockNumber}`).to.be.at.least(median11(c.slice(i - 11, i).map((x) => x.timestamp)));
          }
        });
        const o = wd.orphan;
        const p = wd.orphanIndex;
        expect(lc(bitcoinHash(o)), `${wd.name} orphan hash`).to.equal(lc(o.blockHash));
        expect(lc(o.prevBlockHash), `${wd.name} orphan parent`).to.equal(lc(c[p - 1].blockHash));
        expect(lc(o.blockHash)).to.not.equal(lc(c[p].blockHash));
        expect(BigInt(o.blockHash) < target(c[p - 1].nBits), `${wd.name} orphan PoW`).to.equal(true);
        expect(o.timestamp).to.be.at.least(median11(c.slice(p - 11, p).map((x) => x.timestamp)));
        expect(c.filter((h) => lc(h.prevBlockHash) === lc(o.blockHash)), `${wd.name} orphan has no child`).to.have.length(0);
        // Every orphan slot must be reachable from a canonical init window, and the
        // orphan's child height must exist (the "orphan never returns" property needs it).
        expect(p).to.be.at.least(RING);
        expect(p + 1).to.be.below(c.length);
      }
      expect(WORLDS[W967].orphan.blockNumber).to.equal(matrix.orphanHeight);
    });

    it("the generated OracleHeaderFixtures.sol is up to date with the generator", function () {
      expect(fs.readFileSync(FIXTURE_SOL, "utf8") === render(WORLDS), "run: node security/scripts/gen-oracle-fixtures.js").to.equal(true);
    });

    it("the deployed fixture contract returns exactly the JSON headers of both worlds", async function () {
      const h = await loadFixture(fixedHarness);
      const fx = await ethers.getContractAt("OracleHeaderFixtures", await h.fixtures());
      expect(await fx.WORLD_COUNT()).to.equal(WORLDS.length);
      for (let w = 0; w < WORLDS.length; w++) {
        const wd = WORLDS[w];
        const [first, count, orphanIndex] = await fx.info(w);
        expect([first.toNumber(), count.toNumber(), orphanIndex.toNumber()]).to.deep.equal([wd.firstHeight, wd.canonical.length, wd.orphanIndex]);
        const all = [...wd.canonical, wd.orphan];
        const slice = await fx.slice(w, 0, wd.canonical.length);
        const hashes = await fx.hashes(w);
        expect(hashes).to.have.length(all.length);
        for (let i = 0; i < all.length; i++) {
          const want = all[i];
          const got = i < wd.canonical.length ? slice[i] : await fx.header(w, i);
          for (const f of ["prevBlockHash", "merkleRootHash", "blockHash"]) expect(lc(got[f]), `${wd.name}[${i}].${f}`).to.equal(lc(want[f]));
          for (const f of ["blockNumber", "version", "timestamp", "nBits", "nonce"]) expect(Number(got[f]), `${wd.name}[${i}].${f}`).to.equal(want[f]);
          expect(lc(hashes[i])).to.equal(lc(want.blockHash));
        }
        const branch = await fx.orphanBranch(w, wd.orphanIndex - 2);
        expect(branch.map((x) => lc(x.blockHash))).to.deep.equal(
          [wd.canonical[wd.orphanIndex - 2], wd.canonical[wd.orphanIndex - 1], wd.orphan].map((x) => lc(x.blockHash))
        );
        await expectCustomError(fx.header(w, wd.canonical.length + 1), fx.interface, "FixtureIndexOutOfRange", [w, wd.canonical.length + 1]);
      }
      await expectCustomError(fx.info(WORLDS.length), fx.interface, "UnknownWorld", [WORLDS.length]);
    });
  });

  // -------------------------------------------------------------------------
  describe("deployment", function () {
    it("lists exactly the harness's echidna_ properties in failedProperties() bit order", async function () {
      const h = await loadFixture(fixedHarness);
      const sels = await h.propertySelectors();
      expect(sels).to.deep.equal(PROPS.map((n) => h.interface.getSighash(`${n}()`)));
      const abiProps = Object.values(h.interface.functions).map((f) => f.name).filter((n) => n.startsWith("echidna_"));
      expect([...abiProps].sort()).to.deep.equal([...PROPS].sort());
    });

    it("starts with both worlds initialised at their first 17 canonical headers and every property holding", async function () {
      const h = await loadFixture(fixedHarness);
      for (let w = 0; w < WORLDS.length; w++) {
        const wd = WORLDS[w];
        const world = await h.getWorld(w);
        const s = await state(h, w);
        expect(s.height).to.equal(wd.firstHeight + RING - 1);
        expect(s.next).to.equal(0);
        expect(lc(s.tip.blockHash)).to.equal(lc(wd.canonical[RING - 1].blockHash));
        expect(world.tipIndex.toNumber()).to.equal(RING - 1);
        expect(world.tipIsOrphan).to.equal(false);
        expect(world.epoch.toNumber()).to.equal(1);
        expect(await s.oracle.getBufferSize()).to.equal(RING);
      }
      await expectProperties(h, 0, "after deployment");
    });
  });

  // -------------------------------------------------------------------------
  describe("production facet — deterministic sequences", function () {
    it("linear extension with submitNextBlock walks the pointer through both wraps to the fixture end", async function () {
      const h = await loadFixture(fixedHarness);
      const wd = WORLDS[W967];
      for (let i = RING; i < wd.canonical.length; i++) {
        await act.next(h, W967);
        const s = await state(h, W967);
        expect(s.height).to.equal(wd.firstHeight + i);
        expect(s.next).to.equal((i - (RING - 1)) % RING);
        expect(lc(s.tip.blockHash)).to.equal(lc(wd.canonical[i].blockHash));
        await expectProperties(h, 0, `after submitNext to ${wd.firstHeight + i}`);
      }
      // Fixture exhausted: submitNext is a no-op, never a failure.
      await act.next(h, W967);
      expect((await stats(h)).acceptedSubmissions).to.equal(wd.canonical.length - RING);
      await expectProperties(h, 0);
    });

    it("a single 19-header batch extension (longer than the ring) is accepted", async function () {
      const h = await loadFixture(fixedHarness);
      const wd = WORLDS[W935];
      await act.batch(h, W935, RING, 18); // canonical[17 .. 35]: len = 1 + 18 % 19
      const s = await state(h, W935);
      expect(s.height).to.equal(wd.firstHeight + wd.canonical.length - 1);
      expect(s.next).to.equal(19 % RING);
      expect(lc(s.tip.blockHash)).to.equal(lc(wd.canonical[wd.canonical.length - 1].blockHash));
      await expectProperties(h, 0);
    });

    it("production incident: orphan in slot 16 (nextBlockIndex 0), then the held depth-1 batch replays", async function () {
      const h = await loadFixture(fixedHarness);
      const wd = WORLDS[W967];
      await driveOrphanIntoSlot(h, W967, 16);
      let s = await state(h, W967);
      expect(s.height).to.equal(matrix.orphanHeight);
      expect(s.next).to.equal(0);
      expect(lc((await s.oracle.getBlockHeaderAt(16)).blockHash)).to.equal(lc(wd.orphan.blockHash));
      expect((await h.getWorld(W967)).tipIsOrphan).to.equal(true);
      await expectProperties(h, 0, "with the orphan as tip");

      await act.reorg(h, W967, 1, 2); // [967143 canonical, 967144, 967145, 967146]
      s = await state(h, W967);
      expect(s.height).to.equal(967146);
      expect(s.next).to.equal(3);
      expect(lc((await s.oracle.getBlockHeaderByNumber(matrix.orphanHeight)).blockHash)).to.equal(lc(wd.canonical[wd.orphanIndex].blockHash));
      const st = await stats(h);
      expect(st.acceptedReorgs).to.equal(1);
      expect((await h.getWorld(W967)).successorSeen).to.equal(true);
      await expectProperties(h, 0, "after the replay");
    });

    it("after the canonical successor is stored the orphan can never come back (single or batch)", async function () {
      const h = await loadFixture(fixedHarness);
      await driveOrphanIntoSlot(h, W967, 16);
      await act.reorg(h, W967, 1, 0); // [967143 canonical, 967144]
      const before = await state(h, W967);
      await act.orphan(h, W967);
      for (let pre = 0; pre <= RING; pre++) await act.orphanBatch(h, W967, pre);
      await act.any(h, W967, WORLDS[W967].canonical.length); // index count = orphan
      const after = await state(h, W967);
      expect(after.height).to.equal(before.height);
      expect(lc(after.tip.blockHash)).to.equal(lc(before.tip.blockHash));
      expect((await stats(h)).safetyViolations).to.equal(0);
      await expectProperties(h, 0);
    });

    it("orphan in slot 0 (nextBlockIndex 1), then the depth-1 replay", async function () {
      const h = await loadFixture(fixedHarness);
      await driveOrphanIntoSlot(h, W967, 0);
      let s = await state(h, W967);
      expect(s.next).to.equal(1);
      expect(lc((await s.oracle.getBlockHeaderAt(0)).blockHash)).to.equal(lc(WORLDS[W967].orphan.blockHash));
      await act.reorg(h, W967, 1, 2);
      s = await state(h, W967);
      expect(s.height).to.equal(967146);
      expect(s.next).to.equal(4);
      await expectProperties(h, 0);
    });

    it("all 17 orphan slots: state and replay outcome match scenarios.json 'After fix'", async function () {
      const h = await loadFixture(fixedHarness);
      for (const sc of matrix.scenarios) {
        await driveOrphanIntoSlot(h, W967, sc.orphanSlot);
        let s = await state(h, W967);
        expect([s.height, s.next], `slot ${sc.orphanSlot} pre-state`).to.deep.equal([sc.stateWithOrphan.currentBlockHeight, sc.stateWithOrphan.nextBlockIndex]);
        await act.reorg(h, W967, 1, sc.replayBatch.blocks.length - 2); // depth 1, len = replayBatch length
        s = await state(h, W967);
        const after = sc.expectedAfterFix;
        expect([s.height, s.next], `slot ${sc.orphanSlot} post-state`).to.deep.equal([after.currentBlockHeight, after.nextBlockIndex]);
        expect(lc((await s.oracle.getBlockHeaderAt(after.slotNowHolding967143)).blockHash)).to.equal(lc(after.blockHeaderByNumber_967143));
        await expectProperties(h, 0, `slot ${sc.orphanSlot}`);
      }
      const st = await stats(h);
      expect(st.acceptedReorgs).to.equal(matrix.scenarios.length);
      expect(st.panicCount).to.equal(0);
    });

    it("world 1 (reorg-935497): orphan placed in slot 16 directly by init, then replayed at depths 1..6", async function () {
      const h = await loadFixture(fixedHarness);
      const wd = WORLDS[W935];
      for (let depth = 1; depth <= MTP_SAFE_DEPTH; depth++) {
        await act.reset(h, W935, 0, true); // init window = canonical[p-16 .. p-1] + orphan
        let s = await state(h, W935);
        expect([s.height, s.next]).to.deep.equal([wd.orphan.blockNumber, 0]);
        expect(lc(s.tip.blockHash)).to.equal(lc(wd.orphan.blockHash));
        await act.reorg(h, W935, depth, 0);
        s = await state(h, W935);
        expect(s.height, `depth ${depth}`).to.equal(wd.orphan.blockNumber + 1);
        expect(lc((await s.oracle.getBlockHeaderByNumber(wd.orphan.blockNumber)).blockHash)).to.equal(lc(wd.canonical[wd.orphanIndex].blockHash));
        await expectProperties(h, 0, `world 1 depth ${depth}`);
      }
    });

    it("pointer x depth matrix: every replay of depth 1..6 at every nextBlockIndex is accepted", async function () {
      const h = await loadFixture(fixedHarness);
      const { panics, accepted, failedUnion } = await pointerDepthMatrix(h);
      expect(panics, "no panics on the fixed facet").to.deep.equal([]);
      expect(accepted).to.equal(RING * MTP_SAFE_DEPTH);
      expect(namesOf(failedUnion), "no property failed after any replay").to.deep.equal([]);
      await expectProperties(h, 0);
    });

    it("overlapping, stale, gapped and too-deep batches are rejected without breaking any property", async function () {
      const h = await loadFixture(fixedHarness);
      const wd = WORLDS[W967];
      await nextUntil(h, W967, 24); // tip 967134, window canonical[8..24]
      const before = await state(h, W967);
      await act.batch(h, W967, 10, 4); // canonical[10..14], fully stored, not longer
      await act.batch(h, W967, 20, 4); // canonical[20..24]: equal-length depth-5 replay of the tip
      await act.batch(h, W967, 9, 15); // canonical[9..24], ends at the tip: not longer (depth 16)
      await act.batch(h, W967, 26, 2); // canonical[26..28]: gap, parent 25 not stored
      await act.batch(h, W967, 7, 19); // canonical[7..26]: parent 6 already evicted (depth 18)
      await act.batch(h, W967, 0, 19); // canonical[0..19]: parent precedes the fixture
      const after = await state(h, W967);
      expect([after.height, after.next]).to.deep.equal([before.height, before.next]);
      let st = await stats(h);
      expect(st.acceptedSubmissions).to.equal(24 - (RING - 1));
      await expectProperties(h, 0, "after rejected batches");

      await act.batch(h, W967, 20, 5); // canonical[20..25]: overlaps the tip, one longer (depth 5)
      const s = await state(h, W967);
      expect(s.height).to.equal(wd.firstHeight + 25);
      st = await stats(h);
      expect(st.acceptedReorgs).to.equal(1);
      await expectProperties(h, 0, "after an overlapping longer batch");
    });

    it("ORC-007 FIXED: same-chain replays of depth 7..16 are all accepted; 17 is CannotFindForkPoint", async function () {
      const h = await loadFixture(fixedHarness);
      await nextUntil(h, W967, 30);
      const outcomes = [];
      for (let depth = MTP_SAFE_DEPTH + 1; depth <= RING; depth++) {
        const snap = await network.provider.send("evm_snapshot");
        const before = await stats(h);
        await act.reorg(h, W967, depth, 0);
        const after = await stats(h);
        const outcome =
          after.acceptedReorgs.gt(before.acceptedReorgs) ? "accepted" : after.mtpRejections.gt(before.mtpRejections) ? "InvalidTimestamp" : "rejected";
        outcomes.push(`${depth}:${outcome}`);
        // The median-time window is read by height (ORC-007), so a replay inside the buffer
        // is accepted at every depth; only a fork point outside the buffer is rejected.
        expect(outcome).to.equal(depth === RING ? "rejected" : "accepted");
        await expectProperties(h, 0, `depth ${depth}`);
        await network.provider.send("evm_revert", [snap]);
      }
      console.log(`      deep same-chain replays from tip ${WORLDS[W967].firstHeight + 30}: ${outcomes.join(" ")}`);
    });

    it("caller-supplied blockNumber / blockHash are recomputed; a skewed first blockNumber is rejected", async function () {
      const h = await loadFixture(fixedHarness);
      const wd = WORLDS[W967];
      const junk = ethers.BigNumber.from("0x" + "ab".repeat(32));
      await act.any(h, W967, RING, junk); // the real next header with junk metadata: accepted
      let s = await state(h, W967);
      expect(s.height).to.equal(wd.firstHeight + RING);
      expect(lc(s.tip.blockHash)).to.equal(lc(wd.canonical[RING].blockHash));
      expect(s.tip.blockNumber).to.equal(wd.firstHeight + RING);

      for (const skew of [1, ethers.constants.MaxUint256, 17, ethers.BigNumber.from(2).pow(255)]) {
        await act.skewed(h, W967, RING + 1, 2, skew, 0); // canonical[18..20] with a wrong first number
      }
      s = await state(h, W967);
      expect(s.height).to.equal(wd.firstHeight + RING);

      await act.skewed(h, W967, RING - 2, 4, 0, junk); // depth-2 replay, junk metadata on every header
      s = await state(h, W967);
      expect(s.height).to.equal(wd.firstHeight + RING + 2);
      const window = await s.oracle.getAllBlockHeaders();
      for (const hdr of window) expect(lc(hdr.blockHash)).to.not.equal(lc(ethers.utils.hexZeroPad(junk.toHexString(), 32)));
      await expectProperties(h, 0);
    });

    it("a replay the oracle must accept is rejected once any consensus field is tampered", async function () {
      const h = await loadFixture(fixedHarness);
      await driveOrphanIntoSlot(h, W967, 16); // tamper replays from the incident state too
      const before = await state(h, W967);
      for (let field = 0; field < 6; field++) {
        await act.tampered(h, W967, 1, 0, field, 1, false); // depth-1 replay, first header
        await act.tampered(h, W967, 3, 2, field, ethers.constants.MaxUint256, false); // depth 3, inner header
      }
      await act.reorg(h, W967, 1, 0); // honest replay to a canonical tip
      for (let field = 0; field < 6; field++) await act.tampered(h, W967, 0, 0, field, 0x100, true); // submitNextBlock path
      const st = await stats(h);
      expect(st.safetyViolations).to.equal(0);
      expect(st.acceptedSubmissions.toNumber()).to.be.greaterThan(0);
      const s = await state(h, W967);
      expect(s.height).to.equal(before.height + 1); // only the honest replay landed
      await expectProperties(h, 0);
    });

    it("re-initialising a live oracle is rejected", async function () {
      const h = await loadFixture(fixedHarness);
      for (let w = 0; w < WORLDS.length; w++) {
        await act.reinit(h, w, 0);
        await act.reinit(h, w, 5);
      }
      expect((await stats(h)).reinitSucceeded).to.equal(false);
      await expectProperties(h, 0);
    });

    it("ORC-011 FIXED: submitBatchBlocks([]) reverts a named error — echidna_empty_batch_no_panic holds", async function () {
      const h = await loadFixture(fixedHarness);
      const before = await state(h, W967);
      await act.empty(h, W967);
      const st = await stats(h);
      expect(st.emptyBatchPanicked).to.equal(false);
      expect(st.panicCount).to.equal(0);
      expect(st.unexpectedErrorCount, "BlockHeaderOracle_EmptyBatch is a declared error").to.equal(0);
      await expectProperties(h, 0, "after the empty batch");
      const after = await state(h, W967);
      expect([after.height, after.next]).to.deep.equal([before.height, before.next]);

      await act.reorg(h, W967, 1, 0);
      await expectProperties(h, 0);
    });
  });

  // -------------------------------------------------------------------------
  describe("negative control — pre-SCRUM-521 facet (SEC-015)", function () {
    it("starts healthy (the defect needs a replay to trigger)", async function () {
      const h = await loadFixture(preFixHarness);
      await expectProperties(h, 0);
    });

    it("production sequence: the depth-1 replay from slot 16 trips the panic and liveness properties", async function () {
      const h = await loadFixture(preFixHarness);
      await driveOrphanIntoSlot(h, W967, 16);
      await expectProperties(h, 0, "before the replay");
      await act.reorg(h, W967, 1, 2);
      const st = await stats(h);
      expect(st.panicCount).to.equal(1);
      expect(st.lastPanicCode).to.equal(PANIC_ARITHMETIC);
      expect(st.lastPanicAction).to.equal(A.REORG);
      expect(st.livenessViolations).to.equal(1);
      // The oracle is frozen at the orphan: exactly the SEC-015 properties fail, the
      // structural ones still hold (the panicking call was rolled back).
      await expectProperties(h, SEC015_BITS, "after the replay");
      const s = await state(h, W967);
      expect([s.height, s.next]).to.deep.equal([matrix.orphanHeight, 0]);
    });

    it("all 17 orphan slots: the harness flags exactly the slots scenarios.json marks 'Before fix: Panic(0x11)'", async function () {
      const fixed = await loadFixture(fixedHarness);
      const preFix = await loadFixture(preFixHarness);
      const expected = matrix.scenarios.filter((sc) => sc.expectedBeforeFix !== "success").map((sc) => sc.orphanSlot);
      expect([...expected].sort((a, b) => a - b)).to.deep.equal([0, 16]);

      const flagged = [];
      for (const sc of matrix.scenarios) {
        await driveOrphanIntoSlot(preFix, W967, sc.orphanSlot);
        const before = await stats(preFix);
        await act.reorg(preFix, W967, 1, sc.replayBatch.blocks.length - 2);
        const after = await stats(preFix);
        if (after.panicCount.gt(before.panicCount)) {
          expect(after.lastPanicCode).to.equal(PANIC_ARITHMETIC);
          flagged.push(sc.orphanSlot);
        } else {
          const s = await state(preFix, W967);
          expect([s.height, s.next]).to.deep.equal([sc.expectedAfterFix.currentBlockHeight, sc.expectedAfterFix.nextBlockIndex]);
        }
      }
      expect(flagged.sort((a, b) => a - b)).to.deep.equal([...expected].sort((a, b) => a - b));
      expect(namesOf(await mask(preFix))).to.deep.equal(namesOf(SEC015_BITS));
      expect((await stats(fixed)).panicCount).to.equal(0); // untouched fixed-harness snapshot
    });

    it("pointer x depth matrix: panics exactly where nextBlockIndex <= depth (no orphan needed)", async function () {
      const h = await loadFixture(preFixHarness);
      const { panics, accepted, failedUnion } = await pointerDepthMatrix(h);
      const expected = [];
      for (let next = 0; next < RING; next++) for (let d = 1; d <= MTP_SAFE_DEPTH; d++) if (next <= d) expected.push(`${next}/${d}`);
      expect(panics).to.deep.equal(expected);
      expect(accepted).to.equal(RING * MTP_SAFE_DEPTH - expected.length);
      expect(namesOf(failedUnion), "only the SEC-015 properties fail").to.deep.equal(namesOf(SEC015_BITS));
    });

    it("right after initialisation (nextBlockIndex 0) a depth-1 same-chain replay already panics", async function () {
      const preFix = await loadFixture(preFixHarness);
      await act.reorg(preFix, W935, 1, 0);
      expect((await stats(preFix)).lastPanicCode).to.equal(PANIC_ARITHMETIC);
      expect(namesOf(await mask(preFix))).to.deep.equal(namesOf(SEC015_BITS));

      const fixed = await loadFixture(fixedHarness);
      await act.reorg(fixed, W935, 1, 0);
      await expectProperties(fixed, 0);
    });
  });

  // -------------------------------------------------------------------------
  describe("seeded random walks over every action", function () {
    it("production facet: 300 random actions never fail a property", async function () {
      const h = await loadFixture(fixedHarness);
      const log = await randomWalk(h, 0x5ec015, 300, async (step, label) => {
        const m = await mask(h);
        expect(namesOf(m), `step ${step}: ${label}`).to.deep.equal([]);
      });
      const st = await stats(h);
      console.log(
        `      walk: ${log.length} actions, accepted ${st.acceptedSubmissions}, reorgs ${st.acceptedReorgs}, ` +
          `mtp-rejected ${st.mtpRejections}, empty-reverts ${st.emptyRevertCount}`
      );
      expect(st.acceptedSubmissions.toNumber(), "the walk must exercise accepted submissions").to.be.greaterThan(20);
      expect(st.acceptedReorgs.toNumber(), "the walk must exercise accepted reorg replays").to.be.greaterThan(2);
      expect(st.panicCount).to.equal(0);
    });

    it("pre-fix facet: the same random walk is caught by the SEC-015 properties", async function () {
      const h = await loadFixture(preFixHarness);
      let caughtAt = -1;
      await randomWalk(h, 0x5ec015, 300, async (step) => {
        if ((await mask(h)) & bit("echidna_no_panic_nonempty")) {
          caughtAt = step;
          return STOP;
        }
      });
      expect(caughtAt, "the walk must hit the SEC-015 panic").to.be.at.least(0);
      const st = await stats(h);
      expect(st.lastPanicCode).to.equal(PANIC_ARITHMETIC);
      // The panic property always fires. Liveness fires too only if the panicking call was one
      // the spec says must be accepted: the pre-fix rewind panics before any header is
      // verified, so a tampered replay (which must be rejected anyway) panics as well.
      expect((await mask(h)) & bit("echidna_no_panic_nonempty")).to.not.equal(0);
      const actionName = Object.keys(A).find((k) => A[k] === st.lastPanicAction);
      console.log(`      pre-fix walk: first SEC-015 Panic(0x11) at step ${caughtAt}, action ${actionName}`);
    });
  });
});

// ---------------------------------------------------------------------------
// Shared drivers
// ---------------------------------------------------------------------------

/**
 * For every nextBlockIndex 0..16 (world 0, init window 0, then `next` linear headers)
 * replay the canonical chain from depth 1..6 below the tip with a batch one header
 * longer than the depth. Each replay runs from an EVM snapshot of the pointer state.
 */
async function pointerDepthMatrix(h) {
  const panics = [];
  let accepted = 0;
  let failedUnion = 0; // properties seen failing right after a replay (read before the revert)
  await act.reset(h, W967, 0);
  for (let next = 0; next < RING; next++) {
    if (next > 0) await act.next(h, W967);
    const s = await state(h, W967);
    expect(s.next).to.equal(next);
    for (let d = 1; d <= MTP_SAFE_DEPTH; d++) {
      const snap = await network.provider.send("evm_snapshot");
      const before = await stats(h);
      await act.reorg(h, W967, d, 0);
      const after = await stats(h);
      if (after.panicCount.gt(before.panicCount)) panics.push(`${next}/${d}`);
      if (after.acceptedReorgs.gt(before.acceptedReorgs)) accepted++;
      failedUnion |= await mask(h);
      await network.provider.send("evm_revert", [snap]);
    }
  }
  return { panics, accepted, failedUnion };
}

const STOP = Symbol("stop");

/** mulberry32 */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random sequence over every fuzz action with fuzzer-like arguments. Weighted so chains
 * grow between resets. `check(step, label)` runs after every action.
 */
async function randomWalk(h, seed, steps, check) {
  const rnd = prng(seed);
  const u8 = () => Math.floor(rnd() * 256);
  const w = () => Math.floor(rnd() * 2);
  const small = (n) => Math.floor(rnd() * n);
  // Deterministic 256-bit words (0 half the time: "no junk" / default delta).
  const word = () =>
    rnd() < 0.5 ? 0 : ethers.BigNumber.from("0x" + Array.from({ length: 32 }, () => u8().toString(16).padStart(2, "0")).join(""));
  const choices = [
    [3, () => ["reset", act.reset, [w(), u8(), rnd() < 0.2]]],
    [14, () => ["next", act.next, [w()]]],
    [4, () => ["any", act.any, [w(), u8(), word()]]],
    [5, () => ["orphan", act.orphan, [w()]]],
    [6, () => ["batch", act.batch, [w(), u8(), u8()]]],
    [10, () => ["reorg", act.reorg, [w(), small(RING + 1), small(3)]]],
    [4, () => ["orphanBatch", act.orphanBatch, [w(), u8()]]],
    [3, () => ["skewed", act.skewed, [w(), u8(), u8(), rnd() < 0.5 ? 0 : small(40), word()]]],
    [4, () => ["tampered", act.tampered, [w(), u8(), u8(), u8(), word(), rnd() < 0.5]]],
    [1, () => ["empty", act.empty, [w()]]],
    [1, () => ["reinit", act.reinit, [w(), u8()]]],
  ];
  const total = choices.reduce((s, [wt]) => s + wt, 0);
  const log = [];
  for (let step = 0; step < steps; step++) {
    let r = rnd() * total;
    let pick = choices[choices.length - 1][1];
    for (const [wt, fn] of choices) {
      if ((r -= wt) < 0) {
        pick = fn;
        break;
      }
    }
    const [name, fn, args] = pick();
    const label = `${name}(${args.map(String).join(",")})`;
    await fn(h, ...args);
    log.push(label);
    if ((await check(step, label)) === STOP) break;
  }
  return log;
}
