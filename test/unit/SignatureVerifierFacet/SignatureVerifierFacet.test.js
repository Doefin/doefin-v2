const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SignatureVerifierFacet", function () {
  let verifier;
  let owner, eoaSigner, otherSigner;

  const DOMAIN_NAME = "Doefin Exchange";
  const DOMAIN_VERSION = "3";

  // EIP-712 typed data definition for signing in tests
  const ORDER_TYPE = {
    DoefinOrder: [
      { name: "salt", type: "uint256" },
      { name: "maker", type: "address" },
      { name: "signer", type: "address" },
      { name: "positionId", type: "bytes32" },
      { name: "collateralToken", type: "address" },
      { name: "side", type: "uint8" },
      { name: "amount", type: "uint128" },
      { name: "pricePerToken", type: "uint128" },
      { name: "expiration", type: "uint64" },
      { name: "nonce", type: "uint256" },
    ],
  };

  function makeDomain(verifyingContract) {
    return {
      name: DOMAIN_NAME,
      version: DOMAIN_VERSION,
      chainId: 31337,
      verifyingContract,
    };
  }

  function makeOrder(maker, signer) {
    return {
      salt: 1,
      maker,
      signer,
      positionId: ethers.utils.formatBytes32String("pos1"),
      collateralToken: "0x3333333333333333333333333333333333333333",
      side: 0,
      amount: 1000,
      pricePerToken: 500,
      expiration: 0,
      nonce: 1,
    };
  }

  async function signOrder(signerWallet, domain, order) {
    return signerWallet._signTypedData(domain, ORDER_TYPE, order);
  }

  /**
   * Helper: compute the 4-byte error selector for a custom error.
   * Used to assert reverts with parameterized errors since the repo
   * uses @nomiclabs/hardhat-waffle (no revertedWithCustomError).
   */
  function errorSelector(signature) {
    return ethers.utils.id(signature).slice(0, 10);
  }

  /**
   * Assert that a transaction reverts with a specific custom error selector.
   */
  async function expectRevertWithSelector(txPromise, errorSig) {
    try {
      await txPromise;
      expect.fail("Expected transaction to revert");
    } catch (error) {
      const selector = errorSelector(errorSig);
      const errorData = error.data || error.error?.data || "";
      expect(errorData.toString().startsWith(selector)).to.equal(
        true,
        `Expected error selector ${selector} (${errorSig}) but got: ${errorData}`
      );
    }
  }

  before(async function () {
    [owner, eoaSigner, otherSigner] = await ethers.getSigners();

    const Verifier = await ethers.getContractFactory("SignatureVerifierFacet");
    verifier = await Verifier.deploy();
    await verifier.deployed();
  });

  // ========================================
  // DOMAIN SEPARATOR TESTS
  // ========================================

  describe("getDomainSeparator()", function () {
    it("should match cross-verified computation from SC-001", async function () {
      const Harness = await ethers.getContractFactory("DoefinOrderHarness");
      const harness = await Harness.deploy();
      await harness.deployed();

      const expected = await harness.domainSeparator(
        DOMAIN_NAME,
        DOMAIN_VERSION,
        31337,
        verifier.address
      );
      const actual = await verifier.getDomainSeparator();
      expect(actual).to.equal(expected);
    });
  });

  // ========================================
  // ORDER HASH TESTS
  // ========================================

  describe("getOrderHash()", function () {
    it("should match LibDoefinOrder.hashOrder() via harness", async function () {
      const Harness = await ethers.getContractFactory("DoefinOrderHarness");
      const harness = await Harness.deploy();
      await harness.deployed();

      const order = makeOrder(eoaSigner.address, eoaSigner.address);

      const ds = await harness.domainSeparator(
        DOMAIN_NAME,
        DOMAIN_VERSION,
        31337,
        verifier.address
      );
      const expected = await harness.hashOrder(order, ds);
      const actual = await verifier.getOrderHash(order);
      expect(actual).to.equal(expected);
    });
  });

  // ========================================
  // EOA SIGNATURE VERIFICATION
  // ========================================

  describe("EOA signature verification (signatureType=0)", function () {
    it("should return true for a valid EOA signature (signer == maker)", async function () {
      const order = makeOrder(eoaSigner.address, eoaSigner.address);
      const domain = makeDomain(verifier.address);
      const signature = await signOrder(eoaSigner, domain, order);

      const result = await verifier.verifyOrderSignature(order, signature, 0);
      expect(result).to.equal(true);
    });

    it("should revert when recovered signer does not match order.signer", async function () {
      const order = makeOrder(eoaSigner.address, eoaSigner.address);
      const domain = makeDomain(verifier.address);
      const signature = await signOrder(otherSigner, domain, order);

      await expectRevertWithSelector(
        verifier.verifyOrderSignature(order, signature, 0),
        "InvalidOrderSignature(bytes32)"
      );
    });

    it("should revert when signer != maker in EOA mode", async function () {
      const order = makeOrder(owner.address, eoaSigner.address);
      const domain = makeDomain(verifier.address);
      const signature = await signOrder(eoaSigner, domain, order);

      await expectRevertWithSelector(
        verifier.verifyOrderSignature(order, signature, 0),
        "InvalidOrderSignature(bytes32)"
      );
    });

    it("should revert with corrupted signature", async function () {
      const order = makeOrder(eoaSigner.address, eoaSigner.address);
      const domain = makeDomain(verifier.address);
      const signature = await signOrder(eoaSigner, domain, order);

      const sigBytes = ethers.utils.arrayify(signature);
      sigBytes[10] ^= 0xff;
      const corrupted = ethers.utils.hexlify(sigBytes);

      await expectRevertWithSelector(
        verifier.verifyOrderSignature(order, corrupted, 0),
        "InvalidOrderSignature(bytes32)"
      );
    });

    it("should revert with wrong-length signature", async function () {
      const order = makeOrder(eoaSigner.address, eoaSigner.address);

      await expect(
        verifier.verifyOrderSignature(order, "0xdead", 0)
      ).to.be.revertedWith("InvalidSignatureLength()");
    });
  });

  // ========================================
  // EIP-1271 SIGNATURE VERIFICATION
  // ========================================

  describe("EIP-1271 signature verification (signatureType=1)", function () {
    let validWallet, invalidWallet;

    before(async function () {
      const MockWallet = await ethers.getContractFactory("MockERC1271Wallet");
      validWallet = await MockWallet.deploy(true);
      await validWallet.deployed();
      invalidWallet = await MockWallet.deploy(false);
      await invalidWallet.deployed();
    });

    it("should return true when EIP-1271 wallet returns magic value", async function () {
      const order = makeOrder(validWallet.address, eoaSigner.address);
      const domain = makeDomain(verifier.address);
      const signature = await signOrder(eoaSigner, domain, order);

      const result = await verifier.verifyOrderSignature(order, signature, 1);
      expect(result).to.equal(true);
    });

    it("should revert when EIP-1271 wallet returns wrong magic value", async function () {
      const order = makeOrder(invalidWallet.address, eoaSigner.address);
      const domain = makeDomain(verifier.address);
      const signature = await signOrder(eoaSigner, domain, order);

      await expectRevertWithSelector(
        verifier.verifyOrderSignature(order, signature, 1),
        "InvalidOrderSignature(bytes32)"
      );
    });

    it("should revert when ECDSA recovery does not match order.signer", async function () {
      const order = makeOrder(validWallet.address, eoaSigner.address);
      const domain = makeDomain(verifier.address);
      const signature = await signOrder(otherSigner, domain, order);

      await expectRevertWithSelector(
        verifier.verifyOrderSignature(order, signature, 1),
        "InvalidOrderSignature(bytes32)"
      );
    });
  });

  // ========================================
  // REGISTERED SIGNER TESTS
  // ========================================

  describe("Registered signer", function () {
    let scwWallet;

    before(async function () {
      // Deploy a mock wallet that returns INVALID (to prove we bypass the 1271 call)
      const MockWallet = await ethers.getContractFactory("MockERC1271Wallet");
      scwWallet = await MockWallet.deploy(false); // returns 0xffffffff
      await scwWallet.deployed();
    });

    it("should allow a SCW to register a signer", async function () {
      await ethers.provider.send("hardhat_impersonateAccount", [scwWallet.address]);
      await owner.sendTransaction({ to: scwWallet.address, value: ethers.utils.parseEther("1") });

      const scwSigner = await ethers.getSigner(scwWallet.address);
      await verifier.connect(scwSigner).registerOrderSigner(eoaSigner.address, true);

      const isRegistered = await verifier.isRegisteredSigner(scwWallet.address, eoaSigner.address);
      expect(isRegistered).to.equal(true);

      await ethers.provider.send("hardhat_stopImpersonatingAccount", [scwWallet.address]);
    });

    it("should skip EIP-1271 call for registered signer (wallet returns invalid but verification passes)", async function () {
      // The mock wallet returns 0xffffffff (invalid), but the signer is registered
      // so the EIP-1271 call should be skipped entirely
      const order = makeOrder(scwWallet.address, eoaSigner.address);
      const domain = makeDomain(verifier.address);
      const signature = await signOrder(eoaSigner, domain, order);

      const result = await verifier.verifyOrderSignature(order, signature, 1);
      expect(result).to.equal(true);
    });

    it("should fall through to EIP-1271 for unregistered signer", async function () {
      // otherSigner is NOT registered for scwWallet, and the wallet returns invalid
      const order = makeOrder(scwWallet.address, otherSigner.address);
      const domain = makeDomain(verifier.address);
      const signature = await signOrder(otherSigner, domain, order);

      await expectRevertWithSelector(
        verifier.verifyOrderSignature(order, signature, 1),
        "InvalidOrderSignature(bytes32)"
      );
    });

    it("should allow deregistering a signer", async function () {
      await ethers.provider.send("hardhat_impersonateAccount", [scwWallet.address]);
      const scwSigner = await ethers.getSigner(scwWallet.address);
      await verifier.connect(scwSigner).registerOrderSigner(eoaSigner.address, false);

      const isRegistered = await verifier.isRegisteredSigner(scwWallet.address, eoaSigner.address);
      expect(isRegistered).to.equal(false);

      await ethers.provider.send("hardhat_stopImpersonatingAccount", [scwWallet.address]);
    });

    it("should revert after signer is deregistered (falls through to invalid EIP-1271)", async function () {
      const order = makeOrder(scwWallet.address, eoaSigner.address);
      const domain = makeDomain(verifier.address);
      const signature = await signOrder(eoaSigner, domain, order);

      await expectRevertWithSelector(
        verifier.verifyOrderSignature(order, signature, 1),
        "InvalidOrderSignature(bytes32)"
      );
    });
  });

  // ========================================
  // INVALID SIGNATURE TYPE
  // ========================================

  describe("Invalid signatureType", function () {
    it("should revert with signatureType > 1", async function () {
      const order = makeOrder(eoaSigner.address, eoaSigner.address);
      const domain = makeDomain(verifier.address);
      const signature = await signOrder(eoaSigner, domain, order);

      await expectRevertWithSelector(
        verifier.verifyOrderSignature(order, signature, 2),
        "InvalidOrderSignature(bytes32)"
      );
    });
  });

  // ========================================
  // ECDSA SIGNATURE MALLEABILITY (HIGH-3)
  // ========================================

  describe("ECDSA signature malleability rejection", function () {
    const SECP256K1_N = ethers.BigNumber.from("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");

    it("should reject a malleable signature (high-s value)", async function () {
      const order = makeOrder(eoaSigner.address, eoaSigner.address);
      const domain = makeDomain(verifier.address);
      const signature = await signOrder(eoaSigner, domain, order);

      // Extract r, s, v and flip s to n - s
      const sigBytes = ethers.utils.arrayify(signature);
      const r = ethers.utils.hexlify(sigBytes.slice(0, 32));
      const s = ethers.BigNumber.from(sigBytes.slice(32, 64));
      const v = sigBytes[64];

      const malleableS = SECP256K1_N.sub(s);
      const malleableV = v === 27 ? 28 : 27;

      const malleableSig = ethers.utils.hexlify(
        ethers.utils.concat([
          r,
          ethers.utils.hexZeroPad(malleableS.toHexString(), 32),
          [malleableV],
        ])
      );

      await expectRevertWithSelector(
        verifier.verifyOrderSignature(order, malleableSig, 0),
        "InvalidOrderSignature(bytes32)"
      );
    });

    it("should accept the original (low-s) signature", async function () {
      const order = makeOrder(eoaSigner.address, eoaSigner.address);
      const domain = makeDomain(verifier.address);
      const signature = await signOrder(eoaSigner, domain, order);

      const result = await verifier.verifyOrderSignature(order, signature, 0);
      expect(result).to.equal(true);
    });
  });
});
