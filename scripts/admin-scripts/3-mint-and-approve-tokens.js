const { ethers } = require("hardhat");
require("dotenv").config();

async function main() {
    console.log("🚀 Starting token minting and approval...");
    
    const [deployer] = await ethers.getSigners();
    console.log("📝 Operating with account:", deployer.address);
    console.log("💰 Account balance:", ethers.utils.formatEther(await deployer.getBalance()), "ETH");
    
    // Configuration from .env
    const COLLATERAL_TOKEN_ADDRESS = process.env.COLLATERAL_TOKEN_ADDRESS;
    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS;
    
    if (!COLLATERAL_TOKEN_ADDRESS || !DIAMOND_ADDRESS) {
        throw new Error("❌ Please set COLLATERAL_TOKEN_ADDRESS and DIAMOND_ADDRESS in .env file");
    }
    
    console.log("🪙 Collateral Token:", COLLATERAL_TOKEN_ADDRESS);
    console.log("💎 Diamond Address:", DIAMOND_ADDRESS);
    
    // Get token contract
    console.log("\n1️⃣ Connecting to collateral token...");
    const mockToken = await ethers.getContractAt("MockERC20", COLLATERAL_TOKEN_ADDRESS);
    const tokenName = await mockToken.name();
    const tokenSymbol = await mockToken.symbol();
    const tokenDecimals = await mockToken.decimals();
    
    console.log(`📊 Token: ${tokenName} (${tokenSymbol}) - ${tokenDecimals} decimals`);
    
    // Check current balance
    console.log("\n2️⃣ Checking current token balance...");
    const currentBalance = await mockToken.balanceOf(deployer.address);
    console.log(`💰 Current balance: ${ethers.utils.formatUnits(currentBalance, tokenDecimals)} ${tokenSymbol}`);
    
    // Mint more tokens if balance is low
    const minBalance = ethers.utils.parseUnits("10000", tokenDecimals); // 10K tokens
    if (currentBalance.lt(minBalance)) {
        console.log("\n3️⃣ Minting additional tokens...");
        const mintAmount = ethers.utils.parseUnits("50000", tokenDecimals); // 50K tokens
        console.log(`💰 Minting ${ethers.utils.formatUnits(mintAmount, tokenDecimals)} ${tokenSymbol}...`);
        
        try {
            const mintTx = await mockToken.mint(deployer.address, mintAmount);
            console.log("📤 Mint transaction sent:", mintTx.hash);
            
            const mintReceipt = await mintTx.wait();
            console.log("✅ Mint confirmed in block:", mintReceipt.blockNumber);
            
            const newBalance = await mockToken.balanceOf(deployer.address);
            console.log(`✅ New balance: ${ethers.utils.formatUnits(newBalance, tokenDecimals)} ${tokenSymbol}`);
            
        } catch (error) {
            console.log("⚠️ Minting failed (might not have mint function):", error.message);
            console.log("Continuing with existing balance...");
        }
    } else {
        console.log("✅ Sufficient balance available");
    }
    
    // Check current allowance
    console.log("\n4️⃣ Checking Diamond allowance...");
    const currentAllowance = await mockToken.allowance(deployer.address, DIAMOND_ADDRESS);
    console.log(`🔓 Current allowance: ${ethers.utils.formatUnits(currentAllowance, tokenDecimals)} ${tokenSymbol}`);
    
    // Set up sufficient allowance for Diamond
    const finalBalance = await mockToken.balanceOf(deployer.address);
    const targetAllowance = finalBalance; // Allow spending entire balance
    
    if (currentAllowance.lt(targetAllowance)) {
        console.log("\n5️⃣ Approving Diamond to spend tokens...");
        console.log(`🔓 Approving ${ethers.utils.formatUnits(targetAllowance, tokenDecimals)} ${tokenSymbol}...`);
        
        try {
            const approveTx = await mockToken.approve(DIAMOND_ADDRESS, targetAllowance, {
                gasLimit: 100000 // Sufficient gas for approval
            });
            console.log("📤 Approval transaction sent:", approveTx.hash);
            
            const approveReceipt = await approveTx.wait();
            console.log("✅ Approval confirmed in block:", approveReceipt.blockNumber);
            
            // Verify new allowance
            const newAllowance = await mockToken.allowance(deployer.address, DIAMOND_ADDRESS);
            console.log(`✅ New allowance: ${ethers.utils.formatUnits(newAllowance, tokenDecimals)} ${tokenSymbol}`);
            
            // Parse approval event
            const approvalEvent = approveReceipt.logs.find(log => {
                try {
                    const parsed = mockToken.interface.parseLog(log);
                    return parsed.name === "Approval";
                } catch {
                    return false;
                }
            });
            
            if (approvalEvent) {
                const parsed = mockToken.interface.parseLog(approvalEvent);
                console.log("🎉 Approval event confirmed:", {
                    owner: parsed.args.owner,
                    spender: parsed.args.spender,
                    value: ethers.utils.formatUnits(parsed.args.value, tokenDecimals)
                });
            }
            
        } catch (error) {
            console.error("❌ Approval failed:", error.message);
            throw error;
        }
    } else {
        console.log("✅ Sufficient allowance already exists");
    }
    
    // Final status
    const finalAllowance = await mockToken.allowance(deployer.address, DIAMOND_ADDRESS);
    
    console.log("\n🎉 Token setup complete!");
    console.log("\n📋 Final Summary:");
    console.log(`   Token: ${tokenName} (${tokenSymbol})`);
    console.log(`   Your Balance: ${ethers.utils.formatUnits(finalBalance, tokenDecimals)} ${tokenSymbol}`);
    console.log(`   Diamond Allowance: ${ethers.utils.formatUnits(finalAllowance, tokenDecimals)} ${tokenSymbol}`);
    console.log(`   Ready for Trading: ✅`);
    
    console.log("\n🔄 Next Step:");
    console.log("   Run script 4: Create prediction condition");
    console.log("   Command: npx hardhat run scripts/admin-scripts/4-create-condition.js --network baseSepolia");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Error:", error);
        process.exit(1);
    });
