const { ethers } = require("hardhat");

async function main() {
    console.log("🚀 Starting Cross-Currency Setup...");

    const [deployer] = await ethers.getSigners();
    console.log("📝 Operating with account:", deployer.address);

    // Configuration
    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "YOUR_DIAMOND_ADDRESS_HERE";
    const MOCK_TOKEN_ADDRESS = process.env.MOCK_TOKEN_ADDRESS || "YOUR_MUSDC_ADDRESS_HERE";
    const SEC_MOCK_TOKEN_ADDRESS = process.env.SEC_MOCK_TOKEN_ADDRESS || "YOUR_MBTC_ADDRESS_HERE";

    if (DIAMOND_ADDRESS === "YOUR_DIAMOND_ADDRESS_HERE") {
        throw new Error("❌ Please set DIAMOND_ADDRESS environment variable");
    }
    if (MOCK_TOKEN_ADDRESS === "YOUR_MUSDC_ADDRESS_HERE") {
        throw new Error("❌ Please set MOCK_TOKEN_ADDRESS environment variable");
    }
    if (SEC_MOCK_TOKEN_ADDRESS === "YOUR_MBTC_ADDRESS_HERE") {
        throw new Error("❌ Please set SEC_MOCK_TOKEN_ADDRESS environment variable");
    }

    console.log("💎 Diamond Address:", DIAMOND_ADDRESS);
    console.log("🪙 mUSDC Address:", MOCK_TOKEN_ADDRESS);
    console.log("₿ mBTC Address:", SEC_MOCK_TOKEN_ADDRESS);

    // Get contract instances
    const adminConfig = await ethers.getContractAt("AdminConfigFacet", DIAMOND_ADDRESS);
    const oracleManager = await ethers.getContractAt("OracleManagerFacet", DIAMOND_ADDRESS);

    // Step 1: Set token symbols
    console.log("\n1️⃣ Setting token symbols...");
    await adminConfig.setTokenSymbol(MOCK_TOKEN_ADDRESS, "USDC");
    console.log("✅ mUSDC symbol set to 'USDC'");

    await adminConfig.setTokenSymbol(SEC_MOCK_TOKEN_ADDRESS, "BTC");
    console.log("✅ mBTC symbol set to 'BTC'");

    // Step 1.5: Add tokens as allowed collateral (if not already added)
    console.log("\n1️⃣5️⃣ Adding tokens as allowed collateral...");
    
    // Check if mUSDC is already allowed
    const isUsdcAllowed = await adminConfig.isAllowedCollateral(MOCK_TOKEN_ADDRESS);
    if (!isUsdcAllowed) {
        const usdcUnit = ethers.utils.parseUnits("1", 6); // 1 USDC = 10^6 units
        await adminConfig.addCollateralToken(MOCK_TOKEN_ADDRESS, usdcUnit);
        console.log("✅ mUSDC added as collateral");
    } else {
        console.log("ℹ️ mUSDC already added as collateral");
    }

    // Check if mBTC is already allowed
    const isBtcAllowed = await adminConfig.isAllowedCollateral(SEC_MOCK_TOKEN_ADDRESS);
    if (!isBtcAllowed) {
        const btcUnit = ethers.utils.parseUnits("1", 8); // 1 BTC = 10^8 units
        await adminConfig.addCollateralToken(SEC_MOCK_TOKEN_ADDRESS, btcUnit);
        console.log("✅ mBTC added as collateral");
    } else {
        console.log("ℹ️ mBTC already added as collateral");
    }

    // Step 2: Set up MockOracleAdapter
    console.log("\n2️⃣ Setting up MockOracleAdapter...");
    
    const adapterId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("MockV1"));
    const existingAdapter = await oracleManager.getAdapterInfo(adapterId);
    
    let mockAdapter;
    if (existingAdapter.adapterAddress !== ethers.constants.AddressZero) {
        // Use existing registered adapter
        mockAdapter = await ethers.getContractAt("MockOracleAdapter", existingAdapter.adapterAddress);
        console.log("✅ Using registered MockOracleAdapter at:", existingAdapter.adapterAddress);
    } else {
        // Deploy and register new adapter
        const MockOracleAdapter = await ethers.getContractFactory("MockOracleAdapter");
        mockAdapter = await MockOracleAdapter.deploy();
        await mockAdapter.deployed();
        
        const registerTx = await oracleManager.registerAdapter(adapterId, mockAdapter.address, 3600);
        await registerTx.wait();
        
        console.log("✅ MockOracleAdapter deployed and registered at:", mockAdapter.address);
    }

    // Step 3: Configure assets (if not already configured)
    console.log("\n3️⃣ Configuring assets...");
    
    // Check if BTC-USD is already configured
    const btcUsdAssetId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("BTC-USD"));
    let btcUsdConfigured = false;
    try {
        await oracleManager.getPrice(btcUsdAssetId);
        btcUsdConfigured = true;
        console.log("ℹ️ BTC-USD already configured");
    } catch (error) {
        // Not configured yet
    }
    
    if (!btcUsdConfigured) {
        const configBtcTx = await oracleManager.configureAsset(
            btcUsdAssetId,
            [adapterId],
            1800, // 30 minutes staleness
            8 // BTC prices have 8 decimals
        );
        await configBtcTx.wait();
        console.log("✅ BTC-USD configured with asset ID:", btcUsdAssetId);
    }
    
    // Check if USD-USDC is already configured
    const usdUsdcAssetId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("USD-USDC"));
    let usdUsdcConfigured = false;
    try {
        await oracleManager.getPrice(usdUsdcAssetId);
        usdUsdcConfigured = true;
        console.log("ℹ️ USD-USDC already configured");
    } catch (error) {
        // Not configured yet
    }
    
    if (!usdUsdcConfigured) {
        const configUsdcTx = await oracleManager.configureAsset(
            usdUsdcAssetId,
            [adapterId],
            3600, // 1 hour staleness
            6 // USD-USDC prices have 6 decimals
        );
        await configUsdcTx.wait();
        console.log("✅ USD-USDC configured with asset ID:", usdUsdcAssetId);
    }

    // Step 4: Set initial prices and ensure they're fresh
    console.log("\n4️⃣ Setting initial prices with current timestamp...");

    // Set prices with current timestamp to avoid staleness issues
    const currentTime = Math.floor(Date.now() / 1000);

    // BTC-USD: $45,000
    const btcPrice = ethers.utils.parseUnits("45000", 8);
    await mockAdapter.setPrice(btcUsdAssetId, btcPrice);
    console.log("✅ BTC-USD price set to $45,000");

    // USD-USDC: 1:1
    const usdcPrice = ethers.utils.parseUnits("1", 6);
    await mockAdapter.setPrice(usdUsdcAssetId, usdcPrice);
    console.log("✅ USD-USDC price set to 1:1");

    // Step 5: Update prices in OracleManager and ensure trading is unpaused
    console.log("\n5️⃣ Updating prices in OracleManager...");

    try {
        const btcUpdateTx = await oracleManager.updatePrice(btcUsdAssetId);
        await btcUpdateTx.wait();
        console.log("✅ BTC-USD price updated in OracleManager");
    } catch (error) {
        console.log("⚠️ BTC-USD price update failed:", error.message);
    }

    try {
        const usdcUpdateTx = await oracleManager.updatePrice(usdUsdcAssetId);
        await usdcUpdateTx.wait();
        console.log("✅ USD-USDC price updated in OracleManager");
    } catch (error) {
        console.log("⚠️ USD-USDC price update failed:", error.message);
    }

    // Step 6: Verify setup
    console.log("\n6️⃣ Verifying setup...");

    const [btcPriceCheck, btcTimestamp, btcPaused] = await oracleManager.getPrice(btcUsdAssetId);
    console.log("📊 BTC-USD:", {
        price: ethers.utils.formatUnits(btcPriceCheck, 8),
        timestamp: new Date(btcTimestamp * 1000).toISOString(),
        isPaused: btcPaused,
        status: btcPaused ? "❌ PAUSED - Trading Disabled" : "✅ ACTIVE - Trading Enabled"
    });

    const [usdcPriceCheck, usdcTimestamp, usdcPaused] = await oracleManager.getPrice(usdUsdcAssetId);
    console.log("📊 USD-USDC:", {
        price: ethers.utils.formatUnits(usdcPriceCheck, 6),
        timestamp: new Date(usdcTimestamp * 1000).toISOString(),
        isPaused: usdcPaused,
        status: usdcPaused ? "❌ PAUSED - Trading Disabled" : "✅ ACTIVE - Trading Enabled"
    });

    // Check for trading pause issues
    if (btcPaused || usdcPaused) {
        console.log("\n⚠️ WARNING: Some assets have paused trading!");
        console.log("💡 This will prevent cross-currency orders from working.");
        console.log("🔧 To fix this, run: npx hardhat run scripts/admin-scripts/15-update-oracle-prices.js --network baseSepolia");
        console.log("🔧 Or manually update prices to resume trading.");
    } else {
        console.log("\n✅ All oracle prices are active - cross-currency trading is enabled!");
    }

    // Test conversion path
    const conversionPath = await adminConfig.getCrossCurrencyConversionPath(SEC_MOCK_TOKEN_ADDRESS, MOCK_TOKEN_ADDRESS);
    console.log("🔄 BTC to USDC conversion path:", conversionPath.map(id => id));

    console.log("\n🎉 Cross-Currency Setup Complete!");
    console.log("\n📝 Summary:");
    console.log("- MockOracleAdapter:", mockAdapter.address);
    console.log("- Adapter ID:", adapterId);
    console.log("- BTC-USD Asset ID:", btcUsdAssetId);
    console.log("- USD-USDC Asset ID:", usdUsdcAssetId);
    console.log("- mUSDC (USDC):", MOCK_TOKEN_ADDRESS);
    console.log("- mBTC (BTC):", SEC_MOCK_TOKEN_ADDRESS);

    console.log("\n💡 Next steps:");
    console.log("- Create conditions and positions");
    console.log("- Test cross-currency orders");
    console.log("- Update prices as needed: mockAdapter.setPrice(assetId, newPrice)");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });