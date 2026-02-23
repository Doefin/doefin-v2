#!/usr/bin/env node

const { ethers } = require("hardhat");
const hre = require("hardhat");
require("dotenv").config();

/**
 * Upgrade script for DoefinV1BlockHeaderOracleFacet critical fixes
 * 
 * Changes:
 * - DoefinV1BlockHeaderOracleFacet.sol: Fixed settlement timing in _applyChain method
 *   • _applyChain now calls _settleCondition() after each block instead of only at the end
 *   • Prevents skipped settlements for intermediate blocks during batch submissions
 * - DoefinV1BlockHeaderOracleFacet.sol: Fixed fork point boundary condition
 *   • Updated _findForkPoint fallback to prevent arithmetic underflow at buffer edges
 *   • Changed condition from "> currentHeight - NUM_OF_BLOCK_HEADERS" to "> currentHeight - NUM_OF_BLOCK_HEADERS + 1"
 */

async function main() {
    console.log("Starting DoefinV1BlockHeaderOracleFacet upgrade...");
    
    // Configuration from environment variables
    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS;
    if (!DIAMOND_ADDRESS) {
        throw new Error("DIAMOND_ADDRESS not set in environment variables");
    }
    
    const [deployer] = await ethers.getSigners();
    console.log("Deploying with account:", deployer.address);
    console.log("Diamond address:", DIAMOND_ADDRESS);
    console.log("Network:", hre.network.name);
    
    // Get diamond interfaces
    const diamondCut = await ethers.getContractAt("IDiamondCut", DIAMOND_ADDRESS);
    const diamondLoupe = await ethers.getContractAt("IDiamondLoupe", DIAMOND_ADDRESS);
    
    // 1. Handle BlockHeaderUtils library
    console.log("\n=== Setting up BlockHeaderUtils Library ===");
    let blockHeaderUtilsAddress = process.env.BLOCK_HEADER_UTILS_ADDRESS;
    
    if (blockHeaderUtilsAddress) {
        console.log("Using existing BlockHeaderUtils at:", blockHeaderUtilsAddress);
    } else {
        console.log("⚠️  BLOCK_HEADER_UTILS_ADDRESS not set - deploying new library");
        console.log("💡 To save gas in future, set BLOCK_HEADER_UTILS_ADDRESS in your .env");
        
        const BlockHeaderUtilsLib = await ethers.getContractFactory("BlockHeaderUtils");
        const blockHeaderUtils = await BlockHeaderUtilsLib.deploy();
        await blockHeaderUtils.deployed();
        blockHeaderUtilsAddress = blockHeaderUtils.address;
        console.log("New BlockHeaderUtils deployed:", blockHeaderUtilsAddress);
        console.log("💡 Save this address: BLOCK_HEADER_UTILS_ADDRESS=" + blockHeaderUtilsAddress);
    }
    
    // 2. Deploy new DoefinV1BlockHeaderOracleFacet
    console.log("\n=== Deploying New DoefinV1BlockHeaderOracleFacet ===");
    const DoefinV1BlockHeaderOracleFacet = await ethers.getContractFactory("DoefinV1BlockHeaderOracle", {
        libraries: { BlockHeaderUtils: blockHeaderUtilsAddress },
    });
    
    const existingBlockHeaderFacetAddress = process.env.NEW_BLOCK_HEADER_ORACLE_FACET_ADDRESS;
    let blockHeaderOracleFacet;
    
    if (existingBlockHeaderFacetAddress) {
        console.log("Using existing DoefinV1BlockHeaderOracleFacet at:", existingBlockHeaderFacetAddress);
        blockHeaderOracleFacet = { address: existingBlockHeaderFacetAddress };
    } else {
        blockHeaderOracleFacet = await DoefinV1BlockHeaderOracleFacet.deploy();
        await blockHeaderOracleFacet.deployed();
        console.log("New DoefinV1BlockHeaderOracleFacet deployed at:", blockHeaderOracleFacet.address);
        console.log("💡 To reuse this deployment, set NEW_BLOCK_HEADER_ORACLE_FACET_ADDRESS=" + blockHeaderOracleFacet.address + " in your .env");
    }
    
    // 3. Find current DoefinV1BlockHeaderOracleFacet
    console.log("\n=== Finding Current DoefinV1BlockHeaderOracleFacet ===");
    const currentFacets = await diamondLoupe.facets();
    
    let currentBlockHeaderOracleFacet = null;
    
    // Generate selectors dynamically from contract interface
    const blockHeaderSelectors = Object.values(DoefinV1BlockHeaderOracleFacet.interface.functions)
        .filter(func => func.type === 'function')
        .map(func => DoefinV1BlockHeaderOracleFacet.interface.getSighash(func));
    
    for (const facet of currentFacets) {
        const facetSelectors = await diamondLoupe.facetFunctionSelectors(facet.facetAddress);
        
        const hasBlockHeaderSelectors = facetSelectors.some(selector => 
            blockHeaderSelectors.includes(selector)
        );
        
        if (hasBlockHeaderSelectors) {
            currentBlockHeaderOracleFacet = facet.facetAddress;
            console.log("Current DoefinV1BlockHeaderOracleFacet found at:", currentBlockHeaderOracleFacet);
            break;
        }
    }
    
    if (!currentBlockHeaderOracleFacet) {
        throw new Error("Could not find current DoefinV1BlockHeaderOracleFacet - check selectors");
    }
    
    // 4. Get new function selectors
    console.log("\n=== Getting New Function Selectors ===");
    const newBlockHeaderOracleSelectors = Object.values(DoefinV1BlockHeaderOracleFacet.interface.functions)
        .filter(func => func.type === 'function')
        .map(func => DoefinV1BlockHeaderOracleFacet.interface.getSighash(func));
    
    console.log("New DoefinV1BlockHeaderOracleFacet selectors:", newBlockHeaderOracleSelectors.length);
    
    // 5. Prepare diamond cut
    console.log("\n=== Preparing Diamond Cut ===");
    const FacetCutAction = { Add: 0, Replace: 1, Remove: 2 };
    
    const cut = [
        {
            facetAddress: blockHeaderOracleFacet.address,
            action: FacetCutAction.Replace,
            functionSelectors: newBlockHeaderOracleSelectors
        }
    ];
    
    console.log("Diamond cut configuration:");
    console.log("- REPLACE DoefinV1BlockHeaderOracleFacet with settlement timing fix");
    console.log("- Old address:", currentBlockHeaderOracleFacet);
    console.log("- New address:", blockHeaderOracleFacet.address);
    
    // 6. Estimate gas
    console.log("\n=== Gas Estimation ===");
    try {
        const gasEstimate = await diamondCut.estimateGas.diamondCut(cut, ethers.constants.AddressZero, "0x");
        console.log("Estimated gas:", gasEstimate.toString());
    } catch (error) {
        console.warn("Gas estimation failed:", error.message);
    }
    
    // 7. Execute upgrade
    console.log("\n=== Executing Upgrade ===");
    const tx = await diamondCut.diamondCut(cut, ethers.constants.AddressZero, "0x");
    console.log("Transaction hash:", tx.hash);
    
    const receipt = await tx.wait();
    console.log("Transaction confirmed in block:", receipt.blockNumber);
    console.log("Gas used:", receipt.gasUsed.toString());
    
    // 8. Verify upgrade
    console.log("\n=== Verifying Upgrade ===");
    
    // Wait for transaction to be processed
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const updatedFacets = await diamondLoupe.facets();
    
    let newBlockHeaderFacetFound = null;
    
    // Define key selectors to verify
    const keySelectors = ['submitBatchBlocks', 'submitNextBlock', 'getCurrentBlockHeight']
        .map(name => DoefinV1BlockHeaderOracleFacet.interface.getSighash(name));
    
    for (const facet of updatedFacets) {
        const facetSelectors = await diamondLoupe.facetFunctionSelectors(facet.facetAddress);
        
        // Check if this facet has all key block header oracle selectors
        const hasAllKeySelectors = keySelectors.every(sel => facetSelectors.includes(sel));
        if (hasAllKeySelectors) {
            newBlockHeaderFacetFound = facet.facetAddress;
            break;
        }
    }
    
    console.log("Verification results:");
    console.log("- DoefinV1BlockHeaderOracleFacet updated to:", newBlockHeaderFacetFound);
    console.log("- Expected:", blockHeaderOracleFacet.address);
    
    const upgradeSuccess = newBlockHeaderFacetFound === blockHeaderOracleFacet.address;
    
    if (upgradeSuccess) {
        console.log("✅ DoefinV1BlockHeaderOracleFacet successfully upgraded");
    } else {
        throw new Error("Upgrade verification failed");
    }
    
    console.log("\n=== Upgrade Complete ===");
    console.log("Summary:");
    console.log("- DoefinV1BlockHeaderOracleFacet: Settlement timing fix applied");
    console.log("  • _applyChain now calls _settleCondition() after each block");
    console.log("  • Improved settlement performance for batch block submissions");
    console.log("\n🎉 Block header oracle settlement timing successfully upgraded!");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("Block header oracle upgrade failed:", error);
        process.exit(1);
    });