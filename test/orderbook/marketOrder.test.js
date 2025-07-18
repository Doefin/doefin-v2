
const { deployDiamond } = require('../../scripts/deploy.js');
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployMockERC20 } = require("../mock/deployMocks");
const { BigNumber, utils } = require("ethers");
const {
    getConditionId,
    parseTransferBatch,
    computeTradeBreakdown
} = require("../utils.js")

describe("OrderbookFacet - Extended Tests", function () {
    let owner, user, maker, oracle, taker;
    let diamondAddress, orderbook, erc20, erc1155, conditionalFacet, conditionManagerFacet;
    let questionId, outcomeSlotCount, conditionId, mintAmount, unit, parentCollectionId;
    let yesId, noId, yesIndexSet, noIndexSet, yesAmount, noAmount, positionParams;
    let feeReceiver, makerFeeBps, takerFeeBps;
    let adminConfig;
    let snapshotId;

    before(async function () {
        [owner, user, maker, oracle, taker] = await ethers.getSigners();

        erc20 = await deployMockERC20("MockToken", "MOCK");

        diamondAddress = await deployDiamond();
        orderbook = await ethers.getContractAt("OrderbookFacet", diamondAddress);
        erc1155 = await ethers.getContractAt("ERC1155Facet", diamondAddress);
        conditionalFacet = await ethers.getContractAt("ConditionalTokensFacet", diamondAddress);
        conditionManagerFacet = await ethers.getContractAt("ConditionManagerFacet", diamondAddress);
        const accessControlFacet = await ethers.getContractAt('AccessControlFacet', diamondAddress);
        adminConfig = await ethers.getContractAt("AdminConfigFacet", diamondAddress);

        await adminConfig.connect(owner).addCollateralToken(erc20.address, ethers.utils.parseEther("1"));
        await accessControlFacet.addMarketMaker(owner.address);

        feeReceiver = maker.address;

        // Set fees: 2% maker, 1% taker
        makerFeeBps = 200;
        takerFeeBps = 100;
        await adminConfig.setTradingFeesBps(makerFeeBps, takerFeeBps);
        await adminConfig.setFeeReceiver(feeReceiver);

        questionId = ethers.utils.id("will-hashrate-increase?");
        outcomeSlotCount = 2;
        yesIndexSet = 1;
        noIndexSet = 2;
        conditionId = getConditionId(oracle.address, questionId, outcomeSlotCount);
        parentCollectionId = ethers.constants.HashZero;

        await conditionManagerFacet.connect(owner).createCondition(
            oracle.address,
            questionId,
            outcomeSlotCount,
            "ipfs://dummy"
        );

        unit = ethers.utils.parseEther("1");
        const collateralAmount = unit.mul(2);

        mintAmount = ethers.utils.parseEther("120")

        await erc20.mint(owner.address, mintAmount);
        await erc20.connect(owner).approve(diamondAddress, mintAmount);

        // Split position
        const splitTx = await conditionalFacet.connect(owner).splitPosition(
            erc20.address,
            ethers.constants.HashZero,
            conditionId,
            ethers.utils.parseEther("2"),
            [yesIndexSet, noIndexSet]
        );

        const receipt = await splitTx.wait();
        const { positionIds, amounts } = parseTransferBatch(receipt, ethers.constants.AddressZero, owner.address);

        yesId = positionIds[0];
        noId = positionIds[1];
        yesAmount = amounts[0];
        noAmount = amounts[1];

        positionParams = { positionId: yesId, indexSet: yesIndexSet, collateralToken: erc20.address, conditionId, parentCollectionId };

        await erc1155.connect(owner).setApprovalForAll(diamondAddress, true);
    });

    beforeEach(async () => {
        snapshotId = await ethers.provider.send("evm_snapshot", []);
    });

    afterEach(async () => {
        await ethers.provider.send("evm_revert", [snapshotId]);
    });

    it("should simulate and execute a BUY market order from multiple SELL limit orders", async () => {
        const firstOrderDir = 1; // Sell
        const secOrderDir = 1;   // Sell
        const matchOrderDir = 0; // Buy
        const matchOrderAmount = 8;

        // Limit order 1: Sell 5 @ 1.0
        const firstOrderAmount = 3;
        const firstOrderPrice = ethers.utils.parseEther("1.0");
        const firstBreakdown = computeTradeBreakdown(firstOrderAmount, firstOrderPrice, firstOrderDir, makerFeeBps, takerFeeBps);

        // Limit order 2: Sell 5 @ 0.8
        const secOrderAmount = 5;
        const secOrderPrice = ethers.utils.parseEther("0.8");
        const secBreakdown = computeTradeBreakdown(secOrderAmount, secOrderPrice, secOrderDir, makerFeeBps, takerFeeBps);

        const totalTakerPays = firstBreakdown.totalTakerPays.add(secBreakdown.totalTakerPays);

        // Set up user (taker)
        await erc20.mint(user.address, totalTakerPays);
        await erc20.connect(user).approve(diamondAddress, totalTakerPays);

        // Record balances before
        const balBefore = {
            makerErc20: await erc20.balanceOf(owner.address),
            makerErc1155: await erc1155.balanceOf(owner.address, yesId),
            takerErc20: await erc20.balanceOf(user.address),
            takerErc1155: await erc1155.balanceOf(user.address, yesId),
            // feeReceiver: await erc20.balanceOf(feeReceiver.address)
        };

        // Set up maker (owner)
        await erc1155.connect(owner).setApprovalForAll(diamondAddress, true);
        await orderbook.connect(owner).createLimitOrder(positionParams, firstOrderAmount, firstOrderPrice, 1, 0, firstOrderDir);
        await orderbook.connect(owner).createLimitOrder(positionParams, secOrderAmount, secOrderPrice, 1, 0, secOrderDir);

        const sim = await orderbook.connect(user).callStatic.simulateMarketOrder(positionParams, matchOrderAmount, matchOrderDir);
        await orderbook.connect(user).fillMarketOrderWithRoute(positionParams, matchOrderAmount, false, matchOrderDir, sim, 0);

        const balAfter = {
            makerErc20: await erc20.balanceOf(owner.address),
            makerErc1155: await erc1155.balanceOf(owner.address, yesId),
            takerErc20: await erc20.balanceOf(user.address),
            takerErc1155: await erc1155.balanceOf(user.address, yesId),
        };

        const totalMakerReceives = firstBreakdown.totalMakerReceives.add(secBreakdown.totalMakerReceives);
        const totalMakerFees = firstBreakdown.makerFee.add(secBreakdown.makerFee);
        const totalTakerFees = firstBreakdown.takerFee.add(secBreakdown.takerFee);

        // ✅ Assertions
        expect(balAfter.takerErc20).to.equal(balBefore.takerErc20.sub(totalTakerPays));
        expect(balAfter.takerErc1155).to.equal(balBefore.takerErc1155.add(matchOrderAmount));

        expect(balAfter.makerErc20).to.equal(balBefore.makerErc20.add(totalMakerReceives));
        expect(balAfter.makerErc1155).to.equal(balBefore.makerErc1155.sub(matchOrderAmount));

        // expect(balAfter.feeReceiver).to.equal(balBefore.feeReceiver.add(totalMakerFees).add(totalTakerFees));
    });

    it("should simulate and execute a SELL market order from multiple BUY limit orders", async () => {
        const firstOrderDir = 0; // Buy
        const secOrderDir = 0;   // Buy
        const matchOrderDir = 1; // Sell
        const matchOrderAmount = 8;

        const firstOrderAmount = 5;
        const firstOrderPrice = ethers.utils.parseEther("1.0");
        const firstBreakdown = computeTradeBreakdown(firstOrderAmount, firstOrderPrice, firstOrderDir, makerFeeBps, takerFeeBps);

        const secOrderAmount = 3;
        const secOrderPrice = ethers.utils.parseEther("0.8");
        const secBreakdown = computeTradeBreakdown(secOrderAmount, secOrderPrice, secOrderDir, makerFeeBps, takerFeeBps);

        const totalMakerLocks = firstBreakdown.totalMakerLocks.add(secBreakdown.totalMakerLocks);

        // Prepare seller (taker) with 10 YES
        await erc1155.connect(user).setApprovalForAll(diamondAddress, true);
        await erc1155.safeTransferFrom(owner.address, user.address, yesId, 10, "0x");

        await erc20.mint(owner.address, totalMakerLocks);
        await erc20.connect(owner).approve(diamondAddress, totalMakerLocks);

        const balBefore = {
            makerErc20: await erc20.balanceOf(owner.address),
            makerErc1155: await erc1155.balanceOf(owner.address, yesId),
            takerErc20: await erc20.balanceOf(user.address),
            takerErc1155: await erc1155.balanceOf(user.address, yesId)
        };

        console.log("balance before setup:", balBefore)
        console.log("Maker to pay amount:", totalMakerLocks)

        await orderbook.connect(owner).createLimitOrder(positionParams, firstOrderAmount, firstOrderPrice, 1, 0, firstOrderDir);
        await orderbook.connect(owner).createLimitOrder(positionParams, secOrderAmount, secOrderPrice, 1, 0, secOrderDir);

        const sim = await orderbook.connect(user).callStatic.simulateMarketOrder(positionParams, matchOrderAmount, matchOrderDir);
        console.log("Sim:", sim)
        await orderbook.connect(user).fillMarketOrderWithRoute(positionParams, matchOrderAmount, false, matchOrderDir, sim, 0);

        const balAfter = {
            makerErc20: await erc20.balanceOf(owner.address),
            makerErc1155: await erc1155.balanceOf(owner.address, yesId),
            takerErc20: await erc20.balanceOf(user.address),
            takerErc1155: await erc1155.balanceOf(user.address, yesId)
        };

        console.log("balance after setup:", balAfter)

        const totalMakerFees = firstBreakdown.makerFee.add(secBreakdown.makerFee);
        const totalTakerFees = firstBreakdown.takerFee.add(secBreakdown.takerFee);
        const totalMakerReceives = firstBreakdown.totalMakerReceives.add(secBreakdown.totalMakerReceives);
        const totalTakerReceives = firstBreakdown.cost.add(secBreakdown.cost).sub(totalTakerFees); // Seller (taker) receives cost - fee


        // ✅ Assertions
        expect(balAfter.takerErc20).to.equal(balBefore.takerErc20.add(totalTakerReceives));
        expect(balAfter.takerErc1155).to.equal(balBefore.takerErc1155.sub(matchOrderAmount));

        expect(balAfter.makerErc20).to.equal(balBefore.makerErc20.sub(totalMakerLocks));
        expect(balAfter.makerErc1155).to.equal(balBefore.makerErc1155.add(matchOrderAmount));

        // expect(balAfter.feeReceiver).to.equal(balBefore.feeReceiver.add(totalMakerFees).add(totalTakerFees));
    });

    it("should revert if fillOrKill is true and not enough liquidity", async () => {
        await orderbook.createLimitOrder(positionParams, 5, ethers.utils.parseEther("1"), 1, 0, 1);
        await expect(orderbook.simulateMarketOrder(positionParams, 6, 1)).to.be.revertedWith("simulateMarketOrder: Couldn't satisify the ammount");
    });

    it("should remove orders fully filled", async () => {
        const limitOrderDir = 1; // SELL
        const limitOrderAmount = 3;
        const matchOrderDir = 0 // Buy
        const matchOrderAmount = 8

        const limitOrderPricePerToken = ethers.utils.parseEther("1");

        const {
            cost: firstOrderCost,
            makerFee: firstOrderMakerFee,
            totalMakerLocks: firstOrderTotalMakerLocks
        } = computeTradeBreakdown(limitOrderAmount, limitOrderPricePerToken, limitOrderDir, makerFeeBps, takerFeeBps);

        await orderbook.createLimitOrder(positionParams, limitOrderAmount, limitOrderPricePerToken, 1, 0, limitOrderDir);

        const sim = await orderbook.simulateMarketOrder(positionParams, limitOrderAmount, matchOrderDir);
        await orderbook.fillMarketOrderWithRoute(positionParams, limitOrderAmount, false, matchOrderDir, sim, 0);
        const updatedSim = await orderbook.simulateMarketOrder(positionParams, 1, matchOrderDir).catch(() => true);
        expect(updatedSim).to.equal(true); // means reverted because no orders left
    });

    it("should skip expired orders", async () => {
        const now = (await ethers.provider.getBlock()).timestamp;
        await orderbook.createLimitOrder(positionParams, 5, ethers.utils.parseEther("1"), 1, now - 10, 1);
        await expect(orderbook.simulateMarketOrder(positionParams, 1, 0)).to.be.revertedWith("simulateMarketOrder: Couldn't satisify the ammount");
    });

    it("should keep order list sorted after inserts", async () => {
        await orderbook.createLimitOrder(positionParams, 5, ethers.utils.parseEther("2.0"), 1, 0, 1);
        await orderbook.createLimitOrder(positionParams, 5, ethers.utils.parseEther("1.5"), 1, 0, 1);
        await orderbook.createLimitOrder(positionParams, 5, ethers.utils.parseEther("1.0"), 1, 0, 1);
        const book = await orderbook.getOrderbook(yesId, 1);
        const prices = await Promise.all(book.map(id => orderbook.getOrder(id).then(o => o.pricePerToken)));
        const sorted = [...prices].sort((a, b) => (a.lt(b) ? -1 : a.gt(b) ? 1 : 0));
        expect(prices.map(p => p.toString())).to.eql(sorted.map(p => p.toString()));
    });

    it("should respect price-time priority when inserting orders", async () => {
        await erc20.mint(maker.address, mintAmount);
        await erc20.connect(maker).approve(diamondAddress, mintAmount);

        await erc20.mint(user.address, mintAmount);
        await erc20.connect(user).approve(diamondAddress, mintAmount);

        // Order 1 (earlier timestamp)
        await orderbook.connect(maker).createLimitOrder(positionParams, 5, ethers.utils.parseEther("1.0"), 1, 0, 0);
        const firstOrderId = await orderbook.getNextOrderId() - 1;

        // Order 2 (same price, different creator, later time)
        await orderbook.connect(user).createLimitOrder(positionParams, 5, ethers.utils.parseEther("1.0"), 1, 0, 0);
        const secondOrderId = await orderbook.getNextOrderId() - 1;

        // Order 3 (same price, different creator, later time)
        await orderbook.createLimitOrder(positionParams, 5, ethers.utils.parseEther("1.0"), 1, 0, 0);
        const thirdOrderId = await orderbook.getNextOrderId() - 1;

        // Simulate a market buy
        const result = await orderbook.callStatic.simulateMarketOrder(positionParams, 12, 1);
        const [matchedOrderIds, matchedAmounts] = result;

        expect(matchedOrderIds[0]).to.equal(firstOrderId);
        expect(matchedOrderIds[1]).to.equal(secondOrderId);
        expect(matchedOrderIds[2]).to.equal(thirdOrderId);

    });

    it("should fill entire market order if avg price is below maxAveragePrice", async () => {
        // Order 1 @ 1.0, Order 2 @ 1.1
        await orderbook.createLimitOrder(positionParams, 5, ethers.utils.parseEther("1.0"), 1, 0, 1);
        await orderbook.createLimitOrder(positionParams, 5, ethers.utils.parseEther("1.1"), 1, 0, 1);

        await erc20.mint(user.address, ethers.utils.parseEther("20"));
        await erc20.connect(user).approve(diamondAddress, ethers.utils.parseEther("20"));

        const maxAvgPrice = ethers.utils.parseEther("1.1"); // should allow full match

        const sim = await orderbook.connect(user).callStatic.simulateMarketOrder(positionParams, 10, 0);
        await orderbook.connect(user).fillMarketOrderWithRoute(positionParams, 10, false, 0, sim, maxAvgPrice);
    });

    it("should partially fill and stop when avg price exceeds maxAveragePrice", async () => {
        // Order 1 @ 1.0 (5 tokens), Order 2 @ 1.5 (5 tokens)
        await orderbook.createLimitOrder(positionParams, 5, ethers.utils.parseEther("1.0"), 1, 0, 1);
        await orderbook.createLimitOrder(positionParams, 5, ethers.utils.parseEther("1.5"), 1, 0, 1);

        await erc20.mint(maker.address, ethers.utils.parseEther("20"));
        await erc20.connect(maker).approve(diamondAddress, ethers.utils.parseEther("20"));

        const maxAvgPrice = ethers.utils.parseEther("1.2");

        const sim = await orderbook.connect(maker).callStatic.simulateMarketOrder(positionParams, 8, 0);

        const erc20BalanceBefore = await erc20.balanceOf(maker.address)
        const erc1155BalanceBefore = await erc1155.balanceOf(maker.address, yesId);

        console.log("ERC20 Balance before:", erc20BalanceBefore)
        console.log("ERC1155 Balance before:", erc1155BalanceBefore)

        await orderbook.connect(maker).fillMarketOrderWithRoute(positionParams, 8, false, 0, sim, maxAvgPrice);

        const erc1155BalanceAfter = await erc1155.balanceOf(maker.address, yesId);
        console.log("ERC1155 Balance After:", erc1155BalanceAfter)

        const erc20BalanceAfter = await erc20.balanceOf(maker.address)
        console.log("ERC20 Balance After:", erc20BalanceAfter)

        const erc20Spent = erc20BalanceBefore.sub(erc20BalanceAfter);
        const tokensReceived = erc1155BalanceAfter;

        console.log("Token spent:", erc20Spent)
        const actualAvgPrice = erc20Spent.div(tokensReceived);
        console.log("Actual average:", actualAvgPrice)

        console.log("Actual avg price (ETH):", ethers.utils.formatEther(actualAvgPrice));

        console.log("Max average:", maxAvgPrice)

        expect(actualAvgPrice.lte(maxAvgPrice)).to.be.true;

    });

    it("should revert if fillOrKill is true and avg price exceeds maxAveragePrice", async () => {
        await orderbook.createLimitOrder(positionParams, 5, ethers.utils.parseEther("1.0"), 1, 0, 1);
        await orderbook.createLimitOrder(positionParams, 5, ethers.utils.parseEther("1.5"), 1, 0, 1);

        await erc20.mint(user.address, ethers.utils.parseEther("20"));
        await erc20.connect(user).approve(diamondAddress, ethers.utils.parseEther("20"));

        const maxAvgPrice = ethers.utils.parseEther("1.2");

        const sim = await orderbook.connect(user).callStatic.simulateMarketOrder(positionParams, 10, 0);

        await expect(
            orderbook.connect(user).fillMarketOrderWithRoute(positionParams, 10, true, 0, sim, maxAvgPrice)
        ).to.be.revertedWith("Orderbook: FillOrKill failed");
    });

    it("should correctly charge maker and taker fees on a BUY market order", async () => {

        const amount = 5;
        const pricePerToken = ethers.utils.parseEther("1.0");
        const cost = pricePerToken.mul(amount);
        const makerFee = cost.mul(makerFeeBps).div(10_000);
        const takerFee = cost.mul(takerFeeBps).div(10_000);
        const totalTakerPays = cost.add(takerFee);
        const totalMakerReceives = cost.sub(makerFee);

        // Maker creates SELL limit order
        await orderbook.createLimitOrder(positionParams, amount, pricePerToken, 1, 0, 1);

        // Taker mints and approves enough collateral (cost + takerFee)
        await erc20.mint(user.address, totalTakerPays);
        await erc20.connect(user).approve(diamondAddress, totalTakerPays);

        // Snapshot balances before trade
        const balBefore = {
            taker: await erc20.balanceOf(user.address),
            maker: await erc20.balanceOf(owner.address),
        };

        // Simulate and fill market order
        const sim = await orderbook.connect(user).callStatic.simulateMarketOrder(positionParams, amount, 0);
        await orderbook.connect(user).fillMarketOrderWithRoute(positionParams, amount, false, 0, sim, 0);

        // Snapshot balances after trade
        const balAfter = {
            taker: await erc20.balanceOf(user.address),
            maker: await erc20.balanceOf(owner.address),
        };

        // Check final balances
        expect(balAfter.taker).to.equal(balBefore.taker.sub(totalTakerPays));
        expect(balAfter.maker).to.equal(balBefore.maker.add(totalMakerReceives));

        // Check that taker received ERC1155 positions
        const positionBal = await erc1155.balanceOf(user.address, yesId);
        expect(positionBal).to.equal(amount);
    });

    it("should lock cost + makerFee when creating a BUY limit order", async () => {
        const adminConfig = await ethers.getContractAt("AdminConfigFacet", diamondAddress);
        await adminConfig.setTradingFeesBps(250, 150); // 2.5% maker, 1.5% taker

        const price = ethers.utils.parseEther("1.0");
        const amount = 10;
        const cost = price.mul(amount);
        const makerFee = cost.mul(250).div(10_000);
        const total = cost.add(makerFee);

        await erc20.mint(maker.address, total);
        await erc20.connect(maker).approve(diamondAddress, total);

        await expect(
            orderbook.connect(maker).createLimitOrder(positionParams, amount, price, 1, 0, 0)
        ).to.not.be.reverted;

        const bal = await orderbook.getCollateralBalance(maker.address, erc20.address);
        expect(bal).to.equal(total);
    });

    it("should settle order with original fee config even after admin changes global fees", async () => {
        const orderDir = 0; // Buy
        const orderAmount = 5;
        const orderPrice = ethers.utils.parseEther("1.0");

        const matchOrderDir = 1; // Sell
        const matchOrderAmount = 5;

        const orderBreakdown = computeTradeBreakdown(orderAmount, orderPrice, orderDir, makerFeeBps, takerFeeBps);

        // Prepare seller (taker) with 10 YES
        await erc1155.connect(user).setApprovalForAll(diamondAddress, true);
        await erc1155.safeTransferFrom(owner.address, user.address, yesId, 10, "0x");

        await erc20.mint(owner.address, orderBreakdown.totalMakerLocks);
        await erc20.connect(owner).approve(diamondAddress, orderBreakdown.totalMakerLocks);

        const balBefore = {
            makerErc20: await erc20.balanceOf(owner.address),
            makerErc1155: await erc1155.balanceOf(owner.address, yesId),
            takerErc20: await erc20.balanceOf(user.address),
            takerErc1155: await erc1155.balanceOf(user.address, yesId)
        };

        await orderbook.connect(owner).createLimitOrder(positionParams, orderAmount, orderPrice, 1, 0, orderDir);

        // Change global fees
        await adminConfig.setTradingFeesBps(800, 700); // now 8% / 7%

        const sim = await orderbook.connect(user).callStatic.simulateMarketOrder(positionParams, matchOrderAmount, matchOrderDir);
        await orderbook.connect(user).fillMarketOrderWithRoute(positionParams, matchOrderAmount, false, matchOrderDir, sim, 0);

        const balAfter = {
            makerErc20: await erc20.balanceOf(owner.address),
            makerErc1155: await erc1155.balanceOf(owner.address, yesId),
            takerErc20: await erc20.balanceOf(user.address),
            takerErc1155: await erc1155.balanceOf(user.address, yesId)
        };

        const totalTakerReceives = orderBreakdown.cost.sub(orderBreakdown.takerFee); // Seller (taker) receives cost - fee

        // ✅ Assertions
        expect(balAfter.takerErc20).to.equal(balBefore.takerErc20.add(totalTakerReceives));
        expect(balAfter.takerErc1155).to.equal(balBefore.takerErc1155.sub(matchOrderAmount));

        expect(balAfter.makerErc20).to.equal(balBefore.makerErc20.sub(orderBreakdown.totalMakerLocks));
        expect(balAfter.makerErc1155).to.equal(balBefore.makerErc1155.add(matchOrderAmount));
    });
    it("should correctly release remaining escrow after partial fill and emit EscrowReleased", async () => {
        const orderDir = 0; // Buy
        const orderAmount = 10;
        const orderPrice = ethers.utils.parseEther("1"); // 1 USDC/token
        const partialFill = 4;

        const breakdown = computeTradeBreakdown(orderAmount, orderPrice, orderDir, makerFeeBps, takerFeeBps);

        await erc20.mint(taker.address, breakdown.totalMakerLocks);
        await erc20.connect(taker).approve(diamondAddress, breakdown.totalMakerLocks);

        await erc1155.connect(user).setApprovalForAll(diamondAddress, true);
        await erc1155.safeTransferFrom(owner.address, user.address, yesId, 10, "0x");

        const tx = await orderbook.connect(taker).createLimitOrder(
            positionParams, orderAmount, orderPrice, 0, 0, orderDir
        );
        const receipt = await tx.wait();
        const orderId = receipt.events.find(e => e.event === "OrderCreated").args.orderId;

        // Now simulate a taker partially filling 4 tokens
        const route = {
            matchedOrderIds: [orderId],
            matchedAmounts: [partialFill],
        };

        await orderbook.connect(user).fillMarketOrderWithRoute(
            positionParams,
            partialFill,
            false,
            1, // Sell
            route,
            0
        );

        // Maker cancels the remaining 6 tokens
        const remaining = orderAmount - partialFill;
        const expectedRelease = remaining * orderPrice;
        const expectedMakerFee = expectedRelease * makerFeeBps / 10000;
        const totalRelease = expectedRelease + expectedMakerFee;

        await expect(orderbook.connect(taker).cancelOrder(orderId)).to.emit(orderbook, "EscrowReleased").withArgs(
            taker.address,
            positionParams.collateralToken,
            positionParams.positionId,
            remaining,
            orderPrice,
            orderDir
        );
        const postBal = await erc20.balanceOf(taker.address);
        expect(postBal).to.eq(BigNumber.from(totalRelease.toString()));

    });

});
