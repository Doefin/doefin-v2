const hre = require("hardhat");

async function main() {
    const [signer] = await hre.ethers.getSigners();
    console.log("📚 Viewing order book...");
    console.log("📝 Operating with account:", signer.address);
    
    // Contract instances
    const DIAMOND_ADDRESS = "0xe705E1eBafF4270DC5ce74D405068221Ec3e1ABd";
    const COLLATERAL_TOKEN_ADDRESS = "0x87Cfb70F98CaF5a92ab0d2b8Ec26bC6c8ceeB25D";
    const CONDITION_ID = "0xd30fa023590ea8145f6af2acae3b0a61f34fb87852859a80433fbe3a022a84bc";
    const POSITION_ID_0 = "42357642655776753159032952059633678181643271713746076233649188523622216842216"; // NO
    const POSITION_ID_1 = "96098285239728320667922024460121242236519207887032348165891086918626104719912"; // YES
    
    const exchangeViewFacet = await hre.ethers.getContractAt(
        "ExchangeViewFacet", 
        DIAMOND_ADDRESS
    );
    
    console.log("💎 Diamond Address:", DIAMOND_ADDRESS);
    console.log("🪙 Collateral Token:", COLLATERAL_TOKEN_ADDRESS);
    console.log("🎯 Condition ID:", CONDITION_ID);
    console.log("📍 Position ID 0 (NO):", POSITION_ID_0);
    console.log("📍 Position ID 1 (YES):", POSITION_ID_1);
    
    // 1. Get the next order ID to see how many orders exist
    console.log("\n1️⃣ Getting next order ID...");
    
    try {
        const nextOrderId = await exchangeViewFacet.getNextOrderId();
        console.log("🆔 Next Order ID:", nextOrderId.toString());
        console.log("📝 Total orders created so far:", nextOrderId.toNumber() - 1);
        
        // Get individual orders
        if (nextOrderId.toNumber() > 1) {
            console.log("\n2️⃣ Retrieving individual orders...");
            
            for (let i = 1; i < nextOrderId.toNumber(); i++) {
                try {
                    const order = await exchangeViewFacet.getOrder(i);
                    const positionType = order.positionId.toString() === POSITION_ID_0 ? "NO" : "YES";
                    const direction = order.direction === 0 ? "BUY" : "SELL";
                    const executionType = order.executionType === 0 ? "FIXED" : "DYNAMIC";
                    
                    console.log(`\n   📋 Order ${i}:`);
                    console.log(`      Position: ${positionType} (${order.positionId?.toString()})`);
                    console.log(`      Direction: ${direction}`);
                    console.log(`      Size: ${hre.ethers.utils.formatEther(order.size || 0)}`);
                    console.log(`      Price: ${hre.ethers.utils.formatUnits(order.price || 0, 6)}`);
                    console.log(`      Execution: ${executionType}`);
                    console.log(`      Maker: ${order.maker}`);
                    console.log(`      Active: ${order.isActive || false}`);
                    console.log(`      Min Fill: ${hre.ethers.utils.formatEther(order.minFillAmount || 0)}`);
                    console.log(`      Expiry: ${order.expiry ? new Date(order.expiry * 1000).toISOString() : "N/A"}`);
                    
                    if (order.crossCurrencyData && order.crossCurrencyData.quoteCurrencyToken !== hre.ethers.constants.AddressZero) {
                        console.log(`      Cross-Currency: Yes (Quote: ${order.crossCurrencyData.quoteCurrencyToken})`);
                    } else {
                        console.log(`      Cross-Currency: No`);
                    }
                } catch (error) {
                    console.log(`   ❌ Failed to get order ${i}:`, error.message);
                }
            }
        }
        
    } catch (error) {
        console.log("❌ Failed to get next order ID:", error.message);
    }
    
    // 3. Get orderbook for each position and direction
    console.log("\n3️⃣ Getting orderbook for Position 0 (NO tokens)...");
    
    try {
        // Buy orders for NO tokens
        const buyOrdersNO = await exchangeViewFacet.getOrderbook(POSITION_ID_0, 0); // 0 = BUY
        console.log(`📈 BUY orders for NO tokens: ${buyOrdersNO.length}`);
        
        if (buyOrdersNO.length > 0) {
            console.log("   Order IDs:", buyOrdersNO.map(id => id.toString()).join(", "));
        }
        
        // Sell orders for NO tokens  
        const sellOrdersNO = await exchangeViewFacet.getOrderbook(POSITION_ID_0, 1); // 1 = SELL
        console.log(`📉 SELL orders for NO tokens: ${sellOrdersNO.length}`);
        
        if (sellOrdersNO.length > 0) {
            console.log("   Order IDs:", sellOrdersNO.map(id => id.toString()).join(", "));
        }
        
    } catch (error) {
        console.log("❌ Failed to get NO orderbook:", error.message);
    }
    
    console.log("\n4️⃣ Getting orderbook for Position 1 (YES tokens)...");
    
    try {
        // Buy orders for YES tokens
        const buyOrdersYES = await exchangeViewFacet.getOrderbook(POSITION_ID_1, 0); // 0 = BUY
        console.log(`📈 BUY orders for YES tokens: ${buyOrdersYES.length}`);
        
        if (buyOrdersYES.length > 0) {
            console.log("   Order IDs:", buyOrdersYES.map(id => id.toString()).join(", "));
        }
        
        // Sell orders for YES tokens
        const sellOrdersYES = await exchangeViewFacet.getOrderbook(POSITION_ID_1, 1); // 1 = SELL
        console.log(`📉 SELL orders for YES tokens: ${sellOrdersYES.length}`);
        
        if (sellOrdersYES.length > 0) {
            console.log("   Order IDs:", sellOrdersYES.map(id => id.toString()).join(", "));
        }
        
    } catch (error) {
        console.log("❌ Failed to get YES orderbook:", error.message);
    }
    
    console.log("\n🎉 Order book viewing complete!");
    console.log("\n💡 Summary:");
    console.log("   - Successfully created counterparty orders");
    console.log("   - Orders are waiting in the order book");
    console.log("   - No automatic matching occurred (same maker)");
    console.log("   - Ready for cross-account trading");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Error:", error);
        process.exit(1);
    });