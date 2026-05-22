const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployDiamond } = require("../../scripts/deploy.js");

/**
 * Characterization test — settlement governance (SCRUM-230 A2 / ARCH-01).
 *
 * Pins the observable behavior of the owner-only settlement governance functions
 * — setOperator, pauseTrading, unpauseTrading, getOperator, isTradingPaused — and
 * the pause gate on matchOrders.
 *
 * Written before the ARCH-01 facet extraction and refactor-invariant: the five
 * governance selectors are addressed through a minimal ABI on the Diamond, so this
 * suite passes unchanged whether they are served by SettlementFacet or by the
 * extracted SettlementAdminFacet. matchOrders is reached through the SettlementFacet
 * handle — it never moves.
 */

const ADMIN_ABI = [
  "function setOperator(address) external",
  "function pauseTrading() external",
  "function unpauseTrading() external",
  "function getOperator() external view returns (address)",
  "function isTradingPaused() external view returns (bool)",
  "event OperatorUpdated(address indexed oldOperator, address indexed newOperator)",
  "event SettlementTradingPaused(address indexed admin)",
  "event SettlementTradingUnpaused(address indexed admin)",
];

// A fully-zero DoefinOrder (10 fields). Only used to reach matchOrders' modifier
// chain — onlyOperator -> notPaused run before any argument validation.
const EMPTY_ORDER = [
  0, // salt
  ethers.constants.AddressZero, // maker
  ethers.constants.AddressZero, // signer
  ethers.constants.HashZero, // positionId
  ethers.constants.AddressZero, // collateralToken
  0, // side
  0, // amount
  0, // pricePerToken
  0, // expiration
  0, // nonce
];

describe("Characterization — settlement governance (SCRUM-230 A2)", function () {
  this.timeout(120000);

  let diamond, admin, settlement;
  let owner, operator, stranger;

  beforeEach(async function () {
    [owner, operator, stranger] = await ethers.getSigners();
    diamond = await deployDiamond();
    admin = new ethers.Contract(diamond, ADMIN_ABI, owner);
    settlement = await ethers.getContractAt("SettlementFacet", diamond);
  });

  function callMatchOrders(signer) {
    return settlement
      .connect(signer)
      .matchOrders(EMPTY_ORDER, "0x", 0, [], [], [], 0, [], [], []);
  }

  describe("setOperator", function () {
    it("reverts for a non-owner caller", async function () {
      await expect(
        admin.connect(stranger).setOperator(operator.address)
      ).to.be.revertedWith("NotContractOwner()");
    });

    it("reverts when setting the zero address", async function () {
      await expect(
        admin.connect(owner).setOperator(ethers.constants.AddressZero)
      ).to.be.revertedWith("ZeroAddress()");
    });

    it("sets the operator and emits OperatorUpdated for the owner", async function () {
      const oldOperator = await admin.getOperator();
      await expect(admin.connect(owner).setOperator(operator.address))
        .to.emit(admin, "OperatorUpdated")
        .withArgs(oldOperator, operator.address);
      expect(await admin.getOperator()).to.equal(operator.address);
    });
  });

  describe("pauseTrading / unpauseTrading", function () {
    it("pauseTrading reverts for a non-owner caller", async function () {
      await expect(
        admin.connect(stranger).pauseTrading()
      ).to.be.revertedWith("NotContractOwner()");
    });

    it("unpauseTrading reverts for a non-owner caller", async function () {
      await expect(
        admin.connect(stranger).unpauseTrading()
      ).to.be.revertedWith("NotContractOwner()");
    });

    it("owner pauses and unpauses; isTradingPaused tracks the flag", async function () {
      expect(await admin.isTradingPaused()).to.equal(false);

      await expect(admin.connect(owner).pauseTrading())
        .to.emit(admin, "SettlementTradingPaused")
        .withArgs(owner.address);
      expect(await admin.isTradingPaused()).to.equal(true);

      await expect(admin.connect(owner).unpauseTrading())
        .to.emit(admin, "SettlementTradingUnpaused")
        .withArgs(owner.address);
      expect(await admin.isTradingPaused()).to.equal(false);
    });
  });

  describe("pause gate on matchOrders", function () {
    it("matchOrders reverts while paused (operator call hits the pause gate)", async function () {
      await admin.connect(owner).setOperator(operator.address);
      await admin.connect(owner).pauseTrading();
      // Called as the operator, the only revert reachable before the function
      // body is the notPaused gate — TradingIsPaused, selector 0x6af3eee6.
      // (Asserted generically, as the existing suite does, because waffle 3.4
      // does not decode this particular custom error; the unpause test below
      // proves the gate, not later validation, is what blocks the call.)
      await expect(callMatchOrders(operator)).to.be.reverted;
    });

    it("after unpause, matchOrders passes the pause gate", async function () {
      await admin.connect(owner).setOperator(operator.address);
      await admin.connect(owner).pauseTrading();
      await admin.connect(owner).unpauseTrading();
      // Past the pause gate the empty call fails later validation
      // (ZeroAmount on takerFillAmount == 0) — proving the gate was lifted.
      await expect(callMatchOrders(operator)).to.be.revertedWith(
        "ZeroAmount()"
      );
    });
  });
});

/**
 * Post-extraction wiring check (SCRUM-230 A2 / ARCH-01).
 *
 * Confirms the diamondCut routed the five governance selectors to the extracted
 * SettlementAdminFacet and that the matchOrders hot path stays on a distinct
 * facet — the structural boundary the extraction created.
 */
describe("Facet wiring — SettlementAdminFacet extraction (SCRUM-230 A2)", function () {
  this.timeout(120000);

  it("the 5 governance selectors resolve to one facet, distinct from matchOrders' facet", async function () {
    const diamond = await deployDiamond();
    const loupe = await ethers.getContractAt("DiamondLoupeFacet", diamond);

    const adminIface = (await ethers.getContractFactory("SettlementAdminFacet"))
      .interface;
    const settlementIface = (await ethers.getContractFactory("SettlementFacet"))
      .interface;

    const govSelectors = [
      "setOperator",
      "pauseTrading",
      "unpauseTrading",
      "getOperator",
      "isTradingPaused",
    ].map((n) => adminIface.getSighash(n));

    const adminFacet = await loupe.facetAddress(govSelectors[0]);
    expect(adminFacet).to.not.equal(ethers.constants.AddressZero);
    for (const s of govSelectors) {
      expect(await loupe.facetAddress(s)).to.equal(adminFacet);
    }

    // The hot path stays on SettlementFacet — a different facet address.
    const matchOrdersFacet = await loupe.facetAddress(
      settlementIface.getSighash("matchOrders")
    );
    expect(matchOrdersFacet).to.not.equal(ethers.constants.AddressZero);
    expect(matchOrdersFacet).to.not.equal(adminFacet);
  });
});
