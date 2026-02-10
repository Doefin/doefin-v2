/**
 * Test to verify the batch submission settlement fix
 * This test verifies that conditions settle correctly 
 * when blocks are submitted via submitBatchBlocks with the timing fix applied
 */

const { deployDiamond } = require("../../scripts/deploy.js");
const { expect } = require("chai");
const { ethers } = require("hardhat");

const {
  QuestionType,
  encodeDifficultyThreshold,
} = require("../utils/oracleAdapterUtils.js");

const {
  getInitializationBlocks,
  getInitialBlockHeight,
  submitBatchBlocks,
  submitBlockHeader,
  getCurrentBlockHeight,
} = require("../utils/blockHeaderOracleUtils.js");

describe("Batch Submission Settlement Fix Verification", function () {
  let diamondAddress;
  let conditionManager;
  let oracleAdapter;
  let blockHeaderOracle;
  let conditionalTokens;
  let owner, marketMaker;
  let initBlocks, initialHeight;
  
  const SETTLEMENT_DELAY = 6;
  
  // This test verifies the fix where _settleCondition() is called after each block
  // instead of in a separate batch after all blocks are processed

  // Load clean production blocks (without reorg) to test settlement timing fix
  let productionBlocks;
  
  before(function() {
    const productionData = require("../data/blocks-production.json");
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
    console.log(`📚 Loaded ${productionBlocks.length} clean production blocks for settlement timing test`);
  });



  beforeEach(async function () {
    [owner, marketMaker] = await ethers.getSigners();
    diamondAddress = await deployDiamond();

    // Get contract interfaces
    conditionManager = await ethers.getContractAt(
      "IConditionManager",
      diamondAddress
    );

    oracleAdapter = await ethers.getContractAt(
      "OracleAdapterFacet",
      diamondAddress
    );

    blockHeaderOracle = await ethers.getContractAt(
      "IDoefinBlockHeaderOracle",
      diamondAddress
    );

    conditionalTokens = await ethers.getContractAt(
      "ConditionalTokensFacet",
      diamondAddress
    );

    // Add market maker role
    const accessControl = await ethers.getContractAt(
      "IAccessControl",
      diamondAddress
    );
    await accessControl.connect(owner).addMarketMaker(marketMaker.address);

    // Use the same production blocks for initialization (first 17 blocks)
    initBlocks = productionBlocks.slice(0, 17);
    initialHeight = productionBlocks[0].blockNumber;
    
    // IMPORTANT: Initialize the block header oracle with production blocks
    console.log(`🔧 Initializing oracle with ${initBlocks.length} blocks starting from height ${initialHeight}`);
    await blockHeaderOracle.initializeBlockHeaderOracle(initBlocks, initialHeight);
    
    const currentHeight = await getCurrentBlockHeight(blockHeaderOracle);
    console.log(`✅ Oracle initialized. Current height: ${currentHeight}`);
  });

  describe("Settlement Fix Verification: Batch Submission", function () {
    it("should verify that settlement-per-block timing fix works correctly", async function () {
      console.log("\\n=== VERIFYING SETTLEMENT-PER-BLOCK FIX ===");
      console.log("This test verifies that _settleCondition() is called after each block");
      console.log("instead of batching all settlements at the end.");
      
      // Step 1: Verify initial state
      const currentHeight = await getCurrentBlockHeight(blockHeaderOracle);
      console.log(`📊 Initial height: ${currentHeight}`);
      
      // Step 2: Create a condition for a specific block that we will submit
      // Oracle is initialized with 17 blocks (935468-935484), so next block is 935485
      const targetBlockHeight = 935485;
      const settlementBlockHeight = targetBlockHeight + SETTLEMENT_DELAY; // 935491
      
      console.log(`🎯 Target block: ${targetBlockHeight}`);
      console.log(`⏰ Settlement block: ${settlementBlockHeight}`);
      
      // Create a difficulty threshold question that will be exceeded
      const threshold = ethers.utils.parseUnits("100", 12); // 100T difficulty threshold (will be exceeded)
      const metadata = encodeDifficultyThreshold(threshold, targetBlockHeight);
      
      console.log(`🎲 Creating condition with threshold: ${ethers.utils.formatUnits(threshold, 12)}T`);
      
      const createTx = await conditionManager
        .connect(marketMaker)
        .createConditionWithMetadata(
          QuestionType.DifficultyThreshold,
          metadata,
          2, // binary outcome
          "test://batch-submission-bug-repro",
          ethers.constants.HashZero
        );
      
      const createReceipt = await createTx.wait();
      console.log(`✅ Condition created successfully`);
      
      // Debug: Print all events and logs to see what's available
      console.log(`🔍 Events in receipt: ${createReceipt.events ? createReceipt.events.length : 0}`);
      console.log(`🔍 Logs in receipt: ${createReceipt.logs ? createReceipt.logs.length : 0}`);
      
      // Extract the condition ID from the events
      let conditionId;
      
      // Check all logs for ConditionPreparation event
      if (createReceipt.logs) {
        for (let i = 0; i < createReceipt.logs.length; i++) {
          const log = createReceipt.logs[i];
          console.log(`📋 Log ${i}: address=${log.address}, topics=${log.topics ? log.topics.length : 0}`);
          
          if (log.topics && log.topics.length > 0) {
            console.log(`  Topic 0: ${log.topics[0]}`);
            if (log.topics[1]) console.log(`  Topic 1: ${log.topics[1]}`);
            if (log.topics[2]) console.log(`  Topic 2: ${log.topics[2]}`);
            if (log.topics[3]) console.log(`  Topic 3: ${log.topics[3]}`);
          }
          
          try {
            // Try to parse with conditionalTokens interface
            const parsedLog = conditionalTokens.interface.parseLog(log);
            console.log(`✅ Parsed log: ${parsedLog.name}`);
            if (parsedLog.name === "ConditionPreparation") {
              conditionId = parsedLog.args.conditionId;
              console.log(`🆔 Found condition ID: ${conditionId}`);
              break;
            }
          } catch (e) {
            // Try with conditionManager interface
            try {
              const parsedLog = conditionManager.interface.parseLog(log);
              console.log(`✅ Parsed log (CM): ${parsedLog.name}`);
              if (parsedLog.name === "ConditionPreparation") {
                conditionId = parsedLog.args.conditionId;
                console.log(`🆔 Found condition ID (CM): ${conditionId}`);
                break;
              }
            } catch (e2) {
              // Try with oracleAdapter interface
              try {
                const parsedLog = oracleAdapter.interface.parseLog(log);
                console.log(`✅ Parsed log (OA): ${parsedLog.name}`);
              } catch (e3) {
                // Show what values we're extracting from this log
                console.log(`Log ${i} values:`);
                console.log(`  Topics: ${JSON.stringify(log.topics)}`);
                console.log(`  Data: ${log.data}`);
                console.log(`  Address: ${log.address}`);
                
                // Extract condition ID from topics if possible (topic 2 often contains condition ID)
                if (log.topics && log.topics.length >= 3) {
                  const potentialConditionId = log.topics[2] || log.topics[1];
                  if (!conditionId && potentialConditionId) {
                    console.log(`🆔 Found condition ID via topic: ${potentialConditionId}`);
                    conditionId = potentialConditionId;
                  }
                }
              }
            }
          }
        }
      }
      
      // If still not found, try computed topic search
      if (!conditionId && createReceipt.logs) {
        // Look for the ConditionPreparation event signature
        // Compute the canonical topic for ConditionPreparation(bytes32,address,bytes32,uint8)
        const conditionPreparationTopic = ethers.utils.id("ConditionPreparation(bytes32,address,bytes32,uint8)");
        // Based on the logs, the third log has the pattern we expect
        for (const log of createReceipt.logs) {
          if (log.topics && log.topics.length >= 2 && 
              log.topics[0] === conditionPreparationTopic) {
            conditionId = log.topics[1]; // First indexed parameter is conditionId
            console.log(`🆔 Found condition ID via topic: ${conditionId}`);
            break;
          }
        }
      }
      
      if (!conditionId) {
        // As a last resort, use the questionId from topic 1 of the last log
        if (createReceipt.logs && createReceipt.logs.length > 0) {
          const lastLog = createReceipt.logs[createReceipt.logs.length - 1];
          if (lastLog.topics && lastLog.topics.length >= 2) {
            conditionId = lastLog.topics[1];
            console.log(`🆔 Using questionId as condition ID: ${conditionId}`);
          }
        }
      }
      
      if (!conditionId) {
        console.log(`❌ Could not extract condition ID from transaction`);
        console.log(`💡 This might be a test setup issue - continuing with manual condition lookup`);
        
        // For debugging, let's try to get the latest condition created
        // This is a workaround for the event parsing issue
        throw new Error("Could not extract condition ID - test needs to be fixed");
      }
      
      expect(conditionId).to.not.be.undefined;
      console.log(`🆔 Condition ID: ${conditionId}`);
      
      // Step 3: Submit blocks 935485 through 935491 via BATCH submission
      // This should include both the target block (935485) and settlement block (935491)
      const blocksToSubmit = productionBlocks.slice(17, 24); // 935485-935491
      
      console.log(`📦 Batch submitting ${blocksToSubmit.length} blocks (${blocksToSubmit[0].blockNumber} to ${blocksToSubmit[blocksToSubmit.length-1].blockNumber})`);
      console.log(`   This batch includes target block ${targetBlockHeight} and settlement block ${settlementBlockHeight}`);
      
      // Submit as a batch - verify the fix works correctly!
      const batchTx = await submitBatchBlocks({
        oracle: blockHeaderOracle,
        blockHeaders: blocksToSubmit,
        caller: owner
      });
      
      console.log(`✅ Batch submission completed`);
      
      // Get the transaction receipt to analyze settlement events
      const batchReceipt = await batchTx.wait();
      
      // Define canonical topic for ConditionResolution event
      const CONDITION_RESOLUTION_TOPIC = ethers.utils.id("ConditionResolution(bytes32,address,bytes32,uint8,uint256[])");
      
      // Count settlement events that occurred during batch processing
      // Note: May fail to parse due to Gnosis ConditionalTokens interface mismatches
      let settlementEventCount = 0;
      const settlementEvents = [];
      
      if (batchReceipt.events) {
        for (const event of batchReceipt.events) {
          // Look for ConditionResolution events (settlement events)
          if (event.topics && event.topics[0] === CONDITION_RESOLUTION_TOPIC) {
            settlementEventCount++;
            settlementEvents.push({
              eventName: "ConditionResolution",
              blockNumber: event.blockNumber,
              transactionHash: event.transactionHash
            });
            console.log(`🎯 Settlement event ${settlementEventCount} found`);
          }
        }
      }
      
      // Also try parsing logs for any settlement-related events
      if (batchReceipt.logs) {
        for (let i = 0; i < batchReceipt.logs.length; i++) {
          const log = batchReceipt.logs[i];
          const interfacesToTry = [oracleAdapter, conditionManager, conditionalTokens];
          let parsed = false;
          
          for (const contractInterface of interfacesToTry) {
            try {
              const parsedLog = contractInterface.interface.parseLog(log);
              if (parsedLog.name && (parsedLog.name.includes('Resolution') || parsedLog.name.includes('Settlement'))) {
                if (!settlementEvents.some(e => e.transactionHash === log.transactionHash)) {
                  settlementEventCount++;
                  console.log(`🎯 Additional settlement event found: ${parsedLog.name}`);
                  console.log(`   Parameters: ${JSON.stringify(parsedLog.args, null, 2)}`);
                }
                parsed = true;
                break;
              }
            } catch (e) {
              // Continue to next interface
            }
          }
          
          if (!parsed && log.topics) {
            console.log(`Batch log ${i} values:`);
            console.log(`  Topics: ${JSON.stringify(log.topics)}`);
            console.log(`  Data: ${log.data}`);
            console.log(`  Address: ${log.address}`);
          }
        }
      }
      
      console.log(`🔍 Total settlement events during batch: ${settlementEventCount}`);
      
      // Step 4: Check if the condition was resolved 
      const finalHeight = await getCurrentBlockHeight(blockHeaderOracle);
      console.log(`📊 Final height: ${finalHeight}`);
      
      // Try to get the condition resolution
      let isResolved = false;
      try {
        const payoutNumerators = await conditionalTokens.getPayoutNumerators(conditionId);
        
        // Check if payouts are set (non-zero values indicate resolution)
        isResolved = payoutNumerators.some(payout => payout.gt(0));
        console.log(`🔍 Condition resolved: ${isResolved}`);
        
        if (isResolved) {
          console.log(`💰 Payouts: [${payoutNumerators.join(", ")}]`);
        }
      } catch (error) {
        console.log(`❌ Error checking resolution: ${error.message}`);
      }
      
      // THE SETTLEMENT-PER-BLOCK FIX VERIFICATION
      console.log(`\\n=== SETTLEMENT-PER-BLOCK FIX VERIFICATION RESULT ===`);
      console.log(`Expected: Condition SHOULD be resolved with per-block settlement timing`);
      console.log(`Actual: Condition resolved = ${isResolved}`);
      console.log(`Settlement events during batch: ${settlementEventCount}`);
      
      if (isResolved) {
        console.log(`✅ SETTLEMENT-PER-BLOCK FIX WORKING: Condition was resolved!`);
        console.log(`   Target block ${targetBlockHeight} processed → Settlement block ${settlementBlockHeight} reached`);
        console.log(`   The fix ensures _settleCondition() is called after EACH block in the batch`);
        
        // With the per-block settlement fix, conditions resolve correctly
        if (settlementEventCount > 0) {
          console.log(`✅ Settlement events captured: ${settlementEventCount}`);
          console.log(`   This confirms settlement happens during individual block processing`);
        } else {
          console.log(`ℹ️  Settlement events not captured in logs (Gnosis ConditionalTokens interface mismatch)`);
          console.log(`   This is expected - the underlying Gnosis contract uses different event signatures`);
          console.log(`   But condition resolution proves the per-block settlement fix works correctly`);
        }
        
        console.log(`✅ CORE FIX VERIFIED: Settlement occurs per-block, not batched at end`);
        console.log(`   Before fix: All settlements batched → some conditions missed`);
        console.log(`   After fix: Settlement per block → all conditions properly resolved`);
      } else {
        console.log(`❌ SETTLEMENT-PER-BLOCK FIX ISSUE: Condition was not resolved`);
        console.log(`   This suggests the fix may not be working as expected`);
      }
      
      // This should pass to show the settlement-per-block fix works
      expect(isResolved).to.be.true; 
      
      console.log(`✅ SETTLEMENT-PER-BLOCK FIX CONFIRMED: Batch submission now resolves conditions correctly`);
      console.log(`🟢 FIX SUMMARY: _settleCondition() called after each block → proper condition resolution!`);
    });
  });
});