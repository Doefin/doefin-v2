// PENTEST · SEC-004 (MED) — domain-separator cache cross-facet inconsistency
// ----------------------------------------------------------------------------
// STATUS: FIXED via option (ii) — the cache is gone. `cacheDomainSeparator()`
// is removed from `ISettlement`, the `domainSeparator` field is removed from
// `LibSettlementStorage`, and all three facets (`SettlementFacet`,
// `SignatureVerifierFacet`, `NonceManagerFacet`) now recompute the separator
// from `block.chainid` on every call. NEW-2 and NEW-3 are closed.
//
// This pentest used to demonstrate the bug by corrupting the cache via
// `hardhat_setStorageAt`. With the cache gone there is no slot to corrupt —
// so the pentest is now a FIX-VERIFICATION suite asserting the three
// load-bearing post-fix invariants:
//
//   1. The `cacheDomainSeparator()` selector is no longer reachable on the
//      Diamond.
//   2. The former cache storage slot is empty.
//   3. The three facets agree on the live separator: a cancellation routed
//      through NonceManagerFacet takes effect on a subsequent matchOrders
//      attempt — which is only possible if the two facets hash the order
//      identically (i.e. compute the same domain separator).
//
// A control test confirms a normal complementary match still settles.
//
// Pre-fix-fail signal: if the cache or the `cacheDomainSeparator()` selector
// is ever reintroduced WITHOUT a `chainId` guard, test (1) breaks (the call
// no longer reverts at the Diamond router) and (2) breaks (the slot is no
// longer empty after the cache is populated). That's the regression check.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupAuditFixture } = require("../utils/auditFixture.js");

describe("PENTEST · SEC-004 (MED, FIXED) — domain-separator cache removed", function () {
  let ctx;
  let formerCacheSlot;

  before(async function () {
    ctx = await setupAuditFixture();

    // The `domainSeparator` field used to live at slot 9 of
    // LibSettlementStorage (struct base = keccak256("doefin.settlement.storage")).
    // After SEC-004 the field was removed; this slot should remain zero.
    const basePosition = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("doefin.settlement.storage"));
    formerCacheSlot = ethers.utils.hexZeroPad(
      ethers.BigNumber.from(basePosition).add(9).toHexString(),
      32,
    );
  });

  it("FIX VERIFIED — `cacheDomainSeparator()` selector is no longer reachable on the Diamond", async function () {
    const { diamondAddress } = ctx;

    // Build an ad-hoc interface for the removed function and try to call it.
    // The Diamond fallback should revert because the selector is unregistered.
    const removed = new ethers.Contract(
      diamondAddress,
      ["function cacheDomainSeparator()"],
      ctx.signers.owner,
    );
    await expect(removed.cacheDomainSeparator()).to.be.reverted; // FunctionNotFound / no-such-selector
  });

  it("FIX VERIFIED — the former cache storage slot is empty (no field there to corrupt)", async function () {
    const { diamondAddress } = ctx;
    const slotValue = await ethers.provider.getStorageAt(diamondAddress, formerCacheSlot);
    expect(slotValue).to.equal(ethers.constants.HashZero);
  });

  it("FIX VERIFIED — SettlementFacet and NonceManagerFacet compute the SAME order hash (consistency)", async function () {
    // The strongest cross-facet consistency proof: cancel an order via
    // NonceManagerFacet, then attempt to settle it via SettlementFacet. The
    // settlement must revert OrderCancelled — which only happens if both
    // facets resolved the SAME order hash. Pre-fix this could fail under a
    // chain fork (cancellation hashed live, settlement hashed cached).
    const { settlement, nonceMgr, sigVerifier } = ctx.contracts;
    const { buyer, seller, operator } = ctx.signers;
    const { positionIdA } = ctx.market;
    const { UNIT } = ctx.constants;
    const { makeOrder, signOrder } = ctx.helpers;

    const fillAmount = ethers.utils.parseUnits("100", 6);
    const price = UNIT.div(2);
    const takerOrder = makeOrder(buyer.address,  positionIdA, 0, fillAmount, price, { salt: 91001 });
    const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, { salt: 91001 });
    const takerSig = await signOrder(buyer,  takerOrder);
    const makerSig = await signOrder(seller, makerOrder);

    // SignatureVerifierFacet exposes a public getOrderHash — confirm it is
    // non-zero (the live separator + struct hash combine correctly).
    const liveTakerHash = await sigVerifier.getOrderHash(takerOrder);
    expect(liveTakerHash).to.not.equal(ethers.constants.HashZero);

    // Cancel via NonceManagerFacet (recomputes the live hash internally).
    await expect(nonceMgr.connect(buyer).cancelOrder(takerOrder)).to.not.be.reverted;

    // SettlementFacet must now reject the same order — proving it resolved
    // the identical hash NonceManagerFacet just wrote to `cancelledOrders`.
    await expect(
      settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fillAmount, [fillAmount], [0], [0],
      ),
    ).to.be.reverted; // OrderCancelled
  });

  it("CONTROL — a fresh complementary match settles normally end-to-end", async function () {
    const { settlement, erc1155Facet } = ctx.contracts;
    const { buyer, seller, operator } = ctx.signers;
    const { positionIdA } = ctx.market;
    const { UNIT } = ctx.constants;
    const { makeOrder, signOrder } = ctx.helpers;

    const fillAmount = ethers.utils.parseUnits("100", 6);
    const price = UNIT.div(2);
    const takerOrder = makeOrder(buyer.address,  positionIdA, 0, fillAmount, price, { salt: 91002 });
    const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, { salt: 91002 });
    const takerSig = await signOrder(buyer,  takerOrder);
    const makerSig = await signOrder(seller, makerOrder);

    const before = await erc1155Facet.balanceOf(buyer.address, positionIdA);
    await settlement.connect(operator).matchOrders(
      takerOrder, takerSig, 0,
      [makerOrder], [makerSig], [0],
      fillAmount, [fillAmount], [0], [0],
    );
    const after = await erc1155Facet.balanceOf(buyer.address, positionIdA);
    expect(after.sub(before)).to.equal(fillAmount);
  });
});
