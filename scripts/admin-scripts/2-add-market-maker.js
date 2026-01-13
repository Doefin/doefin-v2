const { ethers } = require("hardhat");
require("dotenv").config();

async function main() {
    console.log("🚀 Starting Market Maker setup...");
    
    const [deployer] = await ethers.getSigners();
    console.log("📝 Operating with account:", deployer.address);
    console.log("💰 Account balance:", ethers.utils.formatEther(await deployer.getBalance()), "ETH");
    
    // Market Maker address configuration
    const MARKET_MAKER_ADDRESS = process.env.MARKET_MAKER_ADDRESS || deployer.address;
    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS;
    
    if (!DIAMOND_ADDRESS) {
        throw new Error("❌ Please set DIAMOND_ADDRESS in .env file");
    }
    
    console.log("🎯 Market Maker address:", MARKET_MAKER_ADDRESS);
    console.log("💎 Diamond Address:", DIAMOND_ADDRESS);
    
    // Get AccessControlFacet interface
    console.log("\n1️⃣ Connecting to Diamond Access Control...");
    const AccessControlFacet = await ethers.getContractFactory("AccessControlFacet");
    const diamond = AccessControlFacet.attach(DIAMOND_ADDRESS);
    
    // Check if already a market maker
    console.log("\n2️⃣ Checking current market maker status...");
    let isCurrentlyMM = false;
    try {
        isCurrentlyMM = await diamond.isMarketMaker(MARKET_MAKER_ADDRESS);
        console.log(`📊 ${MARKET_MAKER_ADDRESS === deployer.address ? 'Your account' : 'Target account'} MM status:`, isCurrentlyMM);
    } catch (error) {
        console.log("⚠️ Cannot check market maker status:", error.message);
    }
    
    if (isCurrentlyMM) {
        console.log("✅ Address is already a Market Maker!");
    } else {
        // Add market maker
        console.log("\n3️⃣ Adding Market Maker role...");
        try {
            const addMMTx = await diamond.addMarketMaker(MARKET_MAKER_ADDRESS, {
                gasLimit: 300000 // Sufficient gas limit
            });
            console.log("📤 Transaction sent:", addMMTx.hash);
            
            // Wait for confirmation
            const receipt = await addMMTx.wait();
            console.log("✅ Transaction confirmed in block:", receipt.blockNumber);
            
            // Parse events
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
            
            // Wait and verify
            console.log("\n4️⃣ Verifying Market Maker addition...");
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            const isNowMM = await diamond.isMarketMaker(MARKET_MAKER_ADDRESS);
            console.log("✅ Market Maker status verified:", isNowMM);
            
        } catch (error) {
            console.error("❌ Failed to add market maker:", error.message);
            throw error;
        }
    }
    
    // Check owner status as well
    console.log("\n5️⃣ Checking additional permissions...");
    try {
        // Check if we're the owner
        const OwnershipFacet = await ethers.getContractFactory("OwnershipFacet");
        const ownershipDiamond = OwnershipFacet.attach(DIAMOND_ADDRESS);
        const owner = await ownershipDiamond.owner();
        const isOwner = owner.toLowerCase() === deployer.address.toLowerCase();
        console.log("📋 Contract owner:", owner);
        console.log("📋 You are owner:", isOwner);
    } catch (error) {
        console.log("⚠️ Cannot check owner status:", error.message);
    }
    
    console.log("\n🎉 Market Maker setup complete!");
    console.log("\n📋 Summary:");
    console.log(`   Market Maker: ${MARKET_MAKER_ADDRESS}`);
    console.log(`   Diamond: ${DIAMOND_ADDRESS}`);
    console.log(`   Status: ✅ Active Market Maker`);
    
    if (MARKET_MAKER_ADDRESS !== deployer.address) {
        console.log("\n💡 Environment Variable for .env:");
        console.log(`MARKET_MAKER_ADDRESS=${MARKET_MAKER_ADDRESS}`);
    }
    
    console.log("\n🔄 Next Step:");
    console.log("   Run script 3: Mint and approve tokens for trading");
    console.log("   Command: npx hardhat run scripts/admin-scripts/3-mint-and-approve-tokens.js --network baseSepolia");
}


main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Error:", error);
        process.exit(1);
    });
