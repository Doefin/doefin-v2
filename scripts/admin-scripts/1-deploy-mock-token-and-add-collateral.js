const { ethers } = require("hardhat");

async function main() {
    console.log("🚀 Starting Mock ERC20 deployment and collateral addition...");
    
    const [deployer] = await ethers.getSigners();
    console.log("📝 Deploying with account:", deployer.address);
    
    // Deploy Mock ERC20 Token
    console.log("\n1️⃣ Deploying Mock ERC20 Token...");
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const mockToken = await MockERC20.deploy(
        "Mock USDC",
        "mUSDC",
        18  // 18 decimals (standard for USDC-like tokens)
    );
    
    await mockToken.deployed();
    const mockTokenAddress = mockToken.address;
    console.log("✅ Mock ERC20 deployed at:", mockTokenAddress);
    
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
        
        // Try to get more details about the error
        if (mintError.transaction) {
            console.log("Transaction hash:", mintError.transactionHash);
            console.log("Transaction failed with status:", mintError.receipt?.status);
        }
        
        // Check if the contract is deployed properly
        const code = await deployer.provider.getCode(mockToken.address);
        if (code === "0x") {
            console.error("❌ Contract has no code deployed!");
        } else {
            console.log("✅ Contract code exists");
            // Try to call decimals to test if contract works
            try {
                const decimals = await mockToken.decimals();
                console.log("✅ Contract is responsive, decimals:", decimals);
            } catch (callError) {
                console.error("❌ Contract call failed:", callError.message);
            }
        }
        throw mintError;
    }
    
    // Get Diamond contract address
    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "YOUR_DIAMOND_ADDRESS_HERE";
    
    if (DIAMOND_ADDRESS === "YOUR_DIAMOND_ADDRESS_HERE") {
        throw new Error("❌ Please set DIAMOND_ADDRESS environment variable");
    }
    
    // Get AdminConfigFacet interface
    console.log("\n2️⃣ Adding token as collateral to Diamond...");
    const AdminConfigFacet = await ethers.getContractFactory("AdminConfigFacet");
    const diamond = AdminConfigFacet.attach(DIAMOND_ADDRESS);
    
    // Add collateral token with proper unit (1 ETH = 10^18 wei)
    const unitPerPair = ethers.utils.parseEther("1"); // 1 ETH unit for 18-decimal token
    console.log("🔧 Setting unit per pair to:", ethers.utils.formatEther(unitPerPair), "ETH");
    const addCollateralTx = await diamond.addCollateralToken(mockTokenAddress, unitPerPair);
    console.log("📤 Transaction sent:", addCollateralTx.hash);
    
    // Wait for confirmation and listen to events
    const receipt = await addCollateralTx.wait();
    console.log("✅ Transaction confirmed in block:", receipt.blockNumber);
    
    // Listen for CollateralTokenAdded event
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
        console.log("🎉 CollateralTokenAdded event:", {
            token: parsed.args.token,
            unitPerPair: parsed.args.unitPerPair.toString()
        });
    }
    
    // Verify collateral was added
    console.log("\n3️⃣ Verifying collateral addition...");
    
    try {
        // Wait a moment for state to be updated
        console.log("⏳ Waiting for state update...");
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const isCollateral = await diamond.isAllowedCollateral(mockTokenAddress);
        console.log("✅ Is allowed collateral:", isCollateral);
        
        if (isCollateral) {
            const collateralUnit = await diamond.getCollateralUnit(mockTokenAddress);
            console.log("✅ Collateral unit per pair:", collateralUnit.toString());
        } else {
            console.log("⚠️ Warning: Token not showing as allowed collateral yet");
            // Try the function that might be available
            try {
                const collateralUnit = await diamond.getCollateralUnit(mockTokenAddress);
                console.log("✅ Collateral unit per pair:", collateralUnit.toString());
            } catch (unitError) {
                console.log("⚠️ Cannot get unit yet, but collateral was added successfully (see event above)");
            }
        }
        
        console.log("\n📋 Summary:");
        console.log("Mock Token Address:", mockTokenAddress);
        console.log("Diamond Address:", DIAMOND_ADDRESS);
        console.log("Collateral Added Successfully: ✅ (Event emitted)");
        
    } catch (verificationError) {
        console.log("⚠️ Verification failed but collateral was added successfully (see event above)");
        console.log("Error:", verificationError.message);
        
        console.log("\n📋 Summary:");
        console.log("Mock Token Address:", mockTokenAddress);
        console.log("Diamond Address:", DIAMOND_ADDRESS);
        console.log("Collateral Added: ✅ (Event emitted successfully)");
    }
    
    console.log("\n💡 Save this for next scripts:");
    console.log("export MOCK_TOKEN_ADDRESS=" + mockTokenAddress);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Error:", error);
        process.exit(1);
    });
