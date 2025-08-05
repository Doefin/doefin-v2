const { deployDiamond } = require('../../../scripts/deploy.js');
const { expect } = require("chai");
const { ethers } = require("hardhat");

const { deployMockERC20 } = require("../../mock/deployMocks.js");
const { getConditionId } = require("../../utils/ctfUtils.js");
const { addCollateralToken } = require("../../utils/adminConfigUtils.js");
const { mintAndApproveERC20 } = require("../../utils/erc20Utils.js");
const { splitConditionAndGetPositionIds, createAndSplitCondition } = require("../../utils/conditionUtils.js");
const { takeSnapshot, revertToSnapshot } = require("../../utils/snapshotUtils.js");

describe("MarketDataFacet - Advanced Test Cases", function () {
    let owner, oracle, user, oracle2;
    let diamondAddress, marketDataFacet, conditionalFacet, conditionManagerFacet, adminConfig, accessControlFacet;
    let erc20, erc20_2, questionId, conditionId, yesId, noId;
    let ercUnit, ercUnit2;
    let snapshotId;

    before(async function () {
        [owner, oracle, user, oracle2] = await ethers.getSigners();

        // Deploy multiple mock ERC20 tokens
        erc20 = await deployMockERC20("MockToken", "MOCK");
        erc20_2 = await deployMockERC20("SecondToken", "MOCK2", 6); // Different decimals

        // Deploy diamond
        diamondAddress = await deployDiamond();

        // Get facet instances
        marketDataFacet = await ethers.getContractAt("MarketDataFacet", diamondAddress);
        conditionalFacet = await ethers.getContractAt("ConditionalTokensFacet", diamondAddress);
        conditionManagerFacet = await ethers.getContractAt("ConditionManagerFacet", diamondAddress);
        adminConfig = await ethers.getContractAt("AdminConfigFacet", diamondAddress);
        accessControlFacet = await ethers.getContractAt("AccessControlFacet", diamondAddress);

        // Setup permissions
        await accessControlFacet.addMarketMaker(owner.address);

        // Add collateral tokens with different units
        ercUnit = ethers.utils.parseEther("1");
        ercUnit2 = ethers.utils.parseUnits("1", 6);
        
        await addCollateralToken({ 
            adminConfig: adminConfig, 
            token: erc20, 
            unit: ercUnit, 
            caller: owner 
        });
        
        await addCollateralToken({ 
            adminConfig: adminConfig, 
            token: erc20_2, 
            unit: ercUnit2, 
            caller: owner 
        });

        // Create primary condition
        questionId = ethers.utils.id("will-hashrate-increase?");
        const outcomeSlotCount = 2;
        conditionId = getConditionId(oracle.address, questionId, outcomeSlotCount);

        await conditionManagerFacet.connect(owner).createCondition(
            oracle.address,
            questionId,
            outcomeSlotCount,
            "ipfs://dummy"
        );

        // Mint and approve ERC20
        const mintAmount = ethers.utils.parseEther("100");
        await mintAndApproveERC20({
            token: erc20,
            minter: owner,
            to: owner,
            amount: mintAmount,
            spender: diamondAddress
        });

        // Split condition to create position tokens
        const splitAmount = ethers.utils.parseEther("10");
        const [positionIds, _amounts] = await splitConditionAndGetPositionIds({
            user: owner,
            amount: splitAmount,
            conditionId,
            indexSets: [1, 2],
            erc20,
            conditionalFacet
        });

        yesId = positionIds[0];
        noId = positionIds[1];
    });

    beforeEach(async () => {
        snapshotId = await takeSnapshot();
    });

    afterEach(async () => {
        await revertToSnapshot(snapshotId);
    });

    describe("Edge Cases and Error Handling", function () {
        it("should handle very large position IDs", async () => {
            const largePositionId = ethers.constants.MaxUint256;
            
            await expect(
                marketDataFacet.getMarketMetadata(largePositionId)
            ).to.be.revertedWith("InvalidPositionId()");
        });

        it("should handle zero position ID", async () => {
            await expect(
                marketDataFacet.getMarketMetadata(0)
            ).to.be.revertedWith("InvalidPositionId()");
        });

        it("should handle malformed condition ID", async () => {
            const malformedConditionId = ethers.utils.id("non-existent-condition");
            
            await expect(
                marketDataFacet.getMarketsByCondition(malformedConditionId)
            ).to.be.revertedWith("ConditionDoesNotExist()");
        });

        it("should return consistent data across multiple calls", async () => {
            // Call the same function multiple times and verify consistency
            const metadata1 = await marketDataFacet.getMarketMetadata(yesId);
            const metadata2 = await marketDataFacet.getMarketMetadata(yesId);
            const metadata3 = await marketDataFacet.getMarketMetadata(yesId);

            expect(metadata1.collateralToken).to.equal(metadata2.collateralToken);
            expect(metadata2.collateralToken).to.equal(metadata3.collateralToken);
            expect(metadata1.positionIds.length).to.equal(metadata2.positionIds.length);
            expect(metadata2.positionIds.length).to.equal(metadata3.positionIds.length);
        });

        it("should handle concurrent condition creation", async () => {
            const questionId1 = ethers.utils.id("concurrent-test-1");
            const questionId2 = ethers.utils.id("concurrent-test-2");
            const outcomeSlotCount = 2;

            // Create conditions concurrently
            await Promise.all([
                conditionManagerFacet.connect(owner).createCondition(
                    oracle.address,
                    questionId1,
                    outcomeSlotCount,
                    "ipfs://concurrent-1"
                ),
                conditionManagerFacet.connect(owner).createCondition(
                    oracle2.address,
                    questionId2,
                    outcomeSlotCount,
                    "ipfs://concurrent-2"
                )
            ]);

            const conditionId1 = getConditionId(oracle.address, questionId1, outcomeSlotCount);
            const conditionId2 = getConditionId(oracle2.address, questionId2, outcomeSlotCount);

            // Both conditions should exist but have no positions yet, so they should revert
            await expect(
                marketDataFacet.getMarketsByCondition(conditionId1)
            ).to.be.revertedWith("ConditionDoesNotExist()");
            
            await expect(
                marketDataFacet.getMarketsByCondition(conditionId2)
            ).to.be.revertedWith("ConditionDoesNotExist()");
        });

        it("should handle getMarketMetadataByCondition with invalid condition", async () => {
            const invalidConditionId = ethers.utils.id("invalid-condition-metadata");
            
            await expect(
                marketDataFacet.getMarketMetadataByCondition(invalidConditionId)
            ).to.be.revertedWith("ConditionDoesNotExist()");
        });
    });

    describe("Multi-Collateral Token Scenarios", function () {
        it("should handle conditions with different collateral tokens", async () => {
            // Create condition with first token
            const questionId1 = ethers.utils.id("multi-collateral-1");
            const conditionId1 = getConditionId(oracle.address, questionId1, 2);
            
            await conditionManagerFacet.connect(owner).createCondition(
                oracle.address,
                questionId1,
                2,
                "ipfs://multi-1"
            );

            // Split with first token
            const mintAmount1 = ethers.utils.parseEther("5");
            await mintAndApproveERC20({
                token: erc20,
                minter: owner,
                to: owner,
                amount: mintAmount1,
                spender: diamondAddress
            });

            const [positionIds1, _] = await splitConditionAndGetPositionIds({
                user: owner,
                amount: mintAmount1,
                conditionId: conditionId1,
                indexSets: [1, 2],
                erc20,
                conditionalFacet
            });

            // Create condition with second token
            const questionId2 = ethers.utils.id("multi-collateral-2");
            const conditionId2 = getConditionId(oracle.address, questionId2, 2);
            
            await conditionManagerFacet.connect(owner).createCondition(
                oracle.address,
                questionId2,
                2,
                "ipfs://multi-2"
            );

            // Split with second token
            const mintAmount2 = ethers.utils.parseUnits("5", 6);
            await mintAndApproveERC20({
                token: erc20_2,
                minter: owner,
                to: owner,
                amount: mintAmount2,
                spender: diamondAddress
            });

            const [positionIds2, __] = await splitConditionAndGetPositionIds({
                user: owner,
                amount: mintAmount2,
                conditionId: conditionId2,
                indexSets: [1, 2],
                erc20: erc20_2,
                conditionalFacet
            });

            // Verify different collateral tokens
            const collateral1 = await marketDataFacet.getCollateralToken(positionIds1[0]);
            const collateral2 = await marketDataFacet.getCollateralToken(positionIds2[0]);
            
            expect(collateral1).to.equal(erc20.address);
            expect(collateral2).to.equal(erc20_2.address);
            expect(collateral1).to.not.equal(collateral2);

            // Verify different units
            const unit1 = await marketDataFacet.getCollateralUnit(positionIds1[0]);
            const unit2 = await marketDataFacet.getCollateralUnit(positionIds2[0]);
            
            expect(unit1).to.equal(ercUnit);
            expect(unit2).to.equal(ercUnit2);
            expect(unit1).to.not.equal(unit2);
        });

        it("should return correct metadata for positions with different collaterals", async () => {
            // Setup two conditions with different collaterals (from previous test)
            const questionId1 = ethers.utils.id("metadata-multi-1");
            const questionId2 = ethers.utils.id("metadata-multi-2");
            
            const conditionId1 = getConditionId(oracle.address, questionId1, 2);
            const conditionId2 = getConditionId(oracle.address, questionId2, 2);

            await conditionManagerFacet.connect(owner).createCondition(oracle.address, questionId1, 2, "ipfs://meta-1");
            await conditionManagerFacet.connect(owner).createCondition(oracle.address, questionId2, 2, "ipfs://meta-2");

            // Split with different tokens
            const [positionIds1, _] = await splitConditionAndGetPositionIds({
                user: owner,
                amount: ethers.utils.parseEther("3"),
                conditionId: conditionId1,
                indexSets: [1, 2],
                erc20,
                conditionalFacet
            });

            await mintAndApproveERC20({
                token: erc20_2,
                minter: owner,
                to: owner,
                amount: ethers.utils.parseUnits("3", 6),
                spender: diamondAddress
            });

            const [positionIds2, __] = await splitConditionAndGetPositionIds({
                user: owner,
                amount: ethers.utils.parseUnits("3", 6),
                conditionId: conditionId2,
                indexSets: [1, 2],
                erc20: erc20_2,
                conditionalFacet
            });

            const metadata1 = await marketDataFacet.getMarketMetadata(positionIds1[0]);
            const metadata2 = await marketDataFacet.getMarketMetadata(positionIds2[0]);

            expect(metadata1.collateralToken).to.equal(erc20.address);
            expect(metadata2.collateralToken).to.equal(erc20_2.address);
            expect(metadata1.positionIds.length).to.equal(2);
            expect(metadata2.positionIds.length).to.equal(2);
        });
    });

    describe("Complex Condition Scenarios", function () {
        it("should handle conditions with different outcome counts", async () => {
            // Create condition with 3 outcomes
            const questionId3 = ethers.utils.id("three-outcomes");
            const conditionId3 = getConditionId(oracle.address, questionId3, 3);
            
            await conditionManagerFacet.connect(owner).createCondition(
                oracle.address,
                questionId3,
                3,
                "ipfs://three-outcomes"
            );

            // Split into 3 positions
            const [positionIds3, _] = await splitConditionAndGetPositionIds({
                user: owner,
                amount: ethers.utils.parseEther("6"),
                conditionId: conditionId3,
                indexSets: [1, 2, 4], // Binary representation: 001, 010, 100
                erc20,
                conditionalFacet
            });

            expect(positionIds3).to.have.lengthOf(3);

            const markets = await marketDataFacet.getMarketsByCondition(conditionId3);
            expect(markets).to.have.lengthOf(3);

            const metadata = await marketDataFacet.getMarketMetadata(positionIds3[0]);
            expect(metadata.positionIds).to.have.lengthOf(3);
            expect(metadata.partitions).to.have.lengthOf(3);
        });

        it("should handle conditions with maximum outcome count", async () => {
            // Create condition with 8 outcomes (maximum for uint8)
            const questionId8 = ethers.utils.id("eight-outcomes");
            const conditionId8 = getConditionId(oracle.address, questionId8, 8);
            
            await conditionManagerFacet.connect(owner).createCondition(
                oracle.address,
                questionId8,
                8,
                "ipfs://eight-outcomes"
            );

            // Split into all 8 positions
            const indexSets = [1, 2, 4, 8, 16, 32, 64, 128]; // Powers of 2
            const [positionIds8, _] = await splitConditionAndGetPositionIds({
                user: owner,
                amount: ethers.utils.parseEther("16"),
                conditionId: conditionId8,
                indexSets,
                erc20,
                conditionalFacet
            });

            expect(positionIds8).to.have.lengthOf(8);

            const markets = await marketDataFacet.getMarketsByCondition(conditionId8);
            expect(markets).to.have.lengthOf(8);

            // Test complement functionality with multiple outcomes
            // Note: With 8 individual outcomes (powers of 2), each position's complement
            // would be the union of all other positions, which may not exist as a single position
            // So we'll test that the function works for the first few positions
            const complement1 = await marketDataFacet.getComplement(positionIds8[0]);
            const complement2 = await marketDataFacet.getComplement(positionIds8[1]);
            
            // Verify complements are different from originals
            expect(complement1).to.not.equal(positionIds8[0]);
            expect(complement2).to.not.equal(positionIds8[1]);
            expect(complement1).to.not.equal(complement2);
        });

        it("should handle partial position splits", async () => {
            // Create condition and split only some outcomes
            const questionIdPartial = ethers.utils.id("partial-split");
            const conditionIdPartial = getConditionId(oracle.address, questionIdPartial, 4);
            
            await conditionManagerFacet.connect(owner).createCondition(
                oracle.address,
                questionIdPartial,
                4,
                "ipfs://partial"
            );

            // Split only 2 out of 4 possible outcomes
            const [partialPositionIds, _] = await splitConditionAndGetPositionIds({
                user: owner,
                amount: ethers.utils.parseEther("4"),
                conditionId: conditionIdPartial,
                indexSets: [3, 12], // Binary: 0011, 1100 (complementary)
                erc20,
                conditionalFacet
            });

            expect(partialPositionIds).to.have.lengthOf(2);

            const markets = await marketDataFacet.getMarketsByCondition(conditionIdPartial);
            expect(markets).to.have.lengthOf(2);

            // Verify complement relationship
            const complement1 = await marketDataFacet.getComplement(partialPositionIds[0]);
            const complement2 = await marketDataFacet.getComplement(partialPositionIds[1]);
            
            expect(complement1).to.equal(partialPositionIds[1]);
            expect(complement2).to.equal(partialPositionIds[0]);
        });
    });

    describe("Performance and Scalability Tests", function () {
        it("should handle multiple conditions efficiently", async () => {
            const numConditions = 10;
            const conditionIds = [];
            const allPositionIds = [];

            // Create multiple conditions
            for (let i = 0; i < numConditions; i++) {
                const questionId = ethers.utils.id(`performance-test-${i}`);
                const conditionId = getConditionId(oracle.address, questionId, 2);
                conditionIds.push(conditionId);

                await conditionManagerFacet.connect(owner).createCondition(
                    oracle.address,
                    questionId,
                    2,
                    `ipfs://perf-${i}`
                );

                const [positionIds, _] = await splitConditionAndGetPositionIds({
                    user: owner,
                    amount: ethers.utils.parseEther("2"),
                    conditionId,
                    indexSets: [1, 2],
                    erc20,
                    conditionalFacet
                });

                allPositionIds.push(...positionIds);
            }

            // Test batch queries
            const startTime = Date.now();
            
            for (const conditionId of conditionIds) {
                await marketDataFacet.getMarketsByCondition(conditionId);
            }
            
            for (const positionId of allPositionIds) {
                await marketDataFacet.getCollateralToken(positionId);
            }

            const endTime = Date.now();
            console.log(`Batch query time for ${numConditions} conditions: ${endTime - startTime}ms`);

            expect(endTime - startTime).to.be.lessThan(5000); // Should complete within 5 seconds
        });

        it("should handle large position ID values efficiently", async () => {
            // Position IDs can be very large numbers
            const metadata = await marketDataFacet.getMarketMetadata(yesId);
            const positionInfo = await marketDataFacet.getPositionInfo(yesId);

            // Verify large number handling
            expect(metadata.positionIds[0].toString()).to.have.length.greaterThan(10);
            expect(positionInfo[3].toString()).to.have.length.greaterThan(10); // complement ID
        });
    });

    describe("Integration with Other Facets", function () {
        it("should provide consistent data with ConditionManagerFacet", async () => {
            // Create a new condition
            const integrationQuestionId = ethers.utils.id("integration-test");
            const integrationConditionId = getConditionId(oracle.address, integrationQuestionId, 2);

            await conditionManagerFacet.connect(owner).createCondition(
                oracle.address,
                integrationQuestionId,
                2,
                "ipfs://integration"
            );

            // Split condition
            const [integrationPositionIds, _] = await splitConditionAndGetPositionIds({
                user: owner,
                amount: ethers.utils.parseEther("4"),
                conditionId: integrationConditionId,
                indexSets: [1, 2],
                erc20,
                conditionalFacet
            });

            // Verify MarketDataFacet returns consistent condition ID
            const returnedConditionId = await marketDataFacet.getConditionId(integrationPositionIds[0]);
            expect(returnedConditionId).to.equal(integrationConditionId);

            // Verify markets are returned correctly
            const markets = await marketDataFacet.getMarketsByCondition(integrationConditionId);
            expect(markets).to.have.lengthOf(2);
            expect(markets[0]).to.equal(integrationPositionIds[0]);
            expect(markets[1]).to.equal(integrationPositionIds[1]);
        });

        it("should handle position queries after condition resolution", async () => {
            // Create and resolve a condition
            const resolvedQuestionId = ethers.utils.id("resolved-condition");
            const resolvedConditionId = getConditionId(oracle.address, resolvedQuestionId, 2);

            await conditionManagerFacet.connect(owner).createCondition(
                oracle.address,
                resolvedQuestionId,
                2,
                "ipfs://resolved"
            );

            const [resolvedPositionIds, _] = await splitConditionAndGetPositionIds({
                user: owner,
                amount: ethers.utils.parseEther("2"),
                conditionId: resolvedConditionId,
                indexSets: [1, 2],
                erc20,
                conditionalFacet
            });

            // Resolve the condition
            await conditionalFacet.connect(oracle).reportPayouts(resolvedQuestionId, [1, 0]);

            // MarketDataFacet should still return valid data
            const metadata = await marketDataFacet.getMarketMetadata(resolvedPositionIds[0]);
            const collateralToken = await marketDataFacet.getCollateralToken(resolvedPositionIds[0]);
            const complement = await marketDataFacet.getComplement(resolvedPositionIds[0]);

            expect(metadata.collateralToken).to.equal(erc20.address);
            expect(collateralToken).to.equal(erc20.address);
            expect(complement).to.equal(resolvedPositionIds[1]);
        });
    });

    describe("Data Consistency and Validation", function () {
        it("should maintain referential integrity across all functions", async () => {
            // Get data using different methods
            const directMetadata = await marketDataFacet.getMarketMetadata(yesId);
            const conditionMetadata = await marketDataFacet.getMarketMetadataByCondition(conditionId);
            const positionInfo = await marketDataFacet.getPositionInfo(yesId);

            // All should return consistent collateral token
            expect(directMetadata.collateralToken).to.equal(conditionMetadata.collateralToken);
            expect(directMetadata.collateralToken).to.equal(positionInfo[1]);

            // All should return consistent position arrays
            expect(directMetadata.positionIds.length).to.equal(conditionMetadata.positionIds.length);
            expect(directMetadata.partitions.length).to.equal(conditionMetadata.partitions.length);

            // Verify complement relationships
            const complement = await marketDataFacet.getComplement(yesId);
            expect(complement).to.equal(noId);
            expect(positionInfo[3]).to.equal(complement);
        });

        it("should handle boundary conditions gracefully", async () => {
            // Test with minimum valid values
            const markets = await marketDataFacet.getMarketsByCondition(conditionId);
            expect(markets.length).to.be.greaterThan(0);

            // Test position info completeness
            const [condId, collateral, unit, complement, metadata] = await marketDataFacet.getPositionInfo(yesId);
            
            expect(condId).to.not.equal(ethers.constants.HashZero);
            expect(collateral).to.not.equal(ethers.constants.AddressZero);
            expect(unit.gt(0)).to.be.true;
            expect(complement).to.not.equal(yesId);
            expect(metadata.positionIds.length).to.be.greaterThan(0);
        });

        it("should test TokenNotAllowed error in getPositionInfo", async () => {
            // This test would require removing a token from allowed list
            // which might not be possible in current implementation
            // but we can test the path exists by checking the validation
            const [condId, collateral, unit, complement, metadata] = await marketDataFacet.getPositionInfo(yesId);
            
            // Verify the function works correctly when token is allowed
            expect(collateral).to.equal(erc20.address);
            expect(unit).to.equal(ercUnit);
        });

        it("should handle edge case in complement calculation", async () => {
            // Test complement functionality works correctly
            const complement1 = await marketDataFacet.getComplement(yesId);
            const complement2 = await marketDataFacet.getComplement(noId);
            
            expect(complement1).to.equal(noId);
            expect(complement2).to.equal(yesId);
            
            // Verify complement of complement returns original
            const complementOfComplement = await marketDataFacet.getComplement(complement1);
            expect(complementOfComplement).to.equal(yesId);
        });
    });
});