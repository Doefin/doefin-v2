#!/usr/bin/env node

const { ethers } = require("hardhat");
const hre = require("hardhat");
require("dotenv").config();

/**
 * SCRUM-89 — Diamond-cut upgrade for SettlementFacet.
 *
 * Replaces the SettlementFacet selectors with a new deployment that reads
 * complement/condition data from the CTF position registry
 * (AppStorage.positionRegistry) instead of the dead settlement-local mappings.
 * Also removes the now-deleted `registerPositionPair(bytes32,bytes32,bytes32,address)`
 * selector from the diamond.
 *
 * Storage layout: LibSettlementStorage keeps three reserved slots in place of
 * the removed mappings, so `domainSeparator` and `__gap` stay at their original
 * offsets. Any value cached via `cacheDomainSeparator()` on the live diamond is
 * preserved across the upgrade.
 *
 * Environment variables:
 *   DIAMOND_ADDRESS                      (required) target diamond proxy
 *   NEW_SETTLEMENT_FACET_ADDRESS         (optional) reuse an already-deployed new facet
 *   SKIP_VERIFICATION                    (optional) set truthy to skip loupe re-read
 */

// keccak256("registerPositionPair(bytes32,bytes32,bytes32,address)")[:4]
const REGISTER_POSITION_PAIR_SELECTOR = "0xebccdd14";
// keccak256("getOperator()")[:4] — stable zero-arg view used to locate the current SettlementFacet.
const GET_OPERATOR_SELECTOR = "0xe7f43c68";

async function main() {
    console.log("=== SCRUM-89 SettlementFacet diamond-cut upgrade ===");

    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS;
    if (!DIAMOND_ADDRESS) {
        throw new Error("DIAMOND_ADDRESS not set in environment variables");
    }

    const [deployer] = await ethers.getSigners();
    console.log("Deployer:", deployer.address);
    console.log("Diamond :", DIAMOND_ADDRESS);
    console.log("Network :", hre.network.name);

    const diamondCut = await ethers.getContractAt("IDiamondCut", DIAMOND_ADDRESS);
    const diamondLoupe = await ethers.getContractAt("IDiamondLoupe", DIAMOND_ADDRESS);
    const FacetCutAction = { Add: 0, Replace: 1, Remove: 2 };

    // -----------------------------------------------------------------------
    // 1. Deploy (or reuse) the new SettlementFacet
    // -----------------------------------------------------------------------
    console.log("\n=== Deploying new SettlementFacet ===");
    const SettlementFacet = await ethers.getContractFactory("SettlementFacet");
    let newFacetAddress = process.env.NEW_SETTLEMENT_FACET_ADDRESS;
    if (newFacetAddress) {
        console.log("Reusing existing SettlementFacet deployment at:", newFacetAddress);
    } else {
        const facet = await SettlementFacet.deploy();
        await facet.deployed();
        newFacetAddress = facet.address;
        console.log("New SettlementFacet deployed at:", newFacetAddress);
        console.log("   NEW_SETTLEMENT_FACET_ADDRESS=" + newFacetAddress);
    }

    // -----------------------------------------------------------------------
    // 2. Compute new selector set from the ABI
    // -----------------------------------------------------------------------
    const newSelectors = Object.values(SettlementFacet.interface.functions)
        .filter((f) => f.type === "function")
        .map((f) => SettlementFacet.interface.getSighash(f));

    console.log("\n=== SettlementFacet selector set (post-upgrade) ===");
    console.log("Total selectors:", newSelectors.length);
    newSelectors.forEach((s) => {
        const name = Object.values(SettlementFacet.interface.functions).find(
            (f) => SettlementFacet.interface.getSighash(f) === s
        ).name;
        console.log(`   ${s}  ${name}`);
    });

    if (newSelectors.includes(REGISTER_POSITION_PAIR_SELECTOR)) {
        throw new Error(
            "New SettlementFacet still exposes registerPositionPair selector — aborting. " +
                "Make sure the contracts were recompiled after the SCRUM-89 source changes."
        );
    }

    // -----------------------------------------------------------------------
    // 3. Inspect current diamond state
    // -----------------------------------------------------------------------
    console.log("\n=== Inspecting current diamond selectors ===");
    const currentFacets = await diamondLoupe.facets();
    // selector -> current facet address
    const selectorToFacet = new Map();
    for (const f of currentFacets) {
        for (const s of f.functionSelectors) {
            selectorToFacet.set(s.toLowerCase(), f.facetAddress.toLowerCase());
        }
    }

    const oldSettlementFacetAddress = selectorToFacet.get(GET_OPERATOR_SELECTOR);
    if (!oldSettlementFacetAddress) {
        throw new Error(
            `Could not locate current SettlementFacet on the diamond (getOperator selector ${GET_OPERATOR_SELECTOR} not found).`
        );
    }
    console.log("Current SettlementFacet :", oldSettlementFacetAddress);
    console.log("New SettlementFacet     :", newFacetAddress.toLowerCase());

    const registerPositionPairCurrentFacet = selectorToFacet.get(REGISTER_POSITION_PAIR_SELECTOR);
    if (registerPositionPairCurrentFacet) {
        console.log(
            `registerPositionPair is currently routed to ${registerPositionPairCurrentFacet} — will Remove.`
        );
    } else {
        console.log(
            "registerPositionPair selector not present on the diamond — Remove step will be skipped."
        );
    }

    // -----------------------------------------------------------------------
    // 4. Build the diamond cut
    //    Replace: every selector the new facet exposes AND that the diamond
    //             already has.
    //    Add    : new facet's selectors that the diamond does NOT have yet.
    //    Remove : registerPositionPair (if present).
    // -----------------------------------------------------------------------
    const toReplace = [];
    const toAdd = [];
    for (const s of newSelectors) {
        const key = s.toLowerCase();
        if (selectorToFacet.has(key)) {
            toReplace.push(s);
        } else {
            toAdd.push(s);
        }
    }

    const cut = [];
    if (toReplace.length) {
        cut.push({
            facetAddress: newFacetAddress,
            action: FacetCutAction.Replace,
            functionSelectors: toReplace,
        });
    }
    if (toAdd.length) {
        cut.push({
            facetAddress: newFacetAddress,
            action: FacetCutAction.Add,
            functionSelectors: toAdd,
        });
    }
    if (registerPositionPairCurrentFacet) {
        cut.push({
            facetAddress: ethers.constants.AddressZero,
            action: FacetCutAction.Remove,
            functionSelectors: [REGISTER_POSITION_PAIR_SELECTOR],
        });
    }

    console.log("\n=== Diamond cut payload ===");
    console.log(`Replace : ${toReplace.length} selectors -> ${newFacetAddress}`);
    console.log(`Add     : ${toAdd.length} selectors -> ${newFacetAddress}`);
    console.log(`Remove  : ${registerPositionPairCurrentFacet ? "1 selector (registerPositionPair)" : "0"}`);

    // -----------------------------------------------------------------------
    // 5. Estimate gas, then execute
    // -----------------------------------------------------------------------
    try {
        const gas = await diamondCut.estimateGas.diamondCut(
            cut,
            ethers.constants.AddressZero,
            "0x"
        );
        console.log("Gas estimate:", gas.toString());
    } catch (err) {
        console.warn("Gas estimation failed:", err.message);
    }

    console.log("\n=== Executing diamond cut ===");
    const tx = await diamondCut.diamondCut(cut, ethers.constants.AddressZero, "0x");
    console.log("Tx hash:", tx.hash);
    const receipt = await tx.wait();
    console.log("Confirmed in block:", receipt.blockNumber);
    console.log("Gas used:", receipt.gasUsed.toString());

    if (process.env.SKIP_VERIFICATION) {
        console.log("\nSkipping verification (SKIP_VERIFICATION set).");
        return;
    }

    // -----------------------------------------------------------------------
    // 6. Verify — every new selector points at the new facet, and the removed
    //    selector is gone.
    // -----------------------------------------------------------------------
    console.log("\n=== Verifying upgrade ===");
    await new Promise((r) => setTimeout(r, 2000));

    const postFacets = await diamondLoupe.facets();
    const postMap = new Map();
    for (const f of postFacets) {
        for (const s of f.functionSelectors) {
            postMap.set(s.toLowerCase(), f.facetAddress.toLowerCase());
        }
    }

    const expected = newFacetAddress.toLowerCase();
    for (const s of newSelectors) {
        const actual = postMap.get(s.toLowerCase());
        if (actual !== expected) {
            throw new Error(
                `Selector ${s} not routed to new facet (expected ${expected}, got ${actual ?? "<missing>"})`
            );
        }
    }
    if (postMap.has(REGISTER_POSITION_PAIR_SELECTOR)) {
        throw new Error(
            "registerPositionPair selector is still routed after upgrade — Remove step failed."
        );
    }

    console.log("All SettlementFacet selectors now route to:", expected);
    console.log("registerPositionPair selector is removed from the diamond.");
    console.log("\n=== SCRUM-89 upgrade complete ===");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("SCRUM-89 upgrade failed:", error);
        process.exit(1);
    });
