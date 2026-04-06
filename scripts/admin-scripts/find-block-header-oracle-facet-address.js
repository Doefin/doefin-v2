#!/usr/bin/env node

const { ethers } = require("hardhat");
const hre = require("hardhat");
require("dotenv").config();

function getSelectors(contract) {
  return Object.keys(contract.interface.functions).map((signature) =>
    contract.interface.getSighash(signature)
  );
}

async function main() {
  const diamondAddress = process.env.DIAMOND_ADDRESS;
  if (!diamondAddress) {
    throw new Error(
      "Missing diamond address. Set DIAMOND_ADDRESS in .env"
    );
  }

  console.log("Network:", hre.network.name);
  console.log("Diamond:", diamondAddress);

  const diamondLoupe = await ethers.getContractAt("IDiamondLoupe", diamondAddress);
  const oracleInterface = await ethers.getContractAt("IDoefinBlockHeaderOracle", diamondAddress);

  const selectors = getSelectors(oracleInterface);
  console.log("Checking selectors from IDoefinBlockHeaderOracle:", selectors.length);

  const selectorMappings = [];
  const countByAddress = new Map();

  for (const selector of selectors) {
    const facetAddress = await diamondLoupe.facetAddress(selector);
    selectorMappings.push({ selector, facetAddress });

    if (facetAddress !== ethers.constants.AddressZero) {
      const key = facetAddress.toLowerCase();
      countByAddress.set(key, (countByAddress.get(key) || 0) + 1);
    }
  }

  if (countByAddress.size === 0) {
    throw new Error(
      "No selectors from IDoefinBlockHeaderOracle are registered in this diamond."
    );
  }

  const rankedAddresses = Array.from(countByAddress.entries()).sort((a, b) => b[1] - a[1]);
  const [bestAddressLower, matchedCount] = rankedAddresses[0];
  const bestAddress = selectorMappings.find(
    (entry) => entry.facetAddress.toLowerCase() === bestAddressLower
  ).facetAddress;

  const missingCount = selectorMappings.filter(
    (entry) => entry.facetAddress === ethers.constants.AddressZero
  ).length;

  const otherAddressCount = selectorMappings.filter(
    (entry) =>
      entry.facetAddress !== ethers.constants.AddressZero &&
      entry.facetAddress.toLowerCase() !== bestAddressLower
  ).length;

  console.log("\nDoefinV1BlockHeaderOracleFacet address:");
  console.log(bestAddress);
  console.log(`Matched selectors: ${matchedCount}/${selectors.length}`);

  if (missingCount > 0 || otherAddressCount > 0) {
    console.log("\nWarning: selector ownership is split or incomplete.");
    console.log("Missing selectors:", missingCount);
    console.log("Selectors on other facets:", otherAddressCount);
    console.log("\nAddress distribution:");

    for (const [addressLower, count] of rankedAddresses) {
      const normalized = selectorMappings.find(
        (entry) => entry.facetAddress.toLowerCase() === addressLower
      ).facetAddress;
      console.log(`- ${normalized}: ${count}`);
    }
  } else {
    console.log("All IDoefinBlockHeaderOracle selectors resolve to this address.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Failed to resolve DoefinV1BlockHeaderOracleFacet address:", error.message);
    process.exit(1);
  });