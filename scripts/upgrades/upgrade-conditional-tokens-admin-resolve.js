#!/usr/bin/env node

const { ethers } = require("hardhat");
const hre = require("hardhat");
require("dotenv").config();

function getSelectors(contractFactory) {
    return Object.values(contractFactory.interface.functions)
        .filter((func) => func.type === "function")
        .map((func) => contractFactory.interface.getSighash(func));
}

function buildSelectorMap(contractFactory) {
    const map = {};
    for (const signature of Object.keys(contractFactory.interface.functions)) {
        map[contractFactory.interface.getSighash(signature)] = signature;
    }
    return map;
}

async function main() {
    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS;
    if (!DIAMOND_ADDRESS) {
        throw new Error("DIAMOND_ADDRESS not set in environment variables");
    }

    const [deployer] = await ethers.getSigners();
    console.log("Starting ConditionalTokensFacet admin resolver upgrade...");
    console.log("Network:", hre.network.name);
    console.log("Deployer:", deployer.address);
    console.log("Diamond:", DIAMOND_ADDRESS);

    const diamondCut = await ethers.getContractAt("IDiamondCut", DIAMOND_ADDRESS);
    const diamondLoupe = await ethers.getContractAt("IDiamondLoupe", DIAMOND_ADDRESS);

    const ConditionalTokensFacet = await ethers.getContractFactory("ConditionalTokensFacet");

    let newFacetAddress = process.env.NEW_CONDITIONAL_TOKENS_FACET_ADDRESS;
    if (!newFacetAddress) {
        const newFacet = await ConditionalTokensFacet.deploy();
        await newFacet.deployed();
        newFacetAddress = newFacet.address;
        console.log("Deployed new ConditionalTokensFacet:", newFacetAddress);
        console.log("Tip: set NEW_CONDITIONAL_TOKENS_FACET_ADDRESS=", newFacetAddress, "to reuse this deployment");
    } else {
        console.log("Using existing ConditionalTokensFacet:", newFacetAddress);
    }

    const facetCode = await ethers.provider.getCode(newFacetAddress);
    if (facetCode === "0x") {
        throw new Error(`Facet address has no deployed code on ${hre.network.name}: ${newFacetAddress}`);
    }

    const selectors = getSelectors(ConditionalTokensFacet);
    const selectorMap = buildSelectorMap(ConditionalTokensFacet);
    console.log("Target selectors:", selectors.length);

    const addSelectors = [];
    const replaceSelectors = [];
    const unchangedSelectors = [];

    for (const selector of selectors) {
        const currentFacetAddress = await diamondLoupe.facetAddress(selector);

        if (currentFacetAddress === ethers.constants.AddressZero) {
            addSelectors.push(selector);
            continue;
        }

        if (currentFacetAddress.toLowerCase() === newFacetAddress.toLowerCase()) {
            unchangedSelectors.push(selector);
            continue;
        }

        replaceSelectors.push(selector);
    }

    console.log("Selector plan:", {
        add: addSelectors.length,
        replace: replaceSelectors.length,
        unchanged: unchangedSelectors.length,
    });

    if (addSelectors.length > 0) {
        console.log("Add selectors:", addSelectors.map((selector) => `${selector} ${selectorMap[selector]}`));
    }

    if (replaceSelectors.length > 0) {
        console.log("Replace selectors:", replaceSelectors.map((selector) => `${selector} ${selectorMap[selector]}`));
    }

    const FacetCutAction = { Add: 0, Replace: 1, Remove: 2 };
    const cut = [];

    if (addSelectors.length > 0) {
        cut.push({
            facetAddress: newFacetAddress,
            action: FacetCutAction.Add,
            functionSelectors: addSelectors,
        });
    }

    if (replaceSelectors.length > 0) {
        cut.push({
            facetAddress: newFacetAddress,
            action: FacetCutAction.Replace,
            functionSelectors: replaceSelectors,
        });
    }

    if (cut.length === 0) {
        console.log("No selector updates required. Exiting.");
        return;
    }

    try {
        const gasEstimate = await diamondCut.estimateGas.diamondCut(cut, ethers.constants.AddressZero, "0x");
        console.log("Estimated gas:", gasEstimate.toString());
    } catch (error) {
        console.log("Gas estimate failed (continuing):", error.message);
    }

    const tx = await diamondCut.diamondCut(cut, ethers.constants.AddressZero, "0x");
    console.log("Upgrade tx:", tx.hash);
    const receipt = await tx.wait();
    console.log("Confirmed in block:", receipt.blockNumber);
    console.log("Gas used:", receipt.gasUsed.toString());

    const adminSelector = ConditionalTokensFacet.interface.getSighash("adminResolveCondition(bytes32,uint256[])");
    const resolvedFacetAddress = await diamondLoupe.facetAddress(adminSelector);

    console.log("adminResolveCondition selector:", adminSelector);
    console.log("selector facet address:", resolvedFacetAddress);

    if (resolvedFacetAddress.toLowerCase() !== newFacetAddress.toLowerCase()) {
        throw new Error("Upgrade verification failed: selector does not point to the new facet");
    }

    console.log("Upgrade successful: adminResolveCondition is now active.");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("Upgrade failed:", error);
        process.exit(1);
    });
