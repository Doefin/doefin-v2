const { ethers } = require("hardhat");

async function main() {
    console.log("🚀 Starting Market Maker addition...");
    
    const [deployer] = await ethers.getSigners();
    console.log("📝 Operating with account:", deployer.address);
    
    // Market Maker address (you can change this)
    const MARKET_MAKER_ADDRESS = process.env.MARKET_MAKER_ADDRESS || deployer.address;
    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "YOUR_DIAMOND_ADDRESS_HERE";
    
    if (DIAMOND_ADDRESS === "YOUR_DIAMOND_ADDRESS_HERE") {
        throw new Error("❌ Please set DIAMOND_ADDRESS environment variable");
    }
    
    console.log("🎯 Market Maker to add:", MARKET_MAKER_ADDRESS);
    console.log("💎 Diamond Address:", DIAMOND_ADDRESS);
    
    // Get AccessControlFacet interface
    const AccessControlFacet = await ethers.getContractFactory("AccessControlFacet");
    const diamond = AccessControlFacet.attach(DIAMOND_ADDRESS);
    
    // Check if already a market maker
    console.log("\n1️⃣ Checking current market maker status...");
    const isCurrentlyMM = await diamond.isMarketMaker(MARKET_MAKER_ADDRESS);
    console.log("Current MM status:", isCurrentlyMM);
    
    if (isCurrentlyMM) {
        console.log("✅ Address is already a Market Maker!");
        return;
    }
    
    // Add market maker
    console.log("\n2️⃣ Adding Market Maker...");
    const addMMTx = await diamond.addMarketMaker(MARKET_MAKER_ADDRESS);
    console.log("📤 Transaction sent:", addMMTx.hash);
    
    // Wait for confirmation and listen to events
    const receipt = await addMMTx.wait();
    console.log("✅ Transaction confirmed in block:", receipt.blockNumber);
    
    // Listen for MarketMakerStatusUpdated event
    const marketMakerAddedEvent = receipt.logs.find(log => {
        try {
            const parsed = diamond.interface.parseLog(log);
            return parsed.name === "MarketMakerStatusUpdated";
        } catch {
            return false;
        }
    });
    
    if (marketMakerAddedEvent) {
        const parsed = diamond.interface.parseLog(marketMakerAddedEvent);
        console.log("🎉 MarketMakerStatusUpdated event:", {
            account: parsed.args.account,
            status: parsed.args.status
        });
    }
    
    // Verify market maker was added
    console.log("\n3️⃣ Verifying Market Maker addition...");
    const isNowMM = await diamond.isMarketMaker(MARKET_MAKER_ADDRESS);
    console.log("✅ Is Market Maker now:", isNowMM);
    
    console.log("\n📋 Summary:");
    console.log("Market Maker Address:", MARKET_MAKER_ADDRESS);
    console.log("Diamond Address:", DIAMOND_ADDRESS);
    console.log("Successfully Added:", isNowMM);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Error:", error);
        process.exit(1);
    });
