// Coverage follow-up — AdminConfigFacet / NonceManagerFacet / LibSignature
// ============================================================================
// Closes uncovered branches reported by the `npx hardhat coverage` run for the
// non-settlement settlement-core surface. Each `describe` names the contract
// line(s) it pins.
//
//   AdminConfigFacet  L56  — addCollateralToken: empty-symbol fallback
//                     L83  — removeCollateralToken: token not allowed
//                     L107 — setFeeReceiver: no-change revert
//                     L129 — setResolutionFeeBps: no-change revert
//                     L169 — getCollateralUnit: allowed-token happy path
//                     L204 — setTokenSymbol / getTokenSymbol
//   NonceManagerFacet L90  — cancelOrders: an already-cancelled order
//   LibSignature      L77  — _recover: v normalization (v < 27)
//                     L67  — verifyEIP1271: the catch branch

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupAuditFixture } = require("../utils/auditFixture.js");

describe("Coverage follow-up — AdminConfig / NonceManager / LibSignature", function () {
  let ctx;

  beforeEach(async function () {
    ctx = await setupAuditFixture();
  });

  // Assert a (possibly view-call) revert carries a specific custom-error
  // selector. The repo uses @nomiclabs/hardhat-waffle 3.4, whose `revertedWith`
  // does not reliably match a parameterized custom error thrown from a
  // `staticcall` — mirrors the helper in SignatureVerifierFacet.test.js.
  async function expectRevertWithSelector(txPromise, errorSig) {
    const selector = ethers.utils.id(errorSig).slice(0, 10);
    try {
      await txPromise;
      expect.fail("Expected the call to revert");
    } catch (error) {
      const data = (error.data || error.error?.data || "").toString();
      expect(data.startsWith(selector), `expected revert selector ${selector}, got ${data}`)
        .to.equal(true);
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // AdminConfigFacet
  // ──────────────────────────────────────────────────────────────────────
  describe("AdminConfigFacet", function () {
    it("addCollateralToken stores the 'UNKNOWN' fallback for an empty-symbol token (L56)", async function () {
      const { adminConfig } = ctx.contracts;
      const { owner } = ctx.signers;
      const { UNIT } = ctx.constants;

      // A token whose ERC20 `symbol()` returns an empty string — the
      // try-succeeds-but-empty branch, distinct from the catch fallback.
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const emptyTok = await MockERC20.deploy("Empty Symbol Token", "", 6);
      await emptyTok.deployed();

      await adminConfig.connect(owner).addCollateralToken(emptyTok.address, UNIT);

      expect(await adminConfig.getTokenSymbol(emptyTok.address)).to.equal("UNKNOWN");
    });

    it("removeCollateralToken reverts TokenNotAllowed for a token that was never added (L83)", async function () {
      const { adminConfig } = ctx.contracts;
      const { owner } = ctx.signers;

      const neverAdded = ethers.Wallet.createRandom().address;
      await expect(
        adminConfig.connect(owner).removeCollateralToken(neverAdded),
      ).to.be.revertedWith("TokenNotAllowed()");
    });

    it("setFeeReceiver reverts NoChangeRequired when the receiver is unchanged (L107)", async function () {
      const { adminConfig } = ctx.contracts;
      const { owner, feeReceiver } = ctx.signers;

      // The fixture already set feeReceiver to `feeReceiver.address`.
      await expect(
        adminConfig.connect(owner).setFeeReceiver(feeReceiver.address),
      ).to.be.revertedWith("NoChangeRequired()");
    });

    it("setResolutionFeeBps reverts NoChangeRequired when the rate is unchanged (L129)", async function () {
      const { adminConfig } = ctx.contracts;
      const { owner } = ctx.signers;

      // Re-setting the rate to its current value is a no-op. Read the live
      // value rather than assuming the fresh-deploy default.
      const [, currentBps] = await adminConfig.getFees();
      await expect(
        adminConfig.connect(owner).setResolutionFeeBps(currentBps),
      ).to.be.revertedWith("NoChangeRequired()");
    });

    it("getCollateralUnit returns the configured unit for an allowed token (L169 happy path)", async function () {
      const { adminConfig, collateral } = ctx.contracts;
      const { UNIT } = ctx.constants;

      expect(await adminConfig.getCollateralUnit(collateral.address)).to.equal(UNIT);
    });

    it("setTokenSymbol updates the symbol for an allowed token and getTokenSymbol reads it back (L204)", async function () {
      const { adminConfig, collateral } = ctx.contracts;
      const { owner } = ctx.signers;

      await expect(adminConfig.connect(owner).setTokenSymbol(collateral.address, "USDC.e"))
        .to.emit(adminConfig, "TokenSymbolUpdated")
        .withArgs(collateral.address, "USDC.e");

      expect(await adminConfig.getTokenSymbol(collateral.address)).to.equal("USDC.e");
    });

    it("setTokenSymbol reverts TokenNotAllowed for a token that is not allow-listed (L204 revert)", async function () {
      const { adminConfig } = ctx.contracts;
      const { owner } = ctx.signers;

      const neverAdded = ethers.Wallet.createRandom().address;
      await expect(
        adminConfig.connect(owner).setTokenSymbol(neverAdded, "X"),
      ).to.be.revertedWith("TokenNotAllowed()");
    });

    it("setTokenSymbol reverts for a non-owner caller", async function () {
      const { adminConfig, collateral } = ctx.contracts;
      const { attacker } = ctx.signers;

      // LibDiamond.enforceIsContractOwner — owner-only gate.
      await expect(
        adminConfig.connect(attacker).setTokenSymbol(collateral.address, "X"),
      ).to.be.reverted;
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // NonceManagerFacet
  // ──────────────────────────────────────────────────────────────────────
  describe("NonceManagerFacet", function () {
    it("cancelOrders reverts OrderCancelled when a batch entry was already cancelled (L90)", async function () {
      const { nonceMgr, sigVerifier } = ctx.contracts;
      const { buyer } = ctx.signers;
      const { positionIdA } = ctx.market;
      const { UNIT } = ctx.constants;
      const { makeOrder } = ctx.helpers;

      const order = makeOrder(
        buyer.address, positionIdA, 0, ethers.utils.parseUnits("10", 6), UNIT.div(2), { salt: 76001 },
      );
      const orderHash = await sigVerifier.getOrderHash(order);

      // Cancel it once individually, then feed it to the batch path.
      await nonceMgr.connect(buyer).cancelOrder(order);

      await expect(
        nonceMgr.connect(buyer).cancelOrders([order]),
      ).to.be.revertedWith(`OrderCancelled("${orderHash}")`);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // LibSignature (via SignatureVerifierFacet.verifyOrderSignature)
  // ──────────────────────────────────────────────────────────────────────
  describe("LibSignature", function () {
    it("accepts a signature whose v is in the un-normalized 0/1 form (_recover L77)", async function () {
      const { sigVerifier } = ctx.contracts;
      const { buyer } = ctx.signers;
      const { positionIdA } = ctx.market;
      const { UNIT } = ctx.constants;
      const { makeOrder, signOrder } = ctx.helpers;

      const order = makeOrder(
        buyer.address, positionIdA, 0, ethers.utils.parseUnits("10", 6), UNIT.div(2), { salt: 77001 },
      );
      const sig = await signOrder(buyer, order);

      // A standard signature ends in v = 27 or 28. Some signers emit the
      // un-normalized 0/1 form; `_recover` adds 27 back. Rewrite the trailing
      // v byte to v-27 and assert the facet still accepts it.
      const v = parseInt(sig.slice(-2), 16);
      expect(v === 27 || v === 28).to.equal(true);
      const normalizedDown = (v - 27).toString(16).padStart(2, "0");
      const mangledSig = sig.slice(0, -2) + normalizedDown;

      expect(await sigVerifier.verifyOrderSignature(order, mangledSig, 0)).to.equal(true);
    });

    it("rejects an EIP-1271 order whose maker contract has no isValidSignature (verifyEIP1271 catch L67)", async function () {
      const { sigVerifier, collateral } = ctx.contracts;
      const { buyer } = ctx.signers;
      const { positionIdA } = ctx.market;
      const { UNIT } = ctx.constants;
      const { makeOrder, signOrder } = ctx.helpers;

      // maker = the collateral ERC20 (a contract WITHOUT `isValidSignature`);
      // signer = an EOA whose key actually signs. signatureType 1 ⇒ the facet
      // dispatches to IERC1271(maker).isValidSignature, the typed call to a
      // contract lacking that function reverts, and `verifyEIP1271` hits its
      // `catch` and returns false.
      const order = makeOrder(
        collateral.address, positionIdA, 0, ethers.utils.parseUnits("10", 6), UNIT.div(2),
        { signer: buyer.address, salt: 78001 },
      );
      const sig = await signOrder(buyer, order); // recovers to order.signer == buyer

      await expectRevertWithSelector(
        sigVerifier.verifyOrderSignature(order, sig, 1),
        "InvalidOrderSignature(bytes32)",
      );
    });
  });
});
