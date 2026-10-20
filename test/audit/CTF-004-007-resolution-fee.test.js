// AUDIT · CTF-004 (MEDIUM), CTF-007 (LOW) — the resolution (redemption) fee
// ----------------------------------------------------------------------------
// Finding detail: audit/findings/ctf-review.md.
//
//   CTF-004: the fee was charged only by redeemPositions. After resolution, merging a full set
//            back to collateral paid nothing, so winners could avoid the fee by pairing their
//            tokens with losing ones (worthless, or fabricated through nested splits).
//   CTF-007: the fee was read at redemption time and could be set to 100% at any moment, so
//            the owner could take winnings of an already-resolved condition.
//
// FIX (SCRUM-214):
//   - setResolutionFeeBps is capped at MAX_RESOLUTION_FEE_BPS = 500 (5%).
//   - The rate is snapshotted per condition when payouts are reported; redemption and the
//     post-resolution merge charge the snapshot. A condition resolved before the cut has no
//     snapshot and is charged 0, so a later fee raise cannot reach its unredeemed winnings.
//   - A root merge of a full set after resolution charges that fee (FEE_KIND_RESOLUTION).
//
// Tests tagged [pre-fix: …] fail on the pre-fix contracts (run recorded in the fix commit).

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupAuditFixture } = require("../utils/auditFixture.js");
const { getConditionId, getCollectionId, getPositionId } = require("../utils/ctfUtils.js");

const ROOT = ethers.constants.HashZero;
const FEE_KIND_RESOLUTION = 1;

describe("AUDIT · CTF-004 / CTF-007 — the resolution fee", function () {
  let ctx;
  const AMOUNT = ethers.utils.parseUnits("1000", 6);
  let counter = 0;

  before(async function () {
    ctx = await setupAuditFixture();
  });

  /** A fresh binary condition resolved by the owner (its oracle), split by `holder` for AMOUNT. */
  async function splitCondition(holder) {
    const { owner } = ctx.signers;
    const questionId = ethers.utils.formatBytes32String(`ctf-fee-${counter++}`);
    await ctx.contracts.conditionMgr.connect(owner).createCondition(owner.address, questionId, 2, "ipfs://fee");
    const conditionId = getConditionId(owner.address, questionId, 2);
    await ctx.contracts.conditionalTokens
      .connect(holder)
      .splitPosition(ctx.contracts.collateral.address, ROOT, conditionId, [1, 2], AMOUNT);
    return { questionId, conditionId };
  }

  async function setFee(bps) {
    const { adminConfig } = ctx.contracts;
    const [, current] = await adminConfig.getFees();
    if (current !== bps) await adminConfig.connect(ctx.signers.owner).setResolutionFeeBps(bps);
  }

  async function resolveYes(questionId) {
    await ctx.contracts.conditionalTokens.connect(ctx.signers.owner).reportPayouts(questionId, [1, 0]);
  }

  async function accrued() {
    return ctx.contracts.adminConfig.getAccruedFees(ctx.contracts.collateral.address);
  }

  describe("CTF-007 — cap and snapshot", function () {
    it("setResolutionFeeBps above 500 bps reverts FeeTooHigh; 500 is accepted [pre-fix: up to 10000 accepted]", async function () {
      const { adminConfig } = ctx.contracts;
      await expect(adminConfig.connect(ctx.signers.owner).setResolutionFeeBps(501)).to.be.revertedWith("FeeTooHigh()");
      await expect(adminConfig.connect(ctx.signers.owner).setResolutionFeeBps(10_000)).to.be.revertedWith("FeeTooHigh()");
      await setFee(500);
      expect((await adminConfig.getFees())[1]).to.equal(500);
    });

    it("raising the fee after resolution does not change that condition's redemption [pre-fix: the new rate applied]", async function () {
      const { buyer } = ctx.signers;
      const { collateral, conditionalTokens } = ctx.contracts;
      await setFee(100); // 1% when the condition resolves
      const { questionId, conditionId } = await splitCondition(buyer);
      await resolveYes(questionId);
      await setFee(500); // raised afterwards

      const before = await collateral.balanceOf(buyer.address);
      const feesBefore = await accrued();
      await conditionalTokens.connect(buyer).redeemPositions(collateral.address, ROOT, conditionId, [1, 2]);
      const fee = AMOUNT.mul(100).div(10_000);
      expect((await collateral.balanceOf(buyer.address)).sub(before)).to.equal(AMOUNT.sub(fee));
      expect((await accrued()).sub(feesBefore)).to.equal(fee);
    });

    it("a condition resolved before the cut (no snapshot) is charged 0, even after the fee is raised [pre-fix and 22c741a..: the live rate]", async function () {
      const { owner, buyer } = ctx.signers;
      const { collateral, conditionalTokens } = ctx.contracts;
      const facet = await (await ethers.getContractFactory("LegacyStateWriterFacet")).deploy();
      const selector = facet.interface.getSighash("clearResolutionFeeSnapshot(bytes32)");
      await (await ethers.getContractAt("IDiamondCut", ctx.diamondAddress))
        .connect(owner)
        .diamondCut([{ facetAddress: facet.address, action: 0 /* Add */, functionSelectors: [selector] }], ethers.constants.AddressZero, "0x");
      const legacy = await ethers.getContractAt("LegacyStateWriterFacet", ctx.diamondAddress);

      await setFee(0);
      const { questionId, conditionId } = await splitCondition(buyer);
      await resolveYes(questionId);
      await legacy.clearResolutionFeeSnapshot(conditionId); // as every pre-cut resolution is
      await setFee(500); // raised after the cut

      const before = await collateral.balanceOf(buyer.address);
      const feesBefore = await accrued();
      await conditionalTokens.connect(buyer).redeemPositions(collateral.address, ROOT, conditionId, [1, 2]);
      expect((await collateral.balanceOf(buyer.address)).sub(before)).to.equal(AMOUNT);
      expect(await accrued()).to.equal(feesBefore);
    });

    it("lowering the fee after resolution does not change it either (the snapshot is the rate at resolution)", async function () {
      const { buyer } = ctx.signers;
      const { collateral, conditionalTokens } = ctx.contracts;
      await setFee(300);
      const { questionId, conditionId } = await splitCondition(buyer);
      await resolveYes(questionId);
      await setFee(0);

      const before = await collateral.balanceOf(buyer.address);
      await conditionalTokens.connect(buyer).redeemPositions(collateral.address, ROOT, conditionId, [1, 2]);
      expect((await collateral.balanceOf(buyer.address)).sub(before)).to.equal(AMOUNT.sub(AMOUNT.mul(300).div(10_000)));
    });
  });

  describe("CTF-004 — a full-set merge after resolution pays the resolution fee", function () {
    it("merging a full set after resolution charges the snapshotted fee and books it as FEE_KIND_RESOLUTION [pre-fix: no fee]", async function () {
      const { seller } = ctx.signers;
      const { collateral, conditionalTokens } = ctx.contracts;
      await setFee(200);
      const { questionId, conditionId } = await splitCondition(seller);
      await resolveYes(questionId);

      const fee = AMOUNT.mul(200).div(10_000);
      const before = await collateral.balanceOf(seller.address);
      const feesBefore = await accrued();
      await expect(conditionalTokens.connect(seller).mergePositions(collateral.address, ROOT, conditionId, [1, 2], AMOUNT))
        .to.emit(conditionalTokens, "FeeAccrued")
        .withArgs(collateral.address, fee, FEE_KIND_RESOLUTION);
      expect((await collateral.balanceOf(seller.address)).sub(before)).to.equal(AMOUNT.sub(fee));
      expect((await accrued()).sub(feesBefore)).to.equal(fee);
    });

    it("merge then redeem cost the same: the winner's exit price no longer depends on the route", async function () {
      const { buyer, seller } = ctx.signers;
      const { collateral, conditionalTokens } = ctx.contracts;
      await setFee(250);
      const a = await splitCondition(buyer);
      const b = await splitCondition(seller);
      await resolveYes(a.questionId);
      await resolveYes(b.questionId);

      const buyerBefore = await collateral.balanceOf(buyer.address);
      await conditionalTokens.connect(buyer).redeemPositions(collateral.address, ROOT, a.conditionId, [1, 2]);
      const viaRedeem = (await collateral.balanceOf(buyer.address)).sub(buyerBefore);

      const sellerBefore = await collateral.balanceOf(seller.address);
      await conditionalTokens.connect(seller).mergePositions(collateral.address, ROOT, b.conditionId, [1, 2], AMOUNT);
      const viaMerge = (await collateral.balanceOf(seller.address)).sub(sellerBefore);

      expect(viaMerge).to.equal(viaRedeem);
    });

    it("CONTROL — before resolution a merge is fee-free (a refund of the complete set)", async function () {
      const { seller } = ctx.signers;
      const { collateral, conditionalTokens } = ctx.contracts;
      await setFee(500);
      const { conditionId } = await splitCondition(seller);

      const before = await collateral.balanceOf(seller.address);
      await conditionalTokens.connect(seller).mergePositions(collateral.address, ROOT, conditionId, [1, 2], AMOUNT);
      expect((await collateral.balanceOf(seller.address)).sub(before)).to.equal(AMOUNT);
    });

    it("CONTROL — with a zero fee at resolution a post-resolution merge books nothing and emits no FeeAccrued", async function () {
      const { seller } = ctx.signers;
      const { collateral, conditionalTokens } = ctx.contracts;
      await setFee(0);
      const { questionId, conditionId } = await splitCondition(seller);
      await resolveYes(questionId);

      const feesBefore = await accrued();
      await expect(conditionalTokens.connect(seller).mergePositions(collateral.address, ROOT, conditionId, [1, 2], AMOUNT))
        .to.not.emit(conditionalTokens, "FeeAccrued");
      expect(await accrued()).to.equal(feesBefore);
    });
  });
});
