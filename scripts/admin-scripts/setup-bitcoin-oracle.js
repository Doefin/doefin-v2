const { ethers } = require("hardhat");
require("dotenv").config();

// Import block header oracle utilities
const {
  getInitializationBlocks,
  getInitialBlockHeight,
  initializeBlockHeaderOracle,
} = require("../../test/utils/blockHeaderOracleUtils.js");

async function main() {
    console.log("🚀 Initializing Bitcoin Block Header Oracle with latest blocks...");
    
    const [deployer] = await ethers.getSigners();
    console.log("📝 Operating with account:", deployer.address);
    console.log("💰 Account balance:", ethers.utils.formatEther(await deployer.getBalance()), "ETH");
    
    // Configuration from .env
    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS;
    
    if (!DIAMOND_ADDRESS) {
        throw new Error("❌ Please set DIAMOND_ADDRESS in .env file");
    }
    
    console.log("💎 Diamond Address:", DIAMOND_ADDRESS);
    
    // Get block header oracle interface
    console.log("\n1️⃣ Connecting to Block Header Oracle...");
    const blockHeaderOracle = await ethers.getContractAt("IDoefinBlockHeaderOracle", DIAMOND_ADDRESS);
    
    // Check current oracle state
    const currentBlockHeight = await blockHeaderOracle.getCurrentBlockHeight();
    console.log("📊 Current oracle block height:", currentBlockHeight.toString());
    
    if (currentBlockHeight.toNumber() > 0) {
        console.log("⚠️ Oracle already initialized with block height:", currentBlockHeight.toString());
        console.log("💡 If you want to reinitialize, you might need to deploy a new contract");
        
        // Show current oracle info
        try {
            const latestHeader = await blockHeaderOracle.getLatestBlockHeader();
            console.log("📋 Current latest block:");
            console.log("   Block Number:", latestHeader.blockNumber.toString());
            console.log("   Block Hash:", latestHeader.blockHash);
            console.log("   Timestamp:", new Date(latestHeader.timestamp.toNumber() * 1000).toISOString());
        } catch (error) {
            console.log("ℹ️ Could not retrieve latest block header");
        }
        
        return;
    }
    
    // Load initialization blocks (latest 17 blocks from blocks-production.json)
    console.log("\n2️⃣ Loading initialization blocks...");
    const initBlocks = getInitializationBlocks();
    const initialHeight = getInitialBlockHeight();
    
    console.log("📦 Initialization blocks loaded:");
    console.log("   Block Count:", initBlocks.length);
    console.log("   Initial Height:", initialHeight);
    console.log("   Block Range:", `${initBlocks[0].blockNumber} to ${initBlocks[initBlocks.length - 1].blockNumber}`);
    
    // Display first and last block info
    const firstBlock = initBlocks[0];
    const lastBlock = initBlocks[initBlocks.length - 1];
    
    console.log("   First Block (oldest):");
    console.log("     Height:", firstBlock.blockNumber);
    console.log("     Hash:", firstBlock.blockHash);
    console.log("     Timestamp:", new Date(firstBlock.timestamp * 1000).toISOString());
    
    console.log("   Last Block (newest):");
    console.log("     Height:", lastBlock.blockNumber);
    console.log("     Hash:", lastBlock.blockHash);
    console.log("     Timestamp:", new Date(lastBlock.timestamp * 1000).toISOString());
    
    // Initialize the oracle
    console.log("\n3️⃣ Initializing Block Header Oracle...");
    try {
        console.log("📤 Sending initialization transaction...");
        const tx = await blockHeaderOracle
            .connect(deployer)
            .initializeBlockHeaderOracle(initBlocks, initialHeight);
        
        console.log("⏳ Transaction sent:", tx.hash);
        console.log("⏳ Waiting for confirmation...");
        const receipt = await tx.wait();
        console.log("✅ Transaction confirmed in block:", receipt.blockNumber);
        
        if (receipt.status !== 1) {
            throw new Error(`Transaction failed with status: ${receipt.status}`);
        }
        
        console.log("✅ Oracle initialization transaction successful!");
        console.log("   Gas used:", receipt.gasUsed.toString());
        
        // Verify initialization
        console.log("\n4️⃣ Verifying initialization...");
        const newBlockHeight = await blockHeaderOracle.getCurrentBlockHeight();
        console.log("✅ New oracle block height:", newBlockHeight.toString());
        
        // Check if initialization actually worked
        if (newBlockHeight.toNumber() === 0) {
            throw new Error("Oracle initialization failed - block height is still 0. The initializeBlockHeaderOracle transaction may have failed.");
        }
        
        const latestHeader = await blockHeaderOracle.getLatestBlockHeader();
        console.log("✅ Latest block in oracle:");
        console.log("   Block Number:", latestHeader.blockNumber.toString());
        console.log("   Block Hash:", latestHeader.blockHash);
        
        // Handle timestamp conversion properly (could be bigint or BigNumber)
        let timestampValue;
        if (typeof latestHeader.timestamp === 'bigint') {
            timestampValue = Number(latestHeader.timestamp);
        } else if (latestHeader.timestamp.toNumber) {
            timestampValue = latestHeader.timestamp.toNumber();
        } else {
            timestampValue = latestHeader.timestamp;
        }
        console.log("   Timestamp:", new Date(timestampValue * 1000).toISOString());
        
        console.log("\n🎉 Block Header Oracle initialization complete!");
        console.log("\n📋 Summary:");
        console.log(`   Oracle initialized with blocks: ${firstBlock.blockNumber} to ${lastBlock.blockNumber}`);
        console.log(`   Current oracle height: ${newBlockHeight.toString()}`);
        console.log(`   Current difficulty: 146.47T (from blocks)`);
        console.log(`   Oracle ready for condition creation!`);
        
        console.log("\n🔄 Next Steps:");
        console.log("   1. Oracle is now ready to create difficulty-based conditions");
        console.log("   2. Run condition creation script with real block numbers");
        console.log("      Command: npx hardhat run scripts/admin-scripts/4b-create-condition-with-metadata.js --network baseSepolia");
        console.log("   3. Target block numbers can now be in range:", `${firstBlock.blockNumber}-${lastBlock.blockNumber + 100}`);
        
    } catch (error) {
        console.error("❌ Oracle initialization failed:", error);
        
        // Better error messages
        if (error.message.includes("AlreadyInitialized") || error.message.includes("already initialized")) {
            console.error("💡 Hint: Oracle is already initialized");
        } else if (error.message.includes("InvalidBlockHeight") || error.message.includes("block height")) {
            console.error("💡 Hint: Check block height sequence - blocks must be in ascending order");
        } else if (error.message.includes("NotAuthorized") || error.message.includes("not authorized")) {
            console.error("💡 Hint: Make sure the account has oracle admin permissions");
        } else if (error.message.includes("InvalidBlockHeader")) {
            console.error("💡 Hint: Block header validation failed - check block data format");
        } else if (error.message.includes("revert")) {
            console.error("💡 Hint: Transaction was reverted - check contract state and permissions");
        }
        
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Error:", error.message);
        process.exit(1);
    });