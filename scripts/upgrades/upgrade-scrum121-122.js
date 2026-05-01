#!/usr/bin/env node

/**
 * SCRUM-121 / SCRUM-122 — SettlementFacet upgrade
 *
 * SCRUM-121: Fix _settleMint and _settleMerge to fill at maker's effective price.
 *   Previously both paths split collateral/payout based on the taker's signed price,
 *   discarding any price improvement the maker offered. Now:
 *     _settleMint:  makerCollateral = P_m × fill / unit
 *                   takerCollateral = fill − makerCollateral  (effective price = unit − P_m)
 *     _settleMerge: makerPayout = P_m × fill / unit
 *                   takerPayout = fill − makerPayout          (effective return = unit − P_m)
 *   Crossing guards updated:
 *     Mint:  P_t + P_m < unit  → revert InvalidMatch()
 *     Merge: P_t + P_m > unit  → revert InvalidMatch()
 *
 * SCRUM-122: Remove minFillAmount on-chain enforcement.
 *   Dropped the FillBelowMinimum check from _checkFillAmount and removed
 *   the Errors.FillBelowMinimum error. minFillAmount remains in the DoefinOrder
 *   struct and EIP-712 hash — enforcement moves fully off-chain to the matcher.
 *
 * SCRUM-123: Tests only — no on-chain changes, no redeploy needed.
 *
 * Affected facet: SettlementFacet only (internal logic changes, no ABI changes).
 * All public selectors remain the same — this is a pure Replace cut.
 *
 * Environment variables:
 *   DIAMOND_ADDRESS              (required) target diamond proxy
 *   SETTLEMENT_FACET             (optional) reuse an already-deployed facet address
 *   SKIP_VERIFICATION            (optional) skip loupe re-read after cut
 */

const { ethers } = require("hardhat");
const hre = require("hardhat");
require("dotenv").config();

// Stable selector used to locate the current SettlementFacet on-chain.
const GET_OPERATOR_SELECTOR = ethers.utils.id("getOperator()").substring(0, 10);

async function main() {
    console.log("=== SCRUM-121/122 SettlementFacet diamond-cut upgrade ===");

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
    let newFacetAddress = process.env.SETTLEMENT_FACET;
    if (newFacetAddress) {
        console.log("Reusing existing deployment at:", newFacetAddress);
    } else {
        const facet = await SettlementFacet.deploy();
        await facet.deployed();
        newFacetAddress = facet.address;
        console.log("Deployed at:", newFacetAddress);
        console.log("  SETTLEMENT_FACET=" + newFacetAddress);
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
    // 4. Build the diamond cut
    //    Replace selectors already on-chain, Add any new ones, Remove orphans.
    //
    //    SCRUM-121/122 made no public ABI changes, so expect pure Replace.
    //    The Add/Remove logic is kept as a safety net.
    // -------------------------------------------------------------------------
    console.log("\n--- Step 4: Build diamond cut ---");

    const newSelectorSet = new Set(newSelectors.map(s => s.toLowerCase()));

    // Selectors currently belonging to the old SettlementFacet
    const oldSelectors = [];
    for (const [s, addr] of selectorToFacet) {
        if (addr === oldFacetAddress) oldSelectors.push(s);
    }

    const toReplace = [];
    const toAdd = [];
    const toRemove = [];

    for (const s of newSelectors) {
        if (selectorToFacet.has(s.toLowerCase())) {
            toReplace.push(s);
        } else {
            toAdd.push(s);
        }
    }
    for (const s of oldSelectors) {
        if (!newSelectorSet.has(s.toLowerCase())) {
            toRemove.push(s);
        }
    }

    const cut = [];
    if (toReplace.length) {
        cut.push({ facetAddress: newFacetAddress, action: FacetCutAction.Replace, functionSelectors: toReplace });
    }
    if (toAdd.length) {
        cut.push({ facetAddress: newFacetAddress, action: FacetCutAction.Add, functionSelectors: toAdd });
    }
    if (toRemove.length) {
        cut.push({ facetAddress: ethers.constants.AddressZero, action: FacetCutAction.Remove, functionSelectors: toRemove });
    }

    console.log("Replace:", toReplace.length, "selectors →", newFacetAddress);
    console.log("Add    :", toAdd.length,     "selectors →", newFacetAddress);
    console.log("Remove :", toRemove.length,  "selectors (orphaned from old facet)");

    if (cut.length === 0) {
        console.log("\nNothing to cut — diamond already up to date.");
        return;
    }

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
    for (const s of toRemove) {
        if (postMap.has(s.toLowerCase())) {
            console.error("FAIL selector", s, "→ expected removed but still present");
            allOk = false;
        }
    }

    if (!allOk) throw new Error("Verification failed — one or more selectors not routed correctly.");

    console.log("All SettlementFacet selectors route to:", expected);
    console.log("\n=== SCRUM-121/122 upgrade complete ===");
}

main()
    .then(() => process.exit(0))
    .catch(err => {
        console.error("SCRUM-121/122 upgrade failed:", err);
        process.exit(1);
    });
