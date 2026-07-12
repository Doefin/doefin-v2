const { ethers } = require("hardhat");
require("dotenv").config();

async function main() {
    console.log("🔍 Verifying Bitcoin Oracle Block Count...");
    
    const [deployer] = await ethers.getSigners();
    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS;
    
    if (!DIAMOND_ADDRESS) {
        throw new Error("❌ Please set DIAMOND_ADDRESS in .env file");
    }
    
    console.log("💎 Diamond Address:", DIAMOND_ADDRESS);
    
    // Get block header oracle interface
    const blockHeaderOracle = await ethers.getContractAt("IDoefinBlockHeaderOracle", DIAMOND_ADDRESS);
    
    // Get current oracle state
    const currentBlockHeight = await blockHeaderOracle.getCurrentBlockHeight();
    console.log("📊 Current oracle block height:", currentBlockHeight.toString());
    
    // Try to get buffer size (number of blocks stored)
    try {
        const bufferSize = await blockHeaderOracle.getBufferSize();
        console.log("📦 Oracle buffer size (blocks stored):", bufferSize.toString());
    } catch (error) {
        console.log("ℹ️ Could not get buffer size");
    }
    
    // Check specific block heights to confirm range
    console.log("\n🔍 Checking block range in oracle...");
    
    // Check if we can access the blocks
    const blocksToCheck = [933331, 933335, 933340, 933345, 933347]; // Sample blocks
    
    for (const blockHeight of blocksToCheck) {
        try {
            const header = await blockHeaderOracle.getBlockHeaderByNumber(blockHeight);
            console.log(`✅ Block ${blockHeight}: ${header.blockHash.substring(0, 20)}...`);
        } catch (error) {
            console.log(`❌ Block ${blockHeight}: Not found in oracle`);
        }
    }
    
    // Get latest block
    try {
        const latestHeader = await blockHeaderOracle.getLatestBlockHeader();
        console.log("\n📋 Latest block in oracle:");
        console.log("   Block Number:", latestHeader.blockNumber.toString());
        console.log("   Block Hash:", latestHeader.blockHash);
    } catch (error) {
        console.log("❌ Could not retrieve latest block header");
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Error:", error.message);
        process.exit(1);
    });