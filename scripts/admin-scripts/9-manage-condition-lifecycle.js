const { ethers } = require("hardhat");

async function main() {
    const [deployer] = await ethers.getSigners();
    
    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS;
    const CONDITION_ID = process.env.CONDITION_ID;
    const COLLATERAL_TOKEN = process.env.MOCK_TOKEN_ADDRESS;
    const QUESTION_ID = process.env.QUESTION_ID || "0x8cdf8b03900ebb65e57f2e8030d95c23f32b7789e797d029104d938e6f22792d";
    
    // Simple operation config
    const operation = process.env.OPERATION || "reportPayouts";
    
    console.log(`� ${operation.toUpperCase()}`);
    
    const ConditionManagerFacet = await ethers.getContractFactory("ConditionManagerFacet");
    const ConditionalTokensFacet = await ethers.getContractFactory("ConditionalTokensFacet");
    
    const conditionManager = ConditionManagerFacet.attach(DIAMOND_ADDRESS);
    const conditionalTokens = ConditionalTokensFacet.attach(DIAMOND_ADDRESS);
    
    switch (operation) {
        case "cancel":
            const cancelTx = await conditionManager.cancelCondition(CONDITION_ID);
            await cancelTx.wait();
            console.log("✅ Condition cancelled");
            break;
            
        case "reportPayouts":
            const payouts = process.env.PAYOUTS ? process.env.PAYOUTS.split(',').map(Number) : [0, 1];
            const reportTx = await conditionalTokens.reportPayouts(QUESTION_ID, payouts);
            await reportTx.wait();
            console.log("✅ Payouts reported:", payouts);
            break;
            
        case "merge":
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
    }
}

main().catch(console.error);