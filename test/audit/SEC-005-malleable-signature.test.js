// PENTEST · SEC-005 (MED) — ECDSA malleability across the shared verifier
// ----------------------------------------------------------------------------
// STATUS: FIXED. ECDSA recovery is consolidated in a single `LibSignature`
// library (assembly r/s/v, `v<27` normalization, low-`s` reject). This pentest
// validates the settlement-side malleability check, which blocks the attack on
// the crown-jewel surfaces.
//
// The cross-currency OracleManagerFacet that previously carried a divergent,
// unhardened copy of the verifier has been removed from the protocol entirely,
// so no inconsistent ecrecover path remains.
//
// What this pentest covers
//   - DEMONSTRATES: SettlementFacet's `_verifySignature` rejects a malleable
//     (high-`s`) signature with `InvalidOrderSignature`.
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

describe("PENTEST · SEC-005 (MED) — ECDSA malleability against the shared verifier", function () {
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
        fillAmount, [fillAmount], [0], [0],
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
        fillAmount, [fillAmount], [0], [0],
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
      fillAmount, [fillAmount], [0], [0],
    );
    const after = await erc1155Facet.balanceOf(buyer.address, positionIdA);
    expect(after.sub(before)).to.equal(fillAmount);
  });
});
