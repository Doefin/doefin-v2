const { deployDiamond } = require('../../scripts/deploy.js');
const { expect } = require('chai');
const { ethers } = require('hardhat');

describe("AccessControlFacet & OwnershipFacet", function () {
    let diamondAddress;
    let accessControl;
    let ownership;
    let owner, maker;

    before(async function () {
        [owner, maker] = await ethers.getSigners();

        // Deploy diamond
        diamondAddress = await deployDiamond();

        // Get facet instances
        accessControl = await ethers.getContractAt("AccessControlFacet", diamondAddress);
        ownership = await ethers.getContractAt("OwnershipFacet", diamondAddress);
    });

    it("should allow the owner to add a market maker", async () => {
        await accessControl.connect(owner).addMarketMaker(maker.address);
        expect(await accessControl.isMarketMaker(maker.address)).to.equal(true);
    });

    it("should allow the owner to remove a market maker", async () => {
        await accessControl.connect(owner).addMarketMaker(maker.address);
        await accessControl.connect(owner).removeMarketMaker(maker.address);
        expect(await accessControl.isMarketMaker(maker.address)).to.equal(false);
    });

    it("should emit MarketMakerUpdated event", async () => {
        await expect(accessControl.connect(owner).addMarketMaker(maker.address))
            .to.emit(accessControl, "MarketMakerUpdated")
            .withArgs(maker.address, true);

        await expect(accessControl.connect(owner).removeMarketMaker(maker.address))
            .to.emit(accessControl, "MarketMakerUpdated")
            .withArgs(maker.address, false);
    });

    it("should return the correct contract owner", async () => {
        expect(await ownership.owner()).to.equal(owner.address);
    });

    it("should transfer ownership to a new address", async () => {
        await ownership.connect(owner).transferOwnership(maker.address);
        expect(await ownership.owner()).to.equal(maker.address);

        // Restore original owner for other tests
        await ownership.connect(maker).transferOwnership(owner.address);
    });

    it("should revert if non-owner tries to transfer ownership", async () => {
        await expect(
            ownership.connect(maker).transferOwnership(owner.address)
        ).to.be.revertedWith("LibDiamond: Must be contract owner");
    });
});
