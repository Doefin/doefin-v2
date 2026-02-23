const { ethers } = require("hardhat");

async function main() {
    console.log("🔄 Minting more position tokens using working condition...");

    const [deployer] = await ethers.getSigners();
    console.log("📝 Operating with account:", deployer.address);

    // Configuration from .env
    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS;
    const CONDITION_ID = process.env.CONDITION_ID;
    const COLLATERAL_TOKEN_ADDRESS = process.env.COLLATERAL_TOKEN_ADDRESS;

    console.log("💎 Diamond Address:", DIAMOND_ADDRESS);
    console.log("🎯 Condition ID:", CONDITION_ID);
    console.log("🪙 Collateral Token:", COLLATERAL_TOKEN_ADDRESS);

    // Get contract instances
    const conditionalFacet = await ethers.getContractAt("ConditionalTokensFacet", DIAMOND_ADDRESS);
    const erc1155 = await ethers.getContractAt("ERC1155Facet", DIAMOND_ADDRESS);
    const collateralToken = await ethers.getContractAt("MockERC20", COLLATERAL_TOKEN_ADDRESS);

    // Get collateral token info
    const symbol = await collateralToken.symbol();
    const decimals = await collateralToken.decimals();
    console.log(`📊 Collateral token: ${symbol} (${decimals} decimals)`);

    // Step 1: Mint collateral tokens
    console.log("\n1️⃣ Minting collateral tokens...");
    const mintAmount = ethers.utils.parseUnits("5000", decimals); // 5,000 tokens
    
    try {
        const mintTx = await collateralToken.mint(deployer.address, mintAmount);
        await mintTx.wait();
        console.log(`✅ Minted ${ethers.utils.formatUnits(mintAmount, decimals)} ${symbol}`);
    } catch (error) {
        console.log("⚠️ Mint failed (might not have mint function):", error.message);
        // Continue anyway - user might already have tokens
    }

    // Check balance
    const balance = await collateralToken.balanceOf(deployer.address);
    console.log(`📊 Current balance: ${ethers.utils.formatUnits(balance, decimals)} ${symbol}`);

    if (balance.lt(mintAmount.div(2))) {
        console.log("⚠️ Warning: Low collateral token balance. You may need to obtain more tokens.");
    }

    // Step 2: Approve diamond to spend tokens
    console.log("\n2️⃣ Approving diamond to spend tokens...");
    const approveAmount = mintAmount;
    const approveTx = await collateralToken.approve(DIAMOND_ADDRESS, approveAmount);
    await approveTx.wait();
    console.log(`✅ Approved ${ethers.utils.formatUnits(approveAmount, decimals)} ${symbol}`);

    // Step 3: Split position to create more YES/NO tokens
    console.log("\n3️⃣ Splitting position to create YES/NO tokens...");
    const splitAmount = ethers.utils.parseUnits("1000", decimals); // Split 1,000 tokens
    
    try {
        console.log(`🔧 Splitting ${ethers.utils.formatUnits(splitAmount, decimals)} ${symbol}...`);
        
        const splitTx = await conditionalFacet.splitPosition(
            COLLATERAL_TOKEN_ADDRESS,
            ethers.constants.HashZero, // Parent collectionId
            CONDITION_ID,
            [0, 1], // partition for binary outcome (NO=0, YES=1)
            splitAmount,
            { gasLimit: 800000 } // Sufficient gas limit
        );
        
        const splitReceipt = await splitTx.wait();
        console.log("✅ Position split successful!");
        
        // Find position transfer events
        const transferEvents = splitReceipt.logs
            .map(log => {
                try {
                    return erc1155.interface.parseLog(log);
                } catch {
                    return null;
                }
            })
            .filter(event => event && event.name === 'TransferBatch');
            
        if (transferEvents.length > 0) {
            const transferEvent = transferEvents[0];
            console.log("📊 Position tokens created:");
            console.log("   Position IDs:", transferEvent.args.ids.map(id => id.toString()));
            console.log("   Amounts:", transferEvent.args.values.map(val => ethers.utils.formatEther(val)));
        }

    } catch (error) {
        console.error("❌ Split failed:", error.message);
        console.log("🔍 This might be because:");
        console.log("   - Condition is resolved or expired");
        console.log("   - Insufficient allowance");
        console.log("   - Network connectivity issues");
        throw error;
    }

    // Step 4: Check final position token balances
    console.log("\n4️⃣ Checking final position token balances...");
    const POSITION_ID_0 = process.env.POSITION_ID_0;
    const POSITION_ID_1 = process.env.POSITION_ID_1;
    
    const balance0 = await erc1155.balanceOf(deployer.address, POSITION_ID_0);
    const balance1 = await erc1155.balanceOf(deployer.address, POSITION_ID_1);
    
    console.log(`📊 Position 0 (NO) balance: ${ethers.utils.formatEther(balance0)}`);
    console.log(`📊 Position 1 (YES) balance: ${ethers.utils.formatEther(balance1)}`);

    console.log("\n🎉 Position token minting complete!");
    console.log("\n💡 Next step: Run cross-currency order creation:");
    console.log("   npx hardhat run scripts/admin-scripts/14-create-cross-currency-orders.js --network baseSepolia");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });