#!/usr/bin/env node

/**
 * Upgrade script for LibCTFCondition._splitPosition change
 *
 * Affected facets (proven via call chain analysis):
 *
 * 1. ConditionalTokensFacet
 *    DIRECT: splitPosition() → LibCTFCondition._splitPosition()
 *
 * 2. MarketExecutionFacet
 *    INDIRECT: fillOrders()
 *              → LibSettlement.fillOrders()
 *              → LibSettlement._executeMatches()
 *              → LibTradeSettlement.settlementDispatcher()
 *              → LibTradeSettlement._handleMintMatch()
 *              → LibTradeSettlement._executeSplitOperation()
 *              → LibCTFCondition._splitPosition()
 *
 * 3. OrderCreationFacet
 *    INDIRECT: createOrder()
 *              → LibOrderbook.createOrder()
 *              → LibSettlement.fillOrders()       ← same chain as above
 *              → LibTradeSettlement._executeSplitOperation()
 *              → LibCTFCondition._splitPosition()
 *
 * NOT affected (verified):
 *   - ConditionManagerFacet: only calls LibCTFCondition.prepareCondition(), never _splitPosition()
 *   - OracleAdapterFacet: no path to _splitPosition() at all
 */

const { ethers } = require("hardhat");
const hre = require("hardhat");
require("dotenv").config();

// ─── Selector helpers ──────────────────────────────────────────────────────────

/**
 * Derive all function selectors from a ContractFactory's ABI.
 * Mirrors the getSelectors() helper in scripts/libraries/diamond.js.
 */
function getSelectors(contractFactory) {
    return Object.values(contractFactory.interface.functions)
        .filter(f => f.type === "function")
        .map(f => contractFactory.interface.getSighash(f));
}

/**
 * Compute a single 4-byte selector from a plain function signature string.
 * Example: sig4("fillOrders(uint256,uint256[])")
 */
function sig4(signature) {
    return ethers.utils.id(signature).substring(0, 10);
}

// ─── Known anchor selectors for facet discovery via DiamondLoupe ──────────────
//
// One reliable selector per facet is enough to locate its current address on-chain.
// These are stable signatures that won't change between upgrades.

const ANCHOR_SELECTORS = {
    // // ConditionalTokensFacet — splitPosition is the function we changed
    // conditionalTokens: sig4("splitPosition(address,bytes32,bytes32,uint256[],uint256)"),

    // // MarketExecutionFacet — its only public entry point
    // marketExecution: sig4("fillOrders(uint256,uint256[])"),

    // OrderCreationFacet — its only public entry point
    // Full sig with tuple for CrossCurrencyData struct (Solidity ABI-encodes structs as tuples)
    orderCreation: sig4("createOrder(uint256,address,uint256,uint256,uint256,uint32,bool,uint8,uint8,(address,uint256))"),
};

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log("=".repeat(60));
    console.log("  LibCTFCondition._splitPosition — Facet Upgrade Script");
    console.log("=".repeat(60));

    // ── Config ────────────────────────────────────────────────────────────────
    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS;
    if (!DIAMOND_ADDRESS) throw new Error("DIAMOND_ADDRESS not set in .env");

    const [deployer] = await ethers.getSigners();
    console.log("\nDeployer :", deployer.address);
    console.log("Diamond  :", DIAMOND_ADDRESS);
    console.log("Network  :", hre.network.name);

    // ── Interfaces ────────────────────────────────────────────────────────────
    const diamondCut   = await ethers.getContractAt("IDiamondCut",   DIAMOND_ADDRESS);
    const diamondLoupe = await ethers.getContractAt("IDiamondLoupe", DIAMOND_ADDRESS);

    // ── Step 1: Deploy new facets (or reuse if already deployed this session) ─

    console.log("\n--- Step 1: Deploy new facets ---\n");

    const conditionalTokensFacet = await deployOrReuse(
        "ConditionalTokensFacet",
        process.env.NEW_CONDITIONAL_TOKENS_FACET_ADDRESS
    );

    const marketExecutionFacet = await deployOrReuse(
        "MarketExecutionFacet",
        process.env.NEW_MARKET_EXECUTION_FACET_ADDRESS
    );

    const orderCreationFacet = await deployOrReuse(
        "OrderCreationFacet",
        process.env.NEW_ORDER_CREATION_FACET_ADDRESS
    );

    // ── Step 2: Locate current facet addresses on-chain via DiamondLoupe ──────

    console.log("\n--- Step 2: Locate current facets on-chain ---\n");

    const currentAddresses = await locateCurrentFacets(diamondLoupe);

    console.log("Current ConditionalTokensFacet :", currentAddresses.conditionalTokens);
    console.log("Current MarketExecutionFacet   :", currentAddresses.marketExecution);
    console.log("Current OrderCreationFacet     :", currentAddresses.orderCreation);

    // Sanity check — warn if any not found, but proceed with found ones
    const foundFacets = Object.entries(currentAddresses).filter(([name, addr]) => addr);
    const missingFacets = Object.entries(currentAddresses).filter(([name, addr]) => !addr);
    
    if (missingFacets.length > 0) {
        console.log("Warning: The following facets were not found on-chain and will be skipped:");
        missingFacets.forEach(([name]) => console.log(`  - ${name}`));
    }
    
    if (foundFacets.length === 0) {
        throw new Error("No facets found on-chain. Check DIAMOND_ADDRESS and network.");
    }

    // ── Step 3: Build selectors for the new facets ────────────────────────────

    console.log("\n--- Step 3: Compute new selectors ---\n");

    const ConditionalTokensFactory = await ethers.getContractFactory("ConditionalTokensFacet");
    const MarketExecutionFactory    = await ethers.getContractFactory("MarketExecutionFacet");
    const OrderCreationFactory      = await ethers.getContractFactory("OrderCreationFacet");

    const newConditionalTokensSelectors = getSelectors(ConditionalTokensFactory);
    const newMarketExecutionSelectors   = getSelectors(MarketExecutionFactory);
    const newOrderCreationSelectors     = getSelectors(OrderCreationFactory);

    console.log(`ConditionalTokensFacet : ${newConditionalTokensSelectors.length} selectors`);
    console.log(`MarketExecutionFacet   : ${newMarketExecutionSelectors.length} selectors`);
    console.log(`OrderCreationFacet     : ${newOrderCreationSelectors.length} selectors`);

    // ── Step 4: Build the diamond cut ─────────────────────────────────────────

    console.log("\n--- Step 4: Prepare diamond cut ---\n");

    const FacetCutAction = { Add: 0, Replace: 1, Remove: 2 };

    const facetConfigs = [
        {
            name: "ConditionalTokensFacet",
            factory: ConditionalTokensFactory,
            deployed: conditionalTokensFacet,
            currentAddr: currentAddresses.conditionalTokens,
        },
        {
            name: "MarketExecutionFacet",
            factory: MarketExecutionFactory,
            deployed: marketExecutionFacet,
            currentAddr: currentAddresses.marketExecution,
        },
        {
            name: "OrderCreationFacet",
            factory: OrderCreationFactory,
            deployed: orderCreationFacet,
            currentAddr: currentAddresses.orderCreation,
        },
    ];

    const cut = facetConfigs
        .filter(config => config.currentAddr || true) // include all, since we have deployments
        .map(config => ({
            facetAddress: config.deployed.address,
            action: config.currentAddr ? FacetCutAction.Replace : FacetCutAction.Add,
            functionSelectors: getSelectors(config.factory),
        }));

    console.log("Cut summary:");
    facetConfigs.forEach(config => {
        const action = config.currentAddr ? "REPLACE" : "ADD";
        console.log(`  ${action} ${config.name}`);
        if (config.currentAddr) {
            console.log(`    old: ${config.currentAddr}`);
        }
        console.log(`    new: ${config.deployed.address}`);
    });

    // ── Step 5: Gas estimate ───────────────────────────────────────────────────

    console.log("\n--- Step 5: Gas estimate ---\n");
    try {
        const gas = await diamondCut.estimateGas.diamondCut(
            cut,
            ethers.constants.AddressZero,
            "0x"
        );
        console.log("Estimated gas:", gas.toString());
    } catch (err) {
        // Non-fatal — estimation can fail on some networks, execution may still succeed
        console.warn("Gas estimation failed (non-fatal):", err.message);
    }

    // ── Step 6: Execute ────────────────────────────────────────────────────────

    console.log("\n--- Step 6: Execute diamond cut ---\n");

    const tx = await diamondCut.diamondCut(
        cut,
        ethers.constants.AddressZero,
        "0x"
    );
    console.log("Tx hash:", tx.hash);

    const receipt = await tx.wait();
    console.log("Confirmed in block:", receipt.blockNumber);
    console.log("Gas used:", receipt.gasUsed.toString());

    // ── Step 7: Verify ─────────────────────────────────────────────────────────

    console.log("\n--- Step 7: Verify upgrade ---\n");

    const verifyChecks = {};
    facetConfigs.forEach(config => {
        const anchorKey = Object.keys(ANCHOR_SELECTORS).find(key => 
            key.toLowerCase().includes(config.name.toLowerCase().replace('facet', ''))
        );
        verifyChecks[config.name] = {
            selector: ANCHOR_SELECTORS[anchorKey],
            expectedAddress: config.deployed.address,
        };
    });

    await verify(diamondLoupe, verifyChecks);

    // ── Done ───────────────────────────────────────────────────────────────────

    console.log("\n" + "=".repeat(60));
    console.log("  Upgrade complete ✅");
    console.log("=".repeat(60));
    console.log("\nSummary of changes applied:");
    facetConfigs.forEach(config => {
        const action = config.currentAddr ? "updated" : "added";
        const reason = config.name === "ConditionalTokensFacet" 
            ? "direct _splitPosition caller"
            : "indirect via LibTradeSettlement._executeSplitOperation()";
        console.log(`  ${config.name} — ${reason} ${action}`);
    });
    console.log("\n💡 Reuse these deployments on retry by adding to your .env:");
    facetConfigs.forEach(config => {
        const envKey = `NEW_${config.name.toUpperCase().replace('FACET', '')}_FACET_ADDRESS`;
        console.log(`  ${envKey}=${config.deployed.address}`);
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Deploy a new facet, or attach to an already-deployed address when the env var
 * is set. This lets you safely re-run the script after a partial failure without
 * paying deploy gas again.
 */
async function deployOrReuse(contractName, existingAddress) {
    if (existingAddress) {
        console.log(`${contractName}: reusing existing deployment at ${existingAddress}`);
        return { address: existingAddress };
    }

    const Factory = await ethers.getContractFactory(contractName);
    const instance = await Factory.deploy();
    await instance.deployed();
    console.log(`${contractName}: deployed at ${instance.address}`);
    return instance;
}

/**
 * Use DiamondLoupe.facetAddress() to find where each anchor selector currently
 * points. This is the safest and most precise way to locate facets on-chain
 * without relying on off-chain bookkeeping.
 */
async function locateCurrentFacets(diamondLoupe) {
    const conditionalTokens = await diamondLoupe.facetAddress(ANCHOR_SELECTORS.conditionalTokens);
    const marketExecution   = await diamondLoupe.facetAddress(ANCHOR_SELECTORS.marketExecution);
    const orderCreation     = await diamondLoupe.facetAddress(ANCHOR_SELECTORS.orderCreation);

    return {
        conditionalTokens: conditionalTokens !== ethers.constants.AddressZero ? conditionalTokens : null,
        marketExecution:   marketExecution   !== ethers.constants.AddressZero ? marketExecution   : null,
        orderCreation:     orderCreation     !== ethers.constants.AddressZero ? orderCreation     : null,
    };
}

/**
 * For each facet in the checks map, ask DiamondLoupe where the anchor selector
 * now points and compare to the expected new address.
 */
async function verify(diamondLoupe, checks) {
    let allPassed = true;

    for (const [name, { selector, expectedAddress }] of Object.entries(checks)) {
        const actualAddress = await diamondLoupe.facetAddress(selector);
        const passed = actualAddress.toLowerCase() === expectedAddress.toLowerCase();
        const icon   = passed ? "✅" : "❌";

        console.log(`${icon} ${name}`);
        console.log(`   expected : ${expectedAddress}`);
        console.log(`   actual   : ${actualAddress}`);

        if (!passed) allPassed = false;
    }

    if (!allPassed) {
        throw new Error("Verification failed — one or more facets did not update correctly.");
    }

    console.log("\nAll facets verified successfully.");
}

// ─── Entry point ──────────────────────────────────────────────────────────────

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error("\nUpgrade failed:", err);
        process.exit(1);
    });