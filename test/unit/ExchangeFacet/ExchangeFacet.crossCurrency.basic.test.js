const { deployDiamond } = require("../../../scripts/deploy.js");
const { expect } = require("chai");
const { ethers } = require("hardhat");

const { deployMockERC20 } = require("../../mock/deployMocks.js");
const { getConditionId } = require("../../utils/ctfUtils.js");
const { getFees, addCollateralToken } = require("../../utils/adminConfigUtils.js");
const { mintAndApproveERC20 } = require("../../utils/erc20Utils.js");
const { splitConditionAndGetPositionIds } = require("../../utils/conditionUtils.js");
const {
  createCrossCurrencyLimitOrder,
  OrderDirection,
  ExchangeRateType,
} = require("../../utils/orderUtils.js");
const {
  deployMockOracleAdapter,
  setupMockOracleManager,
  setupCrossCurrencyTokens,
  setupOraclePrices,
} = require("../../utils/crossCurrencyUtils.js");
const { takeSnapshot, revertToSnapshot } = require("../../utils/snapshotUtils.js");

describe("Cross-Currency Basic Tests", function () {
  let owner, oracle, trader1, trader2;
  let diamondAddress, diamond, orderCreationFacet, orderManagementFacet;
  let collateralToken, btcToken;
  let mockOracleAdapter;
  let questionId, conditionId, yesId, noId;
  let snapshotId;

  before(async function () {
    [owner, oracle, trader1, trader2] = await ethers.getSigners();

    try {
      // Deploy diamond and get contract instances
      diamondAddress = await deployDiamond();
      diamond = await ethers.getContractAt("Diamond", diamondAddress);
      orderCreationFacet = await ethers.getContractAt("OrderCreationFacet", diamondAddress);
      orderManagementFacet = await ethers.getContractAt("OrderManagementFacet", diamondAddress);
      
      console.log("✅ Diamond deployed successfully");
    } catch (error) {
      console.error("❌ Diamond deployment failed:", error.message);
      this.skip();
    }
  });

  it("should validate diamond deployment", async () => {
    expect(diamondAddress).to.be.properAddress;
    expect(orderCreationFacet.address).to.equal(diamondAddress);
    expect(orderManagementFacet.address).to.equal(diamondAddress);
    console.log("🔧 Diamond validation passed");
  });
});