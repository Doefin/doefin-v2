# Doefin v3 — Dead-Code Findings

**Scope:** all v3 contracts kept on `v3/dev` — settlement, CTF, oracle, block-header,
infrastructure facets and their libraries. Mocks (`contracts/mock/`) and the
invariant harness (`contracts/audit/`) are excluded as test scaffolding (they are
not deployment-time roots, but their call sites are still counted to distinguish
"test-only" library functions from genuinely-dead ones).

**Status:** detection complete. No contract removals in this pass — the report and
the reusable tooling land here; deletion is a separate follow-up.

## Why a new pass at all

The previous audit passes mark the v3 libraries as clean. They are not. Two
detection methods produced false negatives:

| Method | Verdict on Doefin v3 | What it actually does |
|---|---|---|
| Reference-counting grep ("function name → ≥1 hit → alive") | "Zero dead functions" | Can't distinguish a *definition* line from a *call* line, and can't see a function whose only caller is itself dead. |
| Slither `dead-code` / `unused-state` / `unused-return` detectors | **0 results** (see `audit/output/deadcode/slither-deadcode.txt`) | Treats every `external`/`public` function as a live root. Library functions reachable only through an *orphaned* facet entry point stay marked "used". |

Both produced "clean." The reachability analysis introduced here found **15
verified-dead internal/library functions**, **2 orphan external selectors**, and
**32 test-only external selectors** — with the position-registry cluster the
user originally flagged showing up as the headline transitively-orphaned case.

The structural takeaway is in [audit/output/deadcode/slither-deadcode.txt](../output/deadcode/slither-deadcode.txt):
`94 contracts with 3 detectors, 0 result(s) found`. Slither's `dead-code`
detector is not a dead-code gate for a Diamond — Layer 2 reachability is.

## Method — a 4-layer pipeline

Each layer detects a category the previous one cannot.

1. **Slither `dead-code`, unfiltered** (Layer 1) — catches `internal`/`private`
   functions never called *and never reachable* from a public entry point.
   Config: [security/slither-deadcode.config.json](../../security/slither-deadcode.config.json)
   (the standard `security/slither.config.json` `filter_paths` hides
   `BlockHeaderUtils`, `LibCTFCondition`, `LibCTHelpers`, `LibConditionMetadata`
   and the CTF/oracle facets — half the libraries were never analysed).
2. **Call-graph reachability from the deployed selector set** (Layer 2, the
   rigorous core) — builds the call graph with the Slither Python API, seeds
   it with the `external`/`public` functions of every facet in
   `scripts/deploy.js` `FacetNames` + `DiamondCutFacet` + `DiamondInit`,
   computes the transitive closure, reports everything outside it. This is
   the layer that catches what grep and Slither's detector miss.
   Script: [security/scripts/deadcode-reachability.py](../../security/scripts/deadcode-reachability.py).
3. **Cross-repo selector usage matrix** (Layer 3) — for every registered
   selector, counts callsites across backend (`doefin-backend`), frontend
   (`doefin-frontend`), this repo's ops scripts, and this repo's tests; then
   classifies each as `keep (standard)` / `keep (backend)` / `keep (frontend)`
   / `keep (ops-script)` / `keep (end-user-direct)` / `test-only` /
   `ORPHAN`. Script: [audit/scripts/usage-matrix.js](../scripts/usage-matrix.js).
4. **Coverage corroboration** (Layer 4) — `npx hardhat coverage`; 0%-line
   functions cross-referenced against Layers 1–3. Used as a tie-breaker, not
   a verdict — high coverage on a library function combined with Layer-2
   "unreached" is exactly the "test-only library function" signature
   (verified live for `LibDoefinOrder.hash` etc. below).

Roots, run once:

```
[reachability] live roots            : 98
[reachability] functions in universe : 352
[reachability] reachable             : 234
[reachability] UNREACHABLE (dead)    : 15
[reachability] unresolved dyn. calls : 0      ← no function-pointer edges to worry about
[reachability] soundness check       : PASS for registerPositionPairs, validatePositionId
```

## Category A — verified dead internal/library functions (15)

These have **zero call sites anywhere in `contracts/`** (mocks and the audit
harness, when they reference one, are noted explicitly). Each was confirmed by
manual `grep` after the reachability flagged it.

| # | File:Line | Function | Why it is dead | Recommendation |
|---|---|---|---|---|
| A-1 | [contracts/libraries/LibCTFCondition.sol:203](../../contracts/libraries/LibCTFCondition.sol#L203) | `_validateCollateral(address,uint256)` | No caller in `contracts/`. Likely a CTF refactor leftover — collateral validation is now done elsewhere (the splitPosition/mergePositions paths don't invoke it). | Delete. |
| A-2 | [contracts/libraries/LibCTFCondition.sol:294](../../contracts/libraries/LibCTFCondition.sol#L294) | `enforceConditionIsActive(bytes32)` | No caller in `contracts/`. The "is condition active" check no longer happens during settlement. | Delete (or wire it in — verify with `sc-manual-reviewer` whether that check is a missing invariant). |
| A-3..6 | [contracts/libraries/LibConditionMetadata.sol:36,44,52,61](../../contracts/libraries/LibConditionMetadata.sol#L36) | `encodeDifficultyThreshold`, `encodeDifficultyRange`, `encodeBlockCount`, `encodeMiningDuration` | The encode side of the metadata codec is unused — only `decode*` and `validate*` are reached. | Delete the 4 encoders, keep the decoders. |
| A-7..11 | [contracts/libraries/LibDoefinBlockHeaderOracle.sol:34,46,63,82,94](../../contracts/libraries/LibDoefinBlockHeaderOracle.sol#L34) | `getNextBlockIndex`, `getBlockHeaderAt`, `getBlockHeaderByNumber`, `getLatestBlockHeader`, `getAllBlockHeaders` | **Pure dead duplication.** Every one of these is reimplemented inline inside `DoefinV1BlockHeaderOracleFacet` (see [DoefinV1BlockHeaderOracleFacet.sol:155](../../contracts/facets/DoefinV1BlockHeaderOracleFacet.sol#L155), [:253](../../contracts/facets/DoefinV1BlockHeaderOracleFacet.sol#L253), [:260](../../contracts/facets/DoefinV1BlockHeaderOracleFacet.sol#L260), [:270](../../contracts/facets/DoefinV1BlockHeaderOracleFacet.sol#L270), [:289](../../contracts/facets/DoefinV1BlockHeaderOracleFacet.sol#L289)) reading storage directly instead of calling the library. | Pick one source of truth. Recommendation: route the facet through the library (the library is reusable, the inline copies are not). Delete the library functions only if the facet inlines stay. |
| A-12 | [contracts/libraries/LibDoefinOrder.sol:78](../../contracts/libraries/LibDoefinOrder.sol#L78) | `hash(DoefinOrder memory)` | **Test-scaffolding-only.** Called only by `contracts/mock/DoefinOrderHarness.sol:20` and `contracts/audit/DoefinInvariantHarness.sol`. Production facets use `hashOrderCalldata` exclusively. | Migrate the harness to `hashOrderCalldata`, then delete. Or keep as `internal pure` test affordance — but document it. |
| A-13 | [contracts/libraries/LibDoefinOrder.sol:102](../../contracts/libraries/LibDoefinOrder.sol#L102) | `domainSeparator(string,string,uint256,address)` | Same — only used by `DoefinOrderHarness:29` and `DoefinInvariantHarness:553,566`. Production uses `diamondDomainSeparator`. | Same as A-12. |
| A-14 | [contracts/libraries/LibDoefinOrder.sol:143](../../contracts/libraries/LibDoefinOrder.sol#L143) | `hashOrder(DoefinOrder memory,bytes32)` | Same — only `DoefinOrderHarness:36`, `DoefinInvariantHarness:559,572`. Production uses `hashOrderCalldata`. | Same as A-12. |
| A-15 | [contracts/libraries/LibPositionRegistry.sol:73](../../contracts/libraries/LibPositionRegistry.sol#L73) | `getConditionId(uint256)` | This is the position-registry case the user flagged. `MarketDataFacet.getConditionId` looks like it delegates (per its NatSpec) but actually [reads storage directly](../../contracts/facets/MarketDataFacet.sol#L203) — `ds.positionRegistry.conditionIdByPositionId[positionId]`. Naive grep counted the facet's `function getConditionId(...) {` definition line as a "call" of the library version; it isn't. | Delete the library version — the facet's direct read is sound. (Or keep it and route the facet through it, mirroring the `getComplement` pattern at [MarketDataFacet.sol:223](../../contracts/facets/MarketDataFacet.sol#L223).) |

**A-12/13/14 are the textbook "high coverage, still dead" case.** `LibDoefinOrder.sol`
hits 100% function coverage in Layer 4 — Istanbul records the harness exercising
it — yet the production reachability closure excludes all three. Coverage alone
would have signed off; reachability is what surfaces them.

## Category B — orphan external selectors (2)

Reachable on-chain (the selectors are registered by `scripts/deploy.js`) but
**zero callers anywhere** — backend, frontend, ops scripts, tests all show 0.
Source: [audit/output/deadcode/usage-matrix.md](../output/deadcode/usage-matrix.md).

| Selector | Facet | backend | frontend | scripts | tests | Recommendation |
|---|---|---:|---:|---:|---:|---|
| `getAllPositionIdsByCondition(bytes32)` | `MarketDataFacet` | 0 | 0 | 0 | 0 | **Remove.** Zero callers, no tests, no spec hook. Likely a vestigial alias from when the registry exposed both per-market and aggregated reads. |
| `getPositionIdsByMarket(bytes32,bytes32,address)` | `MarketDataFacet` | 0 | 0 | 0 | 0 | **Remove** or write a test — the only reason to keep it is if it is part of the documented external SDK surface (no evidence it is). |

## Category C — transitively orphaned library clusters

Library functions that the call graph marks reachable but whose only path back
to a root runs through Category B or `test-only` externals. They are alive in
the closure but dead from any current integration's perspective. Disposition
must come *after* the team decides each cluster's parent facet's fate.

### C-1 · `LibPositionRegistry` read-side (the original concern)

The user's instinct was correct — the registry's read-side is partially orphaned:

| Library function | Reached only via | Layer-3 disposition of that selector |
|---|---|---|
| `getComplement(uint256)` | `MarketDataFacet.getComplement` | `test-only` (0/0/0/20) |
| `getCollateralToken(uint256)` | `MarketDataFacet.getCollateralToken`, `getCollateralUnit` | `getCollateralToken` test-only; `getCollateralUnit` backend-used → **alive** |
| `getMarketMetadata(uint256)` | `MarketDataFacet.getMarketMetadata`, `getPositionInfo`, `getMarketMetadataByMarket` | all three `test-only` |
| `getMarketsForCondition(bytes32)` | `MarketDataFacet.getMarketsByCondition`, `getAllPositionIdsByCondition` | both unused (one test-only, one **orphan** — see B) |
| `buildMarketKey(...)` | internal helper of the above | rides their fate |
| `validatePositionId(uint256)` | `LibCTFCondition.splitPosition` / `mergePositions` path **and** `MarketDataFacet` getters | **alive** via end-user-direct splits/merges |
| `registerPositionPairs(...)` | `LibCTFCondition._splitPosition` | **alive** |

So the registry has two genuinely-live functions (`registerPositionPairs`,
`validatePositionId`) and one half-live one (`getCollateralToken`, used by
`getCollateralUnit` which the backend calls). The remaining five reads exist
only to back `MarketDataFacet` view getters that no integration uses. If the
team decides `MarketDataFacet`'s view layer is intended public-API surface
(for explorers / future frontend use), keep them; otherwise this whole cluster
collapses to ~3 functions.

### C-2 · `LibOracleAdapter` bucket helpers

`getTimestampBucket` is reached only by `OracleAdapterFacet.getTimestampBucket`
which is `test-only`. The private bucket-index resolvers (`_findBucketIndex`,
`_updateAuxiliaryMappings`, `_findBlockByTimestamp`) are reached from
`settleCondition` (live). Decision: keep the private helpers, decide
`getTimestampBucket` based on whether the bucket index is part of the public
oracle SDK surface.

## Category B (extended) — test-only external selectors (32)

Pre-triaged disposition. Full matrix at
[audit/output/deadcode/usage-matrix.md](../output/deadcode/usage-matrix.md).

**Keep — public read API (likely explorer / wallet / future-integration surface):**
`isOrderValid`, `verifyOrderSignature`, `getMaxFeeRate`, `getTokenSymbol`,
`getComplement`, `getCollateralToken`, `getMarketMetadata`,
`getMarketMetadataByMarket`, `getMarketsByCondition`, `getPositionInfo`,
`medianBlockTime`, `getMedianBufferSize`, `getNextBlockIndex`,
`getBlockHeaderAt`, `getAllBlockHeaders`, `getBlockTimestamp`,
`getTimestampBlock`, `getTimestampBucket`, `getThresholdQuestionsAtBlock`,
`getRangeQuestionsAtBlock`, `getDurationQuestionsAtBlock`,
`getBlockCountQuestionsAtTimestamp`, `getTotalQuestionsCreated`,
`getTotalQuestionsResolved`.

**Keep — admin (operator/governance):**
`removeCollateralToken`, `removeMarketMaker`, `setMaxFeeRate`,
`setResolutionFeeBps`, `setTokenSymbol`.

**Flag — needs product confirmation before keeping or removing:**

- `submitNextBlock(...)`, `submitBatchBlocks(...)` — Bitcoin block-header
  ingestion. Zero callers in either repo and no ops script invokes them.
  Who feeds the oracle in production? If a keeper does (likely, off-repo),
  keep + document. Caveat: the matrix regex requires `name(` so an ABI-only
  reference would be missed; double-check the backend before acting.
- `fillOrder(...)` — the single-side operator settlement path. Backend's
  `settlement_service.py` uses `matchOrders` only. Is `fillOrder` planned
  (e.g. for partial fills outside the match loop), or is it superseded?

## Comparison of detection methods on this codebase

| Method | Findings produced | False negatives proven by this pass |
|---|---:|---|
| Reference-counting grep (the first naive sweep) | 0 dead | All 15 Category A items — and especially `LibPositionRegistry.getConditionId(uint256)`, mistaken for "called" because the facet's same-named function definition matched the grep. |
| Slither `dead-code` + `unused-state` + `unused-return`, unfiltered | 0 results | All 15 Category A — every dead function has at least one caller, just not one reachable from a live root. Slither has no concept of "Diamond root set". |
| Solidity coverage at 0% lines | Would have caught most Category A | Would **not** have caught `LibDoefinOrder.hash/hashOrder/domainSeparator` (100% lines, exercised by harness only). |
| Layer-2 reachability (this pass) | 15 dead + 2 orphan externals + 32 test-only externals | None observed. Soundness check passed (`registerPositionPairs`, `validatePositionId` reach as live). No unresolved dynamic calls. |

## Tooling — reproduction

Everything is on the host or in the audit Docker container; no manual steps.

```bash
# Layer 1 + 2 in one shot (writes audit/output/deadcode/)
npm run audit:deadcode

# Layer 3 — needs sibling repo paths
node audit/scripts/usage-matrix.js \
    --backend  ../doefin-backend \
    --frontend ../doefin-frontend
# or: npm run audit:deadcode:matrix

# Layer 4
npm run audit:coverage
```

Artifacts:

- `audit/output/deadcode/slither-deadcode.{txt,json}` — Layer 1 raw output.
- `audit/output/deadcode/reachability.{txt,json}` — Layer 2 closure + Category A.
- `audit/output/deadcode/usage-matrix.{md,json}` — Layer 3 matrix.
- `audit/output/deadcode/coverage-run.log` + `coverage/` — Layer 4.

Optional CI gate: diff `reachability.json#dead_functions` between branches and
fail if the set grows. Left for a follow-up.

## Verification done

1. **Compile clean** — `npx hardhat compile` (Slither and coverage both
   recompiled successfully; 94 contracts).
2. **Soundness check inside the reachability script** — `registerPositionPairs`
   and `validatePositionId` come out reachable. If a known-live function fell
   out as dead, the graph would be missing edges (modifiers / `using for` /
   library calls) and the dead list would be untrustworthy.
3. **No unresolved dynamic calls** — `unresolved dyn. calls: 0` means there
   are no `InternalDynamicCall` (function pointer) edges that could let the
   closure under-report.
4. **Manual spot-check of every Category A finding** — `grep -rn <name>
   contracts/` for each, confirming the only matches are the declaration
   itself and (for A-12..14) the mock + audit harness. Output retained in the
   report rationale column.
5. **Layer-1/Layer-2 comparison** — Slither's `dead-code` detector emitted 0
   results on the same source tree. This is the headline structural finding:
   the existing tooling is not a dead-code gate.

## Follow-up tickets (suggested, not part of this pass)

- **A-DEAD-1** — remove A-1..6 and A-15 (uncontroversial; no integration
  surface affected).
- **A-DEAD-2** — pick one source of truth for the block-header oracle view
  functions (A-7..11); migrate the facet to the library or delete the library
  copies.
- **A-DEAD-3** — refactor `DoefinOrderHarness` / `DoefinInvariantHarness` to
  use the calldata variants, then delete A-12/13/14.
- **B-PRODUCT-1** — product decision on `submitNextBlock` / `submitBatchBlocks` /
  `fillOrder` and on `MarketDataFacet`'s view surface. The C-1 verdict
  follows from this.
- **CI-1** — wire the closure-shrink gate so future PRs cannot introduce new
  Category A regressions silently.
