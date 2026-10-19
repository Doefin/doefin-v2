// PENTEST · ORC-008 (MEDIUM) — `initializeBlockHeaderOracle` is permissionless and validates
// nothing, so whoever calls it first on a fresh deployment owns the oracle
// ----------------------------------------------------------------------------
// STATUS: FIXED (SCRUM-214) — `initializeBlockHeaderOracle` is owner-only
// (`LibDiamond.enforceIsContractOwner`) and requires the 17 headers to be one linked chain
// with valid proof of work against each header's own target. Deployment follow-up: the oracle
// must now be initialised by the owner (Safe), e.g. inside the bootstrap MultiSend.
//
// Attack scenario
//
//   The documented deployment cuts the facets in from the Safe and initialises the oracle in a
//   LATER, separate EOA transaction (scripts/seed-oracle.js:55; the MultiSend in
//   scripts/deploy-safe-owned.js:221-278 does not initialise it). Anyone watching for the cut
//   back-runs it with `initializeBlockHeaderOracle(<17 arbitrary headers>, <any height>)`:
//     - no access control: the only guard is `currentBlockHeight != 0`;
//     - no validation: linkage, PoW and nBits of the 17 headers are never checked, so the
//       attacker also picks the baseline target every later PoW check builds on;
//     - no reset: the honest initialisation then reverts AlreadyInitialized, and only a
//       diamondCut `_init` (or a redeploy) can undo it.
//
// Root cause (pre-fix)
//
//   contracts/facets/DoefinV1BlockHeaderOracleFacet.sol:69-91.
//
// Impact
//
//   On a fresh deployment the attacker owns the oracle from block one (free headers; honest
//   headers never link). The mainnet Diamond is already initialised and not exposed.

const path = require("path");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const sc = require("../utils/syntheticChain.js");
const { isolateChainState } = require("../utils/oracleAuditFixture.js");
const { snapshotFixture, deployOracleAuditDiamond, submitEach, loadRealHeaders } = require("../utils/oracleAuditFixture.js");

const REAL = loadRealHeaders(path.join(__dirname, "../data/reorg_index_underflow/blocks-mainchain-967110-967160.json"));
const INIT_FROM = 967110; // the height the deployer intends to seed
const TIP = INIT_FROM + sc.NUM_OF_BLOCK_HEADERS - 1;

/** 17 headers that link to nothing, carry no proof of work, and end on the attack target. */
function garbageHeaders() {
  return Array.from({ length: sc.NUM_OF_BLOCK_HEADERS }, (_, i) => {
    const h = {
      prevBlockHash: "0x" + sc.sha256(Buffer.from(`orc008-unlinked-prev-${i}`)).toString("hex"),
      merkleRootHash: "0x" + sc.sha256(Buffer.from(`orc008-merkle-${i}`)).toString("hex"),
      blockNumber: INIT_FROM + i,
      version: 0x20000000,
      timestamp: 1_000_000_000 + i * 7, // arbitrary
      nBits: i === sc.NUM_OF_BLOCK_HEADERS - 1 ? sc.NBITS.ATTACK : 0x1d00ffff + i, // arbitrary, last one trivial
      nonce: 0, // no work at all
    };
    h.blockHash = sc.blockHash(h);
    return h;
  });
}

const loadFresh = snapshotFixture(deployOracleAuditDiamond);

describe("PENTEST · ORC-008 (MEDIUM) — permissionless, unvalidated oracle initialisation", function () {
  this.timeout(300_000);
  isolateChainState();

  it("CONTROL — the owner initialises with 17 real linked headers and the next real header is accepted", async function () {
    const ctx = await loadFresh();
    await ctx.oracle.connect(ctx.signers.owner).initializeBlockHeaderOracle(REAL.headers(INIT_FROM, TIP), INIT_FROM);
    await submitEach(ctx, REAL.headers(TIP + 1, TIP + 1));
    expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(TIP + 1);
  });

  it("ATTACK BLOCKED — a non-owner cannot initialise: NotContractOwner(), the oracle stays uninitialised", async function () {
    const ctx = await loadFresh();
    const { attacker, owner } = ctx.signers;
    const ownership = await ethers.getContractAt("OwnershipFacet", ctx.diamondAddress);
    expect(await ownership.owner()).to.equal(owner.address);
    expect(attacker.address).to.not.equal(owner.address);

    // Pre-fix: accepted, and the attacker's 17 headers became the oracle's baseline.
    await expect(
      ctx.oracle.connect(attacker).initializeBlockHeaderOracle(garbageHeaders().map(sc.toContract), INIT_FROM)
    ).to.be.revertedWith("NotContractOwner()");
    // Even a perfectly valid seed is refused from a non-owner.
    await expect(
      ctx.oracle.connect(attacker).initializeBlockHeaderOracle(REAL.headers(INIT_FROM, TIP), INIT_FROM)
    ).to.be.revertedWith("NotContractOwner()");
    expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(0);
  });

  it("ATTACK BLOCKED — even the owner cannot seed unmined headers (InvalidBlockHash) or a chain with a gap (PrevBlockHashMismatch)", async function () {
    const ctx = await loadFresh();
    const { owner } = ctx.signers;

    const junk = garbageHeaders();
    expect(junk.every((h) => !sc.passesBitcoinPow(h))).to.equal(true); // none carries valid PoW
    await expect(
      ctx.oracle.connect(owner).initializeBlockHeaderOracle(junk.map(sc.toContract), INIT_FROM)
    ).to.be.revertedWith("BlockHeaderOracle_InvalidBlockHash()");

    // 17 real, PoW-valid headers with one height skipped: every header is genuine but the seed is not one chain.
    const gapped = [...REAL.headers(INIT_FROM, INIT_FROM + 7), ...REAL.headers(INIT_FROM + 9, TIP + 1)];
    expect(gapped).to.have.lengthOf(sc.NUM_OF_BLOCK_HEADERS);
    await expect(
      ctx.oracle.connect(owner).initializeBlockHeaderOracle(gapped, INIT_FROM)
    ).to.be.revertedWith("BlockHeaderOracle_PrevBlockHashMismatch()");

    expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(0);
  });

  it("ATTACK BLOCKED — after the failed hijack the owner's honest initialisation succeeds and the real chain extends", async function () {
    const ctx = await loadFresh();
    await expect(
      ctx.oracle.connect(ctx.signers.attacker).initializeBlockHeaderOracle(garbageHeaders().map(sc.toContract), INIT_FROM)
    ).to.be.revertedWith("NotContractOwner()");

    // Pre-fix: AlreadyInitialized here, and the real next block could never link.
    await ctx.oracle.connect(ctx.signers.owner).initializeBlockHeaderOracle(REAL.headers(INIT_FROM, TIP), INIT_FROM);
    await submitEach(ctx, REAL.headers(TIP + 1, TIP + 1));
    expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(TIP + 1);
    expect((await ctx.oracle.getLatestBlockHeader()).blockHash).to.equal(REAL.byHeight[TIP + 1].blockHash);
  });
});
