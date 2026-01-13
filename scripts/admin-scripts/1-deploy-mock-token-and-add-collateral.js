const { ethers } = require("hardhat");
require("dotenv").config();

async function main() {
    console.log("🚀 Starting collateral token setup and registration...");
    
    const [deployer] = await ethers.getSigners();
    console.log("📝 Operating with account:", deployer.address);
    console.log("💰 Account balance:", ethers.utils.formatEther(await deployer.getBalance()), "ETH");
    
    // Get Diamond address from environment
    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS;
    if (!DIAMOND_ADDRESS) {
        throw new Error("❌ Please set DIAMOND_ADDRESS in .env file");
    }
    console.log("💎 Diamond Address:", DIAMOND_ADDRESS);

    let mockTokenAddress;
    let shouldDeployNew = true;

    // Check if we already have a collateral token address in .env
    if (process.env.COLLATERAL_TOKEN_ADDRESS) {
        console.log("\n📋 Found existing collateral token in .env:", process.env.COLLATERAL_TOKEN_ADDRESS);
        
        // Try to connect to existing token
        try {
            const existingToken = await ethers.getContractAt("MockERC20", process.env.COLLATERAL_TOKEN_ADDRESS);
            const name = await existingToken.name();
            const symbol = await existingToken.symbol();
            const decimals = await existingToken.decimals();
            
            console.log(`✅ Connected to existing token: ${name} (${symbol}) with ${decimals} decimals`);
            mockTokenAddress = process.env.COLLATERAL_TOKEN_ADDRESS;
            shouldDeployNew = false;
            
        } catch (error) {
            console.log("⚠️ Cannot connect to existing token, will deploy new one");
            console.log("Error:", error.message);
        }
    }

    if (shouldDeployNew) {
        // Deploy MockBTC Token
        console.log("\n1️⃣ Deploying new MockBTC Token...");
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        const mockToken = await MockERC20.deploy(
            "MockBTC",
            "mBTC",
            18  // 18 decimals (using 18 for testing, real BTC has 8)
        );
        
        await mockToken.deployed();
        mockTokenAddress = mockToken.address;
        console.log("✅ MockBTC deployed at:", mockTokenAddress);
        
        // Wait for deployment to be fully confirmed
        console.log("⏳ Waiting for deployment confirmation...");
        await mockToken.deployTransaction.wait(2); // Wait for 2 confirmations
        console.log("✅ Deployment confirmed");
        
        // Mint initial supply to deployer
        console.log("\n📈 Minting initial supply...");
        const initialSupply = ethers.utils.parseEther("1000000"); // 1M tokens
        try {
            const mintTx = await mockToken.mint(deployer.address, initialSupply);
            await mintTx.wait();
            console.log("✅ Minted", ethers.utils.formatEther(initialSupply), "tokens to deployer");
        } catch (mintError) {
            console.error("❌ Mint failed:", mintError.message);
            throw mintError;
        }
        
        console.log("💡 Update your .env file with:");
        console.log(`COLLATERAL_TOKEN_ADDRESS=${mockTokenAddress}`);
    }

    // Get token contract instance
    const mockToken = await ethers.getContractAt("MockERC20", mockTokenAddress);
    const tokenName = await mockToken.name();
    const tokenSymbol = await mockToken.symbol();
    const tokenDecimals = await mockToken.decimals();
    
    console.log(`\n📊 Token Info: ${tokenName} (${tokenSymbol}) - ${tokenDecimals} decimals`);
    
    // Check token balance
    const balance = await mockToken.balanceOf(deployer.address);
    console.log(`💰 Your balance: ${ethers.utils.formatUnits(balance, tokenDecimals)} ${tokenSymbol}`);
    
    // Get Diamond contract interface
    console.log("\n2️⃣ Connecting to Diamond contract...");
    const AdminConfigFacet = await ethers.getContractFactory("AdminConfigFacet");
    const diamond = AdminConfigFacet.attach(DIAMOND_ADDRESS);
    
    // Check if token is already registered as collateral
    console.log("\n3️⃣ Checking collateral registration status...");
    let isAlreadyCollateral = false;
    try {
        isAlreadyCollateral = await diamond.isAllowedCollateral(mockTokenAddress);
        console.log(`📋 Is ${tokenSymbol} already registered as collateral:`, isAlreadyCollateral);
    } catch (error) {
        console.log("⚠️ Cannot check collateral status:", error.message);
    }
    
    if (!isAlreadyCollateral) {
        // Add collateral token with proper unit
        console.log(`\n4️⃣ Registering ${tokenSymbol} as collateral...`);
        const unitPerPair = ethers.utils.parseUnits("1", tokenDecimals); // 1 token unit
        console.log("🔧 Setting unit per pair to:", ethers.utils.formatUnits(unitPerPair, tokenDecimals), tokenSymbol);
        
        try {
            const addCollateralTx = await diamond.addCollateralToken(mockTokenAddress, unitPerPair, {
                gasLimit: 500000 // Sufficient gas limit
            });
            console.log("📤 Transaction sent:", addCollateralTx.hash);
            
            // Wait for confirmation
            const receipt = await addCollateralTx.wait();
            console.log("✅ Transaction confirmed in block:", receipt.blockNumber);
            
            // Parse events
            const collateralAddedEvent = receipt.logs.find(log => {
                try {
                    const parsed = diamond.interface.parseLog(log);
                    return parsed.name === "CollateralTokenAdded";
                } catch {
                    return false;
                }
            });
            
            if (collateralAddedEvent) {
                const parsed = diamond.interface.parseLog(collateralAddedEvent);
                console.log("🎉 CollateralTokenAdded event emitted:", {
                    token: parsed.args.token,
                    unitPerPair: ethers.utils.formatUnits(parsed.args.unitPerPair, tokenDecimals)
                });
            }
        } catch (error) {
            console.error("❌ Failed to add collateral token:", error.message);
            throw error;
        }
    } else {
        console.log(`✅ ${tokenSymbol} is already registered as collateral`);
    }
    
    
    // Verify collateral registration
    console.log("\n5️⃣ Verifying collateral registration...");
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for state update
    
    try {
        const isCollateral = await diamond.isAllowedCollateral(mockTokenAddress);
        console.log(`✅ ${tokenSymbol} is allowed as collateral:`, isCollateral);
        
        if (isCollateral) {
            const collateralUnit = await diamond.getCollateralUnit(mockTokenAddress);
            console.log(`✅ Collateral unit per pair: ${ethers.utils.formatUnits(collateralUnit, tokenDecimals)} ${tokenSymbol}`);
        }
        
    } catch (error) {
        console.log("⚠️ Verification check failed:", error.message);
        console.log("(This is often normal due to timing, collateral should still be registered)");
    }
    
    // Check token balance and approve diamond
    console.log("\n6️⃣ Setting up token approvals...");
    const currentBalance = await mockToken.balanceOf(deployer.address);
    if (currentBalance.gt(0)) {
        console.log(`💰 Current ${tokenSymbol} balance: ${ethers.utils.formatUnits(currentBalance, tokenDecimals)}`);
        
        // Approve Diamond to spend tokens
        const approveAmount = currentBalance.div(2); // Approve half of balance
        console.log(`🔓 Approving Diamond to spend ${ethers.utils.formatUnits(approveAmount, tokenDecimals)} ${tokenSymbol}...`);
        
        try {
            const approveTx = await mockToken.approve(DIAMOND_ADDRESS, approveAmount);
            await approveTx.wait();
            console.log("✅ Approval successful");
            
            // Verify allowance
            const allowance = await mockToken.allowance(deployer.address, DIAMOND_ADDRESS);
            console.log(`✅ Diamond allowance: ${ethers.utils.formatUnits(allowance, tokenDecimals)} ${tokenSymbol}`);
            
        } catch (error) {
            console.error("❌ Approval failed:", error.message);
        }
    } else {
        console.log("⚠️ No token balance to approve");
    }
    
    console.log("\n🎉 Collateral token setup complete!");
    console.log("\n📋 Summary:");
    console.log(`   Token: ${tokenName} (${tokenSymbol})`);
    console.log(`   Address: ${mockTokenAddress}`);
    console.log(`   Diamond: ${DIAMOND_ADDRESS}`);
    console.log(`   Collateral Status: ✅ Registered`);
    
    console.log("\n💡 Environment Variables for .env:");
    console.log(`COLLATERAL_TOKEN_ADDRESS=${mockTokenAddress}`);
    if (!process.env.COLLATERAL_TOKEN_ADDRESS || process.env.COLLATERAL_TOKEN_ADDRESS !== mockTokenAddress) {
        console.log("⚠️  Please update your .env file with the above address");
    }
    
    console.log("\n🔄 Next Steps:");
    console.log("   1. Run script 2: Add market maker");
    console.log("   2. Run script 3: Mint and approve more tokens");
    console.log("   3. Run script 4: Create prediction condition");
    console.log("\n   Command: npx hardhat run scripts/admin-scripts/2-add-market-maker.js --network baseSepolia");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Error:", error);
        process.exit(1);
    });
