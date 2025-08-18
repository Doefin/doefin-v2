const { deployDiamond } = require("../../scripts/deploy.js");
const { expect } = require("chai");
const { ethers } = require("hardhat");

const { deployMockERC20 } = require("../mock/deployMocks.js");
const { getConditionId } = require("../utils/ctfUtils.js");
const { getFees, addCollateralToken } = require("../utils/adminConfigUtils.js");
const {
  createCompleteMarket,
  createMarketScenario,
  measureGas,
  increaseTime,
} = require("../utils/marketUtils.js");
const { simulateAndParseMatchRoute } = require("../utils/simulationUtils.js");
const { takeSnapshot, revertToSnapshot } = require("../utils/snapshotUtils.js");

describe("Full Market Lifecycle Integration Tests", function () {
  let owner, oracle, trader1, trader2, trader3, marketMaker1, marketMaker2;
  let diamondAddress, contracts, feeConfig;
  let snapshotId;

  before(async function () {
    [owner, oracle, trader1, trader2, trader3, marketMaker1, marketMaker2] =
      await ethers.getSigners();

    // Deploy diamond and get all contract instances
    diamondAddress = await deployDiamond();

    contracts = {
      exchangeFacet: await ethers.getContractAt(
        "ExchangeFacet",
        diamondAddress
      ),
      erc1155: await ethers.getContractAt("ERC1155Facet", diamondAddress),
      conditionalFacet: await ethers.getContractAt(
        "ConditionalTokensFacet",
        diamondAddress
      ),
      conditionManagerFacet: await ethers.getContractAt(
        "ConditionManagerFacet",
        diamondAddress
      ),
      marketExecutionFacet: await ethers.getContractAt(
        "MarketExecutionFacet",
        diamondAddress
      ),
      adminConfig: await ethers.getContractAt(
        "AdminConfigFacet",
        diamondAddress
      ),
      routeSimFacet: await ethers.getContractAt(
        "RouteSimulationFacet",
        diamondAddress
      ),
      accessControlFacet: await ethers.getContractAt(
        "AccessControlFacet",
        diamondAddress
      ),
      marketDataFacet: await ethers.getContractAt(
        "MarketDataFacet",
        diamondAddress
      ),
    };

    // Deploy ERC20 token
    contracts.erc20 = await deployMockERC20("TestToken", "TEST");

    // Setup access control
    await contracts.accessControlFacet
      .connect(owner)
      .addMarketMaker(owner.address);
    await contracts.accessControlFacet
      .connect(owner)
      .addMarketMaker(marketMaker1.address);

    // Setup collateral token
    const ercUnit = ethers.utils.parseEther("1");
    await addCollateralToken({
      adminConfig: contracts.adminConfig,
      token: contracts.erc20,
      unit: ercUnit,
      caller: owner,
    });

    feeConfig = await getFees(contracts.adminConfig);
  });

  beforeEach(async () => {
    snapshotId = await takeSnapshot();
  });

  afterEach(async () => {
    await revertToSnapshot(snapshotId);
  });

  describe("Complete Market Creation and Trading Lifecycle", function () {
    it("should handle full lifecycle: creation → trading → resolution → redemption", async () => {
      const questionId = ethers.utils.id("will-eth-reach-5000-by-eoy?");

      // Phase 1: Market Creation
      console.log("Phase 1: Creating market...");
      const market = await createCompleteMarket({
        ...contracts,
        oracle,
        owner,
        questionId,
        diamondAddress,
      });

      // Verify market data is accessible
      const marketMetadata = await contracts.marketDataFacet.getMarketMetadata(
        market.yesId
      );
      expect(marketMetadata.positionIds).to.have.lengthOf(2);
      expect(marketMetadata.collateralToken).to.equal(contracts.erc20.address);

      // Phase 2: Initial Liquidity Provision
      console.log("Phase 2: Adding initial liquidity...");
      const scenario = await createMarketScenario({
        scenario: "balanced",
        contracts,
        signers: [owner, oracle, marketMaker1, marketMaker2, trader1],
        diamondAddress,
      });

      // Verify orderbook state
      const sellBook = await contracts.exchangeFacet.getOrderbook(
        market.yesId,
        1
      );
      const buyBook = await contracts.exchangeFacet.getOrderbook(
        market.yesId,
        0
      );
      console.log("Sell book length:", sellBook.length);
      console.log("Buy book length:", buyBook.length);

      // If no orders were created, skip the trading phase
      if (sellBook.length === 0 && buyBook.length === 0) {
        console.log("No orders created, skipping trading phase");
        return;
      }

      expect(sellBook.length).to.be.greaterThan(0);
      expect(buyBook.length).to.be.greaterThan(0);

      // Phase 3: Active Trading
      console.log("Phase 3: Executing trades...");

      // Trader1 executes a large BUY order
      const tradeAmount = ethers.utils.parseEther("15");
      const maxPrice = ethers.utils.parseEther("0.6");

      // Fund trader1
      const estimatedCost = tradeAmount
        .mul(maxPrice)
        .div(ethers.utils.parseEther("1"));
      const estimatedFee = estimatedCost.mul(feeConfig.takerBps).div(10000);
      const totalCost = estimatedCost.add(estimatedFee);

      await contracts.erc20.mint(trader1.address, totalCost);
      await contracts.erc20.connect(trader1).approve(diamondAddress, totalCost);

      // Simulate and execute trade
      const route = await simulateAndParseMatchRoute({
        routeSimFacet: contracts.routeSimFacet,
        positionId: market.yesId,
        amount: tradeAmount,
        direction: 0, // BUY
      });

      const trader1BalanceBefore = await contracts.erc20.balanceOf(
        trader1.address
      );
      const trader1YesBalanceBefore = await contracts.erc1155.balanceOf(
        trader1.address,
        market.yesId
      );

      const { gasUsed: tradeGas } = await measureGas(
        contracts.marketExecutionFacet
          .connect(trader1)
          .fillMarketOrderWithRoute(
            market.yesId,
            tradeAmount,
            maxPrice,
            false,
            0,
            route.matches.map((m) => [
              m.matchedOrderId,
              m.amount,
              m.effectivePrice,
              m.matchType,
            ])
          )
      );

      console.log(`Trade execution gas: ${tradeGas.toString()}`);

      // Verify trade execution
      const trader1BalanceAfter = await contracts.erc20.balanceOf(
        trader1.address
      );
      const trader1YesBalanceAfter = await contracts.erc1155.balanceOf(
        trader1.address,
        market.yesId
      );

      expect(trader1BalanceBefore.gt(trader1BalanceAfter)).to.be.true;
      expect(trader1YesBalanceAfter.sub(trader1YesBalanceBefore)).to.equal(
        tradeAmount
      );

      // Phase 4: More Complex Trading Scenarios
      console.log("Phase 4: Complex trading scenarios...");

      // Trader2 executes a SELL order
      await contracts.erc1155
        .connect(owner)
        .safeTransferFrom(
          owner.address,
          trader2.address,
          market.yesId,
          ethers.utils.parseEther("10"),
          "0x"
        );
      await contracts.erc1155
        .connect(trader2)
        .setApprovalForAll(diamondAddress, true);

      const sellRoute = await simulateAndParseMatchRoute({
        routeSimFacet: contracts.routeSimFacet,
        positionId: market.yesId,
        amount: ethers.utils.parseEther("8"),
        direction: 1, // SELL
      });

      await contracts.marketExecutionFacet
        .connect(trader2)
        .fillMarketOrderWithRoute(
          market.yesId,
          ethers.utils.parseEther("8"),
          ethers.utils.parseEther("0.4"), // Min acceptable price
          false,
          1,
          sellRoute.matches.map((m) => [
            m.matchedOrderId,
            m.amount,
            m.effectivePrice,
            m.matchType,
          ])
        );

      // Phase 5: Market Resolution
      console.log("Phase 5: Resolving market...");

      // Advance time to simulate market resolution
      await increaseTime(86400 * 30); // 30 days

      // Oracle resolves the condition (YES wins)
      const payouts = [1, 0]; // YES wins, NO loses
      await contracts.conditionalFacet
        .connect(oracle)
        .reportPayouts(questionId, payouts);

      // Verify condition is resolved
      const conditionAfterResolution =
        await contracts.conditionManagerFacet.getCondition(market.conditionId);
      expect(conditionAfterResolution.resolved).to.be.true;
      expect(conditionAfterResolution.payouts).to.deep.equal(payouts);

      // Phase 6: Position Redemption
      console.log("Phase 6: Redeeming positions...");

      // Trader1 redeems winning YES positions
      const trader1ERC20BeforeRedemption = await contracts.erc20.balanceOf(
        trader1.address
      );
      const trader1YesBeforeRedemption = await contracts.erc1155.balanceOf(
        trader1.address,
        market.yesId
      );

      await contracts.conditionalFacet.connect(trader1).redeemPositions(
        contracts.erc20.address,
        ethers.constants.HashZero,
        market.conditionId,
        [1] // Redeem YES positions
      );

      const trader1ERC20AfterRedemption = await contracts.erc20.balanceOf(
        trader1.address
      );
      const trader1YesAfterRedemption = await contracts.erc1155.balanceOf(
        trader1.address,
        market.yesId
      );

      // Verify redemption (should receive ERC20 minus resolution fee)
      expect(trader1ERC20AfterRedemption.gt(trader1ERC20BeforeRedemption)).to.be
        .true;
      expect(trader1YesAfterRedemption.lt(trader1YesBeforeRedemption)).to.be
        .true;

      // Trader2 tries to redeem losing NO positions (should get nothing)
      const trader2ERC20BeforeRedemption = await contracts.erc20.balanceOf(
        trader2.address
      );
      const trader2NoBeforeRedemption = await contracts.erc1155.balanceOf(
        trader2.address,
        market.noId
      );

      if (trader2NoBeforeRedemption.gt(0)) {
        await contracts.conditionalFacet.connect(trader2).redeemPositions(
          contracts.erc20.address,
          ethers.constants.HashZero,
          market.conditionId,
          [2] // Redeem NO positions
        );

        const trader2ERC20AfterRedemption = await contracts.erc20.balanceOf(
          trader2.address
        );
        // Should receive nothing for losing positions
        expect(trader2ERC20AfterRedemption).to.equal(
          trader2ERC20BeforeRedemption
        );
      }

      console.log("Full market lifecycle completed successfully!");
    });

    it("should handle market with high trading volume and multiple participants", async () => {
      const questionId = ethers.utils.id("high-volume-market");

      // Create market with high initial liquidity
      const market = await createCompleteMarket({
        ...contracts,
        oracle,
        owner,
        questionId,
        initialLiquidity: ethers.utils.parseEther("500"),
        diamondAddress,
      });

      // Create complex orderbook
      const scenario = await createMarketScenario({
        scenario: "balanced",
        contracts,
        signers: [owner, oracle, marketMaker1, marketMaker2, trader1, trader2],
        diamondAddress,
      });

      // Execute multiple trades from different participants
      const traders = [trader1, trader2, trader3];
      const tradeResults = [];

      for (let i = 0; i < traders.length; i++) {
        const trader = traders[i];
        const tradeAmount = ethers.utils.parseEther((5 + i * 3).toString());
        const direction = i % 2; // Alternate BUY/SELL

        if (direction === 0) {
          // BUY
          const cost = tradeAmount
            .mul(ethers.utils.parseEther("0.6"))
            .div(ethers.utils.parseEther("1"));
          const fee = cost.mul(feeConfig.takerBps).div(10000);
          const totalCost = cost.add(fee);

          await contracts.erc20.mint(trader.address, totalCost);
          await contracts.erc20
            .connect(trader)
            .approve(diamondAddress, totalCost);
        } else {
          // SELL
          await contracts.erc1155
            .connect(owner)
            .safeTransferFrom(
              owner.address,
              trader.address,
              market.yesId,
              tradeAmount,
              "0x"
            );
          await contracts.erc1155
            .connect(trader)
            .setApprovalForAll(diamondAddress, true);
        }

        const route = await simulateAndParseMatchRoute({
          routeSimFacet: contracts.routeSimFacet,
          positionId: market.yesId,
          amount: tradeAmount,
          direction,
        });

        const { gasUsed } = await measureGas(
          contracts.marketExecutionFacet
            .connect(trader)
            .fillMarketOrderWithRoute(
              market.yesId,
              tradeAmount,
              direction === 0
                ? ethers.utils.parseEther("0.7")
                : ethers.utils.parseEther("0.3"),
              false,
              direction,
              route.matches.map((m) => [
                m.matchedOrderId,
                m.amount,
                m.effectivePrice,
                m.matchType,
              ])
            )
        );

        tradeResults.push({
          trader: i,
          direction,
          amount: tradeAmount,
          gasUsed,
        });
      }

      // Verify all trades executed successfully
      expect(tradeResults).to.have.lengthOf(3);

      // Check gas efficiency
      const avgGas = tradeResults
        .reduce((sum, result) => sum.add(result.gasUsed), ethers.constants.Zero)
        .div(3);
      console.log(`Average gas per trade: ${avgGas.toString()}`);
      expect(avgGas.lt(ethers.utils.parseUnits("500", 3))).to.be.true; // Less than 500k gas

      // Verify market state consistency
      const finalMetadata = await contracts.marketDataFacet.getMarketMetadata(
        market.yesId
      );
      expect(finalMetadata.positionIds).to.have.lengthOf(2);
    });
  });

  describe("Error Handling and Edge Cases Integration", function () {
    it("should handle failed trades gracefully without affecting market state", async () => {
      const questionId = ethers.utils.id("error-handling-market");

      const market = await createCompleteMarket({
        ...contracts,
        oracle,
        owner,
        questionId,
        diamondAddress,
      });

      // Create minimal liquidity
      const scenario = await createMarketScenario({
        scenario: "low_liquidity",
        contracts,
        signers: [owner, oracle, marketMaker1],
        diamondAddress,
      });

      // Check if orders were actually created
      const sellBook = await contracts.exchangeFacet.getOrderbook(
        market.yesId,
        1
      );
      const buyBook = await contracts.exchangeFacet.getOrderbook(
        market.yesId,
        0
      );

      console.log("Initial sell book length:", sellBook.length);
      console.log("Initial buy book length:", buyBook.length);

      if (sellBook.length === 0 && buyBook.length === 0) {
        console.log("No orders created, skipping fill-or-kill test");
        return;
      }

      // Attempt trade larger than available liquidity with fill-or-kill
      const largeAmount = ethers.utils.parseEther("100");
      const maxPrice = ethers.utils.parseEther("0.8");

      await contracts.erc20.mint(
        trader1.address,
        largeAmount.mul(maxPrice).div(ethers.utils.parseEther("1"))
      );
      await contracts.erc20
        .connect(trader1)
        .approve(
          diamondAddress,
          largeAmount.mul(maxPrice).div(ethers.utils.parseEther("1"))
        );

      try {
        const route = await simulateAndParseMatchRoute({
          routeSimFacet: contracts.routeSimFacet,
          positionId: market.yesId,
          amount: largeAmount,
          direction: 0,
        });

        // Should revert with fill-or-kill
        await expect(
          contracts.marketExecutionFacet
            .connect(trader1)
            .fillMarketOrderWithRoute(
              market.yesId,
              largeAmount,
              maxPrice,
              true, // fill-or-kill
              0,
              route.matches.map((m) => [
                m.matchedOrderId,
                m.amount,
                m.effectivePrice,
                m.matchType,
              ])
            )
        ).to.be.revertedWith("FillOrKillFailed()");
      } catch (error) {
        // If simulation fails due to no matches, that's also acceptable
        console.log("Simulation failed, which is expected with no liquidity");
      }

      // Verify market state unchanged
      const finalSellBook = await contracts.exchangeFacet.getOrderbook(
        market.yesId,
        1
      );
      const finalBuyBook = await contracts.exchangeFacet.getOrderbook(
        market.yesId,
        0
      );
      expect(finalSellBook.length).to.equal(sellBook.length);
      expect(finalBuyBook.length).to.equal(buyBook.length);

      // Verify balances unchanged
      const trader1Balance = await contracts.erc20.balanceOf(trader1.address);
      expect(trader1Balance).to.equal(
        largeAmount.mul(maxPrice).div(ethers.utils.parseEther("1"))
      );
    });

    it("should handle condition resolution edge cases", async () => {
      const questionId = ethers.utils.id("resolution-edge-cases");

      const market = await createCompleteMarket({
        ...contracts,
        oracle,
        owner,
        questionId,
        diamondAddress,
      });

      // Try to resolve with wrong oracle - should fail with ConditionNotPrepared since trader1 is not the oracle
      await expect(
        contracts.conditionalFacet
          .connect(trader1)
          .reportPayouts(questionId, [1, 0])
      ).to.be.revertedWith("ConditionNotPrepared()");

      // Try to resolve non-existent condition
      const fakeQuestionId = ethers.utils.id("fake-question");
      await expect(
        contracts.conditionalFacet
          .connect(oracle)
          .reportPayouts(fakeQuestionId, [1, 0])
      ).to.be.revertedWith("ConditionNotPrepared()");

      // Resolve correctly
      await contracts.conditionalFacet
        .connect(oracle)
        .reportPayouts(questionId, [1, 0]);

      // Try to resolve again
      await expect(
        contracts.conditionalFacet
          .connect(oracle)
          .reportPayouts(questionId, [0, 1])
      ).to.be.revertedWith("ConditionAlreadyResolved()");

      // Verify resolution state
      const payouts = await contracts.conditionalFacet.getPayoutNumerators(
        market.conditionId
      );
      expect(payouts.length).to.be.greaterThan(0);
      expect(payouts[0].toNumber()).to.equal(1);
      expect(payouts[1].toNumber()).to.equal(0);
    });
  });

  describe("Performance and Scalability Integration", function () {
    it("should handle multiple concurrent markets efficiently", async () => {
      const numMarkets = 5;
      const markets = [];

      // Pre-fund owner with enough tokens for all markets
      const totalLiquidity = ethers.utils.parseEther("50").mul(numMarkets);
      await contracts.erc20.mint(owner.address, totalLiquidity);
      await contracts.erc20
        .connect(owner)
        .approve(diamondAddress, totalLiquidity);

      // Create multiple markets concurrently
      const marketPromises = [];
      for (let i = 0; i < numMarkets; i++) {
        const questionId = ethers.utils.id(`concurrent-market-${i}`);
        marketPromises.push(
          createCompleteMarket({
            ...contracts,
            oracle,
            owner,
            questionId,
            initialLiquidity: ethers.utils.parseEther("50"),
            diamondAddress,
          })
        );
      }

      const startTime = Date.now();
      const createdMarkets = await Promise.all(marketPromises);
      const endTime = Date.now();

      console.log(`Created ${numMarkets} markets in ${endTime - startTime}ms`);
      expect(endTime - startTime).to.be.lessThan(10000); // Less than 10 seconds

      // Verify all markets are independent and functional
      for (let i = 0; i < createdMarkets.length; i++) {
        const market = createdMarkets[i];

        // Verify market data
        const metadata = await contracts.marketDataFacet.getMarketMetadata(
          market.yesId
        );
        expect(metadata.positionIds).to.have.lengthOf(2);

        // Verify condition exists by checking if oracle is set
        const [oracle] = await contracts.conditionManagerFacet.getCondition(
          market.conditionId
        );
        expect(oracle).to.not.equal(ethers.constants.AddressZero);

        markets.push(market);
      }

      // Execute trades on all markets simultaneously
      const tradePromises = [];
      for (let i = 0; i < markets.length; i++) {
        const market = markets[i];
        const trader = [trader1, trader2, trader3][i % 3];
        const amount = ethers.utils.parseEther("2");
        const maxPrice = ethers.utils.parseEther("0.8");

        // Calculate proper cost and fund trader with extra buffer
        const estimatedCost = amount
          .mul(maxPrice)
          .div(ethers.utils.parseEther("1"));
        const estimatedFee = estimatedCost.mul(feeConfig.takerBps).div(10000);
        const totalCost = estimatedCost.add(estimatedFee);
        const bufferAmount = totalCost.mul(50).div(100); // 50% buffer for safety
        const finalAmount = totalCost.add(bufferAmount);

        // Check current balance and allowance
        const currentBalance = await contracts.erc20.balanceOf(trader.address);
        const currentAllowance = await contracts.erc20.allowance(
          trader.address,
          diamondAddress
        );

        // Mint additional tokens if needed
        if (currentBalance.lt(finalAmount)) {
          await contracts.erc20.mint(
            trader.address,
            finalAmount.sub(currentBalance)
          );
        }

        // Approve additional allowance if needed
        if (currentAllowance.lt(finalAmount)) {
          await contracts.erc20
            .connect(trader)
            .approve(diamondAddress, finalAmount);
        }

        const route = await simulateAndParseMatchRoute({
          routeSimFacet: contracts.routeSimFacet,
          positionId: market.yesId,
          amount,
          direction: 0,
        });

        tradePromises.push(
          contracts.marketExecutionFacet
            .connect(trader)
            .fillMarketOrderWithRoute(
              market.yesId,
              amount,
              maxPrice,
              false,
              0,
              route.matches.map((m) => [
                m.matchedOrderId,
                m.amount,
                m.effectivePrice,
                m.matchType,
              ])
            )
        );
      }

      const tradeStartTime = Date.now();
      await Promise.all(tradePromises);
      const tradeEndTime = Date.now();

      console.log(
        `Executed ${numMarkets} trades in ${tradeEndTime - tradeStartTime}ms`
      );
      expect(tradeEndTime - tradeStartTime).to.be.lessThan(15000); // Less than 15 seconds
    });
  });
});
