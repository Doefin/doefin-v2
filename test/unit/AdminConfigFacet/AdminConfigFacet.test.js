const { deployDiamond } = require("../../../scripts/deploy.js");
const { expect } = require("chai");
const { ethers } = require("hardhat");

const {
  addCollateralToken,
  removeCollateralToken,
  setTradingFeesBps,
  setResolutionFeeBps,
  setFeeReceiver,
  isAllowedCollateral,
  getCollateralUnit,
  getFees,
} = require("../../utils/adminConfigUtils.js");

describe("AdminConfigFacet", function () {
  let diamondAddress, adminConfig, owner, addr1, mockToken, feeReceiver, recipient;

  beforeEach(async function () {
    [owner, addr1, feeReceiver, recipient] = await ethers.getSigners();

    diamondAddress = await deployDiamond();

    adminConfig = await ethers.getContractAt("AdminConfigFacet", diamondAddress);
    console.log("Owner address:", owner.address)

    const MockToken = await ethers.getContractFactory("MockERC20");
    mockToken = await MockToken.deploy("MockToken", "MTK", 18);
    await mockToken.deployed();
  });

  it("should add and remove collateral token", async function () {
    await expect(addCollateralToken({ adminConfig, token: mockToken, unit: ethers.utils.parseEther("1") }))
      .to.emit(adminConfig, "CollateralTokenAdded")
      .withArgs(mockToken.address, ethers.utils.parseEther("1"));

    expect(await isAllowedCollateral(adminConfig, mockToken)).to.be.true;

    await expect(removeCollateralToken({ adminConfig, token: mockToken, caller: owner }))
      .to.emit(adminConfig, "CollateralTokenRemoved")
      .withArgs(mockToken.address);

    expect(await isAllowedCollateral(adminConfig, mockToken)).to.be.false;
  });

  it("should revert on invalid token address for addCollateralToken", async function () {
    await expect(adminConfig.addCollateralToken(ethers.constants.AddressZero, 1))
      .to.be.revertedWith("InvalidTokenAddress()");
  });

  it("should revert on zero unitPerPair for addCollateralToken", async function () {
    await expect(adminConfig.addCollateralToken(mockToken.address, 0))
      .to.be.revertedWith("InvalidUnitPerPair()");
  });

  it("should revert if token already allowed", async function () {
    await addCollateralToken({ adminConfig, token: mockToken, unit: 1 });
    await expect(addCollateralToken({ adminConfig, token: mockToken, unit: 1 }))
      .to.be.revertedWith("TokenAlreadyAllowed()");
  });

  it("should set and update fee receiver", async function () {
    await expect(setFeeReceiver({ adminConfig, feeReceiver, caller: owner }))
      .to.emit(adminConfig, "FeeReceiverUpdated")
      .withArgs(owner.address, feeReceiver.address);
  });

  it("should revert on invalid fee receiver", async function () {
    await expect(setFeeReceiver({ adminConfig, feeReceiver: ethers.constants.AddressZero, caller: owner }))
      .to.be.revertedWith("InvalidFeeReceiver()");
  });

  it("should set resolution fee bps", async function () {
    await expect(setResolutionFeeBps({ adminConfig, bps: 100, caller: owner }))
      .to.emit(adminConfig, "ResolutionFeeUpdated")
      .withArgs(500, 100);
  });

  it("should revert on too high resolution fee bps", async function () {
    await expect(setResolutionFeeBps({ adminConfig, bps: 20000, caller: owner }))
      .to.be.revertedWith("FeeTooHigh()");
  });

  it("should set trading fees", async function () {
    await expect(setTradingFeesBps({ adminConfig, makerBps: 300, takerBps: 400, caller: owner }))
      .to.emit(adminConfig, "TradingFeesUpdated")
      .withArgs(0, 0, 300, 400);
  });

  it("should revert on too high trading fees", async function () {
    await expect(setTradingFeesBps({ adminConfig, makerBps: 20000, takerBps: 100, caller: owner }))
      .to.be.revertedWith("FeeTooHigh()");
  });

  it("should get fees config", async function () {
    await setFeeReceiver({ adminConfig, feeReceiver, caller: owner });
    await setResolutionFeeBps({ adminConfig, bps: 123, caller: owner });
    await setTradingFeesBps({ adminConfig, makerBps: 10, takerBps: 20, caller: owner });

    const fees = await getFees(adminConfig);
    expect(fees.receiver).to.equal(feeReceiver.address);
    expect(fees.resolutionFeeBps).to.equal(123);
    expect(fees.makerBps).to.equal(10);
    expect(fees.takerBps).to.equal(20);
  });

  it("should revert getCollateralUnit if token not allowed", async function () {
    await expect(getCollateralUnit(adminConfig, mockToken))
      .to.be.revertedWith("TokenNotAllowed()");
  });

  // ========================================
  // MAX FEE RATE (SCRUM-224)
  // ========================================

  describe("setMaxFeeRate / getMaxFeeRate (SCRUM-224)", function () {
    it("should default maxFeeRateBps to 0 on a fresh deploy", async function () {
      expect(await adminConfig.getMaxFeeRate()).to.equal(0);
    });

    it("should set the max fee rate and emit MaxFeeRateUpdated", async function () {
      await expect(adminConfig.connect(owner).setMaxFeeRate(250))
        .to.emit(adminConfig, "MaxFeeRateUpdated")
        .withArgs(0, 250);
      expect(await adminConfig.getMaxFeeRate()).to.equal(250);
    });

    it("should allow setting the rate exactly at the 1000-bps ceiling", async function () {
      await adminConfig.connect(owner).setMaxFeeRate(1000);
      expect(await adminConfig.getMaxFeeRate()).to.equal(1000);
    });

    it("should revert when the rate exceeds the 1000-bps ceiling", async function () {
      await expect(adminConfig.connect(owner).setMaxFeeRate(1001))
        .to.be.revertedWith("MaxFeeRateExceedsCeiling()");
    });

    it("should revert setMaxFeeRate for a non-owner", async function () {
      await expect(adminConfig.connect(addr1).setMaxFeeRate(100))
        .to.be.revertedWith("NotContractOwner()");
    });
  });
});