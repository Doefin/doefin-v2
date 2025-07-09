const { ethers } = require("hardhat");

async function deployMockERC20(name = "MockToken", symbol = "MOCK") {
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const mockERC20 = await MockERC20.deploy(name, symbol);
    await mockERC20.deployed();
    return mockERC20;
}

async function deployMockERC1155() {
    const MockERC1155 = await ethers.getContractFactory("MOCkERC1155");
    const mockERC1155 = await MockERC1155.deploy();
    await mockERC1155.deployed();
    return mockERC1155;
}

module.exports = {
    deployMockERC20, deployMockERC1155
};
