const { ethers } = require("hardhat");
require("dotenv").config();

// Import utility functions from test utils
const {
  QuestionType,
  encodeDifficultyThreshold,
  encodeDifficultyRange,
  encodeBlockCount,
  encodeMiningDuration,
} = require("../../test/utils/oracleAdapterUtils.js");

async function main() {
    console.log("🚀 Creating condition with metadata (Oracle Adapter questions)...");
    
    const [deployer] = await ethers.getSigners();
    console.log("📝 Operating with account:", deployer.address);
    console.log("💰 Account balance:", ethers.utils.formatEther(await deployer.getBalance()), "ETH");
    
    // Configuration from .env
    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS;
    
    if (!DIAMOND_ADDRESS) {
        throw new Error("❌ Please set DIAMOND_ADDRESS in .env file");
    }
    
    console.log("💎 Diamond Address:", DIAMOND_ADDRESS);
    
    // Get contract interfaces
    console.log("\n1️⃣ Connecting to Diamond contracts...");
    const ConditionManagerFacet = await ethers.getContractFactory("ConditionManagerFacet");
    const diamond = ConditionManagerFacet.attach(DIAMOND_ADDRESS);
    
    // Get block header oracle interface
    const blockHeaderOracle = await ethers.getContractAt("IDoefinBlockHeaderOracle", DIAMOND_ADDRESS);
    
    // Get current block height for validation
    const currentBlockHeight = await blockHeaderOracle.getCurrentBlockHeight();
    console.log("📊 Current block height:", currentBlockHeight.toString());
    
    // === SIMPLE CONFIGURATION - EDIT THESE VALUES DIRECTLY ===
    const TARGET_BLOCK_HEIGHT = 949000;  // Bitcoin block number to target (next difficulty adjustment)
    const TARGET_DIFFICULTY = "169000000000000";  // Target difficulty (169T)
    
    // Configuration for question creation
    const QUESTION_CONFIG = {
        // Question type to create (change this to test different types)
        type: QuestionType.DifficultyThreshold,
        
        // DifficultyThreshold parameters - direct input, no calculations
        difficultyThreshold: ethers.BigNumber.from(TARGET_DIFFICULTY),
        targetBlockHeight: TARGET_BLOCK_HEIGHT,
        
        // General parameters
        outcomeSlotCount: 2, // Binary outcome: Yes/No
        metadataURI: "https://doefin.com/questions/btc-difficulty-threshold",
        salt: ethers.utils.randomBytes(32) // Random salt for uniqueness
    };
    
    console.log("\n2️⃣ Question Configuration:");
    console.log("   Type:", Object.keys(QuestionType)[QUESTION_CONFIG.type]);
    console.log("   Target Block Height:", QUESTION_CONFIG.targetBlockHeight.toString());
    console.log("   Target Difficulty:", TARGET_DIFFICULTY, "(169T)");
    console.log("   Outcome Slots:", QUESTION_CONFIG.outcomeSlotCount);
    console.log("   Metadata URI:", QUESTION_CONFIG.metadataURI);
    
    // Encode metadata based on question type
    let metadata;
    switch(QUESTION_CONFIG.type) {
        case QuestionType.DifficultyThreshold:
            console.log("   Difficulty Threshold:", ethers.utils.formatUnits(QUESTION_CONFIG.difficultyThreshold, 0));
            console.log("   Question: Will difficulty >= threshold at target block?");
            metadata = encodeDifficultyThreshold(
                QUESTION_CONFIG.difficultyThreshold, 
                QUESTION_CONFIG.targetBlockHeight
            );
            break;
            
        case QuestionType.DifficultyRange:
            // Example for range questions
            const buckets = [
                ethers.utils.parseUnits("40", "gwei"),
                ethers.utils.parseUnits("50", "gwei"), 
                ethers.utils.parseUnits("60", "gwei")
            ];
            QUESTION_CONFIG.outcomeSlotCount = 4; // 3 buckets + 1 = 4 outcomes
            console.log("   Difficulty Buckets:", buckets.map(b => ethers.utils.formatUnits(b, "gwei")).join(", "), "GWei");
            metadata = encodeDifficultyRange(QUESTION_CONFIG.targetBlockHeight, buckets);
            break;
            
        case QuestionType.BlockCount:
            // Example for block count questions
            const currentTime = Math.floor(Date.now() / 1000);
            const startTimestamp = currentTime + 3600; // Start 1 hour from now
            const endTimestamp = startTimestamp + 86400; // End 24 hours later
            const countBuckets = [10, 20, 30]; // 10, 20, 30 blocks
            QUESTION_CONFIG.outcomeSlotCount = 4; // 3 buckets + 1 = 4 outcomes
            console.log("   Start Time:", new Date(startTimestamp * 1000).toISOString());
            console.log("   End Time:", new Date(endTimestamp * 1000).toISOString());
            console.log("   Count Buckets:", countBuckets.join(", "));
            metadata = encodeBlockCount(startTimestamp, endTimestamp, countBuckets);
            break;
            
        case QuestionType.MiningDuration:
            // Example for mining duration questions
            const startBlockHeight = currentBlockHeight + 5;
            const blockCount = 10; // Mine 10 blocks
            const durationBuckets = [600, 1200, 1800]; // 10, 20, 30 minutes in seconds
            QUESTION_CONFIG.outcomeSlotCount = 4; // 3 buckets + 1 = 4 outcomes
            console.log("   Start Block Height:", startBlockHeight.toString());
            console.log("   Block Count:", blockCount);
            console.log("   Duration Buckets:", durationBuckets.join(", "), "seconds");
            metadata = encodeMiningDuration(startBlockHeight, blockCount, durationBuckets);
            break;
            
        default:
            throw new Error("❌ Unsupported question type");
    }
    
    console.log("\n3️⃣ Creating condition with metadata...");
    try {
        const createTx = await diamond.createConditionWithMetadata(
            QUESTION_CONFIG.type,
            metadata,
            QUESTION_CONFIG.outcomeSlotCount,
            QUESTION_CONFIG.metadataURI,
            QUESTION_CONFIG.salt,
            { gasLimit: 1000000 } // Sufficient gas limit
        );
        
        console.log("📤 Transaction sent:", createTx.hash);
        
        // Wait for confirmation
        const receipt = await createTx.wait();
        console.log("✅ Transaction confirmed in block:", receipt.blockNumber);
        
        // Parse ConditionCreated event
        let conditionId = null;
        let questionId = null;
        
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
            conditionId = parsed.args.conditionId;
            questionId = parsed.args.questionId;
            
            console.log("🎉 ConditionCreated event emitted:");
            console.log("   Condition ID:", conditionId);
            console.log("   Question ID:", questionId);
            console.log("   Oracle:", parsed.args.oracle);
            console.log("   Outcome Slots:", parsed.args.outcomeSlotCount.toString());
            console.log("   Creator:", parsed.args.creator);
        }
        
        // Verify the condition was created
        if (conditionId) {
            console.log("\n4️⃣ Verifying condition creation...");
            const conditionInfo = await diamond.getCondition(conditionId);
            console.log("✅ Condition successfully created:");
            console.log("   Oracle:", conditionInfo.oracle);
            console.log("   Active:", conditionInfo.active);
            console.log("   Creator:", conditionInfo.creator);
            console.log("   Metadata URI:", conditionInfo.metadataURI);
        }
        
        console.log("\n🎉 Condition creation complete!");
        console.log("\n📋 Summary:");
        console.log(`   Question Type: ${Object.keys(QuestionType)[QUESTION_CONFIG.type]}`);
        console.log(`   Target Block: ${TARGET_BLOCK_HEIGHT}`);
        console.log(`   Target Difficulty: ${TARGET_DIFFICULTY}`);
        console.log(`   Condition ID: ${conditionId}`);
        console.log(`   Question ID: ${questionId}`);
        console.log(`   Outcomes: ${QUESTION_CONFIG.outcomeSlotCount} (Binary: Yes/No)`);
        
        console.log("\n💡 Environment Variables for .env:");
        console.log(`CONDITION_ID=${conditionId}`);
        console.log(`QUESTION_ID=${questionId}`);
        
        console.log("\n🔄 Next Steps:");
        console.log("   1. Run script 5: Split condition to create position tokens");
        console.log("      Command: npx hardhat run scripts/admin-scripts/5-split-condition.js --network baseSepolia");
        console.log("   2. Wait for target block height to be reached");
        console.log("   3. Oracle will automatically resolve the condition");
        
    } catch (error) {
        console.error("❌ Condition creation failed:", error);
        
        // Better error messages for common issues
        if (error.message.includes("InvalidOutcomeSlotCount")) {
            console.error("💡 Hint: outcomeSlotCount must be > 1");
        } else if (error.message.includes("InvalidTargetBlockHeight")) {
            console.error("💡 Hint: Target block height must be greater than current block height");
        } else if (error.message.includes("NotAuthorized")) {
            console.error("💡 Hint: Make sure the account is added as a market maker");
        }
        
        throw error;
    }
}

// Helper function to display usage instructions
function displayUsage() {
    console.log("\n📖 Usage Instructions:");
    console.log("This script creates different types of oracle questions using createConditionWithMetadata()");
    console.log("\nSupported Question Types:");
    console.log("  • DifficultyThreshold - Binary: Will difficulty exceed threshold at target block?");
    console.log("  • DifficultyRange - Multiple: Which difficulty range will the target block be in?");
    console.log("  • BlockCount - Multiple: How many blocks will be mined in time period?");
    console.log("  • MiningDuration - Multiple: How long will it take to mine N blocks?");
    console.log("\nTo change question type, modify QUESTION_CONFIG.type in the script");
    console.log("Example: type: QuestionType.DifficultyRange");
}

main()
    .then(() => {
        displayUsage();
        process.exit(0);
    })
    .catch((error) => {
        console.error("❌ Error:", error.message);
        displayUsage();
        process.exit(1);
    });