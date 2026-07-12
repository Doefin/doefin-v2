const hre = require("hardhat");

async function main() {
    const [signer] = await hre.ethers.getSigners();
    const diamond = await hre.ethers.getContractAt(
        "OrderCreationFacet", 
        "0xe705E1eBafF4270DC5ce74D405068221Ec3e1ABd"
    );
    
    const marketFacet = await hre.ethers.getContractAt(
        "MarketDataFacet", 
        "0xe705E1eBafF4270DC5ce74D405068221Ec3e1ABd"
    );
    
    console.log("🔍 Debugging order creation...");
    console.log("Account:", signer.address);
    
    // Check if market exists for the condition
    const conditionId = "0xd30fa023590ea8145f6af2acae3b0a61f34fb87852859a80433fbe3a022a84bc";
    const collateralToken = "0x87Cfb70F98CaF5a92ab0d2b8Ec26bC6c8ceeB25D";
    
    try {
        const marketData = await marketFacet.getMarket(conditionId, collateralToken);
        console.log("📊 Market data:", {
            exists: marketData.exists,
            isActive: marketData.isActive,
            totalLiquidity: hre.ethers.utils.formatEther(marketData.totalLiquidity),
            makerFeeRate: marketData.makerFeeRate.toString(),
            takerFeeRate: marketData.takerFeeRate.toString()
        });
    } catch (error) {
        console.log("❌ Market query failed:", error.message);
    }
    
    // Try a very simple order
    try {
        console.log("\n🧪 Attempting simple order creation...");
        
        const positionId = "96098285239728320667922024460121242236519207887032348165891086918626104719912"; // YES position
        
        // Estimate gas first
        try {
            const gasEstimate = await diamond.estimateGas.createOrder(
                positionId,
                collateralToken,
                hre.ethers.utils.parseEther("10"), // 10 tokens
                hre.ethers.utils.parseUnits("0.5", 6), // 0.5 price
                hre.ethers.utils.parseEther("1"), // min fill 1 token
                Math.floor(Date.now() / 1000) + 3600, // 1 hour expiry
                false, // not fill or kill
                0, // BUY direction
                0, // FIXED execution type
                {
                    quoteCurrencyToken: collateralToken,
                    floorRate: hre.ethers.utils.parseUnits("100000", 0)
                }
            );
            
            console.log("⛽ Gas estimate:", gasEstimate.toString());
            
            // Now try the actual transaction
            const tx = await diamond.createOrder(
                positionId,
                collateralToken,
                hre.ethers.utils.parseEther("10"), // 10 tokens
                hre.ethers.utils.parseUnits("0.5", 6), // 0.5 price
                hre.ethers.utils.parseEther("1"), // min fill 1 token
                Math.floor(Date.now() / 1000) + 3600, // 1 hour expiry
                false, // not fill or kill
                0, // BUY direction
                0, // FIXED execution type
                {
                    quoteCurrencyToken: collateralToken,
                    floorRate: hre.ethers.utils.parseUnits("100000", 0)
                },
                { 
                    gasLimit: gasEstimate.add(100000) // Add buffer
                }
            );
            
            console.log("📤 Transaction sent:", tx.hash);
            const receipt = await tx.wait();
            console.log("✅ Order created successfully!");
            
        } catch (gasError) {
            console.log("❌ Gas estimation failed:", gasError.message);
            
            // Try to call the function to see what the revert reason is
            try {
                await diamond.callStatic.createOrder(
                    positionId,
                    collateralToken,
                    hre.ethers.utils.parseEther("10"),
                    hre.ethers.utils.parseUnits("0.5", 6),
                    hre.ethers.utils.parseEther("1"),
                    Math.floor(Date.now() / 1000) + 3600,
                    false,
                    0,
                    0,
                    {
                        quoteCurrencyToken: collateralToken,
                        floorRate: hre.ethers.utils.parseUnits("100000", 0)
                    }
                );
            } catch (callError) {
                console.log("❌ Call static failed:", callError.message);
                if (callError.reason) {
                    console.log("❌ Revert reason:", callError.reason);
                }
            }
        }
    } catch (error) {
        console.log("❌ Order creation failed:", error.message);
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });