#!/usr/bin/env node

/**
 * SCRUM-120 — Remove registerPositionPairs from _splitPositionInternal
 *
 * Root cause: _splitPositionInternal (called during Mint settlement) was
 * calling registerPositionPairs, which re-ran an order-sensitive consistency
 * check against the initial market registration. When the taker held the
 * higher indexSet (YES=2, maker=NO=1), the partition arrived as [2,1] but the
 * registry stored [1,2] from the original splitPosition — index 0 mismatch →
 * InvalidMatch() revert.
 *
 * Fix: removed the registerPositionPairs call from _splitPositionInternal.
 * The registry is already fully populated by the initial splitPosition that
 * seeded the market. Settlement mints must only mint tokens, not touch the
 * registry again.
 *
 * Affected facet: SettlementFacet only.
 *   - SettlementFacet calls _splitPositionInternal (behavioral change).
 *   - ConditionalTokensFacet calls _splitPosition (unchanged, no redeploy needed).
 *   - ConditionManagerFacet only uses prepareCondition (unchanged, no redeploy needed).
 *
 * Environment variables:
 *   DIAMOND_ADDRESS                   (required) target diamond proxy
 *   NEW_SETTLEMENT_FACET_ADDRESS      (optional) reuse an already-deployed facet
 *   SKIP_VERIFICATION                 (optional) skip loupe re-read after cut
 */

const { ethers } = require("hardhat");
const hre = require("hardhat");
require("dotenv").config();

// Stable selector used to locate the current SettlementFacet on-chain.
const GET_OPERATOR_SELECTOR = ethers.utils.id("getOperator()").substring(0, 10);

async function main() {
    console.log("=== SCRUM-120 SettlementFacet diamond-cut upgrade ===");

    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS;
    if (!DIAMOND_ADDRESS) throw new Error("DIAMOND_ADDRESS not set in environment");

    const [deployer] = await ethers.getSigners();
    console.log("Deployer:", deployer.address);
    console.log("Diamond :", DIAMOND_ADDRESS);
    console.log("Network :", hre.network.name);

    const diamondCut   = await ethers.getContractAt("IDiamondCut",   DIAMOND_ADDRESS);
    const diamondLoupe = await ethers.getContractAt("IDiamondLoupe", DIAMOND_ADDRESS);
    const FacetCutAction = { Add: 0, Replace: 1, Remove: 2 };

    // -------------------------------------------------------------------------
    // 1. Deploy (or reuse) the new SettlementFacet
    // -------------------------------------------------------------------------
    console.log("\n--- Step 1: Deploy new SettlementFacet ---");
    const SettlementFacet = await ethers.getContractFactory("SettlementFacet");
    let newFacetAddress = process.env.NEW_SETTLEMENT_FACET_ADDRESS;
    if (newFacetAddress) {
        console.log("Reusing existing deployment at:", newFacetAddress);
    } else {
        const facet = await SettlementFacet.deploy();
        await facet.deployed();
        newFacetAddress = facet.address;
        console.log("Deployed at:", newFacetAddress);
        console.log("  NEW_SETTLEMENT_FACET_ADDRESS=" + newFacetAddress);
    }

    // -------------------------------------------------------------------------
    // 2. Compute selector set from the new ABI
    // -------------------------------------------------------------------------
    const newSelectors = Object.values(SettlementFacet.interface.functions)
        .filter(f => f.type === "function")
        .map(f => SettlementFacet.interface.getSighash(f));

    console.log("\n--- Step 2: Selector set (" + newSelectors.length + " selectors) ---");
    newSelectors.forEach(s => {
        const name = Object.values(SettlementFacet.interface.functions)
            .find(f => SettlementFacet.interface.getSighash(f) === s).name;
        console.log("  " + s + "  " + name);
    });

    // -------------------------------------------------------------------------
    // 3. Locate the current SettlementFacet via DiamondLoupe
    // -------------------------------------------------------------------------
    console.log("\n--- Step 3: Locate current SettlementFacet on-chain ---");
    const currentFacets = await diamondLoupe.facets();
    const selectorToFacet = new Map();
    for (const f of currentFacets) {
        for (const s of f.functionSelectors) {
            selectorToFacet.set(s.toLowerCase(), f.facetAddress.toLowerCase());
        }
    }

    const oldFacetAddress = selectorToFacet.get(GET_OPERATOR_SELECTOR);
    if (!oldFacetAddress) {
        throw new Error(
            "Could not locate current SettlementFacet on diamond " +
            "(getOperator selector " + GET_OPERATOR_SELECTOR + " not found)."
        );
    }
    console.log("Current SettlementFacet:", oldFacetAddress);
    console.log("New     SettlementFacet:", newFacetAddress.toLowerCase());

    if (oldFacetAddress === newFacetAddress.toLowerCase()) {
        console.log("WARNING: new address is the same as current — did the facet compile?");
    }

    // -------------------------------------------------------------------------
    // 4. Build the diamond cut (Replace existing selectors, Add any new ones)
    // -------------------------------------------------------------------------
    console.log("\n--- Step 4: Build diamond cut ---");
    const toReplace = [];
    const toAdd = [];
    for (const s of newSelectors) {
        if (selectorToFacet.has(s.toLowerCase())) {
            toReplace.push(s);
        } else {
            toAdd.push(s);
        }
    }

    const cut = [];
    if (toReplace.length) {
        cut.push({ facetAddress: newFacetAddress, action: FacetCutAction.Replace, functionSelectors: toReplace });
    }
    if (toAdd.length) {
        cut.push({ facetAddress: newFacetAddress, action: FacetCutAction.Add, functionSelectors: toAdd });
    }

    console.log("Replace:", toReplace.length, "selectors →", newFacetAddress);
    console.log("Add    :", toAdd.length,     "selectors →", newFacetAddress);

    // -------------------------------------------------------------------------
    // 5. Gas estimate
    // -------------------------------------------------------------------------
    try {
        const gas = await diamondCut.estimateGas.diamondCut(cut, ethers.constants.AddressZero, "0x");
        console.log("\nGas estimate:", gas.toString());
    } catch (err) {
        console.warn("\nGas estimation failed (non-fatal):", err.message);
    }

    // -------------------------------------------------------------------------
    // 6. Execute
    // -------------------------------------------------------------------------
    console.log("\n--- Step 5: Execute diamond cut ---");
    const tx = await diamondCut.diamondCut(cut, ethers.constants.AddressZero, "0x");
    console.log("Tx hash:", tx.hash);
    const receipt = await tx.wait();
    console.log("Confirmed in block:", receipt.blockNumber);
    console.log("Gas used:", receipt.gasUsed.toString());

    if (process.env.SKIP_VERIFICATION) {
        console.log("\nSkipping verification (SKIP_VERIFICATION set).");
        return;
    }

    // -------------------------------------------------------------------------
    // 7. Verify
    // -------------------------------------------------------------------------
    console.log("\n--- Step 6: Verify ---");
    await new Promise(r => setTimeout(r, 2000));

    const postFacets = await diamondLoupe.facets();
    const postMap = new Map();
    for (const f of postFacets) {
        for (const s of f.functionSelectors) {
            postMap.set(s.toLowerCase(), f.facetAddress.toLowerCase());
        }
    }

    const expected = newFacetAddress.toLowerCase();
    let allOk = true;
    for (const s of newSelectors) {
        const actual = postMap.get(s.toLowerCase());
        if (actual !== expected) {
            console.error("FAIL selector", s, "→ expected", expected, "got", actual ?? "<missing>");
            allOk = false;
        }
    }
    if (!allOk) throw new Error("Verification failed — one or more selectors not routed correctly.");

    console.log("All SettlementFacet selectors route to:", expected);
    console.log("\n=== SCRUM-120 upgrade complete ===");
}

main()
    .then(() => process.exit(0))
    .catch(err => {
        console.error("SCRUM-120 upgrade failed:", err);
        process.exit(1);
    });
