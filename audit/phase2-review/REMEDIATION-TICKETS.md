# Doefin v3 — Phase-2 Remediation Tasks

Derived from the Phase-2 review triage (`REVIEW.md`), walked with the user 2026-05-22.
All 26 actionable findings are packaged into **3 Jira tasks**. The earlier 7-group
breakdown (G1–G7) is retained as the *internal* sub-structure of each task — one
commit per group — so the CLAUDE.md "one commit per logical unit" rule still holds.

Each task below is Jira-paste-ready: title, per-group scope checklist, an explicit
**characterization-test plan**, and a Definition of Done. Replace `SCRUM-XXX` with
the real id once the Jira task exists — the branch is `feature/SCRUM-{id}-{Short-Desc}`
off the v3 development branch, per the repo rule.

## Task summary

| Task | Contains | Findings | upgrade-safe | Pre-deploy | Effort |
|---|---|---|---|---|---|
| **A — Settlement facets: structural cleanup** | G5 dead-code · G1 facet split · G3 access-control · G4 signature dedup · settlement-area docs | CPX-001/002/003/004/008, ARCH-01/02/06/09/10/13, GAS-005, INFO-3/4/5/6, CPX-006b | **no** (via G1) | **yes** | M–L |
| **B — Finalize v3 storage layout** | G2 EIP-7201 namespaces + storage docs | ARCH-03/04/05, INFO-1 (GAS-004 void) | **no** | **yes** | M |
| **C — Gas hot-path pass** | G6 gas optimizations (+ OracleAdapter NatSpec, INFO-2) | GAS-001/002/003/006/007 | yes | no | low–M |

## Sequencing & dependencies

- **Cross-task order: B → A → C.**
  - **B first** — G2 peels `AccessControlStorage` into its own EIP-7201 namespace.
    Task A's access-control work (G3) should be written against that *final*
    storage; doing A first means reworking G3 when B lands.
  - **A second** — the structural cleanup, on the final storage layout.
  - **C last** — gas pass is independent of both; do it on the settled code.
- **Tasks A and B are pre-deploy-gated** (`upgrade-safe: no`) — they change the
  function-selector set and the storage layout. Free if landed before the fresh v3
  mainnet deploy; costly `diamondCut` + storage migration after. Task C is not
  gated but should still land before the audit handoff so auditors see final code.
- **B is the last storage-touching work.** Its layout snapshot test baselines the
  *final* layout — any later storage change would have to re-baseline it.

## Open item — ARCH-08 (not in any task)

`audit/00-scope.md:16` names `OracleManagerFacet` and `BlockScholesOracleAdapter` —
contracts that do not exist (the deploy script ships `OracleAdapterFacet` and
`DoefinV1BlockHeaderOracle` only). Auditors working from the scope doc will hunt
phantom contracts. This is a 1-line documentation fix, but `audit/00-scope.md` is a
pre-existing file under the "do not modify `audit/`" rule, so it cannot ride inside
a code task. **User decision needed:** correct it directly, or have the audit-handoff
owner do it. `.claude/CLAUDE.md` is already clean — verified.

## Characterization-test method (applies to every refactor)

A **characterization test** pins *current, observable* behavior — it is written and
committed *before* the refactor, passes on today's code, and the refactor's only job
is to keep it green. It is the safety net that proves a "no behavior change" refactor
actually changed no behavior.

Rules for this work:
- Each refactor group's characterization test is **commit #1 of that group** — it
  lands and passes against the pre-refactor code, then the refactor follows.
- Characterization tests assert *exact* observable behavior: return values, emitted
  events, and **exact revert errors** (not just "it reverts").
- Pure-deletion groups (G5) and config/doc changes have no characterization test —
  their safety net is the full regression suite plus one targeted new test.
- Every group's DoD: `npx hardhat compile` clean · `npx hardhat size-contracts` all
  facets < 24 KiB · full `npx hardhat test` green · no new pending tests.

---

# Task A — Settlement facets: structural cleanup

**Title:** `Settlement facets — structural cleanup: facet split, access-control, signature dedup, dead-code`
**Branch:** `feature/SCRUM-XXX-Settlement-Structural-Cleanup`
**upgrade-safe:** no (G1 moves selectors) — **pre-deploy-gated**
**Effort:** M–L
**Priority callout for the Jira description:** this task carries **ARCH-02, a High
finding** (the `addMarketMaker` authorization gate is invisible — buried inside a
library setter). Track it as the headline item.

Internal commit order: **A1 → A2 → A3 → A4 → A5**. Each refactor group leads with its
characterization test (commit), then the change (commit).

## A1 — Dead-code & error-surface sweep (group G5)

**Findings:** CPX-002, CPX-003/ARCH-10, CPX-004, ARCH-13, GAS-005, CPX-008

### Scope
- [ ] **CPX-002** — delete the ~10 zero-reference errors (`InvalidTimestamp`,
      `SignatureExpired`, `InvalidSignature`, `ArithmeticOverflow`,
      `ArithmeticUnderflow`, `TooManyOutcomeSlots`, `NotOwner`, `InvalidAddress`,
      `NotPendingOwner`, `OracleAdapter_QuestionAlreadyExists`); delete the empty
      `FEE MANAGEMENT ERRORS` header; resolve the `MOCK CONTRACT ERRORS` block
      (move to the mock that needs them, or delete if none does).
- [ ] **CPX-003 / ARCH-10** — delete `SettlementFacet._getIndexSet` (dead wrapper;
      fix the dangling NatSpec ref to point at `_getIndexSetIn`); delete
      `LibReentrancyGuard._initReentrancyGuard` and `_isEntered`.
- [ ] **ARCH-13** — delete the `LibReentrancyGuard.nonReentrant` library modifier;
      move its usage guidance onto `_nonReentrantBefore`.
- [ ] **CPX-004** — delete `LibSignature.recoverMemory` (zero callers, never-fuzzed
      assembly).
- [ ] **GAS-005** — remove the dead `if (_status == 0)` init-check from
      `_nonReentrantBefore` (`DiamondInit` already sets `_status = 1`).
- [ ] **CPX-008** — add `error FillAmountMismatch(uint128 sumOfMakerFills, uint128 takerFillAmount)`
      to `Errors.sol`; revert it where `matchOrders` currently reverts
      `MismatchedInputLengths` for the fill-sum check; update `@custom:reverts` NatSpec.

### Characterization tests
No characterization test — A1 is deletion + one error rename. Safety net:
- [ ] Before deleting any error name, `grep -rn` it in `test/`. A hit means a test
      asserts an unemittable error (a pre-existing test bug) — flag it, do not keep
      the declaration to satisfy a broken test.
- [ ] **New test:** `matchOrders` reverts `FillAmountMismatch` when maker fill
      amounts do not sum to the taker fill amount — and still reverts
      `MismatchedInputLengths` for the genuine array-length mismatch (two cases,
      two distinct errors).

### DoD
Full suite green; `compile` clean; `size-contracts` clean (facet bytecode should
shrink slightly).

## A2 — Extract `SettlementAdminFacet` (group G1)

**Findings:** ARCH-01 (High), ARCH-09 — ARCH-07 optional, recommend defer.

### Scope
- [ ] Create `contracts/facets/SettlementAdminFacet.sol` — `setOperator`,
      `pauseTrading`, `unpauseTrading`, `getOperator`, `isTradingPaused`; bodies
      moved **verbatim** from `SettlementFacet` (no logic change).
- [ ] Remove those 5 functions from `SettlementFacet`; keep its `onlyOperator` /
      `notPaused` modifiers (they gate the hot path).
- [ ] Split `ISettlement` → `ISettlement` (`matchOrders`, `fillOrder`, hot-path
      views) + `ISettlementAdmin` (the 3 governance fns + governance views).
- [ ] Add `SettlementAdminFacet` to `scripts/deploy.js` `FacetNames`; register
      `ISettlementAdmin` in `DiamondInit` ERC-165 if `ISettlement` is registered.
- [ ] **ARCH-07** (`registerOrderSigner` → `NonceManagerFacet`) — note in the
      ticket, **do not action**; the review judged co-location acceptable.

### Characterization tests *(commit #1 of A2 — pin against current `SettlementFacet`)*
File: `test/characterization/SettlementAdmin.characterization.test.js`
- [ ] `setOperator`: non-owner reverts with the exact current error; owner succeeds
      and emits the operator-changed event; `getOperator` returns the new value.
- [ ] `pauseTrading` / `unpauseTrading`: non-owner reverts with the exact error;
      owner succeeds and emits; `isTradingPaused` reflects the flag.
- [ ] **Cross-facet behavior:** while paused, `matchOrders` reverts (paused error);
      after `unpauseTrading`, an otherwise-valid `matchOrders` settles.
- [ ] These pass against current code; **after the extraction the same file passes
      unchanged** against `SettlementAdminFacet`.

Post-extraction additions:
- [ ] Loupe test — `DiamondLoupeFacet.facetAddress(selector)` returns the
      `SettlementAdminFacet` address for all 5 selectors; `matchOrders`/`fillOrder`
      still resolve to `SettlementFacet`.
- [ ] Deploy script runs clean — no selector clash on `diamondCut`.

### DoD
Characterization file green pre- and post-move; loupe test green; full suite green;
`size-contracts` clean.

## A3 — Unify access-control (group G3)

**Findings:** ARCH-02 (High), ARCH-06. **Depends on Task B** (uses the peeled
`AccessControlStorage` namespace).

### Scope
- [ ] Standardize every owner-only check on `LibDiamond.enforceIsContractOwner()`;
      remove `LibAccessControl.isOwner` (callers use `LibDiamond` directly).
- [ ] Make every gate **visible in the facet body**: `AccessControlFacet.addMarketMaker`
      / `removeMarketMaker` call `LibDiamond.enforceIsContractOwner()` explicitly;
      `LibAccessControl.setMarketMaker` drops its embedded owner check (a storage
      setter must not double as an authorization gate).
- [ ] Add an `enforceIsOperator()` helper in the access library; replace
      `SettlementFacet`'s inline `msg.sender != ss.operator` with it.
- [ ] Slim `LibAccessControl` to the market-maker role only (`isMarketMaker`,
      `enforceIsMarketMaker`, `setMarketMaker`); delete the redundant
      `isCollateralTokenAllowed`. Consider renaming to `LibMarketMakerRole`.

### Characterization tests *(commit #1 of A3 — the regression risk ARCH-02 names)*
File: `test/characterization/access-control-matrix.characterization.test.js`
- [ ] An exhaustive matrix over **every privileged function** in the in-scope
      facets — owner-only (`setMaxFeeRate`, `setFeeReceiver`, `setResolutionFeeBps`,
      `addMarketMaker`, `removeMarketMaker`, `setOperator`, `pauseTrading`,
      `unpauseTrading`, `transferOwnership`, `diamondCut`, …) and operator-only
      (`matchOrders`, `fillOrder`):
  - unauthorized caller → reverts with the **exact current error selector**;
  - authorized caller → succeeds.
- [ ] This pins **revert-reason parity**. After the refactor every row passes
      unchanged — same revert error, same success.
- [ ] Explicit row for `addMarketMaker` / `removeMarketMaker` from a non-owner —
      proving the now-visible gate behaves identically to the previously-hidden one.

### DoD
Matrix green pre- and post-refactor with identical revert reasons; full suite green.

## A4 — Consolidate the signature-verification wrapper (group G4)

**Findings:** CPX-001.

### Scope
- [ ] Add `LibSignature.verifyOrderSignature(order, orderHash, signature, signatureType)`
      — the unified EOA/EIP-1271 dispatch wrapper above the existing primitives.
- [ ] `SettlementFacet` and `SignatureVerifierFacet` both call it; delete their
      private `_verifySignature` copies.
- [ ] `LibSignature` gains imports of `LibDoefinOrder` and `LibSettlementStorage`.

### Characterization tests *(commit #1 of A4)*
File: `test/characterization/signature-equivalence.characterization.test.js`
- [ ] A matrix over: `signatureType` 0 / 1 / >1; `signer == maker` vs
      `signer != maker`; a registered delegated signer; an EIP-1271 smart-wallet
      maker; a malleable-high-`s` signature; a signature recovering to `address(0)`.
- [ ] For each input, assert the **accept/reject decision and the revert error are
      identical** between the `SettlementFacet` settlement path and
      `SignatureVerifierFacet.verifyOrderSignature`.
- [ ] After consolidation every row passes unchanged.

### DoD
Equivalence matrix green pre- and post-consolidation; full suite green.

## A5 — Settlement-area documentation (part of group G7)

**Findings:** INFO-3, INFO-4, INFO-5, INFO-6, CPX-006b.

### Scope
- [ ] **INFO-5** — fix `Events.OrdersMatched` NatSpec: match-type encoding is
      `1 = Complementary, 2 = Mint, 3 = Merge` (code emits 1/2/3; comment says
      0/1/2 — a decoding-bug trap for off-chain consumers).
- [ ] **INFO-3 / INFO-4** — extract `uint256 constant BPS_DENOMINATOR = 10_000`;
      reference it from `SettlementFacet._validateFee` and `AdminConfigFacet`;
      apply consistent digit-separator formatting to 4+-digit literals.
- [ ] **INFO-6** — drop absolute "previously at line N" cross-references from
      `SettlementFacet` NatSpec; keep function-name references only.
- [ ] **CPX-006b** — rewrite the `DiamondInit.init` NatSpec block: ownership +
      `resolutionFeeBps = 500` for CTF redemption; settlement fees are
      operator-supplied, bounded by `maxFeeRateBps` (default 0); remove all
      "trading fees" phrasing.

### Characterization tests
None (comments + one constant). Safety net:
- [ ] Trivial assertion `BPS_DENOMINATOR == 10_000` (guards the INFO-3 extraction).

### DoD
Compile clean; full suite green (no behavior change).

---

# Task B — Finalize v3 storage layout

**Title:** `Finalize v3 storage layout — EIP-7201 namespaces`
**Branch:** `feature/SCRUM-XXX-Finalize-Storage-Layout`
**upgrade-safe:** no — storage layout change. Pre-deploy: free; post-deploy:
impossible without a full migration.
**Effort:** M
**Run this task first** (the B → A → C order).

## Scope (group G2 — Option A, full EIP-7201)

- [ ] **GAS-004 — VOID, no action.** The finding claimed the `Condition` struct
      wastes 2 slots (6 → 4). The storage-layout snapshot (commit 1) proves the
      struct is **already 4 slots** — solc packs `oracle` + `outcomeSlotCount` +
      `active` (20 + 1 + 1 = 22 bytes) into one slot because they are declared
      consecutively. 4 slots is the arithmetic minimum for those 6 fields; the
      proposed reorder saves nothing. The `Condition` struct is left unchanged.
- [ ] **EIP-7201 formula** — switch every storage namespace from `keccak256("id")`
      to `keccak256(abi.encode(uint256(keccak256("id")) - 1)) & ~bytes32(uint256(0xff))`.
      Applies to `LibDoefinStorage` (`AppStorage`), `LibSettlementStorage`, and the
      two new namespaces below. Add `@custom:storage-location erc7201:doefin.<id>`
      annotations on each storage struct.
- [ ] **ARCH-03 peel** — extract `AdminConfigStorage` and `AccessControlStorage`
      out of `AppStorage` into their own per-concern namespace libraries (own
      EIP-7201 slots), matching `LibSettlementStorage`. Update every facet/library
      that reads them (`AdminConfigFacet`, `AccessControlFacet`,
      `SettlementFacet._validateFee` / `_validateOrder`, `MarketDataFacet`,
      `ConditionalTokensFacet`, `LibAccessControl`, …).
- [ ] CTF / ERC1155 / position-registry / reentrancy / Bitcoin-oracle sub-structs
      **stay embedded in `AppStorage`** (peeling them is out of audit scope); keep
      their `__gap`s. `AppStorage` itself moves to its EIP-7201 slot.
- [ ] On the peeled namespaced structs the `__gap` is structurally unnecessary
      (256-slot runway) — drop it, or keep one with a clarifying comment.
- [ ] **CLAUDE.md storage section** — the EIP-7201 claim is now **true**: document
      the formula, the annotations, and that the legacy `AppStorage` monolith is a
      grandfathered exception holding only CTF/ERC1155/oracle/registry/reentrancy.
- [ ] **INFO-1** — while updating `MarketDataFacet` for the peeled namespace,
      remove its doubled NatSpec blocks (one block per function).

## Characterization / snapshot tests

The storage-layout snapshot **is** the primary deliverable. Build it in two phases
so the migration is provably understood:

File: `test/storage/storage-layout-snapshot.test.js`
- [ ] **Phase 1 — baseline (commit #1, against current code):** enable the solc
      `storageLayout` output (`outputSelection`), dump the layout of every storage
      struct, and write it to a committed `storage-layout.baseline.json`. This is
      the characterization snapshot — it records exactly where every field lives
      *today*.
- [ ] **Phase 2 — final snapshot (after the migration):** re-dump; the test asserts
      every field's slot + byte-offset against the committed *final* snapshot. The
      diff between baseline and final is reviewed in the PR — every moved slot must
      be explained by GAS-004 / the peel / the 7201 formula, nothing unexpected.
      The final snapshot becomes the permanent CI regression gate (ARCH-05).
- [ ] **Namespace-distinctness assertion:** the EIP-7201-derived slots for
      `AppStorage`, `LibSettlementStorage`, `AdminConfigStorage`,
      `AccessControlStorage`, and the Diamond slot are all distinct.

Behavior characterization:
- [ ] `Condition` round-trip — `prepareCondition` / `resolveCondition` produce and
      read identical values before and after the migration (the `Condition` struct
      is unchanged — see GAS-004 void above).
- [ ] Regression over every peeled-storage consumer: admin config get/set
      (`feeReceiver`, `maxFeeRateBps`, `resolutionFeeBps`, `unitPerPair`, collateral
      allow-list), market-maker add/remove, settlement fee validation — all return
      the same values through the new namespace.

## DoD
Final storage snapshot committed and asserted; baseline→final diff fully explained
in the PR; namespace distinctness asserted; full suite green; `size-contracts` clean.

---

# Task C — Gas hot-path pass

**Title:** `Gas hot-path optimization pass`
**Branch:** `feature/SCRUM-XXX-Gas-Hot-Path-Pass`
**upgrade-safe:** yes — bytecode / internal refactor only.
**Effort:** low–M
**Run last** (B → A → C) — independent, do it on the settled code.

## Scope (group G6 + INFO-2)

- [ ] **GAS-001** — `hardhat.config.js` optimizer `runs: 1` → `runs: 200`.
      Benchmark with `REPORT_GAS=true`; if any facet crosses ~23 KiB, add a
      per-contract override (`SettlementFacet` has ~10 KiB headroom).
- [ ] **GAS-002** — precompute `keccak256("Doefin Exchange")` and `keccak256("3")`
      as `bytes32 constant` in `LibDoefinOrder`; `diamondDomainSeparator` uses the
      constants instead of hashing string memory each call.
- [ ] **GAS-003** — hoist `maxFeeRateBps` alongside `feeReceiver` in `matchOrders`
      (and `fillOrder`); thread it into `_validateFee` as a parameter.
- [ ] **GAS-006** — wrap the 4 settlement collateral multiplications
      (`SettlementFacet` ~551, 604, 697, 750) in `unchecked` with an inline
      invariant comment (`price <= unit`, enforced by `_validateOrder`).
- [ ] **GAS-007** — `unchecked { ++i; }` for the ~9 loop counters in
      `NonceManagerFacet.cancelOrders`, `LibERC1155`, `LibPositionRegistry`,
      `LibCTFCondition`.
- [ ] **INFO-2** — remove the doubled NatSpec blocks in `OracleAdapterFacet`.

## Characterization / gas tests

File: `test/gas/hot-path-gas.test.js`
- [ ] **Baseline (commit #1):** capture `matchOrders` / `fillOrder` / `prepareCondition`
      gas with `REPORT_GAS=true` on the pre-change code; record it in the ticket.
- [ ] After each change, re-measure; the ticket records the per-call delta. No
      regression — every settlement scenario costs ≤ baseline.
- [ ] **GAS-006 safety test** — an order with `pricePerToken > unit` is rejected by
      `_validateOrder` (BIZ-004) *before* any `unchecked` multiply site is reached,
      proving those sites can never see an overflowing input.
- [ ] Behavior characterization: the full settlement suite (complementary / mint /
      merge / mixed match-types / fee at cap / fee over cap) passes unchanged — the
      optimizer and `unchecked` changes alter cost, never results.

## DoD
Gas deltas recorded; no behavior change (full suite green); `size-contracts` clean
after the `runs: 200` change.

---

## Out of scope / no action

Confirmed sound by the review, no task: the EIP-2535 Diamond assembly, the
`DiamondInit` one-shot guard, the standard facets and selector router (ARCH-11); the
`LibDoefinOrder` / `LibSignature` / `LibOrderValidity` settlement-library layering
(ARCH-12); the completed `Events.sol` / `Errors.sol` fee cleanup (ARCH-14);
`MarketDataFacet` as a read-only facet (ARCH-15); GAS-008 / GAS-009 (caching already
correct); CPX-005 (`LibDoefinOrder` memory variants — intentional API, keep). CPX-006a
(drop the Bitcoin-oracle structs from `AppStorage`) is **moot** — `deploy.js` ships
both oracle facets, so those structs are live. ARCH-08 (`audit/00-scope.md` phantom
contracts) is an open documentation item — see the note near the top of this file.
