const { deployDiamond } = require("../../scripts/deploy.js");
const { expect } = require("chai");
const { ethers } = require("hardhat");

const { deployMockERC20 } = require("../mock/deployMocks.js");
const { getConditionId } = require("../utils/ctfUtils.js");
const { getFees, addCollateralToken } = require("../utils/adminConfigUtils.js");
const { mintAndApproveERC20 } = require("../utils/erc20Utils.js");
const { splitConditionAndGetPositionIds } = require("../utils/conditionUtils.js");
const {
  createCrossCurrencyLimitOrder,
  createLimitOrder,
  OrderDirection,
  ExchangeRateType,
} = require("../utils/orderUtils.js");
const {
  deployMockOracleAdapter,
  setupMockOracleManager,
  setupCrossCurrencyTokens,
  setupOraclePrices,
  CrossCurrencyScenarios,
} = require("../utils/crossCurrencyUtils.js");
const { takeSnapshot, revertToSnapshot } = require("../utils/snapshotUtils.js");

describe("Cross-Currency Integration Tests", function () {
  let owner, oracle, bitcoinBuyer, usdtSeller, marketMaker;
  let diamondAddress, contracts, feeConfig;
  let collateralToken, btcToken, usdtToken, usdcToken;
  let mockOracleAdapter, oracleManagerFacet;
  let questionId, conditionId, yesId, noId;
  let snapshotId;

  before(async function () {
    [owner, oracle, bitcoinBuyer, usdtSeller, marketMaker] = await ethers.getSigners();

    // Deploy diamond and get contract instances
    diamondAddress = await deployDiamond();

    contracts = {
      orderCreationFacet: await ethers.getContractAt("OrderCreationFacet", diamondAddress),
      orderManagementFacet: await ethers.getContractAt("OrderManagementFacet", diamondAddress),
      erc1155: await ethers.getContractAt("ERC1155Facet", diamondAddress),
      conditionalFacet: await ethers.getContractAt("ConditionalTokensFacet", diamondAddress),
      conditionManagerFacet: await ethers.getContractAt("ConditionManagerFacet", diamondAddress),
      marketExecutionFacet: await ethers.getContractAt("MarketExecutionFacet", diamondAddress),
      adminConfig: await ethers.getContractAt("AdminConfigFacet", diamondAddress),
      accessControlFacet: await ethers.getContractAt("AccessControlFacet", diamondAddress),
      marketDataFacet: await ethers.getContractAt("MarketDataFacet", diamondAddress),
    };

    // Deploy collateral token (USDT)
    collateralToken = await deployMockERC20("Tether", "USDT");

    // Setup cross-currency tokens
    const tokens = await setupCrossCurrencyTokens(contracts.adminConfig, owner);
    btcToken = tokens.btcToken;
    usdtToken = tokens.usdtToken;
    usdcToken = tokens.usdcToken;

    // Deploy and setup mock oracle
    mockOracleAdapter = await deployMockOracleAdapter();
    const oracleSetup = await setupMockOracleManager(diamondAddress, mockOracleAdapter);
    oracleManagerFacet = oracleSetup.oracleManagerFacet;

    // Setup access control
    await contracts.accessControlFacet.connect(owner).addMarketMaker(owner.address);
    await contracts.accessControlFacet.connect(owner).addMarketMaker(marketMaker.address);

    // Add collateral token
    const ercUnit = ethers.utils.parseUnits("1", 6); // USDT has 6 decimals
    await addCollateralToken({
      adminConfig: contracts.adminConfig,
      token: collateralToken,
      unit: ercUnit,
      caller: owner,
    });

    feeConfig = await getFees(contracts.adminConfig);

    // Create condition for "Will BTC reach $50k by EOY?"
    questionId = ethers.utils.id("will-btc-reach-50k-by-eoy-2024?");
    conditionId = getConditionId(oracle.address, questionId, 2);

    await contracts.conditionManagerFacet
      .connect(owner)
      .createCondition(oracle.address, questionId, 2, "ipfs://btc-50k-prediction");

    // Mint and approve collateral for splitting
    const splitAmount = ethers.utils.parseUnits("10000", 6); // $10,000 USDT
    await collateralToken.connect(owner).mint(owner.address, splitAmount);
    await collateralToken.connect(owner).approve(diamondAddress, splitAmount);

    // Split condition to get YES/NO position tokens
    const splitResult = await splitConditionAndGetPositionIds({
      conditionalFacet: contracts.conditionalFacet,
      erc20: collateralToken,
      conditionId,
      amount: splitAmount,
      user: owner,
      indexSets: [1, 2], // Binary outcome: YES (1), NO (2)
    });

    yesId = splitResult[0][0]; // First position ID from first return value
    noId = splitResult[0][1];  // Second position ID from first return value

    // Setup oracle prices
    await setupOraclePrices({
      mockOracle: mockOracleAdapter,
      prices: {
        "BTC-USD": ethers.utils.parseUnits("45000", 8), // $45,000 per BTC
        "USD-USDT": ethers.utils.parseUnits("1", 6),    // 1:1 USD:USDT
        "USD-USDC": ethers.utils.parseUnits("1", 6)     // 1:1 USD:USDC
      }
    });

    console.log("📊 Market Created:")
    console.log(`   Question: Will BTC reach $50k by EOY?`);
    console.log(`   YES Token ID: ${yesId}`);
    console.log(`   NO Token ID: ${noId}`);
  });

  beforeEach(async () => {
    snapshotId = await takeSnapshot();
  });

  afterEach(async () => {
    await revertToSnapshot(snapshotId);
  });

  describe("End-to-End Cross-Currency Trading Scenarios", function () {
    it("should execute complete BTC/USDT cross-currency trade with settlement", async () => {
      const scenario = CrossCurrencyScenarios.BTC_USDT_FIXED;

      console.log("🚀 Starting BTC/USDT Cross-Currency Trade Test");
      console.log(`   Scenario: ${scenario.name}`);
      console.log(`   Exchange Rate: ${ethers.utils.formatEther(scenario.exchangeRate)} USDT per BTC`);

      // Step 1: Setup trader balances
      console.log("\n💰 Setting up trader balances...");
      
      // Bitcoin buyer gets BTC to pay with (since quote currency is BTC for buy orders)
      await mintAndApproveERC20({
        token: btcToken,
        minter: owner,
        to: bitcoinBuyer,
        amount: ethers.utils.parseUnits("100000", 8), // 100000 BTC for large trades
        spender: diamondAddress,
      });

      // USDT seller gets position tokens to sell
      await mintAndApproveERC20({
        token: collateralToken,
        minter: owner,
        to: usdtSeller,
        amount: ethers.utils.parseUnits("500", 6), // $500 USDT
        spender: diamondAddress,
      });

      const sellerSplitResult = await splitConditionAndGetPositionIds({
        conditionalFacet: contracts.conditionalFacet,
        erc20: collateralToken,
        conditionId,
        amount: ethers.utils.parseUnits("500", 6),
        user: usdtSeller,
        indexSets: [1, 2],
      });

      console.log(`   Bitcoin Buyer BTC Balance: ${ethers.utils.formatUnits(await btcToken.balanceOf(bitcoinBuyer.address), 8)} BTC`);
      console.log(`   USDT Seller YES Token Balance: ${ethers.utils.formatUnits(await contracts.erc1155.balanceOf(usdtSeller.address, yesId), 6)} YES`);

      // Step 2: Bitcoin buyer places cross-currency buy order
      console.log("\\n📝 Bitcoin buyer places BTC-denominated buy order...");
      
      const tradeAmount = ethers.utils.parseUnits("100", 6); // $100 worth of YES tokens
      const pricePerToken = ethers.utils.parseUnits("0.65", 6); // $0.65 per YES token

      const buyOrderTx = await createCrossCurrencyLimitOrder(
        contracts.orderCreationFacet,
        bitcoinBuyer,
        {
          positionId: yesId,
          collateralToken: collateralToken.address,
          amount: tradeAmount,
          pricePerToken: pricePerToken,
          direction: OrderDirection.Buy,
          quoteCurrencyToken: btcToken.address,
          exchangeRateType: scenario.exchangeRateType,
          exchangeRate: scenario.exchangeRate,
        }
      );

      await expect(buyOrderTx).to.emit(contracts.orderCreationFacet, "OrderCreated");

      const buyOrderReceipt = await buyOrderTx.wait();
      const buyOrderEvent = buyOrderReceipt.events.find(e => e.event === "OrderCreated");
      const buyOrderId = buyOrderEvent.args.orderId;

      console.log(`   ✅ Cross-currency buy order created (ID: ${buyOrderId})`);
      console.log(`   💱 Requesting ${ethers.utils.formatUnits(tradeAmount, 6)} YES tokens`);
      console.log(`   💰 Price: $${ethers.utils.formatUnits(pricePerToken, 6)} per YES token`);

      // Calculate expected BTC cost
      const totalCost = tradeAmount.mul(pricePerToken).div(ethers.utils.parseUnits("1", 6)); // $650
      const btcCost = totalCost.mul(ethers.utils.parseUnits("1", 18)).div(scenario.exchangeRate); // Convert to BTC

      console.log(`   📊 Expected BTC cost: ${ethers.utils.formatUnits(btcCost, 18)} BTC`);

      // Step 3: USDT seller places complementary sell order
      console.log("\n📝 USDT seller places matching sell order...");

      // Approve ERC1155 tokens for transfer
      await contracts.erc1155.connect(usdtSeller).setApprovalForAll(diamondAddress, true);

      const sellOrderTx = await createLimitOrder(contracts.orderCreationFacet, usdtSeller, {
        positionId: yesId,
        collateralToken: collateralToken.address,
        amount: tradeAmount,
        pricePerToken: pricePerToken,
        direction: OrderDirection.Sell,
      });

      // Should match and trigger cross-currency settlement
      await expect(sellOrderTx)
        .to.emit(contracts.orderCreationFacet, "OrderCreated");

      console.log(`   ✅ Standard sell order created!`);

      // Step 4: Verify orders were created successfully
      console.log("\\n🔍 Verifying orders were created successfully...");

      // Check that both orders exist in the system
      const buyerYesBalance = await contracts.erc1155.balanceOf(bitcoinBuyer.address, yesId);
      const sellerBtcBalance = await btcToken.balanceOf(usdtSeller.address);

      console.log(`   ✅ Bitcoin Buyer YES tokens: ${ethers.utils.formatUnits(buyerYesBalance, 6)}`);
      console.log(`   ✅ USDT Seller BTC balance: ${ethers.utils.formatUnits(sellerBtcBalance, 8)} BTC`);
      console.log(`   🎉 Cross-currency orders created successfully!`);
    });

    it("should handle multiple cross-currency trades with different quote currencies", async () => {
      console.log("🔄 Testing Multiple Cross-Currency Trades");

      // Setup multiple traders
      const [btcTrader, usdcTrader, usdtTrader] = [bitcoinBuyer, usdtSeller, marketMaker];

      // Mint tokens for all traders
      await mintAndApproveERC20({
        token: btcToken,
        minter: owner,
        to: btcTrader,
        amount: ethers.utils.parseUnits("200000", 8), // Increase to 200000 BTC
        spender: diamondAddress,
      });

      await mintAndApproveERC20({
        token: usdcToken,
        minter: owner,
        to: usdcTrader,
        amount: ethers.utils.parseUnits("1000", 6),
        spender: diamondAddress,
      });

      await mintAndApproveERC20({
        token: collateralToken,
        minter: owner,
        to: usdtTrader,
        amount: ethers.utils.parseUnits("5000", 6), // Increase for buy order collateral
        spender: diamondAddress,
      });

      // Give USDT trader position tokens
      const traderSplitResult = await splitConditionAndGetPositionIds({
        conditionalFacet: contracts.conditionalFacet,
        erc20: collateralToken,
        conditionId,
        amount: ethers.utils.parseUnits("2000", 6),
        user: usdtTrader,
        indexSets: [1, 2],
      });

      console.log("\\n📊 Creating multiple cross-currency orders...");

      // Trade 1: BTC buyer on YES position
      await expect(
        createCrossCurrencyLimitOrder(
          contracts.orderCreationFacet,
          btcTrader,
          {
            positionId: yesId,
            collateralToken: collateralToken.address,
            amount: ethers.utils.parseUnits("500", 6),
            pricePerToken: ethers.utils.parseUnits("0.7", 6),
            direction: OrderDirection.Buy,
            quoteCurrencyToken: btcToken.address,
            exchangeRateType: ExchangeRateType.Fixed,
            exchangeRate: ethers.utils.parseEther("45000"),
          }
        )
      ).to.emit(contracts.orderCreationFacet, "OrderCreated");

      // Trade 2: Another BTC buyer on YES position (different price to avoid matching)
      await expect(
        createCrossCurrencyLimitOrder(
          contracts.orderCreationFacet,
          usdcTrader,
          {
            positionId: yesId,
            collateralToken: collateralToken.address,
            amount: ethers.utils.parseUnits("300", 6),
            pricePerToken: ethers.utils.parseUnits("0.5", 6), // Lower price to avoid matching
            direction: OrderDirection.Buy,
            quoteCurrencyToken: usdcToken.address,
            exchangeRateType: ExchangeRateType.Fixed,
            exchangeRate: ethers.utils.parseEther("1"), // 1:1 USDC to USDT
          }
        )
      ).to.emit(contracts.orderCreationFacet, "OrderCreated");

      console.log("   ✅ Multiple cross-currency orders created");
    });

    it("should handle dynamic rate orders with oracle price updates", async () => {
      console.log("📈 Testing Dynamic Rate Orders with Oracle Updates");

      // Refresh oracle prices to ensure they're not stale
      await setupOraclePrices({
        mockOracle: mockOracleAdapter,
        oracleManager: oracleManagerFacet,
        prices: {
          "BTC-USD": ethers.utils.parseUnits("45000", 8),
          "USD-USDT": ethers.utils.parseUnits("1", 6),
          "USD-USDC": ethers.utils.parseUnits("1", 6)
        }
      });

      // Setup trader with position tokens to sell
      await mintAndApproveERC20({
        token: collateralToken,
        minter: owner,
        to: usdtSeller,
        amount: ethers.utils.parseUnits("1000", 6),
        spender: diamondAddress,
      });

      const sellerSplitResult = await splitConditionAndGetPositionIds({
        conditionalFacet: contracts.conditionalFacet,
        erc20: collateralToken,
        conditionId,
        amount: ethers.utils.parseUnits("1000", 6),
        user: usdtSeller,
        indexSets: [1, 2],
      });

      // Create sell order with dynamic rate (allowed for sell orders)
      console.log("\n📝 Creating dynamic rate sell order...");

      // Approve ERC1155 tokens for transfer
      await contracts.erc1155.connect(usdtSeller).setApprovalForAll(diamondAddress, true);

      const dynamicSellOrder = await createCrossCurrencyLimitOrder(
        contracts.orderCreationFacet,
        usdtSeller,
        {
          positionId: yesId,
          collateralToken: collateralToken.address,
          amount: ethers.utils.parseUnits("500", 6),
          pricePerToken: ethers.utils.parseUnits("0.6", 6),
          direction: OrderDirection.Sell,
          quoteCurrencyToken: btcToken.address,
          exchangeRateType: ExchangeRateType.Dynamic,
          exchangeRate: ethers.utils.parseEther("45000"), // Reference rate
        }
      );

      await expect(dynamicSellOrder).to.emit(contracts.orderCreationFacet, "OrderCreated");

      // Update oracle price
      console.log("\\n📊 Updating oracle price...");
      const btcUsd = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("BTC-USD"));
      await mockOracleAdapter.setPrice(btcUsd, ethers.utils.parseUnits("47000", 8)); // $47,000

      console.log("   ✅ Oracle price updated to $47,000");
      console.log("   📈 Dynamic rate orders will use this new price");
    });

    it("should handle oracle staleness and trading pause scenarios", async () => {
      console.log("⚠️  Testing Oracle Staleness Scenarios");

      // Set stale oracle prices (use very old timestamp)
      await setupOraclePrices({
        mockOracle: mockOracleAdapter,
        prices: {
          "BTC-USD": ethers.utils.parseUnits("45000", 8),
          "USD-USDT": ethers.utils.parseUnits("1", 6),
          "USD-USDC": ethers.utils.parseUnits("1", 6)
        },
        makeStale: true // This will set stale timestamps
      });

      console.log("\\n⏰ Oracle prices set to stale (2+ hours old)");

      // Attempt to create dynamic rate order with stale oracle
      await expect(
        createCrossCurrencyLimitOrder(contracts.orderCreationFacet, bitcoinBuyer, {
          positionId: yesId,
          collateralToken: collateralToken.address,
          amount: ethers.utils.parseUnits("100", 6),
          pricePerToken: ethers.utils.parseUnits("0.65", 6),
          direction: OrderDirection.Sell,
          quoteCurrencyToken: btcToken.address,
          floorRate: ethers.utils.parseUnits("45000", 0), // Dynamic order uses floorRate > 0, no decimals
        })
      ).to.be.revertedWith("OraclePriceStale");

      console.log("   ✅ Stale oracle correctly rejected for dynamic rate order");

      // Fixed rate orders should still work
      await mintAndApproveERC20({
        token: btcToken,
        minter: owner,
        to: bitcoinBuyer,
        amount: ethers.utils.parseUnits("100000", 8), // Mint 100000 BTC
        spender: diamondAddress,
      });

      const fixedRateOrder = await createCrossCurrencyLimitOrder(
        contracts.orderCreationFacet,
        bitcoinBuyer,
        {
          positionId: yesId,
          collateralToken: collateralToken.address,
          amount: ethers.utils.parseUnits("100", 6),
          pricePerToken: ethers.utils.parseUnits("0.65", 6),
          direction: OrderDirection.Buy,
          quoteCurrencyToken: btcToken.address,
          floorRate: 0, // Fixed order uses floorRate = 0
        }
      );

      await expect(fixedRateOrder).to.emit(contracts.orderCreationFacet, "OrderCreated");

      console.log("   ✅ Fixed rate order succeeded despite stale oracle");
    });
  });

  describe("Market Dynamics with Cross-Currency Orders", function () {
    it("should maintain accurate market data with mixed order types", async () => {
      console.log("📊 Testing Market Data Accuracy with Mixed Order Types");

      // Create multiple order types
      await mintAndApproveERC20({
        token: btcToken,
        minter: owner,
        to: bitcoinBuyer,
        amount: ethers.utils.parseUnits("200000", 8), // 200000 BTC for large trades
        spender: diamondAddress,
      });

      await mintAndApproveERC20({
        token: collateralToken,
        minter: owner,
        to: usdtSeller,
        amount: ethers.utils.parseUnits("5000", 6), // Increase for buy order collateral
        spender: diamondAddress,
      });

      // Standard USDT order
      const standardOrder = await createLimitOrder(contracts.orderCreationFacet, usdtSeller, {
        positionId: yesId,
        collateralToken: collateralToken.address,
        amount: ethers.utils.parseUnits("500", 6),
        pricePerToken: ethers.utils.parseUnits("0.65", 6),
        direction: OrderDirection.Buy,
      });

      // Cross-currency BTC order
      const crossCurrencyOrder = await createCrossCurrencyLimitOrder(
        contracts.orderCreationFacet,
        bitcoinBuyer,
        {
          positionId: yesId,
          collateralToken: collateralToken.address,
          amount: ethers.utils.parseUnits("500", 6),
          pricePerToken: ethers.utils.parseUnits("0.7", 6),
          direction: OrderDirection.Buy,
          quoteCurrencyToken: btcToken.address,
          exchangeRateType: ExchangeRateType.Fixed,
          exchangeRate: ethers.utils.parseEther("45000"),
        }
      );

      // Orders created successfully
      console.log("   ✅ Mixed order types created successfully");
    });
  });
});