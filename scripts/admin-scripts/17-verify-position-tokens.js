const { ethers } = require("hardhat");

async function main() {
    console.log("🔍 Verifying position tokens and condition...");

    const [deployer] = await ethers.getSigners();
    console.log("📝 Operating with account:", deployer.address);

    // Configuration from .env
    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS;
    const CONDITION_ID = process.env.CONDITION_ID;
    const QUESTION_ID = process.env.QUESTION_ID;
    const POSITION_ID_0 = process.env.POSITION_ID_0;
    const POSITION_ID_1 = process.env.POSITION_ID_1;
    const COLLATERAL_TOKEN_ADDRESS = process.env.COLLATERAL_TOKEN_ADDRESS;

    console.log("💎 Diamond Address:", DIAMOND_ADDRESS);
    console.log("🎯 Condition ID:", CONDITION_ID);
    console.log("❓ Question ID:", QUESTION_ID);
    console.log("🪙 Collateral Token:", COLLATERAL_TOKEN_ADDRESS);
    console.log("📍 Position ID 0:", POSITION_ID_0);
    console.log("📍 Position ID 1:", POSITION_ID_1);

    // Get contract instances
    const conditionManager = await ethers.getContractAt("ConditionManagerFacet", DIAMOND_ADDRESS);
    const erc1155 = await ethers.getContractAt("ERC1155Facet", DIAMOND_ADDRESS);
    const adminConfig = await ethers.getContractAt("AdminConfigFacet", DIAMOND_ADDRESS);

    try {
        // 1. Verify condition exists and is active
        console.log("\n1️⃣ Checking condition status...");
        const condition = await conditionManager.getCondition(CONDITION_ID);
        console.log("📊 Condition details:", {
            oracle: condition.oracle,
            questionId: condition.questionId,
            outcomeSlotCount: condition.outcomeSlotCount.toString(),
            active: condition.active
        });

        if (!condition.active) {
            console.log("⚠️ Warning: Condition is not active");
        } else {
            console.log("✅ Condition is active");
        }

        // 2. Check if collateral token is registered
        console.log("\n2️⃣ Checking collateral token registration...");
        const isAllowedCollateral = await adminConfig.isAllowedCollateral(COLLATERAL_TOKEN_ADDRESS);
        console.log("📊 Is allowed collateral:", isAllowedCollateral);

        if (isAllowedCollateral) {
            console.log("✅ Collateral token is registered");
        } else {
            console.log("❌ Collateral token is not registered - need to add it");
        }

        // 3. Check position token balances
        console.log("\n3️⃣ Checking position token balances...");
        const balance0 = await erc1155.balanceOf(deployer.address, POSITION_ID_0);
        const balance1 = await erc1155.balanceOf(deployer.address, POSITION_ID_1);
        
        console.log(`📊 Position 0 balance: ${ethers.utils.formatEther(balance0)}`);
        console.log(`📊 Position 1 balance: ${ethers.utils.formatEther(balance1)}`);

        if (balance0.gt(0) || balance1.gt(0) ) {
            console.log("✅ Position tokens found!");
        } else {
            console.log("⚠️ No position tokens in this account");
        }

        // 4. Get token symbol if possible
        console.log("\n4️⃣ Getting collateral token info...");
        try {
            const collateralToken = await ethers.getContractAt("MockERC20", COLLATERAL_TOKEN_ADDRESS);
            const symbol = await collateralToken.symbol();
            const decimals = await collateralToken.decimals();
            const userBalance = await collateralToken.balanceOf(deployer.address);
            
            console.log("📊 Collateral token details:", {
                symbol: symbol,
                decimals: decimals.toString(),
                userBalance: ethers.utils.formatUnits(userBalance, decimals)
            });
        } catch (error) {
            console.log("⚠️ Could not get collateral token details:", error.message);
        }

        console.log("\n🎉 Verification complete!");
        
        // Provide next steps based on findings
        if (!isAllowedCollateral) {
            console.log("\n💡 Next steps:");
            console.log("1. Add collateral token: Update admin script to add this token as collateral");
            console.log("2. Then proceed with cross-currency setup");
        } else if (balance0.eq(0) && balance1.eq(0)) {
            console.log("\n💡 Next steps:");
            console.log("1. Mint some collateral tokens");
            console.log("2. Split position to get YES/NO tokens");
            console.log("3. Then proceed with cross-currency orders");
        } else {
            console.log("\n✅ Ready for cross-currency trading!");
            console.log("💡 Next step: Run cross-currency order creation script");
        }

    } catch (error) {
        console.error("❌ Verification failed:", error.message);
        
        // Try to give helpful debugging info
        if (error.message.includes("call revert exception")) {
            console.log("💡 This might indicate:");
            console.log("- Condition ID doesn't exist on this network");
            console.log("- Contract is not deployed properly");
            console.log("- Network connection issues");
        }
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });