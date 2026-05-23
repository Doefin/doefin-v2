# Doefin v3 — Phase-2 In-Depth Review: Consolidated Findings Ledger

**Scope:** production v3 contract surface (15 facets, 18 libraries, 16 interfaces,
`Diamond.sol`, `DiamondInit.sol`). `contracts/mock/` and `contracts/audit/` excluded.
**Code state:** post-SCRUM-223/224/226, branch `v3/dev` @ `a6491c8`.
**Passes:** `sc-complexity-analyst` · `sc-gas-optimizer` · `sc-architecture-reviewer`.
Detailed findings: `complexity-findings.md`, `gas-findings.md`, `architecture-findings.md`.

This ledger de-duplicates the three passes, normalizes severity across them, and proposes
a remediation grouping for triage. **No code has been changed.**

## Headline

The v3 settlement core is in good shape — the architecture pass confirms the EIP-2535
assembly, the `DiamondInit` one-shot guard, and the `LibDoefinOrder`/`LibSignature`/
`LibOrderValidity` settlement-library layer are all sound; the complexity pass confirms
`SettlementFacet` itself is well-decomposed (the 873 LOC is mostly NatSpec). No
security-grade defects — this was a quality/gas/structure review, and the prior security
audit is separate.

The actionable findings cluster into: **two High architecture items**, a **storage-
architecture cluster**, a **dead-code sweep**, **one real duplication**, and a **gas
hot-path pass**.

## ⏰ Time-critical axis — `upgrade-safe: no` items

These change the function-selector set or the storage layout. v3 mainnet is a **fresh
deploy**, so they are **free if done before the deploy** and become costly `diamondCut` +
storage-migration operations after. They gate the deploy, not the audit handoff:

| Finding | What | Effort |
|---|---|---|
| ARCH-01 | Extract owner-governance (`setOperator`/`pauseTrading`/`unpauseTrading`) out of `SettlementFacet` → `SettlementAdminFacet` | S |
| GAS-004 | Reorder `Condition` struct fields — 6 storage slots → 4 (~40k gas saved per condition) | low |
| ARCH-03 | Peel `AdminConfigStorage`/`AccessControlStorage` out of the monolithic `AppStorage` into namespaces | M |
| ARCH-04 | *If* adopting the real EIP-7201 slot formula — the namespace slots move | M |
| ARCH-07 | *If* moving `registerOrderSigner` to an order-lifecycle facet | S |
| CPX-006a | *If* the oracle facets are not cut — drop their structs from `AppStorage` | S |

Everything else is `upgrade-safe: yes` — can land any time, but should be in before the
audit handoff so auditors review the final code.

## Master ledger (de-duplicated, ranked)

| ID(s) | Sev | Theme | upgrade-safe | Effort | Summary |
|---|---|---|---|---|---|
| ARCH-01 | **High** | architecture | no | S | `SettlementFacet` mixes owner-only governance with the operator hot path — extract `SettlementAdminFacet` |
| ARCH-02 | **High** | architecture | yes | M | Three unreconciled access-control mechanisms; `AccessControlFacet.addMarketMaker`'s only gate is hidden inside a library setter — standardize on `LibDiamond.enforceIsContractOwner`, make every gate visible |
| ARCH-03 | Med | storage | no/yes | M | `AppStorage` monolith vs `LibSettlementStorage` namespace is an undocumented hybrid — document the rule; peel the two in-scope sub-structs into namespaces |
| ARCH-04 | Med | storage | no/yes | S–M | `CLAUDE.md` says "EIP-7201" but the code uses plain `keccak256` slots, no `@custom:storage-location`, no `& ~0xff` mask — decide and make doc==code |
| ARCH-05 | Med | storage | yes | S | `AppStorage.__gap` sizes are hand-maintained, unverifiable (`AdminConfigStorage [12]` post-SCRUM-224 unprovable by inspection) — add a `storageLayout` snapshot CI test |
| ARCH-06 | Med | architecture | yes | S | `LibAccessControl` is a half-migrated v2 grab-bag (owner check + market-maker + collateral allow-list) — slim to the market-maker role only |
| CPX-001 | Med | duplication | yes | S | `_verifySignature` EOA/EIP-1271 dispatch wrapper still duplicated verbatim in `SettlementFacet` + `SignatureVerifierFacet` — promote to `LibSignature.verifyOrderSignature` |
| CPX-002 | Med | dead code | yes | S | ~10 zero-reference custom errors in `Errors.sol` + an empty "FEE MANAGEMENT ERRORS" header + a mock-only error block in a production library |
| CPX-003 / ARCH-10 | Med | dead code | yes | S | Dead `internal` functions — `SettlementFacet._getIndexSet` (superseded by `_getIndexSetIn`) and three uncalled `LibReentrancyGuard` members |
| GAS-001 | Med | gas | yes | low | `optimizer runs: 1` is wrong for a constantly-called settlement contract — ~300–1000 gas/`matchOrders`; `SettlementFacet` has 10.3 KiB headroom for `runs: 200` |
| GAS-002 | Med | gas | yes | low | `diamondDomainSeparator` re-`keccak256`s the constant strings `"Doefin Exchange"`/`"3"` every call — precompute as `bytes32 constant` (~150–200 gas/call) |
| GAS-004 | Med | gas/storage | no | low | `Condition` struct field order wastes 2 storage slots — reorder (~40k gas per condition created) |
| CPX-004 | Low | dead code | yes | XS | `LibSignature.recoverMemory` has zero callers — dead, never-fuzzed assembly in a crypto library |
| CPX-006b | Low | docs | yes | S | `DiamondInit.init` NatSpec mixes current + pre-SCRUM-224 fee language |
| CPX-008 | Low | consistency | yes | XS | `matchOrders` reverts `MismatchedInputLengths` for a fill-sum mismatch (not a length mismatch) — add a dedicated `FillAmountMismatch` error |
| GAS-003 | Low | gas | yes | M | `_validateFee` re-reads `maxFeeRateBps` per call — hoist alongside `feeReceiver` (~up to 500 gas / multi-maker `matchOrders`) |
| GAS-005 | Low | gas/dead code | yes | XS | `_nonReentrantBefore` runs a dead "init on first use" check every call — `DiamondInit` already sets `_status = 1` |
| GAS-006 | Low | gas | yes | low | 4 settlement collateral multiplications not `unchecked` though provably safe under `price <= unit` (~120–160 gas/call) |
| GAS-007 / CPX-007 | Low | gas | yes | low | ~9 loops (`cancelOrders`, `LibERC1155`, `LibPositionRegistry`, `LibCTFCondition`) use checked `++i` — switch to `unchecked` |
| ARCH-07 | Low | architecture | no | S | `registerOrderSigner` is the lone state-mutating fn in the otherwise pure-view `SignatureVerifierFacet` — move to an order-lifecycle facet (judgment call) |
| ARCH-08 | Low | docs | yes | S | `audit/00-scope.md:16` names non-existent `OracleManagerFacet`/`BlockScholesOracleAdapter` — auditors will hunt phantom contracts. **(`.claude/CLAUDE.md` is already clean — verified; ARCH-08's CLAUDE.md claim is a false positive.)** |
| ARCH-09 | Low | interface | yes | S | `ISettlement` bundles operator hot-path + owner governance — split into `ISettlement` + `ISettlementAdmin` (pairs with ARCH-01) |
| ARCH-13 | Info | dead code | yes | S | `LibReentrancyGuard.nonReentrant` library modifier is dead (libraries can't export modifiers) and misleading — delete (part of the CPX-003 cluster) |
| CPX-006a | Low | storage | no | S | `AppStorage` permanently embeds the Bitcoin oracle sub-structs — removable only if those facets aren't cut (scoping question) |

**No-action / confirmed sound:** ARCH-11 (EIP-2535 assembly, `DiamondInit` one-shot,
standard facets, selector router), ARCH-12 (`LibDoefinOrder`/`LibSignature`/
`LibOrderValidity` layering), ARCH-14 (`Events.sol`/`Errors.sol` fee cleanup complete),
ARCH-15 (`MarketDataFacet`), GAS-008/009 (caching already correct), CPX-005
(`LibDoefinOrder` memory variants — intentional API). Cosmetic nits (doubled NatSpec in
`MarketData`/`OracleAdapter` facets, magic-number `10000`, the `OrdersMatched` NatSpec
that says match-type `0/1/2` but the code emits `1/2/3` — a decoding-bug trap worth
fixing) are listed in the per-pass files' appendices.

## Cross-pass de-duplication notes

- `SettlementFacet._getIndexSet` dead — flagged by **both** CPX-003 and ARCH-10. One item.
- `LibReentrancyGuard` — three passes touch it: CPX-003 (dead `_initReentrancyGuard`/
  `_isEntered`/modifier), ARCH-13 (the modifier specifically), GAS-005 (the dead init
  check in `_nonReentrantBefore`). One remediation: a `LibReentrancyGuard` cleanup.
- Loop `unchecked` — CPX-007 (consistency lens) and GAS-007 (gas lens) flag the same
  `cancelOrders` loop; GAS-007 is broader (9 loops). One item.
- `AppStorage` oracle bloat — CPX-006a and ARCH-03 both touch it; ARCH-03 is the broader
  storage-architecture finding.

## Proposed remediation grouping (for triage)

Eight candidate tickets. **T-A and T-B are pre-deploy-gated** (`upgrade-safe: no`); the
rest are `upgrade-safe: yes` — do them before the audit handoff.

| Ticket | Findings | Pre-deploy? | Effort |
|---|---|---|---|
| **T-A — Facet restructure** | ARCH-01 (+ ARCH-09 interface split; ARCH-07 optional) | **Yes — `upgrade-safe: no`** | S–M |
| **T-B — Storage-layout finalization** | GAS-004 (`Condition` reorder), ARCH-03 (peel sub-structs), ARCH-04 (EIP-7201 decision), CPX-006a | **Yes — `upgrade-safe: no`** | M |
| **T-C — Access-control unification** | ARCH-02, ARCH-06 | no | M |
| **T-D — Dead-code sweep** | CPX-002, CPX-003/ARCH-10, CPX-004, ARCH-13, GAS-005 | no | S |
| **T-E — Signature-wrapper dedup** | CPX-001 | no | S |
| **T-F — Gas hot-path pass** | GAS-001, GAS-002, GAS-003, GAS-006, GAS-007 | no | low–M |
| **T-G — Storage-layout snapshot test** | ARCH-05 (CI gate) | no | S |
| **T-H — Docs & cosmetics** | ARCH-08, CPX-006b, CPX-008, the NatSpec nits | no | S |

**One genuine decision in triage:** ARCH-04 — adopt the real EIP-7201 slot formula
(slots move, pre-deploy-only, kills the hand-sized `__gap` hazard) **or** keep plain-
`keccak256` + `__gap` and correct `CLAUDE.md` to say so. The first is the better long-term
posture; the second is near-zero effort.

## Next step

Triage this ledger with the user — decide which tickets are in scope, especially the
pre-deploy-gated T-A/T-B. Agreed items become remediation tickets (one concern each).
"Leave it, documented" is a valid outcome for any finding.
