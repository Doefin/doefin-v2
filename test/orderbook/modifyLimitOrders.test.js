const { deployDiamond } = require('../../scripts/deploy.js');
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployMockERC20 } = require("../mock/deployMocks");
const {
    getConditionId,
    parseTransferBatch,
    computeTradeBreakdown
} = require("../utils.js")

describe("modifyLimitOrder", function () {
    let orderId;
    let owner, maker, taker, oracle;
    let questionId, outcomeSlotCount, conditionId, unit, collateralToken, parentCollectionId;
    let orderbook, erc20;
    let buyDir, sellDir;
    let feeReceiver, makerFeeBps, takerFeeBps;
    let yesId, noId, yesIndexSet, noIndexSet, yesAmount, noAmount, positionParams;

    beforeEach(async () => {
        [owner, maker, taker, oracle] = await ethers.getSigners();

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

        const mintAmount = ethers.utils.parseEther("120")

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

        const splitReceipt = await splitTx.wait();
        const { positionIds, amounts } = parseTransferBatch(splitReceipt, ethers.constants.AddressZero, owner.address);

        yesId = positionIds[0];
        noId = positionIds[1];
        yesAmount = amounts[0];
        noAmount = amounts[1];

        positionParams = { positionId: yesId, indexSet: yesIndexSet, collateralToken: collateralToken, conditionId, parentCollectionId };

        await erc1155.connect(owner).setApprovalForAll(diamondAddress, true);
        await erc1155.safeTransferFrom(owner.address, maker.address, yesId, 10, "0x");

        // Mint and approve ERC20 and ERC1155
        await erc20.mint(maker.address, ethers.utils.parseEther("100"));
        await erc20.connect(maker).approve(diamondAddress, ethers.utils.parseEther("100"));
        await erc1155.connect(maker).setApprovalForAll(diamondAddress, true);


        // Create a BUY limit order (price: 1.0, amount: 10)
        const tx = await orderbook.connect(maker).createLimitOrder(positionParams, 10, ethers.utils.parseEther("1.0"), 1, 0, 0);
        const receipt = await tx.wait();
        const event = receipt.events.find(e => e.event === "OrderCreated");
        orderId = await orderbook.getNextOrderId() - 1;
    });

    it("should revert when trying to modify a partially filled order", async () => {
        const sim = await orderbook.connect(taker).callStatic.simulateMarketOrder(positionParams, 5, 1);
        await erc20.mint(taker.address, ethers.utils.parseEther("10"));
        await erc20.connect(taker).approve(diamondAddress, ethers.utils.parseEther("10"));

        await erc1155.safeTransferFrom(owner.address, taker.address, yesId, 10, "0x");
        await erc1155.connect(taker).setApprovalForAll(diamondAddress, true);

        await orderbook.connect(taker).fillMarketOrderWithRoute(positionParams, 5, false, 1, sim, ethers.utils.parseEther("1.5"));

        const newAmount = 15
        console.log("Order id:", orderId)
        await expect(
            orderbook.connect(maker).modifyLimitOrder(orderId, 15, ethers.utils.parseEther("1.0"), 1, 0)
        ).to.be.revertedWith("Orderbook: Already partially filled");
    });

    it("should require more ERC20 when increasing buy order", async () => {
        const erc20Before = await erc20.balanceOf(maker.address);
        await orderbook.connect(maker).modifyLimitOrder(orderId, 15, ethers.utils.parseEther("1.2"), 1, 0);
        const erc20After = await erc20.balanceOf(maker.address);
        expect(erc20After.lt(erc20Before)).to.be.true;
    });

    it("should refund ERC20 when decreasing buy order", async () => {
        const erc20Before = await erc20.balanceOf(maker.address);
        await orderbook.connect(maker).modifyLimitOrder(orderId, 5, ethers.utils.parseEther("0.9"), 1, 0);
        const erc20After = await erc20.balanceOf(maker.address);
        expect(erc20After.gt(erc20Before)).to.be.true;
    });

    it("should lock ERC1155 when increasing sell order", async () => {
        // Create a SELL order
        await orderbook.connect(maker).createLimitOrder(positionParams, 5, ethers.utils.parseEther("1.0"), 0, 0, 1);
        const sellOrderId = orderId = await orderbook.getNextOrderId() - 1;
        console.log("Sell Order Id:", sellOrderId)

        const lockedBefore = await orderbook.getLockedERC1155(maker.address, yesId);
        await orderbook.connect(maker).modifyLimitOrder(sellOrderId, 10, ethers.utils.parseEther("1.0"), 1, 0);
        const lockedAfter = await orderbook.getLockedERC1155(maker.address, yesId);
        expect(lockedAfter.sub(lockedBefore)).to.equal(5);
    });

    it("should refund ERC1155 when decreasing sell order", async () => {
        await orderbook.connect(maker).createLimitOrder(positionParams, 10, ethers.utils.parseEther("1.0"), 0, 0, 1);
        const sellOrderId = orderId = await orderbook.getNextOrderId() - 1;

        const lockedBefore = await orderbook.getLockedERC1155(maker.address, yesId);
        await orderbook.connect(maker).modifyLimitOrder(sellOrderId, 5, ethers.utils.parseEther("1.0"), 1, 0);
        const lockedAfter = await orderbook.getLockedERC1155(maker.address, yesId);
        expect(lockedBefore.sub(lockedAfter)).to.equal(5);
    });
});
