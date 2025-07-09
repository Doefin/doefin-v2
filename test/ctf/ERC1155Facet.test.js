const { deployDiamond } = require('../../scripts/deploy.js');
const { ethers, network } = require('hardhat');
const { expect } = require('chai');
const { getConditionId, parseTransferBatch } = require('../utils.js');
const { deployMockERC20 } = require("../mock/deployMocks");
const { BigNumber } = require("ethers");

describe("ERC1155Facet", () => {
    let diamondAddress;
    let erc1155Facet, conditionalFacet, conditionManagerFacet, adminConfigFacet;
    let erc20;
    let owner, oracle, maker, receiver;
    let conditionId, questionId;
    let yesId, noId, yesAmount, noAmount;
    let snapshotId;
    const outcomeSlotCount = 2;

    before(async function () {
        [owner, oracle, maker, receiver] = await ethers.getSigners();

        erc20 = await deployMockERC20("MockToken", "MOCK");

        diamondAddress = await deployDiamond();
        erc1155Facet = await ethers.getContractAt("ERC1155Facet", diamondAddress);
        conditionalFacet = await ethers.getContractAt("ConditionalTokensFacet", diamondAddress);
        conditionManagerFacet = await ethers.getContractAt("ConditionManagerFacet", diamondAddress);
        adminConfigFacet = await ethers.getContractAt("AdminConfigFacet", diamondAddress);

        // Allow token
        await adminConfigFacet.connect(owner).addCollateralToken(erc20.address, ethers.utils.parseEther("1"));

        const accessControlFacet = await ethers.getContractAt('AccessControlFacet', diamondAddress);
        await accessControlFacet.addMarketMaker(maker.address);

        questionId = ethers.utils.id("erc1155-transfer-test");
        conditionId = getConditionId(oracle.address, questionId, outcomeSlotCount);

        // Prepare condition
        await conditionManagerFacet.connect(maker).createCondition(
            oracle.address,
            questionId,
            outcomeSlotCount,
            "ipfs://erc1155-test"
        );

        // Mint and approve collateral
        await erc20.mint(maker.address, ethers.utils.parseEther("2"));
        await erc20.connect(maker).approve(diamondAddress, ethers.utils.parseEther("2"));

        // Split position
        const splitTx = await conditionalFacet.connect(maker).splitPosition(
            erc20.address,
            ethers.constants.HashZero,
            conditionId,
            ethers.utils.parseEther("2"),
            [1, 2]
        );

        const receipt = await splitTx.wait();
        const { positionIds, amounts } = parseTransferBatch(receipt, ethers.constants.AddressZero, maker.address);

        yesId = positionIds[0];
        noId = positionIds[1];
        yesAmount = amounts[0];
        noAmount = amounts[1];

        // Snapshot the state after setup
        snapshotId = await network.provider.send("evm_snapshot");
    });

    afterEach(async () => {
        await network.provider.send("evm_revert", [snapshotId]);
        snapshotId = await network.provider.send("evm_snapshot"); // snapshot again for next test
    });

    it("should reflect correct balances for all positions", async function () {
        const yesBal = await erc1155Facet.balanceOf(maker.address, yesId);
        const noBal = await erc1155Facet.balanceOf(maker.address, noId);
        expect(yesBal).to.equal(yesAmount);
        expect(noBal).to.equal(noAmount);
    });

    it("should allow approval and transfer of ERC1155 token", async () => {
        const transferAmount = ethers.utils.parseEther("1");

        await erc1155Facet.connect(maker).setApprovalForAll(receiver.address, true);

        const isApproved = await erc1155Facet.isApprovedForAll(maker.address, receiver.address);
        expect(isApproved).to.equal(true);

        await erc1155Facet.connect(receiver).safeTransferFrom(
            maker.address,
            receiver.address,
            yesId,
            transferAmount,
            "0x"
        );

        const senderFinalBalance = await erc1155Facet.balanceOf(maker.address, yesId);
        const receiverFinalBalance = await erc1155Facet.balanceOf(receiver.address, yesId);

        expect(senderFinalBalance.toString()).to.equal(ethers.utils.parseEther("1").toString());
        expect(receiverFinalBalance.toString()).to.equal(ethers.utils.parseEther("1").toString());
    });

    it("should allow batch transfer", async () => {

        await erc1155Facet.connect(maker).setApprovalForAll(receiver.address, true);

        await erc1155Facet.connect(receiver).safeBatchTransferFrom(
            maker.address,
            receiver.address,
            [yesId, noId],
            [ethers.utils.parseEther("1"), ethers.utils.parseEther("2")],
            "0x"
        );

        const balance1 = await erc1155Facet.balanceOf(receiver.address, yesId);
        const balance2 = await erc1155Facet.balanceOf(receiver.address, noId);

        expect(balance1).to.be.gt(0);
        expect(balance2).to.be.gt(0);
    });

    it("should revert transfer if not approved", async () => {
        const unauthorized = await ethers.getSigner(4);
        await expect(
            erc1155Facet.connect(unauthorized).safeTransferFrom(
                maker.address,
                unauthorized.address,
                noId,
                ethers.utils.parseEther("1"),
                "0x"
            )
        ).to.be.revertedWith("ERC1155: not owner nor approved");
    });

    it("should allow the winner (new holder) to redeem payout after transfer", async function () {
        // === Setup ===
        const [feeReceiver, resolutionFeeBps] = await adminConfigFacet.getFees();

        // Transfer NO token from maker to receiver
        await erc1155Facet.connect(maker).setApprovalForAll(receiver.address, true);
        await erc1155Facet.connect(receiver).safeTransferFrom(
            maker.address,
            receiver.address,
            noId,
            noAmount,
            "0x"
        );

        // Report NO as the winner
        const payout = [0, 1]; // NO wins
        await conditionalFacet.connect(oracle).reportPayouts(questionId, payout);

        const receiverInitialBalance = await erc20.balanceOf(receiver.address);
        const feeReceiverInitialBalance = await erc20.balanceOf(feeReceiver);

        // Redeem by new NO token holder (receiver)
        const tx = await conditionalFacet.connect(receiver).redeemPositions(
            erc20.address,
            ethers.constants.HashZero,
            conditionId,
            [2]
        );

        const receipt = await tx.wait();
        const event = receipt.events.find((e) => e.event === "ResolutionFeePaid");

        noAmount = BigNumber.from(noAmount);

        const expectedFee = noAmount.mul(resolutionFeeBps).div(10_000);
        const expectedNet = noAmount.sub(expectedFee);

        // === Assertions ===
        expect(event.args.redeemer).to.equal(receiver.address);
        expect(event.args.feeReceiver).to.equal(feeReceiver);
        expect(event.args.feeAmount).to.equal(expectedFee);
        expect(event.args.userPayout).to.equal(expectedNet);

        const receiverFinalBalance = await erc20.balanceOf(receiver.address);
        const feeReceiverFinalBalance = await erc20.balanceOf(feeReceiver);

        expect(receiverFinalBalance.sub(receiverInitialBalance)).to.equal(expectedNet);
        expect(feeReceiverFinalBalance.sub(feeReceiverInitialBalance)).to.equal(expectedFee);
    });

});
