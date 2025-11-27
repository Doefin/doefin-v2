const { ethers } = require("hardhat");

async function main() {
    console.log("🔧 Setting conditional token approval for sell orders...");
    
    const [deployer] = await ethers.getSigners();
    
    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "YOUR_DIAMOND_ADDRESS_HERE";
    const MARKET_MAKER_ADDRESS = process.env.MARKET_MAKER_ADDRESS || deployer.address;
    
    if (DIAMOND_ADDRESS === "YOUR_DIAMOND_ADDRESS_HERE") {
        throw new Error("❌ Please set DIAMOND_ADDRESS environment variable");
    }
    
    console.log("💎 Diamond Address:", DIAMOND_ADDRESS);
    console.log("🎯 Market Maker:", MARKET_MAKER_ADDRESS);
    
    // Get the ERC1155Facet interface to approve conditional token transfers
    const ERC1155Facet = await ethers.getContractFactory("ERC1155Facet");
    const ctf = ERC1155Facet.attach(DIAMOND_ADDRESS);
    
    // Connect with the market maker (use deployer for now)
    const signer = deployer; // Market maker should sign this
    const ctfWithSigner = ctf.connect(signer);
    
    console.log("\n1️⃣ Checking current approval status...");
    try {
        const isApproved = await ctfWithSigner.isApprovedForAll(MARKET_MAKER_ADDRESS, DIAMOND_ADDRESS);
        console.log("Current approval status:", isApproved);
        
        if (isApproved) {
            console.log("✅ Already approved for conditional token transfers");
            return;
        }
    } catch (error) {
        console.log("⚠️  Could not check approval status, proceeding with approval...");
    }
    
    console.log("\n2️⃣ Setting approval for conditional token transfers...");
    try {
        const approveTx = await ctfWithSigner.setApprovalForAll(DIAMOND_ADDRESS, true);
        console.log("📤 Approval transaction sent:", approveTx.hash);
        
        const receipt = await approveTx.wait();
        console.log("✅ Approval confirmed in block:", receipt.blockNumber);
        
        // Verify approval
        console.log("\n3️⃣ Verifying approval...");
        const isApproved = await ctfWithSigner.isApprovedForAll(MARKET_MAKER_ADDRESS, DIAMOND_ADDRESS);
        console.log("New approval status:", isApproved);
        
        if (isApproved) {
            console.log("✅ Conditional token approval set successfully!");
            console.log("💡 Now you can create SELL orders using conditional tokens");
        } else {
            console.log("❌ Approval verification failed");
        }
        
    } catch (error) {
        console.error("❌ Error setting approval:", error.message);
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Error:", error);
        process.exit(1);
    });