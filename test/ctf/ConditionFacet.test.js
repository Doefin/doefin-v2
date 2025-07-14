/* global describe it before ethers */

const { deployDiamond } = require('../../scripts/deploy.js');
const { expect } = require('chai');
const { ethers } = require('hardhat');
const { getConditionId } = require('../utils');

describe('ConditionManagerFacet', function () {
    let diamondAddress;
    let conditionFacet;
    let accessControlFacet;
    let oracle;
    let maker;
    let nonMaker;
    let questionId;
    let outcomeSlotCount;
    let metadataURI;

    before(async function () {
        const accounts = await ethers.getSigners();
        [oracle, maker, nonMaker] = accounts;

        // Deploy diamond and get ConditionManagerFacet interface on diamond address
        diamondAddress = await deployDiamond();
        conditionFacet = await ethers.getContractAt('ConditionManagerFacet', diamondAddress);
        accessControlFacet = await ethers.getContractAt('AccessControlFacet', diamondAddress);

        // Add `maker` as market maker
        await accessControlFacet.addMarketMaker(maker.address);
    });

    it('should create a new condition and emit ConditionCreated', async function () {
        // Setup test condition params
        questionId = ethers.utils.id("will-BTC-Difficulty-go-above-2T?");
        outcomeSlotCount = 2;
        metadataURI = "ipfs://some-metadata-uri";

        const expectedConditionId = getConditionId(oracle.address, questionId, outcomeSlotCount);

        // Expect proper event emission
        await expect(
            conditionFacet.connect(maker).createCondition(oracle.address, questionId, outcomeSlotCount, metadataURI)
        )
            .to.emit(conditionFacet, "ConditionCreated")
            .withArgs(expectedConditionId, oracle.address, questionId, outcomeSlotCount, metadataURI);
    });

    it('should revert if condition is created twice (duplicate)', async function () {
        await expect(
            conditionFacet.connect(maker).createCondition(oracle.address, questionId, outcomeSlotCount, metadataURI)
        ).to.be.revertedWith("ConditionalTokens: already prepared");
    });

    it('should revert if outcomeSlotCount is 0', async function () {
        const newQuestionId = ethers.utils.id("will-BTC-Diff-hit-10T?");
        await expect(
            conditionFacet.connect(maker).createCondition(oracle.address, newQuestionId, 0, "ipfs://some-uri")
        ).to.be.revertedWith("ConditionalTokens: invalid outcome count");
    });

    it('should revert if caller is not a market maker', async function () {
        const newQuestionId = ethers.utils.id("is-non-maker-allowed?");
        await expect(
            conditionFacet.connect(nonMaker).createCondition(nonMaker.address, newQuestionId, 2, "ipfs://unauthorized")
        ).to.be.revertedWith("AccessControl: must be market maker");
    });

    it('should allow market maker to create another condition', async function () {
        const newQuestionId = ethers.utils.id("will-BTC-hashrate-drop?");
        const newMetadata = "ipfs://new-metadata";
        const expectedConditionId = getConditionId(maker.address, newQuestionId, 2);

        await expect(
            conditionFacet.connect(maker).createCondition(maker.address, newQuestionId, 2, newMetadata)
        ).to.emit(conditionFacet, "ConditionCreated")
            .withArgs(expectedConditionId, maker.address, newQuestionId, outcomeSlotCount, newMetadata);
    });

    it("should allow creator to cancel condition", async function () {
        const questionId = ethers.utils.id("cancel-by-creator?");
        const outcomeSlotCount = 2;
        const metadataURI = "ipfs://cancel-test";
        const expectedConditionId = getConditionId(maker.address, questionId, outcomeSlotCount);

        // Create condition
        await conditionFacet.connect(maker).createCondition(maker.address, questionId, outcomeSlotCount, metadataURI);

        // Cancel condition
        await expect(conditionFacet.connect(maker).cancelCondition(expectedConditionId))
            .to.emit(conditionFacet, "ConditionCancelled")
            .withArgs(expectedConditionId);
    });

    it("should prevent non-creator market maker from cancelling condition", async function () {
        const questionId = ethers.utils.id("unauthorized-maker-cancel?");
        const expectedConditionId = getConditionId(maker.address, questionId, 2);
        await conditionFacet.connect(maker).createCondition(maker.address, questionId, 2, "ipfs://nonowner");

        await expect(
            conditionFacet.connect(nonMaker).cancelCondition(expectedConditionId)
        ).to.be.revertedWith("ConditionalManager: Not authorized to cancel this condition");
    });

    it("should allow contract owner to cancel condition", async function () {
        const questionId = ethers.utils.id("admin-cancel?");
        const expectedConditionId = getConditionId(maker.address, questionId, 2);
        await conditionFacet.connect(maker).createCondition(maker.address, questionId, 2, "ipfs://owner-cancel");

        await expect(conditionFacet.connect(oracle).cancelCondition(expectedConditionId)) // owner
            .to.emit(conditionFacet, "ConditionCancelled")
            .withArgs(expectedConditionId);
    });
});
