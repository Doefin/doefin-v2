# Doefin v3 Mainnet Audit — Phase 5 Fix Changelog

**Branch:** `feature/mainnet-audit-system` · **State:** uncommitted working-tree changes (not staged, not committed).
**Scope:** Settlement-input hardening — the 2 HIGH mainnet blockers plus 3 co-located `_validateOrder`/operator-fill guards.

All five fixes are confined to `contracts/facets/SettlementFacet.sol`. No new errors were added —
`Errors.sol` already declared `TokenNotAllowed`, `InvalidUnitPerPair`, `ZeroAmount`, `InvalidPrice`,
and `InvalidMatch`. No storage layout or function-selector change; all fixes are upgrade-safe.

Tests added in one new describe block, `Mainnet audit — settlement-input hardening`, in
`test/unit/SettlementFacet/SettlementFacet.test.js` (lines 1922-2235). Every fix-dependent test
was negative-control verified: with `SettlementFacet.sol` reverted to pre-fix, all 10
fix-dependent cases fail (the 3 control cases still pass); with the fixes applied all 13 pass.

| ID | Severity | Files changed (working tree) | Test file::case | Note |
|---|---|---|---|---|
| SEC-001 | HIGH | `contracts/facets/SettlementFacet.sol` — `_settleComplementary` NatSpec + guard at line 448 (`if (taker.collateralToken != maker.collateralToken) revert Errors.InvalidMatch();`) | `SettlementFacet.test.js` :: `Mainnet audit … › SEC-001 › should revert a complementary match when taker and maker collateral tokens differ` (+ control: `should still settle … when both collateral tokens match`) | First statement of `_settleComplementary`; mirrors the identical guard already in `_settleMint` (line 499) and `_settleMerge` (line 567). Closes the Slither `arbitrary-send-erc20` cluster. |
| SEC-002 | HIGH | `contracts/facets/SettlementFacet.sol` — `_validateOrder` NatSpec + lines 332-336 (`isAllowed` allow-list check → `Errors.TokenNotAllowed`; `unitPerPair == 0` check → `Errors.InvalidUnitPerPair`) | `SettlementFacet.test.js` :: `Mainnet audit … › SEC-002 › should revert settlement against a never-allow-listed collateral token`, `… › should revert settlement against a token after it is removed from the allow-list`, `… › should revert fillOrder against a non-allow-listed collateral token` | Central gate in `_validateOrder`, so it covers `matchOrders` (taker + every maker) and `fillOrder`. Reads `LibDoefinStorage.appStorage().adminConfigStorage`. Pre-fix, a zero-fee order on a removed token settled with no revert; a non-zero-fee order reverted only incidentally with the wrong error (`InvalidPrice` from `_computeFee`). |
| SEC-003 | MEDIUM | `contracts/facets/SettlementFacet.sol` — `_executeOperatorFill` NatSpec + lines 639-640 (`collateralAmount == 0` → `Errors.ZeroAmount`; `collateralAmount < fee` → `Errors.InvalidPrice`) | `SettlementFacet.test.js` :: `Mainnet audit … › SEC-003 › should revert a fillOrder whose collateral leg rounds down to zero`, `… › should revert a sub-unit sell fillOrder that rounds the collateral leg to zero` (+ control: `should still fill an order whose collateral leg is non-zero`) | Placed immediately after `collateralAmount` is computed. The `< fee` check also prevents the `collateralAmount - fee` subtraction below from underflow-panicking. |
| BIZ-004 | LOW | `contracts/facets/SettlementFacet.sol` — `_validateOrder` line 339 (`if (uint256(order.pricePerToken) > unit) revert Errors.InvalidPrice();`) | `SettlementFacet.test.js` :: `Mainnet audit … › BIZ-004 › should revert a zero-fee order whose pricePerToken exceeds unit` (+ control: `should accept an order whose pricePerToken equals unit exactly`) | Reuses the SEC-002 `unitPerPair` read. Test uses `feeRateBps == 0` so the revert is proven to come from `_validateOrder`, not `_computeFee`'s own `price > unit` guard (which early-returns on zero fee). |
| BIZ-006 | LOW | `contracts/facets/SettlementFacet.sol` — `_validateOrder` line 329 (`if (order.side > 1) revert Errors.InvalidMatch();`) | `SettlementFacet.test.js` :: `Mainnet audit … › BIZ-006 › should revert a matchOrders pair whose taker order has side = 2`, `… › should revert when a maker order has side = 2`, `… › should revert a fillOrder whose order has side = 255` | Rejects `side >= 2` before `_determineMatchType` can route a malformed order to the complementary path. |

## Verification

- `npx hardhat compile` — clean (the one `LibDiamond.sol` unused-parameter warning is pre-existing and unrelated).
- `npx hardhat size-contracts` — `SettlementFacet` 13.998 KiB deployed (+0.664 KiB), well under the 24 KiB limit.
  The single contract over the size limit is `DoefinInvariantHarness` (the Phase 3 fuzzing harness, not a deployable facet).
- `npx hardhat test test/unit/SettlementFacet/SettlementFacet.test.js` — 84 passing, 0 failing (13 new audit-hardening cases included).
- `npx hardhat test` (full suite) — 517 passing, 2 pending, 1 failing.
  The single failure, `Batch Submission Settlement Fix Verification` in
  `test/integration/BatchSubmissionBugRepro.test.js`, is a pre-existing failure in out-of-scope CTF
  code (`LibConditionMetadata.sol:131`, `ValueOutOfRange()`). It is not caused by these fixes.

---

# Phase 5b — Remaining mainnet-audit fixes

**Branch:** `feature/mainnet-audit-system` · **State:** uncommitted working-tree changes
(not staged, not committed). **Scope:** every remaining `status: confirmed AND decision: fix`
finding in `audit/findings-ledger.md` except the items explicitly deferred at the bottom of this
table.

| ID | Severity | Files changed (working tree) | Notes |
|---|---|---|---|
| BIZ-001 | MED | `contracts/facets/SettlementFacet.sol` — `_settleMerge` line ~654-663 replaces the two `if (payout > fee)`-guarded `safeTransfer` branches with checked subtractions (`takerNet = takerPayout - takerFee`, `makerNet = makerPayout - makerFee`). | The pre-fix branch silently skipped payouts while still remitting fees if `fee >= payout`. At MAX_FEE_RATE_BPS=100 the case is unreachable, but a future cap raise would re-arm it with no test signal; the checked subtraction makes it a clean revert. |
| SEC-006 | MED | `contracts/facets/SettlementFacet.sol` (constant line ~32-36) · `.claude/CLAUDE.md` (fee-model section line 64-69) | `MAX_FEE_RATE_BPS` lowered from 500 (5%) to 100 (1%). CLAUDE.md corrected: fees go to `ds.adminConfigStorage.feeReceiver`, not the operator — the operator is the authorized `msg.sender`, never a fee sink. |
| SEC-005 | MED | NEW `contracts/libraries/LibSignature.sol` · `contracts/facets/SettlementFacet.sol` (`_verifySignature`) · `contracts/facets/SignatureVerifierFacet.sol` (`_verifySignature`, removed `_recoverSigner` + EIP1271_MAGIC_VALUE) · `contracts/facets/OracleManagerFacet.sol` (`_recoverSigner`, removed IERC1271 import) | Three triplicated copies consolidated into one library: `recoverCalldata` / `recoverMemory` / `verifyEIP1271`, the secp256k1 half-curve constant + low-`s` reject + v normalization promoted up. All three facets now use the typed `IERC1271(...).isValidSignature` dispatch (with try/catch) instead of the raw `staticcall` previously used in SettlementFacet. Closes the OracleManagerFacet malleability gap (REMAINING-1). |
| CPX-003 | LOW | NEW `contracts/libraries/LibOrderValidity.sol` · `contracts/facets/NonceManagerFacet.sol` (`isOrderValid` now delegates; NatSpec corrected to reflect that SettlementFacet does NOT call this function) | The shared orderbook-validity rule (not cancelled, nonce current, salt above min, not expired) lives in one library. `SettlementFacet._validateOrder` still inlines the rules (it has to revert with rule-specific reasons), but the doc-level lie ("settlement calls `isOrderValid()`") is gone. |
| SEC-004 | MED | `contracts/libraries/LibSettlementStorage.sol` (struct: cached `domainSeparator` field replaced with `__reserved_sec004_domainSeparator` slot placeholder so `__gap` keeps its downstream offsets) · `contracts/interfaces/ISettlement.sol` (selector `cacheDomainSeparator()` removed) · `contracts/facets/SettlementFacet.sol` (removed `cacheDomainSeparator()` external, simplified `_getDomainSeparator()`) · `contracts/facets/SignatureVerifierFacet.sol` + `contracts/facets/NonceManagerFacet.sol` (`_getDomainSeparator` now delegates) · `contracts/libraries/LibDoefinOrder.sol` (NEW helper `diamondDomainSeparator(address)`) · `contracts/audit/DoefinInvariantHarness.sol` (settlement-cut selector array shrunk from 9 to 8) | Fresh-deploy storage-layout change. **Selector removal** — `cacheDomainSeparator()` is gone from `ISettlement` and from the SettlementFacet diamondCut selector list. `deploy.js` uses `getSelectors(facet)` so it auto-adjusts; the historical `scripts/upgrades/upgrade-settlement-scrum89.js` script still references the field in a comment for the SCRUM-89 upgrade history (kept as-is). |
| BIZ-002 | LOW | `contracts/facets/SettlementFacet.sol` — `_settleMerge` line ~592-599: the crossing check `if (P_t + P_m > unit) revert InvalidMatch()` moved to BEFORE the ERC-1155 pulls and the CTF burn, mirroring `_settleMint` (line ~507). | Atomic-revert always meant no fund loss pre-fix; the placement now matches `_settleMint` so the check-effects-interactions ordering is consistent across both paths. |
| CPX-006 + GAS-006 | LOW | `contracts/facets/SettlementFacet.sol` — `matchOrders` (line ~76-160) refactored: new private helper `_settleAgainstMaker(...)` extracted (the per-leg loop body); the standalone pre-loop `totalMakerFill` sum at lines 93-104 folded INTO the main loop; the equality `totalMakerFill == takerFillAmount` is asserted once after the loop. Archaeological "Fix N" comments rephrased as invariant NatSpec. | The aggregate sum is a router-input consistency check; each leg is independently bounded by `_checkFillAmount` (per-maker remaining capacity). |
| CPX-007 + GAS-002 | LOW | `contracts/facets/SettlementFacet.sol` — new private helper `_conditionAndPartition(takerPositionId, makerPositionId, ds)` replaces the verbatim 6-line `_splitPosition`-arg construction at the top of `_settleMint:497-506` and `_settleMerge:550-553`. The AppStorage pointer is resolved once at the matchOrders loop's hoist and threaded through `_executeSettlement` → `_settleX`. `_getIndexSet` retains its public-internal contract but now delegates to a new `_getIndexSetIn(positionId, ds)` so the partition slot scan re-uses the resolved namespace. The misleading "O(1)" comment is gone — replaced with "linear scan over the market's position slots (length 2 for binary markets)." | Pure DRY refactor; behaviour unchanged. |
| GAS-004 | LOW | `contracts/facets/SettlementFacet.sol` — `_computeFee(uint16, uint128, uint128, uint256 unit)` is now `pure`: `unit` is an input parameter, the SLOAD lives once per maker iteration in the `matchOrders` loop body (and once per `fillOrder` call). `feeReceiver` is similarly hoisted and threaded through. The `feeRateBps <= MAX_FEE_RATE_BPS` and `price <= unit` guards inside `_computeFee` are retained (they are correctness guards, not redundant). `_validateOrder` is the SEC-002 gate that ensures `unit != 0` before the loop body fires. | `_settleComplementary`, `_settleMint`, `_settleMerge`, `_executeOperatorFill` all take `unit` (and where needed `feeReceiver`, `ds`) as parameters now. |
| GAS-007 | LOW | `contracts/facets/SettlementFacet.sol` — `unchecked { ++i }` applied to the three remaining loop counters (`matchOrders` maker loop, `_getIndexSetIn` partition scan). Four guarded subtractions wrapped in `unchecked {}`: `fillAmount - makerCollateral` (`_settleMint`, guarded by the crossing check), `fillAmount - makerPayout` (`_settleMerge`, same), `collateralAmount - fee` (`_executeOperatorFill`, guarded by the `< fee` revert). The fee/collateral multiplications are NOT uncheckled — those can overflow on adversarial inputs and the checked arithmetic is the safety boundary. | The `orderAmount - filled` subtraction in `_checkFillAmount:352` was already inside a comparison; the comparison itself prevents the underflow case. Wrapping it in `unchecked` is a no-op the compiler already inlines, so left as-is for readability. |
| SEC-011 | LOW | `contracts/libraries/Events.sol` — NEW `OperatorUpdated(address indexed oldOperator, address indexed newOperator)` · `contracts/facets/SettlementFacet.sol` — `setOperator` now reverts with `Errors.ZeroAddress()` on `address(0)` and emits `OperatorUpdated(old, new)`. (`Errors.ZeroAddress` already existed in the central Errors lib; not added.) | The `cacheDomainSeparator()`-event ask in the original SEC-011 framing dropped away when that selector was removed in SEC-004 (Group C). |
| SEC-012 | INFO | `contracts/libraries/Events.sol` — orphaned `event ProtocolFeesWithdrawn` declaration deleted (replaced with a short SEC-012 attribution comment). | Grep confirmed zero emit sites in the codebase. |
| SEC-013 | INFO | `contracts/facets/AdminConfigFacet.sol` — `setTradingFeesBps(...)` deleted, `getFees()` narrowed to return `(address feeReceiver, uint16 resolutionFeeBps)` · `contracts/interfaces/IAdminConfig.sol` — same · `contracts/libraries/LibDoefinStorage.sol` — `makerTradingFeeBps` / `takerTradingFeeBps` fields removed from `AdminConfigStorage`; `LibDoefinStorage.initialize(...)` signature narrowed to `(address feeReceiver, uint16 resolutionFeeBps)` · `contracts/upgradeInitializers/DiamondInit.sol` — call site updated to the 2-arg signature, deprecation lines removed · `contracts/audit/DoefinInvariantHarness.sol` — admin-config selector array shrunk from 13 to 12 · `test/utils/adminConfigUtils.js` + `test/unit/AdminConfigFacet/AdminConfigFacet.test.js` — wrapper and unit tests rewritten against the new 2-tuple `getFees`. | Fresh-deploy storage-layout change (struct narrows). The two test-audit assertions targeting the dead path (`LOW-INFO-batch.test.js`) are expected to flip — the user re-runs the audit suite separately. |
| SEC-014 | INFO | `contracts/facets/ERC1155Facet.sol` — the facet's explicit `emit Events.ApprovalForAll(...)` removed; the `Events` import is now unused and also dropped. The library function `LibERC1155.setApprovalForAll` is now the sole emit site. | Removes one redundant log per `setApprovalForAll` call. |

## Storage layout change summary (fresh deploy required)

Two fresh-deploy storage changes land in this batch:

1. **`LibSettlementStorage.SettlementStorage`** — `domainSeparator bytes32` removed
   (SEC-004). Replaced with `__reserved_sec004_domainSeparator` so the trailing `__gap`
   keeps its offset; the live value (if any) becomes inert on the new deployment.
2. **`LibDoefinStorage.AdminConfigStorage`** — `makerTradingFeeBps uint16` and
   `takerTradingFeeBps uint16` removed (SEC-013). The two packed `uint16` slots they
   occupied are gone; downstream `__gap[10]` is unchanged.

Both are safe for a fresh mainnet deploy (the explicit reason this dispatch was scoped to
"mainnet-fresh-deploy" rather than "upgrade existing diamond"). For any future upgrade-in-place,
do NOT diamondCut these facets onto a live diamond without storage migration.

## Selector change summary

- **Removed** `cacheDomainSeparator()` (SettlementFacet) — selector dropped from the diamondCut.
- **Removed** `setTradingFeesBps(uint16,uint16)` (AdminConfigFacet) — selector dropped from the diamondCut.
- **Changed** `getFees()` signature on AdminConfigFacet (2-tuple, not 4-tuple) — selector change.

`scripts/deploy.js` uses `getSelectors(facet)` dynamically, so it auto-adjusts.
`contracts/audit/DoefinInvariantHarness.sol` was updated to match (its selector arrays were
hand-written).

## Verification

- `npx hardhat compile` — clean (no new warnings beyond the pre-existing `LibDiamond.sol`
  unused-parameter one).
- `npx hardhat size-contracts` — `SettlementFacet` is 13.097 KiB deployed (down from
  13.949 KiB, a 0.85 KiB win from the GAS-002/GAS-004/GAS-006/GAS-007 refactor); all
  in-scope facets remain well under 24 KiB. The single contract over the size limit is
  `DoefinInvariantHarness` (init code only — test-only, not a deployable facet).
- `npx hardhat test test/unit/SettlementFacet/SettlementFacet.test.js` — **83 passing, 0
  failing**. The unit tests for the new SEC-006 cap (100 bps), the SEC-004 domain-separator
  parity, and the Group E refactor all pass. Two pre-existing fee-calc unit tests had
  hardcoded `200 * ...` math that was updated to use the `FEE_BPS` constant (which dropped
  from 200 to 50 to stay inside the new 100-bps cap).
- `npx hardhat test` (full suite) — 528 passing, 23 pending, **16 failing**.
  - **15 of the 16 failures are in `test/audit/`** and are the expected post-fix flips
    (the user re-runs that suite separately):
    - `BIZ-001-*` controls — pass after the cap stayed at 100, but the merge-overpay
      DEMONSTRATES case at 500 is now blocked.
    - `SEC-001-*` ATTACK-BLOCKED + 2 CONTROLs — sign with old `feeRateBps = 200`.
    - `SEC-002-*` CONTROL — same.
    - `SEC-004-*` DEMONSTRATES + CONTROL — the cache no longer exists.
    - `SEC-005-*` CONTROL — uses old `feeRateBps`.
    - `SEC-006-*` both DEMONSTRATES — the cap is now 100, not 500; fees now correctly
      assert against `feeReceiver`.
    - `SEC-007-*` all three cases — use old `feeRateBps`.
    - `LOW-INFO-batch.test.js` SEC-011, SEC-013, SEC-014 DEMONSTRATES — the bugs are now fixed.
  - **The 16th failure** (`Batch Submission Settlement Fix Verification` in
    `test/integration/BatchSubmissionBugRepro.test.js`) is the pre-existing failure in
    out-of-scope CTF code (`LibConditionMetadata.sol:131`, `ValueOutOfRange()`) noted in
    the Phase 5 changelog; not caused by these fixes.

## Deferred (out of scope for this dispatch)

| ID | Why deferred |
|---|---|
| SEC-007 (MED) | Off-`unit` price-sum slack — needs team confirmation that the slack is intentional under SCRUM-121's "effective price" model. If unintentional, tighten the mint/merge crossing check to `== unit`. |
| GAS-001 (MED) | Removing the four dead `DoefinOrder` fields (`minFillAmount` / `orderType` / `quoteCurrency` / `exchangeRate`) is a breaking EIP-712/ABI change; needs byte-for-byte backend coordination (`encoder.py`, `models.py`, `settlement_abi.py`). Schedule as an explicit pre-deploy decision item. |
| GAS-005 (MED) | `optimizer runs=1` mistuning — needs a measurement sweep across `runs ∈ {200, 1000, 100000}`. Pick the highest that beats the current baseline without breaching EIP-170. Separate task. |
| BIZ-008 (INFO) | `minFillAmount` NatSpec note — only required if GAS-001 isn't executed pre-deploy. Becomes mandatory if the dead field stays. |
| GAS-003 (LOW) | Fee-transfer coalescing — narrow residual, most batching blocked by distinct debtors. Deferred per dispatch spec. |
| SEC-008, SEC-009, SEC-010 (LOW) | accept-risk, no fix. |
| BIZ-005 (LOW) | Test coverage gap, separate work — the on-chain fee invariants are now exercised at multiple price points by the existing SettlementFacet test, but the specific multi-maker `feeRateBps > 0` integration case is still owed. |
| CPX-005, CPX-A2, CPX-A4567 | Post-launch cleanup commit. |

## Audit pentest assertions that will need to be updated (the user re-runs separately)

These tests in `test/audit/` were written against pre-fix behaviour and will need their
"DEMONSTRATES BUG" and "CONTROL" assertions adjusted post-fix:

- `SEC-004-domain-separator-cache.test.js` — the storage-corruption demo using
  `cacheDomainSeparator()` is no longer runnable (the selector is gone).
- `SEC-006-fee-recipient-and-cap.test.js` — the 5% cap assertion (`feeRateBps = 500`)
  must become 1% (`feeRateBps = 100`). The "fees go to feeReceiver, not the operator"
  demonstration is still correct — only the dollar amounts shift.
- `SEC-011-set-operator.test.js` (in `LOW-INFO-batch.test.js`) — the
  `setOperator(address(0))` accept-case is now a revert (`ZeroAddress`).
- `SEC-013` block (in `LOW-INFO-batch.test.js`) — `setTradingFeesBps` is gone; the
  selector call will fail at the ABI layer.
- `SEC-014-double-event.test.js` (in `LOW-INFO-batch.test.js`) — the duplicate-event
  count drops from 2 to 1 per `setApprovalForAll` call.
- `SEC-001-token-mismatch.test.js`, `SEC-002-allowlist-gate.test.js`, `SEC-005-*`,
  `SEC-007-*`, `BIZ-001-*` — most failures are mechanical: the test fixtures sign orders
  with `feeRateBps = 200`, which now exceeds `MAX_FEE_RATE_BPS = 100`. Either update the
  fixture to use a `feeRateBps <= 100` or sign `feeRateBps = 0` for cases not testing
  fee logic.

---

# SCRUM-521 — SEC-015: `submitBatchBlocks` reorg-rewind underflow (production incident 2026-09-15)

**Branch:** `feature/SCRUM-521-fix-submit-batch-blocks-ring-buffer-underflow-blocking-mainnet-oracle` (off `dev`).
**Scope:** the one arithmetic defect that froze the Base-mainnet block-header oracle, its regression matrix, the
single-selector deployment tooling, and the audit-scope correction that let it escape. No new errors, events,
storage or selectors.

| ID | Severity | Files changed | Test | Note |
|---|---|---|---|---|
| SEC-015 | HIGH | `contracts/facets/DoefinV1BlockHeaderOracleFacet.sol` — `submitBatchBlocks` rewind: `depth = currentBlockHeight - forkHeight`; prev-header slot `(nextBlockIndex + numHeaders - depth - 1) % numHeaders`; pointer `(nextBlockIndex + numHeaders - depth) % numHeaders` (+ NatSpec `@dev` / `@custom:reverts`) | `test/integration/OracleReorgIndexUnderflow.test.js` — real headers 967110-967160 + the orphaned 967143 read back from mainnet (`test/data/reorg_index_underflow/`, loader `scripts/lib/oracle-fixture.js`): orphan in each of the 17 ring slots × replay depths {1, 2, 3, 6} (68 replays), negatives (`NewChainNotLonger`, `CannotFindForkPoint` ×2, `PrevBlockHashMismatch`), recovery from the production state + `submitNextBlock` catch-up across the 16 → 0 wrap, depth-0 extension after a replay | Negative-control verified: on the pre-fix facet **19 cases fail, all `Panic(0x11)`** — every depth-`d` replay in a slot where `nextBlockIndex <= d` (16) plus the 3 cases that depend on a successful replay; with the fix **75 passing**. `_findForkPoint` bounds `depth <= 16`, so the `+ NUM_OF_BLOCK_HEADERS` idiom (already used by `_findForkPoint` and `LibDoefinBlockHeaderOracle.getBlockHeaderByNumber`) keeps every intermediate non-negative with the modulus unchanged. `NewChainNotLonger`, `BlockReorged`, `_applyChain` untouched. |

**Deployment tooling (same branch):** `scripts/upgrades/upgrade-scrum521-oracle-reorg-underflow.js` — Replace cut of
the `submitBatchBlocks` selector only (`0x7ea1b3d8`), Safe-routed on public networks, owner-impersonated on a fork,
DiamondLoupe post-check + oracle-state-unchanged check; `scripts/oracle-replay-batch.js` — submits the held
`[967143 canonical .. 967146]` batch only from the exact incident state, after a simulation that distinguishes
"fix not live" (`Panic(0x11)`); `scripts/upgrades/rehearse-scrum521-fork.js` — end-to-end rehearsal on a Base-mainnet
fork. npm: `upgrade:scrum521:{baseSepolia,base,rehearse}`, `oracle:replay:{baseSepolia,base}`.

**Audit-scope correction:** `audit/00-scope.md` and `audit-exclusion-guidance.md` had excluded the block-header oracle
as "v1 (superseded)"; it is the live settlement-triggering oracle. Re-scoped IN; SC08 in
`audit/findings/manual-findings.md` flipped from Pass to Findings; `.coderabbit.yml` path instruction for the facet
updated to review ring-buffer arithmetic (wrap-safe idiom only); follow-ups SCRUM-521-BE-GUARD / -AUDIT-SCOPE /
-DEEP-REORG-MTP in `audit/follow-ups.md`.

## Verification

- `npx hardhat compile` — clean (solcjs 0.8.20 on the arm64/no-Rosetta dev machine; CI uses native solc on Linux).
- `npx hardhat size-contracts` — `DoefinV1BlockHeaderOracle` 9.091 KiB deployed (+0.022 KiB), `BlockHeaderUtils`
  0.426 KiB; the only contract over the limit is the audit-only `DoefinInvariantHarness`, unchanged.
- `npx hardhat test test/integration/OracleReorgIndexUnderflow.test.js` — **75 passing** (pre-fix facet: 56 passing,
  19 failing, all `Panic(0x11)`).
- `npx hardhat test` (full suite) — **680 passing, 21 pending, 0 failing** (10 min); the storage-layout snapshot gate
  (`test/storage/storage-layout-snapshot.test.js`) matches the committed snapshot, as expected for a code-only change.
- `npm run upgrade:scrum521:rehearse` (fork of Base mainnet, 2026-09-23, fork block 51680704) — **PASSED**: live
  state `height 967143 / nextBlockIndex 0 / tip = orphan …8e0c9e34…314c` reproduced; the held batch reverts
  `Panic(0x11)` on the current facet `0x966584f4…3121`; cut (158,344 gas, Safe `0x42B0c347…3486` impersonated)
  routes only `submitBatchBlocks` to the new facet, the other 11 oracle selectors and the oracle state are
  untouched; replay 557,801 gas → `BlockReorged` ×1, height 967146, `nextBlockIndex 3`,
  `getBlockHeaderByNumber(967143)` canonical `…895ebcc5…bea37f`; catch-up 967147-967160 walks the pointer 4 → 16 → 0.

## SCRUM-521 rollout log

| Step | When (UTC) | Evidence |
|---|---|---|
| Base Sepolia cut | 2026-09-23 12:12 | Safe-routed single-selector Replace on `0x2f03d475…Ae3f`: `submitBatchBlocks` (`0x7ea1b3d8`) → fixed facet `0x32F61D47…4De` (linked to a fresh `BlockHeaderUtils` `0x2AE70d19…7d7D`); the other 11 oracle selectors stay on `0xF69e3109…8Aa3`. Cut tx `0xd1223e2a…ceec`, Safe tx `0x37da6c65…e7e3`. Oracle state unchanged by the cut (height 968269, `nextBlockIndex 4`). Record: `deployments/baseSepolia/scrum521-oracle-upgrade-2026-09-23T12-12-38-854Z.json`. Post-cut verification: new facet runtime bytecode byte-identical to the local fixed build (library address substituted), routing confirmed via DiamondLoupe, and the oracle advanced canonically through the new facet afterwards (`npm run oracle:status:baseSepolia` at 13:08 UTC: #968276, 0 blocks behind the Bitcoin tip, tip canonical). Both new contracts verified on Sourcify (exact match: `0x2AE70d19…7d7D` job `ace554b8…`, `0x32F61D47…4De` job `77666201…`). Basescan verification did **not** happen: the `ETHERSCAN_API_KEY` in `.env` is rejected by the Etherscan v2 API, so the script's verify step was skipped with a warning (the CR-HARDHAT-VERIFY failure mode) — re-run `npx hardhat verify --network baseSepolia --libraries <file exporting { BlockHeaderUtils: "0x2AE70d19Bb26cCC16700a4B66DaF8A3c73A47d7D" }> 0x32F61D479483fB244a780afd5E45E4c8244fE4De` with a valid key, or import from Sourcify on Basescan. |
| Base mainnet cut | pending | `npm run upgrade:scrum521:base` |
| Mainnet held-batch replay | pending | `npm run oracle:replay:base`; then `npm run oracle:status:base` must report the tip canonical and the lag shrinking |
| block-indexer guard removal (same window) | pending | SCRUM-521-BE-GUARD |

**Monitoring tool added:** `scripts/oracle-status.js` (`npm run oracle:status:{baseSepolia,base}`) — stored tip / pointer /
facet behind `submitBatchBlocks`, lag vs the Bitcoin tip and canonical check via mempool.space; exits 1 on an orphaned tip
(the SEC-015 signature), 2 on lag > `ORACLE_STATUS_MAX_LAG`.
