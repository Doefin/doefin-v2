const { deployDiamond } = require('../../scripts/deploy.js');
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployMockERC20 } = require("../mock/deployMocks");
const {
    getConditionId,
    parseTransferBatch
} = require("../utils.js")

describe("OrderbookFacet", function () {
    let owner, user, oracle;
    let questionId, outcomeSlotCount, conditionId, unit, collateralToken;
    let orderbook, erc20;
    let buyDir, sellDir;
    let yesId, noId, yesIndexSet, noIndexSet, yesAmount, noAmount;

    beforeEach(async function () {
        [owner, user, oracle] = await ethers.getSigners();

        buyDir, sellDir = 0, 1;

        // Deploy mocks
        erc20 = await deployMockERC20("MockToken", "MOCK");

        collateralToken = erc20.address;

        // Deploy diamond and get facets
        diamondAddress = await deployDiamond();
        conditionalFacet = await ethers.getContractAt('ConditionalTokensFacet', diamondAddress);
        conditionManagerFacet = await ethers.getContractAt('ConditionManagerFacet', diamondAddress);
        erc1155 = await ethers.getContractAt("ERC1155Facet", diamondAddress);
        orderbook = await ethers.getContractAt("OrderbookFacet", diamondAddress);
        accessControlFacet = await ethers.getContractAt('AccessControlFacet', diamondAddress);
        const adminConfig = await ethers.getContractAt("AdminConfigFacet", diamondAddress);
        await adminConfig.connect(owner).addCollateralToken(collateralToken, ethers.utils.parseEther("1"));

        // Add `maker` as market maker
        await accessControlFacet.addMarketMaker(owner.address);

        // Prepare condition
        questionId = ethers.utils.id("will-hashrate-increase?");
        outcomeSlotCount = 2;
        conditionId = getConditionId(oracle.address, questionId, outcomeSlotCount);

        await conditionManagerFacet.connect(owner).createCondition(
            oracle.address,
            questionId,
            outcomeSlotCount,
            "ipfs://dummy"
        );

        unit = ethers.utils.parseEther("1");
        collateralAmount = unit.mul(2);

        mintAmount = ethers.utils.parseEther("120")

        await erc20.mint(owner.address, mintAmount);
        await erc20.connect(owner).approve(diamondAddress, mintAmount);


        // Split position
        const splitTx = await conditionalFacet.connect(owner).splitPosition(
            collateralToken,
            ethers.constants.HashZero,
            conditionId,
            ethers.utils.parseEther("2"),
            [1, 2]
        );

        const receipt = await splitTx.wait();
        const { positionIds, amounts } = parseTransferBatch(receipt, ethers.constants.AddressZero, owner.address);

        yesIndexSet = 1;
        noIndexSet = 2;
        yesId = positionIds[0];
        noId = positionIds[1];
        yesAmount = amounts[0];
        noAmount = amounts[1];

        await erc1155.connect(owner).setApprovalForAll(diamondAddress, true);
    });

    it("should create a BUY limit order and lock collateral", async function () {
        const tx = await orderbook.connect(owner).createLimitOrder(
            yesId, // positionId
            10, // amount
            ethers.utils.parseEther("1"), // pricePerToken
            1, // minFillAmount
            0, // expiry
            1, // indexSet
            collateralToken, // collateralToken
            ethers.constants.HashZero, // conditionId
            0 // OrderDirection.Buy
        );
        const receipt = await tx.wait();
        const event = receipt.events.find(e => e.event === "OrderCreated");
        expect(event.args.maker).to.equal(owner.address);
    });

    it("should create a SELL limit order and lock ERC1155 tokens", async function () {
        const tx = await orderbook.connect(owner).createLimitOrder(
            yesId, yesAmount, ethers.utils.parseEther("1"), 1, 0, 1, collateralToken, ethers.constants.HashZero, 1 // Sell
        );
        const receipt = await tx.wait();
        const event = receipt.events.find(e => e.event === "OrderCreated");
        expect(event.args.direction).to.equal(1); // Sell
    });

    it("should cancel an order and release escrow", async function () {
        await orderbook.connect(owner).createLimitOrder(
            1, 10, ethers.utils.parseEther("1"), 1, 0, 1, collateralTokens, ethers.constants.HashZero, 0
        );

        const cancelTx = await orderbook.connect(owner).cancelOrder(1);
        const cancelReceipt = await cancelTx.wait();
        const cancelEvent = cancelReceipt.events.find(e => e.event === "OrderCanceled");
        expect(cancelEvent.args.orderId).to.equal(1);
    });

    it("should revert cancel if not maker", async function () {
        await orderbook.connect(owner).createLimitOrder(
            1, 10, ethers.utils.parseEther("1"), 1, 0, 1, collateralToken, ethers.constants.HashZero, 0
        );
        await expect(orderbook.connect(user).cancelOrder(1)).to.be.revertedWith("Orderbook: Only maker can cancel");
    });

    it("should revert cancel if already inactive", async function () {
        await orderbook.connect(owner).createLimitOrder(
            1, 10, ethers.utils.parseEther("1"), 1, 0, 1, collateralToken, ethers.constants.HashZero, 0
        );
        await orderbook.connect(owner).cancelOrder(1);
        await expect(orderbook.connect(owner).cancelOrder(1)).to.be.revertedWith("Orderbook: Order is inactive or already canceled");
    });

    it("should simulate a BUY market order and return correct matches", async function () {
        // Maker creates 3 SELL limit orders at different prices
        await orderbook.connect(owner).createLimitOrder(yesId, 5, ethers.utils.parseEther("1.2"), 1, 0, 1, collateralToken, ethers.constants.HashZero, 1);
        await orderbook.connect(owner).createLimitOrder(yesId, 5, ethers.utils.parseEther("1.0"), 1, 0, 1, collateralToken, ethers.constants.HashZero, 1);

        // Simulate buying 8 units
        const result = await orderbook.connect(user).callStatic.simulateMarketOrder({
            positionId: yesId,
            indexSet: 1,
            collateralToken: collateralToken,
            conditionId: ethers.constants.HashZero
        }, 8, 0); // direction = 0 (Buy)

        const [matchedOrderIds, matchedAmounts, totalCost, avgPrice] = result;
        console.log("Total cost: ", totalCost, ", average price: ", avgPrice)
        expect(matchedOrderIds.length).to.equal(2);
        expect(matchedAmounts[0]).to.equal(5);
        expect(matchedAmounts[1]).to.equal(3); // partial fill from second order
    });

    it("should execute a BUY market order correctly", async function () {
        // Maker creates a SELL order
        await orderbook.connect(owner).createLimitOrder(yesId, 5, ethers.utils.parseEther("1.0"), 1, 0, 1, collateralToken, ethers.constants.HashZero, 1);

        // Simulate
        const result = await orderbook.connect(user).callStatic.simulateMarketOrder({
            positionId: yesId,
            indexSet: 1,
            collateralToken: collateralToken,
            conditionId: ethers.constants.HashZero
        }, 5, 0); // direction = 0 = Buy

        const [matchedOrderIds, matchedAmounts, totalCost] = result;

        // Mint ERC20 to user to execute market order
        await erc20.mint(user.address, totalCost);
        await erc20.connect(user).approve(diamondAddress, totalCost);

        await orderbook.connect(user).fillMarketOrderWithRoute({
            positionId: yesId,
            indexSet: 1,
            collateralToken: collateralToken,
            conditionId: ethers.constants.HashZero
        }, 5, false, 0, { matchedOrderIds, matchedAmounts, totalCost });

        // Verify user owns ERC1155 now
        const balance = await erc1155.balanceOf(user.address, yesId);
        expect(balance.toString()).to.equal("5");
    });

    it("should revert if fillOrKill is true but not enough liquidity", async function () {
        await orderbook.connect(owner).createLimitOrder(yesId, 5, ethers.utils.parseEther("1.0"), 1, 0, 1, collateralToken, ethers.constants.HashZero, 1);

        const result = await orderbook.connect(user).callStatic.simulateMarketOrder({
            positionId: yesId,
            indexSet: 1,
            collateralToken: collateralToken,
            conditionId: ethers.constants.HashZero
        }, 3, 0); // direction = 0 = Buy

        const [matchedOrderIds, matchedAmounts, totalCost] = result;

        await erc20.mint(user.address, totalCost);
        await erc20.connect(user).approve(diamondAddress, totalCost);

        await expect(orderbook.connect(user).fillMarketOrderWithRoute({
            positionId: yesId,
            indexSet: 1,
            collateralToken: collateralToken,
            conditionId: ethers.constants.HashZero
        }, 6, true, 0, { matchedOrderIds, matchedAmounts, totalCost })).to.be.revertedWith("Orderbook: FillOrKill failed");
    });


});
