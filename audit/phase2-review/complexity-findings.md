# Doefin v3 — Phase-2 Complexity & Maintainability Findings (Domain 4)

domain: complexity
scope: contracts/facets (15), contracts/libraries (18), contracts/interfaces (16),
       contracts/Diamond.sol, contracts/upgradeInitializers/DiamondInit.sol
excluded: contracts/mock/*, contracts/audit/DoefinInvariantHarness.sol
reviewer: sc-complexity-analyst
note: Complexity findings cap at MEDIUM per the severity rubric. v3 mainnet is a
      fresh deploy, so every `upgrade-safe: no` item is free if applied pre-deploy.

## Summary

| Severity | Count |
|----------|-------|
| MEDIUM   | 3     |
| LOW      | 5     |
| INFO     | 6 (appendix) |

Headline: the v3 settlement core is in good shape. The prior-review duplications
flagged in the regression checklist (REMAINING-1 `_verifySignature`, REMAINING-2
`ProtocolFeesWithdrawn`, REMAINING-3 `setTradingFeesBps`) are **resolved** — see the
regression notes at the end. The remaining work is dead-code removal and one
genuine residual duplication (`_verifySignature` wrapper, CPX-001) plus a verbose
v2.0-era struct/error surface that survives in shared libraries.

## Highest-impact items (read these first)

1. **CPX-001** — `_verifySignature` is still byte-for-byte duplicated between
   `SettlementFacet` and `SignatureVerifierFacet`. `LibSignature` centralized the
   *primitives* but not the EOA/EIP-1271 *dispatch wrapper*. The two copies are
   security-relevant and can drift. MEDIUM.
2. **CPX-002** — ~12 zero-reference custom errors and one orphaned `Errors.sol`
   section header. Dead surface in a shared, in-scope library. MEDIUM.
3. **CPX-003** — `SettlementFacet._getIndexSet` is a fully dead `internal` function
   superseded by `_getIndexSetIn`; `LibReentrancyGuard._initReentrancyGuard`,
   `_isEntered`, and the library `nonReentrant` modifier are all uncalled. MEDIUM.
4. **CPX-004** — `LibSignature.recoverMemory` has zero callers in the entire repo
   (production, mock, and harness). LOW.
5. **CPX-006** — v2.0/cross-currency-era residue in `LibDoefinStorage`: the four
   Bitcoin question structs and `OracleAdapterStorage` are still part of the
   permanent `AppStorage` layout, and `DiamondInit` NatSpec is stale. LOW.

---

## CPX-001: `_verifySignature` duplicated across SettlementFacet and SignatureVerifierFacet

id:             CPX-001
domain:         complexity
severity:       medium
status:         new
location:       contracts/facets/SettlementFacet.sol:345-371 ; contracts/facets/SignatureVerifierFacet.sol:126-155
source:         complexity
regression-of:  REMAINING-1 (partially open)
title:          Duplicate EOA/EIP-1271 signature-dispatch wrapper in two facets
description:
  REMAINING-1 from the SC-008 review is only *partially* resolved. `LibSignature`
  now centralizes the cryptographic primitives — `recoverCalldata`, `verifyEIP1271`,
  `_recover` with the low-`s` malleability check and `v` normalization — and both
  facets correctly route through it. But the higher-level *dispatch wrapper*
  `_verifySignature(order, orderHash, signature, signatureType)` — which decides
  EOA-vs-EIP-1271, enforces `signer == maker` for type 0, consults
  `registeredOrderSigners` for type 1, and rejects any `signatureType > 1` — is
  still implemented twice, essentially verbatim:
    - `SettlementFacet.sol:345-371`
    - `SignatureVerifierFacet.sol:126-155`
  The bodies differ only in incidental comment text. Both read
  `LibSettlementStorage.settlementStorage()` and the same `registeredOrderSigners`
  map, so the logic is not facet-specific — it is shared protocol policy that
  happens to live in two places.
impact:
  Maintainability + latent security: a future change to the signature-acceptance
  policy (e.g. adding a `signatureType == 2`, or tightening the registered-signer
  rule) must be made in two files. If only one is updated, `SettlementFacet`
  (the value-moving path) and `SignatureVerifierFacet.verifyOrderSignature` (the
  off-chain orderbook's pre-check) would disagree on whether an order is signable
  — an order the orderbook accepts could revert at settlement, or worse, vice
  versa. The crypto primitives were consolidated for exactly this reason; the
  wrapper deserves the same treatment.
poc:
  Diff `SettlementFacet.sol:345-371` against `SignatureVerifierFacet.sol:126-155`
  — the control flow, storage reads, and revert conditions are identical.
recommendation:
  Promote the dispatch wrapper into `LibSignature` (or a thin `LibOrderSignature`):

    // LibSignature.sol
    function verifyOrderSignature(
        LibDoefinOrder.DoefinOrder calldata order,
        bytes32 orderHash,
        bytes calldata signature,
        uint8 signatureType
    ) internal view {
        address recovered = recoverCalldata(orderHash, signature);
        if (recovered == address(0) || recovered != order.signer)
            revert Errors.InvalidOrderSignature(orderHash);
        if (signatureType == 0) {
            if (order.signer != order.maker)
                revert Errors.InvalidOrderSignature(orderHash);
        } else if (signatureType == 1) {
            LibSettlementStorage.SettlementStorage storage ss =
                LibSettlementStorage.settlementStorage();
            if (!ss.registeredOrderSigners[order.maker][order.signer]) {
                if (!verifyEIP1271(order.maker, orderHash, signature))
                    revert Errors.InvalidOrderSignature(orderHash);
            }
        } else {
            revert Errors.InvalidOrderSignature(orderHash);
        }
    }

  Then both facets call `LibSignature.verifyOrderSignature(...)` and delete their
  private `_verifySignature`. (`LibSignature` would gain imports of
  `LibDoefinOrder` and `LibSettlementStorage`, which is acceptable for a
  protocol-specific helper.)
upgrade-safe:   yes
  Internal-library refactor. `_verifySignature` is `internal` in both facets —
  removing it changes no external selector and touches no storage layout. The
  external selector sets of both facets are unchanged.
effort:         S (≈1 hr incl. test confirmation that both facets still verify)

---

## CPX-002: ~12 zero-reference custom errors and a stale section header in Errors.sol

id:             CPX-002
domain:         complexity
severity:       medium
status:         new
location:       contracts/libraries/Errors.sol (multiple) ; lines 132-135 ; 207-228 ; 248-258
source:         complexity
regression-of:  -
title:          Dead error declarations in the shared, in-scope Errors library
description:
  A repo-wide scan of every `revert Errors.<Name>` site (production code only)
  shows the following errors are declared in `Errors.sol` but have **zero revert
  sites anywhere in `contracts/`**:

    Confirmed dead (no revert site, in scope or excluded):
      - InvalidTimestamp        (Errors.sol:209)  "SIGNATURE ERRORS" section
      - SignatureExpired        (Errors.sol:212)
      - InvalidSignature        (Errors.sol:215)  — note: LibSignature reverts
                                 InvalidSignatureLength, never InvalidSignature
      - ArithmeticOverflow      (Errors.sol:274)
      - ArithmeticUnderflow     (Errors.sol:277)
      - TooManyOutcomeSlots     (Errors.sol:105)
      - NotOwner                (Errors.sol:329)  "MOCK CONTRACT ERRORS"
      - InvalidAddress          (Errors.sol:332)  "MOCK CONTRACT ERRORS"
      - NotPendingOwner         (Errors.sol:335)  "MOCK CONTRACT ERRORS"
      - OracleAdapter_QuestionAlreadyExists (Errors.sol:249)

  Additionally:
      - Errors.sol:132-135 — a "FEE MANAGEMENT ERRORS" section header with an
        empty body (every fee error under it was deleted in the SCRUM-224 fee
        rework). The header is now a misleading comment.
      - Errors.sol:325-329 — a "MOCK CONTRACT ERRORS" section: `NotOwner`,
        `InvalidAddress`, `NotPendingOwner` are declared for mock contracts only.
        Mocks are explicitly out of scope; a production-shipped shared library
        should not carry mock-only declarations. (If mocks still revert these,
        confirm — the scan found no `revert` for them even inside `contracts/mock`.)

  Note on what is NOT dead (do not remove): `MismatchedInputLengths`,
  `InvalidPrice`, `InvalidUnitPerPair`, `TokenNotAllowed`, `InvalidPositionId`,
  `InvalidComplement`, `PositionNotFound`, `CollateralNotAligned`,
  `BlockHeaderOracle_*`, and all other `OracleAdapter_*` errors all have live
  revert sites — several only in *excluded* files (CTF / block-header-v1 /
  oracle-adapter), but those files still ship, so the errors are reachable and
  must stay.
impact:
  Each declared error costs nothing at runtime but inflates the bytecode of
  every facet/library that imports `Errors` (the selector tables and metadata
  grow), clutters the ABI surface an external auditor must reason about, and —
  in the case of `InvalidSignature` vs `InvalidSignatureLength` — invites a
  future contributor to revert the wrong, never-tested error. The empty
  "FEE MANAGEMENT ERRORS" header actively misleads a reader into thinking fee
  errors live there.
poc:
  `grep -rn 'Errors\.InvalidTimestamp\|Errors\.SignatureExpired\|...' contracts/`
  returns no matches for the ten names above.
recommendation:
  - Delete the ten zero-reference error declarations.
  - Delete the empty "FEE MANAGEMENT ERRORS" header (lines 132-135).
  - Delete the "MOCK CONTRACT ERRORS" section (lines 325-336) — or, if a mock
    genuinely needs them, move those declarations into the mock that uses them
    so the shared production library stays clean. (Mocks are out of scope, so
    confirm with `sc-developer` before deleting if a mock imports them.)
  - Before deleting, re-run the grep against `test/` as well: a Hardhat test
    may `revertedWithCustomError(..., "InvalidSignature")`. If a test references
    a name, that is itself a bug (the test asserts an error the contract can
    never emit) and should be flagged to `sc-business-logic`, not a reason to
    keep the declaration.
upgrade-safe:   yes
  Removing an unused error declaration changes no storage layout and no function
  selector. Custom-error selectors are not part of the Diamond's function-
  selector set. Pure source-surface reduction.
effort:         S (≈30 min; the grep is the work, the deletion is trivial)

---

## CPX-003: Dead internal functions — SettlementFacet._getIndexSet and three LibReentrancyGuard members

id:             CPX-003
domain:         complexity
severity:       medium
status:         new
location:       contracts/facets/SettlementFacet.sol:848-850 ;
                contracts/libraries/LibReentrancyGuard.sol:22-27,62-65,81-85
source:         complexity
regression-of:  -
title:          Unreachable internal helpers in SettlementFacet and LibReentrancyGuard
description:
  Two independent dead-code clusters, both confirmed by a full-repo caller scan:

  (a) `SettlementFacet._getIndexSet(bytes32)` — `SettlementFacet.sol:848-850`.
      This is the "resolve namespace internally" variant. The settlement hot
      path was refactored (CPX-007, per its own NatSpec) to call
      `_getIndexSetIn(positionId, ds)` everywhere with a caller-resolved
      `AppStorage` pointer, precisely to avoid re-resolving the namespace.
      `_getIndexSet` is the leftover wrapper from before that refactor and has
      **zero callers** — `_conditionAndPartition` (the only consumer of index
      sets) calls `_getIndexSetIn` directly. It is `internal`, so it does not
      even appear in the ABI; it is pure dead weight.

  (b) `LibReentrancyGuard` carries three uncalled members:
      - `_initReentrancyGuard()` (lines 22-27) — zero callers. Reentrancy
        storage is initialized by `LibDoefinStorage.initialize` setting
        `_status = 1`, and `_nonReentrantBefore` also lazily initializes the
        `_status == 0` case, so this function is redundant and unused.
      - `_isEntered()` (lines 62-65) — zero callers.
      - the `nonReentrant` library `modifier` (lines 81-85) — unused; its own
        NatSpec admits "Library modifiers cannot be imported or used directly
        by contracts" and `SettlementFacet` copies its own `nonReentrant`
        modifier (SettlementFacet.sol:49-53) calling the `_before`/`_after`
        pair manually. The library modifier is documentation-by-example that
        ships as bytecode.
impact:
  `_getIndexSet` and the `LibReentrancyGuard` extras are dead surface an
  external auditor must still read and reason about ("is this reachable? does
  it bypass a guard?"). `LibReentrancyGuard` is an in-scope library; a
  reentrancy-protection library that ships three unused entry points invites a
  reviewer to wonder whether one of them is a back door. Removing them shrinks
  the attack-surface narrative to exactly the two functions
  (`_nonReentrantBefore`/`_nonReentrantAfter`) that are actually load-bearing.
poc:
  `grep -rn '_getIndexSet\b' contracts/` → only the definition + a NatSpec
  cross-reference. `grep -rn '_initReentrancyGuard\|_isEntered\|LibReentrancyGuard.nonReentrant' contracts/`
  → only the definitions.
recommendation:
  - Delete `SettlementFacet._getIndexSet` (lines 848-850) and fix the dangling
    `{_getIndexSet}` NatSpec reference at `SettlementFacet.sol:853` to point at
    `_getIndexSetIn` directly.
  - Delete `LibReentrancyGuard._initReentrancyGuard`, `_isEntered`, and the
    `nonReentrant` modifier. Keep only `_nonReentrantBefore` /
    `_nonReentrantAfter` and the two `_NOT_ENTERED` / `_ENTERED` constants.
    Move the "how to use this in a facet" guidance from the deleted modifier's
    NatSpec onto `_nonReentrantBefore` so the usage note is not lost.
upgrade-safe:   yes
  All four removals are `internal` library/facet functions or a library modifier
  — none is an external selector, none touches storage layout. The
  `ReentrancyStorage` struct itself is untouched, so the `_status` slot is
  preserved.
effort:         S (≈30 min)

---

## CPX-004: LibSignature.recoverMemory has zero callers

id:             CPX-004
domain:         complexity
severity:       low
status:         new
location:       contracts/libraries/LibSignature.sol:57-70
source:         complexity
regression-of:  -
title:          Unused memory-variant signature recovery in LibSignature
description:
  `LibSignature` exposes two recovery entry points: `recoverCalldata` (used by
  both `SettlementFacet` and `SignatureVerifierFacet` via the `_verifySignature`
  wrappers) and `recoverMemory`. A full-repo scan finds **zero callers** of
  `recoverMemory` — not in production facets, not in `contracts/mock`, not in
  `DoefinInvariantHarness`. `verifyEIP1271` takes `bytes memory` but does its
  own `IERC1271` dispatch and never calls `recoverMemory`.
impact:
  Minor. `recoverMemory` contains its own inline-assembly block (lines 63-68)
  duplicating the `recoverCalldata` assembly with different offset arithmetic.
  An assembly block that is never exercised by any test is a latent
  liability — if a future caller adopts it, it has never been fuzzed. Dead
  assembly in a security-critical library is worse than dead high-level code.
poc:
  `grep -rn 'recoverMemory' contracts/ test/` → only the definition.
recommendation:
  Delete `recoverMemory` (lines 57-70). If a memory-variant is wanted as a
  forward-looking API surface, that is a judgement call for `sc-developer` — but
  an un-exercised assembly path should not ship to mainnet "just in case".
  Prefer deletion; re-add it with tests if a caller ever materializes.
upgrade-safe:   yes
  `internal` library function, no selector, no storage.
effort:         XS (≈10 min)

---

## CPX-005: LibDoefinOrder memory hashing variants are production-dead (test-only)

id:             CPX-005
domain:         complexity
severity:       low
status:         new
location:       contracts/libraries/LibDoefinOrder.sol:71-87 (hash), 95-110 (domainSeparator),
                126-137 (hashOrder)
source:         complexity
regression-of:  -
title:          Memory-variant order-hashing helpers unused by production facets
description:
  `LibDoefinOrder` provides paired memory/calldata hashing helpers. All three
  production v3 facets (`SettlementFacet`, `SignatureVerifierFacet`,
  `NonceManagerFacet`) use only the calldata variants — `hashCalldata`,
  `hashOrderCalldata` — plus `diamondDomainSeparator`. The memory variants
  `hash`, `hashOrder`, and the parameterized `domainSeparator(name,version,...)`
  are referenced **only** by `contracts/mock/DoefinOrderHarness.sol` and
  `contracts/audit/DoefinInvariantHarness.sol` — both out of scope.
impact:
  Low and arguably intentional: `domainSeparator` is the building block that
  `diamondDomainSeparator` itself calls, so it cannot be removed. `hash` is
  called by `hashOrder`. The genuinely orphaned-from-production member is
  `hashOrder` (the memory full-hash). This is more an observation than a defect
  — the library is a deliberately reusable EIP-712 toolkit and the harnesses are
  legitimate consumers. Flagged so triage can confirm it is intentional rather
  than silently dropping it.
poc:
  `grep -rn 'LibDoefinOrder.hashOrder\b' contracts/` → only the two harnesses.
recommendation:
  No production change required. Either (a) accept as intentional library API
  and add a one-line NatSpec note that `hash`/`hashOrder` exist for off-chain /
  harness EIP-712 reconstruction, or (b) if the team wants a minimal surface,
  move `hashOrder` next to the harness. Recommendation: option (a) — keep,
  document. Do NOT remove `hash` or `domainSeparator` (both are internal
  dependencies of the live calldata path).
upgrade-safe:   yes (no change, or internal-only)
effort:         XS (≈10 min, doc-only)

---

## CPX-006: v2.0 / Bitcoin-oracle residue in the permanent AppStorage layout and stale DiamondInit NatSpec

id:             CPX-006
domain:         complexity
severity:       low
status:         new
location:       contracts/libraries/LibDoefinStorage.sol:23-94,182-205 ;
                contracts/upgradeInitializers/DiamondInit.sol:47-57
source:         complexity
regression-of:  -
title:          Question structs / OracleAdapterStorage and stale init NatSpec carried into v3
description:
  Two observations on residual surface, both informational-grade but worth a
  pre-deploy decision:

  (a) `LibDoefinStorage` still carries the four Bitcoin question structs
      (`DifficultyThresholdQuestion`, `DifficultyRangeQuestion`,
      `BlockCountQuestion`, `MiningDurationQuestion`), the `QuestionType` enum,
      the `OracleAdapterStorage` struct, and `BlockHeaderOracleStorage` /
      `BlockHeader`. These are consumed only by the excluded block-header-v1 and
      oracle-adapter facets — which still ship — so the structs are reachable
      and CANNOT simply be deleted. The point: `AppStorage` (LibDoefinStorage.sol
      :197-207) embeds `blockHeaderOracleStorage` and `oracleAdapterStorage` as
      permanent members of the v3 storage root. For a *fresh* mainnet deploy
      this is harmless (the slots are simply unused if those facets are not
      cut), but it bloats the canonical storage layout an auditor must map and
      couples the v3 storage struct to v1/v2 oracle subsystems.

  (b) `DiamondInit.init` NatSpec is stale: line 53 says
      "Initializes protocol fees: 5% resolution" and the older "trading fees"
      framing — fine — but the `@custom:fees` / surrounding comment still reads
      as if there were a global settlement fee. The body is correct (SCRUM-224
      operator-supplied fee, `maxFeeRateBps` default 0). The header comment block
      at lines 47-57 mixes accurate and pre-SCRUM-224 language; a reader cannot
      tell which is current without reading the body.
impact:
  Documentation/clarity. No runtime cost on a fresh deploy. The risk is purely
  reviewer-time: an external auditor sees `oracleAdapterStorage` inside the v3
  `AppStorage` and must chase down whether settlement touches it (it does not).
poc:
  Inspect `AppStorage` at LibDoefinStorage.sol:197-207 — `blockHeaderOracleStorage`
  and `oracleAdapterStorage` are members 7 and 8.
recommendation:
  - (a) No safe code change for a Diamond that still cuts the oracle/block-header
    facets — leave the structs. If the mainnet deploy does NOT cut those facets,
    raise this with `sc-developer`/orchestrator: the structs (and their errors,
    see CPX-002) could then be fully removed, materially shrinking `AppStorage`.
    Treat this as a scoping question, not an edit.
  - (b) Rewrite the `DiamondInit.init` NatSpec block (lines 47-57) to state
    plainly: ownership + `resolutionFeeBps = 500` for CTF redemption; settlement
    fees are operator-supplied and bounded by `maxFeeRateBps` (default 0).
    Remove any "trading fees" phrasing.
upgrade-safe:   no (for storage-struct removal in the future) / yes (for the NatSpec fix)
  The NatSpec fix is upgrade-safe. Any future removal of `oracleAdapterStorage` /
  `blockHeaderOracleStorage` from `AppStorage` IS a storage-layout change — free
  on a fresh deploy, breaking on a `diamondCut` upgrade. Tag the struct-removal
  branch `upgrade-safe: no` and gate it on the fresh-deploy confirmation.
effort:         S (NatSpec rewrite ≈20 min; the struct-removal is a separate
                scoping decision, not estimated here)

---

## CPX-007: NonceManagerFacet.cancelOrders lacks the unchecked-increment pattern used elsewhere

id:             CPX-007
domain:         complexity
severity:       low
status:         new
location:       contracts/facets/NonceManagerFacet.sol:82-96
source:         complexity
regression-of:  -
title:          Loop-style inconsistency between cancelOrders and the settlement loops
description:
  `NonceManagerFacet.cancelOrders` iterates with `for (uint256 i; i < orders.length; ++i)`
  — re-reading `orders.length` each iteration and using a checked `++i`.
  `SettlementFacet.matchOrders` (line 133) and `_getIndexSetIn` (line 865) both
  use the established codebase pattern: hoist the length into a local and
  `unchecked { ++i; }`. This is primarily a *consistency* finding, not a gas
  finding (gas is sc-gas-optimizer's domain) — three loops over calldata arrays,
  two written one way and one written another, in code an auditor reads
  side-by-side.
impact:
  Minor. A reviewer comparing the two facets has to confirm the divergence is
  not semantically meaningful (it is not). Consistency lowers review cost.
recommendation:
  Align `cancelOrders` with the house style:

    uint256 len = orders.length;
    for (uint256 i; i < len;) {
        ...
        unchecked { ++i; }
    }

  If sc-gas-optimizer has already filed this as a gas item, defer to that
  finding and mark this a duplicate.
upgrade-safe:   yes
  Loop-body refactor inside one external function; no selector or storage change.
effort:         XS (≈10 min)

---

## CPX-008: matchOrders reuses MismatchedInputLengths for a non-length aggregate-fill failure

id:             CPX-008
domain:         complexity
severity:       low
status:         new
location:       contracts/facets/SettlementFacet.sol:154-155
source:         complexity
regression-of:  -
title:          Semantically wrong error name on the totalMakerFill consistency check
description:
  `matchOrders` ends with a router-input invariant check
  (`SettlementFacet.sol:154-155`):
      if (totalMakerFill != takerFillAmount) revert Errors.MismatchedInputLengths();
  `totalMakerFill` is the *sum of fill amounts*, not an array length.
  `MismatchedInputLengths` is the error used (correctly) at line 101 for the
  actual array-length mismatch. Reusing it here for a value-sum mismatch means
  two structurally different failure modes revert with the same selector — an
  off-chain operator decoding the revert cannot tell whether it passed
  mis-sized arrays or arrays whose fill amounts simply do not sum.
impact:
  Operability/clarity. The contract is correct; the diagnostic is ambiguous.
  This is a maintainability finding (clear error taxonomy), not a security bug.
  The NatSpec at SettlementFacet.sol:77-79 lists `MismatchedInputLengths` once,
  reinforcing the conflation.
recommendation:
  Introduce a dedicated error — e.g. `error FillAmountMismatch(uint128 sumOfMakerFills,
  uint128 takerFillAmount);` — in `Errors.sol` and revert it at line 155. Update
  the `matchOrders` `@custom:reverts` NatSpec. This pairs naturally with CPX-002
  (you are already editing `Errors.sol`).
upgrade-safe:   yes
  Adding an error and changing which error a revert path emits does not affect
  storage layout or the function-selector set.
effort:         XS (≈15 min)

---

## Regression-checklist re-confirmation (complexity-relevant items)

| ID | Status | Note |
|----|--------|------|
| REMAINING-1 | **partially open** | Crypto primitives centralized in `LibSignature` (resolved). The EOA/EIP-1271 *dispatch wrapper* `_verifySignature` is still duplicated — see **CPX-001**. |
| REMAINING-2 | **resolved** | `ProtocolFeesWithdrawn` is gone; `Events.sol:183-187` carries an explanatory tombstone comment (SEC-012). Acceptable; no action. |
| REMAINING-3 | **resolved** | `setTradingFeesBps` and the v2.0 maker/taker trading-fee params are gone from `AdminConfigFacet`. The current fee surface is `setMaxFeeRate` / `getMaxFeeRate` (SCRUM-224), correctly bounded by `MAX_FEE_RATE_BPS_CAP = 1000`. No action. |
| NEW-3 | **confirmed consistent** | Domain-separator computation is identical across all three v3 facets — each `_getDomainSeparator` delegates to `LibDoefinOrder.diamondDomainSeparator`. No duplication. |

---

## Appendix — cosmetic / informational nits

These are below LOW. Listed for completeness; batch them or skip them.

- **INFO-1 — MarketDataFacet NatSpec is doubled.** Every function in
  `MarketDataFacet` carries two NatSpec blocks back-to-back: a verbose
  `@custom:*`-tag block and then a second terse `/// @notice` block (e.g.
  lines 25-38 then 36-38; lines 44-57 then 55-57). The pattern repeats for all
  eight functions. One block per function suffices. ~80 lines of removable
  duplication. `upgrade-safe: yes`.

- **INFO-2 — OracleAdapterFacet NatSpec is similarly doubled** (e.g. lines 29-42
  then 40-42). Same pattern, same fix. `upgrade-safe: yes`.

- **INFO-3 — Magic number `10000` in `_validateFee`.** `SettlementFacet.sol:806`
  hard-codes the bps denominator `10000`. `AdminConfigFacet` uses `10_000` (with
  the digit separator) at line 124. Define one shared `uint256 constant BPS_DENOMINATOR = 10_000`
  and reference it from both, for a single source of truth and consistent
  formatting. `upgrade-safe: yes`.

- **INFO-4 — Inconsistent numeric-literal formatting.** `MAX_FEE_RATE_BPS_CAP = 1000`
  (AdminConfigFacet.sol:25) vs `10_000` (line 124). Pick one convention
  (digit separators for 4+-digit literals is the common Solidity style).
  `upgrade-safe: yes`.

- **INFO-5 — `matchType` event encoding is 1/2/3 but the NatSpec says 0/1/2.**
  `Events.OrdersMatched` NatSpec (`Events.sol:339`) documents
  "0 = Complementary, 1 = Mint, 2 = Merge", but `SettlementFacet` constants are
  `MATCH_COMPLEMENTARY = 1`, `MATCH_MINT = 2`, `MATCH_MERGE = 3` (lines 29-31)
  and that value is what is emitted (line 215). The NatSpec is wrong by one.
  Fix the comment to 1/2/3. Off-chain consumers decoding the event must use the
  on-chain values; the stale comment is a decoding-bug trap. `upgrade-safe: yes`.

- **INFO-6 — Stale CPX cross-references in comments may dangle after fixes.**
  `SettlementFacet` NatSpec cites line numbers from a prior layout, e.g.
  `_conditionAndPartition` at line 825 says it was "previously duplicated
  verbatim across `_settleMint:497-506` and `_settleMerge:550-553`" — those
  line numbers no longer correspond to anything. Such "previously at line N"
  notes rot with every edit. Recommend dropping the absolute line numbers and
  keeping only the function names. `upgrade-safe: yes`.

---

## Complexity assessment of the crown-jewel functions (no finding — for the record)

The brief asked for an explicit complexity read on `SettlementFacet`. Result:
the facet is **well-decomposed** and does not warrant a complexity finding.

- `matchOrders` (81-160): one validation block + one linear maker loop that
  delegates the per-leg body to `_settleAgainstMaker`. Cyclomatic complexity is
  low; nesting never exceeds 2. The CPX-006-era refactor that pulled the loop
  body out is the right shape.
- `_determineMatchType` (450-466): a flat 3-branch decision with an early
  `revert`. Trivial.
- `_executeSettlement` (496-514): a clean 3-way `if/else-if` dispatch — a lookup
  table would not improve a fixed 3-entry switch. Leave as is.
- `_settleComplementary` / `_settleMint` / `_settleMerge`: each is ~50 LOC,
  single-responsibility (one settlement path), nesting depth 2, no loops. The
  buyer/seller-resolution ternaries in `_settleComplementary` (lines 539-547)
  are the densest spot but read clearly.
- The 873 LOC is dominated by NatSpec and `@custom:audit` rationale comments,
  not logic. That is a *feature* for an audit subject — the "why" is documented
  inline. No split is recommended; splitting the three `_settleX` paths into a
  separate library would only add a cross-file jump for the reviewer.

Net: `SettlementFacet` passes the complexity bar. The findings above are about
dead surface and duplication, not about any function being hard to reason about.
