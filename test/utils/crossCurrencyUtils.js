const { ethers } = require("hardhat");
const { OrderDirection, ExecutionType } = require("./orderUtils.js");

/**
 * Cross-currency testing utilities
 */

/**
 * Deploy MockOracleAdapter for testing
 */
async function deployMockOracleAdapter() {
  const MockOracleAdapter = await ethers.getContractFactory("MockOracleAdapter");
  const mockOracle = await MockOracleAdapter.deploy();
  await mockOracle.deployed();
  return mockOracle;
}

/**
 * Setup Oracle Manager with mock adapter for testing
 */
async function setupMockOracleManager(diamondAddress, mockOracle) {
  const oracleManagerFacet = await ethers.getContractAt(
    "OracleManagerFacet",
    diamondAddress
  );

  // Register mock adapter
  const adapterId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("MockOracleV1"));
  const maxStaleness = 3600; // 1 hour

  console.log("🔧 Registering oracle adapter...");
  await oracleManagerFacet.registerAdapter(
    adapterId,
    mockOracle.address,
    maxStaleness
  );
  console.log("✅ Oracle adapter registered");

  // Configure assets with mock adapter priority
  const btcUsd = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("BTC-USD"));
  const usdUsdc = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("USD-USDC"));
  const usdUsdt = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("USD-USDT"));

  console.log("🔧 Configuring BTC-USD asset...");
  await oracleManagerFacet.configureAsset(btcUsd, [adapterId], maxStaleness, 8); // BTC prices have 8 decimals
  console.log("✅ BTC-USD configured");
  
  console.log("🔧 Configuring USD-USDC asset...");
  await oracleManagerFacet.configureAsset(usdUsdc, [adapterId], maxStaleness, 6); // USD-USDC prices have 6 decimals
  console.log("✅ USD-USDC configured");
  
  console.log("🔧 Configuring USD-USDT asset...");
  await oracleManagerFacet.configureAsset(usdUsdt, [adapterId], maxStaleness, 6); // USD-USDT prices have 6 decimals
  console.log("✅ USD-USDT configured");

  return { oracleManagerFacet, adapterId, assets: { btcUsd, usdUsdc, usdUsdt } };
}

/**
 * Setup cross-currency tokens (BTC, USDT, USDC)
 */
async function setupCrossCurrencyTokens(adminConfig, owner) {
  const { deployMockERC20 } = require("../mock/deployMocks.js");
  
  // Deploy quote currency tokens with correct decimals
  const btcToken = await deployMockERC20("Bitcoin", "BTC", 8); // BTC has 8 decimals
  const usdtToken = await deployMockERC20("Tether", "USDT", 6); // USDT has 6 decimals
  const usdcToken = await deployMockERC20("USD Coin", "USDC", 6); // USDC has 6 decimals

  // Add tokens as allowed collateral
  const btcUnit = ethers.utils.parseUnits("1", 8); // 1 BTC = 10^8 units
  const usdtUnit = ethers.utils.parseUnits("1", 6); // 1 USDT = 10^6 units
  const usdcUnit = ethers.utils.parseUnits("1", 6); // 1 USDC = 10^6 units

  await adminConfig.connect(owner).addCollateralToken(btcToken.address, btcUnit);
  await adminConfig.connect(owner).addCollateralToken(usdtToken.address, usdtUnit);
  await adminConfig.connect(owner).addCollateralToken(usdcToken.address, usdcUnit);

  return { btcToken, usdtToken, usdcToken };
}

/**
 * Create cross-currency order data
 */
function createCrossCurrencyData({
  quoteCurrencyToken,
  floorRate = 0,
}) {
  return {
    quoteCurrencyToken,
    floorRate,
  };
}

/**
 * Calculate expected quote currency amount for cross-currency orders
 */
function calculateQuoteCurrencyAmount(amount, pricePerToken, exchangeRate) {
  // amount * pricePerToken / exchangeRate
  const collateralValue = amount.mul(pricePerToken);
  return collateralValue.div(exchangeRate);
}

/**
 * Setup mock oracle prices for testing scenarios
 */
async function setupOraclePrices({ mockOracle, prices, owner = null, oracleManager = null }) {
  // Set prices on the mock oracle first
  const oracleContract = owner ? mockOracle.connect(owner) : mockOracle;

  for (const [assetKey, price] of Object.entries(prices)) {
    const assetId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(assetKey));
    await oracleContract.setPrice(assetId, price);
    
    // If oracle manager is provided, trigger an update to refresh the cached price
    if (oracleManager && typeof oracleManager.updatePrice === 'function') {
      try {
        await oracleManager.updatePrice(assetId);
      } catch (error) {
        console.log(`Warning: Failed to update price for ${assetKey}:`, error.message);
      }
    }
  }

  return {
    btcUsd: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("BTC-USD")),
    usdUsdc: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("USD-USDC")),
    usdUsdt: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("USD-USDT"))
  };
}

/**
 * Create a complete cross-currency market scenario
 */
async function createCrossCurrencyMarket({
  diamondAddress,
  collateralToken,
  quoteCurrencyToken,
  oracle,
  owner,
  questionId,
  mockOracleAdapter,
  floorRate = 0,
}) {
  const { createCompleteMarket } = require("./marketUtils.js");

  const contracts = {
    exchangeFacet: await ethers.getContractAt("ExchangeFacet", diamondAddress),
    conditionalFacet: await ethers.getContractAt("ConditionalTokensFacet", diamondAddress),
    conditionManagerFacet: await ethers.getContractAt("ConditionManagerFacet", diamondAddress),
  };

  // Setup oracle prices if provided
  if (mockOracleAdapter) {
    await setupOraclePrices(mockOracleAdapter, "default");
  }

  // Create the base market
  const market = await createCompleteMarket({
    ...contracts,
    erc20: collateralToken,
    oracle,
    owner,
    questionId,
    diamondAddress,
  });

  return {
    ...market,
    crossCurrencyData: createCrossCurrencyData({
      quoteCurrencyToken: quoteCurrencyToken.address,
      floorRate,
    }),
  };
}

/**
 * Test scenarios for cross-currency orders
 */
const CrossCurrencyScenarios = {
  BTC_USDT_FIXED: {
    name: "BTC/USDT with Fixed Rate",
    collateral: "BTC",
    quoteCurrency: "USDT", 
    isFixed: true,
    floorRate: 0, // Fixed orders have floorRate = 0
    referenceRate: ethers.utils.parseUnits("96000", 6), // 96,000 USDT per BTC (quote token has 6 decimals)
    exchangeRate: ethers.utils.parseUnits("96000", 6),
  },
  BTC_USDC_FIXED: {
    name: "BTC/USDC with Fixed Rate", 
    collateral: "USDC",
    quoteCurrency: "BTC",
    isFixed: true,
    floorRate: 0, // Fixed orders have floorRate = 0
    referenceRate: ethers.utils.parseUnits("96000", 6), // 96,000 USDC per BTC (quote token has 6 decimals)
    exchangeRate: ethers.utils.parseUnits("96000", 6),
  },
  BTC_USDT_DYNAMIC: {
    name: "BTC/USDT with Dynamic Rate",
    collateral: "USDT", 
    quoteCurrency: "BTC",
    isFixed: false,
    floorRate: ethers.utils.parseUnits("95000", 6), // Minimum rate: 95,000 USDT per BTC (6 decimals)
    referenceRate: ethers.utils.parseUnits("96000", 6), // Reference rate for oracle (6 decimals)
    exchangeRate: ethers.utils.parseUnits("96000", 6),
  },
  USDT_USDC: {
    name: "USDT/USDC with Fixed Rate",
    collateral: "USDC",
    quoteCurrency: "USDT", 
    isFixed: true,
    floorRate: 0, // Fixed orders have floorRate = 0
    referenceRate: ethers.utils.parseUnits("1", 6), // 1:1 rate
    exchangeRate: ethers.utils.parseUnits("1", 6),
  },
};

module.exports = {
  deployMockOracleAdapter,
  setupMockOracleManager,
  setupCrossCurrencyTokens,
  createCrossCurrencyData,
  calculateQuoteCurrencyAmount,
  setupOraclePrices,
  createCrossCurrencyMarket,
  CrossCurrencyScenarios,
};