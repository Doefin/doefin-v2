# Audit Exclusion Guidance

## Purpose
This note tells auditors which components to ignore when reviewing the core protocol. The items below are excluded from the audit scope and should be omitted from code review, threat modeling, and test coverage expectations.

## Components to Exclude (Audit Only)
- **CTF (imported from Gnosis CTF)**
	- [contracts/facets/ConditionalTokensFacet.sol](contracts/facets/ConditionalTokensFacet.sol)
	- [contracts/facets/ConditionManagerFacet.sol](contracts/facets/ConditionManagerFacet.sol)
	- [contracts/interfaces/IConditionalTokens.sol](contracts/interfaces/IConditionalTokens.sol)
	- [contracts/interfaces/IConditionManager.sol](contracts/interfaces/IConditionManager.sol)
	- [contracts/libraries/LibConditionMetadata.sol](contracts/libraries/LibConditionMetadata.sol)
	- [contracts/libraries/LibCTHelpers.sol](contracts/libraries/LibCTHelpers.sol)
	- [contracts/libraries/LibCTFCondition.sol](contracts/libraries/LibCTFCondition.sol)

- **Block Header v1 (superseded)**
	- [contracts/facets/DoefinV1BlockHeaderOracleFacet.sol](contracts/facets/DoefinV1BlockHeaderOracleFacet.sol)
	- [contracts/libraries/BlockHeaderUtils.sol](contracts/libraries/BlockHeaderUtils.sol)
	- [contracts/libraries/LibDoefinBlockHeaderOracle.sol](contracts/libraries/LibDoefinBlockHeaderOracle.sol)
	- [contracts/interfaces/IDoefinBlockHeaderOracle.sol](contracts/interfaces/IDoefinBlockHeaderOracle.sol)

- **Diamond reference (from diamond-hardhat template)**
	- [contracts/Diamond.sol](contracts/Diamond.sol)
	- [contracts/libraries/LibDiamond.sol](contracts/libraries/LibDiamond.sol)
	- [contracts/upgradeInitializers/DiamondInit.sol](contracts/upgradeInitializers/DiamondInit.sol)
	- [contracts/facets/DiamondCutFacet.sol](contracts/facets/DiamondCutFacet.sol)
	- [contracts/facets/DiamondLoupeFacet.sol](contracts/facets/DiamondLoupeFacet.sol)
	- [contracts/facets/OwnershipFacet.sol](contracts/facets/OwnershipFacet.sol)
	- [contracts/interfaces/IDiamondCut.sol](contracts/interfaces/IDiamondCut.sol)
	- [contracts/interfaces/IDiamondLoupe.sol](contracts/interfaces/IDiamondLoupe.sol)
	- [contracts/interfaces/IERC173.sol](contracts/interfaces/IERC173.sol)

- **Mocks (test-only; exclude entire folder)**
	- [contracts/mock/MockBlockScholesOracle.sol](contracts/mock/MockBlockScholesOracle.sol)
	- [contracts/mock/MockOracleAdapter.sol](contracts/mock/MockOracleAdapter.sol)
	- [contracts/mock/MockOracleManager.sol](contracts/mock/MockOracleManager.sol)
	- [contracts/mock/MockERC20.sol](contracts/mock/MockERC20.sol)
	- [contracts/mock/MockERC1155.sol](contracts/mock/MockERC1155.sol)
	- [contracts/mock/Test1Facet.sol](contracts/mock/Test1Facet.sol)
	- [contracts/mock/Test2Facet.sol](contracts/mock/Test2Facet.sol)

## Rationale
- The CTF flow is third-party (Gnosis CTF) and excluded from audit to avoid re-reviewing upstream code; exclusion is audit-only and does not imply removal from deployment artifacts.
- Block header v1 components are superseded by newer oracle integrations and should not be part of the current audit scope.
- Diamond base components come from the diamond-hardhat reference and are treated as upstream; exclude from this audit to focus on custom logic.
- Mock contracts are test-only and not part of production deployments.

## How to Apply the Exclusions
- Do not review or rate the excluded files for security findings.
- Skip deployment, initialization, or upgrade considerations for the excluded components.
- Ignore tests that target these components when evaluating coverage or risk.

## Notes
- If an excluded component is referenced in shared code, treat that reference as a candidate for removal or isolation, but do not expand the audit scope to cover the excluded code itself.
- If the auditors notice additional CTF-specific helpers not named above, they should treat them as excluded unless clearly tied to in-scope production logic.
