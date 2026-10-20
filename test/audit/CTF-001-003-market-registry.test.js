// AUDIT · CTF-001 (CRITICAL), CTF-002 (HIGH), CTF-003 (MEDIUM) — settlement-market registry
// ----------------------------------------------------------------------------
// Finding detail: audit/findings/ctf-review.md.
//
// Settlement treats a registered market as the complete set of a condition's outcomes in its
// root collection and the order's collateral. Before the fix the registry was written by the
// FIRST split of any (condition, parent, collateral) — any partition, any order, any parent,
// any amount including 0 — and settlement trusted it; complementary trades of unregistered
// positions skipped the registry (and the cancelled / resolved gate) altogether.
//
// FIX (SCRUM-214):
//   - LibCTFCondition._splitPosition registers only a canonical root split: no parent, full
//     partition, ascending singletons [1, 2, 4, …]. Other splits stay ordinary CTF operations.
//   - SettlementFacet._validateOrder requires a registered root-market position in the order's
//     collateral; _conditionAndPartition requires the two index sets to cover every outcome.
//
// Each test below asserts the guarded behaviour; on the pre-fix contracts the tests marked
// [pre-fix: …] fail as noted (run recorded in the fix commit).

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupAuditFixture } = require("../utils/auditFixture.js");
const { getConditionId, getCollectionId, getPositionId } = require("../utils/ctfUtils.js");

const ROOT = ethers.constants.HashZero;

describe("AUDIT · CTF-001 / CTF-002 / CTF-003 — the settlement-market registry", function () {
  let ctx;
  let marketData;
  const ONE = ethers.utils.parseUnits("1", 6);

  before(async function () {
    ctx = await setupAuditFixture();
    marketData = await ethers.getContractAt("MarketDataFacet", ctx.diamondAddress);
  });

  async function newCondition(label, slots) {
    const { owner } = ctx.signers;
    const questionId = ethers.utils.formatBytes32String(label);
    await ctx.contracts.conditionMgr.connect(owner).createCondition(owner.address, questionId, slots, `ipfs://${label}`);
    return getConditionId(owner.address, questionId, slots);
  }

  async function position(conditionId, indexSet, parent = ROOT, collateral = ctx.contracts.collateral.address) {
    return getPositionId(collateral, await getCollectionId(parent, conditionId, indexSet, ethers.provider));
  }

  async function split(signer, conditionId, partition, amount, parent = ROOT) {
    return ctx.contracts.conditionalTokens
      .connect(signer)
      .splitPosition(ctx.contracts.collateral.address, parent, conditionId, partition, amount);
  }

  async function matchPair(takerOrder, takerSigner, makerOrder, makerSigner, fill) {
    const { settlement } = ctx.contracts;
    const { signOrder } = ctx.helpers;
    return settlement.connect(ctx.signers.operator).matchOrders(
      takerOrder, await signOrder(takerSigner, takerOrder), 0,
      [makerOrder], [await signOrder(makerSigner, makerOrder)], [0],
      fill, [fill], [0], [0],
    );
  }

  describe("CTF-001 / CTF-002 — only a canonical root split registers a market", function () {
    it("a partial split of a 3-outcome condition registers nothing [pre-fix: registered a 2-position 'binary' market]", async function () {
      const c = await newCondition("ctf-3-partial", 3);
      await split(ctx.signers.attacker, c, [1, 2], 0);
      expect(await marketData.getMarketsByCondition(c)).to.have.lengthOf(0);
      await expect(marketData.getConditionId(await position(c, 1))).to.be.revertedWith("InvalidPositionId()"); // not registered
    });

    it("a reordered split [2, 1] registers nothing, and the canonical seed then registers in outcome order [pre-fix: the seed reverted InvalidMatch]", async function () {
      const c = await newCondition("ctf-reordered", 2);
      await split(ctx.signers.attacker, c, [2, 1], 0);
      expect(await marketData.getMarketsByCondition(c)).to.have.lengthOf(0);

      await split(ctx.signers.owner, c, [1, 2], ONE);
      const [market] = await marketData.getMarketsByCondition(c);
      expect(market.partitions.map(Number)).to.deep.equal([1, 2]);
      expect(market.positionIds.map((p) => p.toString())).to.deep.equal([(await position(c, 1)).toString(), (await position(c, 2)).toString()]);
    });

    it("a nested split (non-zero parent collection) registers nothing [pre-fix: registered a nested market]", async function () {
      const c = await newCondition("ctf-nested", 2);
      const { conditionId: d } = ctx.market; // the fixture's seeded binary market
      const parent = await getCollectionId(ROOT, d, 1, ethers.provider);
      await split(ctx.signers.owner, d, [1, 2], ONE.mul(5)); // root tokens of d for the owner
      await split(ctx.signers.owner, c, [1, 2], ONE, parent);
      expect(await marketData.getMarketsByCondition(c)).to.have.lengthOf(0);
      await expect(marketData.getConditionId(await position(c, 1, parent))).to.be.revertedWith("InvalidPositionId()"); // not registered
    });

    it("the canonical [1, 2, 4] split of a 3-outcome condition registers all three outcomes", async function () {
      const c = await newCondition("ctf-3-canonical", 3);
      await split(ctx.signers.owner, c, [1, 2, 4], ONE);
      const [market] = await marketData.getMarketsByCondition(c);
      expect(market.partitions.map(Number)).to.deep.equal([1, 2, 4]);
      expect(market.parentCollectionId).to.equal(ROOT);
    });

    it("settlement never treats two outcomes of a 3-outcome market as a complete pair: a Merge reverts InvalidMatch (routing: a 3-entry market is not a binary pair; also true before the fix)", async function () {
      const c = await newCondition("ctf-3-merge", 3);
      const { owner, seller } = ctx.signers;
      await split(owner, c, [1, 2, 4], ONE.mul(10));
      const pos1 = await position(c, 1);
      const pos2 = await position(c, 2);
      await ctx.contracts.erc1155Facet.connect(owner).safeTransferFrom(owner.address, seller.address, pos2, ONE.mul(10), "0x");

      const { makeOrder } = ctx.helpers;
      const takerOrder = makeOrder(owner.address, pos1, 1, ONE, ONE.div(2), { salt: 71001 });
      const makerOrder = makeOrder(seller.address, pos2, 1, ONE, ONE.div(2), { salt: 71002 });
      await expect(matchPair(takerOrder, owner, makerOrder, seller, ONE)).to.be.revertedWith("InvalidMatch()");
    });
  });

  describe("CTF-001 — settlement guard (defence in depth): a legacy 2-entry market that does not cover every outcome", function () {
    // Since the fix no split can register such a market, so the entry is written directly, as a
    // pre-fix 0-amount partial split left it. The 3-outcome Merge test above reverts earlier, in
    // _determineMatchType (a 3-entry market is never a binary pair); only this test reaches
    // SettlementFacet._conditionAndPartition's partition check.
    let writer;

    before(async function () {
      const facet = await (await ethers.getContractFactory("LegacyStateWriterFacet")).deploy();
      const selector = facet.interface.getSighash("registerLegacyMarket(uint256[],uint256[],bytes32,bytes32,address)");
      await (await ethers.getContractAt("IDiamondCut", ctx.diamondAddress))
        .connect(ctx.signers.owner)
        .diamondCut([{ facetAddress: facet.address, action: 0 /* Add */, functionSelectors: [selector] }], ethers.constants.AddressZero, "0x");
      writer = await ethers.getContractAt("LegacyStateWriterFacet", ctx.diamondAddress);
    });

    it("Merge and Mint on a partial [1, 2] market of a 3-outcome condition revert InvalidMatch; the Diamond's collateral is untouched [pre-fix: the Merge paid full collateral and minted the union to the Diamond]", async function () {
      const { owner, seller, buyer, buyerB } = ctx.signers;
      const { collateral, erc1155Facet } = ctx.contracts;
      const { makeOrder } = ctx.helpers;
      const c = await newCondition("ctf-legacy-partial", 3);
      const pos1 = await position(c, 1);
      const pos2 = await position(c, 2);
      await writer.registerLegacyMarket([pos1, pos2], [1, 2], c, ROOT, collateral.address);
      expect(await marketData.getComplement(pos1)).to.equal(pos2); // routing treats them as a binary pair

      // pos1 / pos2 without a canonical split: grouped [3, 4], then the partial [1, 2] (neither registers).
      await split(owner, c, [3, 4], ONE.mul(10));
      await split(owner, c, [1, 2], ONE.mul(10));
      await erc1155Facet.connect(owner).safeTransferFrom(owner.address, seller.address, pos2, ONE.mul(10), "0x");

      const diamondCollateral = await collateral.balanceOf(ctx.diamondAddress);
      await expect(
        matchPair(
          makeOrder(owner.address, pos1, 1, ONE, ONE.div(2), { salt: 71101 }), owner,
          makeOrder(seller.address, pos2, 1, ONE, ONE.div(2), { salt: 71102 }), seller, ONE,
        ),
      ).to.be.revertedWith("InvalidMatch()"); // Merge
      await expect(
        matchPair(
          makeOrder(buyer.address, pos1, 0, ONE, ONE.div(2), { salt: 71103 }), buyer,
          makeOrder(buyerB.address, pos2, 0, ONE, ONE.div(2), { salt: 71104 }), buyerB, ONE,
        ),
      ).to.be.revertedWith("InvalidMatch()"); // Mint
      expect(await collateral.balanceOf(ctx.diamondAddress)).to.equal(diamondCollateral);
    });
  });

  describe("CTF-003 — settlement only trades registered root-market positions in their own collateral", function () {
    it("an order whose collateral differs from its position's market collateral reverts InvalidMatch [pre-fix: settled]", async function () {
      const { buyer, seller } = ctx.signers;
      const { positionIdA } = ctx.market;
      const { makeOrder, addCollateralToken } = ctx.helpers;
      const other = await addCollateralToken("Other", "OTH", 6, ONE);

      // Both orders name the same (other) collateral, so SEC-001's token-match check passes;
      // the position belongs to the fixture's USDC market.
      const takerOrder = makeOrder(buyer.address, positionIdA, 0, ONE, ONE.div(2), { salt: 72001, collateralToken: other.address });
      const makerOrder = makeOrder(seller.address, positionIdA, 1, ONE, ONE.div(2), { salt: 72002, collateralToken: other.address });
      await expect(matchPair(takerOrder, buyer, makerOrder, seller, ONE)).to.be.revertedWith("InvalidMatch()");
    });

    it("an order on an unregistered (nested) position reverts InvalidMatch [pre-fix: a complementary trade settled with no condition gate]", async function () {
      const { owner, buyer } = ctx.signers;
      const { conditionId: d } = ctx.market;
      const c = await newCondition("ctf-unregistered", 2);
      const parent = await getCollectionId(ROOT, d, 1, ethers.provider);
      await split(owner, d, [1, 2], ONE.mul(5));
      await split(owner, c, [1, 2], ONE.mul(5), parent);
      const nested = await position(c, 1, parent);
      await expect(marketData.getConditionId(nested)).to.be.revertedWith("InvalidPositionId()"); // not registered

      const { makeOrder } = ctx.helpers;
      const takerOrder = makeOrder(buyer.address, nested, 0, ONE, ONE.div(2), { salt: 73001 });
      const makerOrder = makeOrder(owner.address, nested, 1, ONE, ONE.div(2), { salt: 73002 });
      await expect(matchPair(takerOrder, buyer, makerOrder, owner, ONE)).to.be.revertedWith("InvalidMatch()");
    });

    it("CONTROL — the canonical binary market still settles Complementary, Mint and Merge", async function () {
      const { buyer, buyerB, seller } = ctx.signers;
      const { positionIdA, positionIdB } = ctx.market;
      const { makeOrder } = ctx.helpers;

      await matchPair(
        makeOrder(buyer.address, positionIdA, 0, ONE, ONE.div(2), { salt: 74001 }), buyer,
        makeOrder(seller.address, positionIdA, 1, ONE, ONE.div(2), { salt: 74002 }), seller, ONE,
      ); // complementary
      await matchPair(
        makeOrder(buyer.address, positionIdA, 0, ONE, ONE.div(2), { salt: 74003 }), buyer,
        makeOrder(buyerB.address, positionIdB, 0, ONE, ONE.div(2), { salt: 74004 }), buyerB, ONE,
      ); // mint
      await matchPair(
        makeOrder(seller.address, positionIdA, 1, ONE, ONE.div(2), { salt: 74005 }), seller,
        makeOrder(buyerB.address, positionIdB, 1, ONE, ONE.div(2), { salt: 74006 }), buyerB, ONE,
      ); // merge
    });
  });
});
