const { ethers } = require("hardhat");

async function main() {
    console.log("🚀 Creating focused cross-currency orders for simulation testing...");

    const [deployer] = await ethers.getSigners();
    console.log("📝 Operating with account:", deployer.address);

    // Configuration
    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS;
    const MOCK_TOKEN_ADDRESS = process.env.MOCK_TOKEN_ADDRESS; // mUSDC
    const SEC_MOCK_TOKEN_ADDRESS = process.env.SEC_MOCK_TOKEN_ADDRESS; // mBTC
    const POSITION_ID_YES = process.env.POSITION_ID_1;
    const POSITION_ID_NO = process.env.POSITION_ID_0;

    console.log("💎 Diamond Address:", DIAMOND_ADDRESS);
    console.log("📍 YES Position ID:", POSITION_ID_YES);
    console.log("📍 NO Position ID:", POSITION_ID_NO);

    // Get contract instances
    const orderCreation = await ethers.getContractAt("OrderCreationFacet", DIAMOND_ADDRESS);
    const mockUSDC = await ethers.getContractAt("MockERC20", MOCK_TOKEN_ADDRESS);
    const mockBTC = await ethers.getContractAt("MockERC20", SEC_MOCK_TOKEN_ADDRESS);

    console.log("\n=== Creating Cross-Currency Orders ===");

    // Cross-currency order data
    const crossCurrencyDataBTC = {
        quoteCurrencyToken: SEC_MOCK_TOKEN_ADDRESS, // BTC as quote currency
        crossCurrencyTolerancePercent: 500 // 5%
    };

    const crossCurrencyDataUSDC = {
        quoteCurrencyToken: MOCK_TOKEN_ADDRESS, // USDC as quote currency
        crossCurrencyTolerancePercent: 300 // 3%
    };

    try {
        console.log("\n1️⃣ Creating cross-currency BUY order (YES tokens, quoted in BTC)...");
        
        // Order to buy YES tokens, quote in BTC, 5% tolerance
        await orderCreation.createLimitOrder(
            POSITION_ID_YES,
            ethers.utils.parseEther("50"), // 50 YES tokens
            ethers.utils.parseEther("0.5"), // Price: 0.5 collateral per token
            0, // BUY
            1, // FIXED execution
            Math.floor(Date.now() / 1000) + 3600, // 1 hour expiry
            ethers.utils.parseEther("10"), // Min fill: 10 tokens
            crossCurrencyDataBTC
        );
        console.log("✅ Cross-currency BUY order created (YES tokens, BTC quote)");

        console.log("\n2️⃣ Creating cross-currency SELL order (NO tokens, quoted in USDC)...");
        
        // Order to sell NO tokens, quote in USDC, 3% tolerance
        await orderCreation.createLimitOrder(
            POSITION_ID_NO,
            ethers.utils.parseEther("30"), // 30 NO tokens
            ethers.utils.parseEther("0.4"), // Price: 0.4 collateral per token
            1, // SELL
            1, // FIXED execution
            Math.floor(Date.now() / 1000) + 7200, // 2 hour expiry
            ethers.utils.parseEther("5"), // Min fill: 5 tokens
            crossCurrencyDataUSDC
        );
        console.log("✅ Cross-currency SELL order created (NO tokens, USDC quote)");

        console.log("\n3️⃣ Creating regular order (for contrast)...");
        
        // Regular order without cross-currency
        const regularCrossCurrencyData = {
            quoteCurrencyToken: ethers.constants.AddressZero, // No cross-currency
            crossCurrencyTolerancePercent: 0
        };

        await orderCreation.createLimitOrder(
            POSITION_ID_YES,
            ethers.utils.parseEther("25"), // 25 YES tokens
            ethers.utils.parseEther("0.6"), // Price: 0.6 collateral per token
            1, // SELL
            1, // FIXED execution
            Math.floor(Date.now() / 1000) + 3600, // 1 hour expiry
            ethers.utils.parseEther("5"), // Min fill: 5 tokens
            regularCrossCurrencyData
        );
        console.log("✅ Regular order created (YES tokens, no cross-currency)");

        console.log("\n🎉 All orders created successfully!");
        console.log("\n📋 Order Summary:");
        console.log("   1. Cross-currency BUY: 50 YES tokens @ 0.5 (BTC quote, 5% tolerance)");
        console.log("   2. Cross-currency SELL: 30 NO tokens @ 0.4 (USDC quote, 3% tolerance)");
        console.log("   3. Regular SELL: 25 YES tokens @ 0.6 (no cross-currency)");
        
        console.log("\n🚀 Ready to test simulation!");

    } catch (error) {
        console.error("❌ Failed to create orders:", error.message);
        
        // Check if it's a gas estimation error
        if (error.message.includes('gas')) {
            console.log("💡 Tip: This might be a gas estimation issue. Try with manual gas limits.");
        }
        
        // Check if it's an allowance issue
        if (error.message.includes('allowance') || error.message.includes('approval')) {
            console.log("💡 Tip: Check token approvals for the diamond contract.");
        }
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Script failed:", error);
        process.exit(1);
    });