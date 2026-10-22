// AUDIT · CTF-005 (MEDIUM), CTF-006 (MEDIUM) — who may resolve a condition, and how
// ----------------------------------------------------------------------------
// Finding detail: audit/findings/ctf-review.md.
//
//   CTF-005: payouts could only be written by the condition's oracle. A condition that can
//            never be reported (stalled oracle, orphaned or skipped question) locked one-sided
//            collateral until an emergency diamondCut; cancelCondition only halted trading.
//   CTF-006: the legacy createCondition let a market maker appoint any resolver; reportPayouts
//            accepted any vector (single slot, unbounded numerators) and ignored cancellation.
//
// FIX (SCRUM-214):
//   - ConditionManagerFacet.voidCondition (owner, after cancelCondition) resolves as void: every
//     outcome pays an equal share, fee 0. The oracle adapter skips questions whose condition is
//     already resolved, so a void cannot freeze header submission.
//   - Legacy createCondition is owner-only. reportPayouts refuses a cancelled managed condition;
//     payouts need >= 2 slots and numerators summing to at most 2^64 − 1; prepareCondition
//     needs >= 2 slots.
//
// Tests tagged [pre-fix: …] fail on the pre-fix contracts (run recorded in the fix commit).

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupAuditFixture } = require("../utils/auditFixture.js");
const { getConditionId, getCollectionId, getPositionId } = require("../utils/ctfUtils.js");
const sc = require("../utils/syntheticChain.js");
const {
  isolateChainState,
  deployOracleAuditDiamond,
  initSyntheticOracle,
  createDuration,
  payouts,
  submitEach,
} = require("../utils/oracleAuditFixture.js");

const ROOT = ethers.constants.HashZero;

describe("AUDIT · CTF-005 / CTF-006 — resolution authority", function () {
  let ctx;
  let counter = 0;
  const AMOUNT = ethers.utils.parseUnits("1000", 6);

  before(async function () {
    ctx = await setupAuditFixture();
    await ctx.contracts.accessControl.connect(ctx.signers.owner).addMarketMaker(ctx.signers.attacker.address);
  });

  /** Owner-created legacy condition whose resolver is `resolver`. */
  async function legacyCondition(resolver, slots = 2) {
    const questionId = ethers.utils.formatBytes32String(`ctf-auth-${counter++}`);
    await ctx.contracts.conditionMgr.connect(ctx.signers.owner).createCondition(resolver.address, questionId, slots, "ipfs://auth");
    return { questionId, conditionId: getConditionId(resolver.address, questionId, slots) };
  }

  async function position(conditionId, indexSet) {
    return getPositionId(ctx.contracts.collateral.address, await getCollectionId(ROOT, conditionId, indexSet, ethers.provider));
  }

  describe("CTF-005 — a cancelled condition can be voided by the owner", function () {
    it("void pays every outcome an equal share and charges no fee [pre-fix: no void path]", async function () {
      const { owner, buyer, seller } = ctx.signers;
      const { conditionalTokens, conditionMgr, collateral, erc1155Facet, adminConfig } = ctx.contracts;
      await adminConfig.connect(owner).setResolutionFeeBps(300);
      try {
        const { conditionId } = await legacyCondition(owner);
        await conditionalTokens.connect(buyer).splitPosition(collateral.address, ROOT, conditionId, [1, 2], AMOUNT);
        await erc1155Facet.connect(buyer).safeTransferFrom(buyer.address, seller.address, await position(conditionId, 2), AMOUNT, "0x");

        await conditionMgr.connect(owner).cancelCondition(conditionId);
        await expect(conditionMgr.connect(owner).voidCondition(conditionId))
          .to.emit(conditionMgr, "ConditionVoided")
          .withArgs(conditionId, owner.address);
        expect((await conditionalTokens.getPayoutNumerators(conditionId)).map(Number)).to.deep.equal([1, 1]);

        for (const [holder, indexSet] of [[buyer, 1], [seller, 2]]) {
          const before = await collateral.balanceOf(holder.address);
          await conditionalTokens.connect(holder).redeemPositions(collateral.address, ROOT, conditionId, [indexSet]);
          expect((await collateral.balanceOf(holder.address)).sub(before)).to.equal(AMOUNT.div(2)); // no fee on a void
        }
      } finally {
        await adminConfig.connect(owner).setResolutionFeeBps(0); // keep later tests fee-free
      }
    });

    it("only the owner can void; a live condition must be cancelled first; a resolved one cannot be voided [pre-fix: no void path]", async function () {
      const { owner, attacker } = ctx.signers;
      const { conditionMgr, conditionalTokens } = ctx.contracts;

      const live = await legacyCondition(owner);
      await expect(conditionMgr.connect(owner).voidCondition(live.conditionId)).to.be.revertedWith("ConditionStillActive()");
      await conditionMgr.connect(owner).cancelCondition(live.conditionId);
      await expect(conditionMgr.connect(attacker).voidCondition(live.conditionId)).to.be.revertedWith("NotContractOwner()");

      const resolved = await legacyCondition(owner);
      await conditionalTokens.connect(owner).reportPayouts(resolved.questionId, [1, 0]);
      await conditionMgr.connect(owner).cancelCondition(resolved.conditionId);
      await expect(conditionMgr.connect(owner).voidCondition(resolved.conditionId)).to.be.revertedWith("ConditionAlreadyResolved()");

      await expect(conditionMgr.connect(owner).voidCondition(ethers.utils.id("missing"))).to.be.revertedWith("ConditionDoesNotExist()");
    });

    describe("voiding an oracle-backed market does not freeze the oracle", function () {
      isolateChainState();

      it("the voided market's question is skipped when its settlement block is submitted; the oracle keeps advancing and the question totals still balance (INV-ORC-4)", async function () {
        this.timeout(300_000);
        const octx = await deployOracleAuditDiamond();
        const init = await initSyntheticOracle(octx, { fresh: true });
        const tip = init[init.length - 1];
        const start = tip.blockNumber + 10;
        const { conditionId } = await createDuration(octx, start, 1, [600]);

        const cm = await ethers.getContractAt("ConditionManagerFacet", octx.diamondAddress);
        await cm.connect(octx.signers.marketMaker).cancelCondition(conditionId);
        await cm.connect(octx.signers.owner).voidCondition(conditionId);

        const settlement = start + 1 + sc.SETTLEMENT_DELAY;
        await submitEach(octx, sc.extendChain(tip, settlement - tip.blockNumber + 1, { tag: "ctf005-void" }));
        expect(await octx.oracle.getCurrentBlockHeight()).to.equal(settlement + 1);
        expect(await payouts(octx, conditionId)).to.deep.equal([1, 1]); // still the void, not re-resolved
        // INV-ORC-4 (resolved + pending == created): the skipped question left its queue, so it is
        // counted — the cut rehearsal's pending-question accounting relies on this identity.
        expect(await octx.oracleAdapter.getDurationQuestionsAtBlock(settlement)).to.have.lengthOf(0);
        expect(await octx.oracleAdapter.getTotalQuestionsCreated()).to.equal(1);
        expect(await octx.oracleAdapter.getTotalQuestionsResolved()).to.equal(1); // [8c86393..fe651cf: 0]
      });
    });
  });

  describe("CTF-006 — resolver appointment and payout validation", function () {
    it("a market maker cannot create a legacy condition with a resolver of its choice; the owner can [pre-fix: any market maker could]", async function () {
      const { owner, attacker } = ctx.signers;
      const questionId = ethers.utils.formatBytes32String(`ctf-auth-mm-${counter++}`);
      await expect(
        ctx.contracts.conditionMgr.connect(attacker).createCondition(attacker.address, questionId, 2, "ipfs://mm"),
      ).to.be.revertedWith("NotContractOwner()");
      await ctx.contracts.conditionMgr.connect(owner).createCondition(attacker.address, questionId, 2, "ipfs://owner");
    });

    it("a resolver cannot report payouts after its condition is cancelled [pre-fix: accepted]", async function () {
      const { owner, buyer } = ctx.signers;
      const { questionId, conditionId } = await legacyCondition(buyer);
      await ctx.contracts.conditionMgr.connect(owner).cancelCondition(conditionId);
      await expect(ctx.contracts.conditionalTokens.connect(buyer).reportPayouts(questionId, [1, 0])).to.be.revertedWith(
        "ConditionNotActive()",
      );
    });

    it("payout numerators summing above 2^64 − 1 revert InvalidPayouts [pre-fix: accepted — redemption could overflow]", async function () {
      const { buyer } = ctx.signers;
      const { questionId } = await legacyCondition(buyer);
      const huge = ethers.BigNumber.from(2).pow(64);
      await expect(ctx.contracts.conditionalTokens.connect(buyer).reportPayouts(questionId, [huge, 0])).to.be.revertedWith(
        "InvalidPayouts()",
      );
    });

    it("a single-outcome condition cannot be prepared, and a single-slot payout vector is refused [pre-fix: both accepted]", async function () {
      const { owner } = ctx.signers;
      const questionId = ethers.utils.formatBytes32String(`ctf-auth-1slot-${counter++}`);
      await expect(ctx.contracts.conditionalTokens.connect(owner).prepareCondition(owner.address, questionId, 1)).to.be.revertedWith(
        "InvalidOutcomeSlotCount()",
      );
      await expect(ctx.contracts.conditionalTokens.connect(owner).reportPayouts(questionId, [1])).to.be.revertedWith(
        "InvalidPayoutLength()",
      );
    });

    it("CONTROL — the appointed resolver reports a normal vector on an active condition and winners redeem", async function () {
      const { buyer } = ctx.signers;
      const { conditionalTokens, collateral } = ctx.contracts;
      const { questionId, conditionId } = await legacyCondition(buyer);
      await conditionalTokens.connect(buyer).splitPosition(collateral.address, ROOT, conditionId, [1, 2], AMOUNT);
      await conditionalTokens.connect(buyer).reportPayouts(questionId, [0, 1]);

      const before = await collateral.balanceOf(buyer.address);
      await conditionalTokens.connect(buyer).redeemPositions(collateral.address, ROOT, conditionId, [1, 2]);
      expect((await collateral.balanceOf(buyer.address)).sub(before)).to.equal(AMOUNT);
    });
  });
});
