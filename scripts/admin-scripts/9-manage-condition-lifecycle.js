const { ethers } = require("hardhat");

async function main() {
    const [deployer] = await ethers.getSigners();
    
    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS;
    const CONDITION_ID = process.env.CONDITION_ID;
    const COLLATERAL_TOKEN = process.env.MOCK_TOKEN_ADDRESS;
    const QUESTION_ID = process.env.QUESTION_ID;

    if (!DIAMOND_ADDRESS) {
        throw new Error("❌ Please set DIAMOND_ADDRESS in .env file");
    }
    
    // Simple operation config
    const operation = process.env.OPERATION || "reportPayouts";
    
    console.log(`� ${operation.toUpperCase()}`);
    
    const ConditionManagerFacet = await ethers.getContractFactory("ConditionManagerFacet");
    const ConditionalTokensFacet = await ethers.getContractFactory("ConditionalTokensFacet");
    
    const conditionManager = ConditionManagerFacet.attach(DIAMOND_ADDRESS);
    const conditionalTokens = ConditionalTokensFacet.attach(DIAMOND_ADDRESS);
    
    switch (operation) {
        case "cancel":
            if (!CONDITION_ID) {
                throw new Error("❌ Please set CONDITION_ID in .env file");
            }
            const cancelTx = await conditionManager.cancelCondition(CONDITION_ID);
            await cancelTx.wait();
            console.log("✅ Condition cancelled");
            break;
            
        case "reportPayouts":
            if (!CONDITION_ID) {
                throw new Error("❌ Please set CONDITION_ID in .env file");
            }
            const payouts = process.env.PAYOUTS
                ? process.env.PAYOUTS.split(',').map((value) => value.trim()).filter((value) => value.length > 0)
                : ["0", "1"];
            const reportTx = await conditionalTokens.adminResolveCondition(CONDITION_ID, payouts);
            await reportTx.wait();
            console.log("✅ Condition resolved via admin method:", CONDITION_ID);
            console.log("✅ Payouts reported:", payouts);
            break;
            
        case "merge":
            if (!CONDITION_ID) {
                throw new Error("❌ Please set CONDITION_ID in .env file");
            }
            if (!COLLATERAL_TOKEN) {
                throw new Error("❌ Please set MOCK_TOKEN_ADDRESS in .env file");
            }
            const amount = ethers.utils.parseEther(process.env.AMOUNT || "100");
            const mergeTx = await conditionalTokens.mergePositions(
                COLLATERAL_TOKEN,
                ethers.constants.HashZero,
                CONDITION_ID,
                [1, 2],
                amount
            );
            await mergeTx.wait();
            console.log("✅ Positions merged:", ethers.utils.formatEther(amount));
            break;
            
        case "redeem":
            if (!CONDITION_ID) {
                throw new Error("❌ Please set CONDITION_ID in .env file");
            }
            if (!COLLATERAL_TOKEN) {
                throw new Error("❌ Please set MOCK_TOKEN_ADDRESS in .env file");
            }
            const indexSets = process.env.INDEX_SETS ? process.env.INDEX_SETS.split(',').map(Number) : [2];
            const redeemTx = await conditionalTokens.redeemPositions(
                COLLATERAL_TOKEN,
                ethers.constants.HashZero,
                CONDITION_ID,
                indexSets
            );
            await redeemTx.wait();
            console.log("✅ Positions redeemed:", indexSets);
            break;

        case "reportPayoutsLegacy":
            if (!QUESTION_ID) {
                throw new Error("❌ Please set QUESTION_ID in .env file");
            }
            const legacyPayouts = process.env.PAYOUTS ? process.env.PAYOUTS.split(',').map(Number) : [0, 1];
            const legacyTx = await conditionalTokens.reportPayouts(QUESTION_ID, legacyPayouts);
            await legacyTx.wait();
            console.log("✅ Payouts reported using legacy method:", legacyPayouts);
            break;

        default:
            throw new Error(`❌ Unsupported OPERATION: ${operation}`);
    }
}

main().catch(console.error);