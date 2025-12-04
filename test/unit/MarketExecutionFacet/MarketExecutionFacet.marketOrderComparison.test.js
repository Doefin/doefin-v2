const { deployDiamond } = require("../../../scripts/deploy.js");
const { expect } = require("chai");
const { ethers } = require("hardhat");

const { deployMockERC20 } = require("../../mock/deployMocks.js");
const { getConditionId } = require("../../utils/ctfUtils.js");
const {
  getFees,
  addCollateralToken,
} = require("../../utils/adminConfigUtils.js");
const { mintAndApproveERC20 } = require("../../utils/erc20Utils.js");
const {
  splitConditionAndGetPositionIds,
} = require("../../utils/conditionUtils.js");
const { createLimitOrder, createMarketOrder } = require("../../utils/orderUtils.js");
const { sendAndApproveERC1155 } = require("../../utils/erc1155Utils.js");
const {
  takeSnapshot,
  revertToSnapshot,
} = require("../../utils/snapshotUtils.js");
const {
  simulateAndParseMatchRoute,
} = require("../../utils/simulationUtils.js");

describe("Market Order Execution - Comparison of Methods", function () {
  let owner, maker1, maker2, maker3, taker1, taker2, oracle;
  let diamondAddress,
    marketExecutionFacet,
    routeSimFacet,
    exchangeFacet,
    erc20,
    ercUnit,
    erc1155,
    conditionalFacet,
    conditionManagerFacet,
    adminConfig;
  let conditionId, yesId, noId;
  let erc20Decimals = 18;
  let buyDir, sellDir, feeConfig;
  let snapshotId;

  before(async function () {
    [owner, maker1, maker2, maker3, taker1, taker2, oracle] = await ethers.getSigners();

    erc20 = await deployMockERC20("MockToken", "MOCK", erc20Decimals);

    buyDir = 0;
    sellDir = 1;

    diamondAddress = await deployDiamond();

    exchangeFacet = await ethers.getContractAt("ExchangeFacet", diamondAddress);
    erc1155 = await ethers.getContractAt("ERC1155Facet", diamondAddress);
    conditionalFacet = await ethers.getContractAt(
      "ConditionalTokensFacet",
      diamondAddress
    );
    conditionManagerFacet = await ethers.getContractAt(
      "ConditionManagerFacet",
      diamondAddress
    );
    marketExecutionFacet = await ethers.getContractAt(
      "MarketExecutionFacet",
      diamondAddress
    );
    adminConfig = await ethers.getContractAt(
      "AdminConfigFacet",
      diamondAddress
    );
    routeSimFacet = await ethers.getContractAt(
      "RouteSimulationFacet",
      diamondAddress
    );
    const accessControlFacet = await ethers.getContractAt(
      "AccessControlFacet",
      diamondAddress
    );

    await accessControlFacet.addMarketMaker(owner.address);

    ercUnit = ethers.utils.parseUnits("1", erc20Decimals);

    await addCollateralToken({
      adminConfig: adminConfig,
      token: erc20,
      unit: ercUnit,
      caller: owner,
    });
    feeConfig = await getFees(adminConfig);

    const questionId = ethers.utils.id("market-order-comparison-test");
    const outcomeSlotCount = 2;
    conditionId = getConditionId(owner.address, questionId, outcomeSlotCount);

    await conditionManagerFacet
      .connect(owner)
      .createCondition(
        owner.address,
        questionId,
        outcomeSlotCount,
        "ipfs://dummy"
      );

    await mintAndApproveERC20({
      token: erc20,
      minter: owner,
      to: owner,
      amount: ercUnit.mul(10000000),
      spender: diamondAddress,
    });

    const [positionIds] = await splitConditionAndGetPositionIds({
      user: owner,
      amount: ercUnit.mul(10000000),
      conditionId,
      indexSets: [1, 2],
      erc20,
      conditionalFacet,
      });
    
      describe("Replicated fillLimitOrders Advanced Tests in Market Order Modes", function () {
        it("should handle maximum number of maker orders efficiently in both modes", async () => {
          const maxMakers = 10;
          const makerAmount = ethers.utils.parseUnits("1", erc20Decimals);
          const takerAmount = ethers.utils.parseUnits("10", erc20Decimals);
          const priceSell = ethers.utils.parseUnits("0.50", erc20Decimals);
          const priceBuy = ethers.utils.parseUnits("0.52", erc20Decimals);
    
          for (let i = 0; i < maxMakers; i++) {
            const maker = i % 3 === 0 ? maker1 : i % 3 === 1 ? maker2 : maker3;
            await sendAndApproveERC1155({
              token: erc1155,
              sender: owner,
              to: maker,
              tokenId: yesId,
              spender: diamondAddress,
              amount: makerAmount
            });
            await createLimitOrder(exchangeFacet, maker, {
              positionId: yesId,
              collateralToken: erc20.address,
              amount: makerAmount,
              pricePerToken: priceSell,
              minFillAmount: makerAmount,
              expiry: 0,
              direction: sellDir
            });
          }
    
          // Calculate budget for taker
          const takerBaseCost = takerAmount.mul(priceBuy).div(ercUnit);
          const takerFee = takerBaseCost.mul(feeConfig.takerBps).div(10_000);
          const takerBudget = takerBaseCost.add(takerFee);

          // Approach 1: Simulation+Execution
          const route = await simulateAndParseMatchRoute({
            routeSimFacet,
            positionId: yesId,
            amount: takerBudget,
            direction: buyDir
          });
          await mintAndApproveERC20({
            token: erc20,
            minter: taker1,
            to: taker1,
            amount: takerBudget,
            spender: diamondAddress,
          });
          const tx1 = await marketExecutionFacet.connect(taker1).fillMarketOrderWithRoute(
            yesId,
            takerAmount,
            priceBuy,
            false,
            buyDir,
            route.matches.map(m => [
              m.matchedOrderId,
              m.amount,
              m.effectivePrice,
              m.matchType
            ])
          );
          const rec1 = await tx1.wait();
    
          // Reset for approach 2
          await revertToSnapshot(snapshotId);
          snapshotId = await takeSnapshot();
          for (let i = 0; i < maxMakers; i++) {
            const maker = i % 3 === 0 ? maker1 : i % 3 === 1 ? maker2 : maker3;
            await sendAndApproveERC1155({
              token: erc1155,
              sender: owner,
              to: maker,
              tokenId: yesId,
              spender: diamondAddress,
              amount: makerAmount
            });
            await createLimitOrder(exchangeFacet, maker, {
              positionId: yesId,
              collateralToken: erc20.address,
              amount: makerAmount,
              pricePerToken: priceSell,
              minFillAmount: makerAmount,
              expiry: 0,
              direction: sellDir
            });
          }

          await mintAndApproveERC20({
            token: erc20,
            minter: taker1,
            to: taker1,
            amount: takerAmount,
            spender: diamondAddress,
          });

          // Approach 2: Direct
          const tx2 = await createMarketOrder(exchangeFacet, taker1, {
            positionId: yesId,
            collateralToken: erc20.address,
            amount: takerAmount,
            pricePerToken: priceBuy,
            minFillAmount: ethers.utils.parseUnits("1", erc20Decimals),
            expiry: 0,
            direction: buyDir
          });
          const rec2 = await tx2.wait();
    
          console.log("Gas Sim+Exec:", rec1.gasUsed.toString());
          console.log("Gas Direct:", rec2.gasUsed.toString());
        });
      });

    yesId = positionIds[0];
    noId = positionIds[1];

    await erc1155.connect(owner).setApprovalForAll(diamondAddress, true);
  });

  beforeEach(async () => {
    snapshotId = await takeSnapshot();
  });

  afterEach(async () => {
    await revertToSnapshot(snapshotId);
  });

          it("should handle very large order amounts in both modes", async () => {
          const largeAmount = ethers.utils.parseUnits("1000000", erc20Decimals); // 1M tokens
          const priceSell = ethers.utils.parseUnits("0.50", erc20Decimals);
          const priceBuy = ethers.utils.parseUnits("0.51", erc20Decimals);
    
          // Mint large amounts for testing
          const largeMintAmount = ethers.utils.parseUnits("1000000", erc20Decimals);
          const takerLargeAmount = ethers.utils.parseUnits(
            "1000000",
            erc20Decimals
          );
          const makerLargeAmount = ethers.utils.parseUnits(
            "1000000",
            erc20Decimals
          );
          await mintAndApproveERC20({
            token: erc20,
            minter: owner,
            to: taker1,
            amount: takerLargeAmount,
            spender: diamondAddress,
          });
          await mintAndApproveERC20({
            token: erc20,
            minter: owner,
            to: owner,
            amount: largeMintAmount,
            spender: diamondAddress,
          });

          // Split large amount of collateral

          await sendAndApproveERC1155({
            token: erc1155,
            sender: owner,
            to: maker1,
            tokenId: yesId,
            spender: diamondAddress,
            amount: makerLargeAmount,
          });

          console.log(
            "Maker ERC1155 Balance Before:",
            await erc1155.balanceOf(maker1.address, yesId)
          );

          const makerOrderId = await exchangeFacet.getNextOrderId();
          await createLimitOrder(exchangeFacet, maker1, {
            positionId: yesId,
            collateralToken: erc20.address,
            amount: largeAmount,
            pricePerToken: priceSell,
            minFillAmount: largeAmount,
            expiry: 0,
            direction: sellDir,
          });
          const makerOrderDetail = await exchangeFacet.getOrder(makerOrderId);
          console.log("makerOrderDetail:", makerOrderDetail);

          console.log(
            "Maker ERC1155 Balance After:",
            await erc1155.balanceOf(maker1.address, yesId)
          );

          // Calculate budget for large amount
          const largeBaseCost = largeAmount.mul(priceBuy).div(ercUnit);
          const largeFee = largeBaseCost.mul(feeConfig.takerBps).div(10_000);
          const largeBudget = largeBaseCost.add(largeFee);

          // Approach 1
          const route = await simulateAndParseMatchRoute({
            routeSimFacet,
            positionId: yesId,
            amount: largeBudget,
            direction: buyDir
          });
          console.log("Routes:", route);

          if (route.matches.length === 0) {
            console.log("No matches found in simulation - skipping execution for Approach 1");
          } else {
            await marketExecutionFacet.connect(taker1).fillMarketOrderWithRoute(
              yesId,
              largeAmount,
              priceBuy,
              false,
              buyDir,
              route.matches.map(m => [
                m.matchedOrderId,
                m.amount,
                m.effectivePrice,
                m.matchType
              ])
            );
          }

          // Reset for approach 2
          await revertToSnapshot(snapshotId);
          snapshotId = await takeSnapshot();

          // Recreate maker order for Approach 2
          await sendAndApproveERC1155({
            token: erc1155,
            sender: owner,
            to: maker1,
            tokenId: yesId,
            spender: diamondAddress,
            amount: makerLargeAmount
          });
          await createLimitOrder(exchangeFacet, maker1, {
            positionId: yesId,
            collateralToken: erc20.address,
            amount: largeAmount,
            pricePerToken: priceSell,
            minFillAmount: largeAmount,
            expiry: 0,
            direction: sellDir
          });

          await mintAndApproveERC20({
            token: erc20,
            minter: owner,
            to: taker1,
            amount: largeAmount,
            spender: diamondAddress,
          });

          await createMarketOrder(exchangeFacet, taker1, {
            positionId: yesId,
            collateralToken: erc20.address,
            amount: largeAmount,
            pricePerToken: priceBuy,
            minFillAmount: largeAmount,
            expiry: 0,
            direction: buyDir
          });
        });

  it("should execute market order via simulation+execution AND via direct-exec createLimitOrder(executionType=market) and compare", async () => {
    const amount = ethers.utils.parseUnits("5", erc20Decimals);
    const priceSell = ethers.utils.parseUnits("0.50", erc20Decimals); // Maker would recieve 0.5 - 1%
    const priceBuy = ethers.utils.parseUnits("0.51", erc20Decimals); // Taker has to pay 0.5 + 2%

    // Maker provides YES tokens for SELL order
    await erc1155
      .connect(owner)
      .safeTransferFrom(owner.address, maker1.address, yesId, amount, "0x");
    await erc1155.connect(maker1).setApprovalForAll(diamondAddress, true);

    await createLimitOrder(exchangeFacet, maker1, {
      positionId: yesId,
      collateralToken: erc20.address,
      amount,
      pricePerToken: priceSell,
      minFillAmount: amount,
      expiry: 0,
      direction: sellDir,
    });

    // Fund taker
    const baseCost = amount.mul(priceSell).div(ercUnit);
    const takerFee = baseCost.mul(feeConfig.takerBps).div(10_000);
    const totalCost = baseCost.add(takerFee);

    await mintAndApproveERC20({
      token: erc20,
      minter: owner,
      to: taker1,
      amount: totalCost,
      spender: diamondAddress,
    });

    // Approach 1: Simulation + Execution
    const route = await simulateAndParseMatchRoute({
      routeSimFacet,
      positionId: yesId,
      amount: totalCost,
      direction: buyDir,
    });

    const takerBalanceBeforeRoute = await erc20.balanceOf(taker1.address);
    await marketExecutionFacet.connect(taker1).fillMarketOrderWithRoute(
      yesId,
      amount,
      priceBuy,
      false,
      buyDir,
      route.matches.map((m) => [
        m.matchedOrderId,
        m.amount,
        m.effectivePrice,
        m.matchType,
      ])
    );
    const takerBalanceAfterRoute = await erc20.balanceOf(taker1.address);

    // Reset state for second approach
    await revertToSnapshot(snapshotId);
    snapshotId = await takeSnapshot();

    // Recreate maker order
    await erc1155
      .connect(owner)
      .safeTransferFrom(owner.address, maker1.address, yesId, amount, "0x");
    await erc1155.connect(maker1).setApprovalForAll(diamondAddress, true);

    await createLimitOrder(exchangeFacet, maker1, {
      positionId: yesId,
      collateralToken: erc20.address,
      amount,
      pricePerToken: priceSell,
      minFillAmount: amount,
      expiry: 0,
      direction: sellDir,
    });

    await mintAndApproveERC20({
      token: erc20,
      minter: owner,
      to: taker1,
      amount: totalCost,
      spender: diamondAddress,
    });

    // Approach 2: Direct Execution using createMarketOrder helper
    await createMarketOrder(exchangeFacet, taker1, {
      positionId: yesId,
      collateralToken: erc20.address,
      amount,
      pricePerToken: priceBuy,
      minFillAmount: amount,
      expiry: 0,
      direction: buyDir,
    });

    const takerBalanceAfterDirect = await erc20.balanceOf(taker1.address);

    // Compare
    console.log("Approach1 spent:", takerBalanceBeforeRoute.sub(takerBalanceAfterRoute).toString());
    console.log("Approach2 spent:", totalCost.sub(takerBalanceAfterDirect).toString());

    expect(takerBalanceAfterRoute.lt(takerBalanceBeforeRoute)).to.be.true;
    expect(takerBalanceAfterDirect.lt(totalCost)).to.be.true;
  });
});