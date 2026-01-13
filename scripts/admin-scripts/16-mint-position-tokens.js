const { ethers } = require("hardhat");

async function main() {
    console.log("🔄 Minting position tokens using existing condition...");

    const [deployer] = await ethers.getSigners();
    console.log("📝 Operating with account:", deployer.address);

    // Configuration
    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "YOUR_DIAMOND_ADDRESS_HERE";
    const MOCK_TOKEN_ADDRESS = process.env.MOCK_TOKEN_ADDRESS || "YOUR_MUSDC_ADDRESS_HERE";
    const CONDITION_ID = process.env.CONDITION_ID || "YOUR_CONDITION_ID_HERE";

    if (DIAMOND_ADDRESS === "YOUR_DIAMOND_ADDRESS_HERE") {
        throw new Error("❌ Please set DIAMOND_ADDRESS environment variable");
    }
    if (MOCK_TOKEN_ADDRESS === "YOUR_MUSDC_ADDRESS_HERE") {
        throw new Error("❌ Please set MOCK_TOKEN_ADDRESS environment variable");
    }
    if (CONDITION_ID === "YOUR_CONDITION_ID_HERE") {
        throw new Error("❌ Please set CONDITION_ID environment variable");
    }

    console.log("💎 Diamond Address:", DIAMOND_ADDRESS);
    console.log("🪙 mUSDC Address:", MOCK_TOKEN_ADDRESS);
    console.log("🎯 Condition ID:", CONDITION_ID);

    // Get contract instances
    const conditionalFacet = await ethers.getContractAt("ConditionalTokensFacet", DIAMOND_ADDRESS);
    const erc1155 = await ethers.getContractAt("ERC1155Facet", DIAMOND_ADDRESS);
    const mockToken = await ethers.getContractAt("MockERC20", MOCK_TOKEN_ADDRESS);
    const conditionManager = await ethers.getContractAt("ConditionManagerFacet", DIAMOND_ADDRESS);

    // Check if condition exists
    console.log("\n1️⃣ Checking condition status...");
    try {
        const condition = await conditionManager.getCondition(CONDITION_ID);
        console.log("📊 Condition details:", {
            oracle: condition.oracle,
            questionId: condition.questionId,
            outcomeSlotCount: condition.outcomeSlotCount,
            active: condition.active
        });

        if (!condition.active) {
            throw new Error("❌ Condition is not active. Cannot split position.");
        }
        
        console.log("✅ Condition is active and ready for splitting");
    } catch (error) {
        console.log("❌ Error checking condition:", error.message);
        throw new Error("❌ Invalid condition. Please check CONDITION_ID in your .env file");
    }

    // Mint and approve collateral
    console.log("\n2️⃣ Minting and approving collateral...");
    const splitAmount = ethers.utils.parseUnits("5000", 6); // 5,000 USDC

    await mockToken.mint(deployer.address, splitAmount);
    console.log("✅ Minted", ethers.utils.formatUnits(splitAmount, 6), "mUSDC");

    await mockToken.approve(DIAMOND_ADDRESS, splitAmount);
    console.log("✅ Approved diamond to spend tokens");

    // Check current balances
    const balance = await mockToken.balanceOf(deployer.address);
    const allowance = await mockToken.allowance(deployer.address, DIAMOND_ADDRESS);
    console.log(`📊 Balance: ${ethers.utils.formatUnits(balance, 6)} mUSDC`);
    console.log(`📊 Allowance: ${ethers.utils.formatUnits(allowance, 6)} mUSDC`);

    // Split position to create YES/NO tokens
    console.log("\n3️⃣ Splitting position to create YES/NO tokens...");
    
    try {
        const splitTx = await conditionalFacet.connect(deployer).splitPosition(
            MOCK_TOKEN_ADDRESS,
            ethers.constants.HashZero, // Parent collectionId
            CONDITION_ID,
            [0, 1], // partition for binary outcome (NO=0, YES=1)
            splitAmount,
            { gasLimit: 800000 } // Increased gas limit
        );
        const splitReceipt = await splitTx.wait();
        console.log("✅ Position split successful");
        
        // Calculate position IDs manually using the CTF formula
        const collectionId0 = ethers.utils.keccak256(
            ethers.utils.solidityPack(
                ["bytes32", "uint256"],
                [CONDITION_ID, 1] // indexSet for NO (outcome 0) = 1
            )
        );
        
        const collectionId1 = ethers.utils.keccak256(
            ethers.utils.solidityPack(
                ["bytes32", "uint256"], 
                [CONDITION_ID, 2] // indexSet for YES (outcome 1) = 2
            )
        );

        const positionIdNO = ethers.utils.keccak256(
            ethers.utils.solidityPack(
                ["address", "bytes32"],
                [MOCK_TOKEN_ADDRESS, collectionId0]
            )
        );

        const positionIdYES = ethers.utils.keccak256(
            ethers.utils.solidityPack(
                ["address", "bytes32"],
                [MOCK_TOKEN_ADDRESS, collectionId1]
            )
        );

        console.log("📍 Calculated position IDs:");
        console.log("  - NO Position ID:", positionIdNO);
        console.log("  - YES Position ID:", positionIdYES);

        // Verify balances
        console.log("\n4️⃣ Verifying token balances...");
        const yesBalance = await erc1155.balanceOf(deployer.address, positionIdYES);
        const noBalance = await erc1155.balanceOf(deployer.address, positionIdNO);
        
        console.log(`📊 YES tokens: ${ethers.utils.formatUnits(yesBalance, 6)}`);
        console.log(`📊 NO tokens: ${ethers.utils.formatUnits(noBalance, 6)}`);

        if (yesBalance.gt(0) && noBalance.gt(0)) {
            console.log("✅ Position tokens successfully created!");
            
            console.log("\n🔧 Update your .env file with these position IDs:");
            console.log(`POSITION_ID_0="${positionIdNO}"`);
            console.log(`POSITION_ID_1="${positionIdYES}"`);
            
            console.log("\n💡 Next steps:");
            console.log("1. Update your .env file with the position IDs above");
            console.log("2. Run: npx hardhat run scripts/admin-scripts/14-create-cross-currency-orders.js --network baseSepolia");
        } else {
            throw new Error("❌ Position token split failed - zero balances detected");
        }

    } catch (error) {
        console.error("❌ Split failed:", error.message);
        
        // Try to provide helpful debugging info
        console.log("\n🔍 Debugging information:");
        console.log("- Check that the condition is properly created and active");
        console.log("- Verify mUSDC is registered as collateral");
        console.log("- Ensure sufficient gas limit");
        console.log("- The CONDITION_ID might be invalid or from a different network");
        
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });