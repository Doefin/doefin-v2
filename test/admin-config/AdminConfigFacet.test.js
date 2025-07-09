const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployMockERC20 } = require("../mock/deployMocks");
const { deployDiamond } = require("../../scripts/deploy");

describe("AdminConfigFacet", function () {
    let diamondAddress;
    let adminConfig;
    let erc20;
    let owner, addr1;

    beforeEach(async () => {
        [owner, addr1] = await ethers.getSigners();
        diamondAddress = await deployDiamond();
        adminConfig = await ethers.getContractAt("AdminConfigFacet", diamondAddress);
        erc20 = await deployMockERC20("MockToken", "MOCK");
    });

    it("should allow owner to add a valid collateral token", async () => {
        const unit = ethers.utils.parseEther("1");
        await expect(adminConfig.connect(owner).addCollateralToken(erc20.address, unit))
            .to.emit(adminConfig, "CollateralTokenAdded")
            .withArgs(erc20.address, unit);

        expect(await adminConfig.isAllowedCollateral(erc20.address)).to.be.true;
        expect(await adminConfig.getCollateralUnit(erc20.address)).to.equal(unit);
    });

    it("should revert if non-owner tries to add collateral token", async () => {
        const unit = ethers.utils.parseEther("1");
        await expect(adminConfig.connect(addr1).addCollateralToken(erc20.address, unit)).to.be.revertedWith(
            "LibDiamond: Must be contract owner"
        );
    });

    it("should revert when adding invalid token address", async () => {
        const unit = ethers.utils.parseEther("1");
        await expect(adminConfig.addCollateralToken(ethers.constants.AddressZero, unit)).to.be.revertedWith(
            "AdminConfig: invalid token address"
        );
    });

    it("should revert when adding with zero unit", async () => {
        await expect(adminConfig.addCollateralToken(erc20.address, 0)).to.be.revertedWith(
            "AdminConfig: unit must be > 0"
        );
    });

    it("should revert when adding a duplicate token", async () => {
        const unit = ethers.utils.parseEther("1");
        await adminConfig.addCollateralToken(erc20.address, unit);
        await expect(adminConfig.addCollateralToken(erc20.address, unit)).to.be.revertedWith(
            "AdminConfig: token already allowed"
        );
    });

    it("should allow owner to remove an existing token", async () => {
        const unit = ethers.utils.parseEther("1");
        await adminConfig.addCollateralToken(erc20.address, unit);

        await expect(adminConfig.removeCollateralToken(erc20.address))
            .to.emit(adminConfig, "CollateralTokenRemoved")
            .withArgs(erc20.address);

        expect(await adminConfig.isAllowedCollateral(erc20.address)).to.be.false;
    });

    it("should revert when removing non-existing token", async () => {
        await expect(adminConfig.removeCollateralToken(erc20.address)).to.be.revertedWith(
            "AdminConfig: token not allowed"
        );
    });

    it("should allow owner to set fee receiver", async () => {
        await expect(adminConfig.setFeeReceiver(addr1.address))
            .to.emit(adminConfig, "FeeReceiverUpdated")
            .withArgs(addr1.address);
    });

    it("should revert if fee receiver is zero address", async () => {
        await expect(adminConfig.setFeeReceiver(ethers.constants.AddressZero)).to.be.revertedWith(
            "AdminConfig: invalid fee receiver"
        );
    });

    it("should allow owner to set resolution fee bps", async () => {
        await expect(adminConfig.setResolutionFeeBps(500))
            .to.emit(adminConfig, "ResolutionFeeUpdated")
            .withArgs(500);
    });

    it("should revert if resolution fee > 10000", async () => {
        await expect(adminConfig.setResolutionFeeBps(10001)).to.be.revertedWith(
            "AdminConfig: fee too high"
        );
    });

    it("should allow owner to set maker/taker trading fees", async () => {
        await expect(adminConfig.setTradingFeesBps(100, 200))
            .to.emit(adminConfig, "TradingFeesUpdated")
            .withArgs(100, 200);
    });

    it("should revert if trading fee > 10000", async () => {
        await expect(adminConfig.setTradingFeesBps(5000, 10001)).to.be.revertedWith(
            "AdminConfig: fee too high"
        );
    });

    it("should return the correct fees via getFees", async () => {
        await adminConfig.setFeeReceiver(addr1.address);
        await adminConfig.setResolutionFeeBps(300);
        await adminConfig.setTradingFeesBps(100, 200);

        const [receiver, resolutionBps, makerBps, takerBps] = await adminConfig.getFees();
        expect(receiver).to.equal(addr1.address);
        expect(resolutionBps).to.equal(300);
        expect(makerBps).to.equal(100);
        expect(takerBps).to.equal(200);
    });

    it("should revert getCollateralUnit for unallowed token", async () => {
        await expect(adminConfig.getCollateralUnit(erc20.address)).to.be.revertedWith(
            "AdminConfig: token not allowed"
        );
    });
});
