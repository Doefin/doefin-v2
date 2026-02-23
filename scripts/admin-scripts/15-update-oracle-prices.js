const { ethers } = require("hardhat");

async function main() {
    console.log("🔄 Updating oracle prices to ensure fresh data and resume trading...");

    const [deployer] = await ethers.getSigners();
    console.log("📝 Operating with account:", deployer.address);

    // Configuration - you'll need to set these after running the setup script
    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "YOUR_DIAMOND_ADDRESS_HERE";
    const MOCK_ORACLE_ADDRESS = process.env.MOCK_ORACLE_ADDRESS || "YOUR_MOCK_ORACLE_ADDRESS_HERE";

    if (DIAMOND_ADDRESS === "YOUR_DIAMOND_ADDRESS_HERE") {
        throw new Error("❌ Please set DIAMOND_ADDRESS environment variable");
    }
    if (MOCK_ORACLE_ADDRESS === "YOUR_MOCK_ORACLE_ADDRESS_HERE") {
        throw new Error("❌ Please set MOCK_ORACLE_ADDRESS environment variable (from setup script output)");
    }

    console.log("💎 Diamond Address:", DIAMOND_ADDRESS);
    console.log("🔧 Mock Oracle Address:", MOCK_ORACLE_ADDRESS);

    // Get contract instances
    const mockOracle = await ethers.getContractAt("MockOracleAdapter", MOCK_ORACLE_ADDRESS);
    const oracleManager = await ethers.getContractAt("OracleManagerFacet", DIAMOND_ADDRESS);

    // Asset IDs (these are deterministic)
    const btcUsdAssetId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("BTC-USD"));
    const usdUsdcAssetId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("USD-USDC"));

    // Check current status
    console.log("\n🔍 Checking current oracle status...");
    try {
        const [btcPriceBefore, btcTimestampBefore, btcPausedBefore] = await oracleManager.getPrice(btcUsdAssetId);
        const [usdcPriceBefore, usdcTimestampBefore, usdcPausedBefore] = await oracleManager.getPrice(usdUsdcAssetId);
        
        console.log("📊 Current BTC-USD:", {
            price: ethers.utils.formatUnits(btcPriceBefore, 8),
            timestamp: new Date(btcTimestampBefore * 1000).toISOString(),
            isPaused: btcPausedBefore,
            age: Math.floor((Date.now() / 1000) - btcTimestampBefore) + " seconds"
        });
        
        console.log("📊 Current USD-USDC:", {
            price: ethers.utils.formatUnits(usdcPriceBefore, 6),
            timestamp: new Date(usdcTimestampBefore * 1000).toISOString(),
            isPaused: usdcPausedBefore,
            age: Math.floor((Date.now() / 1000) - usdcTimestampBefore) + " seconds"
        });

        if (btcPausedBefore || usdcPausedBefore) {
            console.log("\n⚠️ Some assets are paused - updating prices to resume trading...");
        }
    } catch (error) {
        console.log("⚠️ Error checking current prices:", error.message);
    }

    // Update prices with current market rates (adjust as needed)
    console.log("\n1️⃣ Setting fresh prices with current timestamp...");
    const currentTime = Math.floor(Date.now() / 1000);
    
    const btcPrice = ethers.utils.parseUnits("45000", 8); // $45,000 per BTC
    await mockOracle.setPrice(btcUsdAssetId, btcPrice);
    console.log("✅ BTC-USD price set to $45,000");

    const usdcPrice = ethers.utils.parseUnits("1", 6); // 1:1 USD:USDC
    await mockOracle.setPrice(usdUsdcAssetId, usdcPrice);
    console.log("✅ USD-USDC price set to 1:1");

    console.log("\n2️⃣ Triggering oracle manager updates to resume trading...");
    
    try {
        const btcUpdateTx = await oracleManager.updatePrice(btcUsdAssetId);
        await btcUpdateTx.wait();
        console.log("✅ BTC-USD updated in OracleManager");
    } catch (error) {
        console.error("❌ BTC-USD update failed:", error.message);
        console.error("💡 This may indicate a configuration issue with the oracle adapter");
    }

    try {
        const usdcUpdateTx = await oracleManager.updatePrice(usdUsdcAssetId);
        await usdcUpdateTx.wait();
        console.log("✅ USD-USDC updated in OracleManager");
    } catch (error) {
        console.error("❌ USD-USDC update failed:", error.message);
        console.error("💡 This may indicate a configuration issue with the oracle adapter");
    }

    // Verify prices
    console.log("\n3️⃣ Verifying price updates and trading status...");
    const [btcPriceCheck, btcTimestamp, btcPaused] = await oracleManager.getPrice(btcUsdAssetId);
    const [usdcPriceCheck, usdcTimestamp, usdcPaused] = await oracleManager.getPrice(usdUsdcAssetId);

    console.log("📊 Updated BTC-USD:", {
        price: ethers.utils.formatUnits(btcPriceCheck, 8),
        timestamp: new Date(btcTimestamp * 1000).toISOString(),
        isPaused: btcPaused,
        status: btcPaused ? "❌ STILL PAUSED" : "✅ TRADING ENABLED"
    });

    console.log("📊 Updated USD-USDC:", {
        price: ethers.utils.formatUnits(usdcPriceCheck, 6),
        timestamp: new Date(usdcTimestamp * 1000).toISOString(),
        isPaused: usdcPaused,
        status: usdcPaused ? "❌ STILL PAUSED" : "✅ TRADING ENABLED"
    });

    if (btcPaused || usdcPaused) {
        console.log("\n⚠️ WARNING: Some prices are still paused!");
        console.log("💡 Possible issues:");
        console.log("   - Oracle adapter not properly configured");
        console.log("   - Price staleness threshold too strict");
        console.log("   - Network timestamp issues");
        console.log("🔧 Try running the setup script again or check oracle adapter configuration");
    } else {
        console.log("\n🎉 All prices are active - cross-currency trading is now enabled!");
    }

    console.log("\n💡 Run this script every 15-30 minutes to keep prices fresh for testing");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });