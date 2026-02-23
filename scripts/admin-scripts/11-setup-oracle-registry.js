const { ethers } = require("hardhat");

async function main() {
    console.log("🚀 Starting Oracle Registry setup...");
    
    const [deployer] = await ethers.getSigners();
    console.log("📝 Operating with account:", deployer.address);
    
    // Configuration
    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "YOUR_DIAMOND_ADDRESS_HERE";
    
    if (DIAMOND_ADDRESS === "YOUR_DIAMOND_ADDRESS_HERE") {
        throw new Error("❌ Please set DIAMOND_ADDRESS environment variable");
    }
    
    console.log("💎 Diamond Address:", DIAMOND_ADDRESS);

    // Deploy MockOracleAdapter
    console.log("\n1️⃣ Deploying MockOracleAdapter...");
    const MockOracleAdapter = await ethers.getContractFactory("MockOracleAdapter");
    const mockAdapter = await MockOracleAdapter.deploy();
    await mockAdapter.deployed();
    console.log("✅ MockOracleAdapter deployed at:", mockAdapter.address);

    // Get OracleManagerFacet interface attached to diamond
    const OracleManagerFacet = await ethers.getContractFactory("OracleManagerFacet");
    const oracleManager = OracleManagerFacet.attach(DIAMOND_ADDRESS);

    // Register the mock adapter
    console.log("\n2️⃣ Registering MockOracleAdapter...");
    const adapterId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("MockV1"));
    const maxStaleness = 3600; // 1 hour
    
    const registerTx = await oracleManager.registerAdapter(adapterId, mockAdapter.address, maxStaleness);
    await registerTx.wait();
    console.log("✅ Adapter registered with ID:", adapterId);

    // Configure assets
    console.log("\n3️⃣ Configuring assets...");
    
    // BTC-USD
    const btcUsdAssetId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("BTC-USD"));
    const configBtcTx = await oracleManager.configureAsset(
        btcUsdAssetId, 
        [adapterId], 
        1800, // 30 minutes staleness
        8 // BTC prices have 8 decimals
    );
    await configBtcTx.wait();
    console.log("✅ BTC-USD configured with asset ID:", btcUsdAssetId);

    // USD-USDC  
    const usdUsdcAssetId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("USD-USDC"));
    const configUsdcTx = await oracleManager.configureAsset(
        usdUsdcAssetId,
        [adapterId],
        3600, // 1 hour staleness (stablecoins change less)
        6 // USD-USDC prices have 6 decimals
    );
    await configUsdcTx.wait();
    console.log("✅ USD-USDC configured with asset ID:", usdUsdcAssetId);

    // USD-USDT
    const usdUsdtAssetId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("USD-USDT"));
    const configUsdtTx = await oracleManager.configureAsset(
        usdUsdtAssetId,
        [adapterId], 
        3600, // 1 hour staleness
        6 // USD-USDT prices have 6 decimals
    );
    await configUsdtTx.wait();
    console.log("✅ USD-USDT configured with asset ID:", usdUsdtAssetId);

    // Test price updates
    console.log("\n4️⃣ Testing price updates...");
    
    try {
        const updateBtcTx = await oracleManager.updatePrice(btcUsdAssetId);
        await updateBtcTx.wait();
        console.log("✅ BTC-USD price updated successfully");

        const updateUsdcTx = await oracleManager.updatePrice(usdUsdcAssetId);
        await updateUsdcTx.wait();
        console.log("✅ USD-USDC price updated successfully");

        const updateUsdtTx = await oracleManager.updatePrice(usdUsdtAssetId);
        await updateUsdtTx.wait();
        console.log("✅ USD-USDT price updated successfully");
    } catch (error) {
        console.warn("⚠️ Price update failed:", error.message);
    }

    // Query current prices
    console.log("\n5️⃣ Querying current prices...");
    
    try {
        const [btcPrice, btcTimestamp, btcPaused] = await oracleManager.getPrice(btcUsdAssetId);
        console.log("📊 BTC-USD:", {
            price: ethers.utils.formatUnits(btcPrice, 8),
            timestamp: new Date(btcTimestamp * 1000).toISOString(),
            isPaused: btcPaused
        });

        const [usdcPrice, usdcTimestamp, usdcPaused] = await oracleManager.getPrice(usdUsdcAssetId);
        console.log("📊 USD-USDC:", {
            price: ethers.utils.formatUnits(usdcPrice, 6),
            timestamp: new Date(usdcTimestamp * 1000).toISOString(),
            isPaused: usdcPaused
        });

        const [usdtPrice, usdtTimestamp, usdtPaused] = await oracleManager.getPrice(usdUsdtAssetId);
        console.log("📊 USD-USDT:", {
            price: ethers.utils.formatUnits(usdtPrice, 6), 
            timestamp: new Date(usdtTimestamp * 1000).toISOString(),
            isPaused: usdtPaused
        });
    } catch (error) {
        console.warn("⚠️ Price query failed:", error.message);
    }

    // Test adapter info
    console.log("\n6️⃣ Querying adapter info...");
    try {
        const adapterInfo = await oracleManager.getAdapterInfo(adapterId);
        console.log("🔧 MockV1 Adapter:", {
            address: adapterInfo.adapterAddress,
            maxStaleness: adapterInfo.maxStaleness.toString(),
            failureCount: adapterInfo.failureCount.toString(),
            enabled: adapterInfo.enabled
        });
    } catch (error) {
        console.warn("⚠️ Adapter info query failed:", error.message);
    }

    console.log("\n🎉 Oracle Registry setup complete!");
    console.log("\n📝 Summary:");
    console.log("- MockOracleAdapter:", mockAdapter.address);
    console.log("- Adapter ID:", adapterId);
    console.log("- BTC-USD Asset ID:", btcUsdAssetId);
    console.log("- USD-USDC Asset ID:", usdUsdcAssetId);
    console.log("- USD-USDT Asset ID:", usdUsdtAssetId);
    
    console.log("\n💡 Next steps:");
    console.log("- Use mockAdapter.setPrice() to test price changes");
    console.log("- Use mockAdapter.setFailure() to test failover logic");
    console.log("- Call oracleManager.updatePrice() to refresh prices");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });