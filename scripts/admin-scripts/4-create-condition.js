const { ethers } = require("hardhat");
require("dotenv").config();

async function main() {
    console.log("🚀 Starting prediction condition creation...");
    
    const [deployer] = await ethers.getSigners();
    console.log("📝 Operating with account:", deployer.address);
    console.log("💰 Account balance:", ethers.utils.formatEther(await deployer.getBalance()), "ETH");
    
    // Configuration from .env
    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS;
    const COLLATERAL_TOKEN_ADDRESS = process.env.COLLATERAL_TOKEN_ADDRESS;
    
    if (!DIAMOND_ADDRESS || !COLLATERAL_TOKEN_ADDRESS) {
        throw new Error("❌ Please set DIAMOND_ADDRESS and COLLATERAL_TOKEN_ADDRESS in .env file");
    }
    
    console.log("💎 Diamond Address:", DIAMOND_ADDRESS);
    console.log("🪙 Collateral Token:", COLLATERAL_TOKEN_ADDRESS);
    
    // Use deployer as oracle for testing
    const ORACLE_ADDRESS = deployer.address;
    console.log("🔮 Oracle Address:", ORACLE_ADDRESS);
    
    // Get contract interfaces
    console.log("\n1️⃣ Connecting to Diamond contracts...");
    const ConditionManagerFacet = await ethers.getContractFactory("ConditionManagerFacet");
    const diamond = ConditionManagerFacet.attach(DIAMOND_ADDRESS);
    
    // Generate unique question parameters
    const currentTime = Math.floor(Date.now() / 1000);
    const futureTime = currentTime + (365 * 24 * 60 * 60); // 1 year from now
    const randomSalt = ethers.utils.randomBytes(32);
    
    const questionData = {
        title: "Will Bitcoin reach $150,000 by end of 2025?",
        description: "Prediction market for Bitcoin price target",
        category: "Cryptocurrency",
        oracle: ORACLE_ADDRESS,
        resolutionTime: futureTime,
        salt: randomSalt
    };
    
    // Create unique question ID
    const questionId = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
            ["string", "string", "address", "uint256", "bytes32"],
            [questionData.title, questionData.description, questionData.oracle, questionData.resolutionTime, questionData.salt]
        )
    );
    
    const outcomeSlotCount = 2; // Binary outcome: Yes/No
    const metadataURI = "https://example.com/btc-150k-metadata.json";
    
    console.log("\n2️⃣ Condition Parameters:");
    console.log("   Title:", questionData.title);
    console.log("   Question ID:", questionId);
    console.log("   Oracle:", ORACLE_ADDRESS);
    console.log("   Outcome Slots:", outcomeSlotCount);
    console.log("   Resolution Time:", new Date(questionData.resolutionTime * 1000).toISOString());
    
    // Calculate expected condition ID
    const conditionId = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
            ["address", "bytes32", "uint256"],
            [ORACLE_ADDRESS, questionId, outcomeSlotCount]
        )
    );
    console.log("   Expected Condition ID:", conditionId);
    
    
    // Check if condition already exists
    console.log("\n3️⃣ Checking if condition already exists...");
    try {
        const conditionInfo = await diamond.getCondition(conditionId);
        if (conditionInfo.creator !== "0x0000000000000000000000000000000000000000") {
            console.log("⚠️ Condition already exists:");
            console.log("   Oracle:", conditionInfo.oracle);
            console.log("   Active:", conditionInfo.active);
            console.log("   Creator:", conditionInfo.creator);
            console.log("   Metadata:", conditionInfo.metadataURI);
            
            console.log("\n💡 Using existing condition ID for .env:");
            console.log(`CONDITION_ID=${conditionId}`);
            console.log(`QUESTION_ID=${questionId}`);
            return;
        }
    } catch (error) {
        console.log("✅ Condition doesn't exist, proceeding with creation...");
    }
    
    // Create the condition
    console.log("\n4️⃣ Creating new condition...");
    try {
        const createTx = await diamond.createCondition(
            ORACLE_ADDRESS,
            questionId,
            outcomeSlotCount,
            metadataURI,
            { gasLimit: 800000 } // Sufficient gas limit
        );
        console.log("📤 Transaction sent:", createTx.hash);
        
        // Wait for confirmation
        const receipt = await createTx.wait();
        console.log("✅ Transaction confirmed in block:", receipt.blockNumber);
        
        // Parse ConditionCreated event
        let actualConditionId = null;
        const conditionCreatedEvent = receipt.logs.find(log => {
            try {
                const parsed = diamond.interface.parseLog(log);
                return parsed.name === "ConditionCreated";
            } catch {
                return false;
            }
        });
        
        if (conditionCreatedEvent) {
            const parsed = diamond.interface.parseLog(conditionCreatedEvent);
            actualConditionId = parsed.args.conditionId;
            console.log("🎉 ConditionCreated event emitted:");
            console.log("   Condition ID:", actualConditionId);
            console.log("   Oracle:", parsed.args.oracle);
            console.log("   Outcome Slots:", parsed.args.outcomeSlotCount.toString());
            console.log("   Creator:", parsed.args.creator);
        }
        
        // Verify the condition was created
        if (actualConditionId) {
            console.log("\n5️⃣ Verifying condition creation...");
            const conditionInfo = await diamond.getCondition(actualConditionId);
            console.log("✅ Condition successfully created:");
            console.log("   Oracle:", conditionInfo.oracle);
            console.log("   Active:", conditionInfo.active);
            console.log("   Creator:", conditionInfo.creator);
        }
        
        console.log("\n🎉 Condition creation complete!");
        console.log("\n📋 Summary:");
        console.log(`   Question: ${questionData.title}`);
        console.log(`   Condition ID: ${actualConditionId || conditionId}`);
        console.log(`   Question ID: ${questionId}`);
        console.log(`   Oracle: ${ORACLE_ADDRESS}`);
        console.log(`   Outcomes: ${outcomeSlotCount} (Binary YES/NO)`);
        
        console.log("\n💡 Environment Variables for .env:");
        console.log(`CONDITION_ID=${actualConditionId || conditionId}`);
        console.log(`QUESTION_ID=${questionId}`);
        
        console.log("\n🔄 Next Step:");
        console.log("   Run script 5: Split condition to create position tokens");
        console.log("   Command: npx hardhat run scripts/admin-scripts/5-split-condition.js --network baseSepolia");
        
    } catch (error) {
        console.error("❌ Condition creation failed:", error.message);
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Error:", error);
        process.exit(1);
    });
