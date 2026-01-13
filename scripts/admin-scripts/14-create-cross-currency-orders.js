const { ethers } = require("hardhat");

async function main() {
    console.log("🚀 Creating sample cross-currency orders...");

    const [deployer] = await ethers.getSigners();
    console.log("📝 Operating with account:", deployer.address);

    // Configuration
    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "YOUR_DIAMOND_ADDRESS_HERE";
    const MOCK_TOKEN_ADDRESS = process.env.MOCK_TOKEN_ADDRESS || "YOUR_MUSDC_ADDRESS_HERE";
    const SEC_MOCK_TOKEN_ADDRESS = process.env.SEC_MOCK_TOKEN_ADDRESS || "YOUR_MBTC_ADDRESS_HERE";
    const COLLATERAL_TOKEN_ADDRESS = process.env.COLLATERAL_TOKEN_ADDRESS || process.env.MOCK_TOKEN_ADDRESS || "YOUR_COLLATERAL_ADDRESS_HERE";
    const POSITION_ID_YES = process.env.POSITION_ID_1 || "YOUR_YES_POSITION_ID_HERE";
    const POSITION_ID_NO = process.env.POSITION_ID_0 || "YOUR_NO_POSITION_ID_HERE";

    if (DIAMOND_ADDRESS === "YOUR_DIAMOND_ADDRESS_HERE") {
        throw new Error("❌ Please set DIAMOND_ADDRESS environment variable");
    }
    if (MOCK_TOKEN_ADDRESS === "YOUR_MUSDC_ADDRESS_HERE") {
        throw new Error("❌ Please set MOCK_TOKEN_ADDRESS environment variable");
    }
    if (SEC_MOCK_TOKEN_ADDRESS === "YOUR_MBTC_ADDRESS_HERE") {
        throw new Error("❌ Please set SEC_MOCK_TOKEN_ADDRESS environment variable");
    }
    if (COLLATERAL_TOKEN_ADDRESS === "YOUR_COLLATERAL_ADDRESS_HERE") {
        throw new Error("❌ Please set COLLATERAL_TOKEN_ADDRESS environment variable");
    }
    if (POSITION_ID_YES === "YOUR_YES_POSITION_ID_HERE") {
        throw new Error("❌ Please set POSITION_ID_1 (YES position) environment variable");
    }
    if (POSITION_ID_NO === "YOUR_NO_POSITION_ID_HERE") {
        throw new Error("❌ Please set POSITION_ID_0 (NO position) environment variable");
    }

    console.log("💎 Diamond Address:", DIAMOND_ADDRESS);
    console.log("🪙 mUSDC Address:", MOCK_TOKEN_ADDRESS);
    console.log("₿ mBTC Address:", SEC_MOCK_TOKEN_ADDRESS);
    console.log("💰 Collateral Token:", COLLATERAL_TOKEN_ADDRESS);
    console.log("📍 YES Position ID:", POSITION_ID_YES);
    console.log("📍 NO Position ID:", POSITION_ID_NO);

    // Get contract instances
    const orderCreation = await ethers.getContractAt("OrderCreationFacet", DIAMOND_ADDRESS);
    const mockUSDC = await ethers.getContractAt("MockERC20", MOCK_TOKEN_ADDRESS);
    const mockBTC = await ethers.getContractAt("MockERC20", SEC_MOCK_TOKEN_ADDRESS);
    const erc1155 = await ethers.getContractAt("ERC1155Facet", DIAMOND_ADDRESS);

    // Step 1.5: Check position token balances
    console.log("\n1️⃣5️⃣ Checking position token balances...");
    const yesBalance = await erc1155.balanceOf(deployer.address, POSITION_ID_YES);
    const noBalance = await erc1155.balanceOf(deployer.address, POSITION_ID_NO);
    
    console.log(`📊 YES tokens: ${ethers.utils.formatEther(yesBalance)}`);
    console.log(`📊 NO tokens: ${ethers.utils.formatEther(noBalance)}`);
    
    const requiredYes = ethers.utils.parseUnits("100", 18);
    const requiredNo = ethers.utils.parseUnits("100", 18);
    
    if (yesBalance.lt(requiredYes) || noBalance.lt(requiredNo)) {
        console.log("\n❌ Insufficient position tokens detected!");
        console.log("🔧 To fix this, you need to run the setup market script first:");
        console.log("   npx hardhat run scripts/admin-scripts/13-setup-test-market.js --network baseSepolia");
        console.log("\n💡 This script will:");
        console.log("   1. Create a test market condition");
        console.log("   2. Split collateral to generate YES/NO position tokens");
        console.log("   3. Provide the position IDs to update in your .env file");
        console.log("\n📋 Required tokens:");
        console.log(`   - YES tokens needed: ${ethers.utils.formatEther(requiredYes)}, have: ${ethers.utils.formatEther(yesBalance)}`);
        console.log(`   - NO tokens needed: ${ethers.utils.formatEther(requiredNo)}, have: ${ethers.utils.formatEther(noBalance)}`);
        throw new Error("❌ Insufficient position tokens. Run market setup script first.");
    }
    console.log("✅ Sufficient position tokens available");

    // Step 1: Mint and approve tokens for orders
    console.log("\n1️⃣ Minting and approving tokens...");

    // Mint mUSDC for YES sellers
    const usdcAmount = ethers.utils.parseUnits("10000", 6); // 10,000 USDC
    await mockUSDC.mint(deployer.address, usdcAmount);
    await mockUSDC.approve(DIAMOND_ADDRESS, usdcAmount);
    console.log("✅ Minted and approved", ethers.utils.formatUnits(usdcAmount, 6), "mUSDC");

    // Mint mBTC for BTC buyers
    const btcAmount = ethers.utils.parseUnits("100", 8); // 100 BTC
    await mockBTC.mint(deployer.address, btcAmount);
    await mockBTC.approve(DIAMOND_ADDRESS, btcAmount);
    console.log("✅ Minted and approved", ethers.utils.formatUnits(btcAmount, 8), "mBTC");

    // Step 2: Create Dynamic Cross-Currency Order (Sell YES for BTC, priced in USDC)
    console.log("\n2️⃣ Creating Dynamic Cross-Currency Order...");
    console.log("   Type: Sell YES tokens for mBTC, priced in mUSDC with floor protection");

    const dynamicOrderTx = await orderCreation.createOrder(
        POSITION_ID_YES, // YES position
        SEC_MOCK_TOKEN_ADDRESS, // mBTC as collateral (what we're receiving)
        ethers.utils.parseUnits("100", 18), // 100 YES tokens
        ethers.utils.parseUnits("0.001", 8), // Listed price: 0.001 BTC per token
        0, // minFillAmount
        0, // expiry (0 = no expiry)
        false, // fillOrKill
        1, // SELL direction
        1, // DYNAMIC execution type
        {
            quoteCurrencyToken: MOCK_TOKEN_ADDRESS, // mUSDC for pricing
            floorRate: ethers.utils.parseUnits("40000", 0) // $40,000 minimum BTC rate
        }
    );
    await dynamicOrderTx.wait();
    console.log("✅ Dynamic order created (Order ID: 1)");

    // Step 3: Create Fixed Cross-Currency Order (Buy NO for BTC at fixed USDC price)
    console.log("\n3️⃣ Creating Fixed Cross-Currency Order...");
    console.log("   Type: Buy NO tokens with mBTC at fixed mUSDC price");

    const fixedOrderTx = await orderCreation.createOrder(
        POSITION_ID_NO, // NO position
        SEC_MOCK_TOKEN_ADDRESS, // mBTC as collateral (what we're paying with)
        ethers.utils.parseUnits("50", 18), // 50 NO tokens
        ethers.utils.parseUnits("45", 6), // Fixed price: 45 USDC per token
        0, // minFillAmount
        0, // expiry
        false, // fillOrKill
        0, // BUY direction
        0, // FIXED execution type
        {
            quoteCurrencyToken: MOCK_TOKEN_ADDRESS, // mUSDC for pricing
            floorRate: 0 // Not used for fixed orders
        }
    );
    await fixedOrderTx.wait();
    console.log("✅ Fixed order created (Order ID: 2)");

    // Step 4: Create Complementary Fixed Order (Sell NO for USDC at fixed price)
    console.log("\n4️⃣ Creating Complementary Fixed Order...");
    console.log("   Type: Sell NO tokens for mUSDC at fixed price");

    const complementaryOrderTx = await orderCreation.createOrder(
        POSITION_ID_NO, // NO position
        MOCK_TOKEN_ADDRESS, // mUSDC as collateral
        ethers.utils.parseUnits("50", 18), // 50 NO tokens
        ethers.utils.parseUnits("45", 6), // Fixed price: 45 USDC per token
        0, // minFillAmount
        0, // expiry
        false, // fillOrKill
        1, // SELL direction
        0, // FIXED execution type
        {
            quoteCurrencyToken: ethers.constants.AddressZero, // No cross-currency
            floorRate: 0
        }
    );
    await complementaryOrderTx.wait();
    console.log("✅ Complementary order created (Order ID: 3)");

    console.log("\n🎉 Cross-Currency Orders Created!");
    console.log("\n📝 Summary:");
    console.log("- Order 1: Dynamic - Sell 100 YES for mBTC @ 0.001 BTC/token (min $40k rate)");
    console.log("- Order 2: Fixed - Buy 50 NO with mBTC @ 45 USDC/token");
    console.log("- Order 3: Fixed - Sell 50 NO for mUSDC @ 45 USDC/token");
    console.log("- These orders should match automatically if trading is active!");

    // Check oracle status to verify cross-currency can work
    console.log("\n🔍 Checking oracle status for cross-currency trading...");
    try {
        const oracleManager = await ethers.getContractAt("OracleManagerFacet", DIAMOND_ADDRESS);
        const btcUsdAssetId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("BTC-USD"));
        const usdUsdcAssetId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("USD-USDC"));
        
        const [btcPrice, btcTimestamp, btcPaused] = await oracleManager.getPrice(btcUsdAssetId);
        const [usdcPrice, usdcTimestamp, usdcPaused] = await oracleManager.getPrice(usdUsdcAssetId);
        
        if (btcPaused || usdcPaused) {
            console.log("⚠️ WARNING: Oracle prices are paused - cross-currency orders may not execute!");
            console.log("🔧 Run: npx hardhat run scripts/admin-scripts/15-update-oracle-prices.js --network baseSepolia");
        } else {
            console.log("✅ Oracle prices are active - cross-currency orders should execute!");
        }
    } catch (error) {
        console.log("⚠️ Could not check oracle status:", error.message);
    }

    console.log("\n💡 Next steps:");
    console.log("- Check order book status with view functions");
    console.log("- Monitor for automatic matching");
    console.log("- Test price updates and their effect on dynamic orders");
    console.log("- Try creating more orders to test different scenarios");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });