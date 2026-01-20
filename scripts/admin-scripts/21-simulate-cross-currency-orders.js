const { ethers } = require("hardhat");

async function main() {
    console.log("🚀 Testing Cross-Currency Route Simulation...");

    const [deployer] = await ethers.getSigners();
    console.log("📝 Operating with account:", deployer.address);

    // Configuration from environment
    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "YOUR_DIAMOND_ADDRESS_HERE";
    const MOCK_TOKEN_ADDRESS = process.env.MOCK_TOKEN_ADDRESS || "YOUR_MUSDC_ADDRESS_HERE";
    const SEC_MOCK_TOKEN_ADDRESS = process.env.SEC_MOCK_TOKEN_ADDRESS || "YOUR_MBTC_ADDRESS_HERE";
    const POSITION_ID_YES = process.env.POSITION_ID_1 || "YOUR_YES_POSITION_ID_HERE";
    const POSITION_ID_NO = process.env.POSITION_ID_0 || "YOUR_NO_POSITION_ID_HERE";

    // Validation
    if (DIAMOND_ADDRESS === "YOUR_DIAMOND_ADDRESS_HERE") {
        throw new Error("❌ Please set DIAMOND_ADDRESS environment variable");
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
    console.log("📍 YES Position ID:", POSITION_ID_YES);
    console.log("📍 NO Position ID:", POSITION_ID_NO);

    // Get contract instances
    const routeSimulation = await ethers.getContractAt([
        "function simulateMarketOrder(uint256 positionId, uint256 sharesOrBudgetAmount, uint8 direction, tuple(address quoteCurrencyAddress, uint64 crossCurrencyTolerancePercent) crossCurrencyData) external view returns (tuple(uint256[] orderIds, uint256[] fillAmounts, uint256 totalFilled, uint256 totalCost, tuple(uint256 fromAmount, uint256 toAmount, uint256 rate)[] crossCurrencyConversions) route)"
    ], DIAMOND_ADDRESS);

    console.log("\n=== Cross-Currency Route Simulation Tests ===\n");

    // Test scenarios
    const testScenarios = [
        {
            name: "Regular Market Order (No Cross-Currency)",
            positionId: POSITION_ID_YES,
            amount: ethers.utils.parseEther("100"), // 100 tokens
            direction: 0, // BUY
            crossCurrencyData: {
                quoteCurrencyAddress: ethers.constants.AddressZero, // No cross-currency
                crossCurrencyTolerancePercent: 0
            }
        },
        {
            name: "Cross-Currency Market Order (USDC → BTC, 5% tolerance)",
            positionId: POSITION_ID_YES,
            amount: ethers.utils.parseEther("50"), // 50 tokens
            direction: 0, // BUY
            crossCurrencyData: {
                quoteCurrencyAddress: SEC_MOCK_TOKEN_ADDRESS, // mBTC as quote currency
                crossCurrencyTolerancePercent: 500 // 5% (500 basis points)
            }
        },
        {
            name: "Cross-Currency Market Order (BTC → USDC, 3% tolerance)",
            positionId: POSITION_ID_NO,
            amount: ethers.utils.parseEther("25"), // 25 tokens
            direction: 1, // SELL
            crossCurrencyData: {
                quoteCurrencyAddress: MOCK_TOKEN_ADDRESS, // mUSDC as quote currency
                crossCurrencyTolerancePercent: 300 // 3% (300 basis points)
            }
        },
        {
            name: "Large Cross-Currency Order (BTC → USDC, 1% tolerance)",
            positionId: POSITION_ID_YES,
            amount: ethers.utils.parseEther("200"), // 200 tokens
            direction: 0, // BUY
            crossCurrencyData: {
                quoteCurrencyAddress: MOCK_TOKEN_ADDRESS, // mUSDC as quote currency
                crossCurrencyTolerancePercent: 100 // 1% (100 basis points)
            }
        }
    ];

    // Execute simulations
    for (let i = 0; i < testScenarios.length; i++) {
        const scenario = testScenarios[i];
        
        console.log(`${i + 1}️⃣ ${scenario.name}`);
        console.log(`   Position ID: ${scenario.positionId}`);
        console.log(`   Amount: ${ethers.utils.formatEther(scenario.amount)}`);
        console.log(`   Direction: ${scenario.direction === 0 ? 'BUY' : 'SELL'}`);
        
        if (scenario.crossCurrencyData.quoteCurrencyAddress !== ethers.constants.AddressZero) {
            console.log(`   Quote Currency: ${scenario.crossCurrencyData.quoteCurrencyAddress}`);
            console.log(`   Tolerance: ${scenario.crossCurrencyData.crossCurrencyTolerancePercent / 100}%`);
        } else {
            console.log(`   Cross-Currency: Disabled`);
        }

        try {
            // Call the new unified simulateMarketOrder function
            const result = await routeSimulation.simulateMarketOrder(
                scenario.positionId,
                scenario.amount,
                scenario.direction,
                scenario.crossCurrencyData
            );

            console.log(`   ✅ Simulation successful!`);
            console.log(`   Route Details:`);
            console.log(`     Orders matched: ${result.orderIds.length}`);
            
            if (result.orderIds.length > 0) {
                console.log(`     Order IDs: ${result.orderIds.map(id => id.toString()).join(', ')}`);
                console.log(`     Fill amounts: ${result.fillAmounts.map(amt => ethers.utils.formatEther(amt)).join(', ')}`);
                console.log(`     Total filled: ${ethers.utils.formatEther(result.totalFilled)}`);
                console.log(`     Total cost: ${ethers.utils.formatEther(result.totalCost)}`);
                
                if (result.crossCurrencyConversions && result.crossCurrencyConversions.length > 0) {
                    console.log(`     Cross-currency conversions: ${result.crossCurrencyConversions.length}`);
                    result.crossCurrencyConversions.forEach((conversion, idx) => {
                        console.log(`       ${idx + 1}. From: ${ethers.utils.formatEther(conversion.fromAmount)}`);
                        console.log(`          To: ${ethers.utils.formatEther(conversion.toAmount)}`);
                        console.log(`          Rate: ${ethers.utils.formatEther(conversion.rate)}`);
                    });
                }
            } else {
                console.log(`     No orders can be matched for this amount and direction`);
            }

        } catch (error) {
            console.log(`   ❌ Simulation failed: ${error.message}`);
            
            // Try to extract revert reason
            if (error.message.includes('revert')) {
                const match = error.message.match(/revert (.+?)(?:\s|$|")/);
                if (match) {
                    console.log(`   📋 Revert reason: ${match[1]}`);
                }
            }
        }

        console.log(''); // Empty line for readability
    }

    console.log("🏁 Cross-currency simulation tests completed!");
}

// Error handling
main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Script failed:", error);
        process.exit(1);
    });