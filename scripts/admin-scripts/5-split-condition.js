const { ethers } = require("hardhat");

async function main() {
    console.log("🚀 Starting condition splitting...");
    
    const [deployer] = await ethers.getSigners();
    
    // Configuration
    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "YOUR_DIAMOND_ADDRESS_HERE";
    let CONDITION_ID = process.env.CONDITION_ID || "0x4f1dec55e191e759b1f254995797d6f1e8600ae70f81fbce00367f2c9f5e1cf7";
    const COLLATERAL_TOKEN = process.env.MOCK_TOKEN_ADDRESS || "YOUR_MOCK_TOKEN_ADDRESS_HERE";
    const MARKET_MAKER_ADDRESS = process.env.MARKET_MAKER_ADDRESS || deployer.address;
    // Don't set the amount yet - we'll calculate it based on unit
    
    if (DIAMOND_ADDRESS === "YOUR_DIAMOND_ADDRESS_HERE" || 
        COLLATERAL_TOKEN === "YOUR_MOCK_TOKEN_ADDRESS_HERE") {
        throw new Error("❌ Please set DIAMOND_ADDRESS and MOCK_TOKEN_ADDRESS environment variables");
    }
    
    console.log("💎 Diamond Address:", DIAMOND_ADDRESS);
    console.log("🔍 Condition ID:", CONDITION_ID);
    console.log("💰 Collateral Token:", COLLATERAL_TOKEN);
    console.log("🎯 Market Maker:", MARKET_MAKER_ADDRESS);
    
    // Get Market Maker signer
    let marketMakerSigner = deployer;
    if (MARKET_MAKER_ADDRESS !== deployer.address) {
        console.log("ℹ️  Note: Using deployer as signer. If Market Maker is different, update the script with proper signer.");
    }
    
    // Get ConditionalTokensFacet interface
    const ConditionalTokensFacet = await ethers.getContractFactory("ConditionalTokensFacet");
    const diamond = ConditionalTokensFacet.attach(DIAMOND_ADDRESS);
    const diamondWithMM = diamond.connect(marketMakerSigner);
    
    // Verify condition exists
    console.log("\n1️⃣ Verifying condition exists...");
    let conditionInfo;
    try {
        const ConditionManagerFacet = await ethers.getContractFactory("ConditionManagerFacet");
        const conditionManager = ConditionManagerFacet.attach(DIAMOND_ADDRESS);
        conditionInfo = await conditionManager.getCondition(CONDITION_ID);
        
        if (conditionInfo.creator === "0x0000000000000000000000000000000000000000") {
            console.log("❌ Condition not found. Available condition IDs from your previous runs:");
            console.log("- 0x4f1dec55e191e759b1f254995797d6f1e8600ae70f81fbce00367f2c9f5e1cf7 (from ConditionCreated event)");
            console.log("\n💡 Update your CONDITION_ID environment variable:");
            console.log("export CONDITION_ID=0x4f1dec55e191e759b1f254995797d6f1e8600ae70f81fbce00367f2c9f5e1cf7");
            throw new Error("Condition not found");
        }
        
        console.log("✅ Condition found:", {
            oracle: conditionInfo.oracle,
            questionId: conditionInfo.questionId,
            outcomeSlotCount: conditionInfo.outcomeSlotCount.toString(),
            active: conditionInfo.active,
            creator: conditionInfo.creator
        });
        
        if (!conditionInfo.active) {
            throw new Error("Condition is not active!");
        }
    } catch (error) {
        throw new Error("❌ Condition verification failed: " + error.message);
    }

    // Calculate what the condition ID should be based on the condition info
    console.log("\n1.2️⃣ Verifying condition ID calculation...");
    const calculatedConditionId = await diamond.getConditionId(
        conditionInfo.oracle,
        conditionInfo.questionId,
        conditionInfo.outcomeSlotCount
    );
    console.log("📝 Condition ID from ConditionManager:", CONDITION_ID);
    console.log("📝 Calculated Condition ID from parameters:", calculatedConditionId);
    
    // Use calculated ID for operations (they should be the same, just different case)
    const conditionIdToUse = calculatedConditionId.toLowerCase() === CONDITION_ID.toLowerCase() ? CONDITION_ID : calculatedConditionId;
    
    if (CONDITION_ID.toLowerCase() !== calculatedConditionId.toLowerCase()) {
        console.log("⚠️  Condition ID mismatch! Using calculated ID for conditional tokens operations.");
    } else {
        console.log("✅ Condition IDs match (case differences ignored)");
    }

    // Verify condition is prepared in ConditionalTokens using the calculated ID
    console.log("\n1.5️⃣ Verifying condition preparation in ConditionalTokens...");
    try {
        console.log("🔍 Checking with condition ID:", conditionIdToUse);
        const payoutNumerators = await diamond.getPayoutNumerators(conditionIdToUse);
        console.log("✅ Condition prepared with", payoutNumerators.length, "outcome slots");
        console.log("📊 Payout numerators:", payoutNumerators.map(p => p.toString()));
        
        // ADDITIONAL CHECK: Verify the exact same condition ID that will be used in splitPosition
        console.log("\n🔍 Double-checking the exact condition ID for splitPosition...");
        console.log("Condition ID being used:", conditionIdToUse);
        console.log("Condition ID hex length:", conditionIdToUse.length);
        console.log("Condition ID type:", typeof conditionIdToUse);
        
        if (payoutNumerators.length !== parseInt(conditionInfo.outcomeSlotCount.toString())) {
            throw new Error(`Mismatch: ConditionManager shows ${conditionInfo.outcomeSlotCount} slots, but ConditionalTokens shows ${payoutNumerators.length}`);
        }
        
        if (payoutNumerators.length === 0) {
            throw new Error("❌ Condition is not prepared in ConditionalTokens - payout numerators length is 0");
        }
        
    } catch (error) {
        console.error("❌ Condition preparation verification failed:", error.message);
        throw error;
    }

    // Get the unitPerPair for the collateral token
    console.log("\n2️⃣ Getting unitPerPair for collateral token...");
    const AdminConfigFacet = await ethers.getContractFactory("AdminConfigFacet");
    const adminConfig = AdminConfigFacet.attach(DIAMOND_ADDRESS);
    
    try {
        const unit = await adminConfig.getCollateralUnit(COLLATERAL_TOKEN);
        console.log("✅ Token unit per pair:", ethers.utils.formatEther(unit));
        
        // Calculate a properly aligned split amount (multiple of unitPerPair)
        const multiplier = 1000; // We want approximately 1000 tokens
        const SPLIT_AMOUNT = unit.mul(multiplier);
        console.log("💸 Split Amount (aligned):", ethers.utils.formatEther(SPLIT_AMOUNT));
        
        // Check if collateral token is allowed
        console.log("\n3️⃣ Checking if collateral token is allowed...");
        const isAllowed = await adminConfig.isAllowedCollateral(COLLATERAL_TOKEN);
        
        if (!isAllowed) {
            throw new Error("❌ Collateral token is not allowed. Please add it first using script 1.");
        }
        console.log("✅ Collateral token is allowed");
        
        // Check Market Maker's collateral balance
        console.log("\n4️⃣ Checking Market Maker's collateral balance...");
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        const collateralToken = MockERC20.attach(COLLATERAL_TOKEN);
        const balance = await collateralToken.balanceOf(MARKET_MAKER_ADDRESS);
        console.log("MM Balance:", ethers.utils.formatEther(balance));
        
        if (balance.lt(SPLIT_AMOUNT)) {
            throw new Error(`❌ Insufficient collateral balance for splitting. Need ${ethers.utils.formatEther(SPLIT_AMOUNT)} but have ${ethers.utils.formatEther(balance)}`);
        }
        
        // Check allowance
        const allowance = await collateralToken.allowance(MARKET_MAKER_ADDRESS, DIAMOND_ADDRESS);
        console.log("MM Allowance:", ethers.utils.formatEther(allowance));
        
        if (allowance.lt(SPLIT_AMOUNT)) {
            console.log("⚠️ Insufficient allowance for splitting. Setting up approval...");
            
            // Connect with market maker signer for approval
            const collateralWithMM = collateralToken.connect(marketMakerSigner);
            
            // Approve Diamond to spend tokens
            console.log(`🔓 Approving Diamond to spend ${ethers.utils.formatEther(SPLIT_AMOUNT)} tokens...`);
            const approveTx = await collateralWithMM.approve(DIAMOND_ADDRESS, SPLIT_AMOUNT.mul(2), {
                gasLimit: 100000
            });
            console.log("📤 Approval transaction sent:", approveTx.hash);
            
            const approveReceipt = await approveTx.wait();
            console.log("✅ Approval confirmed in block:", approveReceipt.blockNumber);
            
            // Verify new allowance
            const newAllowance = await collateralToken.allowance(MARKET_MAKER_ADDRESS, DIAMOND_ADDRESS);
            console.log("✅ New allowance:", ethers.utils.formatEther(newAllowance));
            
            if (newAllowance.lt(SPLIT_AMOUNT)) {
                throw new Error("❌ Approval failed - still insufficient allowance");
            }
        } else {
            console.log("✅ Sufficient allowance available");
        }
        
        // Prepare partition for binary condition (indexSets: [1, 2] for outcome 0 and 1)
        const partition = [
            ethers.BigNumber.from(1), // Index set for outcome 0
            ethers.BigNumber.from(2)  // Index set for outcome 1
        ];
        
        console.log("📝 Split Parameters:");
        console.log("Partition:", partition.map(p => p.toString()));
        
        // Get initial conditional token balances using the correct condition ID
        console.log("\n5️⃣ Checking initial conditional token balances...");
        const parentCollectionId = ethers.constants.HashZero; // Root collection
        
        const collectionId0 = await diamond.getCollectionId(parentCollectionId, conditionIdToUse, ethers.BigNumber.from(1));
        const collectionId1 = await diamond.getCollectionId(parentCollectionId, conditionIdToUse, ethers.BigNumber.from(2));
        const positionId0 = await diamond.getPositionId(COLLATERAL_TOKEN, collectionId0);
        const positionId1 = await diamond.getPositionId(COLLATERAL_TOKEN, collectionId1);
        
        // Get ERC1155 balances
        const ERC1155Facet = await ethers.getContractFactory("ERC1155Facet");
        const erc1155 = ERC1155Facet.attach(DIAMOND_ADDRESS);
        
        const initialBalance0 = await erc1155.balanceOf(MARKET_MAKER_ADDRESS, positionId0);
        const initialBalance1 = await erc1155.balanceOf(MARKET_MAKER_ADDRESS, positionId1);
        
        console.log("Initial CT Balance (Outcome 0):", ethers.utils.formatEther(initialBalance0));
        console.log("Initial CT Balance (Outcome 1):", ethers.utils.formatEther(initialBalance1));
        
        // Split the position using the correct condition ID
        console.log("\n6️⃣ Splitting condition...");
        try {
            console.log("📋 Split parameters:");
            console.log("- Collateral Token:", COLLATERAL_TOKEN);
            console.log("- Parent Collection ID:", parentCollectionId);
            console.log("- Condition ID:", conditionIdToUse);
            console.log("- Partition:", partition.map(p => p.toString()));
            console.log("- Amount:", ethers.utils.formatEther(SPLIT_AMOUNT));
            console.log("- Unit per pair:", ethers.utils.formatEther(unit));
            console.log("- Amount is multiple of unit:", SPLIT_AMOUNT.mod(unit).eq(0) ? "✅ Yes" : "❌ No");
            
            const splitTx = await diamondWithMM.splitPosition(
                COLLATERAL_TOKEN,
                parentCollectionId,
                conditionIdToUse, 
                partition,
                SPLIT_AMOUNT,
                { gasLimit: 5000000 } // Set explicit gas limit
            );
            console.log("📤 Split transaction sent:", splitTx.hash);
            
            // Wait for confirmation and listen to events
            const receipt = await splitTx.wait();
            console.log("✅ Split transaction confirmed in block:", receipt.blockNumber);
            
            // Listen for PositionSplit event
            const positionSplitEvent = receipt.logs.find(log => {
                try {
                    const parsed = diamond.interface.parseLog(log);
                    return parsed.name === "PositionSplit";
                } catch {
                    return false;
                }
            });
            
            if (positionSplitEvent) {
                const parsed = diamond.interface.parseLog(positionSplitEvent);
                console.log("🎉 PositionSplit event:", {
                    stakeholder: parsed.args.stakeholder,
                    collateralToken: parsed.args.collateralToken,
                    parentCollectionId: parsed.args.parentCollectionId,
                    conditionId: parsed.args.conditionId,
                    partition: parsed.args.partition.map(p => p.toString()),
                    amount: ethers.utils.formatEther(parsed.args.amount)
                });
            }
            
            // Check final conditional token balances
            console.log("\n7️⃣ Checking final conditional token balances...");
            const finalBalance0 = await erc1155.balanceOf(MARKET_MAKER_ADDRESS, positionId0);
            const finalBalance1 = await erc1155.balanceOf(MARKET_MAKER_ADDRESS, positionId1);
            
            console.log("Final CT Balance (Outcome 0):", ethers.utils.formatEther(finalBalance0));
            console.log("Final CT Balance (Outcome 1):", ethers.utils.formatEther(finalBalance1));
            
            // Verify the split worked correctly
            const expectedIncrease = SPLIT_AMOUNT;
            const actualIncrease0 = finalBalance0.sub(initialBalance0);
            const actualIncrease1 = finalBalance1.sub(initialBalance1);
            
            console.log("\n8️⃣ Verifying split results...");
            console.log("Expected increase per outcome:", ethers.utils.formatEther(expectedIncrease));
            console.log("Actual increase (Outcome 0):", ethers.utils.formatEther(actualIncrease0));
            console.log("Actual increase (Outcome 1):", ethers.utils.formatEther(actualIncrease1));
            
            const splitSuccessful = actualIncrease0.eq(expectedIncrease) && actualIncrease1.eq(expectedIncrease);
            console.log("✅ Split successful:", splitSuccessful);
            
            console.log("\n📋 Summary:");
            console.log("Condition ID:", conditionIdToUse);
            console.log("Split Amount:", ethers.utils.formatEther(SPLIT_AMOUNT));
            console.log("Position ID (Outcome 0):", positionId0.toString());
            console.log("Position ID (Outcome 1):", positionId1.toString());
            console.log("CT Balance (Outcome 0):", ethers.utils.formatEther(finalBalance0));
            console.log("CT Balance (Outcome 1):", ethers.utils.formatEther(finalBalance1));
            console.log("✅ Condition split completed successfully!");
            
            // Useful info for trading
            console.log("\n💡 For trading these tokens:");
            console.log("Position ID 0 (No):", positionId0.toString());
            console.log("Position ID 1 (Yes):", positionId1.toString());
            
        } catch (error) {
            console.error("❌ Split transaction failed:");
            console.error("Error message:", error.message);
            if (error.data) {
                console.error("Error data:", error.data);
                
                // Help identify known errors
                if (error.data === "0x3e32cb54") {
                    console.error("💡 This is CollateralNotAligned() error");
                    console.error("The split amount must be a multiple of unitPerPair, which is", ethers.utils.formatEther(unit));
                } else if (error.data === "0x03961648") {
                    console.error("💡 This is TokenNotAllowed() error");
                }
            }
            
            throw error;
        }
    } catch (unitError) {
        console.error("❌ Error getting unit per pair:", unitError.message);
        throw unitError;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Error:", error);
        process.exit(1);
    });