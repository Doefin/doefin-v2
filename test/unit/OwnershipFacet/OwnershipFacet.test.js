const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("OwnershipFacet", function () {
  let diamondAddress, ownershipFacet, owner, addr1, addr2;

  beforeEach(async function () {
    [owner, addr1, addr2] = await ethers.getSigners();
    const { deployDiamond } = require("../../../scripts/deploy.js");
    diamondAddress = await deployDiamond();
    ownershipFacet = await ethers.getContractAt("OwnershipFacet", diamondAddress);
  });

  it("should return the correct owner", async function () {
    const currentOwner = await ownershipFacet.owner();
    expect(currentOwner).to.equal(owner.address);
  });

  it("should allow current owner to transfer ownership", async function () {
    await expect(ownershipFacet.transferOwnership(addr1.address))
      .to.emit(ownershipFacet, "OwnershipTransferred")
      .withArgs(owner.address, addr1.address);

    const newOwner = await ownershipFacet.owner();
    expect(newOwner).to.equal(addr1.address);
  });

  it("should revert when a non-owner tries to transfer ownership", async function () {
    await expect(
      ownershipFacet.connect(addr1).transferOwnership(addr2.address)
    ).to.be.revertedWith("NotContractOwner()");
  });
});