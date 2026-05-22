// LibPositionRegistry — coverage
// ============================================================================
// Raises coverage of `contracts/libraries/LibPositionRegistry.sol`.
//
// In production the library is reached only through
// `LibCTFCondition._splitPosition` (which derives CTF-consistent arguments)
// and `MarketDataFacet` view lookups — so its input-validation and
// re-registration-consistency branches cannot be driven with arbitrary
// arguments through any facet. `LibPositionRegistryHarness` exposes the
// internal functions directly, on its own storage namespace.
//
// Two branches remain unreachable BY CONSTRUCTION and are intentionally not
// tested (documented for the auditors):
//   * registerPositionPairs `meta.collateralToken != collateralToken || ...`
//     — `marketKey = keccak256(conditionId, parentCollectionId,
//     collateralToken)`, so reaching the re-registration branch (marketKey
//     hit) already implies those fields match. Dead-defensive.
//   * getComplement `PositionNotFound` — a positionId can only carry a
//     marketKey if `registerPositionPairs` also placed it in that market's
//     `positionIds` array, so the "registered but not in the array" state is
//     unconstructible. Dead-defensive.

const { expect } = require("chai");
const { ethers } = require("hardhat");

const COND_1 = ethers.utils.id("lpr-coverage-condition-1");
const COND_2 = ethers.utils.id("lpr-coverage-condition-2");
const PARENT = ethers.constants.HashZero;
const COLLATERAL = "0x1111111111111111111111111111111111111111";

// Arbitrary position-token ids — the harness stores whatever it is given.
const pA = 1001, pB = 1002, pC = 1003, pZ = 2001;
const UNREGISTERED = 999999;

describe("LibPositionRegistry — coverage", function () {
  let harness;

  beforeEach(async function () {
    const H = await ethers.getContractFactory("LibPositionRegistryHarness");
    harness = await H.deploy();
    await harness.deployed();
  });

  describe("registerPositionPairs", function () {
    it("registers a new market and the lookups read it back (first-registration path)", async function () {
      await harness.registerPositionPairs([pA, pB], [1, 2], COND_1, PARENT, COLLATERAL);

      expect(await harness.getConditionId(pA)).to.equal(COND_1);
      expect(await harness.getConditionId(pB)).to.equal(COND_1);
      expect(await harness.getCollateralToken(pA)).to.equal(COLLATERAL);

      const meta = await harness.getMarketMetadata(pA);
      expect(meta.collateralToken).to.equal(COLLATERAL);
      expect(meta.parentCollectionId).to.equal(PARENT);
      expect(meta.positionIds.map((x) => x.toNumber())).to.deep.equal([pA, pB]);
    });

    it("reverts MismatchedInputLengths when positionIds and partitions differ in length (L153)", async function () {
      await expect(
        harness.registerPositionPairs([pA, pB], [1], COND_1, PARENT, COLLATERAL),
      ).to.be.revertedWith("MismatchedInputLengths()");
    });

    it("accepts an identical re-registration of the same market (consistency path)", async function () {
      await harness.registerPositionPairs([pA, pB], [1, 2], COND_1, PARENT, COLLATERAL);
      // Same marketKey, identical arrays — the consistency checks all pass.
      await harness.registerPositionPairs([pA, pB], [1, 2], COND_1, PARENT, COLLATERAL);
      expect(await harness.getConditionId(pA)).to.equal(COND_1);
    });

    it("reverts InvalidMatch when a re-registration changes the position-array length (L179)", async function () {
      await harness.registerPositionPairs([pA, pB], [1, 2], COND_1, PARENT, COLLATERAL);
      // Same marketKey (same condition/parent/collateral), shorter arrays.
      await expect(
        harness.registerPositionPairs([pA], [1], COND_1, PARENT, COLLATERAL),
      ).to.be.revertedWith("InvalidMatch()");
    });

    it("reverts InvalidMatch when a re-registration reorders the positions (L184)", async function () {
      await harness.registerPositionPairs([pA, pB], [1, 2], COND_1, PARENT, COLLATERAL);
      // Same marketKey, same length, element-wise divergent.
      await expect(
        harness.registerPositionPairs([pB, pA], [2, 1], COND_1, PARENT, COLLATERAL),
      ).to.be.revertedWith("InvalidMatch()");
    });

    it("reverts InvalidMatch when a positionId is reused across two conditions (L194)", async function () {
      await harness.registerPositionPairs([pA, pB], [1, 2], COND_1, PARENT, COLLATERAL);
      // COND_2 → a different marketKey; pA is already mapped to COND_1's market.
      await expect(
        harness.registerPositionPairs([pA, pZ], [1, 2], COND_2, PARENT, COLLATERAL),
      ).to.be.revertedWith("InvalidMatch()");
    });
  });

  describe("getComplement", function () {
    it("returns the opposite position of a binary market, both directions", async function () {
      await harness.registerPositionPairs([pA, pB], [1, 2], COND_1, PARENT, COLLATERAL);
      expect(await harness.getComplement(pA)).to.equal(pB);
      expect(await harness.getComplement(pB)).to.equal(pA);
    });

    it("reverts InvalidComplement for a non-binary (3-outcome) market", async function () {
      await harness.registerPositionPairs([pA, pB, pC], [1, 2, 4], COND_1, PARENT, COLLATERAL);
      await expect(harness.getComplement(pA)).to.be.revertedWith("InvalidComplement()");
    });

    it("reverts InvalidPositionId for an unregistered position", async function () {
      await expect(harness.getComplement(UNREGISTERED)).to.be.revertedWith("InvalidPositionId()");
    });
  });

  describe("view lookups", function () {
    beforeEach(async function () {
      await harness.registerPositionPairs([pA, pB], [1, 2], COND_1, PARENT, COLLATERAL);
    });

    it("getConditionId reverts InvalidPositionId for an unregistered position", async function () {
      await expect(harness.getConditionId(UNREGISTERED)).to.be.revertedWith("InvalidPositionId()");
    });

    it("getCollateralToken reverts InvalidPositionId for an unregistered position", async function () {
      await expect(harness.getCollateralToken(UNREGISTERED)).to.be.revertedWith("InvalidPositionId()");
    });

    it("validatePositionId passes for a registered position and reverts otherwise", async function () {
      await harness.validatePositionId(pA); // no revert
      await expect(harness.validatePositionId(UNREGISTERED)).to.be.revertedWith("InvalidPositionId()");
    });

    it("getMarketMetadata reverts InvalidPositionId for an unregistered position", async function () {
      await expect(harness.getMarketMetadata(UNREGISTERED)).to.be.revertedWith("InvalidPositionId()");
    });

    it("getMarketsForCondition returns the registered markets, empty for an unknown condition", async function () {
      const markets = await harness.getMarketsForCondition(COND_1);
      expect(markets.length).to.equal(1);
      expect(markets[0].collateralToken).to.equal(COLLATERAL);

      const none = await harness.getMarketsForCondition(ethers.utils.id("never-registered"));
      expect(none.length).to.equal(0);
    });

    it("buildMarketKey is the keccak256 of (conditionId, parentCollectionId, collateralToken)", async function () {
      const expected = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ["bytes32", "bytes32", "address"], [COND_1, PARENT, COLLATERAL],
        ),
      );
      expect(await harness.buildMarketKey(COND_1, PARENT, COLLATERAL)).to.equal(expected);
    });
  });
});
