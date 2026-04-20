// scripts/mergeDiamondABI.js
// Usage: node scripts/mergeDiamondABI.js
//
// Merges the ABIs of the v3 Diamond + all active facets into a single ABI file
// that clients can use to call the Diamond proxy.
//
// Output:
//   mergedDiamondABI.json       — flat ABI array (drop-in for ethers/viem)
//   mergedDiamondABI.meta.json  — same ABI plus metadata (facet list, counts)

const fs = require('fs');
const path = require('path');

// v3 contracts — keep in sync with .claude/CLAUDE.md
// Each entry: [sourceFileBaseName, contractName]
// sourceFileBaseName is the .sol filename without extension; contractName is
// the contract declared inside (they differ for DoefinV1BlockHeaderOracleFacet).
const CONTRACTS = [
  // Diamond proxy
  ['Diamond', 'Diamond', 'contracts'],

  // Diamond standard
  ['DiamondCutFacet', 'DiamondCutFacet', 'facets'],
  ['DiamondLoupeFacet', 'DiamondLoupeFacet', 'facets'],
  ['OwnershipFacet', 'OwnershipFacet', 'facets'],

  // Admin / access
  ['AccessControlFacet', 'AccessControlFacet', 'facets'],
  ['AdminConfigFacet', 'AdminConfigFacet', 'facets'],

  // Settlement (v3)
  ['SettlementFacet', 'SettlementFacet', 'facets'],
  ['SignatureVerifierFacet', 'SignatureVerifierFacet', 'facets'],
  ['NonceManagerFacet', 'NonceManagerFacet', 'facets'],

  // CTF core
  ['ConditionalTokensFacet', 'ConditionalTokensFacet', 'facets'],
  ['ConditionManagerFacet', 'ConditionManagerFacet', 'facets'],
  ['ERC1155Facet', 'ERC1155Facet', 'facets'],
  ['ERC1155ReceiverFacet', 'ERC1155ReceiverFacet', 'facets'],

  // Oracle
  ['DoefinV1BlockHeaderOracleFacet', 'DoefinV1BlockHeaderOracle', 'facets'],
  ['OracleAdapterFacet', 'OracleAdapterFacet', 'facets'],
  ['OracleManagerFacet', 'OracleManagerFacet', 'facets'],
  ['BlockScholesOracleAdapter', 'BlockScholesOracleAdapter', 'facets'],

  // Read-only market data
  ['MarketDataFacet', 'MarketDataFacet', 'facets'],
];

const artifactsDir = path.join(__dirname, '../artifacts/contracts');

// Canonical signature used for deduplication. Uses full input types so
// overloaded functions (e.g. safeTransferFrom) are preserved distinctly.
function canonicalSignature(item) {
  const inputs = (item.inputs || []).map(i => flattenType(i)).join(',');
  if (item.type === 'function') return `function ${item.name}(${inputs})`;
  if (item.type === 'event') return `event ${item.name}(${inputs})`;
  if (item.type === 'error') return `error ${item.name}(${inputs})`;
  if (item.type === 'constructor') return `constructor(${inputs})`;
  if (item.type === 'fallback') return 'fallback';
  if (item.type === 'receive') return 'receive';
  return `${item.type}:${item.name || ''}`;
}

// Recursively flatten tuple types so (uint256,address) nested tuples produce
// a stable, selector-equivalent string.
function flattenType(input) {
  if (input.type.startsWith('tuple')) {
    const suffix = input.type.slice('tuple'.length); // handles tuple, tuple[], tuple[2]
    const inner = (input.components || []).map(c => flattenType(c)).join(',');
    return `(${inner})${suffix}`;
  }
  return input.type;
}

function loadArtifact(sourceFile, contractName, group) {
  const artifactPath =
    group === 'contracts'
      ? path.join(artifactsDir, `${sourceFile}.sol`, `${contractName}.json`)
      : path.join(artifactsDir, group, `${sourceFile}.sol`, `${contractName}.json`);
  if (!fs.existsSync(artifactPath)) return null;
  return JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
}

function main() {
  const mergedABI = [];
  const seen = new Map(); // signature -> source contract (first seen wins)
  const collisions = [];
  const missing = [];
  const perContract = [];

  for (const [sourceFile, contractName, group] of CONTRACTS) {
    const artifact = loadArtifact(sourceFile, contractName, group);
    if (!artifact) {
      missing.push(`${group}/${sourceFile}.sol:${contractName}`);
      continue;
    }

    let added = 0;
    let duplicates = 0;
    for (const item of artifact.abi) {
      // Diamond proxy has its own constructor + fallback — keep those from
      // Diamond only; skip constructors from facets (they aren't reachable
      // through the proxy anyway).
      if (item.type === 'constructor' && contractName !== 'Diamond') continue;
      if ((item.type === 'fallback' || item.type === 'receive') && contractName !== 'Diamond') continue;

      const sig = canonicalSignature(item);
      if (seen.has(sig)) {
        duplicates++;
        const existingSource = seen.get(sig);
        if (existingSource !== contractName) {
          collisions.push({ signature: sig, first: existingSource, duplicate: contractName });
        }
        continue;
      }
      seen.set(sig, contractName);
      mergedABI.push(item);
      added++;
    }
    perContract.push({ contract: contractName, added, duplicates });
  }

  // Sort: constructor, fallback, receive, function, event, error; then by name.
  const typeOrder = { constructor: 0, fallback: 1, receive: 2, function: 3, event: 4, error: 5 };
  mergedABI.sort((a, b) => {
    const ao = typeOrder[a.type] ?? 99;
    const bo = typeOrder[b.type] ?? 99;
    if (ao !== bo) return ao - bo;
    return (a.name || '').localeCompare(b.name || '');
  });

  const counts = mergedABI.reduce((acc, item) => {
    acc[item.type] = (acc[item.type] || 0) + 1;
    return acc;
  }, Object.create(null));

  const flatOut = path.join(__dirname, '../mergedDiamondABI.json');
  const metaOut = path.join(__dirname, '../mergedDiamondABI.meta.json');

  fs.writeFileSync(flatOut, JSON.stringify(mergedABI, null, 2));
  fs.writeFileSync(
    metaOut,
    JSON.stringify(
      {
        contractName: 'Diamond',
        description: 'Merged ABI for the Doefin v3 Diamond proxy (all active facets).',
        generatedAt: new Date().toISOString(),
        contracts: CONTRACTS.map(([, name]) => name),
        totalEntries: mergedABI.length,
        entriesByType: counts,
        perContract,
        abi: mergedABI,
      },
      null,
      2,
    ),
  );

  console.log(`Merged ABI   -> ${flatOut}`);
  console.log(`With metadata -> ${metaOut}`);
  console.log(`Entries: ${mergedABI.length}`, counts);

  if (missing.length) {
    console.warn('\nMissing artifacts (run `npx hardhat compile` first):');
    for (const m of missing) console.warn(`  - ${m}`);
  }
  if (collisions.length) {
    console.warn('\nSelector collisions across facets (first-seen kept):');
    for (const c of collisions) {
      console.warn(`  ${c.signature}  first: ${c.first}  dup: ${c.duplicate}`);
    }
  }
}

main();
