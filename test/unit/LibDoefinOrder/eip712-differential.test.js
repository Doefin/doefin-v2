// LibDoefinOrder — cross-runtime EIP-712 differential test
// ============================================================================
// Closes Gap-7 of `audit/business-logic/coverage.md` (INV-SIG-1).
//
// The Diamond verifies EIP-712 signatures on-chain; the Python backend signs
// orders off-chain. The two MUST produce a byte-identical struct hash and
// order digest for the same order, or every signature fails verification.
// Before this test, parity with `doefin-backend/shared/scw/encoder.py` was
// confirmed only by inspection — a drift on either side would ship undetected.
//
// This test mechanically enforces parity. For one shared fixture order it
// computes the EIP-712 struct hash and full order digest THREE independent
// ways and asserts byte equality:
//
//   1. The Solidity LibDoefinOrder harness  (the on-chain implementation).
//   2. A faithful JS port of encoder.py     (the spec the backend satisfies:
//      `compute_struct_hash` = keccak256(abi.encode(typehash, ...fields...))
//      with the exact 10-field type list, in order).
//   3. ethers' own EIP-712 TypedDataEncoder (a third, independent codepath —
//      the same encoder `_signTypedData` drives, so it also proves the
//      Hardhat suite's order signing matches the on-chain hash).
//
// It additionally pins the FROZEN values that the actual Python encoder
// emits for this fixture (`encoder.py` run captured in
// `doefin-backend/tests/test_cross_hash_verification.py`), so drift in the
// backend ALSO fails CI even if its JS port were to drift in lock-step.
//
// SCRUM-228 froze the v3 schema: the 10-field DoefinOrder struct, domain
// version "3". If a removed field (minFillAmount / feeRateBps / ...) ever
// drifts back into either runtime, the type list below diverges and this
// test fails loudly.

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("LibDoefinOrder — EIP-712 cross-runtime differential (Gap-7, INV-SIG-1)", function () {
  let harness;

  // ── Frozen v3 schema (SCRUM-228) ──────────────────────────────────────
  const DOMAIN_NAME = "Doefin Exchange";
  const DOMAIN_VERSION = "3";
  const CHAIN_ID = 31337; // Hardhat default — matches encoder.py TEST_DOMAIN

  // The 10-field EIP-712 type string. Field order/types are the contract of
  // record; this list is byte-identical to encoder.py DOEFIN_ORDER_TYPE_STRING
  // and to LibDoefinOrder's DOEFIN_ORDER_TYPEHASH preimage.
  const ORDER_TYPE_STRING =
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

  // ethers TypedDataEncoder type list — same 10 fields, same order.
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

  // ── Shared fixture order ──────────────────────────────────────────────
  // Byte-identical to:
  //  - `baseOrder` in test/unit/LibDoefinOrder/LibDoefinOrder.test.js
  //  - `BASE_ORDER` in doefin-backend/tests/test_cross_hash_verification.py
  //    (positionId = ethers.utils.formatBytes32String("pos1")).
  const FIXTURE_ORDER = {
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

  // ── Frozen Python-encoder outputs (encoder.py, the backend source of truth)
  // Captured from doefin-backend/tests/test_cross_hash_verification.py and the
  // canonical values pinned in LibDoefinOrder.test.js "Cross-hash verification".
  // verifyingContract for the full-digest value is the harness's deterministic
  // first-deploy address on a fresh Hardhat node.
  const FROZEN_ORDER_TYPEHASH =
    "0xff1c8998850575465e0fe5d8e2ad1901f5487c91977a245a2901fc65cd90a3b0";
  const FROZEN_DOMAIN_TYPEHASH =
    "0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f";
  const FROZEN_STRUCT_HASH =
    "0x0ad5b0928699c9c92346c841ad2f9c92a166a382474ff94409efa3628c4337fd";

  /**
   * Faithful JS port of `encoder.compute_struct_hash` (doefin-backend).
   * Python:  Web3.keccak(eth_abi.encode([types...], [typehash, ...fields...]))
   * The eth_abi 32-byte head encoding of these static types is identical to
   * ethers' defaultAbiCoder — so this is the exact algorithm encoder.py runs.
   */
  function pyComputeStructHash(order) {
    const typehash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(ORDER_TYPE_STRING));
    const encoded = ethers.utils.defaultAbiCoder.encode(
      [
        "bytes32", // typehash
        "uint256", // salt
        "address", // maker
        "address", // signer
        "bytes32", // positionId
        "address", // collateralToken
        "uint8",   // side
        "uint128", // amount
        "uint128", // pricePerToken
        "uint64",  // expiration
        "uint256", // nonce
      ],
      [
        typehash,
        order.salt,
        order.maker,
        order.signer,
        order.positionId,
        order.collateralToken,
        order.side,
        order.amount,
        order.pricePerToken,
        order.expiration,
        order.nonce,
      ],
    );
    return ethers.utils.keccak256(encoded);
  }

  /** Faithful JS port of `encoder.compute_domain_separator`. */
  function pyComputeDomainSeparator(name, version, chainId, verifyingContract) {
    const domainTypehash = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
      ),
    );
    return ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["bytes32", "bytes32", "bytes32", "uint256", "address"],
        [
          domainTypehash,
          ethers.utils.keccak256(ethers.utils.toUtf8Bytes(name)),
          ethers.utils.keccak256(ethers.utils.toUtf8Bytes(version)),
          chainId,
          verifyingContract,
        ],
      ),
    );
  }

  /** Faithful JS port of `encoder.compute_order_hash`. */
  function pyComputeOrderHash(order, domainSeparator) {
    const structHash = pyComputeStructHash(order);
    return ethers.utils.keccak256(
      ethers.utils.solidityPack(
        ["bytes1", "bytes1", "bytes32", "bytes32"],
        ["0x19", "0x01", domainSeparator, structHash],
      ),
    );
  }

  before(async function () {
    const Harness = await ethers.getContractFactory("DoefinOrderHarness");
    harness = await Harness.deploy();
    await harness.deployed();
  });

  it("typehash: Solidity == Python-port == frozen encoder.py value", async function () {
    const solidity = await harness.DOEFIN_ORDER_TYPEHASH();
    const pyPort = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(ORDER_TYPE_STRING));

    expect(solidity).to.equal(pyPort);
    expect(solidity).to.equal(FROZEN_ORDER_TYPEHASH);
  });

  it("domain typehash: Solidity == frozen encoder.py value", async function () {
    expect(await harness.DOMAIN_SEPARATOR_TYPEHASH()).to.equal(FROZEN_DOMAIN_TYPEHASH);
  });

  it("STRUCT HASH: Solidity harness == Python-port == ethers TypedDataEncoder == frozen value", async function () {
    // 1. On-chain implementation.
    const solidityHash = await harness.hash(FIXTURE_ORDER);

    // 2. JS port of encoder.compute_struct_hash (the backend spec).
    const pyPortHash = pyComputeStructHash(FIXTURE_ORDER);

    // 3. ethers' independent EIP-712 struct encoder.
    const ethersHash = ethers.utils._TypedDataEncoder.hashStruct(
      "DoefinOrder", ORDER_TYPE, FIXTURE_ORDER,
    );

    // All three runtimes must agree byte-for-byte.
    expect(solidityHash).to.equal(pyPortHash);
    expect(solidityHash).to.equal(ethersHash);

    // ...and equal the frozen value the real Python encoder emits.
    expect(solidityHash).to.equal(FROZEN_STRUCT_HASH);
  });

  it("DOMAIN SEPARATOR: Solidity harness == Python-port for the v3 domain", async function () {
    const verifyingContract = harness.address;

    const solidityDs = await harness.domainSeparator(
      DOMAIN_NAME, DOMAIN_VERSION, CHAIN_ID, verifyingContract,
    );
    const pyPortDs = pyComputeDomainSeparator(
      DOMAIN_NAME, DOMAIN_VERSION, CHAIN_ID, verifyingContract,
    );

    expect(solidityDs).to.equal(pyPortDs);
  });

  it("FULL ORDER DIGEST: Solidity harness == Python-port == ethers (\\x19\\x01 framing)", async function () {
    const verifyingContract = harness.address;
    const solidityDs = await harness.domainSeparator(
      DOMAIN_NAME, DOMAIN_VERSION, CHAIN_ID, verifyingContract,
    );

    // 1. On-chain full-digest implementation.
    const solidityDigest = await harness.hashOrder(FIXTURE_ORDER, solidityDs);

    // 2. JS port of encoder.compute_order_hash.
    const pyPortDigest = pyComputeOrderHash(FIXTURE_ORDER, solidityDs);

    // 3. ethers' EIP-712 full-message hash (the digest `_signTypedData` signs).
    const ethersDigest = ethers.utils._TypedDataEncoder.hash(
      { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: CHAIN_ID, verifyingContract },
      ORDER_TYPE,
      FIXTURE_ORDER,
    );

    expect(solidityDigest).to.equal(pyPortDigest);
    expect(solidityDigest).to.equal(ethersDigest);
  });

  it("differential holds across fuzzed orders (each field varied)", async function () {
    // INV-SIG-1 must hold for ANY order, not just the canonical fixture. Vary
    // every field and re-assert Solidity == Python-port == ethers on each.
    const variants = [
      { ...FIXTURE_ORDER, salt: ethers.BigNumber.from("123456789012345678901234567890") },
      { ...FIXTURE_ORDER, maker: "0x4444444444444444444444444444444444444444" },
      { ...FIXTURE_ORDER, signer: "0x0000000000000000000000000000000000000001" },
      { ...FIXTURE_ORDER, positionId: "0x" + "ab".repeat(32) },
      { ...FIXTURE_ORDER, collateralToken: "0xffffffffffffffffffffffffffffffffffffffff" },
      { ...FIXTURE_ORDER, side: 1 },
      { ...FIXTURE_ORDER, amount: ethers.BigNumber.from("340282366920938463463374607431768211455") }, // uint128 max
      { ...FIXTURE_ORDER, pricePerToken: 999999 },
      { ...FIXTURE_ORDER, expiration: 1893456000 },
      { ...FIXTURE_ORDER, nonce: ethers.BigNumber.from(2).pow(200) },
    ];

    for (const order of variants) {
      const solidityHash = await harness.hash(order);
      const pyPortHash = pyComputeStructHash(order);
      const ethersHash = ethers.utils._TypedDataEncoder.hashStruct(
        "DoefinOrder", ORDER_TYPE, order,
      );
      expect(solidityHash).to.equal(pyPortHash);
      expect(solidityHash).to.equal(ethersHash);
    }
  });
});
