const { ethers } = require("hardhat");
require("dotenv").config();

async function main() {
    console.log("🚀 Creating counterparty cross-currency orders...");
    
    const [deployer] = await ethers.getSigners();
    console.log("📝 Operating with account:", deployer.address);
    console.log("💰 Account balance:", ethers.utils.formatEther(await deployer.getBalance()), "ETH");
    
    // Configuration from .env
    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS;
    const COLLATERAL_TOKEN_ADDRESS = process.env.COLLATERAL_TOKEN_ADDRESS;
    const CONDITION_ID = process.env.CONDITION_ID;
    const POSITION_ID_0 = process.env.POSITION_ID_0;
    const POSITION_ID_1 = process.env.POSITION_ID_1;
    
    if (!DIAMOND_ADDRESS || !COLLATERAL_TOKEN_ADDRESS || !CONDITION_ID) {
        throw new Error("❌ Please ensure all environment variables are set in .env file");
    }
    
    console.log("💎 Diamond Address:", DIAMOND_ADDRESS);
    console.log("🪙 Collateral Token:", COLLATERAL_TOKEN_ADDRESS);
    console.log("🎯 Condition ID:", CONDITION_ID);
    console.log("📍 Position ID 0 (NO):", POSITION_ID_0);
    console.log("📍 Position ID 1 (YES):", POSITION_ID_1);
    
    // Get contract interfaces
    const OrderCreationFacet = await ethers.getContractFactory("OrderCreationFacet");
    const orderFacet = OrderCreationFacet.attach(DIAMOND_ADDRESS);
    
    const ERC1155Facet = await ethers.getContractFactory("ERC1155Facet");
    const erc1155 = ERC1155Facet.attach(DIAMOND_ADDRESS);
    
    const mockToken = await ethers.getContractAt("MockERC20", COLLATERAL_TOKEN_ADDRESS);
    const tokenSymbol = await mockToken.symbol();
    const tokenDecimals = await mockToken.decimals();
    
    console.log(`📊 Using ${tokenSymbol} (${tokenDecimals} decimals) as collateral`);
    
    // Check balances before creating orders
    console.log("\n1️⃣ Checking account balances...");
    const collateralBalance = await mockToken.balanceOf(deployer.address);
    const position0Balance = await erc1155.balanceOf(deployer.address, POSITION_ID_0);
    const position1Balance = await erc1155.balanceOf(deployer.address, POSITION_ID_1);
    
    console.log(`💰 ${tokenSymbol} Balance: ${ethers.utils.formatUnits(collateralBalance, tokenDecimals)}`);
    console.log(`🎯 Position 0 (NO) Balance: ${ethers.utils.formatEther(position0Balance)}`);
    console.log(`🎯 Position 1 (YES) Balance: ${ethers.utils.formatEther(position1Balance)}`);
    
    // Create counterparty orders - these will be on opposite side of market maker orders
    console.log("\n2️⃣ Creating counterparty orders...");
    
    // Counterparty Order 1: BUY Position 1 (YES) - Taking the opposite of a SELL order
    console.log("\n📈 Creating BUY order for Position 1 (YES tokens)...");
    
    try {
        // Create a simple NON-cross-currency order first
        const buyTx = await orderFacet.createOrder(
            POSITION_ID_1, // Position ID (YES tokens)
            COLLATERAL_TOKEN_ADDRESS, // Collateral token
            ethers.utils.parseEther("100"), // Size: 100 tokens
            ethers.utils.parseUnits("0.55", tokenDecimals), // Price: 0.55
            ethers.utils.parseEther("10"), // Min fill amount: 10 tokens
            Math.floor(Date.now() / 1000) + 3600, // Expiry: 1 hour
            false, // fillOrKill: false
            0, // Direction: 0 = BUY
            0, // Execution type: 0 = FIXED (not cross-currency)
            {
                quoteCurrencyToken: ethers.constants.AddressZero, // No quote currency (standard order)
                floorRate: ethers.utils.parseUnits("0", 0) // No floor rate needed
            },
            { gasLimit: 1500000 }
        );
        
        console.log("📤 BUY transaction sent:", buyTx.hash);
        const buyReceipt = await buyTx.wait();
        console.log("✅ BUY order created in block:", buyReceipt.blockNumber);
        
        // Parse events
        const buyOrderEvent = buyReceipt.logs.find(log => {
            try {
                const parsed = orderFacet.interface.parseLog(log);
                return parsed.name === "OrderCreated";
            } catch {
                return false;
            }
        });
        
        if (buyOrderEvent) {
            const parsed = orderFacet.interface.parseLog(buyOrderEvent);
            console.log("🎉 BUY Order Created:", {
                orderId: parsed.args.orderId ? parsed.args.orderId.toString() : "N/A",
                maker: parsed.args.maker || "N/A",
                positionId: parsed.args.positionId ? parsed.args.positionId.toString() : "N/A",
                size: parsed.args.size ? ethers.utils.formatEther(parsed.args.size) : "N/A"
            });
        }
    } catch (error) {
        console.error("❌ BUY order failed:", error.message);
    }
    
    // Small delay between orders
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Counterparty Order 2: SELL Position 0 (NO) - Taking the opposite of a BUY order  
    console.log("\n📉 Creating SELL order for Position 0 (NO tokens)...");
    
    try {
        const sellTx = await orderFacet.createOrder(
            POSITION_ID_0, // Position ID (NO tokens)
            COLLATERAL_TOKEN_ADDRESS, // Collateral token
            ethers.utils.parseEther("150"), // Size: 150 tokens
            ethers.utils.parseUnits("0.45", tokenDecimals), // Price: 0.45
            ethers.utils.parseEther("25"), // Min fill amount: 25 tokens
            Math.floor(Date.now() / 1000) + 3600, // Expiry: 1 hour
            false, // fillOrKill: false
            1, // Direction: 1 = SELL
            0, // Execution type: 0 = FIXED (not cross-currency)
            {
                quoteCurrencyToken: ethers.constants.AddressZero, // No quote currency (standard order)
                floorRate: ethers.utils.parseUnits("0", 0) // No floor rate needed
            },
            { gasLimit: 1500000 }
        );
        
        console.log("📤 SELL transaction sent:", sellTx.hash);
        const sellReceipt = await sellTx.wait();
        console.log("✅ SELL order created in block:", sellReceipt.blockNumber);
        
        // Parse events
        const sellOrderEvent = sellReceipt.logs.find(log => {
            try {
                const parsed = orderFacet.interface.parseLog(log);
                return parsed.name === "OrderCreated";
            } catch {
                return false;
            }
        });
        
        if (sellOrderEvent) {
            const parsed = orderFacet.interface.parseLog(sellOrderEvent);
            console.log("🎉 SELL Order Created:", {
                orderId: parsed.args.orderId ? parsed.args.orderId.toString() : "N/A",
                maker: parsed.args.maker || "N/A",
                positionId: parsed.args.positionId ? parsed.args.positionId.toString() : "N/A",
                size: parsed.args.size ? ethers.utils.formatEther(parsed.args.size) : "N/A"
            });
        }
    } catch (error) {
        console.error("❌ SELL order failed:", error.message);
    }
    
    // 3️⃣ Create an aggressive market order to trigger matching
    console.log("\n🚀 Creating aggressive BUY order (market taker)...");
    
    try {
        const marketBuyTx = await orderFacet.createOrder(
            POSITION_ID_1, // Position ID (YES tokens)
            COLLATERAL_TOKEN_ADDRESS, // Collateral token
            ethers.utils.parseEther("50"), // Size: 50 tokens
            ethers.utils.parseUnits("0.60", tokenDecimals), // Price: 0.60 (higher than market)
            ethers.utils.parseEther("5"), // Min fill amount: 5 tokens
            Math.floor(Date.now() / 1000) + 1800, // Expiry: 30 minutes
            false, // fillOrKill: false
            0, // Direction: 0 = BUY
            0, // Execution type: 0 = FIXED
            {
                quoteCurrencyToken: ethers.constants.AddressZero, // No quote currency
                floorRate: ethers.utils.parseUnits("0", 0) // No floor rate
            },
            { gasLimit: 1500000 }
        );
        
        console.log("📤 Market BUY transaction sent:", marketBuyTx.hash);
        const marketBuyReceipt = await marketBuyTx.wait();
        console.log("✅ Market BUY order created in block:", marketBuyReceipt.blockNumber);
        
        // Parse events
        const marketBuyOrderEvent = marketBuyReceipt.logs.find(log => {
            try {
                const parsed = orderFacet.interface.parseLog(log);
                return parsed.name === "OrderCreated";
            } catch {
                return false;
            }
        });
        
        if (marketBuyOrderEvent) {
            const parsed = orderFacet.interface.parseLog(marketBuyOrderEvent);
            console.log("🎉 Market BUY Order Created:", {
                orderId: parsed.args.orderId ? parsed.args.orderId.toString() : "N/A",
                maker: parsed.args.maker || "N/A",
                positionId: parsed.args.positionId ? parsed.args.positionId.toString() : "N/A",
                size: parsed.args.size ? ethers.utils.formatEther(parsed.args.size) : "N/A"
            });
        }
    } catch (error) {
        console.error("❌ Market BUY order failed:", error.message);
    }
    
    console.log("\n🎉 Counterparty orders creation complete!");
    console.log("\n📋 Summary of Orders Created:");
    console.log("   1. BUY YES @ 0.55 (100 tokens) - Standard order");
    console.log("   2. SELL NO @ 0.45 (150 tokens) - Standard order"); 
    console.log("   3. Market BUY YES @ 0.60 (50 tokens) - Aggressive order");
    
    console.log("\n🔄 Next Steps:");
    console.log("   1. Check order book: scripts/admin-scripts/view-orders.js");
    console.log("   2. Execute trades: Check if orders automatically match");
    console.log("   3. View position balances: scripts/admin-scripts/17-verify-position-tokens.js");
    
    console.log("\n💡 What just happened:");
    console.log("   - Created standard orders without cross-currency complexity");
    console.log("   - Used different prices to create market pressure");
    console.log("   - Set up potential matching scenarios");
    console.log("   - Orders may automatically execute if they cross existing orders");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Error:", error);
        process.exit(1);
    });