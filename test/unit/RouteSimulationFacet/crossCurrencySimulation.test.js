const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployDiamond } = require("../../../scripts/deploy.js");

describe("RouteSimulationFacet - Cross-Currency", function () {
  let diamondAddress;
  let routeSimulationFacet;
  let adminConfigFacet;
  let orderCreationFacet;
  let conditionalTokensFacet;
  let conditionManagerFacet;
  let owner;
  let user1;
  let user2;
  let mockUSDC;
  let mockWETH;
  let conditionId;
  let positionId;

  before(async function () {
    this.timeout(60000); // Increase timeout for deployment
    [owner, user1, user2] = await ethers.getSigners();

    // Deploy diamond
    diamondAddress = await deployDiamond();

    // Get facets
    routeSimulationFacet = await ethers.getContractAt("RouteSimulationFacet", diamondAddress);
    adminConfigFacet = await ethers.getContractAt("AdminConfigFacet", diamondAddress);
    orderCreationFacet = await ethers.getContractAt("OrderCreationFacet", diamondAddress);
    conditionalTokensFacet = await ethers.getContractAt("ConditionalTokensFacet", diamondAddress);
    conditionManagerFacet = await ethers.getContractAt("ConditionManagerFacet", diamondAddress);
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

  describe("simulateCrossCurrencyMarketOrder", function () {
    it("should return empty route when no compatible orders exist", async function () {
      const crossCurrencyConfig = {
        quoteCurrencyToken: mockWETH.address,
        exchangeRateType: 0, // Fixed
        exchangeRate: ethers.utils.parseUnits("2000", 18), // 2000 USDC per WETH
      };

      const route = await routeSimulationFacet.simulateCrossCurrencyMarketOrder(
        positionId,
        ethers.utils.parseUnits("100", 6),
        0, // Buy
        crossCurrencyConfig
      );

      expect(route.matches.length).to.equal(0);
      expect(route.totalInputAmount).to.equal(0);
      expect(route.totalOutputAmount).to.equal(0);
    });

    it("should validate quote currency token is not zero address", async function () {
      const invalidConfig = {
        quoteCurrencyToken: ethers.constants.AddressZero,
        exchangeRateType: 0,
        exchangeRate: ethers.utils.parseUnits("1", 18),
      };

      try {
        await routeSimulationFacet.simulateCrossCurrencyMarketOrder(
          positionId,
          ethers.utils.parseUnits("100", 6),
          0, // Buy
          invalidConfig
        );
        expect.fail("Should have reverted with InvalidQuoteCurrencyToken");
      } catch (error) {
        expect(error.message).to.include("InvalidQuoteCurrencyToken");
      }
    });

    it("should validate quote currency token is allowed", async function () {
      const unapprovedToken = ethers.Wallet.createRandom().address;
      const invalidConfig = {
        quoteCurrencyToken: unapprovedToken,
        exchangeRateType: 0,
        exchangeRate: ethers.utils.parseUnits("1", 18),
      };

      try {
        await routeSimulationFacet.simulateCrossCurrencyMarketOrder(
          positionId,
          ethers.utils.parseUnits("100", 6),
          0, // Buy
          invalidConfig
        );
        expect.fail("Should have reverted with TokenNotAllowed");
      } catch (error) {
        expect(error.message).to.include("TokenNotAllowed");
      }
    });
  });
});
