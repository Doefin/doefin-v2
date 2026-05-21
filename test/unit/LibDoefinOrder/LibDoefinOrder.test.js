const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("LibDoefinOrder", function () {
  let harness;
  let baseOrder;

  const DOMAIN_NAME = "Doefin Exchange";
  const DOMAIN_VERSION = "3";
  const CHAIN_ID = 31337;

  before(async function () {
    const Harness = await ethers.getContractFactory("DoefinOrderHarness");
    harness = await Harness.deploy();
    await harness.deployed();

    // Canonical test order (SCRUM-226: 10-field struct, no minFillAmount)
    baseOrder = {
      salt: 1,
      maker: "0x1111111111111111111111111111111111111111",
      signer: "0x2222222222222222222222222222222222222222",
      positionId: ethers.utils.formatBytes32String("pos1"),
      collateralToken: "0x3333333333333333333333333333333333333333",
      side: 0, // BUY
      amount: 1000,
      pricePerToken: 500,
      expiration: 0,
      nonce: 1,
    };
  });

  // ========================================
  // TYPE HASH TESTS
  // ========================================

  describe("DOEFIN_ORDER_TYPEHASH", function () {
    it("should match the keccak256 of the canonical type string", async function () {
      const typeString =
        "DoefinOrder(" +
        "uint256 salt," +
        "address maker," +
        "address signer," +
        "bytes32 positionId," +
        "address collateralToken," +
        "uint8 side," +
        "uint128 amount," +
        "uint128 pricePerToken," +
        "uint64 expiration," +
        "uint256 nonce" +
        ")";

      const expected = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes(typeString)
      );
      const actual = await harness.DOEFIN_ORDER_TYPEHASH();
      expect(actual).to.equal(expected);
    });
  });

  describe("DOMAIN_SEPARATOR_TYPEHASH", function () {
    it("should match the keccak256 of the EIP-712 domain type string", async function () {
      const typeString =
        "EIP712Domain(" +
        "string name," +
        "string version," +
        "uint256 chainId," +
        "address verifyingContract" +
        ")";

      const expected = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes(typeString)
      );
      const actual = await harness.DOMAIN_SEPARATOR_TYPEHASH();
      expect(actual).to.equal(expected);
    });
  });

  // ========================================
  // STRUCT HASH TESTS
  // ========================================

  describe("hash()", function () {
    it("should produce a deterministic hash for the same order", async function () {
      const hash1 = await harness.hash(baseOrder);
      const hash2 = await harness.hash(baseOrder);
      expect(hash1).to.equal(hash2);
    });

    it("should produce different hashes for different orders", async function () {
      const order2 = { ...baseOrder, salt: 2 };
      const hash1 = await harness.hash(baseOrder);
      const hash2 = await harness.hash(order2);
      expect(hash1).to.not.equal(hash2);
    });

    it("should change when salt changes", async function () {
      const original = await harness.hash(baseOrder);
      const modified = await harness.hash({ ...baseOrder, salt: 999 });
      expect(original).to.not.equal(modified);
    });

    it("should change when maker changes", async function () {
      const original = await harness.hash(baseOrder);
      const modified = await harness.hash({
        ...baseOrder,
        maker: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      });
      expect(original).to.not.equal(modified);
    });

    it("should change when signer changes", async function () {
      const original = await harness.hash(baseOrder);
      const modified = await harness.hash({
        ...baseOrder,
        signer: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      });
      expect(original).to.not.equal(modified);
    });

    it("should change when positionId changes", async function () {
      const original = await harness.hash(baseOrder);
      const modified = await harness.hash({
        ...baseOrder,
        positionId: ethers.utils.formatBytes32String("pos2"),
      });
      expect(original).to.not.equal(modified);
    });

    it("should change when collateralToken changes", async function () {
      const original = await harness.hash(baseOrder);
      const modified = await harness.hash({
        ...baseOrder,
        collateralToken: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      });
      expect(original).to.not.equal(modified);
    });

    it("should change when side changes", async function () {
      const original = await harness.hash(baseOrder);
      const modified = await harness.hash({ ...baseOrder, side: 1 });
      expect(original).to.not.equal(modified);
    });

    it("should change when amount changes", async function () {
      const original = await harness.hash(baseOrder);
      const modified = await harness.hash({ ...baseOrder, amount: 2000 });
      expect(original).to.not.equal(modified);
    });

    it("should change when pricePerToken changes", async function () {
      const original = await harness.hash(baseOrder);
      const modified = await harness.hash({
        ...baseOrder,
        pricePerToken: 750,
      });
      expect(original).to.not.equal(modified);
    });

    it("should change when expiration changes", async function () {
      const original = await harness.hash(baseOrder);
      const modified = await harness.hash({
        ...baseOrder,
        expiration: 1700000000,
      });
      expect(original).to.not.equal(modified);
    });

    it("should change when nonce changes", async function () {
      const original = await harness.hash(baseOrder);
      const modified = await harness.hash({ ...baseOrder, nonce: 2 });
      expect(original).to.not.equal(modified);
    });

    it("should match manual abi.encode + keccak256 computation", async function () {
      const typehash = await harness.DOEFIN_ORDER_TYPEHASH();
      const encoded = ethers.utils.defaultAbiCoder.encode(
        [
          "bytes32",
          "uint256",
          "address",
          "address",
          "bytes32",
          "address",
          "uint8",
          "uint128",
          "uint128",
          "uint64",
          "uint256",
        ],
        [
          typehash,
          baseOrder.salt,
          baseOrder.maker,
          baseOrder.signer,
          baseOrder.positionId,
          baseOrder.collateralToken,
          baseOrder.side,
          baseOrder.amount,
          baseOrder.pricePerToken,
          baseOrder.expiration,
          baseOrder.nonce,
        ]
      );
      const expected = ethers.utils.keccak256(encoded);
      const actual = await harness.hash(baseOrder);
      expect(actual).to.equal(expected);
    });
  });

  // ========================================
  // DOMAIN SEPARATOR TESTS
  // ========================================

  describe("domainSeparator()", function () {
    it("should produce a deterministic domain separator", async function () {
      const ds1 = await harness.domainSeparator(
        DOMAIN_NAME,
        DOMAIN_VERSION,
        CHAIN_ID,
        harness.address
      );
      const ds2 = await harness.domainSeparator(
        DOMAIN_NAME,
        DOMAIN_VERSION,
        CHAIN_ID,
        harness.address
      );
      expect(ds1).to.equal(ds2);
    });

    it("should match manual EIP-712 domain separator computation", async function () {
      const domainTypehash = await harness.DOMAIN_SEPARATOR_TYPEHASH();
      const encoded = ethers.utils.defaultAbiCoder.encode(
        ["bytes32", "bytes32", "bytes32", "uint256", "address"],
        [
          domainTypehash,
          ethers.utils.keccak256(ethers.utils.toUtf8Bytes(DOMAIN_NAME)),
          ethers.utils.keccak256(ethers.utils.toUtf8Bytes(DOMAIN_VERSION)),
          CHAIN_ID,
          harness.address,
        ]
      );
      const expected = ethers.utils.keccak256(encoded);
      const actual = await harness.domainSeparator(
        DOMAIN_NAME,
        DOMAIN_VERSION,
        CHAIN_ID,
        harness.address
      );
      expect(actual).to.equal(expected);
    });

    it("should change when name changes", async function () {
      const ds1 = await harness.domainSeparator(
        DOMAIN_NAME,
        DOMAIN_VERSION,
        CHAIN_ID,
        harness.address
      );
      const ds2 = await harness.domainSeparator(
        "Other Name",
        DOMAIN_VERSION,
        CHAIN_ID,
        harness.address
      );
      expect(ds1).to.not.equal(ds2);
    });

    it("should change when version changes", async function () {
      const ds1 = await harness.domainSeparator(
        DOMAIN_NAME,
        DOMAIN_VERSION,
        CHAIN_ID,
        harness.address
      );
      const ds2 = await harness.domainSeparator(
        DOMAIN_NAME,
        "3.0",
        CHAIN_ID,
        harness.address
      );
      expect(ds1).to.not.equal(ds2);
    });

    it("should change when chainId changes", async function () {
      const ds1 = await harness.domainSeparator(
        DOMAIN_NAME,
        DOMAIN_VERSION,
        CHAIN_ID,
        harness.address
      );
      const ds2 = await harness.domainSeparator(
        DOMAIN_NAME,
        DOMAIN_VERSION,
        1,
        harness.address
      );
      expect(ds1).to.not.equal(ds2);
    });

    it("should change when verifyingContract changes", async function () {
      const ds1 = await harness.domainSeparator(
        DOMAIN_NAME,
        DOMAIN_VERSION,
        CHAIN_ID,
        harness.address
      );
      const ds2 = await harness.domainSeparator(
        DOMAIN_NAME,
        DOMAIN_VERSION,
        CHAIN_ID,
        "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
      );
      expect(ds1).to.not.equal(ds2);
    });
  });

  // ========================================
  // FULL EIP-712 HASH TESTS
  // ========================================

  describe("hashOrder()", function () {
    let ds;

    before(async function () {
      ds = await harness.domainSeparator(
        DOMAIN_NAME,
        DOMAIN_VERSION,
        CHAIN_ID,
        harness.address
      );
    });

    it("should produce a deterministic full hash", async function () {
      const hash1 = await harness.hashOrder(baseOrder, ds);
      const hash2 = await harness.hashOrder(baseOrder, ds);
      expect(hash1).to.equal(hash2);
    });

    it("should differ from the struct hash alone", async function () {
      const structHash = await harness.hash(baseOrder);
      const fullHash = await harness.hashOrder(baseOrder, ds);
      expect(fullHash).to.not.equal(structHash);
    });

    it("should match manual \\x19\\x01 + domain + structHash computation", async function () {
      const structHash = await harness.hash(baseOrder);
      const expected = ethers.utils.keccak256(
        ethers.utils.solidityPack(
          ["bytes1", "bytes1", "bytes32", "bytes32"],
          ["0x19", "0x01", ds, structHash]
        )
      );
      const actual = await harness.hashOrder(baseOrder, ds);
      expect(actual).to.equal(expected);
    });

    it("should change when the order changes", async function () {
      const hash1 = await harness.hashOrder(baseOrder, ds);
      const hash2 = await harness.hashOrder({ ...baseOrder, amount: 5000 }, ds);
      expect(hash1).to.not.equal(hash2);
    });

    it("should change when the domain separator changes", async function () {
      const ds2 = await harness.domainSeparator(
        DOMAIN_NAME,
        DOMAIN_VERSION,
        1, // different chain
        harness.address
      );
      const hash1 = await harness.hashOrder(baseOrder, ds);
      const hash2 = await harness.hashOrder(baseOrder, ds2);
      expect(hash1).to.not.equal(hash2);
    });
  });

  // ========================================
  // CROSS-HASH VERIFICATION (backend parity)
  // ========================================

  describe("Cross-hash verification", function () {
    // SCRUM-226: recomputed after removing `minFillAmount` from the DoefinOrder struct.
    const EXPECTED_ORDER_TYPEHASH =
      "0xff1c8998850575465e0fe5d8e2ad1901f5487c91977a245a2901fc65cd90a3b0";
    const EXPECTED_DOMAIN_TYPEHASH =
      "0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f";
    const EXPECTED_STRUCT_HASH =
      "0x0ad5b0928699c9c92346c841ad2f9c92a166a382474ff94409efa3628c4337fd";

    it("DOEFIN_ORDER_TYPEHASH must match canonical value", async function () {
      const actual = await harness.DOEFIN_ORDER_TYPEHASH();
      expect(actual).to.equal(EXPECTED_ORDER_TYPEHASH);
    });

    it("EIP712_DOMAIN_TYPEHASH must match canonical value", async function () {
      const actual = await harness.DOMAIN_SEPARATOR_TYPEHASH();
      expect(actual).to.equal(EXPECTED_DOMAIN_TYPEHASH);
    });

    it("struct hash of canonical baseOrder must match canonical value", async function () {
      const actual = await harness.hash(baseOrder);
      expect(actual).to.equal(EXPECTED_STRUCT_HASH);
    });
  });
});
