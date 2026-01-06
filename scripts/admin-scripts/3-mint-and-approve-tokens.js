const { ethers } = require("hardhat");

async function main() {
    console.log("🚀 Starting token minting and approval...");
    
    const [deployer] = await ethers.getSigners();
    
    // Configuration
    const MOCK_TOKEN_ADDRESS = process.env.MOCK_TOKEN_ADDRESS || "YOUR_MOCK_TOKEN_ADDRESS_HERE";
    const MARKET_MAKER_ADDRESS = process.env.MARKET_MAKER_ADDRESS || deployer.address;
    const TAKER_ADDRESS = process.env.TAKER_ADDRESS || "YOUR_TAKER_ADDRESS_HERE";
    const TAKER_PRIVATE_KEY = process.env.TAKER_PRIVATE_KEY || "YOUR_TAKER_PRIVATE_KEY_HERE";
    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "YOUR_DIAMOND_ADDRESS_HERE";
    const MINT_AMOUNT = ethers.utils.parseEther("10000"); // 10,000 tokens
    
    // ========================================
    // 🔧 CONFIGURE WHO TO MINT FOR HERE
    // ========================================
    const MINT_FOR_TAKER = false; // Set to true for taker, false for market maker
    
    const targetAddress = MINT_FOR_TAKER ? TAKER_ADDRESS : MARKET_MAKER_ADDRESS;
    const targetPrivateKey = MINT_FOR_TAKER ? TAKER_PRIVATE_KEY : null;
    const targetName = MINT_FOR_TAKER ? "Taker" : "Market Maker";
    
    if (MOCK_TOKEN_ADDRESS === "YOUR_MOCK_TOKEN_ADDRESS_HERE" || 
        DIAMOND_ADDRESS === "YOUR_DIAMOND_ADDRESS_HERE" ||
        (MINT_FOR_TAKER && (TAKER_ADDRESS === "YOUR_TAKER_ADDRESS_HERE" || TAKER_PRIVATE_KEY === "YOUR_TAKER_PRIVATE_KEY_HERE"))) {
        throw new Error("❌ Please set required environment variables");
    }
    
    console.log("📝 Mock Token Address:", MOCK_TOKEN_ADDRESS);
    console.log("🎯 Target Address (" + targetName + "):", targetAddress);
    console.log("💎 Diamond Address:", DIAMOND_ADDRESS);
    console.log("💰 Mint Amount:", ethers.utils.formatEther(MINT_AMOUNT));
    
    // Get Mock Token contract
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const mockToken = MockERC20.attach(MOCK_TOKEN_ADDRESS);
    
    // Check current balance
    console.log("\n1️⃣ Checking current balance...");
    const currentBalance = await mockToken.balanceOf(targetAddress);
    console.log("Current balance:", ethers.utils.formatEther(currentBalance));
    
    // Mint tokens to target address
    console.log(`\n2️⃣ Minting tokens to ${targetName}...`);
    const mintTx = await mockToken.mint(targetAddress, MINT_AMOUNT);
    console.log("📤 Mint transaction sent:", mintTx.hash);
    
    const mintReceipt = await mintTx.wait();
    console.log("✅ Mint transaction confirmed in block:", mintReceipt.blockNumber);
    
    // Check new balance
    const newBalance = await mockToken.balanceOf(targetAddress);
    console.log("New balance:", ethers.utils.formatEther(newBalance));
    
    // Get appropriate signer
    let targetSigner = deployer;
    if (MINT_FOR_TAKER && targetPrivateKey) {
        // Create signer from taker's private key
        targetSigner = new ethers.Wallet(targetPrivateKey, ethers.provider);
        console.log("✅ Using target signer with address:", targetSigner.address);
        
        // Verify the address matches
        if (targetSigner.address.toLowerCase() !== targetAddress.toLowerCase()) {
            throw new Error(`❌ Private key doesn't match target address. Expected: ${targetAddress}, Got: ${targetSigner.address}`);
        }
    } else if (!MINT_FOR_TAKER && MARKET_MAKER_ADDRESS !== deployer.address) {
        console.log("ℹ️  Note: Using deployer as signer for Market Maker.");
    }
    
    // Connect token with target signer
    const tokenWithTarget = mockToken.connect(targetSigner);
    
    // Check current allowance
    console.log("\n3️⃣ Checking current allowance...");
    const currentAllowance = await mockToken.allowance(targetAddress, DIAMOND_ADDRESS);
    console.log("Current allowance:", ethers.utils.formatEther(currentAllowance));
    
    // Approve Diamond to spend tokens
    const approveAmount = ethers.utils.parseEther("100000"); // Large allowance
    console.log("\n4️⃣ Approving Diamond to spend tokens...");
    const approveTx = await tokenWithTarget.approve(DIAMOND_ADDRESS, approveAmount);
    console.log("📤 Approval transaction sent:", approveTx.hash);
    
    const approveReceipt = await approveTx.wait();
    console.log("✅ Approval transaction confirmed in block:", approveReceipt.blockNumber);
    
    // Verify approval
    const newAllowance = await mockToken.allowance(targetAddress, DIAMOND_ADDRESS);
    console.log("New allowance:", ethers.utils.formatEther(newAllowance));
    
    // Listen for Transfer and Approval events
    const transferEvent = mintReceipt.logs.find(log => {
        try {
            const parsed = mockToken.interface.parseLog(log);
            return parsed.name === "Transfer";
        } catch {
            return false;
        }
    });
    
    if (transferEvent) {
        const parsed = mockToken.interface.parseLog(transferEvent);
        console.log("🎉 Transfer event:", {
            from: parsed.args.from,
            to: parsed.args.to,
            value: ethers.utils.formatEther(parsed.args.value)
        });
    }
    
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
        console.log("🎉 Approval event:", {
            owner: parsed.args.owner,
            spender: parsed.args.spender,
            value: ethers.utils.formatEther(parsed.args.value)
        });
    }
    
    console.log("\n📋 Summary:");
    console.log(`${targetName} Balance:`, ethers.utils.formatEther(newBalance));
    console.log("Diamond Allowance:", ethers.utils.formatEther(newAllowance));
    console.log("✅ Tokens minted and approved successfully!");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Error:", error);
        process.exit(1);
    });
