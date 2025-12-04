/**
 * Oracle Testing Utilities
 *
 * Helper functions for oracle manager and cross-currency testing
 */

const { ethers } = require("hardhat");

/**
 * Deploy a mock oracle adapter
 * @returns {Promise<Contract>} MockOracleAdapter instance
 */
async function deployMockOracleAdapter() {
  const MockOracleAdapter = await ethers.getContractFactory("MockOracleAdapter");
  const adapter = await MockOracleAdapter.deploy();
  await adapter.deployed();
  return adapter;
}

/**
 * Deploy multiple mock oracle adapters
 * @param {number} count - Number of adapters to deploy
 * @returns {Promise<Array<Contract>>} Array of MockOracleAdapter instances
 */
async function deployMultipleMockAdapters(count) {
  const adapters = [];
  for (let i = 0; i < count; i++) {
    const adapter = await deployMockOracleAdapter();
    adapters.push(adapter);
  }
  return adapters;
}

/**
 * Register an adapter with oracle manager
 * @param {Contract} oracleManager - OracleManagerFacet instance
 * @param {string} adapterId - bytes32 adapter ID
 * @param {string} adapterAddress - Adapter contract address
 * @param {number} maxStaleness - Max staleness in seconds
 * @returns {Promise<Transaction>} Transaction receipt
 */
async function registerAdapter(oracleManager, adapterId, adapterAddress, maxStaleness) {
  const tx = await oracleManager.registerAdapter(adapterId, adapterAddress, maxStaleness);
  return tx.wait();
}

/**
 * Configure an asset with oracle adapters
 * @param {Contract} oracleManager - OracleManagerFacet instance
 * @param {string} assetId - bytes32 asset ID
 * @param {Array<string>} adapterIds - Array of adapter IDs in priority order
 * @param {number} maxStaleness - Max staleness in seconds
 * @param {number} decimals - Number of decimals for oracle price (default: 8)
 * @returns {Promise<Transaction>} Transaction receipt
 */
async function configureAsset(oracleManager, assetId, adapterIds, maxStaleness, decimals = 8) {
  const tx = await oracleManager.configureAsset(assetId, adapterIds, maxStaleness, decimals);
  return tx.wait();
}

/**
 * Setup oracle manager with common assets
 * @param {Contract} oracleManager - OracleManagerFacet instance
 * @param {Contract} mockAdapter - MockOracleAdapter instance
 * @returns {Promise<Object>} Object with asset IDs and adapter ID
 */
async function setupCommonAssets(oracleManager, mockAdapter) {
  const adapterId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("MockAdapterV1"));
  const btcUsd = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("BTC-USD"));
  const ethUsd = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("ETH-USD"));
  const usdUsdc = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("USD-USDC"));
  const usdUsdt = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("USD-USDT"));

  // Register adapter
  await registerAdapter(oracleManager, adapterId, mockAdapter.address, 3600);

  // Configure assets with appropriate decimals
  await configureAsset(oracleManager, btcUsd, [adapterId], 3600, 8); // BTC: 8 decimals
  await configureAsset(oracleManager, ethUsd, [adapterId], 3600, 8); // ETH: 8 decimals
  await configureAsset(oracleManager, usdUsdc, [adapterId], 3600, 6); // USD-USDC: 6 decimals
  await configureAsset(oracleManager, usdUsdt, [adapterId], 3600, 6); // USD-USDT: 6 decimals

  return {
    adapterId,
    assets: {
      btcUsd,
      ethUsd,
      usdUsdc,
      usdUsdt,
    },
  };
}

/**
 * Set oracle prices for multiple assets
 * @param {Contract} mockAdapter - MockOracleAdapter instance
 * @param {Object} prices - Object mapping asset names to prices
 *   e.g., { "BTC-USD": parseUnits("45000", 8) }
 * @returns {Promise<void>}
 */
async function setOraclePrices(mockAdapter, prices) {
  for (const [assetName, price] of Object.entries(prices)) {
    const assetId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(assetName));
    await mockAdapter.setPrice(assetId, price);
  }
}

/**
 * Get price from oracle manager
 * @param {Contract} oracleManager - OracleManagerFacet instance
 * @param {string} assetId - bytes32 asset ID
 * @returns {Promise<Array>} [price, timestamp, isPaused]
 */
async function getPrice(oracleManager, assetId) {
  return oracleManager.getPrice(assetId);
}

/**
 * Update price through oracle manager (triggers failover logic)
 * @param {Contract} oracleManager - OracleManagerFacet instance
 * @param {string} assetId - bytes32 asset ID
 * @returns {Promise<Transaction>} Transaction receipt
 */
async function updatePrice(oracleManager, assetId) {
  const tx = await oracleManager.updatePrice(assetId);
  return tx.wait();
}

/**
 * Simulate adapter failure by making it revert
 * @param {Contract} mockAdapter - MockOracleAdapter instance
 * @param {string} assetId - bytes32 asset ID
 * @param {boolean} shouldFail - True to fail, false to recover
 * @returns {Promise<void>}
 */
async function setAdapterFailure(mockAdapter, assetId, shouldFail = true) {
  // This assumes MockOracleAdapter has a setFailure method
  // If not, you may need to implement this method in the mock
  if (typeof mockAdapter.setFailure === "function") {
    await mockAdapter.setFailure(assetId, shouldFail);
  }
}

/**
 * Get adapter failure count
 * @param {Contract} oracleManager - OracleManagerFacet instance
 * @param {string} adapterId - bytes32 adapter ID
 * @returns {Promise<BigNumber>} Failure count
 */
async function getAdapterFailureCount(oracleManager, adapterId) {
  const info = await oracleManager.getAdapterInfo(adapterId);
  return info.failureCount || ethers.BigNumber.from(0);
}

/**
 * Get asset oracle status
 * @param {Contract} oracleManager - OracleManagerFacet instance
 * @param {string} assetId - bytes32 asset ID
 * @returns {Promise<Object>} Asset status object
 */
async function getAssetStatus(oracleManager, assetId) {
  return oracleManager.getAssetOracleStatus(assetId);
}

/**
 * Create EIP-712 signature for manual price update
 * @param {Signer} signer - Signer account
 * @param {string} oracleAddress - OracleManager address
 * @param {string} assetId - bytes32 asset ID
 * @param {BigNumber} price - Price value
 * @param {number} deadline - Expiry timestamp
 * @returns {Promise<string>} Packed signature (v, r, s)
 */
async function createPriceUpdateSignature(
  signer,
  oracleAddress,
  assetId,
  price,
  deadline
) {
  // Domain separator
  const domain = {
    name: "OracleManager",
    version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: oracleAddress,
  };

  // Type definition
  const types = {
    PriceUpdate: [
      { name: "assetId", type: "bytes32" },
      { name: "price", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  // Value to sign
  const value = {
    assetId,
    price,
    deadline,
  };

  // Sign
  const signature = await signer._signTypedData(domain, types, value);
  return signature;
}

/**
 * Submit manual price update with EIP-712 signature
 * @param {Contract} oracleManager - OracleManagerFacet instance
 * @param {string} assetId - bytes32 asset ID
 * @param {BigNumber} price - Price value
 * @param {number} deadline - Expiry timestamp
 * @param {string} signature - EIP-712 signature
 * @returns {Promise<Transaction>} Transaction receipt
 */
async function submitManualPriceUpdate(oracleManager, assetId, price, deadline, signature) {
  const tx = await oracleManager.manualUpdatePrice(assetId, price, deadline, signature);
  return tx.wait();
}

/**
 * Submit emergency price update (owner only)
 * @param {Contract} oracleManager - OracleManagerFacet instance
 * @param {string} assetId - bytes32 asset ID
 * @param {BigNumber} price - Price value
 * @param {string} justification - Reason for emergency update
 * @returns {Promise<Transaction>} Transaction receipt
 */
async function submitEmergencyUpdate(oracleManager, assetId, price, justification) {
  const tx = await oracleManager.emergencyUpdatePrice(assetId, price, justification);
  return tx.wait();
}

/**
 * Helper to create asset ID from string
 * @param {string} assetName - Asset name (e.g., "BTC-USD")
 * @returns {string} bytes32 asset ID
 */
function createAssetId(assetName) {
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(assetName));
}

/**
 * Helper to create adapter ID from string
 * @param {string} adapterName - Adapter name
 * @returns {string} bytes32 adapter ID
 */
function createAdapterId(adapterName) {
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(adapterName));
}

/**
 * Advance blockchain time
 * @param {number} seconds - Seconds to advance
 * @returns {Promise<void>}
 */
async function advanceTime(seconds) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine");
}

/**
 * Get current block timestamp
 * @returns {Promise<number>} Timestamp in seconds
 */
async function getCurrentTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  return block.timestamp;
}

/**
 * Wait for specific time and mine block
 * @param {number} targetTimestamp - Target timestamp
 * @returns {Promise<void>}
 */
async function mineAtTimestamp(targetTimestamp) {
  const current = await getCurrentTimestamp();
  if (targetTimestamp > current) {
    await advanceTime(targetTimestamp - current);
  }
}

/**
 * Test scenario: Adapter failover chain
 * @param {Contract} oracleManager - OracleManagerFacet instance
 * @param {Array<Contract>} adapters - Array of mock adapters
 * @param {string} assetId - Asset ID
 * @param {Object} prices - Price values for each adapter
 * @returns {Promise<Object>} Test scenario results
 */
async function testFailoverScenario(oracleManager, adapters, assetId, prices) {
  const adapterIds = [];

  // Register all adapters
  for (let i = 0; i < adapters.length; i++) {
    const id = createAdapterId(`Adapter${i}`);
    adapterIds.push(id);
    await registerAdapter(oracleManager, id, adapters[i].address, 3600);
  }

  // Configure asset with all adapters in priority
  await configureAsset(oracleManager, assetId, adapterIds, 3600);

  // Set prices
  for (let i = 0; i < adapters.length; i++) {
    await adapters[i].setPrice(assetId, prices[i]);
  }

  return {
    adapterIds,
    scenario: "sequential_failover",
  };
}

module.exports = {
  deployMockOracleAdapter,
  deployMultipleMockAdapters,
  registerAdapter,
  configureAsset,
  setupCommonAssets,
  setOraclePrices,
  getPrice,
  updatePrice,
  setAdapterFailure,
  getAdapterFailureCount,
  getAssetStatus,
  createPriceUpdateSignature,
  submitManualPriceUpdate,
  submitEmergencyUpdate,
  createAssetId,
  createAdapterId,
  advanceTime,
  getCurrentTimestamp,
  mineAtTimestamp,
  testFailoverScenario,
};
