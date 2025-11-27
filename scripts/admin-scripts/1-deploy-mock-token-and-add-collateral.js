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
        "mUSDC"
    );
    
    await mockToken.deployed();
    const mockTokenAddress = mockToken.address;
    console.log("✅ Mock ERC20 deployed at:", mockTokenAddress);
    
    // Mint initial supply to deployer
    console.log("\n📈 Minting initial supply...");
    const initialSupply = ethers.utils.parseEther("1000000"); // 1M tokens
    const mintTx = await mockToken.mint(deployer.address, initialSupply);
    await mintTx.wait();
    console.log("✅ Minted", ethers.utils.formatEther(initialSupply), "tokens to deployer");
    
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
    const isCollateral = await diamond.isAllowedCollateral(mockTokenAddress);
    const collateralUnit = await diamond.getCollateralUnit(mockTokenAddress);
    console.log("✅ Is allowed collateral:", isCollateral);
    console.log("✅ Collateral unit per pair:", collateralUnit.toString());
    
    console.log("\n📋 Summary:");
    console.log("Mock Token Address:", mockTokenAddress);
    console.log("Diamond Address:", DIAMOND_ADDRESS);
    console.log("Collateral Added:", isCollateral);
    console.log("Unit Per Pair:", collateralUnit.toString());
    
    console.log("\n💡 Save this for next scripts:");
    console.log("export MOCK_TOKEN_ADDRESS=" + mockTokenAddress);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Error:", error);
        process.exit(1);
    });
