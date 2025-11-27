const { ethers } = require("hardhat");

async function main() {
    console.log("🚀 Starting order creation...");
    
    const [deployer] = await ethers.getSigners();
    
    // Configuration
    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "YOUR_DIAMOND_ADDRESS_HERE";
    const CONDITION_ID = process.env.CONDITION_ID || "0x4f1dec55e191e759b1f254995797d6f1e8600ae70f81fbce00367f2c9f5e1cf7";
    const COLLATERAL_TOKEN = process.env.MOCK_TOKEN_ADDRESS || "YOUR_MOCK_TOKEN_ADDRESS_HERE";
    const MARKET_MAKER_ADDRESS = process.env.MARKET_MAKER_ADDRESS || deployer.address;
    
    // Position IDs from previous split (these should be provided from the split script output)
    const POSITION_ID_0_STR = process.env.POSITION_ID_0 || "YOUR_POSITION_ID_0_HERE"; // No/Outcome 0
    const POSITION_ID_1_STR = process.env.POSITION_ID_1 || "YOUR_POSITION_ID_1_HERE"; // Yes/Outcome 1
    
    if (DIAMOND_ADDRESS === "YOUR_DIAMOND_ADDRESS_HERE" || 
        COLLATERAL_TOKEN === "YOUR_MOCK_TOKEN_ADDRESS_HERE" ||
        POSITION_ID_0_STR === "YOUR_POSITION_ID_0_HERE" ||
        POSITION_ID_1_STR === "YOUR_POSITION_ID_1_HERE") {
        throw new Error("❌ Please set all required environment variables: DIAMOND_ADDRESS, MOCK_TOKEN_ADDRESS, POSITION_ID_0, POSITION_ID_1");
    }
    
    // Convert position IDs to proper format - if they start with 0x, they're hex, otherwise decimal
    let POSITION_ID_0, POSITION_ID_1;
    try {
        if (POSITION_ID_0_STR.startsWith('0x')) {
            POSITION_ID_0 = POSITION_ID_0_STR;
        } else {
            // Convert large decimal to hex to avoid BigNumber issues
            POSITION_ID_0 = ethers.BigNumber.from(POSITION_ID_0_STR).toHexString();
        }
        
        if (POSITION_ID_1_STR.startsWith('0x')) {
            POSITION_ID_1 = POSITION_ID_1_STR;
        } else {
            // Convert large decimal to hex to avoid BigNumber issues  
            POSITION_ID_1 = ethers.BigNumber.from(POSITION_ID_1_STR).toHexString();
        }
    } catch (error) {
        console.error("❌ Error converting position IDs:", error.message);
        throw new Error("Invalid position IDs in environment variables");
    }
    
    console.log("💎 Diamond Address:", DIAMOND_ADDRESS);
    console.log("🔍 Condition ID:", CONDITION_ID);
    console.log("💰 Collateral Token:", COLLATERAL_TOKEN);
    console.log("🎯 Market Maker:", MARKET_MAKER_ADDRESS);
    console.log("📍 Position ID 0 (No):", POSITION_ID_0);
    console.log("📍 Position ID 1 (Yes):", POSITION_ID_1);
    
    // Get Market Maker signer
    let marketMakerSigner = deployer;
    if (MARKET_MAKER_ADDRESS !== deployer.address) {
        console.log("ℹ️  Note: Using deployer as signer. If Market Maker is different, update the script with proper signer.");
    }
    
    // Get ExchangeFacet interface
    const ExchangeFacet = await ethers.getContractFactory("ExchangeFacet");
    const diamond = ExchangeFacet.attach(DIAMOND_ADDRESS);
    const diamondWithMM = diamond.connect(marketMakerSigner);
    
    // Order Direction enum values (from LibDoefinStorage.sol)
    const OrderDirection = {
        Buy: 0,   // Buy
        Sell: 1   // Sell
    };
    
    // Execution Type enum values (from LibDoefinStorage.sol)
    const ExecutionType = {
        Market: 0, // Market order
        Limit: 1   // Limit order
    };
    
    // Check current balances before creating orders
    console.log("\n1️⃣ Checking current balances...");
    
    // Check ERC20 balance (collateral)
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const mockToken = MockERC20.attach(COLLATERAL_TOKEN);
    const erc20Balance = await mockToken.balanceOf(MARKET_MAKER_ADDRESS);
    console.log("💰 ERC20 Balance:", ethers.utils.formatEther(erc20Balance));
    
    // Check ERC1155 balances (conditional tokens)
    const ERC1155Facet = await ethers.getContractFactory("ERC1155Facet");
    const erc1155 = ERC1155Facet.attach(DIAMOND_ADDRESS);
    const ctBalance0 = await erc1155.balanceOf(MARKET_MAKER_ADDRESS, POSITION_ID_0);
    const ctBalance1 = await erc1155.balanceOf(MARKET_MAKER_ADDRESS, POSITION_ID_1);
    console.log("🎫 CT Balance (Position 0 - No):", ethers.utils.formatEther(ctBalance0));
    console.log("🎫 CT Balance (Position 1 - Yes):", ethers.utils.formatEther(ctBalance1));
    
    // Get initial order ID to track new orders
    const initialOrderId = await diamond.getNextOrderId();
    console.log("📋 Next Order ID:", initialOrderId.toString());
    
    // Order parameters
    const orderAmount = ethers.utils.parseEther("10"); // 10 tokens
    const limitPrice = ethers.utils.parseEther("0.6");  // 0.6 ETH per token (60 cents if ETH = $1)
    const minFillAmount = ethers.utils.parseEther("1");  // Minimum 1 token fill
    const expiry = Math.floor(Date.now() / 1000) + 86400; // 24 hours from now
    const fillOrKill = false; // Allow partial fills
    
    console.log("\n📝 Order Parameters:");
    console.log("Amount:", ethers.utils.formatEther(orderAmount));
    console.log("Limit Price:", ethers.utils.formatEther(limitPrice));
    console.log("Min Fill Amount:", ethers.utils.formatEther(minFillAmount));
    console.log("Expiry:", new Date(expiry * 1000).toISOString());
    console.log("Fill or Kill:", fillOrKill);
    
    const createdOrders = [];
    
    try {
        // 1. Create a BUY LIMIT order for Position 1 (Yes) using collateral
        console.log("\n2️⃣ Creating BUY LIMIT order for Position 1 (Yes)...");
        console.log("📄 This will buy Yes tokens using collateral at limit price");
        
        const buyLimitTx = await diamondWithMM.createOrder(
            POSITION_ID_1,        // positionId - buying Yes tokens
            COLLATERAL_TOKEN,     // collateralToken - paying with ERC20
            orderAmount,          // amount - 10 tokens
            limitPrice,           // pricePerToken - 0.6 per token
            minFillAmount,        // minFillAmount - at least 1 token
            expiry,               // expiry - 24 hours
            fillOrKill,           // fillOrKill - allow partial
            OrderDirection.Buy,   // direction - Buy
            ExecutionType.Limit,  // executionType - Limit order
            { gasLimit: 2000000 }
        );
        
        console.log("📤 Buy Limit transaction sent:", buyLimitTx.hash);
        const buyLimitReceipt = await buyLimitTx.wait();
        console.log("✅ Buy Limit order created in block:", buyLimitReceipt.blockNumber);
        
        const buyLimitOrderId = initialOrderId;
        createdOrders.push({
            id: buyLimitOrderId.toString(),
            type: "BUY LIMIT",
            position: "Position 1 (Yes)",
            positionId: POSITION_ID_1
        });
        
        // 2. Create a SELL LIMIT order for Position 1 (Yes) 
        console.log("\n3️⃣ Creating SELL LIMIT order for Position 1 (Yes)...");
        console.log("📄 This will sell Yes tokens for collateral at limit price");
        
        const sellLimitPrice = ethers.utils.parseEther("0.7"); // Selling at higher price
        
        const sellLimitTx = await diamondWithMM.createOrder(
            POSITION_ID_1,        // positionId - selling Yes tokens
            COLLATERAL_TOKEN,     // collateralToken - receiving ERC20
            orderAmount,          // amount - 10 tokens
            sellLimitPrice,       // pricePerToken - 0.7 per token
            minFillAmount,        // minFillAmount - at least 1 token
            expiry,               // expiry - 24 hours
            fillOrKill,           // fillOrKill - allow partial
            OrderDirection.Sell,  // direction - Sell
            ExecutionType.Limit,  // executionType - Limit order
            { gasLimit: 2000000 }
        );
        
        console.log("📤 Sell Limit transaction sent:", sellLimitTx.hash);
        const sellLimitReceipt = await sellLimitTx.wait();
        console.log("✅ Sell Limit order created in block:", sellLimitReceipt.blockNumber);
        
        const sellLimitOrderId = initialOrderId.add(1);
        createdOrders.push({
            id: sellLimitOrderId.toString(),
            type: "SELL LIMIT",
            position: "Position 1 (Yes)",
            positionId: POSITION_ID_1
        });
        
        // 3. Create a BUY LIMIT order for Position 0 (No)
        console.log("\n4️⃣ Creating BUY LIMIT order for Position 0 (No)...");
        console.log("📄 This will buy No tokens using collateral at limit price");
        
        const noTokenPrice = ethers.utils.parseEther("0.4"); // 40 cents per No token
        
        const buyNoLimitTx = await diamondWithMM.createOrder(
            POSITION_ID_0,        // positionId - buying No tokens
            COLLATERAL_TOKEN,     // collateralToken - paying with ERC20
            orderAmount,          // amount - 10 tokens
            noTokenPrice,         // pricePerToken - 0.4 per token
            minFillAmount,        // minFillAmount - at least 1 token
            expiry,               // expiry - 24 hours
            fillOrKill,           // fillOrKill - allow partial
            OrderDirection.Buy,   // direction - Buy
            ExecutionType.Limit,  // executionType - Limit order
            { gasLimit: 2000000 }
        );
        
        console.log("📤 Buy No Limit transaction sent:", buyNoLimitTx.hash);
        const buyNoLimitReceipt = await buyNoLimitTx.wait();
        console.log("✅ Buy No Limit order created in block:", buyNoLimitReceipt.blockNumber);
        
        const buyNoLimitOrderId = initialOrderId.add(2);
        createdOrders.push({
            id: buyNoLimitOrderId.toString(),
            type: "BUY LIMIT",
            position: "Position 0 (No)",
            positionId: POSITION_ID_0
        });
        
        // 4. Create a SELL LIMIT order for Position 0 (No)
        console.log("\n5️⃣ Creating SELL LIMIT order for Position 0 (No)...");
        console.log("📄 This will sell No tokens for collateral at limit price");
        
        const sellNoPrice = ethers.utils.parseEther("0.5"); // Selling No tokens at 50 cents
        
        const sellNoLimitTx = await diamondWithMM.createOrder(
            POSITION_ID_0,        // positionId - selling No tokens
            COLLATERAL_TOKEN,     // collateralToken - receiving ERC20
            orderAmount,          // amount - 10 tokens
            sellNoPrice,          // pricePerToken - 0.5 per token
            minFillAmount,        // minFillAmount - at least 1 token
            expiry,               // expiry - 24 hours
            fillOrKill,           // fillOrKill - allow partial
            OrderDirection.Sell,  // direction - Sell
            ExecutionType.Limit,  // executionType - Limit order
            { gasLimit: 2000000 }
        );
        
        console.log("📤 Sell No Limit transaction sent:", sellNoLimitTx.hash);
        const sellNoLimitReceipt = await sellNoLimitTx.wait();
        console.log("✅ Sell No Limit order created in block:", sellNoLimitReceipt.blockNumber);
        
        const sellNoLimitOrderId = initialOrderId.add(3);
        createdOrders.push({
            id: sellNoLimitOrderId.toString(),
            type: "SELL LIMIT",
            position: "Position 0 (No)",
            positionId: POSITION_ID_0
        });
        
        // 5. Create a BUY MARKET order for Position 1 (Yes)
        console.log("\n6️⃣ Creating BUY MARKET order for Position 1 (Yes)...");
        console.log("📄 This will buy Yes tokens at market price (immediate execution)");
        
        const marketOrderAmount = ethers.utils.parseEther("5"); // Smaller amount for market order
        
        const buyMarketTx = await diamondWithMM.createOrder(
            POSITION_ID_1,        // positionId - buying Yes tokens
            COLLATERAL_TOKEN,     // collateralToken - paying with ERC20
            marketOrderAmount,    // amount - 5 tokens
            ethers.constants.MaxUint256, // pricePerToken - market price (max for buy)
            marketOrderAmount,    // minFillAmount - all or nothing for market
            expiry,               // expiry - 24 hours
            false,                // fillOrKill - false for market orders
            OrderDirection.Buy,   // direction - Buy
            ExecutionType.Market, // executionType - Market order
            { gasLimit: 2000000 }
        );
        
        console.log("📤 Buy Market transaction sent:", buyMarketTx.hash);
        const buyMarketReceipt = await buyMarketTx.wait();
        console.log("✅ Buy Market order created in block:", buyMarketReceipt.blockNumber);
        
        const buyMarketOrderId = initialOrderId.add(4);
        createdOrders.push({
            id: buyMarketOrderId.toString(),
            type: "BUY MARKET",
            position: "Position 1 (Yes)",
            positionId: POSITION_ID_1
        });
        
        // 6. Create a SELL MARKET order for Position 1 (Yes)
        console.log("\n7️⃣ Creating SELL MARKET order for Position 1 (Yes)...");
        console.log("📄 This will sell Yes tokens at market price (immediate execution)");
        
        const sellMarketTx = await diamondWithMM.createOrder(
            POSITION_ID_1,        // positionId - selling Yes tokens
            COLLATERAL_TOKEN,     // collateralToken - receiving ERC20
            marketOrderAmount,    // amount - 5 tokens
            ethers.constants.Zero, // pricePerToken - market price (0 for sell)
            marketOrderAmount,    // minFillAmount - all or nothing for market
            expiry,               // expiry - 24 hours
            false,                // fillOrKill - false for market orders
            OrderDirection.Sell,  // direction - Sell
            ExecutionType.Market, // executionType - Market order
            { gasLimit: 2000000 }
        );
        
        console.log("📤 Sell Market transaction sent:", sellMarketTx.hash);
        const sellMarketReceipt = await sellMarketTx.wait();
        console.log("✅ Sell Market order created in block:", sellMarketReceipt.blockNumber);
        
        const sellMarketOrderId = initialOrderId.add(5);
        createdOrders.push({
            id: sellMarketOrderId.toString(),
            type: "SELL MARKET",
            position: "Position 1 (Yes)",
            positionId: POSITION_ID_1
        });
        
        // Display all created orders
        console.log("\n8️⃣ Verifying created orders...");
        for (const orderInfo of createdOrders) {
            try {
                const order = await diamond.getOrder(orderInfo.id);
                console.log(`\n📋 Order ${orderInfo.id} (${orderInfo.type}):`);
                console.log("  Position ID:", order.positionId.toString());
                console.log("  Amount:", ethers.utils.formatEther(order.amount));
                console.log("  Price per Token:", ethers.utils.formatEther(order.pricePerToken));
                console.log("  Direction:", order.direction === 0 ? "Buy" : "Sell");
                console.log("  Execution Type:", order.executionType === 0 ? "Market" : "Limit");
                console.log("  Status:", order.status); // You may want to check what status enum values mean
                console.log("  Creator:", order.creator);
            } catch (error) {
                console.log(`❌ Error fetching order ${orderInfo.id}:`, error.message);
            }
        }
        
        // Show orderbook status
        console.log("\n9️⃣ Checking orderbook status...");
        
        try {
            const buyOrdersPosition1 = await diamond.getOrderbook(POSITION_ID_1, OrderDirection.Buy);
            const sellOrdersPosition1 = await diamond.getOrderbook(POSITION_ID_1, OrderDirection.Sell);
            const buyOrdersPosition0 = await diamond.getOrderbook(POSITION_ID_0, OrderDirection.Buy);
            const sellOrdersPosition0 = await diamond.getOrderbook(POSITION_ID_0, OrderDirection.Sell);
            
            console.log("📊 Position 1 (Yes) - Buy Orders:", buyOrdersPosition1.map(id => id.toString()));
            console.log("📊 Position 1 (Yes) - Sell Orders:", sellOrdersPosition1.map(id => id.toString()));
            console.log("📊 Position 0 (No) - Buy Orders:", buyOrdersPosition0.map(id => id.toString()));
            console.log("📊 Position 0 (No) - Sell Orders:", sellOrdersPosition0.map(id => id.toString()));
        } catch (error) {
            console.log("❌ Error fetching orderbook:", error.message);
        }
        
        console.log("\n✅ All orders created successfully!");
        
        console.log("\n📋 Summary of Created Orders:");
        createdOrders.forEach(order => {
            console.log(`  ${order.type}: Order ID ${order.id} for ${order.position}`);
        });
        
        console.log("\n💡 Next steps:");
        console.log("- Orders are now in the orderbook");
        console.log("- Market orders should execute immediately if there's liquidity");
        console.log("- Limit orders will wait for matching orders");
        console.log("- You can check order status with getOrder(orderId)");
        console.log("- You can cancel orders with cancelOrder(orderId)");
        
    } catch (error) {
        console.error("❌ Error creating orders:");
        console.error("Error message:", error.message);
        
        // Help identify common errors
        if (error.data) {
            console.error("Error data:", error.data);
        }
        
        if (error.message.includes("insufficient funds") || error.message.includes("transfer amount exceeds balance")) {
            console.error("💡 Insufficient balance. Make sure you have:");
            console.error("  - Enough ERC20 tokens for buy orders");
            console.error("  - Enough conditional tokens for sell orders");
            console.error("  - Proper allowances set");
        }
        
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Error:", error);
        process.exit(1);
    });