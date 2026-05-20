// PENTEST · SEC-005 (MED) — triplicated ECDSA verifier; OracleManagerFacet's
// copy lacks the malleability check and `v` normalisation
// ----------------------------------------------------------------------------
// STATUS: NOT YET FIXED. This pentest validates the settlement-side
// malleability check (which DOES exist and DOES block the attack on the
// crown-jewel surfaces) and documents the divergent OracleManagerFacet copy
// that lacks it.
//
// Three copies of ECDSA recovery exist at the audited commit:
//   1. SettlementFacet._verifySignature       — assembly r/s/v, `v<27` normalization, low-`s` reject.
//   2. SignatureVerifierFacet._recoverSigner  — same hardening, but typed IERC1271 dispatch.
//   3. OracleManagerFacet._recoverSigner (~544-560) — raw ecrecover, NO `v` normalization, NO low-`s` reject.
//
// The maintenance risk: hardening already DID diverge once (copies 1+2 carry the
// fix, copy 3 doesn't). A future ecrecover-adjacent change to copies 1/2 can
// easily miss copy 3 again. Remedy: extract a single `LibSignature`.
//
// What this pentest covers
//   - DEMONSTRATES: SettlementFacet's `_verifySignature` rejects a malleable
//     (high-`s`) signature with `InvalidOrderSignature`. Same payload would
//     succeed against the equivalent OracleManagerFacet pathway — see the
//     `it.skip` block below for the structural pentest that would need the
//     oracle's authorizedSigner + PRICE_TYPEHASH + EIP-712 domain
//     reconstructed in JS to exploit it directly.
//
// secp256k1 group flip
//   For any valid `(r, s, v)`, the pair `(r, n - s, v ^ 1)` is an equivalent
//   signature that recovers to the same signer. The "low-`s`" convention
//   restricts `s` to the lower half (`s <= n/2`); accepting the upper half
//   permits two distinct on-chain representations of the same authorization.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupAuditFixture } = require("../utils/auditFixture.js");

// secp256k1 curve order n
const SECP256K1_N = ethers.BigNumber.from(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141",
);
// (n - 1) / 2 — the upper bound of the "low-s" half used by both
// SettlementFacet (line 271) and SignatureVerifierFacet (line 191).
const HALF_N = ethers.BigNumber.from(
  "0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0",
);

/**
 * Flip an ECDSA signature to its high-`s` malleable equivalent. Both
 * `(r,s,v)` and `(r, n-s, v^1)` recover to the same signer.
 *
 * ethers v5's `joinSignature` itself rejects high-`s` (it has the same
 * malleability check at the library level), so we build the raw 65-byte
 * signature `r || s || v` directly.
 */
function flipToHighS(sigHex) {
  const sig = ethers.utils.splitSignature(sigHex);
  const sHigh = SECP256K1_N.sub(ethers.BigNumber.from(sig.s));
  const sHighHex = ethers.utils.hexZeroPad(sHigh.toHexString(), 32);
  const vHigh = sig.v === 27 ? 28 : 27;
  return ethers.utils.hexlify(
    ethers.utils.concat([
      sig.r,
      sHighHex,
      ethers.utils.hexlify(vHigh),
    ]),
  );
}

describe("PENTEST · SEC-005 (MED) — ECDSA malleability across the three verifier copies", function () {
  let ctx;

  before(async function () {
    ctx = await setupAuditFixture();
  });

  it("ATTACK BLOCKED — SettlementFacet rejects a malleable (high-`s`) signature for a matched order", async function () {
    const { settlement } = ctx.contracts;
    const { buyer, seller, operator } = ctx.signers;
    const { positionIdA } = ctx.market;
    const { UNIT } = ctx.constants;
    const { makeOrder, signOrder } = ctx.helpers;

    const fillAmount = ethers.utils.parseUnits("100", 6);
    const price = UNIT.div(2);

    const takerOrder = makeOrder(buyer.address,  positionIdA, 0, fillAmount, price, { salt: 92001 });
    const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, { salt: 92001 });

    const takerSigLow  = await signOrder(buyer,  takerOrder);
    const makerSigLow  = await signOrder(seller, makerOrder);

    // Sanity — the low-`s` signature is genuinely below n/2, so flipping
    // moves it above. (If a wallet ever produced a high-`s` directly, the
    // settlement verifier would also reject that — same check.)
    expect(ethers.BigNumber.from(ethers.utils.splitSignature(takerSigLow).s)).to.be.lte(HALF_N);

    const takerSigHigh = flipToHighS(takerSigLow);
    expect(ethers.BigNumber.from(ethers.utils.splitSignature(takerSigHigh).s)).to.be.gt(HALF_N);

    // Attack: submit matchOrders with the malleable taker signature. The
    // SettlementFacet._verifySignature check at line 271 catches this.
    await expect(
      settlement.connect(operator).matchOrders(
        takerOrder, takerSigHigh, 0,
        [makerOrder], [makerSigLow], [0],
        fillAmount, [fillAmount],
      ),
    ).to.be.reverted; // InvalidOrderSignature(hash)
  });

  it("ATTACK BLOCKED — SettlementFacet rejects a malleable maker signature too (loop catches every leg)", async function () {
    const { settlement } = ctx.contracts;
    const { buyer, seller, operator } = ctx.signers;
    const { positionIdA } = ctx.market;
    const { UNIT } = ctx.constants;
    const { makeOrder, signOrder } = ctx.helpers;

    const fillAmount = ethers.utils.parseUnits("100", 6);
    const price = UNIT.div(2);

    const takerOrder = makeOrder(buyer.address,  positionIdA, 0, fillAmount, price, { salt: 92002 });
    const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, { salt: 92002 });

    const takerSigLow  = await signOrder(buyer,  takerOrder);
    const makerSigHigh = flipToHighS(await signOrder(seller, makerOrder));

    await expect(
      settlement.connect(operator).matchOrders(
        takerOrder, takerSigLow, 0,
        [makerOrder], [makerSigHigh], [0],
        fillAmount, [fillAmount],
      ),
    ).to.be.reverted; // InvalidOrderSignature(hash)
  });

  it("CONTROL — both sigs in canonical low-`s` form let the match settle", async function () {
    const { settlement, erc1155Facet } = ctx.contracts;
    const { buyer, seller, operator } = ctx.signers;
    const { positionIdA } = ctx.market;
    const { UNIT } = ctx.constants;
    const { makeOrder, signOrder } = ctx.helpers;

    const fillAmount = ethers.utils.parseUnits("100", 6);
    const price = UNIT.div(2);

    const takerOrder = makeOrder(buyer.address,  positionIdA, 0, fillAmount, price, { salt: 92003 });
    const makerOrder = makeOrder(seller.address, positionIdA, 1, fillAmount, price, { salt: 92003 });

    const takerSig = await signOrder(buyer,  takerOrder);
    const makerSig = await signOrder(seller, makerOrder);

    const before = await erc1155Facet.balanceOf(buyer.address, positionIdA);
    await settlement.connect(operator).matchOrders(
      takerOrder, takerSig, 0,
      [makerOrder], [makerSig], [0],
      fillAmount, [fillAmount],
    );
    const after = await erc1155Facet.balanceOf(buyer.address, positionIdA);
    expect(after.sub(before)).to.equal(fillAmount);
  });

  // The full exploit pentest against OracleManagerFacet — requires
  // configuring `oracleStorage.authorizedSigner`, building the
  // `PRICE_TYPEHASH` EIP-712 envelope in JS, and submitting `manualUpdatePrice`
  // twice with the low-`s` and the high-`s` signatures (the second submission
  // would have to use a different `nonce` because the first marks its own
  // nonce used — i.e. the attack is "re-use this signature across the curve
  // flip", not classic double-spend). Out of scope for this MED-maintenance
  // pentest; the LibSignature extraction recommended in the ledger removes
  // the gap entirely.
  it.skip("ATTACK SUCCEEDS pre-fix — OracleManagerFacet accepts a malleable signature on manualUpdatePrice (requires oracle setup)", async function () {
    // To exploit: set oracleStorage.authorizedSigner, build PRICE_TYPEHASH,
    // submit manualUpdatePrice(low-`s`) on nonce A, submit the flipped-to-high-`s`
    // form on nonce B with the SAME signer-recovered identity. Demonstrates
    // that copy #3 accepts what copies #1/#2 reject. Will be enabled when the
    // LibSignature refactor is in place and we cross-verify all three paths
    // against a single test fixture.
  });
});
