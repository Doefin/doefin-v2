const { deployDiamond } = require("../../../scripts/deploy.js");
const { expect } = require("chai");
const { ethers } = require("hardhat");

const { deployMockERC20 } = require("../../mock/deployMocks.js");
const { getConditionId } = require("../../utils/ctfUtils.js");
const { addCollateralToken } = require("../../utils/adminConfigUtils.js");
const { mintAndApproveERC20 } = require("../../utils/erc20Utils.js");
const { splitConditionAndGetPositionIds } = require("../../utils/conditionUtils.js");
const { createLimitOrder } = require("../../utils/orderUtils.js");
const { takeSnapshot, revertToSnapshot } = require("../../utils/snapshotUtils.js");

describe("ExchangeFacet - Escrow Status", function () {
  let owner, user1, user2, oracle;
  let diamondAddress,
    orderCreationFacet,
    exchangeViewFacet,
    erc20,
    erc20_2,
    erc1155;
  let conditionalFacet, conditionManagerFacet, adminConfig;
  let questionId, conditionId, yesId, noId;
  let mintAmount, unit;
  let buyDir, sellDir;
  let snapshotId;

  before(async function () {
    [owner, user1, user2, oracle] = await ethers.getSigners();

    // Deploy mock tokens
    erc20 = await deployMockERC20("MockToken", "MOCK");
    erc20_2 = await deployMockERC20("MockToken2", "MOCK2");

    buyDir = 0;
    sellDir = 1;

    // Deploy diamond
    diamondAddress = await deployDiamond();

    // Get facet instances
    orderCreationFacet = await ethers.getContractAt(
      "OrderCreationFacet",
      diamondAddress
    );
    exchangeViewFacet = await ethers.getContractAt(
      "ExchangeViewFacet",
      diamondAddress
    );
    erc1155 = await ethers.getContractAt("ERC1155Facet", diamondAddress);
    conditionalFacet = await ethers.getContractAt("ConditionalTokensFacet", diamondAddress);
    conditionManagerFacet = await ethers.getContractAt("ConditionManagerFacet", diamondAddress);
    adminConfig = await ethers.getContractAt("AdminConfigFacet", diamondAddress);
    const accessControlFacet = await ethers.getContractAt("AccessControlFacet", diamondAddress);

    // Setup access control
    await accessControlFacet.addMarketMaker(owner.address);

    // Setup collateral tokens
    unit = ethers.utils.parseEther("1");
    await addCollateralToken({
      adminConfig: adminConfig,
      token: erc20,
      unit: unit,
      caller: owner,
    });
    await addCollateralToken({
      adminConfig: adminConfig,
      token: erc20_2,
      unit: unit,
      caller: owner,
    });

    // Create condition
    questionId = ethers.utils.id("escrow-test-question");
    const outcomeSlotCount = 2;
    conditionId = getConditionId(oracle.address, questionId, outcomeSlotCount);

    await conditionManagerFacet
      .connect(owner)
      .createCondition(oracle.address, questionId, outcomeSlotCount, "ipfs://dummy");

    // Mint and approve tokens for owner
    mintAmount = ethers.utils.parseEther("1000");
    await mintAndApproveERC20({
      token: erc20,
      minter: owner,
      to: owner,
      amount: mintAmount,
      spender: diamondAddress,
    });

    // Split condition to get position tokens
    const [positionIds] = await splitConditionAndGetPositionIds({
      user: owner,
      amount: unit.mul(100),
      conditionId,
      indexSets: [1, 2],
      erc20,
      conditionalFacet,
    });

    yesId = positionIds[0];
    noId = positionIds[1];

    // Setup approvals
    await erc1155.connect(owner).setApprovalForAll(diamondAddress, true);
    await erc1155.connect(user1).setApprovalForAll(diamondAddress, true);
    await erc1155.connect(user2).setApprovalForAll(diamondAddress, true);
  });

  beforeEach(async () => {
    snapshotId = await takeSnapshot();
  });

  afterEach(async () => {
    await revertToSnapshot(snapshotId);
  });

  describe("getUserEscrowStatus", function () {
    it("should return correct escrow balances for a user with locked collateral", async function () {
      // Setup: Give user1 some tokens and position tokens
      const erc20Amount = ethers.utils.parseEther("100");
      const positionAmount = ethers.utils.parseEther("10");

      await mintAndApproveERC20({
        token: erc20,
        minter: owner,
        to: user1,
        amount: erc20Amount,
        spender: diamondAddress,
      });

      await mintAndApproveERC20({
        token: erc20_2,
        minter: owner,
        to: user1,
        amount: erc20Amount.mul(2),
        spender: diamondAddress,
      });

      // Transfer position tokens to user1
      await erc1155
        .connect(owner)
        .safeTransferFrom(owner.address, user1.address, yesId, positionAmount, "0x");
      await erc1155
        .connect(owner)
        .safeTransferFrom(owner.address, user1.address, noId, positionAmount.mul(2), "0x");

      // Create buy order to lock ERC20 collateral
      const buyAmount = ethers.utils.parseEther("20");
      const buyPrice = ethers.utils.parseEther("0.5");
      
      await createLimitOrder(orderCreationFacet, user1, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount: buyAmount,
        pricePerToken: buyPrice,
        minFillAmount: 0,
        expiry: 0,
        direction: buyDir,
      });

      // Create another buy order with second token
      await createLimitOrder(orderCreationFacet, user1, {
        positionId: noId,
        collateralToken: erc20_2.address,
        amount: buyAmount.mul(2),
        pricePerToken: buyPrice,
        minFillAmount: 0,
        expiry: 0,
        direction: buyDir,
      });

      // Create sell order to lock ERC1155 collateral
      const sellAmount = ethers.utils.parseEther("5");
      const sellPrice = ethers.utils.parseEther("0.7");
      
      await createLimitOrder(orderCreationFacet, user1, {
        positionId: yesId,
        collateralToken: erc20.address,
        amount: sellAmount,
        pricePerToken: sellPrice,
        minFillAmount: 0,
        expiry: 0,
        direction: sellDir,
      });

      // Create another sell order for noId
      await createLimitOrder(orderCreationFacet, user1, {
        positionId: noId,
        collateralToken: erc20.address,
        amount: sellAmount.mul(2),
        pricePerToken: sellPrice,
        minFillAmount: 0,
        expiry: 0,
        direction: sellDir,
      });

      // Query escrow status
      const tokens = [erc20.address, erc20_2.address];
      const positionIds = [yesId, noId];
      
      const [erc20Balances, erc1155Balances] = await exchangeViewFacet.getUserEscrowStatus(
        user1.address,
        tokens,
        positionIds
      );

      // Verify ERC20 balances
      // User1 locked: 20 * 0.5 = 10 ETH worth of erc20 (plus fees)
      // User1 locked: 40 * 0.5 = 20 ETH worth of erc20_2 (plus fees)
      expect(erc20Balances.length).to.equal(2);
      expect(erc20Balances[0]).to.be.gt(0); // Should have locked ERC20
      expect(erc20Balances[1]).to.be.gt(0); // Should have locked ERC20_2

      // Verify ERC1155 balances
      // User1 locked: 5 yesId tokens and 10 noId tokens
      expect(erc1155Balances.length).to.equal(2);
      expect(erc1155Balances[0]).to.equal(sellAmount); // 5 yesId locked
      expect(erc1155Balances[1]).to.equal(sellAmount.mul(2)); // 10 noId locked
    });

    it("should return zero balances for user with no locked collateral", async function () {
      // Query escrow status for user2 who has no orders
      const tokens = [erc20.address, erc20_2.address];
      const positionIds = [yesId, noId];
      
      const [erc20Balances, erc1155Balances] = await exchangeViewFacet.getUserEscrowStatus(
        user2.address,
        tokens,
        positionIds
      );

      // Verify all balances are zero
      expect(erc20Balances.length).to.equal(2);
      expect(erc20Balances[0]).to.equal(0);
      expect(erc20Balances[1]).to.equal(0);

      expect(erc1155Balances.length).to.equal(2);
      expect(erc1155Balances[0]).to.equal(0);
      expect(erc1155Balances[1]).to.equal(0);
    });

    it("should handle empty arrays correctly", async function () {
      // Test with empty token array
      const [erc20BalancesEmpty, erc1155BalancesWithPositions] = await exchangeViewFacet.getUserEscrowStatus(
        user1.address,
        [], // Empty tokens array
        [yesId, noId]
      );

      expect(erc20BalancesEmpty.length).to.equal(0);
      expect(erc1155BalancesWithPositions.length).to.equal(2);

      // Test with empty position IDs array
      const [erc20BalancesWithTokens, erc1155BalancesEmpty] = await exchangeViewFacet.getUserEscrowStatus(
        user1.address,
        [erc20.address, erc20_2.address],
        [] // Empty position IDs array
      );

      expect(erc20BalancesWithTokens.length).to.equal(2);
      expect(erc1155BalancesEmpty.length).to.equal(0);

      // Test with both arrays empty
      const [erc20BalancesAllEmpty, erc1155BalancesAllEmpty] = await exchangeViewFacet.getUserEscrowStatus(
        user1.address,
        [],
        []
      );

      expect(erc20BalancesAllEmpty.length).to.equal(0);
      expect(erc1155BalancesAllEmpty.length).to.equal(0);
    });
  });
});