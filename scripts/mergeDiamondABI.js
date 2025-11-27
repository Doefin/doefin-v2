// scripts/mergeDiamondABI.js
// Usage: node scripts/mergeDiamondABI.js
// This script merges the ABIs of all facets and the Diamond contract into one ABI for explorer UI upload.

const fs = require('fs');
const path = require('path');

// List all facet contract names and the Diamond contract
const contracts = [
  'Diamond',
  'DiamondLoupeFacet',
  'OwnershipFacet',
  'ERC1155Facet',
  'ERC1155ReceiverFacet',
  'ConditionalTokensFacet',
  'ConditionManagerFacet',
  'AccessControlFacet',
  'AdminConfigFacet',
  'ExchangeFacet',
  'MarketExecutionFacet',
  'RouteSimulationFacet',
  'MarketDataFacet',
];

const artifactsDir = path.join(__dirname, '../artifacts/contracts');
let mergedABI = [];
let seen = new Set();

for (const contract of contracts) {
  let artifactPath;
  if (contract === 'Diamond') {
    artifactPath = path.join(artifactsDir, 'Diamond.sol', 'Diamond.json');
  } else {
    artifactPath = path.join(artifactsDir, 'facets', `${contract}.sol`, `${contract}.json`);
  }
  if (!fs.existsSync(artifactPath)) {
    console.warn(`Artifact not found: ${artifactPath}`);
    continue;
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath));
  for (const item of artifact.abi) {
    const sig = item.type + ':' + (item.name || '');
    if (!seen.has(sig)) {
      mergedABI.push(item);
      seen.add(sig);
    }
  }
}

const outputPath = path.join(__dirname, '../mergedDiamondABI.json');
fs.writeFileSync(outputPath, JSON.stringify(mergedABI, null, 2));
console.log(`Merged ABI written to ${outputPath}`);
