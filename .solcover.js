// solidity-coverage configuration.
// configureYulOptimizer is required: the project compiles with viaIR, and the
// coverage instrumenter must run the Yul optimizer to avoid "stack too deep".
module.exports = {
  configureYulOptimizer: true,
  skipFiles: [
    // Test-only and audit-only contracts.
    "mock",
    "audit",
    // Diamond reference boilerplate (audit-exclusion-guidance.md).
    "Diamond.sol",
    "upgradeInitializers/DiamondInit.sol",
    "facets/DiamondCutFacet.sol",
    "facets/DiamondLoupeFacet.sol",
    "facets/OwnershipFacet.sol",
    "libraries/LibDiamond.sol",
    // CTF imported from Gnosis (audit-exclusion-guidance.md).
    "facets/ConditionalTokensFacet.sol",
    "facets/ConditionManagerFacet.sol",
    "libraries/LibConditionMetadata.sol",
    "libraries/LibCTHelpers.sol",
    "libraries/LibCTFCondition.sol",
    // Block-header v1, superseded (audit-exclusion-guidance.md).
    "facets/DoefinV1BlockHeaderOracleFacet.sol",
    "libraries/BlockHeaderUtils.sol",
    "libraries/LibDoefinBlockHeaderOracle.sol",
  ],
  istanbulReporter: ["html", "json-summary", "text"],
};
