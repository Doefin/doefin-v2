/**
 * Comprehensive Block Header Oracle Reorg Test
 * Tests oracle deployment, initialization, sequential submissions, and blockchain reorganization handling
 */

const { deployDiamond } = require("../../scripts/deploy.js");
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Block Header Oracle - Comprehensive Reorg Test", function () {
  let diamondAddress, oracle, owner, addr1;
  let productionBlocks, reorgBlocks;

  beforeEach(async function () {
    [owner, addr1] = await ethers.getSigners();

    console.log("\n📋 Deploying Diamond with Block Header Oracle...");
    diamondAddress = await deployDiamond();
    oracle = await ethers.getContractAt("IDoefinBlockHeaderOracle", diamondAddress);

    // Load production blocks from JSON
    const productionData = require("../data/reorg_test/blocks-initiation-till-reorged-block.json");
    productionBlocks = productionData.blocks.map(block => ({
      prevBlockHash: block.prevBlockHash,
      merkleRootHash: block.merkleRootHash,
      blockHash: block.blockHash,
      blockNumber: block.blockNumber,
      version: block.version,
      timestamp: block.timestamp,
      nBits: block.nBits,
      nonce: block.nonce
    }));

    // Load reorg test blocks
    const reorgData = require("../data/reorg_test/blocks-reorg-test.json");
    reorgBlocks = reorgData.blocks.map(block => ({
      prevBlockHash: block.prevBlockHash,
      merkleRootHash: block.merkleRootHash,
      blockHash: block.blockHash,
      blockNumber: block.blockNumber,
      version: block.version,
      timestamp: block.timestamp,
      nBits: block.nBits,
      nonce: block.nonce
    }));

    console.log(`✅ Diamond deployed at ${diamondAddress}`);
    console.log(`📊 Loaded ${productionBlocks.length} production blocks`);
    console.log(`🔄 Loaded ${reorgBlocks.length} reorg test blocks`);
  });

  describe("Comprehensive Oracle Deployment and Reorg Testing", function () {
    it("should complete full oracle lifecycle with reorg handling", async function () {
      console.log("\n=== PHASE 1: ORACLE INITIALIZATION ===");
      
      // Phase 1: Initialize oracle with first 17 blocks (935468-935484)
      const initBlocks = productionBlocks.slice(0, 17);
      const initialHeight = initBlocks[0].blockNumber;
      
      console.log(`🚀 Initializing oracle with first 17 blocks (${initialHeight} to ${initBlocks[16].blockNumber})`);
      
      const initTx = await oracle.initializeBlockHeaderOracle(initBlocks, initialHeight);
      await initTx.wait();
      
      const currentHeight = await oracle.getCurrentBlockHeight();
      expect(currentHeight).to.equal(initBlocks[16].blockNumber);
      
      const latestBlock = await oracle.getLatestBlockHeader();
      expect(latestBlock.blockHash).to.equal(initBlocks[16].blockHash);
      
      console.log(`✅ Oracle initialized successfully at height ${currentHeight}`);
      
      // Verify chain continuity in initialization
      for (let i = 1; i < initBlocks.length; i++) {
        expect(initBlocks[i].prevBlockHash).to.equal(initBlocks[i-1].blockHash);
      }
      console.log(`✅ Chain continuity verified in initialization`);

      console.log("\n=== PHASE 2: SEQUENTIAL BLOCK SUBMISSIONS ===");
      
      // Phase 2: Submit blocks 935485-935497 sequentially
      const additionalBlocks = productionBlocks.slice(17, 30); // Next 13 blocks
      
      console.log(`📦 Submitting ${additionalBlocks.length} additional blocks sequentially`);
      
      for (let i = 0; i < additionalBlocks.length; i++) {
        const block = additionalBlocks[i];
        const expectedPrevHeight = await oracle.getCurrentBlockHeight();
        const expectedPrevBlock = await oracle.getLatestBlockHeader();
        
        // Verify that the block we're submitting chains properly
        expect(block.prevBlockHash).to.equal(expectedPrevBlock.blockHash);
        
        console.log(`  📋 Submitting block ${block.blockNumber} (hash: ${block.blockHash.substring(0,10)}...)`);
        
        const submitTx = await oracle.connect(owner).submitNextBlock(block);
        await submitTx.wait();
        
        // Verify submission was successful
        const newHeight = await oracle.getCurrentBlockHeight();
        expect(newHeight).to.equal(BigInt(expectedPrevHeight) + 1n);
        expect(newHeight).to.equal(block.blockNumber);
        
        const newLatest = await oracle.getLatestBlockHeader();
        expect(newLatest.blockHash).to.equal(block.blockHash);
        expect(newLatest.blockNumber).to.equal(block.blockNumber);
      }
      
      const finalHeight = await oracle.getCurrentBlockHeight();
      console.log(`✅ Sequential submissions completed. Final height: ${finalHeight}`);
      
      // Verify we're now at block 935497
      expect(finalHeight).to.equal(935497);

      console.log("\n=== PHASE 3: REORG SCENARIO TESTING ===");
      
      // Phase 3: Create reorganization by submitting alternative chain
      // The reorg blocks contain a different version of 935497 and subsequent blocks
      
      console.log(`🔄 Testing blockchain reorganization scenario`);
      
      // Current state: Oracle has blocks 935468-935497 (original chain)
      // Reorg data: Contains alternative 935496-935503 (longer chain)
      
      const currentLatest = await oracle.getLatestBlockHeader();
      console.log(`📊 Current chain head: Block ${currentLatest.blockNumber} (${currentLatest.blockHash.substring(0,10)}...)`);
      
      // Find the reorg alternative for block 935497
      const reorgBlock497 = reorgBlocks.find(b => b.blockNumber === 935497);
      const reorgBlock496 = reorgBlocks.find(b => b.blockNumber === 935496);
      
      console.log(`🔍 Original block 935497: ${productionBlocks[29].blockHash.substring(0,10)}...`);
      console.log(`🔍 Alternative block 935497: ${reorgBlock497.blockHash.substring(0,10)}...`);
      
      // Verify the alternative chain has the same 935496 but different 935497
      expect(reorgBlock496.blockHash).to.equal(productionBlocks[28].blockHash);
      expect(reorgBlock497.blockHash).to.not.equal(productionBlocks[29].blockHash);
      
      // Submit the reorg chain (blocks 935497-935503) as a longer alternative
      const reorgChain = reorgBlocks.slice(1); // Skip 935496 (already have it)
      
      console.log(`📦 Submitting reorg chain: ${reorgChain.length} blocks (${reorgChain[0].blockNumber}-${reorgChain[reorgChain.length-1].blockNumber})`);
      
      // Submit as batch to trigger reorg detection
      const batchTx = await oracle.connect(owner).submitBatchBlocks(reorgChain);
      const batchReceipt = await batchTx.wait();
      
      console.log(`✅ Batch submission successful (gas used: ${batchReceipt.gasUsed})`);
      
      // Verify reorg was handled correctly
      const newHeight = await oracle.getCurrentBlockHeight();
      const newLatest = await oracle.getLatestBlockHeader();
      
      console.log(`📊 After reorg - Height: ${newHeight}, Latest: ${newLatest.blockHash.substring(0,10)}...`);
      
      // Should now be at the tip of the longer chain (block 935503)
      expect(newHeight).to.equal(935503);
      expect(newLatest.blockHash).to.equal(reorgBlocks[reorgBlocks.length-1].blockHash);
      expect(newLatest.blockNumber).to.equal(935503);
      
      console.log(`✅ Reorg completed successfully! Chain reorganized from block 935497`);

      console.log("\n=== PHASE 4: POST-REORG VERIFICATION ===");
      
      // Phase 4: Verify the oracle state after reorg
      console.log(`🔍 Verifying post-reorg oracle state`);
      
      // Check that we can retrieve blocks from both the old and new chain portions
      const block496 = await oracle.getBlockHeaderByNumber(935496);
      const block497 = await oracle.getBlockHeaderByNumber(935497);
      const block503 = await oracle.getBlockHeaderByNumber(935503);
      
      // Block 935496 should be unchanged (fork point)
      expect(block496.blockHash).to.equal(reorgBlock496.blockHash);
      
      // Block 935497 should now be the reorg version, not the original
      expect(block497.blockHash).to.equal(reorgBlock497.blockHash);
      expect(block497.blockHash).to.not.equal(productionBlocks[29].blockHash);
      
      // Block 935503 should be the new chain tip
      expect(block503.blockHash).to.equal(reorgBlocks[reorgBlocks.length-1].blockHash);
      
      console.log(`✅ Post-reorg verification completed successfully`);
      
      // Verify chain continuity in the new active chain
      for (let i = 1; i < reorgBlocks.length; i++) {
        const prevBlock = await oracle.getBlockHeaderByNumber(reorgBlocks[i-1].blockNumber);
        const currentBlock = await oracle.getBlockHeaderByNumber(reorgBlocks[i].blockNumber);
        expect(currentBlock.prevBlockHash).to.equal(prevBlock.blockHash);
      }
      
      console.log(`✅ Chain continuity verified in reorganized chain`);

      console.log("\n=== TEST SUMMARY ===");
      console.log(`✨ Successfully completed comprehensive oracle reorg test:`);
      console.log(`   📋 Phase 1: Initialized oracle with 17 blocks (935468-935484)`);
      console.log(`   📋 Phase 2: Added 13 sequential blocks (935485-935497)`);
      console.log(`   📋 Phase 3: Processed reorg with 7 alternative blocks (935497-935503)`);
      console.log(`   📋 Phase 4: Verified final state and chain continuity`);
      console.log(`   🎯 Final chain height: ${newHeight} blocks`);
      console.log(`   🔄 Reorg depth: 1 block (935497)`);
      console.log(`   📈 Chain extension: 6 new blocks (935498-935503)`);

    });

    it("should handle invalid reorg attempts correctly", async function () {
      console.log("\n=== TESTING INVALID REORG REJECTION ===");
      
      // Initialize oracle with first 17 blocks
      const initBlocksInvalid = productionBlocks.slice(0, 17);
      const initialHeightInvalid = initBlocksInvalid[0].blockNumber;
      
      await oracle.initializeBlockHeaderOracle(initBlocksInvalid, initialHeightInvalid);
      
      // Submit additional blocks to reach 935489
      const additionalBlocksInvalid = productionBlocks.slice(17, 22);
      for (const block of additionalBlocksInvalid) {
        await oracle.connect(owner).submitNextBlock(block);
      }
      
      // Attempt to submit a shorter reorg chain (should fail) 
      const invalidReorg = [
        {
          ...reorgBlocks.find(b => b.blockNumber === 935497),
          blockHash: "0x" + "1".repeat(64) // Invalid hash
        }
      ];
      
      console.log(`🚫 Attempting invalid reorg with bad hash`);
      
      await expect(
        oracle.connect(owner).submitBatchBlocks(invalidReorg)
      ).to.be.reverted;
      
      console.log(`✅ Invalid reorg correctly rejected`);
      
      // Verify oracle state unchanged
      const height = await oracle.getCurrentBlockHeight();
      expect(height).to.equal(935489);
    });

    it("should reject reorg attempts that don't provide longer chains", async function () {
      console.log("\n=== TESTING SHORTER REORG REJECTION ===");
      
      // Initialize and submit blocks up to 935497
      const initBlocksShorter = productionBlocks.slice(0, 17);
      await oracle.initializeBlockHeaderOracle(initBlocksShorter, initBlocksShorter[0].blockNumber);
      
      const heightAfterInitialization = await oracle.getCurrentBlockHeight();
      console.log(`📊 Oracle Block Height After Initialization: ${heightAfterInitialization}`);

      const additionalBlocksShorter = productionBlocks.slice(17, 30);
      for (const block of additionalBlocksShorter) {
        await oracle.connect(owner).submitNextBlock(block);
      }

      const heightAfterAdditional = await oracle.getCurrentBlockHeight();
      console.log(`📊 Oracle Block Height After Submitting the additional blocks: ${heightAfterAdditional}`);

      const latestBlock = await oracle.getLatestBlockHeader();

      // Try to submit a reorg that's not longer than current chain
      const shorterReorg = reorgBlocks.slice(1, 2); // Only 935497 (not longer)
      console.log(`🔍 Attempting to submit a slice: ${shorterReorg.map(b => b.blockNumber).join(', ')}`);

      console.log(`🚫 Attempting reorg with shorter chain`);

      // Shorter reorgs should be deterministically rejected
      await expect(oracle.connect(owner).submitBatchBlocks(shorterReorg))
        .to.be.revertedWith("BlockHeaderOracle_NewChainNotLonger");
      
      console.log(`✅ Shorter reorg correctly rejected as expected`);
    });
  });
});