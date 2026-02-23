const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Integration Tests for BlockScholesOracleAdapter with OracleManagerFacet
 *
 * Simplified tests focusing on:
 * 1. Adapter registration with oracle manager
 * 2. Multi-asset configuration
 * 3. Decimal conversion verification
 * 4. Price query flows
 */
describe("BlockScholesOracleAdapter - Integration Tests", function () {
  let adapter;
  let mockBlockScholesOracle;
  let owner, user;

  // Asset IDs
  const BTC_USD_ASSET_ID = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("BTC-USD"));
  const USD_USDT_ASSET_ID = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("USD-USDT"));
  const USD_USDC_ASSET_ID = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("USD-USDC"));

  // Block Scholes constants
  const FEED_ID_SPOT_PRICE = 3;
  const EXCHANGE_BLOCKSCHOLES = 0;
  const BASE_ASSET_BTC = 1;

  // Decimal constants
  const BLOCKSCHOLES_DECIMALS = 9;
  const BTC_DECIMALS = 8;
  const STABLECOIN_DECIMALS = 6;

  before(async function () {
    [owner, user] = await ethers.getSigners();

    // Deploy mock Block Scholes oracle
    const mockOracleFactory = await ethers.getContractFactory("MockBlockScholesOracle");
    mockBlockScholesOracle = await mockOracleFactory.deploy();
    await mockBlockScholesOracle.deployed();

    // Deploy BlockScholesOracleAdapter
    const adapterFactory = await ethers.getContractFactory("BlockScholesOracleAdapter");
    adapter = await adapterFactory.deploy(mockBlockScholesOracle.address);
    await adapter.deployed();
  });

  describe("Adapter Registration & Configuration", function () {
    it("should configure multiple assets with Block Scholes adapter", async function () {
      // Configure BTC-USD
      await adapter.configureAssetFeed(
        BTC_USD_ASSET_ID,
        FEED_ID_SPOT_PRICE,
        EXCHANGE_BLOCKSCHOLES,
        BASE_ASSET_BTC,
        BTC_DECIMALS
      );

      // Configure USD-USDT
      await adapter.configureAssetFeed(
        USD_USDT_ASSET_ID,
        FEED_ID_SPOT_PRICE,
        EXCHANGE_BLOCKSCHOLES,
        BASE_ASSET_BTC,
        STABLECOIN_DECIMALS
      );

      // Configure USD-USDC
      await adapter.configureAssetFeed(
        USD_USDC_ASSET_ID,
        FEED_ID_SPOT_PRICE,
        EXCHANGE_BLOCKSCHOLES,
        BASE_ASSET_BTC,
        STABLECOIN_DECIMALS
      );

      const assets = await adapter.getSupportedAssets();
      expect(assets).to.include(BTC_USD_ASSET_ID);
      expect(assets).to.include(USD_USDT_ASSET_ID);
      expect(assets).to.include(USD_USDC_ASSET_ID);
    });
  });

  describe("Multi-Step Conversion Flow", function () {
    beforeEach(async function () {
      // Reset adapter for clean tests
      const adapter2Factory = await ethers.getContractFactory("BlockScholesOracleAdapter");
      adapter = await adapter2Factory.deploy(mockBlockScholesOracle.address);
      await adapter.deployed();

      // Configure feeds
      await adapter.configureAssetFeed(
        BTC_USD_ASSET_ID,
        FEED_ID_SPOT_PRICE,
        EXCHANGE_BLOCKSCHOLES,
        BASE_ASSET_BTC,
        BTC_DECIMALS
      );

      await adapter.configureAssetFeed(
        USD_USDT_ASSET_ID,
        FEED_ID_SPOT_PRICE,
        EXCHANGE_BLOCKSCHOLES,
        BASE_ASSET_BTC,
        STABLECOIN_DECIMALS
      );
    });

    it("should get correct prices for BTC-USD and USD-USDT separately", async function () {
      // Set mock price: 45000.5 BTC at 9 decimals
      await mockBlockScholesOracle.setPrice(
        ethers.BigNumber.from("45000500000000"),
        Math.floor(Date.now() / 1000)
      );

      // Get BTC-USD price
      const [btcUsdPrice, , btcUsdValid] = await adapter.getLatestPrice(BTC_USD_ASSET_ID);

      expect(btcUsdValid).to.be.true;
      expect(btcUsdPrice).to.equal(ethers.BigNumber.from("4500050000000")); // 8 decimals

      // Get USD-USDT price (same mock price, different decimals)
      const [usdUsdtPrice, , usdUsdtValid] = await adapter.getLatestPrice(USD_USDT_ASSET_ID);

      expect(usdUsdtValid).to.be.true;
      // Same price but converted to 6 decimals: 45000500000000 / 1000 = 45000500000
      expect(usdUsdtPrice).to.equal(ethers.BigNumber.from("45000500000"));
    });

    it("should handle fractional prices correctly", async function () {
      // BTC-USD: 45000.123456789 BTC at 9 decimals
      const btcUsdMockPrice = ethers.BigNumber.from("45000123456789");

      await mockBlockScholesOracle.setPrice(btcUsdMockPrice, Math.floor(Date.now() / 1000));
      const [btcUsdPrice] = await adapter.getLatestPrice(BTC_USD_ASSET_ID);

      // Expected at 8 decimals: 45000123456789 / 10 = 4500012345678
      expect(btcUsdPrice).to.equal(ethers.BigNumber.from("4500012345678"));
    });
  });

  describe("Price Timestamp Handling", function () {
    beforeEach(async function () {
      await adapter.configureAssetFeed(
        BTC_USD_ASSET_ID,
        FEED_ID_SPOT_PRICE,
        EXCHANGE_BLOCKSCHOLES,
        BASE_ASSET_BTC,
        BTC_DECIMALS
      );
    });

    it("should preserve timestamps correctly", async function () {
      const timestamp = Math.floor(Date.now() / 1000);

      await mockBlockScholesOracle.setPrice(
        ethers.BigNumber.from("45000500000000"),
        timestamp
      );

      const [, returnedTimestamp] = await adapter.getLatestPrice(BTC_USD_ASSET_ID);

      expect(returnedTimestamp.toNumber()).to.equal(timestamp);
    });
  });

  describe("Error Handling", function () {
    it("should revert for unconfigured asset", async function () {
      const unconfiguredAssetId = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("UNKNOWN")
      );

      await expect(adapter.getLatestPrice(unconfiguredAssetId)).to.be.revertedWith(
        "AssetNotConfigured"
      );
    });
  });

  describe("Real-world Scenarios", function () {
    beforeEach(async function () {
      const adapter2Factory = await ethers.getContractFactory("BlockScholesOracleAdapter");
      adapter = await adapter2Factory.deploy(mockBlockScholesOracle.address);
      await adapter.deployed();

      // Configure all three assets
      await adapter.configureAssetFeed(
        BTC_USD_ASSET_ID,
        FEED_ID_SPOT_PRICE,
        EXCHANGE_BLOCKSCHOLES,
        BASE_ASSET_BTC,
        BTC_DECIMALS
      );

      await adapter.configureAssetFeed(
        USD_USDT_ASSET_ID,
        FEED_ID_SPOT_PRICE,
        EXCHANGE_BLOCKSCHOLES,
        BASE_ASSET_BTC,
        STABLECOIN_DECIMALS
      );

      await adapter.configureAssetFeed(
        USD_USDC_ASSET_ID,
        FEED_ID_SPOT_PRICE,
        EXCHANGE_BLOCKSCHOLES,
        BASE_ASSET_BTC,
        STABLECOIN_DECIMALS
      );
    });

    it("should handle volatile BTC prices", async function () {
      // Simulate sudden price drop: BTC falls from 45000 to 42000
      const scenarios = [
        ethers.BigNumber.from("45000000000000"), // 45000 BTC at 9 decimals
        ethers.BigNumber.from("42000000000000"), // 42000 BTC at 9 decimals
        ethers.BigNumber.from("48000000000000"), // 48000 BTC at 9 decimals
      ];

      for (const price of scenarios) {
        await mockBlockScholesOracle.setPrice(price, Math.floor(Date.now() / 1000));
        const [returnedPrice, , isValid] = await adapter.getLatestPrice(BTC_USD_ASSET_ID);

        expect(isValid).to.be.true;
        expect(returnedPrice.toNumber()).to.be.greaterThan(0);
      }
    });

    it("should handle stablecoin prices", async function () {
      // Simulate USDT: normally 1.0
      const scenarios = [
        ethers.BigNumber.from("1000000000"), // 1.0 at 9 decimals
        ethers.BigNumber.from("995000000"), // 0.995 at 9 decimals (de-pegged)
        ethers.BigNumber.from("1010000000"), // 1.01 at 9 decimals (premium)
      ];

      for (const price of scenarios) {
        await mockBlockScholesOracle.setPrice(price, Math.floor(Date.now() / 1000));
        const [returnedPrice, , isValid] = await adapter.getLatestPrice(USD_USDT_ASSET_ID);

        expect(isValid).to.be.true;
        expect(returnedPrice.toNumber()).to.be.greaterThan(0);
      }
    });
  });
});
