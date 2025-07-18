const { deployDiamond } = require('../../scripts/deploy.js');
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployMockERC20 } = require("../mock/deployMocks");
const {
    getConditionId,
    parseTransferBatch,
    computeTradeBreakdown
} = require("../utils.js")

describe("OrderbookFacet", function () {
    let owner, user, oracle;
    let questionId, outcomeSlotCount, conditionId, unit, collateralToken, parentCollectionId;
    let orderbook, erc20;
    let buyDir, sellDir;
    let feeReceiver, makerFeeBps, takerFeeBps;
    let yesId, noId, yesIndexSet, noIndexSet, yesAmount, noAmount, positionParams;

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

        console.log("Prepared environments for tests.")

        feeReceiver = owner.address;

        // Set fees: 2% maker, 1% taker
        makerFeeBps = 200;
        takerFeeBps = 100;
        await adminConfig.setTradingFeesBps(makerFeeBps, takerFeeBps);
        await adminConfig.setFeeReceiver(feeReceiver);

        // Add `maker` as market maker
        await accessControlFacet.addMarketMaker(owner.address);

        // Prepare condition
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

        yesId = positionIds[0];
        noId = positionIds[1];
        yesAmount = amounts[0];
        noAmount = amounts[1];

        positionParams = { positionId: yesId, indexSet: yesIndexSet, collateralToken: collateralToken, conditionId, parentCollectionId };

        await erc1155.connect(owner).setApprovalForAll(diamondAddress, true);
    });

    it("should create a BUY limit order and lock collateral", async function () {
        const tx = await orderbook.connect(owner).createLimitOrder(
            positionParams,
            10, // amount
            ethers.utils.parseEther("1"), // pricePerToken
            1, // minFillAmount
            0, // expiry
            0 // OrderDirection.Buy
        );
        const receipt = await tx.wait();
        const event = receipt.events.find(e => e.event === "OrderCreated");
        expect(event.args.maker).to.equal(owner.address);
    });

    it("should create a SELL limit order and lock ERC1155 tokens", async function () {
        const tx = await orderbook.connect(owner).createLimitOrder(
            positionParams, yesAmount, ethers.utils.parseEther("1"), 1, 0, 1 // Sell
        );
        const receipt = await tx.wait();
        const event = receipt.events.find(e => e.event === "OrderCreated");
        expect(event.args.direction).to.equal(1); // Sell
    });

    it("should cancel an order and release escrow", async function () {

        await orderbook.connect(owner).createLimitOrder(
            positionParams, 10, ethers.utils.parseEther("1"), 1, 0, 0
        );

        const cancelTx = await orderbook.connect(owner).cancelOrder(1);
        const cancelReceipt = await cancelTx.wait();
        const cancelEvent = cancelReceipt.events.find(e => e.event === "OrderCanceled");
        expect(cancelEvent.args.orderId).to.equal(1);
    });

    it("should revert cancel if not maker", async function () {
        await orderbook.connect(owner).createLimitOrder(
            positionParams, 10, ethers.utils.parseEther("1"), 1, 0, 0
        );
        await expect(orderbook.connect(user).cancelOrder(1)).to.be.revertedWith("Orderbook: Only maker can cancel");
    });

    it("should revert cancel if already inactive", async function () {
        await orderbook.connect(owner).createLimitOrder(
            positionParams, 10, ethers.utils.parseEther("1"), 1, 0, 0
        );
        await orderbook.connect(owner).cancelOrder(1);
        await expect(orderbook.connect(owner).cancelOrder(1)).to.be.revertedWith("Orderbook: Order is not available");
    });

    it("should revert if positionId is invalid (not derived from conditionId, indexSet, collateralToken, parentCollectionId)", async () => {
        const invalidPositionParams = {
            positionId: yesId,
            indexSet: 2,
            collateralToken: erc20.address,
            conditionId,
            parentCollectionId
        };

        await expect(
            orderbook.connect(user).simulateMarketOrder(invalidPositionParams, 1, 0)
        ).to.be.revertedWith("Orderbook: Invalid positionId");

        await expect(
            orderbook.connect(user).fillMarketOrderWithRoute(invalidPositionParams, 1, false, 0, {
                matchedOrderIds: [],
                matchedAmounts: [],
                totalCost: 0
            }, 10)
        ).to.be.revertedWith("Orderbook: Invalid positionId");
    });

    it("should emit EscrowLocked when creating a SELL limit order", async () => {
        const amount = 5;
        await erc1155.safeTransferFrom(owner.address, user.address, yesId, amount, "0x");
        await erc1155.connect(user).setApprovalForAll(diamondAddress, true);

        const sellParams = { ...positionParams };

        await expect(orderbook.connect(user).createLimitOrder(
            sellParams, amount, ethers.utils.parseEther("1"), 0, 0, 1 // direction = Sell
        )).to.emit(orderbook, "EscrowLocked").withArgs(
            user.address,
            positionParams.collateralToken,
            positionParams.positionId,
            amount,
            ethers.utils.parseEther("1"),
            1 // Sell
        );
    });

    it("should emit EscrowReleased when cancelling a BUY order", async () => {
        const orderDir = 0; // Buy
        const orderAmount = 5;
        const orderPrice = ethers.utils.parseEther("1.0");
        const firstBreakdown = computeTradeBreakdown(orderAmount, orderPrice, orderDir, makerFeeBps, takerFeeBps);

        await erc20.mint(owner.address, firstBreakdown.totalMakerLocks);
        await erc20.connect(owner).approve(diamondAddress, firstBreakdown.totalMakerLocks);

        const tx = await orderbook.connect(owner).createLimitOrder(
            positionParams, orderAmount, orderPrice, 0, 0, orderDir // direction = Buy
        );

        const receipt = await tx.wait();
        const orderCreatedEvent = receipt.events.find(e => e.event === "OrderCreated");
        const orderId = orderCreatedEvent.args.orderId;

        await expect(orderbook.connect(owner).cancelOrder(orderId)).to.emit(orderbook, "EscrowReleased").withArgs(
            owner.address,
            positionParams.collateralToken,
            positionParams.positionId,
            orderAmount,
            orderPrice,
            orderDir
        );
    });



});
