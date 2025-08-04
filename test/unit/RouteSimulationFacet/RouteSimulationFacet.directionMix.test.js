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


describe("RouteSimulationFacet", function () {
    let owner, user, maker, oracle, taker;
    let diamondAddress, routeSimFacet, exchangeFacet, erc20, ercUnit, erc1155, conditionalFacet, conditionManagerFacet, adminConfig;
    let questionId, conditionId, yesId, noId;
    let mintAmount, unit;
    let buyDir, sellDir, feeConfig;
    let snapshotId;

    before(async function () {
        [owner, user, maker, oracle, taker] = await ethers.getSigners();

        erc20 = await deployMockERC20("MockToken", "MOCK");

        buyDir = 0;
        sellDir = 1;

        diamondAddress = await deployDiamond();


        exchangeFacet = await ethers.getContractAt("ExchangeFacet", diamondAddress);
        erc1155 = await ethers.getContractAt("ERC1155Facet", diamondAddress);
        conditionalFacet = await ethers.getContractAt("ConditionalTokensFacet", diamondAddress);
        conditionManagerFacet = await ethers.getContractAt("ConditionManagerFacet", diamondAddress);
        adminConfig = await ethers.getContractAt("AdminConfigFacet", diamondAddress);
        routeSimFacet = await ethers.getContractAt("RouteSimulationFacet", diamondAddress)
        const accessControlFacet = await ethers.getContractAt("AccessControlFacet", diamondAddress);

        await accessControlFacet.addMarketMaker(owner.address)

        ercUnit = ethers.utils.parseEther("1")

        // await addCollateralToken(adminConfig, erc20.address, ercUnit, owner);
        await addCollateralToken({ adminConfig: adminConfig, token: erc20, unit: ercUnit, caller: owner })
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
        mintAmount = ethers.utils.parseEther("120");

        await mintAndApproveERC20({
            token: erc20,
            minter: owner,
            to: owner,
            amount: mintAmount,
            spender: diamondAddress
        });

        const [positionIds, _amounts] = await splitConditionAndGetPositionIds({
            user: owner,
            amount: unit.mul(20),
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

    it("should prioritize best-priced SELL orders even when BUY orders exist", async () => {
        const sellPrice1 = ethers.utils.parseEther("0.65"); // Better
        const sellPrice2 = ethers.utils.parseEther("0.7");
        const buyPrice = ethers.utils.parseEther("0.8"); // Should be ignored

        const amount = ethers.utils.parseEther("5");

        await mintAndApproveERC20({ to: maker, minter: owner, token: erc20, amount: amount.mul(10), spender: diamondAddress });

        await erc1155.connect(owner).safeTransferFrom(
            owner.address,
            maker.address,
            yesId,
            amount.mul(2),
            "0x"
        );
        await erc1155.connect(maker).setApprovalForAll(diamondAddress, true);

        // Create two SELL orders
        await createLimitOrder(exchangeFacet, maker, {
            positionId: yesId,
            collateralToken: erc20.address,
            amount,
            pricePerToken: sellPrice1,
            minFillAmount: amount,
            expiry: 0,
            direction: sellDir
        });

        await createLimitOrder(exchangeFacet, maker, {
            positionId: yesId,
            collateralToken: erc20.address,
            amount,
            pricePerToken: sellPrice2,
            minFillAmount: amount,
            expiry: 0,
            direction: sellDir
        });

        // Create one BUY order (should not be matched when simulating a BUY market order)
        await createLimitOrder(exchangeFacet, maker, {
            positionId: yesId,
            collateralToken: erc20.address,
            amount,
            pricePerToken: buyPrice,
            minFillAmount: amount,
            expiry: 0,
            direction: buyDir
        });

        const route = await simulateAndParseMatchRoute({
            routeSimFacet,
            positionId: yesId,
            amount,
            direction: buyDir
        });

        console.log("Match Route:", route)

        expect(route.totalInputAmount).to.equal(amount);
        expect(route.matches.length).to.equal(1);

        const [match] = route.matches;
        expect(match.matchTypeLabel).to.equal("Complementary");
        expect(match.effectivePrice).to.equal(sellPrice1.add(sellPrice1.mul(feeConfig.takerBps).div(10000)));
    });
});