const { ethers } = require("hardhat");

async function main() {
    console.log("🔧 Modifying an existing order...");
    
    const [deployer] = await ethers.getSigners();
    
    // Configuration from environment
    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "YOUR_DIAMOND_ADDRESS_HERE";
    const MARKET_MAKER_ADDRESS = process.env.MARKET_MAKER_ADDRESS || deployer.address;
    
    // ========================================
    // 🔧 CUSTOMIZE YOUR ORDER MODIFICATION HERE
    // ========================================
    
    const MODIFY_CONFIG = {
        // Order ID to modify (use ORDER_ID env var or default)
        orderId: process.env.ORDER_ID || "4",                        // Order ID to modify
        
        // New order amount (use NEW_AMOUNT env var or default)
        newAmount: process.env.NEW_AMOUNT || "2.0",                    // Increase to 2 tokens
        
        // New price per token (use NEW_PRICE env var or default)
        // NOTE: Price can now be up to 1 ETH per token (unitPerPair = 1 ETH)
        newPricePerToken: process.env.NEW_PRICE || "0.8", // 0.8 ETH per token (80% probability)
        
        // New minimum fill amount (use NEW_MIN_FILL env var or default)
        newMinFillAmount: process.env.NEW_MIN_FILL || "1.0",             // At least 1 token must be filled
        
        // New expiry in hours from now (use NEW_EXPIRY_HOURS env var or default)
        newExpiryHours: process.env.NEW_EXPIRY_HOURS || 48,                  // 48 hours from now
    };
    
    // ========================================
    // Validation and setup
    // ========================================
    
    if (DIAMOND_ADDRESS === "YOUR_DIAMOND_ADDRESS_HERE") {
        throw new Error("❌ Please set DIAMOND_ADDRESS environment variable");
    }
    
    console.log("💎 Diamond Address:", DIAMOND_ADDRESS);
    console.log("🎯 Market Maker:", MARKET_MAKER_ADDRESS);
    
    // Get signer
    let signer = deployer;
    if (MARKET_MAKER_ADDRESS !== deployer.address) {
        console.log("ℹ️  Note: Using deployer as signer. Market Maker address is different.");
    }
    
    // Get contract interfaces
    const ExchangeFacet = await ethers.getContractFactory("ExchangeFacet");
    const diamond = ExchangeFacet.attach(DIAMOND_ADDRESS);
    const diamondWithSigner = diamond.connect(signer);
    
    // Convert config to contract parameters
    const orderId = MODIFY_CONFIG.orderId;
    const newAmount = ethers.utils.parseEther(MODIFY_CONFIG.newAmount);
    const newPricePerToken = ethers.utils.parseEther(MODIFY_CONFIG.newPricePerToken);
    const newMinFillAmount = ethers.utils.parseEther(MODIFY_CONFIG.newMinFillAmount);
    const newExpiry = MODIFY_CONFIG.newExpiryHours > 0 
        ? Math.floor(Date.now() / 1000) + (MODIFY_CONFIG.newExpiryHours * 3600)
        : 0;
    
    // Display modification details
    console.log("\n📋 Order Modification Details:");
    console.log("Order ID:", orderId);
    console.log("New Amount:", MODIFY_CONFIG.newAmount);
    console.log("New Price per Token:", MODIFY_CONFIG.newPricePerToken);
    console.log("New Min Fill:", MODIFY_CONFIG.newMinFillAmount);
    console.log("New Expiry:", MODIFY_CONFIG.newExpiryHours > 0 ? `${MODIFY_CONFIG.newExpiryHours} hours` : "No expiry");
    
    // Check if order exists and get current details
    console.log("\n📊 Checking current order details...");
    try {
        const currentOrder = await diamond.getOrder(orderId);
        
        if (currentOrder.maker === "0x0000000000000000000000000000000000000000") {
            throw new Error("Order does not exist");
        }
        
        console.log("✅ Current Order Details:");
        console.log("  Maker:", currentOrder.maker);
        console.log("  Position ID:", currentOrder.positionId.toString());
        console.log("  Current Amount:", ethers.utils.formatEther(currentOrder.amount));
        console.log("  Current Remaining:", ethers.utils.formatEther(currentOrder.remainingAmount));
        console.log("  Current Price:", ethers.utils.formatEther(currentOrder.pricePerToken));
        console.log("  Current Min Fill:", ethers.utils.formatEther(currentOrder.minFillAmount));
        console.log("  Direction:", currentOrder.direction === 0 ? "Buy" : "Sell");
        console.log("  Execution Type:", currentOrder.executionType === 0 ? "Market" : "Limit");
        console.log("  Active:", currentOrder.active);
        console.log("  Created At:", new Date(currentOrder.createdAt.toNumber() * 1000).toISOString());
        
        // Verify the caller is the maker
        if (currentOrder.maker.toLowerCase() !== MARKET_MAKER_ADDRESS.toLowerCase()) {
            throw new Error(`❌ Only the order maker can modify this order. Maker: ${currentOrder.maker}, Your address: ${MARKET_MAKER_ADDRESS}`);
        }
        
        if (!currentOrder.active) {
            throw new Error("❌ Cannot modify inactive order");
        }
        
        if (currentOrder.executionType !== 1) {
            throw new Error("❌ Only limit orders can be modified");
        }
        
    } catch (error) {
        console.error("❌ Error checking order:", error.message);
        throw error;
    }
    
    // Modify the order
    console.log("\n🔧 Modifying order...");
    try {
        const tx = await diamondWithSigner.modifyLimitOrder(
            orderId,            // orderId
            newAmount,          // newAmount
            newPricePerToken,   // newPricePerToken
            newMinFillAmount,   // newMinFillAmount
            newExpiry,          // newExpiry
            { gasLimit: 2000000 }
        );
        
        console.log("📤 Transaction sent:", tx.hash);
        console.log("⏳ Waiting for confirmation...");
        
        const receipt = await tx.wait();
        
        if (receipt.status === 1) {
            console.log("✅ Order modified successfully!");
            console.log("📦 Block:", receipt.blockNumber);
            console.log("⛽ Gas used:", receipt.gasUsed.toString());
            
            // Try to parse events
            try {
                const events = receipt.logs.map(log => {
                    try {
                        return diamond.interface.parseLog(log);
                    } catch {
                        return null;
                    }
                }).filter(event => event !== null);
                
                console.log("\n🎉 Events emitted:");
                events.forEach(event => {
                    console.log(`  ${event.name}:`, event.args);
                });
                
            } catch (eventError) {
                console.log("⚠️  Could not parse events:", eventError.message);
            }
            
            // Get updated order details
            console.log("\n📊 Updated Order Details:");
            try {
                const updatedOrder = await diamond.getOrder(orderId);
                console.log("  New Amount:", ethers.utils.formatEther(updatedOrder.amount));
                console.log("  New Remaining:", ethers.utils.formatEther(updatedOrder.remainingAmount));
                console.log("  New Price:", ethers.utils.formatEther(updatedOrder.pricePerToken));
                console.log("  New Min Fill:", ethers.utils.formatEther(updatedOrder.minFillAmount));
                if (updatedOrder.expiry > 0) {
                    console.log("  New Expiry:", new Date(updatedOrder.expiry.toNumber() * 1000).toISOString());
                } else {
                    console.log("  New Expiry: No expiry");
                }
            } catch (fetchError) {
                console.log("⚠️  Could not fetch updated order details:", fetchError.message);
            }
            
        } else {
            console.log("❌ Transaction failed");
        }
        
    } catch (error) {
        console.error("❌ Error modifying order:");
        console.error("Message:", error.message);
        
        if (error.data) {
            console.error("Error data:", error.data);
        }
        
        console.log("\n💡 Common issues:");
        console.log("- Order does not exist");
        console.log("- You are not the order maker");
        console.log("- Order is not active");
        console.log("- Order is not a limit order");
        console.log("- Order has been partially filled (may not be modifiable)");
        console.log("- Invalid new parameters (price, amounts, etc.)");
        
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Error:", error);
        process.exit(1);
    });