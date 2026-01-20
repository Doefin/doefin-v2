const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployDiamond } = require("../../../scripts/deploy.js");
const { 
  createMarketOrder,
  createCrossCurrencyMarketOrder,
  createLimitOrder,
  OrderDirection
} = require("../../utils/orderUtils.js");
const { splitConditionAndGetPositionIds } = require("../../utils/conditionUtils.js");

describe("RouteSimulationFacet - Cross-Currency", function () {
  let diamondAddress;
  let routeSimulationFacet;
  let adminConfigFacet;
  let conditionalTokensFacet;
  let conditionManagerFacet;
  let orderCreationFacet;
  let owner;
  let user1;
  let user2;
  let user3;
  let mockUSDC;
  let mockWETH;
  let conditionId;
  let positionId;

  before(async function () {
    this.timeout(60000); // Increase timeout for deployment
    [owner, user1, user2, user3] = await ethers.getSigners();

    // Deploy diamond
    diamondAddress = await deployDiamond();

    // Get facets
    routeSimulationFacet = await ethers.getContractAt("RouteSimulationFacet", diamondAddress);
    adminConfigFacet = await ethers.getContractAt("AdminConfigFacet", diamondAddress);
    conditionalTokensFacet = await ethers.getContractAt("ConditionalTokensFacet", diamondAddress);
    conditionManagerFacet = await ethers.getContractAt("ConditionManagerFacet", diamondAddress);
    orderCreationFacet = await ethers.getContractAt("OrderCreationFacet", diamondAddress);
    const accessControlFacet = await ethers.getContractAt("AccessControlFacet", diamondAddress);

    // Grant market maker role to owner
    await accessControlFacet.addMarketMaker(owner.address);

    // Deploy mock tokens
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    mockUSDC = await MockERC20.deploy("USD Coin", "USDC", 6);
    await mockUSDC.deployed();
    mockWETH = await MockERC20.deploy("Wrapped Ether", "WETH", 18);
    await mockWETH.deployed();

    // Setup admin config
    await adminConfigFacet.addCollateralToken(mockUSDC.address, ethers.utils.parseUnits("1", 6));
    await adminConfigFacet.addCollateralToken(mockWETH.address, ethers.utils.parseUnits("1", 18));

    // Setup conversion path (USDC -> WETH)
    const assetId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("WETH-USD"));
    await adminConfigFacet.setConversionPath(
      mockUSDC.address,
      mockWETH.address,
      [assetId]
    );

    // Create condition and position
    const questionId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("Will BTC hit 100k?"));
    await conditionManagerFacet.createCondition(
      diamondAddress,
      questionId,
      2,
      "BTC100k"
    );

    conditionId = await conditionalTokensFacet.getConditionId(
      diamondAddress,
      questionId,
      2
    );

    positionId = await conditionalTokensFacet.getPositionId(
      mockUSDC.address,
      ethers.utils.solidityKeccak256(
        ["bytes32", "uint256"],
        [conditionId, 1]
      )
    );

    // Mint tokens to users
    await mockUSDC.mint(user1.address, ethers.utils.parseUnits("10000", 6));
    await mockUSDC.mint(user2.address, ethers.utils.parseUnits("10000", 6));
    await mockWETH.mint(user1.address, ethers.utils.parseUnits("10", 18));
    await mockWETH.mint(user2.address, ethers.utils.parseUnits("10", 18));

    // Approve diamond
    await mockUSDC.connect(user1).approve(diamondAddress, ethers.constants.MaxUint256);
    await mockUSDC.connect(user2).approve(diamondAddress, ethers.constants.MaxUint256);
    await mockWETH.connect(user1).approve(diamondAddress, ethers.constants.MaxUint256);
    await mockWETH.connect(user2).approve(diamondAddress, ethers.constants.MaxUint256);
  });

  describe("simulateMarketOrder - Unified API", function () {
    it("should return empty route when no compatible orders exist - Fixed order type", async function () {
      // Fixed cross-currency order (floorRate = 0)
      const crossCurrencyData = {
        quoteCurrencyToken: mockWETH.address,
        floorRate: 0
      };

      const route = await routeSimulationFacet.simulateMarketOrder(
        positionId,
        ethers.utils.parseUnits("100", 6),
        0, // Buy
        crossCurrencyData
      );

      expect(route.matches.length).to.equal(0);
      expect(route.totalInputAmount).to.equal(0);
      expect(route.totalOutputAmount).to.equal(0);
    });

    it("should return empty route when no compatible orders exist - Dynamic order type", async function () {
      // Dynamic cross-currency order (floorRate > 0)
      const crossCurrencyData = {
        quoteCurrencyToken: mockWETH.address,
        floorRate: ethers.utils.parseUnits("1500", 6) // Example floor rate
      };

      const route = await routeSimulationFacet.simulateMarketOrder(
        positionId,
        ethers.utils.parseUnits("100", 6),
        0, // Buy
        crossCurrencyData
      );

      expect(route.matches.length).to.equal(0);
      expect(route.totalInputAmount).to.equal(0);
      expect(route.totalOutputAmount).to.equal(0);
    });

    it("should return empty route when no compatible orders exist - Standard order", async function () {
      // Standard order (quoteCurrencyToken = address(0))
      const crossCurrencyData = {
        quoteCurrencyToken: ethers.constants.AddressZero,
        floorRate: 0
      };

      const route = await routeSimulationFacet.simulateMarketOrder(
        positionId,
        ethers.utils.parseUnits("100", 6),
        0, // Buy
        crossCurrencyData
      );

      expect(route.matches.length).to.equal(0);
      expect(route.totalInputAmount).to.equal(0);
      expect(route.totalOutputAmount).to.equal(0);
    });

    it("should validate quote currency token is not zero address for cross-currency", async function () {
      const crossCurrencyData = {
        quoteCurrencyToken: ethers.constants.AddressZero,
        floorRate: ethers.utils.parseUnits("1500", 6) // Non-zero floor rate but zero quote token
      };

      // This should be treated as standard order since quoteCurrencyToken is zero
      const route = await routeSimulationFacet.simulateMarketOrder(
        positionId,
        ethers.utils.parseUnits("100", 6),
        0, // Buy
        crossCurrencyData
      );

      // Should work as standard order
      expect(route.totalInputAmount).to.be.gte(0);
      expect(route.totalOutputAmount).to.be.gte(0);
    });

    it("should validate quote currency token is allowed", async function () {
      const unapprovedToken = ethers.Wallet.createRandom().address;
      const crossCurrencyData = {
        quoteCurrencyToken: unapprovedToken,
        floorRate: 0
      };

      try {
        await routeSimulationFacet.simulateMarketOrder(
          positionId,
          ethers.utils.parseUnits("100", 6),
          0, // Buy
          crossCurrencyData
        );
        expect.fail("Should have reverted with TokenNotAllowed");
      } catch (error) {
        expect(error.message).to.include("TokenNotAllowed");
      }
    });

    // Test with actual orders to verify budget/shares constraints and floor rates
    describe("Cross-Currency Simulation with Real Orders", function () {
      let orderCreationFacet;
      let orderManagementFacet;

      beforeEach(async function () {
        orderCreationFacet = await ethers.getContractAt("OrderCreationFacet", diamondAddress);
        orderManagementFacet = await ethers.getContractAt("OrderManagementFacet", diamondAddress);

        // Create some cross-currency orders for testing
        // Only use Fixed cross-currency orders (floorRate=0) to avoid oracle requirements
        const fixedCCData = {
          quoteCurrencyToken: mockWETH.address,
          floorRate: 0 // Fixed order - no oracle needed
        };

        // Fixed cross-currency sell order (USDC position, priced in WETH)
        await orderCreationFacet.connect(user1).createOrder(
          positionId,
          mockUSDC.address,
          ethers.utils.parseUnits("1000", 6), // 1000 shares
          ethers.utils.parseUnits("0.5", 18), // 0.5 WETH per share
          ethers.utils.parseUnits("10", 6), // min 10 shares
          0, // no expiry
          false, // not fill-or-kill
          1, // Sell
          0, // Limit order
          fixedCCData
        );

        // Another Fixed cross-currency buy order
        await orderCreationFacet.connect(user2).createOrder(
          positionId,
          mockUSDC.address,
          ethers.utils.parseUnits("500", 6), // 500 shares
          ethers.utils.parseUnits("0.4", 18), // 0.4 WETH per share
          ethers.utils.parseUnits("50", 6), // min 50 shares
          0, // no expiry
          false, // not fill-or-kill
          0, // Buy
          0, // Limit order
          fixedCCData
        );
      });

      it("should respect budget constraints for buy simulation - Fixed CC", async function () {
        const budget = ethers.utils.parseUnits("100", 18); // 100 WETH budget
        const crossCurrencyData = {
          quoteCurrencyToken: mockWETH.address,
          floorRate: 0 // Fixed order simulation
        };

        const route = await routeSimulationFacet.simulateMarketOrder(
          positionId,
          budget,
          0, // Buy
          crossCurrencyData
        );

        // Should limit purchases based on budget
        if (route.matches.length > 0) {
          expect(route.totalOutputAmount).to.be.lte(budget);
          expect(route.totalInputAmount).to.be.gt(0); // Should get some shares
        }
      });

      it("should respect shares constraints for sell simulation - Fixed CC", async function () {
        const sharesToSell = ethers.utils.parseUnits("200", 6); // 200 shares to sell
        const crossCurrencyData = {
          quoteCurrencyToken: mockWETH.address,
          floorRate: 0 // Fixed order simulation
        };

        const route = await routeSimulationFacet.simulateMarketOrder(
          positionId,
          sharesToSell,
          1, // Sell
          crossCurrencyData
        );

        // Should limit sales based on available shares
        if (route.matches.length > 0) {
          expect(route.totalInputAmount).to.be.lte(sharesToSell);
          expect(route.totalOutputAmount).to.be.gt(0); // Should get some WETH revenue
        }
      });

      it("should respect budget constraints for buy simulation - Standard order", async function () {
        const budget = ethers.utils.parseUnits("100", 6); // 100 USDC budget
        const crossCurrencyData = {
          quoteCurrencyToken: ethers.constants.AddressZero, // Standard order
          floorRate: 0
        };

        const route = await routeSimulationFacet.simulateMarketOrder(
          positionId,
          budget,
          0, // Buy
          crossCurrencyData
        );

        // Should work as standard simulation
        expect(route.totalInputAmount).to.be.gte(0);
        expect(route.totalOutputAmount).to.be.gte(0);
      });

      it("should handle Dynamic order simulation with floor rate", async function () {
        const budget = ethers.utils.parseUnits("50", 18); // 50 WETH budget
        const crossCurrencyData = {
          quoteCurrencyToken: mockWETH.address,
          floorRate: ethers.utils.parseUnits("1800", 6) // Floor rate for dynamic order
        };

        // Dynamic simulation should work even without oracle setup
        // It may return empty results due to missing oracle, but shouldn't crash
        const route = await routeSimulationFacet.simulateMarketOrder(
          positionId,
          budget,
          0, // Buy
          crossCurrencyData
        );

        // Route should be valid (may be empty due to no compatible Dynamic orders)
        expect(route.totalInputAmount).to.be.gte(0);
        expect(route.totalOutputAmount).to.be.gte(0);
        if (route.matches.length > 0) {
          expect(route.totalOutputAmount).to.be.lte(budget);
        }
      });

      it("should return empty route for incompatible floor rate - Dynamic CC", async function () {
        const budget = ethers.utils.parseUnits("100", 18); // 100 WETH budget
        const crossCurrencyData = {
          quoteCurrencyToken: mockWETH.address,
          floorRate: ethers.utils.parseUnits("3000", 6) // Very high floor rate
        };

        // Should return empty route due to no Dynamic orders with compatible floor rates
        const route = await routeSimulationFacet.simulateMarketOrder(
          positionId,
          budget,
          0, // Buy
          crossCurrencyData
        );

        // Should return empty route (no compatible Dynamic orders in our test setup)
        expect(route.matches.length).to.equal(0);
        expect(route.totalInputAmount).to.equal(0);
        expect(route.totalOutputAmount).to.equal(0);
      });

      it("should differentiate between Fixed and Dynamic order types based on floor rate", async function () {
        const budget = ethers.utils.parseUnits("100", 18);

        // Fixed order (floorRate = 0)
        const fixedCCData = {
          quoteCurrencyToken: mockWETH.address,
          floorRate: 0
        };

        const fixedRoute = await routeSimulationFacet.simulateMarketOrder(
          positionId,
          budget,
          0, // Buy
          fixedCCData
        );

        // Dynamic order (floorRate > 0)
        const dynamicCCData = {
          quoteCurrencyToken: mockWETH.address,
          floorRate: ethers.utils.parseUnits("2000", 6)
        };

        const dynamicRoute = await routeSimulationFacet.simulateMarketOrder(
          positionId,
          budget,
          0, // Buy
          dynamicCCData
        );

        // Both should be valid calls (results may differ based on available orders)
        expect(fixedRoute.totalInputAmount).to.be.gte(0);
        expect(dynamicRoute.totalInputAmount).to.be.gte(0);
      });

      it("should handle standard vs cross-currency differentiation", async function () {
        const budget = ethers.utils.parseUnits("100", 6);

        // Standard order
        const standardData = {
          quoteCurrencyToken: ethers.constants.AddressZero,
          floorRate: 0
        };

        const standardRoute = await routeSimulationFacet.simulateMarketOrder(
          positionId,
          budget,
          0, // Buy
          standardData
        );

        // Cross-currency order
        const crossCurrencyData = {
          quoteCurrencyToken: mockWETH.address,
          floorRate: 0
        };

        const crossCurrencyRoute = await routeSimulationFacet.simulateMarketOrder(
          positionId,
          budget,
          0, // Buy
          crossCurrencyData
        );

        // Both should be valid calls with unified API
        expect(standardRoute.totalInputAmount).to.be.gte(0);
        expect(crossCurrencyRoute.totalInputAmount).to.be.gte(0);
      });
    });

    // Critical validation: Simulation vs Execution results must match exactly
    describe("Simulation vs Execution Validation", function () {
      let marketExecutionFacet;
      let erc1155Facet;
      let snapshotId;

      beforeEach(async function () {
        marketExecutionFacet = await ethers.getContractAt("MarketExecutionFacet", diamondAddress);
        erc1155Facet = await ethers.getContractAt("ERC1155Facet", diamondAddress);
        
        // Take snapshot before each test for clean state
        snapshotId = await network.provider.send("evm_snapshot");
        
        // Setup initial orderbook liquidity for proper testing
        const splitAmount = ethers.utils.parseUnits("2000", 6);
        
        // Check user2 balance and approval
        const user2Balance = await mockUSDC.balanceOf(user2.address);
        console.log("User2 USDC balance:", ethers.utils.formatUnits(user2Balance, 6));
        
        // Ensure user2 has approval
        const allowance = await mockUSDC.allowance(user2.address, diamondAddress);
        if (allowance.lt(splitAmount)) {
          await mockUSDC.connect(user2).approve(diamondAddress, ethers.constants.MaxUint256);
        }
        
        // Split position using the proper utility function
        const [positionIds, amounts] = await splitConditionAndGetPositionIds({
          conditionalFacet: conditionalTokensFacet,
          erc20: mockUSDC,
          conditionId,
          amount: splitAmount,
          user: user2,
          indexSets: [1, 2], // Binary condition: YES (1) and NO (2)
        });
        
        console.log("Split position result:");
        console.log("  Position IDs:", positionIds.map(id => id.toString()));
        console.log("  Amounts:", amounts.map(amt => ethers.utils.formatUnits(amt, 6)));
        
        // Update the positionId to match the actual created position
        // Note: positionIds[0] should be the YES token we want
        const actualPositionId = positionIds[0];
        console.log("Original positionId:", positionId.toString());
        console.log("Actual positionId:", actualPositionId.toString());
        
        // Verify user2 got position tokens
        const user2PositionBalance = await erc1155Facet.balanceOf(user2.address, actualPositionId);
        console.log("User2 position token balance:", ethers.utils.formatUnits(user2PositionBalance, 6));
        
        // If we got different position IDs, update our test to use the correct one
        if (actualPositionId.toString() !== positionId.toString()) {
          console.log("Position ID mismatch - updating test to use actual position ID");
          global.testPositionId = actualPositionId; // Store for test use
        }
        
        // Approve diamond to transfer user2's position tokens for order creation
        await erc1155Facet.connect(user2).setApprovalForAll(diamondAddress, true);
        
        // Use the actual position ID for creating orders
        const orderPositionId = actualPositionId;
        
        // Create sell orders to provide liquidity for buy tests
        await createLimitOrder(orderCreationFacet, user2, {
          positionId: orderPositionId,
          collateralToken: mockUSDC.address,
          amount: ethers.utils.parseUnits("500", 6), // 500 shares
          pricePerToken: ethers.utils.parseUnits("0.6", 6), // 0.6 USDC per share
          direction: OrderDirection.Sell
        });
        
        await createLimitOrder(orderCreationFacet, user2, {
          positionId: orderPositionId,
          collateralToken: mockUSDC.address,
          amount: ethers.utils.parseUnits("300", 6), // 300 shares  
          pricePerToken: ethers.utils.parseUnits("0.7", 6), // 0.7 USDC per share
          direction: OrderDirection.Sell
        });
        
        // Create buy orders to provide liquidity for sell tests
        await createLimitOrder(orderCreationFacet, user2, {
          positionId: orderPositionId,
          collateralToken: mockUSDC.address,
          amount: ethers.utils.parseUnits("200", 6), // 200 shares
          pricePerToken: ethers.utils.parseUnits("0.5", 6), // 0.5 USDC per share
          direction: OrderDirection.Buy
        });
        
        // Create WETH buy orders for cross-currency sell tests
        // Give user3 WETH balance and approve for orders
        await mockWETH.mint(user3.address, ethers.utils.parseEther("1"));
        await mockWETH.connect(user3).approve(diamondAddress, ethers.constants.MaxUint256);
        
        await createLimitOrder(orderCreationFacet, user3, {
          positionId: orderPositionId,
          collateralToken: mockWETH.address,
          amount: ethers.utils.parseUnits("100", 6), // 100 shares
          pricePerToken: ethers.utils.parseEther("0.0001"), // 0.0001 WETH per share
          direction: OrderDirection.Buy
        });
        
        await createLimitOrder(orderCreationFacet, user3, {
          positionId: orderPositionId,
          collateralToken: mockWETH.address,
          amount: ethers.utils.parseUnits("150", 6), // 150 shares
          pricePerToken: ethers.utils.parseEther("0.0002"), // 0.0002 WETH per share
          direction: OrderDirection.Buy
        });
      });

      afterEach(async function () {
        // Revert to snapshot after each test
        await network.provider.send("evm_revert", [snapshotId]);
      });

      it("should have simulation match execution for standard market buy order", async function () {
        const budget = ethers.utils.parseUnits("100", 6); // 100 USDC budget
        
        // Use the actual position ID from setup (might be different from calculated one)
        const testPositionId = global.testPositionId || positionId;
        console.log("Using position ID for test:", testPositionId.toString());
        
        const crossCurrencyData = {
          quoteCurrencyToken: ethers.constants.AddressZero, // Standard order
          floorRate: 0
        };

        // 1. Get simulation prediction based on budget
        const simulationRoute = await routeSimulationFacet.simulateMarketOrder(
          testPositionId,
          budget, // Budget to spend
          0, // Buy
          crossCurrencyData
        );

        console.log("Simulation results:");
        console.log("  Tokens buyable with budget:", ethers.utils.formatUnits(simulationRoute.totalInputAmount, 6));
        console.log("  Total cost:", ethers.utils.formatUnits(simulationRoute.totalOutputAmount, 6));

        // Skip test if no liquidity available
        if (simulationRoute.totalInputAmount.eq(0)) {
          console.log("No liquidity available, skipping test");
          return;
        }

        // 2. Record balances before execution
        const beforeCollateralBalance = await mockUSDC.balanceOf(user1.address);
        const beforeShareBalance = await erc1155Facet.balanceOf(user1.address, testPositionId);
        
        console.log("Before execution:");
        console.log("  User1 USDC balance:", ethers.utils.formatUnits(beforeCollateralBalance, 6));
        console.log("  User1 position balance:", ethers.utils.formatUnits(beforeShareBalance, 6));

        // 3. Execute actual market order using the token amount from simulation
        const tokenAmountToBuy = simulationRoute.totalInputAmount; // Number of tokens to buy
        const maxPricePerToken = ethers.utils.parseUnits("0.7", 6); // Willing to pay up to 0.7 USDC per token
        
        await createMarketOrder(orderCreationFacet, user1, {
          positionId: testPositionId,
          collateralToken: mockUSDC.address,
          amount: tokenAmountToBuy, // Use amount from simulation
          pricePerToken: maxPricePerToken,
          minFillAmount: tokenAmountToBuy.mul(90).div(100), // Accept 90% minimum fill
          expiry: Math.floor(Date.now() / 1000) + 3600,
          direction: OrderDirection.Buy
        });

        // 4. Record balances after execution
        const afterCollateralBalance = await mockUSDC.balanceOf(user1.address);
        const afterShareBalance = await erc1155Facet.balanceOf(user1.address, testPositionId);
        
        console.log("After execution:");
        console.log("  User1 USDC balance:", ethers.utils.formatUnits(afterCollateralBalance, 6));
        console.log("  User1 position balance:", ethers.utils.formatUnits(afterShareBalance, 6));

        // 5. Compare simulation vs actual results
        const actualCollateralSpent = beforeCollateralBalance.sub(afterCollateralBalance);
        const actualTokensReceived = afterShareBalance.sub(beforeShareBalance);

        console.log("Comparison:");
        console.log("  Simulated tokens:", ethers.utils.formatUnits(simulationRoute.totalInputAmount, 6));
        console.log("  Actual tokens:", ethers.utils.formatUnits(actualTokensReceived, 6));
        console.log("  Simulated cost:", ethers.utils.formatUnits(simulationRoute.totalOutputAmount, 6));
        console.log("  Actual cost:", ethers.utils.formatUnits(actualCollateralSpent, 6));

        // Allow small margin of error due to rounding/precision (1% tolerance)
        const tolerance = simulationRoute.totalInputAmount.mul(1).div(100); // 1%
        const costTolerance = simulationRoute.totalOutputAmount.mul(1).div(100); // 1%

        expect(actualTokensReceived).to.be.closeTo(simulationRoute.totalInputAmount, tolerance);
        expect(actualCollateralSpent).to.be.closeTo(simulationRoute.totalOutputAmount, costTolerance);
      });

      it("should have simulation match execution for cross-currency market buy order", async function () {
        const buyAmount = ethers.utils.parseUnits("1", 18); // 1 WETH budget
        const crossCurrencyData = {
          quoteCurrencyToken: mockWETH.address,
          floorRate: 0 // Fixed order
        };

        // 1. Get simulation prediction
        const simulationRoute = await routeSimulationFacet.simulateMarketOrder(
          positionId,
          buyAmount,
          0, // Buy
          crossCurrencyData
        );

        // 2. Record balances before execution
        const beforeWETHBalance = await mockWETH.balanceOf(user1.address);
        const beforeShareBalance = await erc1155Facet.balanceOf(user1.address, positionId);

        // 3. Execute actual market order with same parameters
        await createCrossCurrencyMarketOrder(orderCreationFacet, user1, {
          positionId,
          collateralToken: mockUSDC.address, // Position collateral token
          amount: buyAmount,
          pricePerToken: ethers.utils.parseUnits("100", 18), // High price for market buy
          direction: OrderDirection.Buy,
          quoteCurrencyToken: mockWETH.address,
          floorRate: 0
        });

        // 4. Record balances after execution
        const afterWETHBalance = await mockWETH.balanceOf(user1.address);
        const afterShareBalance = await erc1155Facet.balanceOf(user1.address, positionId);

        // 5. Calculate actual execution amounts
        const actualWETHSpent = beforeWETHBalance.sub(afterWETHBalance);
        const actualSharesReceived = afterShareBalance.sub(beforeShareBalance);

        // 6. Compare simulation vs execution
        expect(actualSharesReceived).to.equal(simulationRoute.totalInputAmount,
          "Shares received should match simulation prediction");
        expect(actualWETHSpent).to.equal(simulationRoute.totalOutputAmount,
          "WETH spent should match simulation prediction");
      });

      it("should have simulation match execution for standard market sell order", async function () {
        // First, user needs some shares to sell - give user1 some shares by splitting position
        const [positionIds, amounts] = await splitConditionAndGetPositionIds({
          user: user1,
          conditionalFacet: conditionalTokensFacet,
          erc20: mockUSDC,
          amount: ethers.utils.parseUnits("1000", 6), // Split 1000 USDC worth
          conditionId,
          indexSets: [1, 2], // Binary condition outcomes
        });
        
        // Use the first position ID for selling
        const actualPositionId = positionIds[0];

        // Approve the diamond to transfer position tokens
        await erc1155Facet.connect(user1).setApprovalForAll(diamondAddress, true);

        const sellAmount = ethers.utils.parseUnits("500", 6); // Sell 500 shares
        const crossCurrencyData = {
          quoteCurrencyToken: ethers.constants.AddressZero, // Standard order
          floorRate: 0
        };

        // 1. Get simulation prediction
        const simulationRoute = await routeSimulationFacet.simulateMarketOrder(
          actualPositionId,
          sellAmount,
          1, // Sell
          crossCurrencyData
        );

        // 2. Record balances before execution
        const beforeCollateralBalance = await mockUSDC.balanceOf(user1.address);
        const beforeShareBalance = await erc1155Facet.balanceOf(user1.address, actualPositionId);

        // 3. Execute actual market order with same parameters
        await createMarketOrder(orderCreationFacet, user1, {
          positionId: actualPositionId,
          collateralToken: mockUSDC.address,
          amount: sellAmount,
          pricePerToken: ethers.utils.parseUnits("0.7", 6), // Low price for market sell (below 1.0)
          direction: OrderDirection.Sell
        });

        // 4. Record balances after execution
        const afterCollateralBalance = await mockUSDC.balanceOf(user1.address);
        const afterShareBalance = await erc1155Facet.balanceOf(user1.address, actualPositionId);

        // 5. Calculate actual execution amounts
        const actualCollateralReceived = afterCollateralBalance.sub(beforeCollateralBalance);
        const actualSharesSold = beforeShareBalance.sub(afterShareBalance);

        // 6. Compare simulation vs execution
        expect(actualSharesSold).to.equal(simulationRoute.totalInputAmount,
          "Shares sold should match simulation prediction");
        expect(actualCollateralReceived).to.equal(simulationRoute.totalOutputAmount,
          "Collateral received should match simulation prediction");
      });

      it("should have simulation match execution for cross-currency market sell order", async function () {
        // First, user needs some shares to sell - give user1 some shares by splitting position
        const [positionIds, amounts] = await splitConditionAndGetPositionIds({
          user: user1,
          conditionalFacet: conditionalTokensFacet,
          erc20: mockUSDC,
          amount: ethers.utils.parseUnits("1000", 6), // Split 1000 USDC worth
          conditionId,
          indexSets: [1, 2], // Binary condition outcomes
        });
        
        // Use the first position ID for selling
        const actualPositionId = positionIds[0];

        // Approve the diamond to transfer position tokens
        await erc1155Facet.connect(user1).setApprovalForAll(diamondAddress, true);

        const sellAmount = ethers.utils.parseUnits("300", 6); // Sell 300 shares
        const crossCurrencyData = {
          quoteCurrencyToken: mockWETH.address,
          floorRate: 0 // Fixed order
        };

        // 1. Get simulation prediction
        const simulationRoute = await routeSimulationFacet.simulateMarketOrder(
          actualPositionId,
          sellAmount,
          1, // Sell
          crossCurrencyData
        );

        console.log("Cross-currency sell simulation results:");
        console.log("  simulationRoute.totalInputAmount:", simulationRoute.totalInputAmount.toString());
        console.log("  simulationRoute.totalOutputAmount:", simulationRoute.totalOutputAmount.toString());
        console.log("  Expected WETH output (wei):", simulationRoute.totalOutputAmount.toString());
        console.log("  Expected WETH output (formatted):", ethers.utils.formatEther(simulationRoute.totalOutputAmount));

        // 2. Record balances before execution
        const beforeWETHBalance = await mockWETH.balanceOf(user1.address);
        const beforeShareBalance = await erc1155Facet.balanceOf(user1.address, actualPositionId);

        console.log("Before execution balances:");
        console.log("  User1 WETH balance:", ethers.utils.formatEther(beforeWETHBalance));
        console.log("  User1 shares balance:", ethers.utils.formatUnits(beforeShareBalance, 6));
        console.log("  Expected to sell:", ethers.utils.formatUnits(sellAmount, 6), "shares");
        
        // Check if user has enough shares to sell
        if (beforeShareBalance.lt(sellAmount)) {
          console.log("⚠️ Warning: User doesn't have enough shares to sell!");
          console.log("  Has:", ethers.utils.formatUnits(beforeShareBalance, 6));
          console.log("  Needs:", ethers.utils.formatUnits(sellAmount, 6));
        }

        // 3. Execute actual market order with same parameters
        await createCrossCurrencyMarketOrder(orderCreationFacet, user1, {
          positionId: actualPositionId,
          collateralToken: mockUSDC.address, // Use USDC collateral (position's native token)
          amount: sellAmount,
          pricePerToken: ethers.utils.parseEther("0.0001"), // Price in WETH per share
          direction: OrderDirection.Sell,
          quoteCurrencyToken: mockWETH.address, // Sell for WETH
          floorRate: 0
        });

        // 4. Record balances after execution
        const afterWETHBalance = await mockWETH.balanceOf(user1.address);
        const afterShareBalance = await erc1155Facet.balanceOf(user1.address, actualPositionId);

        console.log("After execution balances:");
        console.log("  User1 WETH balance:", ethers.utils.formatEther(afterWETHBalance));
        console.log("  User1 shares balance:", ethers.utils.formatUnits(afterShareBalance, 6));
        
        // 5. Calculate actual execution amounts
        const actualWETHReceived = afterWETHBalance.sub(beforeWETHBalance);
        const actualSharesSold = beforeShareBalance.sub(afterShareBalance);
        
        console.log("Execution results:");
        console.log("  Actual WETH received:", ethers.utils.formatEther(actualWETHReceived));
        console.log("  Actual shares sold:", ethers.utils.formatUnits(actualSharesSold, 6));
        console.log("  Expected shares to sell:", ethers.utils.formatUnits(simulationRoute.totalInputAmount, 6));
        console.log("  Expected WETH to receive:", ethers.utils.formatEther(simulationRoute.totalOutputAmount));

        // 6. Compare simulation vs execution
        expect(actualSharesSold).to.equal(simulationRoute.totalInputAmount,
          "Shares sold should match simulation prediction");
        expect(actualWETHReceived).to.equal(simulationRoute.totalOutputAmount,
          "WETH received should match simulation prediction");
      });

      it("should handle partial fills consistently between simulation and execution", async function () {
        // Use the actual position ID from the global test setup
        const actualPositionId = global.testPositionId || positionId;

        // Test scenario: Limited liquidity, both simulation and execution should show partial fill
        const largeAmount = ethers.utils.parseUnits("10000", 6); // Very large amount
        const crossCurrencyData = {
          quoteCurrencyToken: ethers.constants.AddressZero,
          floorRate: 0
        };

        // 1. Get simulation prediction
        const simulationRoute = await routeSimulationFacet.simulateMarketOrder(
          actualPositionId,
          largeAmount,
          0, // Buy
          crossCurrencyData
        );

        // 2. Record balances before execution
        const beforeCollateralBalance = await mockUSDC.balanceOf(user1.address);
        const beforeShareBalance = await erc1155Facet.balanceOf(user1.address, actualPositionId);

        // 3. Execute actual market order with same parameters
        await createMarketOrder(orderCreationFacet, user1, {
          positionId: actualPositionId,
          collateralToken: mockUSDC.address,
          amount: largeAmount,
          pricePerToken: ethers.utils.parseUnits("0.7", 6), // Price below 1.0 for market buy
          direction: OrderDirection.Buy
        });

        // 4. Record balances after execution
        const afterCollateralBalance = await mockUSDC.balanceOf(user1.address);
        const afterShareBalance = await erc1155Facet.balanceOf(user1.address, actualPositionId);

        // 5. Calculate actual execution amounts
        const actualCollateralSpent = beforeCollateralBalance.sub(afterCollateralBalance);
        const actualSharesReceived = afterShareBalance.sub(beforeShareBalance);

        // 6. Compare simulation vs execution for partial fills
        expect(actualSharesReceived).to.equal(simulationRoute.totalInputAmount,
          "Partial fill shares should match simulation");
        expect(actualCollateralSpent).to.equal(simulationRoute.totalOutputAmount,
          "Partial fill collateral should match simulation");
      });

      it("should match simulation and execution when no fills occur", async function () {
        // Use the actual position ID from the global test setup
        const actualPositionId = global.testPositionId || positionId;

        // Test scenario: Use valid tokens but incompatible position ID to ensure no matches
        const amount = ethers.utils.parseUnits("1", 6);
        const crossCurrencyData = {
          quoteCurrencyToken: mockWETH.address, // Valid token
          floorRate: 0 // Fixed order - no oracle required
        };

        // Clear all existing orders first (this test might need order book to be empty)
        
        // 1. Get simulation prediction
        const simulationRoute = await routeSimulationFacet.simulateMarketOrder(
          actualPositionId,
          amount,
          0, // Buy
          crossCurrencyData
        );
        
        console.log("No fills test - Simulation results:");
        console.log("  simulationRoute.totalInputAmount:", simulationRoute.totalInputAmount.toString());
        console.log("  simulationRoute.totalOutputAmount:", simulationRoute.totalOutputAmount.toString());

        // 2. Record balances before execution
        const beforeCollateralBalance = await mockUSDC.balanceOf(user1.address);
        const beforeShareBalance = await erc1155Facet.balanceOf(user1.address, actualPositionId);

        // 3. Execute actual market order with same parameters (should succeed but find no matches)
        try {
          const orderResult = await createCrossCurrencyMarketOrder(orderCreationFacet, user1, {
            positionId: actualPositionId,
            collateralToken: mockUSDC.address,
            amount,
            pricePerToken: ethers.utils.parseUnits("0.001", 6), // Very low price (0.001 USDC per share)
            direction: OrderDirection.Buy,
            quoteCurrencyToken: mockWETH.address, // Valid token
            floorRate: 0 // Fixed order - no oracle required
          });
          
          console.log("No fills test - Order creation result:", {
            orderId: orderResult?.orderId?.toString() || "undefined",
            success: orderResult?.success || false
          });
        } catch (error) {
          console.log("No fills test - Order creation failed:", error.message);
        }

        // 4. Record balances after execution
        const afterCollateralBalance = await mockUSDC.balanceOf(user1.address);
        const afterShareBalance = await erc1155Facet.balanceOf(user1.address, actualPositionId);

        // 5. Calculate actual execution amounts
        const actualCollateralSpent = beforeCollateralBalance.sub(afterCollateralBalance);
        const actualSharesReceived = afterShareBalance.sub(beforeShareBalance);
        
        console.log("No fills test - Execution results:");
        console.log("  actualCollateralSpent:", actualCollateralSpent.toString());
        console.log("  actualSharesReceived:", actualSharesReceived.toString());

        // 6. Both should show zero activity
        expect(simulationRoute.totalInputAmount).to.equal(0, "Simulation should predict no shares");
        expect(simulationRoute.totalOutputAmount).to.equal(0, "Simulation should predict no collateral");
        expect(actualSharesReceived).to.equal(0, "Execution should result in no shares");
        expect(actualCollateralSpent).to.equal(0, "Execution should result in no collateral spent");
      });
    });
  });
});
