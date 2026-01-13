const { ethers } = require("hardhat");
const { splitConditionAndGetPositionIds } = require("../../test/utils/conditionUtils.js");
const { parseTransferBatch } = require("../../test/utils/ctfUtils.js");

async function main() {
    console.log("🚀 Setting up test market for cross-currency orders...");

    const [deployer] = await ethers.getSigners();
    console.log("📝 Operating with account:", deployer.address);

    // Configuration
    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "YOUR_DIAMOND_ADDRESS_HERE";
    const MOCK_TOKEN_ADDRESS = process.env.MOCK_TOKEN_ADDRESS || "YOUR_MUSDC_ADDRESS_HERE";

    if (DIAMOND_ADDRESS === "YOUR_DIAMOND_ADDRESS_HERE") {
        throw new Error("❌ Please set DIAMOND_ADDRESS environment variable");
    }
    if (MOCK_TOKEN_ADDRESS === "YOUR_MUSDC_ADDRESS_HERE") {
        throw new Error("❌ Please set MOCK_TOKEN_ADDRESS environment variable");
    }

    console.log("💎 Diamond Address:", DIAMOND_ADDRESS);
    console.log("🪙 mUSDC Address:", MOCK_TOKEN_ADDRESS);

    // Get contract instances
    const conditionManager = await ethers.getContractAt("ConditionManagerFacet", DIAMOND_ADDRESS);
    const conditionalFacet = await ethers.getContractAt("ConditionalTokensFacet", DIAMOND_ADDRESS);
    const erc1155 = await ethers.getContractAt("ERC1155Facet", DIAMOND_ADDRESS);
    const accessControl = await ethers.getContractAt("AccessControlFacet", DIAMOND_ADDRESS);
    const adminConfig = await ethers.getContractAt("AdminConfigFacet", DIAMOND_ADDRESS);

    // Use existing mUSDC token
    console.log("\n🪙 Using existing Mock USDC...");
    const mockToken = await ethers.getContractAt("MockERC20", MOCK_TOKEN_ADDRESS);
    console.log("✅ Using Mock USDC at:", MOCK_TOKEN_ADDRESS);

    // Check if collateral token is already registered
    console.log("\n📝 Checking collateral token registration...");
    const isAllowedCollateral = await adminConfig.isAllowedCollateral(MOCK_TOKEN_ADDRESS);
    if (!isAllowedCollateral) {
        console.log("📝 Registering collateral token...");
        try {
            const usdcUnit = ethers.utils.parseUnits("1", 6); // 1 USDC = 10^6 units
            const tx = await adminConfig.addCollateralToken(MOCK_TOKEN_ADDRESS, usdcUnit);
            await tx.wait();
            console.log("✅ Collateral token registered");
        } catch (error) {
            console.error("❌ Failed to register collateral token:", error.message);
            throw error;
        }
    } else {
        console.log("✅ Collateral token already registered");
    }

    // Step 1: Create condition
    console.log("\n1️⃣ Creating condition...");
    
    // Check if deployer is a market maker
    const isMarketMaker = await accessControl.isMarketMaker(deployer.address);
    if (!isMarketMaker) {
        console.log("📝 Adding deployer as market maker...");
        await accessControl.addMarketMaker(deployer.address);
        console.log("✅ Deployer added as market maker");
    }
    
    const questionText = `Will BTC reach $100k by EOY 2026? (Run ${Date.now()})`;
    
    // Use the old createCondition for simplicity
    const oracle = DIAMOND_ADDRESS;
    const questionId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(questionText));
    const outcomeSlotCount = 2;
    const metadataURI = "ipfs://btc-100k-prediction-2026";
    
    console.log("📊 Oracle:", oracle);
    console.log("📊 QuestionId:", questionId);
    
    const tx = await conditionManager.createCondition(oracle, questionId, outcomeSlotCount, metadataURI);
    const receipt = await tx.wait();
    
    const conditionId = receipt.events.find(e => e.event === 'ConditionCreated').args.conditionId;
    console.log("📊 Returned conditionId:", conditionId);

    // Check condition details
    const condition = await conditionManager.getCondition(conditionId);
    console.log("📊 Condition details:", {
        oracle: condition.oracle,
        questionId: condition.questionId,
        outcomeSlotCount: condition.outcomeSlotCount,
        active: condition.active
    });

    // Step 2: Mint and approve collateral tokens
    console.log("\n2️⃣ Minting collateral tokens...");
    const splitAmount = ethers.utils.parseUnits("10000", 6); // 10,000 USDC

    await mockToken.mint(deployer.address, splitAmount);
    console.log("✅ Minted", ethers.utils.formatUnits(splitAmount, 6), "mUSDC");

    // Step 3: Approve diamond to spend tokens
    console.log("\n3️⃣ Approving diamond to spend tokens...");
    await mockToken.approve(DIAMOND_ADDRESS, splitAmount);
    console.log("✅ Approved diamond to spend tokens");
    
    // Check allowance
    const allowance = await mockToken.allowance(deployer.address, DIAMOND_ADDRESS);
    console.log(`📊 Allowance: ${ethers.utils.formatUnits(allowance, 6)} mUSDC`);
    if (allowance.lt(splitAmount)) {
        console.log(`⚠️ Insufficient allowance. Expected ${ethers.utils.formatUnits(splitAmount, 6)}, got ${ethers.utils.formatUnits(allowance, 6)}. Proceeding anyway.`);
    }

    // Check balance
    const balance = await mockToken.balanceOf(deployer.address);
    console.log(`📊 Balance: ${ethers.utils.formatUnits(balance, 6)} mUSDC`);
    if (balance.lt(splitAmount)) {
        throw new Error(`❌ Insufficient balance. Expected ${ethers.utils.formatUnits(splitAmount, 6)}, got ${ethers.utils.formatUnits(balance, 6)}`);
    }

    // Step 4: Split condition to create position tokens
    console.log("\n4️⃣ Splitting condition...");
    
    // Check if token is allowed as collateral
    // const isAllowed = await adminConfig.isAllowedCollateral(mockToken.address);
    // console.log(`📊 Token allowed as collateral: ${isAllowed}`);
    // if (!isAllowed) {
    //     throw new Error("❌ Token is not allowed as collateral");
    // }
    
    let positionIdYES, positionIdNO;
    try {
        const splitTx = await conditionalFacet.connect(deployer).splitPosition(
            mockToken.address,
            ethers.constants.HashZero, // Parent collectionId
            conditionId,
            [0, 1], // partition (array of outcome indexes)
            splitAmount,
            { gasLimit: 500000 } // Manual gas limit
        );
        const splitReceipt = await splitTx.wait();
        console.log("✅ Split successful");
        
        // Parse the transfer batch to get position IDs
        const { positionIds, amounts } = parseTransferBatch(splitReceipt, ethers.constants.AddressZero, deployer.address);
        
        if (positionIds.length < 2) {
            throw new Error("❌ Failed to create position tokens - insufficient position IDs returned");
        }
        
        // Extract position IDs (convert to hex strings for display)
        positionIdYES = positionIds[1]; // YES position (index 1)
        positionIdNO = positionIds[0];  // NO position (index 0)
        
        console.log("✅ Position IDs created:");
        console.log("  - NO (index 0):", positionIdNO);
        console.log("  - YES (index 1):", positionIdYES);
    } catch (error) {
        console.error("❌ Split failed:", error.message);
        throw error;
    }

    // Step 5: Check balances
    console.log("\n5️⃣ Checking position token balances...");
    const yesBalance = await erc1155.balanceOf(deployer.address, positionIdYES);
    const noBalance = await erc1155.balanceOf(deployer.address, positionIdNO);
    
    console.log(`📊 YES tokens: ${ethers.utils.formatUnits(yesBalance, 6)}`);
    console.log(`📊 NO tokens: ${ethers.utils.formatUnits(noBalance, 6)}`);
    
    if (yesBalance.lt(splitAmount) || noBalance.lt(splitAmount)) {
        throw new Error(`❌ Split failed. Expected ${ethers.utils.formatUnits(splitAmount, 6)} tokens each, got YES: ${ethers.utils.formatUnits(yesBalance, 6)}, NO: ${ethers.utils.formatUnits(noBalance, 6)}`);
    }
    console.log("✅ Position tokens successfully minted!");

    console.log("\n🎉 Market Setup Complete!");
    console.log("\n📝 Summary:");
    console.log("- Question: Will BTC reach $100k by EOY 2026?");
    console.log("- Condition ID:", conditionId);
    console.log("- YES Position ID (POSITION_ID_1):", positionIdYES);
    console.log("- NO Position ID (POSITION_ID_0):", positionIdNO);
    console.log("- Collateral: mUSDC (", MOCK_TOKEN_ADDRESS, ")");

    console.log("\n🔧 Update your .env file with these values:");
    console.log(`CONDITION_ID="${conditionId}"`);
    console.log(`POSITION_ID_1="${positionIdYES}"`);
    console.log(`POSITION_ID_0="${positionIdNO}"`);

    console.log("\n💡 Next steps:");
    console.log("1. Update your .env file with the above values");
    console.log("2. Run: npx hardhat run scripts/admin-scripts/14-create-cross-currency-orders.js --network baseSepolia");
    console.log("3. Test with different collateral tokens (mBTC) and quote currencies");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });