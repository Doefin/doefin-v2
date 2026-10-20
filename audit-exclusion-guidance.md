# Audit Exclusion Guidance

## Purpose
This note tells auditors which components to ignore when reviewing the core protocol. The items under **Components to Exclude** are excluded from the audit scope and should be omitted from code review, threat modeling, and test coverage expectations. Components under **Re-scoped IN** were excluded in an earlier revision and are now in scope.

## Re-scoped IN — NOT excluded (SCRUM-521, 2026-09-23; SCRUM-214, 2026-10-19)
- **Bitcoin block-header oracle** (formerly excluded as "Block Header v1 (superseded)"). It was never
  superseded: it is the live settlement-triggering oracle on Base mainnet (`.claude/CLAUDE.md` → Architecture →
  Oracle). The former exclusion hid SEC-015 (reorg-rewind underflow, production incident 2026-09-15). Review,
  threat-model and cover these files like any other in-scope contract; the SCSVS V10 lens applies. The
  tool-level exclusions that still skip them are tracked in `audit/follow-ups.md` SCRUM-521-AUDIT-SCOPE.
	- [contracts/facets/DoefinV1BlockHeaderOracleFacet.sol](contracts/facets/DoefinV1BlockHeaderOracleFacet.sol)
	- [contracts/libraries/BlockHeaderUtils.sol](contracts/libraries/BlockHeaderUtils.sol)
	- [contracts/libraries/LibDoefinBlockHeaderOracle.sol](contracts/libraries/LibDoefinBlockHeaderOracle.sol)
	- [contracts/interfaces/IDoefinBlockHeaderOracle.sol](contracts/interfaces/IDoefinBlockHeaderOracle.sol)

- **Conditional tokens (CTF)** (re-scoped IN by SCRUM-214, 2026-10-19; formerly excluded as "imported from
  Gnosis CTF"). It is not a plain import: the Doefin additions — the settlement-market registry, the internal
  split/merge used by Mint/Merge settlement, the resolution fee, condition cancellation and void — carried
  CTF-001 (Critical) .. CTF-008 (`audit/findings/ctf-review.md`). Review, threat-model and cover these files
  like any other in-scope contract.
	- [contracts/facets/ConditionalTokensFacet.sol](contracts/facets/ConditionalTokensFacet.sol)
	- [contracts/facets/ConditionManagerFacet.sol](contracts/facets/ConditionManagerFacet.sol)
	- [contracts/interfaces/IConditionalTokens.sol](contracts/interfaces/IConditionalTokens.sol)
	- [contracts/interfaces/IConditionManager.sol](contracts/interfaces/IConditionManager.sol)
	- [contracts/libraries/LibConditionMetadata.sol](contracts/libraries/LibConditionMetadata.sol)
	- [contracts/libraries/LibCTHelpers.sol](contracts/libraries/LibCTHelpers.sol)
	- [contracts/libraries/LibCTFCondition.sol](contracts/libraries/LibCTFCondition.sol)

## Components to Exclude (Audit Only)
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

- **Mocks (test-only — exclude the entire `contracts/mock/` folder; the 17 files below as of SCRUM-214, 2026-10-20)**
	- [contracts/mock/BadERC1155Receiver.sol](contracts/mock/BadERC1155Receiver.sol)
	- [contracts/mock/BlockHeaderUtilsHarness.sol](contracts/mock/BlockHeaderUtilsHarness.sol)
	- [contracts/mock/CTFInternalHarness.sol](contracts/mock/CTFInternalHarness.sol)
	- [contracts/mock/DoefinOrderHarness.sol](contracts/mock/DoefinOrderHarness.sol)
	- [contracts/mock/LegacyStateWriterFacet.sol](contracts/mock/LegacyStateWriterFacet.sol)
	- [contracts/mock/LibERC1155Harness.sol](contracts/mock/LibERC1155Harness.sol)
	- [contracts/mock/LibOracleAdapterHarness.sol](contracts/mock/LibOracleAdapterHarness.sol)
	- [contracts/mock/LibPositionRegistryHarness.sol](contracts/mock/LibPositionRegistryHarness.sol)
	- [contracts/mock/MaliciousReentrantERC20.sol](contracts/mock/MaliciousReentrantERC20.sol)
	- [contracts/mock/MaliciousReentrantOperator.sol](contracts/mock/MaliciousReentrantOperator.sol)
	- [contracts/mock/MockERC1155.sol](contracts/mock/MockERC1155.sol)
	- [contracts/mock/MockERC1271Wallet.sol](contracts/mock/MockERC1271Wallet.sol)
	- [contracts/mock/MockERC20.sol](contracts/mock/MockERC20.sol)
	- [contracts/mock/SelfCallerFacet.sol](contracts/mock/SelfCallerFacet.sol)
	- [contracts/mock/StorageLayoutProbe.sol](contracts/mock/StorageLayoutProbe.sol)
	- [contracts/mock/Test1Facet.sol](contracts/mock/Test1Facet.sol)
	- [contracts/mock/Test2Facet.sol](contracts/mock/Test2Facet.sol)

- **Audit harness (audit-only fuzzing harness; not a production contract)**
	- [contracts/audit/DoefinInvariantHarness.sol](contracts/audit/DoefinInvariantHarness.sol)

## Rationale
- ~~The CTF flow is third-party (Gnosis CTF) and excluded from audit to avoid re-reviewing upstream code; exclusion is audit-only and does not imply removal from deployment artifacts.~~
  **Withdrawn (SCRUM-214, 2026-10-19):** the CTF carries Doefin-specific logic that settlement trusts (CTF-001..008) and is no longer excluded — see "Re-scoped IN" above.
- ~~Block header v1 components are superseded by newer oracle integrations and should not be part of the current audit scope.~~
  **Withdrawn (SCRUM-521, 2026-09-23):** the block-header oracle is not superseded and is no longer excluded — see
  "Re-scoped IN" above.
- Diamond base components come from the diamond-hardhat reference and are treated as upstream; exclude from this audit to focus on custom logic.
- Mock contracts are test-only and not part of production deployments — the exclusion covers the entire `contracts/mock/` folder, so any mock added later is excluded by default even if not yet named above.
- `DoefinInvariantHarness.sol` exists only to drive Echidna/Medusa property fuzzing; it is never deployed and is excluded from review consistent with `audit/00-scope.md`.

## How to Apply the Exclusions
- Do not review or rate the excluded files for security findings.
- Skip deployment, initialization, or upgrade considerations for the excluded components.
- Ignore tests that target these components when evaluating coverage or risk.

## Notes
- If an excluded component is referenced in shared code, treat that reference as a candidate for removal or isolation, but do not expand the audit scope to cover the excluded code itself.
- ~~If the auditors notice additional CTF-specific helpers not named above, they should treat them as excluded unless clearly tied to in-scope production logic.~~ Withdrawn with the CTF re-scope (SCRUM-214).
