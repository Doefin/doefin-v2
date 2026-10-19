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
    // The block-header oracle, the question-creation code and the CTF
    // (ConditionalTokensFacet, LibCTFCondition, LibCTHelpers) are measured: the
    // former "superseded" / "imported from Gnosis" exclusions hid SEC-015,
    // ORC-001 and CTF-001 (SCRUM-214).
  ],
  istanbulReporter: ["html", "json-summary", "text"],
};
