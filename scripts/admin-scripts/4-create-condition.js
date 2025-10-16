const { ethers } = require("hardhat");

async function main() {
    console.log("🚀 Starting condition creation...");
    
    const [deployer] = await ethers.getSigners();
    console.log("📝 Operating with account:", deployer.address);
    
    // Configuration
    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "YOUR_DIAMOND_ADDRESS_HERE";
    const ORACLE_ADDRESS = process.env.ORACLE_ADDRESS || deployer.address; // Oracle can be deployer for testing
    
    if (DIAMOND_ADDRESS === "YOUR_DIAMOND_ADDRESS_HERE") {
        throw new Error("❌ Please set DIAMOND_ADDRESS environment variable");
    }
    
    console.log("💎 Diamond Address:", DIAMOND_ADDRESS);
    console.log("🔮 Oracle Address:", ORACLE_ADDRESS);
    
    // Get ConditionManagerFacet interface
    const ConditionManagerFacet = await ethers.getContractFactory("ConditionManagerFacet");
    const diamond = ConditionManagerFacet.attach(DIAMOND_ADDRESS);
    
    // Prepare condition parameters
    const questionId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("Will BTC Difficulty reach 10T by end of 2025?"));
    const outcomeSlotCount = 2; // Binary outcome: Yes/No
    const metadataURI = "https://example.com/btc-10t-metadata.json"; // Metadata for the condition
    
    console.log("📝 Condition Parameters:");
    console.log("Question ID:", questionId);
    console.log("Oracle:", ORACLE_ADDRESS);
    console.log("Outcome Slots:", outcomeSlotCount);
    console.log("Metadata URI:", metadataURI);
    
    // Calculate expected condition ID
    const conditionId = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
            ["address", "bytes32", "uint256"],
            [ORACLE_ADDRESS, questionId, outcomeSlotCount]
        )
    );
    console.log("Expected Condition ID:", conditionId);
    
    // Check if condition already exists
    console.log("\n1️⃣ Checking if condition already exists...");
    try {
        const conditionInfo = await diamond.getCondition(conditionId);
        // Check if condition actually exists by verifying if creator is not zero address
        if (conditionInfo.creator !== "0x0000000000000000000000000000000000000000") {
            console.log("⚠️  Condition already exists:", {
                oracle: conditionInfo.oracle,
                questionId: conditionInfo.questionId,
                outcomeSlotCount: conditionInfo.outcomeSlotCount.toString(),
                metadataURI: conditionInfo.metadataURI,
                active: conditionInfo.active,
                creator: conditionInfo.creator
            });
            return;
        } else {
            console.log("✅ Condition doesn't exist, proceeding with creation...");
        }
    } catch (error) {
        console.log("✅ Condition doesn't exist, proceeding with creation...");
    }
    
    // Create the condition
    console.log("\n2️⃣ Creating condition...");
    const createTx = await diamond.createCondition(
        ORACLE_ADDRESS,
        questionId,
        outcomeSlotCount,
        metadataURI
    );
    console.log("📤 Transaction sent:", createTx.hash);
    
    // Wait for confirmation and listen to events
    const receipt = await createTx.wait();
    console.log("✅ Transaction confirmed in block:", receipt.blockNumber);
    
    // Listen for ConditionCreated event and get the actual condition ID
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
        console.log("🎉 ConditionCreated event:", {
            conditionId: parsed.args.conditionId,
            oracle: parsed.args.oracle,
            questionId: parsed.args.questionId,
            outcomeSlotCount: parsed.args.outcomeSlotCount.toString(),
            metadataURI: parsed.args.metadataURI,
            creator: parsed.args.creator
        });
    }
    
    // Verify condition was created using the actual condition ID
    console.log("\n3️⃣ Verifying condition creation...");
    if (actualConditionId) {
        try {
            const conditionInfo = await diamond.getCondition(actualConditionId);
            console.log("✅ Condition created successfully:", {
                oracle: conditionInfo.oracle,
                questionId: conditionInfo.questionId,
                outcomeSlotCount: conditionInfo.outcomeSlotCount.toString(),
                metadataURI: conditionInfo.metadataURI,
                active: conditionInfo.active,
                creator: conditionInfo.creator
            });
        } catch (error) {
            console.error("❌ Failed to verify condition creation:", error.message);
        }
    }
    
    console.log("\n📋 Summary:");
    console.log("Actual Condition ID:", actualConditionId || "Not found");
    console.log("Expected Condition ID:", conditionId);
    console.log("Oracle:", ORACLE_ADDRESS);
    console.log("Question ID:", questionId);
    console.log("Outcome Slots:", outcomeSlotCount);
    console.log("Metadata URI:", metadataURI);
    console.log("✅ Condition created successfully!");
    
    // Save condition ID for next script
    console.log("\n💡 Use this Condition ID for the next script:");
    console.log("export CONDITION_ID=" + (actualConditionId || conditionId));
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Error:", error);
        process.exit(1);
    });
