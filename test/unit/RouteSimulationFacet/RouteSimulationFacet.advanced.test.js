const { deployDiamond } = require('../../../scripts/deploy.js');
const { expect } = require("chai");
const { ethers } = require("hardhat");

const { deployMockERC20 } = require("../../mock/deployMocks.js");
const { getConditionId } = require("../../utils/ctfUtils.js");
const { getFees, addCollateralToken } = require("../../utils/adminConfigUtils.js")
const { mintAndApproveERC20 } = require("../../utils/erc20Utils.js")
const { splitConditionAndGetPositionIds } = require("../../utils/conditionUtils.js");
const { createLimitOrder } = require("../../utils/orderUtils.js");
const { takeSnapshot, revertToSnapshot } = require("../../utils/snapshotUtils.js");
const { simulateAndParseMatchRoute } = require("../../utils/simulationUtils.js");

describe("RouteSimulationFacet - Advanced Test Cases", function () {
    let owner, user, maker, oracle, taker, maker2, maker3, maker4;
    let diamondAddress, routeSimFacet, exchangeFacet, erc20, ercUnit, erc1155, conditionalFacet, conditionManagerFacet, adminConfig;
    let questionId, conditionId, yesId, noId;
    let mintAmount, unit;
    let buyDir, sellDir, feeConfig;
    let snapshotId;

    before(async function () {
        [owner, user, maker, oracle, taker, maker2, maker3, maker4] = await ethers.getSigners();

        erc20 = await deployMockERC20("MockToken", "MOCK");

        buyDir = 0;
        sellDir = 1;

        diamondAddress = await deployDiamond();

        exchangeFacet = await ethers.getContractAt("ExchangeFacet", diamondAddress);
        erc1155 = await ethers.getContractAt("ERC1155Facet", diamondAddress);
        conditionalFacet = await ethers.getContractAt("ConditionalTokensFacet", diamondAddress);
        conditionManagerFacet = await ethers.getContractAt("ConditionManagerFacet", diamondAddress);
        adminConfig = await ethers.getContractAt("AdminConfigFacet", diamondAddress);
        routeSimFacet = await ethers.getContractAt("RouteSimulationFacet", diamondAddress);
        const accessControlFacet = await ethers.getContractAt("AccessControlFacet", diamondAddress);

        await accessControlFacet.addMarketMaker(owner.address);

        ercUnit = ethers.utils.parseEther("1");

        await addCollateralToken({ adminConfig: adminConfig, token: erc20, unit: ercUnit, caller: owner });
        feeConfig = await getFees(adminConfig);

        questionId = ethers.utils.id("will-hashrate-increase?");
        const outcomeSlotCount = 2;
        conditionId = getConditionId(oracle.address, questionId, outcomeSlotCount);

        await conditionManagerFacet.connect(owner).createCondition(
            oracle.address,
            questionId,
            outcomeSlotCount,
            "ipfs://dummy"
        );

        unit = ethers.utils.parseEther("1");
        mintAmount = ethers.utils.parseEther("1000");

        await mintAndApproveERC20({
            token: erc20,
            minter: owner,
            to: owner,
            amount: mintAmount,
            spender: diamondAddress
        });

        const [positionIds, _amounts] = await splitConditionAndGetPositionIds({
            user: owner,
            amount: unit.mul(200),
            conditionId,
            indexSets: [1, 2],
            erc20,
            conditionalFacet
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

    describe("Complex Multi-Order Routing", function () {
        it("should find optimal route across multiple price levels", async () => {
            const totalAmount = ethers.utils.parseEther("25");
            const prices = [
                ethers.utils.parseEther("0.4"),
                ethers.utils.parseEther("0.5"),
                ethers.utils.parseEther("0.6"),
                ethers.utils.parseEther("0.7")
            ];
            const amounts = [
                ethers.utils.parseEther("5"),
                ethers.utils.parseEther("8"),
                ethers.utils.parseEther("6"),
                ethers.utils.parseEther("10")
            ];

            // Create multiple SELL orders at different price levels
            for (let i = 0; i < prices.length; i++) {
                await erc1155.connect(owner).safeTransferFrom(
                    owner.address,
                    maker.address,
                    yesId,
                    amounts[i],
                    "0x"
                );
            }
            await erc1155.connect(maker).setApprovalForAll(diamondAddress, true);

            for (let i = 0; i < prices.length; i++) {
                await createLimitOrder(exchangeFacet, maker, {
                    positionId: yesId,
                    collateralToken: erc20.address,
                    amount: amounts[i],
                    pricePerToken: prices[i],
                    minFillAmount: amounts[i],
                    expiry: 0,
                    direction: sellDir
                });
            }

            // Simulate BUY order that spans multiple price levels
            const route = await simulateAndParseMatchRoute({
                routeSimFacet,
                positionId: yesId,
                amount: totalAmount,
                direction: buyDir
            });

            // Should match orders in price-ascending order (best prices first)
            expect(route.matches.length).to.be.greaterThan(1);
            
            // Verify price ordering (should start with lowest prices)
            for (let i = 0; i < route.matches.length - 1; i++) {
                if (route.matches[i].matchType === 0 && route.matches[i + 1].matchType === 0) {
                    expect(route.matches[i].effectivePrice.lte(route.matches[i + 1].effectivePrice)).to.be.true;
                }
            }

            // Verify total amount is covered
            const totalMatched = route.matches.reduce((sum, match) => sum.add(match.amount), ethers.constants.Zero);
            expect(totalMatched).to.equal(totalAmount);
        });

        it("should optimize route selection for partial fills", async () => {
            const requestedAmount = ethers.utils.parseEther("15");
            const availableAmounts = [
                ethers.utils.parseEther("10"),
                ethers.utils.parseEther("8"),
                ethers.utils.parseEther("5")
            ];
            const prices = [
                ethers.utils.parseEther("0.3"),
                ethers.utils.parseEther("0.4"),
                ethers.utils.parseEther("0.5")
            ];

            // Create orders with different amounts and prices
            for (let i = 0; i < prices.length; i++) {
                await erc1155.connect(owner).safeTransferFrom(
                    owner.address,
                    maker.address,
                    yesId,
                    availableAmounts[i],
                    "0x"
                );
            }
            await erc1155.connect(maker).setApprovalForAll(diamondAddress, true);

            for (let i = 0; i < prices.length; i++) {
                await createLimitOrder(exchangeFacet, maker, {
                    positionId: yesId,
                    collateralToken: erc20.address,
                    amount: availableAmounts[i],
                    pricePerToken: prices[i],
                    minFillAmount: ethers.utils.parseEther("1"), // Allow partial fills
                    expiry: 0,
                    direction: sellDir
                });
            }

            const route = await simulateAndParseMatchRoute({
                routeSimFacet,
                positionId: yesId,
                amount: requestedAmount,
                direction: buyDir
            });

            // Should prioritize best prices and optimize partial fills
            expect(route.matches.length).to.be.greaterThan(0);
            
            const totalMatched = route.matches.reduce((sum, match) => sum.add(match.amount), ethers.constants.Zero);
            expect(totalMatched).to.equal(requestedAmount);

            // First match should be at best price
            const firstComplementaryMatch = route.matches.find(m => m.matchType === 0);
            if (firstComplementaryMatch) {
                expect(firstComplementaryMatch.effectivePrice).to.equal(
                    prices[0].add(prices[0].mul(feeConfig.takerBps).div(10000))
                );
            }
        });

        it("should handle mixed match types in optimal order", async () => {
            const requestedAmount = ethers.utils.parseEther("30");
            const orderAmount = ethers.utils.parseEther("10");
            const complementaryPrice = ethers.utils.parseEther("0.6");
            const mintPrice = ethers.utils.parseEther("0.3"); // BUY NO at 0.3 = mint YES at 0.7

            // Create one SELL order on YES (complementary match)
            await erc1155.connect(owner).safeTransferFrom(
                owner.address,
                maker.address,
                yesId,
                orderAmount,
                "0x"
            );
            await erc1155.connect(maker).setApprovalForAll(diamondAddress, true);

            await createLimitOrder(exchangeFacet, maker, {
                positionId: yesId,
                collateralToken: erc20.address,
                amount: orderAmount,
                pricePerToken: complementaryPrice,
                minFillAmount: orderAmount,
                expiry: 0,
                direction: sellDir
            });

            // Create multiple BUY orders on NO (for mint matches when buying YES)
            const totalMintAmount = ethers.utils.parseEther("20"); // 20 ETH for mint matches
            const mintCost = totalMintAmount.mul(mintPrice).div(ercUnit);
            const mintFee = mintCost.mul(feeConfig.makerBps).div(10000);
            await mintAndApproveERC20({
                token: erc20,
                minter: owner,
                to: maker2,
                amount: mintCost.add(mintFee),
                spender: diamondAddress
            });

            await createLimitOrder(exchangeFacet, maker2, {
                positionId: noId,
                collateralToken: erc20.address,
                amount: totalMintAmount,
                pricePerToken: mintPrice,
                minFillAmount: orderAmount,
                expiry: 0,
                direction: buyDir
            });

            // Simulate large BUY order (should use complementary + mint)
            const route = await simulateAndParseMatchRoute({
                routeSimFacet,
                positionId: yesId,
                amount: requestedAmount,
                direction: buyDir
            });

            // Should have both complementary and mint matches
            const complementaryMatches = route.matches.filter(m => m.matchType === 0);
            const mintMatches = route.matches.filter(m => m.matchType === 1);

            expect(complementaryMatches.length).to.be.greaterThan(0);
            expect(mintMatches.length).to.be.greaterThan(0);

            // Total should equal requested amount
            const totalMatched = route.matches.reduce((sum, match) => sum.add(match.amount), ethers.constants.Zero);
            expect(totalMatched).to.equal(requestedAmount);
        });
    });

    describe("Price Optimization", function () {
        it("should find best average price across multiple orders", async () => {
            const amount = ethers.utils.parseEther("20");
            
            // Create orders with varying prices
            const orderConfigs = [
                { amount: ethers.utils.parseEther("5"), price: ethers.utils.parseEther("0.2") },
                { amount: ethers.utils.parseEther("8"), price: ethers.utils.parseEther("0.4") },
                { amount: ethers.utils.parseEther("7"), price: ethers.utils.parseEther("0.6") },
                { amount: ethers.utils.parseEther("10"), price: ethers.utils.parseEther("0.8") }
            ];

            for (const config of orderConfigs) {
                await erc1155.connect(owner).safeTransferFrom(
                    owner.address,
                    maker.address,
                    yesId,
                    config.amount,
                    "0x"
                );
            }
            await erc1155.connect(maker).setApprovalForAll(diamondAddress, true);

            for (const config of orderConfigs) {
                await createLimitOrder(exchangeFacet, maker, {
                    positionId: yesId,
                    collateralToken: erc20.address,
                    amount: config.amount,
                    pricePerToken: config.price,
                    minFillAmount: config.amount,
                    expiry: 0,
                    direction: sellDir
                });
            }

            const route = await simulateAndParseMatchRoute({
                routeSimFacet,
                positionId: yesId,
                amount,
                direction: buyDir
            });

            // Calculate expected average price (should use cheapest orders first)
            const expectedCost = orderConfigs[0].amount.mul(orderConfigs[0].price)
                .add(orderConfigs[1].amount.mul(orderConfigs[1].price))
                .add(ethers.utils.parseEther("7").mul(orderConfigs[2].price)); // Partial fill of third order

            const expectedAvgPrice = expectedCost.div(amount);
            const actualAvgPrice = route.totalOutputAmount.mul(ercUnit).div(route.totalInputAmount);

            // Should be close to expected (accounting for fees)
            const tolerance = ethers.utils.parseEther("0.05"); // 5% tolerance
            expect(actualAvgPrice.sub(expectedAvgPrice).abs().lt(tolerance)).to.be.true;
        });

        it("should optimize for SELL orders (maximize received amount)", async () => {
            const sellAmount = ethers.utils.parseEther("15");
            
            // Create BUY orders at different prices
            const buyOrders = [
                { amount: ethers.utils.parseEther("6"), price: ethers.utils.parseEther("0.8") },
                { amount: ethers.utils.parseEther("5"), price: ethers.utils.parseEther("0.6") },
                { amount: ethers.utils.parseEther("8"), price: ethers.utils.parseEther("0.4") }
            ];

            for (const order of buyOrders) {
                const cost = order.amount.mul(order.price).div(ercUnit);
                const fee = cost.mul(feeConfig.makerBps).div(10000);
                const totalCost = cost.add(fee);

                await mintAndApproveERC20({
                    token: erc20,
                    minter: owner,
                    to: maker,
                    amount: totalCost,
                    spender: diamondAddress
                });

                await createLimitOrder(exchangeFacet, maker, {
                    positionId: yesId,
                    collateralToken: erc20.address,
                    amount: order.amount,
                    pricePerToken: order.price,
                    minFillAmount: order.amount,
                    expiry: 0,
                    direction: buyDir
                });
            }

            // Give taker tokens to sell
            await erc1155.connect(owner).safeTransferFrom(
                owner.address,
                taker.address,
                yesId,
                sellAmount,
                "0x"
            );

            const route = await simulateAndParseMatchRoute({
                routeSimFacet,
                positionId: yesId,
                amount: sellAmount,
                direction: sellDir
            });

            // Should prioritize highest-price BUY orders first
            const complementaryMatches = route.matches.filter(m => m.matchType === 0);
            if (complementaryMatches.length > 1) {
                for (let i = 0; i < complementaryMatches.length - 1; i++) {
                    expect(complementaryMatches[i].effectivePrice.gte(complementaryMatches[i + 1].effectivePrice)).to.be.true;
                }
            }
        });
    });

    describe("Edge Cases and Boundary Conditions", function () {
        it("should handle very small order amounts", async () => {
            const smallAmount = ethers.utils.parseUnits("1", 6); // Very small amount
            const price = ethers.utils.parseEther("0.5");

            // Create matching order
            await erc1155.connect(owner).safeTransferFrom(
                owner.address,
                maker.address,
                yesId,
                ethers.utils.parseEther("1"),
                "0x"
            );
            await erc1155.connect(maker).setApprovalForAll(diamondAddress, true);

            await createLimitOrder(exchangeFacet, maker, {
                positionId: yesId,
                collateralToken: erc20.address,
                amount: ethers.utils.parseEther("1"),
                pricePerToken: price,
                minFillAmount: smallAmount,
                expiry: 0,
                direction: sellDir
            });

            const route = await simulateAndParseMatchRoute({
                routeSimFacet,
                positionId: yesId,
                amount: smallAmount,
                direction: buyDir
            });

            console.log("Small amount:", smallAmount)
            console.log("Route:", route)

            expect(route.matches.length).to.be.greaterThan(0);
            expect(route.totalInputAmount).to.equal(smallAmount);
        });

        it("should handle maximum order amounts", async () => {
            const maxAmount = ethers.utils.parseEther("1000");
            const mintPrice = ethers.utils.parseEther("0.5");

            // Create BUY order on NO (for mint match when buying YES)
            const mintCost = maxAmount.mul(mintPrice).div(ercUnit);
            const mintFee = mintCost.mul(feeConfig.makerBps).div(10000);
            await mintAndApproveERC20({
                token: erc20,
                minter: owner,
                to: maker,
                amount: mintCost.add(mintFee),
                spender: diamondAddress
            });

            await createLimitOrder(exchangeFacet, maker, {
                positionId: noId,
                collateralToken: erc20.address,
                amount: maxAmount,
                pricePerToken: mintPrice,
                minFillAmount: maxAmount,
                expiry: 0,
                direction: buyDir
            });

            // Simulate very large order (should be mint match)
            const route = await simulateAndParseMatchRoute({
                routeSimFacet,
                positionId: yesId,
                amount: maxAmount,
                direction: buyDir
            });

            expect(route.matches.length).to.equal(1);
            expect(route.matches[0].matchType).to.equal(1); // Mint match
            expect(route.totalInputAmount).to.equal(maxAmount);
        });

        it("should handle zero liquidity scenarios", async () => {
            const amount = ethers.utils.parseEther("10");

            // No orders exist - should throw NoMatchableOrders error
            try {
                await simulateAndParseMatchRoute({
                    routeSimFacet,
                    positionId: yesId,
                    amount,
                    direction: buyDir
                });
                expect.fail("Should have thrown NoMatchableOrders error");
            } catch (error) {
                expect(error.message).to.include("NoMatchableOrders");
            }
        });

        it("should handle orders with minimum fill requirements", async () => {
            const requestedAmount = ethers.utils.parseEther("3");
            const orderAmount = ethers.utils.parseEther("10");
            const minFill = ethers.utils.parseEther("5"); // Higher than requested
            const price = ethers.utils.parseEther("0.5");

            // Create order with high minimum fill
            await erc1155.connect(owner).safeTransferFrom(
                owner.address,
                maker.address,
                yesId,
                orderAmount,
                "0x"
            );
            await erc1155.connect(maker).setApprovalForAll(diamondAddress, true);

            await createLimitOrder(exchangeFacet, maker, {
                positionId: yesId,
                collateralToken: erc20.address,
                amount: orderAmount,
                pricePerToken: price,
                minFillAmount: minFill,
                expiry: 0,
                direction: sellDir
            });

            // Should skip the order due to min fill requirement and throw error (no other matches available)
            try {
                await simulateAndParseMatchRoute({
                    routeSimFacet,
                    positionId: yesId,
                    amount: requestedAmount,
                    direction: buyDir
                });
                expect.fail("Should have thrown NoMatchableOrders error");
            } catch (error) {
                expect(error.message).to.include("NoMatchableOrders");
            }
        });
    });

    describe("Performance and Scalability", function () {
        it("should handle large orderbook efficiently", async () => {
            const numOrders = 50;
            const baseAmount = ethers.utils.parseEther("2");
            const basePrice = ethers.utils.parseEther("0.1");

            // Create many orders
            for (let i = 0; i < numOrders; i++) {
                await erc1155.connect(owner).safeTransferFrom(
                    owner.address,
                    maker.address,
                    yesId,
                    baseAmount,
                    "0x"
                );
            }
            await erc1155.connect(maker).setApprovalForAll(diamondAddress, true);

            for (let i = 0; i < numOrders; i++) {
                const price = basePrice.add(ethers.utils.parseEther((i * 0.01).toString()));
                await createLimitOrder(exchangeFacet, maker, {
                    positionId: yesId,
                    collateralToken: erc20.address,
                    amount: baseAmount,
                    pricePerToken: price,
                    minFillAmount: baseAmount,
                    expiry: 0,
                    direction: sellDir
                });
            }

            const startTime = Date.now();

            // Simulate order that spans many price levels
            const route = await simulateAndParseMatchRoute({
                routeSimFacet,
                positionId: yesId,
                amount: ethers.utils.parseEther("80"), // Will match many orders
                direction: buyDir
            });

            const endTime = Date.now();

            console.log(`Large orderbook simulation time: ${endTime - startTime}ms`);
            console.log(`Number of matches found: ${route.matches.length}`);

            // Should complete within reasonable time
            expect(endTime - startTime).to.be.lessThan(5000); // 5 seconds
            expect(route.matches.length).to.be.greaterThan(10);
        });

        it("should optimize gas estimation for complex routes", async () => {
            const amount = ethers.utils.parseEther("25");
            
            // Create orders that will result in complex routing
            const configs = [
                { amount: ethers.utils.parseEther("5"), price: ethers.utils.parseEther("0.3") },
                { amount: ethers.utils.parseEther("8"), price: ethers.utils.parseEther("0.4") },
                { amount: ethers.utils.parseEther("6"), price: ethers.utils.parseEther("0.5") },
                { amount: ethers.utils.parseEther("4"), price: ethers.utils.parseEther("0.6") }
            ];

            for (const config of configs) {
                await erc1155.connect(owner).safeTransferFrom(
                    owner.address,
                    maker.address,
                    yesId,
                    config.amount,
                    "0x"
                );
            }
            await erc1155.connect(maker).setApprovalForAll(diamondAddress, true);

            for (const config of configs) {
                await createLimitOrder(exchangeFacet, maker, {
                    positionId: yesId,
                    collateralToken: erc20.address,
                    amount: config.amount,
                    pricePerToken: config.price,
                    minFillAmount: config.amount,
                    expiry: 0,
                    direction: sellDir
                });
            }

            const route = await simulateAndParseMatchRoute({
                routeSimFacet,
                positionId: yesId,
                amount,
                direction: buyDir
            });

            // Route should be optimized for execution efficiency
            expect(route.matches.length).to.be.lessThan(10); // Reasonable number of matches
            
            // Verify route completeness - should match available orders (23 ETH total)
            const totalMatched = route.matches.reduce((sum, match) => sum.add(match.amount), ethers.constants.Zero);
            const availableAmount = ethers.utils.parseEther("23"); // 5+8+6+4 = 23 ETH available
            expect(totalMatched).to.equal(availableAmount);
        });
    });

    describe("Route Validation and Consistency", function () {
        it("should return consistent results for identical queries", async () => {
            const amount = ethers.utils.parseEther("10");
            const price = ethers.utils.parseEther("0.5");

            // Create order
            await erc1155.connect(owner).safeTransferFrom(
                owner.address,
                maker.address,
                yesId,
                amount,
                "0x"
            );
            await erc1155.connect(maker).setApprovalForAll(diamondAddress, true);

            await createLimitOrder(exchangeFacet, maker, {
                positionId: yesId,
                collateralToken: erc20.address,
                amount,
                pricePerToken: price,
                minFillAmount: amount,
                expiry: 0,
                direction: sellDir
            });

            // Query multiple times
            const route1 = await simulateAndParseMatchRoute({
                routeSimFacet,
                positionId: yesId,
                amount,
                direction: buyDir
            });

            const route2 = await simulateAndParseMatchRoute({
                routeSimFacet,
                positionId: yesId,
                amount,
                direction: buyDir
            });

            const route3 = await simulateAndParseMatchRoute({
                routeSimFacet,
                positionId: yesId,
                amount,
                direction: buyDir
            });

            // All routes should be identical
            expect(route1.matches.length).to.equal(route2.matches.length);
            expect(route2.matches.length).to.equal(route3.matches.length);
            expect(route1.totalInputAmount).to.equal(route2.totalInputAmount);
            expect(route2.totalInputAmount).to.equal(route3.totalInputAmount);
        });

        it("should validate route mathematical correctness", async () => {
            const amount = ethers.utils.parseEther("15");
            
            // Create multiple orders
            const orders = [
                { amount: ethers.utils.parseEther("6"), price: ethers.utils.parseEther("0.4") },
                { amount: ethers.utils.parseEther("5"), price: ethers.utils.parseEther("0.6") },
                { amount: ethers.utils.parseEther("8"), price: ethers.utils.parseEther("0.8") }
            ];

            for (const order of orders) {
                await erc1155.connect(owner).safeTransferFrom(
                    owner.address,
                    maker.address,
                    yesId,
                    order.amount,
                    "0x"
                );
            }
            await erc1155.connect(maker).setApprovalForAll(diamondAddress, true);

            for (const order of orders) {
                await createLimitOrder(exchangeFacet, maker, {
                    positionId: yesId,
                    collateralToken: erc20.address,
                    amount: order.amount,
                    pricePerToken: order.price,
                    minFillAmount: order.amount,
                    expiry: 0,
                    direction: sellDir
                });
            }

            const route = await simulateAndParseMatchRoute({
                routeSimFacet,
                positionId: yesId,
                amount,
                direction: buyDir
            });

            // Verify mathematical consistency
            const totalInputAmount = route.matches.reduce((sum, match) => sum.add(match.amount), ethers.constants.Zero);
            expect(totalInputAmount).to.equal(route.totalInputAmount);
            expect(totalInputAmount).to.equal(amount);

            // Verify cost calculation
            let expectedCost = ethers.constants.Zero;
            for (const match of route.matches) {
                if (match.matchType === 0) { // Complementary match
                    const baseCost = match.amount.mul(match.effectivePrice).div(ercUnit);
                    expectedCost = expectedCost.add(baseCost);
                } else if (match.matchType === 1) { // Mint match
                    const baseCost = match.amount.mul(match.effectivePrice).div(ercUnit);
                    expectedCost = expectedCost.add(baseCost);
                }
            }

            // Should be close to totalOutputAmount (accounting for rounding)
            const tolerance = ethers.utils.parseEther("0.001");
            expect(route.totalOutputAmount.sub(expectedCost).abs().lt(tolerance)).to.be.true;
        });
    });
});