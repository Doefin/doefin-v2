// PENTEST · ORC-011 (INFO) — `submitBatchBlocks([])` reverts with a bare Panic(0x11)
// ----------------------------------------------------------------------------
// STATUS: NOT YET FIXED — the `DEMONSTRATES` test asserts today's Panic(0x11) and must be
// flipped by the fix commit (a named error, e.g. `BlockHeaderOracle_EmptyBatch()`).
//
// Root cause
//
//   contracts/facets/DoefinV1BlockHeaderOracleFacet.sol:128 —
//   `newBlockHeaders[newBlockHeaders.length - 1]` evaluates `0 - 1` in checked arithmetic and
//   panics with 0x11 (arithmetic underflow) before any index access, so the code is 0x11 and not
//   0x32 (array out of bounds). No state changes.
//
// Impact
//
//   The block-indexer matches oracle errors by named selector; a bare arithmetic panic looks the
//   same as a SEC-015-class fault in monitoring. Informational.

const { expect } = require("chai");
const sc = require("../utils/syntheticChain.js");
const { snapshotFixture, deployOracleAuditDiamond, initSyntheticOracle } = require("../utils/oracleAuditFixture.js");

const load = snapshotFixture(async () => {
  const ctx = await deployOracleAuditDiamond();
  const init = await initSyntheticOracle(ctx);
  return { ...ctx, init, tip: init[init.length - 1] };
});

describe("PENTEST · ORC-011 (INFO) — empty batch reverts with a bare arithmetic panic", function () {
  this.timeout(300_000);

  it("CONTROL — a one-header batch extending the tip is accepted", async function () {
    const ctx = await load();
    const [next] = sc.extendChain(ctx.tip, 1, { tag: "orc011" });
    await ctx.oracle.submitBatchBlocks([sc.toContract(next)]);
    expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(ctx.tip.blockNumber + 1);
  });

  it("DEMONSTRATES — submitBatchBlocks([]) reverts with Panic(0x11) (arithmetic underflow, not a named error) and changes nothing", async function () {
    const ctx = await load();
    const nextIndexBefore = await ctx.oracle.getNextBlockIndex();

    await expect(ctx.oracle.submitBatchBlocks([])).to.be.revertedWith("panic code 0x11");

    expect(await ctx.oracle.getCurrentBlockHeight()).to.equal(ctx.tip.blockNumber);
    expect(await ctx.oracle.getNextBlockIndex()).to.equal(nextIndexBefore);
  });
});
