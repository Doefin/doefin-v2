/* global describe it before ethers */

const { deployDiamond } = require('../../scripts/deploy.js');
const { expect } = require('chai');
const { ethers } = require('hardhat');
const {
    getConditionId,
    parseTransferBatch,
    getCollectionId,
    getPositionId
} = require("../utils.js")
const { deployMockERC20 } = require("../mock/deployMocks");


describe('ConditionalTokensFacet', function () {
    let diamondAddress;
    let conditionalFacet;
    let conditionManagerFacet;
    let erc20;
    let owner, oracle, maker;
    let questionId, outcomeSlotCount, conditionId, collateralAmount, mintAmount;

    before(async function () {
        [owner, oracle, maker] = await ethers.getSigners();

        // Deploy mocks
        erc20 = await deployMockERC20("MockToken", "MOCK");

        // Deploy diamond and get facets
        diamondAddress = await deployDiamond();
        conditionalFacet = await ethers.getContractAt('ConditionalTokensFacet', diamondAddress);
        conditionManagerFacet = await ethers.getContractAt('ConditionManagerFacet', diamondAddress);
        erc1155 = await ethers.getContractAt("ERC1155Facet", diamondAddress);
        accessControlFacet = await ethers.getContractAt('AccessControlFacet', diamondAddress);
        const adminConfig = await ethers.getContractAt("AdminConfigFacet", diamondAddress);
        await adminConfig.connect(owner).addCollateralToken(erc20.address, ethers.utils.parseEther("1"));

        // Add `maker` as market maker
        await accessControlFacet.addMarketMaker(maker.address);

        // Prepare condition
        questionId = ethers.utils.id("will-hashrate-increase?");
        outcomeSlotCount = 2;
        conditionId = getConditionId(oracle.address, questionId, outcomeSlotCount);

        await conditionManagerFacet.connect(maker).createCondition(
            oracle.address,
            questionId,
            outcomeSlotCount,
            "ipfs://dummy"
        );

        const unit = ethers.utils.parseEther("1");
        collateralAmount = unit.mul(2);

        mintAmount = ethers.utils.parseEther("120")

        await erc20.mint(maker.address, mintAmount);
        await erc20.connect(maker).approve(diamondAddress, mintAmount);

    });

    it("should split collateral into conditional positions", async function () {
        const partition = [1, 2]; // YES and NO index sets

        await expect(
            conditionalFacet.connect(maker).splitPosition(
                erc20.address,
                ethers.constants.HashZero,
                conditionId,
                collateralAmount,
                partition
            )
        ).to.emit(conditionalFacet, "PositionSplit");
    });

    it("should merge positions back into collateral", async function () {
        const partition = [1, 2]; // YES and NO index sets

        await expect(
            conditionalFacet.connect(maker).mergePositions(
                erc20.address,
                ethers.constants.HashZero,
                conditionId,
                partition,
                ethers.utils.parseEther("2").toString()
            )
        ).to.emit(conditionalFacet, "PositionsMerge");
    });

    it("should report payouts and emit event", async function () {
        const payouts = [5, 5]; // equal payout
        await expect(
            conditionalFacet.connect(oracle).reportPayouts(questionId, payouts)
        ).to.emit(conditionalFacet, "ConditionResolution")
            .withArgs(conditionId, oracle.address, questionId, outcomeSlotCount, payouts);
    });

    it("should fail to redeem before resolution", async function () {
        const conditionManagerFacet2 = await ethers.getContractAt('ConditionManagerFacet', diamondAddress);
        const newQId = ethers.utils.id("pre-resolve-test?");
        await conditionManagerFacet2.connect(maker).createCondition(
            oracle.address,
            newQId,
            outcomeSlotCount,
            "ipfs://test"
        );

        await erc20.connect(maker).approve(diamondAddress, ethers.utils.parseEther("2"));
        const newCid = getConditionId(oracle.address, newQId, outcomeSlotCount);
        const partition = [1, 2]; // YES and NO index sets
        await conditionalFacet.connect(maker).splitPosition(
            erc20.address,
            ethers.constants.HashZero,
            newCid,
            ethers.utils.parseEther("2").toString(),
            partition
        );

        await expect(
            conditionalFacet.connect(maker).redeemPositions(
                erc20.address,
                ethers.constants.HashZero,
                newCid,
                partition
            )
        ).to.be.revertedWith("condition not resolved");
    });

    it("should allow redeeming after payout", async function () {
        const partition = [1, 2]; // YES and NO index sets

        await expect(
            conditionalFacet.redeemPositions(
                erc20.address,
                ethers.constants.HashZero,
                conditionId,
                partition
            )
        ).to.emit(conditionalFacet, "PayoutRedemption");
    });

    it("should revert if payouts are reported more than once", async () => {
        const payouts = [6, 4];
        const tx = conditionalFacet.connect(oracle).reportPayouts(questionId, payouts);
        await expect(tx).to.be.revertedWith("ConditionalTokens: already resolved");
    });

    it("should revert if reporting payout on unprepared condition", async () => {
        const fakeQID = ethers.utils.id("never-prepared?");
        const fakeCID = getConditionId(oracle.address, fakeQID, outcomeSlotCount);
        await expect(
            conditionalFacet.connect(oracle).reportPayouts(fakeQID, [5, 5])
        ).to.be.revertedWith("ConditionalTokens: condition not prepared");
    });

    it("should skip redemption if user has no balance", async () => {
        const noBalanceCID = getConditionId(oracle.address, ethers.utils.id("zero-redeem"), 2);
        await conditionManagerFacet.connect(maker).createCondition(oracle.address, ethers.utils.id("zero-redeem"), 2, "ipfs://none");
        await conditionalFacet.connect(oracle).reportPayouts(ethers.utils.id("zero-redeem"), [1, 1]);

        // Should pass silently (no revert, no payout)
        await expect(
            conditionalFacet.redeemPositions(
                erc20.address,
                ethers.constants.HashZero,
                noBalanceCID,
                [1, 2]
            )
        ).to.emit(conditionalFacet, "PayoutRedemption");
    });

    it("should correctly deduct resolution fee and send to feeReceiver", async function () {
        const adminConfig = await ethers.getContractAt("AdminConfigFacet", diamondAddress);
        const [feeReceiver, resolutionFeeBps] = await adminConfig.getFees();

        // Step 1: Create a new condition
        const questionIdFeeTest = ethers.utils.id("doefin-fee-test?");
        const newConditionId = getConditionId(oracle.address, questionIdFeeTest, outcomeSlotCount);

        await conditionManagerFacet.connect(maker).createCondition(
            oracle.address,
            questionIdFeeTest,
            outcomeSlotCount,
            "ipfs://doefin-fee-test"
        );

        // Step 2: Mint and approve collateral for the test
        const feeTestCollateral = ethers.utils.parseEther("10");
        await erc20.mint(maker.address, feeTestCollateral);
        await erc20.connect(maker).approve(diamondAddress, feeTestCollateral);

        const initialReceiverBalance = await erc20.balanceOf(feeReceiver);
        const initialMakerBalance = await erc20.balanceOf(maker.address);

        // Step 3: Split into YES/NO positions
        const partitions = [1, 2];
        await conditionalFacet.connect(maker).splitPosition(
            erc20.address,
            ethers.constants.HashZero,
            newConditionId,
            feeTestCollateral,
            partitions
        );

        const postSplitMakerBalance = await erc20.balanceOf(maker.address);

        // Step 4: Report payout (YES wins)
        const payout = [1, 0]; // YES wins
        await conditionalFacet.connect(oracle).reportPayouts(questionIdFeeTest, payout);

        // Step 5: Redeem positions (YES side)
        const tx = await conditionalFacet.connect(maker).redeemPositions(
            erc20.address,
            ethers.constants.HashZero,
            newConditionId,
            [1]
        );

        const finalReceiverBalance = await erc20.balanceOf(feeReceiver);
        const finalMakerBalance = await erc20.balanceOf(maker.address);

        const expectedPayout = feeTestCollateral; // only YES side redeemed
        const expectedFee = expectedPayout.mul(resolutionFeeBps).div(10_000);
        const expectedNet = expectedPayout.sub(expectedFee);

        expect(finalReceiverBalance.sub(initialReceiverBalance)).to.equal(expectedFee);
        expect(finalMakerBalance.sub(postSplitMakerBalance)).to.equal(expectedNet);
    });

    it("should redeem 0 payout if user holds losing side", async () => {
        const losingQID = ethers.utils.id("losing-side?");
        const cid = getConditionId(oracle.address, losingQID, outcomeSlotCount);

        await conditionManagerFacet.connect(maker).createCondition(
            oracle.address,
            losingQID,
            outcomeSlotCount,
            "ipfs://lose"
        );

        const amount = ethers.utils.parseEther("2");
        await erc20.mint(maker.address, amount);
        await erc20.connect(maker).approve(diamondAddress, amount);

        await conditionalFacet.connect(maker).splitPosition(
            erc20.address,
            ethers.constants.HashZero,
            cid,
            amount,
            [1, 2]
        );

        reportWinnerSide = [1, 0] // YES is wining side

        await conditionalFacet.connect(oracle).reportPayouts(losingQID, reportWinnerSide);

        const pre = await erc20.balanceOf(maker.address);

        const tx = await conditionalFacet.connect(maker).redeemPositions(
            erc20.address,
            ethers.constants.HashZero,
            cid,
            [2] // Redeeming the losing side
        );

        const post = await erc20.balanceOf(maker.address);

        expect(post).to.equal(pre); // No change in balance

        const receipt = await tx.wait();
        expect(receipt.events.some(e => e.event === "PayoutRedemption")).to.be.true;
    });

    it("should revert if index set is invalid", async function () {
        await expect(
            conditionalFacet.splitPosition(
                erc20.address,
                ethers.constants.HashZero,
                conditionId,
                ethers.utils.parseEther("1").toString(),
                [1, 1]
            )
        ).to.be.revertedWith("ConditionalTokens: partition not disjoint");
    });

    it("should revert on partition with zero indexSet", async () => {
        await expect(
            conditionalFacet.splitPosition(
                erc20.address,
                ethers.constants.HashZero,
                conditionId,
                collateralAmount,
                [0, 1]
            )
        ).to.be.revertedWith("ConditionalTokens: invalid index set");
    });

    it("should support full cycle of split → merge → split with same condition and partition", async function () {
        const partition = [1, 2];

        const initialERC20Balance = await erc20.balanceOf(maker.address);

        // Step 1: Split initial ERC20
        await erc20.connect(maker).approve(diamondAddress, collateralAmount);
        await expect(
            conditionalFacet.connect(maker).splitPosition(
                erc20.address,
                ethers.constants.HashZero,
                conditionId,
                collateralAmount,
                partition)
        ).to.emit(conditionalFacet, "PositionSplit");

        const afterSplitERC20Balance = await erc20.balanceOf(maker.address);
        expect(afterSplitERC20Balance).to.equal(initialERC20Balance.sub(collateralAmount));

        await expect(
            conditionalFacet.connect(maker).mergePositions(
                erc20.address,
                ethers.constants.HashZero,
                conditionId,
                partition,
                collateralAmount
            )
        ).to.emit(conditionalFacet, "PositionsMerge");

        const afterMergeERC20Balance = await erc20.balanceOf(maker.address);
        expect(afterMergeERC20Balance).to.equal(afterSplitERC20Balance.add(collateralAmount))

        // Step 3: Re-split using parent collection token
        await erc20.connect(maker).approve(diamondAddress, collateralAmount);
        const reSplitTx = await conditionalFacet.connect(maker).splitPosition(
            erc20.address,
            ethers.constants.HashZero,
            conditionId,
            collateralAmount,
            partition
        );
        const reSplitReceipt = await reSplitTx.wait();
        const reSplitReceiptEvent = reSplitReceipt.events.find(e => e.event === "PositionSplit");

        if (!reSplitReceiptEvent) {
            throw new Error("PositionSplit event not emitted");
        }

        const reBatchEvent = reSplitReceipt.events.find(e => e.event === "TransferBatch");
        if (!reBatchEvent || !reBatchEvent.args) {
            throw new Error("TransferBatch event not found");
        }

        const { ids, values } = reBatchEvent.args;

        await Promise.all(
            ids.map(async (positionId, idx) => {
                const balance = await erc1155.balanceOf(maker.address, positionId);
                expect(balance).to.equal(collateralAmount);
            })
        );

        const finalERC20Balance = await erc20.balanceOf(maker.address);
        expect(finalERC20Balance).to.equal(afterMergeERC20Balance.sub(collateralAmount));
    });


    it("should allow only owner to add collateral token", async () => {
        const adminConfig = await ethers.getContractAt("AdminConfigFacet", diamondAddress);
        await expect(
            adminConfig.connect(maker).addCollateralToken(erc20.address, ethers.utils.parseEther("1"))
        ).to.be.revertedWith("LibDiamond: Must be contract owner");
    });

    it("should not allow adding the same collateral token twice", async () => {
        const adminConfig = await ethers.getContractAt("AdminConfigFacet", diamondAddress);
        const unit = ethers.utils.parseEther("1");

        await expect(
            adminConfig.connect(owner).addCollateralToken(erc20.address, unit)
        ).to.be.revertedWith("AdminConfig: token already allowed");
    });

    it("should allow registering multiple unique collateral tokens", async () => {
        const adminConfig = await ethers.getContractAt("AdminConfigFacet", diamondAddress);
        const unit = ethers.utils.parseEther("1");

        const erc20B = await deployMockERC20("TokenB", "TKB");
        await adminConfig.connect(owner).addCollateralToken(erc20B.address, unit);
        expect(await adminConfig.isAllowedCollateral(erc20B.address)).to.equal(true);
    });

    it("should allow owner to remove an existing collateral token", async () => {
        const adminConfig = await ethers.getContractAt("AdminConfigFacet", diamondAddress);
        const unit = ethers.utils.parseEther("1");

        const erc20B = await deployMockERC20("TokenB", "TKB");
        await adminConfig.connect(owner).addCollateralToken(erc20B.address, unit);
        expect(await adminConfig.isAllowedCollateral(erc20B.address)).to.equal(true);

        // Remove the token
        await adminConfig.connect(owner).removeCollateralToken(erc20B.address);
        expect(await adminConfig.isAllowedCollateral(erc20B.address)).to.equal(false);
    });

    it("should reject split if amount is not multiple of unit", async () => {
        const badAmount = ethers.utils.parseEther("1.5");
        await erc20.mint(owner.address, badAmount);
        await erc20.approve(diamondAddress, badAmount);

        await expect(
            conditionalFacet.splitPosition(
                erc20.address,
                ethers.constants.HashZero,
                conditionId,
                badAmount,
                [1, 2]
            )
        ).to.be.revertedWith("ConditionalTokens: Collateral amount not aligned to unit");
    });


});
