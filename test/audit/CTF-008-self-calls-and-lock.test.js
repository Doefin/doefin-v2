// AUDIT · CTF-008 (LOW) — self-call collateral skip, unenforced lock, self-acceptance dependency
// ----------------------------------------------------------------------------
// Finding detail: audit/findings/ctf-review.md. No exploit today; defence in depth and
// upgrade hazards:
//   (a) public split / merge skipped the collateral movement when `sender == address(this)`, so
//       any future facet that makes the Diamond call itself would mint positions for nothing;
//   (b) the internal split / merge variants (used by Mint / Merge settlement) assumed the caller
//       held the reentrancy lock but never checked it;
//   (c) ERC-1155 transfers TO the Diamond called its own onERC1155Received, so settlement
//       silently depended on the ERC1155ReceiverFacet selectors staying routed.
//
// FIX (SCRUM-214): (a) the public paths revert SelfCallNotAllowed for `sender == address(this)`;
// (b) the internal variants require the lock (ReentrancyLockNotHeld); (c) LibERC1155 skips the
// acceptance check for transfers to the Diamond itself.
//
// Tests tagged [pre-fix: …] fail on the pre-fix contracts (run recorded in the fix commit).

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupAuditFixture } = require("../utils/auditFixture.js");
const { getCollectionId, getPositionId } = require("../utils/ctfUtils.js");

const FacetCutAction = { Add: 0, Replace: 1, Remove: 2 };
const ROOT = ethers.constants.HashZero;

function selectorsOf(contract) {
  return Object.keys(contract.interface.functions).map((sig) => contract.interface.getSighash(sig));
}

describe("AUDIT · CTF-008 — self-calls, the internal-variant lock, and self-acceptance", function () {
  const ONE = ethers.utils.parseUnits("1", 6);

  describe("(a) the Diamond cannot call its own public split / merge", function () {
    let ctx;
    let selfCaller;

    before(async function () {
      ctx = await setupAuditFixture();
      const facet = await (await ethers.getContractFactory("SelfCallerFacet")).deploy();
      const cut = await ethers.getContractAt("IDiamondCut", ctx.diamondAddress);
      await cut
        .connect(ctx.signers.owner)
        .diamondCut([{ facetAddress: facet.address, action: FacetCutAction.Add, functionSelectors: selectorsOf(facet) }], ethers.constants.AddressZero, "0x");
      selfCaller = await ethers.getContractAt("SelfCallerFacet", ctx.diamondAddress);
    });

    it("a self-split reverts SelfCallNotAllowed [pre-fix: minted a full set to the Diamond without collateral]", async function () {
      const { collateral } = ctx.contracts;
      const { conditionId } = ctx.market;
      await expect(selfCaller.selfSplit(collateral.address, conditionId, ONE.mul(100))).to.be.revertedWith("SelfCallNotAllowed()");
    });

    it("a self-merge reverts SelfCallNotAllowed", async function () {
      const { collateral } = ctx.contracts;
      const { conditionId } = ctx.market;
      await expect(selfCaller.selfMerge(collateral.address, conditionId, ONE)).to.be.revertedWith("SelfCallNotAllowed()");
    });
  });

  describe("(b) the internal split variant requires the caller to hold the lock", function () {
    let harness;
    let token;
    let conditionId;

    before(async function () {
      token = await (await ethers.getContractFactory("MockERC20")).deploy("Mock USDC", "USDC", 6);
      harness = await (await ethers.getContractFactory("CTFInternalHarness")).deploy();
      const questionId = ethers.utils.id("ctf-008-internal");
      conditionId = await harness.callStatic.setUp(token.address, questionId);
      await harness.setUp(token.address, questionId);
    });

    it("without the lock it reverts ReentrancyLockNotHeld [pre-fix: no lock check]", async function () {
      await expect(harness.splitWithoutLock(token.address, conditionId, ONE)).to.be.revertedWith("ReentrancyLockNotHeld()");
    });

    it("inside the lock it splits, with the contract itself as holder — the settlement shape, which also needs (c) [pre-fix: the mint to the contract reverted]", async function () {
      await harness.splitHoldingLock(token.address, conditionId, ONE);
      const pos1 = getPositionId(token.address, await getCollectionId(ROOT, conditionId, 1, ethers.provider));
      expect(await harness.balanceOf(pos1)).to.equal(ONE);
    });
  });

  describe("(c) settlement no longer depends on the Diamond accepting its own ERC-1155 transfers", function () {
    let ctx;

    before(async function () {
      ctx = await setupAuditFixture();
      const receiver = await ethers.getContractAt("ERC1155ReceiverFacet", ctx.diamondAddress);
      const selectors = [
        receiver.interface.getSighash("onERC1155Received"),
        receiver.interface.getSighash("onERC1155BatchReceived"),
      ];
      const cut = await ethers.getContractAt("IDiamondCut", ctx.diamondAddress);
      await cut
        .connect(ctx.signers.owner)
        .diamondCut([{ facetAddress: ethers.constants.AddressZero, action: FacetCutAction.Remove, functionSelectors: selectors }], ethers.constants.AddressZero, "0x");
    });

    async function match(takerOrder, takerSigner, makerOrder, makerSigner, fill) {
      const { signOrder } = ctx.helpers;
      return ctx.contracts.settlement.connect(ctx.signers.operator).matchOrders(
        takerOrder, await signOrder(takerSigner, takerOrder), 0,
        [makerOrder], [await signOrder(makerSigner, makerOrder)], [0],
        fill, [fill], [0], [0],
      );
    }

    it("Mint settles with the receiver selectors removed [pre-fix: the mint to the Diamond reverted]", async function () {
      const { buyer, buyerB } = ctx.signers;
      const { positionIdA, positionIdB } = ctx.market;
      const { makeOrder } = ctx.helpers;
      await match(
        makeOrder(buyer.address, positionIdA, 0, ONE, ONE.div(2), { salt: 81001 }), buyer,
        makeOrder(buyerB.address, positionIdB, 0, ONE, ONE.div(2), { salt: 81002 }), buyerB, ONE,
      );
      expect(await ctx.contracts.erc1155Facet.balanceOf(buyer.address, positionIdA)).to.be.gte(ONE);
    });

    it("Merge settles with the receiver selectors removed [pre-fix: the transfer to the Diamond reverted]", async function () {
      const { seller, buyerB } = ctx.signers;
      const { positionIdA, positionIdB } = ctx.market;
      const { makeOrder } = ctx.helpers;
      await match(
        makeOrder(seller.address, positionIdA, 1, ONE, ONE.div(2), { salt: 81003 }), seller,
        makeOrder(buyerB.address, positionIdB, 1, ONE, ONE.div(2), { salt: 81004 }), buyerB, ONE,
      );
      expect(await ctx.contracts.erc1155Facet.balanceOf(ctx.diamondAddress, positionIdA)).to.equal(0);
    });
  });
});
