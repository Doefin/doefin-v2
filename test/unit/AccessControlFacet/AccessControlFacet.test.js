const { deployDiamond } = require("../../../scripts/deploy.js");
const { expect } = require("chai");
const { ethers } = require("hardhat");

const {
  takeSnapshot,
  revertToSnapshot,
} = require("../../utils/snapshotUtils.js");

describe("AccessControlFacet", function () {
  let owner, user1, user2, user3, marketMaker1, marketMaker2;
  let diamondAddress, accessControlFacet;
  let snapshotId;

  before(async function () {
    [owner, user1, user2, user3, marketMaker1, marketMaker2] =
      await ethers.getSigners();

    diamondAddress = await deployDiamond();
    accessControlFacet = await ethers.getContractAt(
      "AccessControlFacet",
      diamondAddress
    );
  });

  beforeEach(async () => {
    snapshotId = await takeSnapshot();
  });

  afterEach(async () => {
    await revertToSnapshot(snapshotId);
  });

  describe("Market Maker Management", function () {
    it("should allow owner to add market maker", async () => {
      await expect(
        accessControlFacet.connect(owner).addMarketMaker(marketMaker1.address)
      )
        .to.emit(accessControlFacet, "MarketMakerStatusUpdated")
        .withArgs(marketMaker1.address, true);

      expect(await accessControlFacet.isMarketMaker(marketMaker1.address)).to.be
        .true;
    });

    it("should allow owner to remove market maker", async () => {
      // First add market maker
      await accessControlFacet
        .connect(owner)
        .addMarketMaker(marketMaker1.address);
      expect(await accessControlFacet.isMarketMaker(marketMaker1.address)).to.be
        .true;

      // Then remove
      await expect(
        accessControlFacet
          .connect(owner)
          .removeMarketMaker(marketMaker1.address)
      )
        .to.emit(accessControlFacet, "MarketMakerStatusUpdated")
        .withArgs(marketMaker1.address, false);

      expect(await accessControlFacet.isMarketMaker(marketMaker1.address)).to.be
        .false;
    });

    it("should revert if non-owner tries to add market maker", async () => {
      await expect(
        accessControlFacet.connect(user1).addMarketMaker(marketMaker1.address)
      ).to.be.revertedWith("NotContractOwner()");
    });

    it("should revert if non-owner tries to remove market maker", async () => {
      await accessControlFacet
        .connect(owner)
        .addMarketMaker(marketMaker1.address);

      await expect(
        accessControlFacet
          .connect(user1)
          .removeMarketMaker(marketMaker1.address)
      ).to.be.revertedWith("NotContractOwner()");
    });

    it("should revert when adding zero address as market maker", async () => {
      await expect(
        accessControlFacet
          .connect(owner)
          .addMarketMaker(ethers.constants.AddressZero)
      ).to.be.revertedWith("InvalidMakerAddress()");
    });

    it("should revert when removing zero address as market maker", async () => {
      await expect(
        accessControlFacet
          .connect(owner)
          .removeMarketMaker(ethers.constants.AddressZero)
      ).to.be.revertedWith("InvalidMakerAddress()");
    });

    it("should revert when adding already existing market maker", async () => {
      await accessControlFacet
        .connect(owner)
        .addMarketMaker(marketMaker1.address);

      await expect(
        accessControlFacet.connect(owner).addMarketMaker(marketMaker1.address)
      ).to.be.revertedWith("AlreadyMarketMaker()");
    });

    it("should handle multiple market makers", async () => {
      // Add multiple market makers
      await accessControlFacet
        .connect(owner)
        .addMarketMaker(marketMaker1.address);
      await accessControlFacet
        .connect(owner)
        .addMarketMaker(marketMaker2.address);

      expect(await accessControlFacet.isMarketMaker(marketMaker1.address)).to.be
        .true;
      expect(await accessControlFacet.isMarketMaker(marketMaker2.address)).to.be
        .true;
      expect(await accessControlFacet.isMarketMaker(user1.address)).to.be.false;

      // Remove one market maker
      await accessControlFacet
        .connect(owner)
        .removeMarketMaker(marketMaker1.address);

      expect(await accessControlFacet.isMarketMaker(marketMaker1.address)).to.be
        .false;
      expect(await accessControlFacet.isMarketMaker(marketMaker2.address)).to.be
        .true;
    });

    it("should return correct market maker status for various addresses", async () => {
      // Initially no one should be market maker
      expect(await accessControlFacet.isMarketMaker(marketMaker1.address)).to.be
        .false;
      expect(await accessControlFacet.isMarketMaker(user1.address)).to.be.false;
      expect(await accessControlFacet.isMarketMaker(owner.address)).to.be.false;

      // Add market maker
      await accessControlFacet
        .connect(owner)
        .addMarketMaker(marketMaker1.address);

      expect(await accessControlFacet.isMarketMaker(marketMaker1.address)).to.be
        .true;
      expect(await accessControlFacet.isMarketMaker(user1.address)).to.be.false;
      expect(await accessControlFacet.isMarketMaker(owner.address)).to.be.false;
    });
  });

  describe("Access Control Integration", function () {
    it("should work with other facets requiring market maker role", async () => {
      const conditionManagerFacet = await ethers.getContractAt(
        "ConditionManagerFacet",
        diamondAddress
      );

      const questionId = ethers.utils.id("test-question");
      const outcomeSlotCount = 2;

      // Should fail without market maker role
      await expect(
        conditionManagerFacet
          .connect(user1)
          .createCondition(
            user1.address,
            questionId,
            outcomeSlotCount,
            "ipfs://test"
          )
      ).to.be.revertedWith("NotMarketMaker()");

      // Add user as market maker
      await accessControlFacet.connect(owner).addMarketMaker(user1.address);

      // Should succeed with market maker role
      await expect(
        conditionManagerFacet
          .connect(user1)
          .createCondition(
            user1.address,
            questionId,
            outcomeSlotCount,
            "ipfs://test"
          )
      ).to.not.be.reverted;
    });

    it("should maintain access control after market maker removal", async () => {
      const conditionManagerFacet = await ethers.getContractAt(
        "ConditionManagerFacet",
        diamondAddress
      );

      // Add and then remove market maker
      await accessControlFacet.connect(owner).addMarketMaker(user1.address);
      await accessControlFacet.connect(owner).removeMarketMaker(user1.address);

      const questionId = ethers.utils.id("test-question-2");
      const outcomeSlotCount = 2;

      // Should fail after removal
      await expect(
        conditionManagerFacet
          .connect(user1)
          .createCondition(
            user1.address,
            questionId,
            outcomeSlotCount,
            "ipfs://test-2"
          )
      ).to.be.revertedWith("NotMarketMaker()");
    });
  });

  describe("Edge Cases and Security", function () {
    it("should handle owner as market maker", async () => {
      // Owner can add themselves as market maker
      await accessControlFacet.connect(owner).addMarketMaker(owner.address);
      expect(await accessControlFacet.isMarketMaker(owner.address)).to.be.true;

      // Owner can remove themselves as market maker
      await accessControlFacet.connect(owner).removeMarketMaker(owner.address);
      expect(await accessControlFacet.isMarketMaker(owner.address)).to.be.false;
    });

    it("should handle rapid add/remove operations", async () => {
      // Rapid add/remove cycles
      for (let i = 0; i < 5; i++) {
        await accessControlFacet
          .connect(owner)
          .addMarketMaker(marketMaker1.address);
        expect(await accessControlFacet.isMarketMaker(marketMaker1.address)).to
          .be.true;

        await accessControlFacet
          .connect(owner)
          .removeMarketMaker(marketMaker1.address);
        expect(await accessControlFacet.isMarketMaker(marketMaker1.address)).to
          .be.false;
      }
    });

    it("should maintain state consistency across multiple operations", async () => {
      const addresses = [
        marketMaker1.address,
        marketMaker2.address,
        user1.address,
        user2.address,
      ];

      // Add all as market makers
      for (const addr of addresses) {
        await accessControlFacet.connect(owner).addMarketMaker(addr);
        expect(await accessControlFacet.isMarketMaker(addr)).to.be.true;
      }

      // Remove every other one
      for (let i = 0; i < addresses.length; i += 2) {
        await accessControlFacet.connect(owner).removeMarketMaker(addresses[i]);
        expect(await accessControlFacet.isMarketMaker(addresses[i])).to.be
          .false;
      }

      // Verify remaining ones are still market makers
      for (let i = 1; i < addresses.length; i += 2) {
        expect(await accessControlFacet.isMarketMaker(addresses[i])).to.be.true;
      }
    });

    it("should handle contract address as market maker", async () => {
      // Use the diamond address itself as market maker (edge case)
      await accessControlFacet.connect(owner).addMarketMaker(diamondAddress);
      expect(await accessControlFacet.isMarketMaker(diamondAddress)).to.be.true;

      await accessControlFacet.connect(owner).removeMarketMaker(diamondAddress);
      expect(await accessControlFacet.isMarketMaker(diamondAddress)).to.be
        .false;
    });
  });

  describe("Gas Optimization", function () {
    it("should efficiently handle large number of market makers", async () => {
      const numMarketMakers = 20;
      const marketMakers = [];

      // Generate test addresses
      for (let i = 0; i < numMarketMakers; i++) {
        marketMakers.push(ethers.Wallet.createRandom().address);
      }

      const startTime = Date.now();

      // Add all market makers
      for (const addr of marketMakers) {
        await accessControlFacet.connect(owner).addMarketMaker(addr);
      }

      // Verify all are added
      for (const addr of marketMakers) {
        expect(await accessControlFacet.isMarketMaker(addr)).to.be.true;
      }

      // Remove all market makers
      for (const addr of marketMakers) {
        await accessControlFacet.connect(owner).removeMarketMaker(addr);
      }

      // Verify all are removed
      for (const addr of marketMakers) {
        expect(await accessControlFacet.isMarketMaker(addr)).to.be.false;
      }

      const endTime = Date.now();
      console.log(
        `Time for ${numMarketMakers} market makers operations: ${
          endTime - startTime
        }ms`
      );

      // Should complete within reasonable time
      expect(endTime - startTime).to.be.lessThan(30000); // 30 seconds
    });

    it("should have consistent gas costs for market maker operations", async () => {
      const addresses = [user1.address, user2.address, user3.address];
      const addGasCosts = [];
      const removeGasCosts = [];

      for (const addr of addresses) {
        // Measure add gas cost
        const addTx = await accessControlFacet
          .connect(owner)
          .addMarketMaker(addr);
        const addReceipt = await addTx.wait();
        addGasCosts.push(addReceipt.gasUsed);

        // Measure remove gas cost
        const removeTx = await accessControlFacet
          .connect(owner)
          .removeMarketMaker(addr);
        const removeReceipt = await removeTx.wait();
        removeGasCosts.push(removeReceipt.gasUsed);
      }

      const addGasNumbers = addGasCosts.map((g) => g.toNumber());
      const removeGasNumbers = removeGasCosts.map((g) => g.toNumber());

      // Gas costs should be relatively consistent
      const addGasVariance =
        Math.max(...addGasNumbers) - Math.min(...addGasNumbers);
      const removeGasVariance =
        Math.max(...removeGasNumbers) - Math.min(...removeGasNumbers);

      console.log("Add gas costs:", addGasNumbers);
      console.log("Remove gas costs:", removeGasNumbers);
      console.log("Add gas variance:", addGasVariance);
      console.log("Remove gas variance:", removeGasVariance);

      // Variance should be minimal (within 10% of average)
      const avgAddGas =
        addGasNumbers.reduce((sum, cost) => sum + cost, 0) /
        addGasNumbers.length;
      const avgRemoveGas =
        removeGasNumbers.reduce((sum, cost) => sum + cost, 0) /
        removeGasNumbers.length;

      expect(addGasVariance).to.be.lessThan(Math.floor(avgAddGas / 10));
      expect(removeGasVariance).to.be.lessThan(
        Math.floor(avgRemoveGas / 10)
      );
    });
  });

  describe("Event Verification", function () {
    it("should emit events with correct parameters", async () => {
      // Test MarketMakerStatusUpdated event
      const addTx = await accessControlFacet
        .connect(owner)
        .addMarketMaker(marketMaker1.address);
      const addReceipt = await addTx.wait();

      const addEvent = addReceipt.events.find(
        (e) => e.event === "MarketMakerStatusUpdated"
      );
      expect(addEvent).to.not.be.undefined;
      expect(addEvent.args.account).to.equal(marketMaker1.address, true);

      // Test MarketMakerRemoved event
      const removeTx = await accessControlFacet
        .connect(owner)
        .removeMarketMaker(marketMaker1.address);
      const removeReceipt = await removeTx.wait();

      const removeEvent = removeReceipt.events.find(
        (e) => e.event === "MarketMakerStatusUpdated"
      );
      expect(removeEvent).to.not.be.undefined;
      expect(removeEvent.args.account).to.equal(
        marketMaker1.address,
        false
      );
    });

    it("should emit events in correct order for multiple operations", async () => {
      const addresses = [marketMaker1.address, marketMaker2.address];

      // Add multiple market makers and track events
      for (const addr of addresses) {
        await expect(accessControlFacet.connect(owner).addMarketMaker(addr))
          .to.emit(accessControlFacet, "MarketMakerStatusUpdated")
          .withArgs(addr, true);
      }

      // Remove in reverse order and track events
      for (let i = addresses.length - 1; i >= 0; i--) {
        await expect(
          accessControlFacet.connect(owner).removeMarketMaker(addresses[i])
        )
          .to.emit(accessControlFacet, "MarketMakerStatusUpdated")
          .withArgs(addresses[i], false);
      }
    });
  });
});
