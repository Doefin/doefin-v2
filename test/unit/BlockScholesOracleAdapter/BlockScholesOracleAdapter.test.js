const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("BlockScholesOracleAdapter", function () {
  let adapter;
  let mockBlockScholesOracle;
  let owner, user;

  // Test constants
  const BTC_USD_ASSET_ID = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("BTC-USD"));
  const USD_USDC_ASSET_ID = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("USD-USDC"));
  const USD_USDT_ASSET_ID = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("USD-USDT"));
  const ETH_USD_ASSET_ID = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("ETH-USD"));

  // Block Scholes constants
  const FEED_ID_SPOT_PRICE = 3;
  const EXCHANGE_BLOCKSCHOLES = 0;
  const BASE_ASSET_BTC = 1;
  const BASE_ASSET_ETH = 2;

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

  describe("Initialization", function () {
    it("should set owner correctly", async function () {
      expect(await adapter.owner()).to.equal(owner.address);
    });

    it("should set Block Scholes oracle address correctly", async function () {
      expect(await adapter.blockScholesOracle()).to.equal(mockBlockScholesOracle.address);
    });

    it("should revert with zero address for oracle", async function () {
      const adapterFactory = await ethers.getContractFactory("BlockScholesOracleAdapter");
      await expect(adapterFactory.deploy(ethers.constants.AddressZero))
        .to.be.revertedWith("InvalidAddress");
    });

    it("should support zero assets initially", async function () {
      const assets = await adapter.getSupportedAssets();
      expect(assets.length).to.equal(0);
    });
  });

  describe("Feed Configuration", function () {
    it("should configure a feed for BTC-USD", async function () {
      const tx = await adapter.configureAssetFeed(
        BTC_USD_ASSET_ID,
        FEED_ID_SPOT_PRICE,
        EXCHANGE_BLOCKSCHOLES,
        BASE_ASSET_BTC,
        BTC_DECIMALS
      );

      await expect(tx)
        .to.emit(adapter, "FeedConfigured")
        .withArgs(
          BTC_USD_ASSET_ID,
          FEED_ID_SPOT_PRICE,
          EXCHANGE_BLOCKSCHOLES,
          BASE_ASSET_BTC,
          BTC_DECIMALS
        );

      // Verify configuration stored
      const config = await adapter.feedConfigs(BTC_USD_ASSET_ID);
      expect(config.feedId).to.equal(FEED_ID_SPOT_PRICE);
      expect(config.exchange).to.equal(EXCHANGE_BLOCKSCHOLES);
      expect(config.baseAsset).to.equal(BASE_ASSET_BTC);
      expect(config.decimals).to.equal(BTC_DECIMALS);
    });

    it("should add asset to supported assets list", async function () {
      await adapter.configureAssetFeed(
        BTC_USD_ASSET_ID,
        FEED_ID_SPOT_PRICE,
        EXCHANGE_BLOCKSCHOLES,
        BASE_ASSET_BTC,
        BTC_DECIMALS
      );

      const assets = await adapter.getSupportedAssets();
      expect(assets.length).to.be.greaterThan(0);
      expect(assets).to.include(BTC_USD_ASSET_ID);
    });

    it("should not duplicate asset in supported list", async function () {
      await adapter.configureAssetFeed(
        BTC_USD_ASSET_ID,
        FEED_ID_SPOT_PRICE,
        EXCHANGE_BLOCKSCHOLES,
        BASE_ASSET_BTC,
        BTC_DECIMALS
      );

      const assets1 = await adapter.getSupportedAssets();
      const count1 = assets1.filter((a) => a === BTC_USD_ASSET_ID).length;

      // Configure again
      await adapter.configureAssetFeed(
        BTC_USD_ASSET_ID,
        FEED_ID_SPOT_PRICE,
        EXCHANGE_BLOCKSCHOLES,
        BASE_ASSET_BTC,
        BTC_DECIMALS
      );

      const assets2 = await adapter.getSupportedAssets();
      const count2 = assets2.filter((a) => a === BTC_USD_ASSET_ID).length;

      expect(count2).to.equal(count1);
    });

    it("should configure ETH asset", async function () {
      await adapter.configureAssetFeed(
        ETH_USD_ASSET_ID,
        FEED_ID_SPOT_PRICE,
        EXCHANGE_BLOCKSCHOLES,
        BASE_ASSET_ETH,
        BTC_DECIMALS
      );

      const config = await adapter.feedConfigs(ETH_USD_ASSET_ID);
      expect(config.baseAsset).to.equal(BASE_ASSET_ETH);
    });

    it("should revert with invalid feedId", async function () {
      await expect(
        adapter.configureAssetFeed(
          BTC_USD_ASSET_ID,
          0, // Invalid feed ID
          EXCHANGE_BLOCKSCHOLES,
          BASE_ASSET_BTC,
          BTC_DECIMALS
        )
      ).to.be.revertedWith("InvalidFeedId");
    });

    it("should revert with invalid decimals (0)", async function () {
      await expect(
        adapter.configureAssetFeed(
          BTC_USD_ASSET_ID,
          FEED_ID_SPOT_PRICE,
          EXCHANGE_BLOCKSCHOLES,
          BASE_ASSET_BTC,
          0 // Invalid decimals
        )
      ).to.be.revertedWith("InvalidDecimals");
    });

    it("should revert with invalid decimals (> 18)", async function () {
      await expect(
        adapter.configureAssetFeed(
          BTC_USD_ASSET_ID,
          FEED_ID_SPOT_PRICE,
          EXCHANGE_BLOCKSCHOLES,
          BASE_ASSET_BTC,
          19 // Invalid decimals
        )
      ).to.be.revertedWith("InvalidDecimals");
    });

    it("should only allow owner to configure feeds", async function () {
      await expect(
        adapter.connect(user).configureAssetFeed(
          BTC_USD_ASSET_ID,
          FEED_ID_SPOT_PRICE,
          EXCHANGE_BLOCKSCHOLES,
          BASE_ASSET_BTC,
          BTC_DECIMALS
        )
      ).to.be.revertedWith("NotOwner");
    });
  });

  describe("Price Queries", function () {
    beforeEach(async function () {
      // Configure feeds
      await adapter.configureAssetFeed(
        BTC_USD_ASSET_ID,
        FEED_ID_SPOT_PRICE,
        EXCHANGE_BLOCKSCHOLES,
        BASE_ASSET_BTC,
        BTC_DECIMALS
      );

      await adapter.configureAssetFeed(
        USD_USDC_ASSET_ID,
        FEED_ID_SPOT_PRICE,
        EXCHANGE_BLOCKSCHOLES,
        BASE_ASSET_BTC, // Note: This is just for testing, not a real asset
        STABLECOIN_DECIMALS
      );
    });

    it("should return price for BTC-USD with decimal conversion", async function () {
      // Set mock price: 45000.5 BTC at 9 decimals = 45000500000000
      const blockScholesPrice = ethers.BigNumber.from("45000500000000");
      const timestamp = Math.floor(Date.now() / 1000);

      await mockBlockScholesOracle.setPrice(blockScholesPrice, timestamp);

      const [price, returnedTimestamp, isValid] = await adapter.getLatestPrice(BTC_USD_ASSET_ID);

      // Expected: 45000.5 at 8 decimals = 4500050000000
      const expectedPrice = ethers.BigNumber.from("4500050000000");
      expect(price).to.equal(expectedPrice);
      expect(returnedTimestamp).to.equal(timestamp);
      expect(isValid).to.be.true;
    });

    it("should convert from 9 decimals to 6 decimals correctly", async function () {
      // Set mock price: 1.0 at 9 decimals = 1000000000
      const blockScholesPrice = ethers.BigNumber.from("1000000000");
      const timestamp = Math.floor(Date.now() / 1000);

      await mockBlockScholesOracle.setPrice(blockScholesPrice, timestamp);

      const [price] = await adapter.getLatestPrice(USD_USDC_ASSET_ID);

      // Expected: 1.0 at 6 decimals = 1000000
      const expectedPrice = ethers.BigNumber.from("1000000");
      expect(price).to.equal(expectedPrice);
    });

    it("should return isValid false for negative prices", async function () {
      // Set mock to return negative price
      await mockBlockScholesOracle.setPrice(ethers.BigNumber.from("-1000"), Math.floor(Date.now() / 1000));

      const [price, , isValid] = await adapter.getLatestPrice(BTC_USD_ASSET_ID);

      expect(price).to.equal(0);
      expect(isValid).to.be.false;
    });

    it("should return isValid false for zero price", async function () {
      await mockBlockScholesOracle.setPrice(0, Math.floor(Date.now() / 1000));

      const [price, , isValid] = await adapter.getLatestPrice(BTC_USD_ASSET_ID);

      expect(price).to.equal(0);
      expect(isValid).to.be.false;
    });

    it("should revert for unconfigured asset", async function () {
      const unconfiguredAssetId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("UNKNOWN"));

      await expect(adapter.getLatestPrice(unconfiguredAssetId))
        .to.be.revertedWith("AssetNotConfigured");
    });

    it("should handle large prices correctly", async function () {
      // Large price: 100000.123456789 at 9 decimals
      const blockScholesPrice = ethers.BigNumber.from("100000123456789");
      const timestamp = Math.floor(Date.now() / 1000);

      await mockBlockScholesOracle.setPrice(blockScholesPrice, timestamp);

      const [price] = await adapter.getLatestPrice(BTC_USD_ASSET_ID);

      // Expected at 8 decimals: 100000123456789 / 10 = 10000012345678 (truncated)
      const expectedPrice = ethers.BigNumber.from("10000012345678");
      expect(price).to.equal(expectedPrice);
    });

    it("should handle small prices correctly", async function () {
      // Small price: 0.000000001 at 9 decimals = 1
      const blockScholesPrice = ethers.BigNumber.from("1");
      const timestamp = Math.floor(Date.now() / 1000);

      await mockBlockScholesOracle.setPrice(blockScholesPrice, timestamp);

      const [price] = await adapter.getLatestPrice(BTC_USD_ASSET_ID);

      // Expected at 8 decimals: 0 (rounds to 0 due to truncation)
      expect(price).to.equal(0);
    });
  });

  describe("Decimal Conversion", function () {
    it("should correctly convert from 9 to 8 decimals", async function () {
      // Configure for 9->8 conversion
      await adapter.configureAssetFeed(
        BTC_USD_ASSET_ID,
        FEED_ID_SPOT_PRICE,
        EXCHANGE_BLOCKSCHOLES,
        BASE_ASSET_BTC,
        8 // Target 8 decimals
      );

      // Price: 100 at 9 decimals = 1000000000
      await mockBlockScholesOracle.setPrice(
        ethers.BigNumber.from("1000000000"),
        Math.floor(Date.now() / 1000)
      );

      const [price] = await adapter.getLatestPrice(BTC_USD_ASSET_ID);

      // Expected: 100 at 9 decimals / 10 = 100 at 8 decimals = 100000000
      expect(price).to.equal(ethers.BigNumber.from("100000000"));
    });

    it("should correctly convert from 9 to 6 decimals", async function () {
      await adapter.configureAssetFeed(
        USD_USDC_ASSET_ID,
        FEED_ID_SPOT_PRICE,
        EXCHANGE_BLOCKSCHOLES,
        BASE_ASSET_BTC,
        6 // Target 6 decimals
      );

      // Price: 100 at 9 decimals = 1000000000
      await mockBlockScholesOracle.setPrice(
        ethers.BigNumber.from("1000000000"),
        Math.floor(Date.now() / 1000)
      );

      const [price] = await adapter.getLatestPrice(USD_USDC_ASSET_ID);

      // Expected: 100 at 9 decimals / 1000 = 100 at 6 decimals = 1000000
      expect(price).to.equal(ethers.BigNumber.from("1000000"));
    });

    it("should handle same decimal conversion (no conversion)", async function () {
      await adapter.configureAssetFeed(
        BTC_USD_ASSET_ID,
        FEED_ID_SPOT_PRICE,
        EXCHANGE_BLOCKSCHOLES,
        BASE_ASSET_BTC,
        9 // Same as Block Scholes
      );

      const blockScholesPrice = ethers.BigNumber.from("45000500000000");
      await mockBlockScholesOracle.setPrice(blockScholesPrice, Math.floor(Date.now() / 1000));

      const [price] = await adapter.getLatestPrice(BTC_USD_ASSET_ID);

      expect(price).to.equal(blockScholesPrice);
    });
  });

  describe("Metadata", function () {
    it("should return correct adapter name", async function () {
      const [name] = await adapter.getAdapterMetadata();
      expect(name).to.equal("BlockScholesV1");
    });

    it("should return correct adapter version", async function () {
      const [, version] = await adapter.getAdapterMetadata();
      expect(version).to.equal("1.0.0");
    });
  });

  describe("Admin Functions", function () {
    it("should update Block Scholes oracle address", async function () {
      const newOracleAddress = user.address;

      const tx = await adapter.setBlockScholesOracle(newOracleAddress);

      await expect(tx).to.emit(adapter, "BlockScholesOracleSet").withArgs(newOracleAddress);

      expect(await adapter.blockScholesOracle()).to.equal(newOracleAddress);
    });

    it("should revert updating oracle to zero address", async function () {
      await expect(adapter.setBlockScholesOracle(ethers.constants.AddressZero))
        .to.be.revertedWith("InvalidAddress");
    });

    it("should only allow owner to update oracle", async function () {
      await expect(adapter.connect(user).setBlockScholesOracle(user.address))
        .to.be.revertedWith("NotOwner");
    });

    it("should transfer ownership", async function () {
      // Step 1: Propose ownership transfer
      const proposeTx = await adapter.proposeOwnership(user.address);
      await expect(proposeTx).to.emit(adapter, "OwnershipProposed").withArgs(owner.address, user.address);
      expect(await adapter.pendingOwner()).to.equal(user.address);

      // Step 2: Accept ownership transfer
      const acceptTx = await adapter.connect(user).acceptOwnership();
      await expect(acceptTx).to.emit(adapter, "OwnershipTransferred").withArgs(owner.address, user.address);
      expect(await adapter.owner()).to.equal(user.address);
      expect(await adapter.pendingOwner()).to.equal(ethers.constants.AddressZero);
    });

    it("should revert transferring ownership to zero address", async function () {
      // Restore owner for this test
      await adapter.connect(user).proposeOwnership(owner.address);
      await adapter.acceptOwnership();

      await expect(adapter.proposeOwnership(ethers.constants.AddressZero))
        .to.be.revertedWith("InvalidAddress");

      // Transfer back to user for next test
      await adapter.proposeOwnership(user.address);
      await adapter.connect(user).acceptOwnership();
    });

    it("should only allow owner to transfer ownership", async function () {
      // Restore owner first if changed in previous test
      if ((await adapter.owner()) !== owner.address) {
        await adapter.connect(user).proposeOwnership(owner.address);
        await adapter.acceptOwnership();
      }

      await expect(adapter.connect(user).proposeOwnership(user.address))
        .to.be.revertedWith("NotOwner");
    });
  });

  describe("IBaseOracleAdapter Interface", function () {
    it("should implement getSupportedAssets", async function () {
      await adapter.configureAssetFeed(
        BTC_USD_ASSET_ID,
        FEED_ID_SPOT_PRICE,
        EXCHANGE_BLOCKSCHOLES,
        BASE_ASSET_BTC,
        BTC_DECIMALS
      );

      const assets = await adapter.getSupportedAssets();
      expect(assets).to.be.an("array");
      expect(assets.length).to.be.greaterThan(0);
    });

    it("should implement getAdapterMetadata", async function () {
      const [name, version] = await adapter.getAdapterMetadata();
      expect(name).to.be.a("string");
      expect(version).to.be.a("string");
      expect(name.length).to.be.greaterThan(0);
      expect(version.length).to.be.greaterThan(0);
    });
  });
});
