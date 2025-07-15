
const { deployDiamond } = require('../../scripts/deploy.js');
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployMockERC20 } = require("../mock/deployMocks");
const {
    getConditionId,
    parseTransferBatch
} = require("../utils.js")

describe("OrderbookFacet - Extended Tests", function () {
    let owner, user, oracle;
    let diamondAddress, orderbook, erc20, erc1155, conditionalFacet, conditionManagerFacet;
    let yesId, noId, yesAmount, noAmount, conditionId;
    let snapshotId;

    before(async function () {
        [owner, user, oracle] = await ethers.getSigners();

        erc20 = await deployMockERC20("MockToken", "MOCK");

        diamondAddress = await deployDiamond();
        orderbook = await ethers.getContractAt("OrderbookFacet", diamondAddress);
        erc1155 = await ethers.getContractAt("ERC1155Facet", diamondAddress);
        conditionalFacet = await ethers.getContractAt("ConditionalTokensFacet", diamondAddress);
        conditionManagerFacet = await ethers.getContractAt("ConditionManagerFacet", diamondAddress);
        const accessControlFacet = await ethers.getContractAt('AccessControlFacet', diamondAddress);
        const adminConfig = await ethers.getContractAt("AdminConfigFacet", diamondAddress);

        await adminConfig.connect(owner).addCollateralToken(erc20.address, ethers.utils.parseEther("1"));
        await accessControlFacet.addMarketMaker(owner.address);

        const questionId = ethers.utils.id("will-hashrate-increase?");
        const outcomeSlotCount = 2;
        conditionId = getConditionId(oracle.address, questionId, outcomeSlotCount);

        await conditionManagerFacet.connect(owner).createCondition(
            oracle.address,
            questionId,
            outcomeSlotCount,
            "ipfs://dummy"
        );

        const unit = ethers.utils.parseEther("1");
        const collateralAmount = unit.mul(2);

        const mintAmount = ethers.utils.parseEther("120")

        await erc20.mint(owner.address, mintAmount);
        await erc20.connect(owner).approve(diamondAddress, mintAmount);

        // Split position
        const splitTx = await conditionalFacet.connect(owner).splitPosition(
            erc20.address,
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

        await erc1155.connect(owner).setApprovalForAll(diamondAddress, true);
    });

    beforeEach(async () => {
        snapshotId = await ethers.provider.send("evm_snapshot", []);
    });

    afterEach(async () => {
        await ethers.provider.send("evm_revert", [snapshotId]);
    });

    it("should simulate and execute a BUY market order from multiple SELL limit orders", async () => {
        // Maker places 2 SELL orders for yesId
        await orderbook.createLimitOrder(yesId, 5, ethers.utils.parseEther("1"), 1, 0, 1, erc20.address, conditionId, 1);
        await orderbook.createLimitOrder(yesId, 5, ethers.utils.parseEther("1.2"), 1, 0, 1, erc20.address, conditionId, 1);

        // User mints collateral and approves
        await erc20.mint(user.address, ethers.utils.parseEther("20"));
        await erc20.connect(user).approve(diamondAddress, ethers.utils.parseEther("20"));

        // Simulate
        const positionParams = { positionId: yesId, indexSet: 1, collateralToken: erc20.address, conditionId };
        const sim = await orderbook.connect(user).callStatic.simulateMarketOrder(positionParams, 8, 0);

        // Execute
        await orderbook.connect(user).fillMarketOrderWithRoute(positionParams, 8, false, 0, sim, 10);
    });

    it("should simulate and execute a SELL market order from multiple BUY limit orders", async () => {
        await orderbook.createLimitOrder(yesId, 5, ethers.utils.parseEther("1"), 1, 0, 1, erc20.address, conditionId, 0);
        await orderbook.createLimitOrder(yesId, 5, ethers.utils.parseEther("0.8"), 1, 0, 1, erc20.address, conditionId, 0);

        await erc1155.connect(user).setApprovalForAll(diamondAddress, true);
        await erc1155.safeTransferFrom(owner.address, user.address, yesId, 10, "0x");

        const positionParams = { positionId: yesId, indexSet: 1, collateralToken: erc20.address, conditionId };
        const sim = await orderbook.connect(user).callStatic.simulateMarketOrder(positionParams, 8, 1);
        await orderbook.connect(user).fillMarketOrderWithRoute(positionParams, 8, false, 1, sim, 10);
    });

    it("should revert if fillOrKill is true and not enough liquidity", async () => {
        await orderbook.createLimitOrder(yesId, 5, ethers.utils.parseEther("1"), 1, 0, 1, erc20.address, conditionId, 1);
        const positionParams = { positionId: yesId, indexSet: 1, collateralToken: erc20.address, conditionId };
        await expect(orderbook.simulateMarketOrder(positionParams, 6, 1)).to.be.revertedWith("simulateMarketOrder: Couldn't satisify the ammount");
    });

    it("should remove orders fully filled", async () => {
        await orderbook.createLimitOrder(yesId, 3, ethers.utils.parseEther("1"), 1, 0, 1, erc20.address, conditionId, 1);
        const positionParams = { positionId: yesId, indexSet: 1, collateralToken: erc20.address, conditionId };
        const sim = await orderbook.simulateMarketOrder(positionParams, 3, 0);
        await orderbook.fillMarketOrderWithRoute(positionParams, 3, false, 0, sim, 10);
        const updatedSim = await orderbook.simulateMarketOrder(positionParams, 1, 0).catch(() => true);
        expect(updatedSim).to.equal(true); // means reverted because no orders left
    });

    it("should skip expired orders", async () => {
        const now = (await ethers.provider.getBlock()).timestamp;
        await orderbook.createLimitOrder(yesId, 5, ethers.utils.parseEther("1"), 1, now - 10, 1, erc20.address, conditionId, 1);
        const positionParams = { positionId: yesId, indexSet: 1, collateralToken: erc20.address, conditionId };
        await expect(orderbook.simulateMarketOrder(positionParams, 1, 0)).to.be.revertedWith("simulateMarketOrder: Couldn't satisify the ammount");
    });

    it("should keep order list sorted after inserts", async () => {
        await orderbook.createLimitOrder(yesId, 5, ethers.utils.parseEther("2.0"), 1, 0, 1, erc20.address, conditionId, 1);
        await orderbook.createLimitOrder(yesId, 5, ethers.utils.parseEther("1.5"), 1, 0, 1, erc20.address, conditionId, 1);
        await orderbook.createLimitOrder(yesId, 5, ethers.utils.parseEther("1.0"), 1, 0, 1, erc20.address, conditionId, 1);
        const book = await orderbook.getOrderbook(yesId, 1);
        const prices = await Promise.all(book.map(id => orderbook.getOrder(id).then(o => o.pricePerToken)));
        const sorted = [...prices].sort((a, b) => (a.lt(b) ? -1 : a.gt(b) ? 1 : 0));
        expect(prices.map(p => p.toString())).to.eql(sorted.map(p => p.toString()));
    });
});
