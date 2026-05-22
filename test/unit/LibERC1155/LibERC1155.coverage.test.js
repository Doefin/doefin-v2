// LibERC1155 — coverage
// ============================================================================
// Raises branch coverage of `contracts/libraries/LibERC1155.sol`. The library
// is exercised two ways:
//
//   1. Through `ERC1155Facet` on the audit-fixture Diamond — the real facet
//      entrypoints (balanceOf / balanceOfBatch / isApprovedForAll /
//      safeTransferFrom / safeBatchTransferFrom), driven down their
//      input-validation and receiver-acceptance branches.
//   2. Through `LibERC1155Harness` for the internal `_mint` / `_batchMint` /
//      `_batchBurn` helpers, whose only production callers (the CTF split /
//      merge / redeem flows) always pass well-formed arguments — so their
//      input-validation reverts are unreachable through any facet.
//
// `BadERC1155Receiver` returns a non-magic selector, exercising the
// `_doSafeTransfer*AcceptanceCheck` rejection branches.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupAuditFixture } = require("../../utils/auditFixture.js");

const ZERO = ethers.constants.AddressZero;

describe("LibERC1155 — coverage", function () {
  // ──────────────────────────────────────────────────────────────────────
  // Facet-driven — ERC1155Facet on the audit-fixture Diamond
  // ──────────────────────────────────────────────────────────────────────
  describe("via ERC1155Facet", function () {
    let ctx;
    beforeEach(async function () {
      ctx = await setupAuditFixture();
    });

    it("balanceOf reverts ZeroAddressQuery for the zero address (L14)", async function () {
      const { erc1155Facet } = ctx.contracts;
      const { positionIdA } = ctx.market;
      await expect(erc1155Facet.balanceOf(ZERO, positionIdA)).to.be.revertedWith("ZeroAddressQuery()");
    });

    it("balanceOfBatch returns an empty array for empty inputs (L19)", async function () {
      const { erc1155Facet } = ctx.contracts;
      expect(await erc1155Facet.balanceOfBatch([], [])).to.deep.equal([]);
    });

    it("balanceOfBatch reverts ArrayLengthMismatch for unequal lengths (L22)", async function () {
      const { erc1155Facet } = ctx.contracts;
      const { seller } = ctx.signers;
      const { positionIdA, positionIdB } = ctx.market;
      await expect(
        erc1155Facet.balanceOfBatch([seller.address], [positionIdA, positionIdB]),
      ).to.be.revertedWith("ArrayLengthMismatch()");
    });

    it("balanceOfBatch reverts ZeroAddressQuery for a zero-address entry (L25)", async function () {
      const { erc1155Facet } = ctx.contracts;
      const { positionIdA } = ctx.market;
      await expect(
        erc1155Facet.balanceOfBatch([ZERO], [positionIdA]),
      ).to.be.revertedWith("ZeroAddressQuery()");
    });

    it("balanceOfBatch returns per-entry balances for valid inputs (L18 happy path)", async function () {
      const { erc1155Facet } = ctx.contracts;
      const { seller, buyerB } = ctx.signers;
      const { positionIdA, positionIdB } = ctx.market;
      const seeded = ethers.utils.parseUnits("10000", 6); // fixture split amount
      const out = await erc1155Facet.balanceOfBatch(
        [seller.address, buyerB.address], [positionIdA, positionIdB],
      );
      expect(out[0]).to.equal(seeded);
      expect(out[1]).to.equal(seeded);
    });

    it("isApprovedForAll reads the operator-approval flag (L40)", async function () {
      const { erc1155Facet } = ctx.contracts;
      const { seller, attacker } = ctx.signers;
      const { diamondAddress } = ctx;
      // The fixture set every actor's approval for the Diamond.
      expect(await erc1155Facet.isApprovedForAll(seller.address, diamondAddress)).to.equal(true);
      expect(await erc1155Facet.isApprovedForAll(seller.address, attacker.address)).to.equal(false);
    });

    it("safeTransferFrom reverts TransferToZeroAddress when `to` is zero (L52)", async function () {
      const { erc1155Facet } = ctx.contracts;
      const { seller } = ctx.signers;
      const { positionIdA } = ctx.market;
      await expect(
        erc1155Facet.connect(seller).safeTransferFrom(seller.address, ZERO, positionIdA, 1, "0x"),
      ).to.be.revertedWith("TransferToZeroAddress()");
    });

    it("safeTransferFrom reverts TransferToZeroAddress when `from` is zero (L52)", async function () {
      const { erc1155Facet } = ctx.contracts;
      const { seller } = ctx.signers;
      const { positionIdA } = ctx.market;
      await expect(
        erc1155Facet.connect(seller).safeTransferFrom(ZERO, seller.address, positionIdA, 1, "0x"),
      ).to.be.revertedWith("TransferToZeroAddress()");
    });

    it("safeTransferFrom reverts NotOwnerNorApproved for an unapproved caller (L56)", async function () {
      const { erc1155Facet } = ctx.contracts;
      const { seller, attacker } = ctx.signers;
      const { positionIdA } = ctx.market;
      // attacker is neither `from` nor an approved operator of seller.
      await expect(
        erc1155Facet.connect(attacker).safeTransferFrom(seller.address, attacker.address, positionIdA, 1, "0x"),
      ).to.be.revertedWith("NotOwnerNorApproved()");
    });

    it("safeTransferFrom reverts ERC1155ReceiverRejectedTokens for a rejecting receiver (L167)", async function () {
      const { erc1155Facet } = ctx.contracts;
      const { seller } = ctx.signers;
      const { positionIdA } = ctx.market;
      const Bad = await ethers.getContractFactory("BadERC1155Receiver");
      const bad = await Bad.deploy();
      await bad.deployed();
      await expect(
        erc1155Facet.connect(seller).safeTransferFrom(seller.address, bad.address, positionIdA, 1, "0x"),
      ).to.be.revertedWith("ERC1155ReceiverRejectedTokens()");
    });

    it("safeBatchTransferFrom reverts TransferToZeroAddress when `to` is zero (L76)", async function () {
      const { erc1155Facet } = ctx.contracts;
      const { seller } = ctx.signers;
      const { positionIdA } = ctx.market;
      await expect(
        erc1155Facet.connect(seller).safeBatchTransferFrom(seller.address, ZERO, [positionIdA], [1], "0x"),
      ).to.be.revertedWith("TransferToZeroAddress()");
    });

    it("safeBatchTransferFrom reverts EmptyArray for empty inputs (L77)", async function () {
      const { erc1155Facet } = ctx.contracts;
      const { seller, buyer } = ctx.signers;
      await expect(
        erc1155Facet.connect(seller).safeBatchTransferFrom(seller.address, buyer.address, [], [], "0x"),
      ).to.be.revertedWith("EmptyArray()");
    });

    it("safeBatchTransferFrom reverts ArrayLengthMismatch for unequal lengths (L78)", async function () {
      const { erc1155Facet } = ctx.contracts;
      const { seller, buyer } = ctx.signers;
      const { positionIdA, positionIdB } = ctx.market;
      await expect(
        erc1155Facet.connect(seller).safeBatchTransferFrom(
          seller.address, buyer.address, [positionIdA, positionIdB], [1], "0x",
        ),
      ).to.be.revertedWith("ArrayLengthMismatch()");
    });

    it("safeBatchTransferFrom reverts NotOwnerNorApproved for an unapproved caller (L82)", async function () {
      const { erc1155Facet } = ctx.contracts;
      const { seller, attacker } = ctx.signers;
      const { positionIdA } = ctx.market;
      await expect(
        erc1155Facet.connect(attacker).safeBatchTransferFrom(
          seller.address, attacker.address, [positionIdA], [1], "0x",
        ),
      ).to.be.revertedWith("NotOwnerNorApproved()");
    });

    it("safeBatchTransferFrom reverts ERC1155ReceiverRejectedTokens for a rejecting receiver (L181)", async function () {
      const { erc1155Facet } = ctx.contracts;
      const { seller } = ctx.signers;
      const { positionIdA } = ctx.market;
      const Bad = await ethers.getContractFactory("BadERC1155Receiver");
      const bad = await Bad.deploy();
      await bad.deployed();
      await expect(
        erc1155Facet.connect(seller).safeBatchTransferFrom(seller.address, bad.address, [positionIdA], [1], "0x"),
      ).to.be.revertedWith("ERC1155ReceiverRejectedTokens()");
    });

    it("safeBatchTransferFrom moves balances on the happy path (L68)", async function () {
      const { erc1155Facet } = ctx.contracts;
      const { seller, buyer } = ctx.signers;
      const { positionIdA } = ctx.market;
      const amount = ethers.utils.parseUnits("100", 6);

      const sellerBefore = await erc1155Facet.balanceOf(seller.address, positionIdA);
      const buyerBefore = await erc1155Facet.balanceOf(buyer.address, positionIdA);

      await erc1155Facet.connect(seller).safeBatchTransferFrom(
        seller.address, buyer.address, [positionIdA], [amount], "0x",
      );

      expect(sellerBefore.sub(await erc1155Facet.balanceOf(seller.address, positionIdA))).to.equal(amount);
      expect((await erc1155Facet.balanceOf(buyer.address, positionIdA)).sub(buyerBefore)).to.equal(amount);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Harness-driven — internal _mint / _batchMint / _batchBurn helpers
  // ──────────────────────────────────────────────────────────────────────
  describe("via LibERC1155Harness (internal helpers)", function () {
    let harness, alice;
    beforeEach(async function () {
      const H = await ethers.getContractFactory("LibERC1155Harness");
      harness = await H.deploy();
      await harness.deployed();
      [, alice] = await ethers.getSigners();
    });

    it("_mint credits the recipient (L95 happy path)", async function () {
      await harness.mint(alice.address, 1, 500, "0x");
      expect(await harness.balanceOf(alice.address, 1)).to.equal(500);
    });

    it("_mint reverts MintToZeroAddress for the zero address (L101)", async function () {
      await expect(harness.mint(ZERO, 1, 500, "0x")).to.be.revertedWith("MintToZeroAddress()");
    });

    it("_batchMint reverts MintToZeroAddress for the zero address (L116)", async function () {
      await expect(harness.batchMint(ZERO, [1], [500], "0x")).to.be.revertedWith("MintToZeroAddress()");
    });

    it("_batchMint reverts ArrayLengthMismatch for unequal lengths (L117)", async function () {
      await expect(
        harness.batchMint(alice.address, [1, 2], [500], "0x"),
      ).to.be.revertedWith("ArrayLengthMismatch()");
    });

    it("_batchMint credits each id, then _batchBurn debits it (happy paths)", async function () {
      await harness.batchMint(alice.address, [1, 2], [500, 700], "0x");
      expect(await harness.balanceOf(alice.address, 1)).to.equal(500);
      expect(await harness.balanceOf(alice.address, 2)).to.equal(700);

      await harness.batchBurn(alice.address, [1, 2], [200, 700]);
      expect(await harness.balanceOf(alice.address, 1)).to.equal(300);
      expect(await harness.balanceOf(alice.address, 2)).to.equal(0);
    });

    it("_batchBurn reverts ArrayLengthMismatch for unequal lengths (L146)", async function () {
      await expect(
        harness.batchBurn(alice.address, [1, 2], [200]),
      ).to.be.revertedWith("ArrayLengthMismatch()");
    });
  });
});
