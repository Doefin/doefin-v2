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
    "libraries/LibCTHelpers.sol",
    "libraries/LibCTFCondition.sol",
    // The block-header oracle (DoefinV1BlockHeaderOracleFacet, BlockHeaderUtils,
    // LibDoefinBlockHeaderOracle) and the Doefin question-creation code
    // (ConditionManagerFacet, LibConditionMetadata) are measured: the former
    // "superseded" exclusion hid SEC-015 (SCRUM-521-AUDIT-SCOPE).
  ],
  istanbulReporter: ["html", "json-summary", "text"],
};
