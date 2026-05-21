// PENTEST · SEC-001 (HIGH) — settlement-path collateral-token mismatch
// ----------------------------------------------------------------------------
// Attack scenario
//
//   The compromised operator pairs two orders that were each signed against a
//   DIFFERENT collateral token:
//     - maker signs a SELL on positionA in token A (USDC, unit=1e6)
//     - taker signs a BUY  on positionA in token B (DAI,  unit=1e18)
//
//   `_determineMatchType` keys only on `(positionId, side)`, so it routes the
//   pair to `_settleComplementary`. Mint and Merge both check
//   `taker.collateralToken == maker.collateralToken` as their first statement;
//   `_settleComplementary` did NOT. The path read `unit = unitPerPair[taker
//   .collateralToken]` and executed every ERC-20 transfer with the TAKER's
//   token — the maker's signed `collateralToken` was never read.
//
// Pre-fix economic impact
//
//   `collateralAmount = (maker.price * fill) / unit_TOKEN_B`. The maker signed
//   a 0.5e6-per-unit price in USDC; the path multiplies that by `fill` and
//   divides by 1e18 (token B's unit). The integer division collapses the
//   number to ~zero. The seller surrenders `fill` position tokens, the buyer
//   pays a near-zero amount of token B, and the maker's signed asset (token A)
//   moves nowhere — the buyer gets the position effectively for free.
//
// Fix
//
//   `SettlementFacet._settleComplementary`'s first statement is now:
//       if (taker.collateralToken != maker.collateralToken) revert InvalidMatch();
//   matching the identical guard already present at the top of `_settleMint`
//   and `_settleMerge`.
//
// Verifying the bug exists pre-fix
//
//   To watch this pentest fail against unfixed code, comment out that one
//   guard line in `contracts/facets/SettlementFacet.sol` (search for
//   `SEC-001`) and re-run. The "attack blocked" `it` will fail with no
//   revert because the exploit succeeds.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupAuditFixture } = require("../utils/auditFixture.js");

describe("PENTEST · SEC-001 (HIGH) — settlement-path token mismatch", function () {
  let ctx;
  let altCollateral; // a second allow-listed token used to construct the cross-token attack

  before(async function () {
    ctx = await setupAuditFixture();

    // Allow-list a second collateral token so that both orders pass
    // `_validateOrder` (the SEC-002 gate now requires an allow-listed,
    // non-zero-unit token). That isolates the bug to `_settleComplementary`
    // itself — without this, SEC-002 would already block the call.
    //
    // Same decimals/unit as the primary collateral, so `_validateOrder`'s
    // `price <= unit` check is satisfied for both legs.
    altCollateral = await ctx.helpers.addCollateralToken(
      "Mock USDT",
      "USDT",
      6,
      ctx.constants.UNIT,
    );
  });

  it("ATTACK BLOCKED — cross-token complementary match reverts InvalidMatch", async function () {
    const { settlement, collateral } = ctx.contracts;
    const { buyer, seller, operator } = ctx.signers;
    const { positionIdA } = ctx.market;
    const { UNIT } = ctx.constants;
    const { makeOrder, signOrder } = ctx.helpers;

    const fillAmount = ethers.utils.parseUnits("100", 6);
    const price = UNIT.div(2); // 0.5 per token

    // --- Construct the attack payload ---
    // The maker (seller) signs a SELL on positionA in the PRIMARY collateral.
    const makerOrder = makeOrder(seller.address, positionIdA, 1 /* SELL */, fillAmount, price, {
      salt: 70001,
      collateralToken: collateral.address, // signed for the primary token
    });
    const makerSig = await signOrder(seller, makerOrder);

    // The taker (buyer) signs a BUY on positionA in the ALT collateral.
    const takerOrder = makeOrder(buyer.address, positionIdA, 0 /* BUY */, fillAmount, price, {
      salt: 70001,
      collateralToken: altCollateral.address, // signed for the alt token
    });
    const takerSig = await signOrder(buyer, takerOrder);

    // Each order's signature is individually valid (it covers its own
    // `collateralToken` field). The vulnerability is that the SETTLEMENT path
    // never compares the two orders' tokens. Both pass `_validateOrder`
    // because each order's collateral token is allow-listed in isolation.
    //
    // The compromised operator submits the cross-token pair.

    await expect(
      settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fillAmount, [fillAmount], [0], [0],
      ),
    ).to.be.revertedWith("InvalidMatch()");
  });

  it("CONTROL — when both orders use the same collateral token, settlement succeeds", async function () {
    // Same harness, but the taker now signs in the alt token too. This proves
    // the SEC-001 guard rejects ONLY genuine mismatches, not all complementary
    // matches that touch the alt token.
    const { settlement, erc1155Facet } = ctx.contracts;
    const { buyer, seller, operator } = ctx.signers;
    const { positionIdA } = ctx.market;
    const { UNIT } = ctx.constants;
    const { makeOrder, signOrder } = ctx.helpers;

    const fillAmount = ethers.utils.parseUnits("100", 6);
    const price = UNIT.div(2);

    const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, {
      salt: 70002,
      collateralToken: altCollateral.address,
    });
    const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, {
      salt: 70002,
      collateralToken: altCollateral.address,
    });

    const makerSig = await signOrder(seller, makerOrder);
    const takerSig = await signOrder(buyer, takerOrder);

    const buyerPosBefore = await erc1155Facet.balanceOf(buyer.address, positionIdA);

    await settlement.connect(operator).matchOrders(
      takerOrder, takerSig, 0,
      [makerOrder], [makerSig], [0],
      fillAmount, [fillAmount], [0], [0],
    );

    const buyerPosAfter = await erc1155Facet.balanceOf(buyer.address, positionIdA);
    expect(buyerPosAfter.sub(buyerPosBefore)).to.equal(fillAmount);
  });

  it("CONTROL — mint and merge already had the token-match guard", async function () {
    // Sanity reference: the guard added to `_settleComplementary` exists
    // verbatim in `_settleMint` (line ~499) and `_settleMerge` (~567) at the
    // pinned audit commit. Crossing those with mismatched tokens already
    // reverted `InvalidMatch` before this fix. We document that here by
    // attempting a Mint cross-token pair and asserting the same revert.
    const { settlement, collateral } = ctx.contracts;
    const { buyer, buyerB, operator } = ctx.signers;
    const { positionIdA, positionIdB } = ctx.market;
    const { UNIT } = ctx.constants;
    const { makeOrder, signOrder } = ctx.helpers;

    const fillAmount = ethers.utils.parseUnits("100", 6);
    const price = UNIT.div(2);

    // Two BUYs on complementary positions = Mint path.
    const buyAOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, {
      salt: 70003,
      collateralToken: collateral.address,
    });
    const buyBOrder = makeOrder(buyerB.address, positionIdB, 0, fillAmount, price, {
      salt: 70003,
      collateralToken: altCollateral.address,
    });

    const sigA = await signOrder(buyer, buyAOrder);
    const sigB = await signOrder(buyerB, buyBOrder);

    await expect(
      settlement.connect(operator).matchOrders(
        buyAOrder, sigA, 0,
        [buyBOrder], [sigB], [0],
        fillAmount, [fillAmount], [0], [0],
      ),
    ).to.be.revertedWith("InvalidMatch()");
  });
});
