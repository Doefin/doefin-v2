const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployDiamond } = require("../../scripts/deploy.js");

/**
 * Characterization test — access-control matrix (SCRUM-230 A3 / ARCH-02).
 *
 * Pins, for every privileged function whose authorization mechanism A3 touches,
 * the exact revert an unauthorized caller receives and that an authorized caller
 * succeeds. ARCH-02's named regression risk is revert-reason parity, so each row
 * asserts the precise error.
 *
 * Committed green against the pre-A3 code. After the refactor every row passes
 * unchanged EXCEPT prepareCondition: A3 standardizes its owner gate onto
 * LibDiamond.enforceIsContractOwner, so its revert changes NotAuthorized ->
 * NotContractOwner. That single intentional change is updated in the refactor
 * commit; every other row is strict parity.
 */

// A fully-zero DoefinOrder (10 fields) — only reaches the operator-gate modifier.
const EMPTY_ORDER = [
  0,
  ethers.constants.AddressZero,
  ethers.constants.AddressZero,
  ethers.constants.HashZero,
  ethers.constants.AddressZero,
  0,
  0,
  0,
  0,
  0,
];

describe("Characterization — access-control matrix (SCRUM-230 A3)", function () {
  this.timeout(180000);

  let diamond;
  let accessControl, ctf, adminConfig, ownership, settlement;
  let owner, stranger, other;

  beforeEach(async function () {
    [owner, stranger, other] = await ethers.getSigners();
    diamond = await deployDiamond();
    accessControl = await ethers.getContractAt("AccessControlFacet", diamond);
    ctf = await ethers.getContractAt("ConditionalTokensFacet", diamond);
    adminConfig = await ethers.getContractAt("AdminConfigFacet", diamond);
    ownership = await ethers.getContractAt("OwnershipFacet", diamond);
    settlement = await ethers.getContractAt("SettlementFacet", diamond);
  });

  describe("owner-only gates revert NotContractOwner for a non-owner", function () {
    it("AccessControlFacet.addMarketMaker", async function () {
      await expect(
        accessControl.connect(stranger).addMarketMaker(other.address)
      ).to.be.revertedWith("NotContractOwner()");
    });

    it("AccessControlFacet.removeMarketMaker", async function () {
      await expect(
        accessControl.connect(stranger).removeMarketMaker(other.address)
      ).to.be.revertedWith("NotContractOwner()");
    });

    it("AdminConfigFacet.setMaxFeeRate", async function () {
      await expect(
        adminConfig.connect(stranger).setMaxFeeRate(100)
      ).to.be.revertedWith("NotContractOwner()");
    });

    it("OwnershipFacet.transferOwnership", async function () {
      await expect(
        ownership.connect(stranger).transferOwnership(other.address)
      ).to.be.revertedWith("NotContractOwner()");
    });
  });

  describe("owner-only gates accept the owner", function () {
    it("addMarketMaker grants the role and emits MarketMakerStatusUpdated", async function () {
      await expect(accessControl.connect(owner).addMarketMaker(other.address))
        .to.emit(accessControl, "MarketMakerStatusUpdated")
        .withArgs(other.address, true);
      expect(await accessControl.isMarketMaker(other.address)).to.equal(true);
    });

    it("setMaxFeeRate succeeds for the owner", async function () {
      await adminConfig.connect(owner).setMaxFeeRate(100);
      expect(await adminConfig.getMaxFeeRate()).to.equal(100);
    });
  });

  describe("ConditionalTokensFacet.prepareCondition owner gate", function () {
    // A3 / ARCH-02: prepareCondition's owner gate was standardized onto
    // LibDiamond.enforceIsContractOwner — its revert is now NotContractOwner
    // (was NotAuthorized pre-A3). This is the one intentional revert-reason
    // change in A3; every other row of the matrix is strict parity.
    it("reverts for a non-owner caller", async function () {
      await expect(
        ctf.connect(stranger).prepareCondition(other.address, ethers.constants.HashZero, 2)
      ).to.be.revertedWith("NotContractOwner()");
    });
  });

  describe("operator-only gates reject a non-operator", function () {
    // Called by a non-operator, the only revert reachable before the function
    // body is the onlyOperator gate — UnauthorizedOperator(caller), selector
    // 0x740fbe61. Asserted generically because waffle 3.4 does not decode this
    // custom error; the SettlementFacet suite covers the operator success path.
    it("SettlementFacet.matchOrders", async function () {
      await expect(
        settlement
          .connect(stranger)
          .matchOrders(EMPTY_ORDER, "0x", 0, [], [], [], 0, [], [], [])
      ).to.be.reverted;
    });

    it("SettlementFacet.fillOrder", async function () {
      await expect(
        settlement.connect(stranger).fillOrder(EMPTY_ORDER, "0x", 0, 0, 0)
      ).to.be.reverted;
    });
  });
});
