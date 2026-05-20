// PENTEST · SEC-002 (HIGH) — no collateral-allowlist / non-zero-unit gate on
// the settlement hot path
// ----------------------------------------------------------------------------
// Attack scenarios
//
//   1. Never-allow-listed token. A token is deployed but never passed to
//      `AdminConfigFacet.addCollateralToken` — `isAllowed[token] == false`
//      and `unitPerPair[token] == 0`. A compromised operator submits a
//      `matchOrders` or `fillOrder` against an order signed for that token.
//
//   2. Removed token. A token was allow-listed but later removed via
//      `removeCollateralToken`, which sets `isAllowed=false` AND
//      `delete unitPerPair`. Pre-fix the settlement path read `unitPerPair=0`
//      and divided by it (`collateralAmount = price * fill / 0`) — a panic
//      revert (safe-fail, but the wrong error and a DoS surface).
//
//   For the more dangerous mis-config case — an allow-listed token with an
//   admin-mis-set non-zero unit (e.g. `unit=1` when 1e6 was intended) — the
//   protection comes from BIZ-004's `pricePerToken > unit` check; that pentest
//   lives in BIZ-004's file. SEC-002 specifically covers the allow-list gate.
//
// Pre-fix behaviour
//
//   `_validateOrder` checked only cancelled / nonce / salt / expiration —
//   never the allow-list. A zero-fee order's `_computeFee` early-returned
//   before its own `price > unit` guard, so the path proceeded into
//   `_settleX` / `_executeOperatorFill` with `unit = 0`, producing either a
//   div-by-zero panic (DoS) or — given a mis-configured non-zero unit —
//   silent mispricing.
//
// Fix
//
//   `SettlementFacet._validateOrder` now reads
//   `LibDoefinStorage.appStorage().adminConfigStorage` and reverts:
//     - `TokenNotAllowed`        if `!isAllowed[collateralToken]`
//     - `InvalidUnitPerPair`     if `unitPerPair[collateralToken] == 0`
//   The gate fires for the TAKER and every MAKER in `matchOrders`, and for
//   the order in `fillOrder` — one central enforcement point.
//
// Verifying the bug exists pre-fix
//
//   To watch this pentest fail against unfixed code, comment out the
//   `cfg.isAllowed` and `unit == 0` checks in `_validateOrder` (search
//   `SEC-002` in `contracts/facets/SettlementFacet.sol`) and re-run. The
//   ATTACK BLOCKED tests will fail with a different revert (a panic from
//   the div-by-zero rather than the expected `TokenNotAllowed`).

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupAuditFixture } = require("../utils/auditFixture.js");

describe("PENTEST · SEC-002 (HIGH) — collateral allow-list gate on settlement", function () {
  let ctx;

  before(async function () {
    ctx = await setupAuditFixture();
  });

  // --- Attack scenario 1: never-allow-listed token --------------------------

  it("ATTACK BLOCKED — matchOrders against a never-allow-listed token reverts TokenNotAllowed", async function () {
    const { settlement } = ctx.contracts;
    const { buyer, seller, operator } = ctx.signers;
    const { positionIdA } = ctx.market;
    const { UNIT } = ctx.constants;
    const { makeOrder, signOrder } = ctx.helpers;

    // Deploy a token but DO NOT allow-list it.
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const rogue = await MockERC20.deploy("Rogue", "RGE", 6);
    await rogue.deployed();
    const fillAmount = ethers.utils.parseUnits("100", 6);
    await rogue.mint(buyer.address, fillAmount.mul(10));
    await rogue.mint(seller.address, fillAmount.mul(10));
    await rogue.connect(buyer).approve(settlement.address, ethers.constants.MaxUint256);
    await rogue.connect(seller).approve(settlement.address, ethers.constants.MaxUint256);

    const price = UNIT.div(2);
    const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, {
      salt: 80001, collateralToken: rogue.address,
    });
    const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, {
      salt: 80001, collateralToken: rogue.address,
    });

    const takerSig = await signOrder(buyer, takerOrder);
    const makerSig = await signOrder(seller, makerOrder);

    // Both signatures are individually valid. Pre-fix, the path proceeded
    // into `_settleComplementary` which read `unit = unitPerPair[rogue] = 0`
    // and panicked on the division. Post-fix, `_validateOrder` rejects the
    // taker before any maker is even examined.
    await expect(
      settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fillAmount, [fillAmount],
      ),
    ).to.be.revertedWith("TokenNotAllowed()");
  });

  it("ATTACK BLOCKED — fillOrder against a never-allow-listed token reverts TokenNotAllowed", async function () {
    const { settlement } = ctx.contracts;
    const { buyer, operator } = ctx.signers;
    const { positionIdA } = ctx.market;
    const { UNIT } = ctx.constants;
    const { makeOrder, signOrder } = ctx.helpers;

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const rogue = await MockERC20.deploy("Rogue2", "RG2", 6);
    await rogue.deployed();
    const fillAmount = ethers.utils.parseUnits("100", 6);
    await rogue.mint(buyer.address, fillAmount.mul(10));
    await rogue.connect(buyer).approve(settlement.address, ethers.constants.MaxUint256);

    const order = makeOrder(buyer.address, positionIdA, 0, fillAmount, UNIT.div(2), {
      salt: 80002, collateralToken: rogue.address,
    });
    const sig = await signOrder(buyer, order);

    await expect(
      settlement.connect(operator).fillOrder(order, sig, 0, fillAmount),
    ).to.be.revertedWith("TokenNotAllowed()");
  });

  // --- Attack scenario 2: removed token -------------------------------------

  it("ATTACK BLOCKED — a token removed AFTER orders were signed cannot settle", async function () {
    // This is the realistic operational version of attack 1: a token WAS
    // allow-listed, makers signed valid orders against it, then admin
    // removed it (e.g. due to a discovered issue with that token contract).
    // Pre-fix, those signed orders could still be settled — the removal
    // didn't propagate to the settlement path. Post-fix, every settlement
    // attempt against the removed token reverts cleanly.
    const { settlement, adminConfig } = ctx.contracts;
    const { buyer, seller, operator } = ctx.signers;
    const { positionIdA } = ctx.market;
    const { UNIT } = ctx.constants;
    const { makeOrder, signOrder } = ctx.helpers;

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const removable = await MockERC20.deploy("Removable", "RMV", 6);
    await removable.deployed();
    const fillAmount = ethers.utils.parseUnits("100", 6);
    await removable.mint(buyer.address, fillAmount.mul(10));
    await removable.mint(seller.address, fillAmount.mul(10));
    await removable.connect(buyer).approve(settlement.address, ethers.constants.MaxUint256);
    await removable.connect(seller).approve(settlement.address, ethers.constants.MaxUint256);

    // Allow-list the token, then remove it.
    await adminConfig.addCollateralToken(removable.address, UNIT);
    await adminConfig.removeCollateralToken(removable.address);

    const price = UNIT.div(2);
    const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, {
      salt: 80003, collateralToken: removable.address,
    });
    const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, {
      salt: 80003, collateralToken: removable.address,
    });
    const takerSig = await signOrder(buyer, takerOrder);
    const makerSig = await signOrder(seller, makerOrder);

    await expect(
      settlement.connect(operator).matchOrders(
        takerOrder, takerSig, 0,
        [makerOrder], [makerSig], [0],
        fillAmount, [fillAmount],
      ),
    ).to.be.revertedWith("TokenNotAllowed()");
  });

  // --- Control --------------------------------------------------------------

  it("CONTROL — settlement against the properly allow-listed collateral still succeeds", async function () {
    // Sanity: an allow-listed token with the right unit settles cleanly —
    // the new gate doesn't disrupt the happy path.
    const { settlement, erc1155Facet } = ctx.contracts;
    const { buyer, seller, operator } = ctx.signers;
    const { positionIdA } = ctx.market;
    const { UNIT } = ctx.constants;
    const { makeOrder, signOrder } = ctx.helpers;

    const fillAmount = ethers.utils.parseUnits("100", 6);
    const price = UNIT.div(2);

    const takerOrder = makeOrder(buyer.address, positionIdA, 0, fillAmount, price, { salt: 80999 });
    const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, { salt: 80999 });
    const takerSig = await signOrder(buyer, takerOrder);
    const makerSig = await signOrder(seller, makerOrder);

    const buyerPosBefore = await erc1155Facet.balanceOf(buyer.address, positionIdA);
    await settlement.connect(operator).matchOrders(
      takerOrder, takerSig, 0,
      [makerOrder], [makerSig], [0],
      fillAmount, [fillAmount],
    );
    const buyerPosAfter = await erc1155Facet.balanceOf(buyer.address, positionIdA);
    expect(buyerPosAfter.sub(buyerPosBefore)).to.equal(fillAmount);
  });
});
