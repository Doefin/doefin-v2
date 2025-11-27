const { ethers } = require("hardhat");

async function main() {
    console.log("❌ Cancelling an order...");
    
    const [deployer] = await ethers.getSigners();
    
    // Configuration from environment
    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "YOUR_DIAMOND_ADDRESS_HERE";
    const MARKET_MAKER_ADDRESS = process.env.MARKET_MAKER_ADDRESS || deployer.address;
    
    // ========================================
    // 🔧 CONFIGURE ORDER TO CANCEL HERE
    // ========================================
    
    const CANCEL_CONFIG = {
        orderId: process.env.ORDER_ID || "3",
    };
    
    // ========================================
    // Validation and setup
    // ========================================
    
    if (DIAMOND_ADDRESS === "YOUR_DIAMOND_ADDRESS_HERE") {
        throw new Error("❌ Please set DIAMOND_ADDRESS environment variable");
    }
    
    console.log("💎 Diamond Address:", DIAMOND_ADDRESS);
    console.log("🎯 Market Maker:", MARKET_MAKER_ADDRESS);
    console.log("📋 Order ID to cancel:", CANCEL_CONFIG.orderId);
    
    // Get signer (using market maker/deployer)
    let signer = deployer;
    if (MARKET_MAKER_ADDRESS !== deployer.address) {
        console.log("ℹ️  Note: Using deployer as signer. Market Maker address is different.");
    }
    
    // Get contract interfaces
    const ExchangeFacet = await ethers.getContractFactory("ExchangeFacet");
    const diamond = ExchangeFacet.attach(DIAMOND_ADDRESS);
    const diamondWithSigner = diamond.connect(signer);
    
    // Check if order exists and get current details
    console.log("\n📊 Checking order details before cancellation...");
    try {
        const currentOrder = await diamond.getOrder(CANCEL_CONFIG.orderId);
        
        if (currentOrder.maker === "0x0000000000000000000000000000000000000000") {
            throw new Error("Order does not exist");
        }
        
        console.log("✅ Current Order Details:");
        console.log("  Order ID:", CANCEL_CONFIG.orderId);
        console.log("  Maker:", currentOrder.maker);
        console.log("  Position ID:", currentOrder.positionId.toString());
        console.log("  Amount:", ethers.utils.formatEther(currentOrder.amount));
        console.log("  Remaining Amount:", ethers.utils.formatEther(currentOrder.remainingAmount));
        console.log("  Price per Token:", ethers.utils.formatEther(currentOrder.pricePerToken));
        console.log("  Direction:", currentOrder.direction === 0 ? "Buy" : "Sell");
        console.log("  Execution Type:", currentOrder.executionType === 0 ? "Market" : "Limit");
        console.log("  Active:", currentOrder.active);
        console.log("  Created At:", new Date(currentOrder.createdAt.toNumber() * 1000).toISOString());
        
        // Verify the caller is the maker
        if (currentOrder.maker.toLowerCase() !== MARKET_MAKER_ADDRESS.toLowerCase()) {
            throw new Error(`❌ Only the order maker can cancel this order. Maker: ${currentOrder.maker}, Your address: ${MARKET_MAKER_ADDRESS}`);
        }
        
        if (!currentOrder.active) {
            throw new Error("❌ Order is already inactive - cannot cancel");
        }
        
    } catch (error) {
        console.error("❌ Error checking order:", error.message);
        throw error;
    }
    
    // Cancel the order
    console.log("\n❌ Cancelling order...");
    try {
        const tx = await diamondWithSigner.cancelOrder(
            CANCEL_CONFIG.orderId,    // orderId
            { gasLimit: 1000000 }
        );
        
        console.log("📤 Transaction sent:", tx.hash);
        console.log("⏳ Waiting for confirmation...");
        
        const receipt = await tx.wait();
        
        if (receipt.status === 1) {
            console.log("✅ Order cancelled successfully!");
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
                    console.log(`  ${event.name}:`);
                    Object.keys(event.args).forEach(key => {
                        if (isNaN(key)) { // Only show named parameters
                            const value = event.args[key];
                            if (ethers.BigNumber.isBigNumber(value)) {
                                // Try to format as ether if it looks like a token amount
                                if (key.toLowerCase().includes('amount') || key.toLowerCase().includes('price')) {
                                    console.log(`    ${key}: ${ethers.utils.formatEther(value)}`);
                                } else {
                                    console.log(`    ${key}: ${value.toString()}`);
                                }
                            } else {
                                console.log(`    ${key}: ${value}`);
                            }
                        }
                    });
                });
                
            } catch (eventError) {
                console.log("⚠️  Could not parse events:", eventError.message);
            }
            
            // Get updated order details to confirm cancellation
            console.log("\n📊 Updated Order Details:");
            try {
                const updatedOrder = await diamond.getOrder(CANCEL_CONFIG.orderId);
                console.log("  Active:", updatedOrder.active);
                console.log("  Remaining Amount:", ethers.utils.formatEther(updatedOrder.remainingAmount));
                
                if (!updatedOrder.active) {
                    console.log("✅ Order successfully deactivated");
                } else {
                    console.log("⚠️  Order is still active - cancellation may have failed");
                }
            } catch (fetchError) {
                console.log("⚠️  Could not fetch updated order details:", fetchError.message);
            }
            
        } else {
            console.log("❌ Transaction failed");
        }
        
    } catch (error) {
        console.error("❌ Error cancelling order:");
        console.error("Message:", error.message);
        
        if (error.data) {
            console.error("Error data:", error.data);
        }
        
        console.log("\n💡 Common issues:");
        console.log("- Order does not exist");
        console.log("- You are not the order maker");
        console.log("- Order is already inactive");
        console.log("- Order has been fully filled");
        console.log("- Order has expired");
        
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Error:", error);
        process.exit(1);
    });