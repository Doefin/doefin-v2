// PENTEST · ORC-001 (CRITICAL) — a header's own nBits is never validated, PoW is checked
// against the PARENT's self-declared target, and fork choice counts blocks, not work
// ----------------------------------------------------------------------------
// STATUS: FIXED (SCRUM-214) — `_verifyBlockHeader` now applies Bitcoin's header rules:
// nBits equal to the parent's inside a 2016-block period and equal to the retarget result at a
// boundary (`_verifyDifficulty`), proof of work against the header's OWN target
// (`BlockHeaderUtils.meetsOwnTarget`), and `submitBatchBlocks` keeps the chain with the most
// cumulative work (`_branchWork` vs `_storedWorkAbove`). The scenario below is the pre-fix attack.
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
// Root cause (pre-fix)
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
//   - H2…Hn are mined in JS at test time; each needs ~1 try.
//   - (b) uses a synthetic regtest-style chain (test/utils/syntheticChain.js).

const path = require("path");
const { expect } = require("chai");
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

  it("ATTACK BLOCKED (a) — a mid-epoch header (42329) declaring nBits 0x2100ffff (parent: 0x1c654657) reverts UnexpectedDifficulty", async function () {
    const ctx = await loadReal2010();

    // H1 carries one genuine block of work against its parent's target — the pre-fix check —
    // but inside a difficulty period its nBits must equal the parent's.
    await expect(ctx.oracle.submitNextBlock(H1)).to.be.revertedWith("BlockHeaderOracle_UnexpectedDifficulty()");

    expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(TIP);
    expect((await ctx.oracle.getLatestBlockHeader()).blockHash).to.equal(REAL.byHeight[TIP].blockHash);
  });

  it("ATTACK BLOCKED (a) — the free follow-on branch H1..H20 is refused as a batch too (UnexpectedDifficulty at H1)", async function () {
    const ctx = await loadReal2010();
    const { headers } = attackerBranch(19);

    await expect(ctx.oracle.connect(ctx.signers.attacker).submitBatchBlocks(headers)).to.be.revertedWith(
      "BlockHeaderOracle_UnexpectedDifficulty()"
    );
    expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(TIP);
  });

  it("ATTACK BLOCKED (b) — a header whose hash is ABOVE its own declared target (but below its parent's) reverts InvalidBlockHash", async function () {
    const ctx = await deployOracleAuditDiamond();
    // The child sits on a retarget boundary and declares a 2x harder target — inside Bitcoin's
    // 4x clamp, so the difficulty rule accepts the nBits. Only its proof of work is wrong.
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
    expect(sc.passesBitcoinPow(child, sc.POW_LIMIT.REGTEST)).to.equal(false);

    await expect(ctx.oracle.submitNextBlock(sc.toContract(child))).to.be.revertedWith("BlockHeaderOracle_InvalidBlockHash()");
    expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(boundary - 1);
  });

  it("ATTACK BLOCKED (c) — a branch with LESS cumulative work but MORE blocks reverts NewChainNotLonger; the real chain stays", async function () {
    const ctx = await loadReal2010();
    const honest = REAL.headers(TIP + 1, TIP + 3); // 3 real blocks on top of the fork point 42328
    await submitEach(ctx, honest);
    expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(TIP + 3);

    const { headers: attack } = attackerBranch(3); // H1..H4, fork at 42328
    const honestWork = honest.reduce((s, h) => s + sc.blockWork(h.nBits), 0n);
    const attackDeclaredWork = attack.reduce((s, h) => s + sc.blockWork(h.nBits), 0n);
    expect(attackDeclaredWork).to.equal(4n); // ~1 hash per header
    expect(honestWork > attackDeclaredWork).to.equal(true);

    // Most-work fork choice runs before any header is applied.
    await expect(ctx.oracle.submitBatchBlocks(attack)).to.be.revertedWith("BlockHeaderOracle_NewChainNotLonger()");
    for (let i = 0; i < honest.length; i++) {
      expect((await ctx.oracle.getBlockHeaderByNumber(TIP + 1 + i)).blockHash).to.equal(honest[i].blockHash);
    }
  });

  describe("(d) end-to-end — the attacker can no longer choose a DifficultyThreshold outcome", function () {
    it("ATTACK BLOCKED — the forged branch H1..H14 is refused, the question stays open, and the real chain resolves it YES", async function () {
      const ctx = await loadReal2010();
      const { conditionId } = await createThreshold(ctx, THRESHOLD, TARGET_HEIGHT);
      const { headers: attack } = attackerBranch(SETTLEMENT_HEIGHT - TIP - 1); // H1..H14 → heights 42329..42342

      await expect(ctx.oracle.connect(ctx.signers.attacker).submitBatchBlocks(attack)).to.be.revertedWith(
        "BlockHeaderOracle_UnexpectedDifficulty()"
      );
      expect(await payouts(ctx, conditionId)).to.deep.equal([0, 0]); // unresolved
      expect(await ctx.oracleAdapter.getTotalQuestionsResolved()).to.equal(0);

      // Pre-fix: forged NO, then NewChainNotLonger / CannotFindForkPoint locked the real chain out.
      await submitEach(ctx, REAL.headers(TIP + 1, SETTLEMENT_HEIGHT));
      expect(await payouts(ctx, conditionId)).to.deep.equal([0, 1]); // YES: real difficulty 3 > 2
    });

    it("ATTACK BLOCKED — no lock-out: after the refused attack the full real chain 42329..42350 is accepted as one batch", async function () {
      const ctx = await loadReal2010();
      const { headers: attack } = attackerBranch(sc.NUM_OF_BLOCK_HEADERS - 1); // H1..H17
      await expect(ctx.oracle.connect(ctx.signers.attacker).submitBatchBlocks(attack)).to.be.revertedWith(
        "BlockHeaderOracle_UnexpectedDifficulty()"
      );

      await submitBatch(ctx, REAL.headers(TIP + 1, LAST));
      expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(LAST);
      expect((await ctx.oracle.getLatestBlockHeader()).blockHash).to.equal(REAL.byHeight[LAST].blockHash);
    });
  });
});
