# Doefin v3 Mainnet Audit — Canonical Findings Ledger

**Commit:** `015097c1c7f8b6a5d70be21972eb345bf1082c06` · **Phase 4 (triage) complete.**
Produced by triage from: 4 domain reviews, Slither (27 raw), Mythril (3), Echidna + Medusa.

## Triage summary

| Severity | Count | IDs |
|---|---|---|
| Critical | 0 | — |
| High | 2 | SEC-001, SEC-002 |
| Medium | 7 | SEC-003, SEC-004, SEC-005, SEC-006, SEC-007, BIZ-001, GAS-001 |
| Low | 12 | SEC-008, SEC-009, SEC-010, SEC-011, BIZ-002, BIZ-004, BIZ-005, BIZ-006, CPX-003, CPX-005, CPX-006, CPX-007 |
| Informational | 6 | SEC-012, SEC-013, SEC-014, BIZ-008, CPX-A2, CPX-A4567 |
| Gas (≤ MEDIUM) | 6 | GAS-002 (M), GAS-005 (M), GAS-003/004/006/007 (L) |

**Total confirmed: 27** (excludes 4 `duplicate`). **Mainnet-blocking: SEC-001, SEC-002.**

**Dedup map (raw → canonical):**
- SEC-005 + CPX-001 + REMAINING-1 + Slither `assembly`×3 + `low-level-calls`×1 → **SEC-005**
- SEC-004 + CPX-002 + NEW-2 + NEW-3 → **SEC-004**
- SEC-003 + BIZ-003 + NEW-5 → **SEC-003**
- SEC-006 + BIZ-007 → **SEC-006** · SEC-012 + CPX-A1 + REMAINING-2 → **SEC-012** · SEC-013 + CPX-004 + REMAINING-3 → **SEC-013** · BIZ-008 + CPX-A3 → **BIZ-008**
- Slither `arbitrary-send-erc20`×9 → folded into **SEC-001**

---

## HIGH — mainnet blockers

### SEC-001 — HIGH — confirmed — fix — `_settleComplementary` never verifies `taker.collateralToken == maker.collateralToken`
- **location:** `contracts/facets/SettlementFacet.sol:413-454` · **source:** manual-reviewer | slither(arbitrary-send-erc20) · **swc:** SWC-110 · **upgrade-safe:** yes
- **description:** `_settleMint:469` and `_settleMerge:537` both open with `if (taker.collateralToken != maker.collateralToken) revert InvalidMatch();`. `_settleComplementary` has no such guard — it reads `unit = unitPerPair[taker.collateralToken]` and does every ERC-20 transfer with `IERC20(taker.collateralToken)`. The maker's signed `collateralToken` is never read.
- **impact:** A compromised operator pairs a maker SELL signed in token A with a taker BUY in token B; settlement executes wholly in token B. Differing decimals/units mis-price by up to 1e12×. HIGH (fund loss behind compromised-operator precondition).
- **recommendation:** First statement of `_settleComplementary`: `if (taker.collateralToken != maker.collateralToken) revert Errors.InvalidMatch();`. Add a regression test pairing differing `collateralToken`.

### SEC-002 — HIGH — confirmed — fix — No collateral-whitelist / non-zero-unit gate on the settlement hot path
- **location:** `SettlementFacet.sol:302-317, 413-454, 593-619` · **source:** manual-reviewer · **swc:** SWC-110 · **upgrade-safe:** yes
- **description:** `_validateOrder` checks cancelled/nonce/salt/expiration only — no `isAllowed[collateralToken]` gate, no non-zero `unitPerPair` check. A removed token has `unit==0` (div-by-zero panic); worse, a zero-fee order (`feeRateBps==0` early-returns in `_computeFee` *before* its `price>unit` guard) against a mis-set `unitPerPair` settles at a wrong price with no revert.
- **impact:** Compromised operator settles trades for an unwhitelisted/removed/mis-`unit` token; the whitelist is silently not enforced. Compounds SEC-001. HIGH.
- **recommendation:** Central gate in `_validateOrder`: `if (!ds.adminConfigStorage.isAllowed[order.collateralToken]) revert Errors.TokenNotAllowed(); if (ds.adminConfigStorage.unitPerPair[order.collateralToken] == 0) revert Errors.InvalidUnitPerPair();`. Implement with BIZ-004 and BIZ-006 (same `_validateOrder` site).

---

## MEDIUM

### SEC-003 — MEDIUM — confirmed — fix — `_executeOperatorFill` allows a zero `collateralAmount` fill
- **location:** `SettlementFacet.sol:593-619` · **source:** manual-reviewer | business-logic · **regression-of:** NEW-5 · **duplicate-of:** BIZ-003 · **upgrade-safe:** yes
- **description:** `collateralAmount = (price*fill)/unit`; only `fillAmount != 0` is guarded. `price*fill < unit` truncates to 0 → maker pays nothing but still receives `fillAmount` position tokens. `collateralAmount - fee` also underflow-panics when `fee > collateralAmount`. NEW-5's recommended check was never applied.
- **impact:** Compromised operator extracts free position tokens via `fillOrder` (bounded to dust fills). MEDIUM.
- **recommendation:** After computing `collateralAmount`: `if (collateralAmount == 0) revert Errors.ZeroAmount(); if (collateralAmount < fee) revert Errors.InvalidPrice();`. Apply `==0` to `_settleComplementary` too.

### SEC-004 — MEDIUM — confirmed — fix — Domain-separator cache has no `chainId` guard and is inconsistent across facets
- **location:** `SettlementFacet.sol:236-247; SignatureVerifierFacet.sol:102-109; NonceManagerFacet.sol:166-173; LibSettlementStorage.sol:48-51` · **source:** manual-reviewer | complexity · **regression-of:** NEW-2, NEW-3 · **duplicate-of:** CPX-002 · **upgrade-safe:** depends on option
- **description:** `SettlementFacet._getDomainSeparator` returns the cache unconditionally; the other two facets always recompute. No `cachedChainId`. After a chain fork, a cancellation via `NonceManagerFacet` computes a different hash than `SettlementFacet` uses → cancellation silently fails.
- **recommendation:** Make all three facets one code path. Recommended: delete the cache, recompute everywhere (~300 gas, negligible on Base) — or add `cachedChainId` and gate the cache on `block.chainid`.

### SEC-005 — MEDIUM — confirmed — fix — Triplicated ECDSA verifier; `OracleManagerFacet` copy lacks the malleability check
- **location:** `SettlementFacet.sol:252-297; SignatureVerifierFacet.sol:129-196; OracleManagerFacet.sol:544-560` · **source:** manual-reviewer | complexity | slither · **swc:** SWC-117 · **regression-of:** REMAINING-1 · **duplicate-of:** CPX-001 · **upgrade-safe:** yes
- **description:** Three copies of ECDSA recovery. `OracleManagerFacet._recoverSigner` has **no `v` normalization and no low-`s` malleability check**. The two settlement copies also differ (raw `staticcall` vs typed `IERC1271`).
- **impact:** No exploitable theft today; maintenance + consistency risk. MEDIUM.
- **recommendation:** Extract one `LibSignature` (`recoverCalldata`, `recoverMemory`, `verifyEIP1271`); route all three facets through it; pick the typed `IERC1271` dispatch.

### SEC-006 — MEDIUM — confirmed — fix — Per-order `feeRateBps` up to 5%; CLAUDE.md mis-states the fee recipient
- **location:** `SettlementFacet.sol:633-647; .claude/CLAUDE.md` · **source:** manual-reviewer | business-logic · **duplicate-of:** BIZ-007 · **upgrade-safe:** yes
- **description:** `_computeFee` caps `feeRateBps` at `MAX_FEE_RATE_BPS=500`; all fees go to `feeReceiver` (the operator is never a fee sink — CLAUDE.md "Operator is the fee recipient" is stale). A maker UI-manipulated into signing `feeRateBps=500` is bound by it.
- **recommendation:** Correct CLAUDE.md; consider lowering `MAX_FEE_RATE_BPS` to ~100 (1%); optionally emit `feeRateBps` in `OrderSettled`.

### SEC-007 — MEDIUM — confirmed — defer — Mint/Merge crossing checks allow an unfair (but collateral-conserving) settlement
- **location:** `SettlementFacet.sol:476, 566-588` · **source:** manual-reviewer · **regression-of:** NEW-4 · **upgrade-safe:** yes
- **description:** Crossing checks revert only on `P_t+P_m < unit` (mint) / `> unit` (merge); off-`unit` sums are accepted. The remainder construction keeps collateral conserved (fuzzing confirms), so this is an unfair-execution window, not insolvency. NEW-4's "dust locked" framing is refuted at this commit.
- **recommendation:** Confirm intent with the team — SCRUM-121's "effective price" may make the slack intentional price-improvement. If not intentional, tighten to `== unit`.

### BIZ-001 — MEDIUM — confirmed — fix — `_settleMerge` can over-remit fees if `fee >= payout` (latent solvency)
- **location:** `SettlementFacet.sol:575-587` · **source:** business-logic · **upgrade-safe:** yes
- **description:** Payout transfers are guarded `if (payout > fee)`, but `totalFees` is transferred unconditionally. If `fee >= payout`, a party's payout is silently skipped while its fee is still remitted → total out > `fillAmount`. NOT reachable at this commit (gated by the 5% cap), but latent — any future cap raise re-arms it with no test signal.
- **recommendation:** Replace guarded transfers with checked subtraction (`net = payout - fee`, reverts on underflow). Add the merge-with-non-zero-fee test (currently absent).

---

## LOW

### SEC-008 — LOW — confirmed — accept-risk — `OracleManagerFacet.updatePrice` is permissionless
`OracleManagerFacet.sol:241-307` — keeper pattern by design; the pause-on-failure write is rolled back by the function's own revert; v3 settlement does not consult oracle storage. Acceptable; optionally require N consecutive failures before pausing.

### SEC-009 — LOW — confirmed — accept-risk — On-chain cancellation keys off `msg.sender`; SCW maker cannot delegate cancellation
`NonceManagerFacet.sol:30-34, 57-69, 115-125` — correct and unspoofable; an availability asymmetry. Optionally add `cancelOrderFor`/`incrementNonceFor` for registered signers.

### SEC-010 — LOW — confirmed — accept-risk — Filled-amount accumulator is `uint256` while order amounts are `uint128`
`SettlementFacet.sol:218; LibSettlementStorage.sol:32` — `_checkFillAmount` caps cumulative fill at the `uint128` `orderAmount`, so no overflow. Optionally narrow the mapping to `uint128`.

### SEC-011 — LOW — confirmed — fix — `setOperator`/`cacheDomainSeparator` emit no event; `setOperator(address(0))` accepted
`SettlementFacet.sol:183-187, 243-247` — add `if (_operator == address(0)) revert Errors.ZeroAddress();` + emit `OperatorUpdated`.

### BIZ-002 — LOW — confirmed — fix — `_settleMerge` runs the CTF merge before its crossing-check
`SettlementFacet.sol:543-567` — effects-before-checks (mint does it correctly). Atomic revert so no fund loss; move the check to the top of `_settleMerge`.

### BIZ-004 — LOW — confirmed — fix — `pricePerToken <= unit` not enforced in complementary / operator-fill paths
`SettlementFacet.sol:437, 601` — add `if (order.pricePerToken > unitPerPair[order.collateralToken]) revert Errors.InvalidPrice();` to `_validateOrder` (with the SEC-002 gate).

### BIZ-005 — LOW — confirmed — fix — On-chain `_computeFee` only asserted at `price = 0.5`
`test/unit/SettlementFacet/SettlementFacet.test.js` — add settlement tests asserting the contract-charged fee via balance deltas at `price = 0.1·unit` and `0.9·unit`, and a multi-maker `matchOrders` with `feeRateBps > 0`.

### BIZ-006 — LOW — confirmed — fix — `side` not constrained to `{0,1}`; `side >= 2` reaches the complementary path
`SettlementFacet.sol:346-362` — add `if (order.side > 1) revert Errors.InvalidMatch();` to `_validateOrder` (with the SEC-002 gate).

### CPX-003 — LOW — confirmed — fix — `_getOrderHash` + order-validity predicate duplicated; stale NatSpec
`NonceManagerFacet.sol:137-160; SettlementFacet.sol:302-317` — `isOrderValid` (bool) and `_validateOrder` (revert) implement the same rule twice; the doc claims settlement calls `isOrderValid()` (it inlines instead). Extract one predicate; fix the NatSpec.

### CPX-005 — LOW — confirmed — defer — Cross-currency conversion-path machinery on `AdminConfigFacet` is dead in v3
`AdminConfigFacet.sol:200-297` — 4 functions + mapping + 2 events, no settlement consumer. Remove post-launch or add a NatSpec note. Do NOT touch the EIP-712-signed `DoefinOrder` `quoteCurrency`/`exchangeRate`/`orderType` fields.

### CPX-006 — LOW — confirmed — fix — `matchOrders` is a long, multi-responsibility function
`SettlementFacet.sol:76-139` — extract a `_settleAgainstMaker` loop-body helper and a `_sumFills` helper; reword the "Fix N" archaeological comments. Coordinate with GAS-006.

### CPX-007 — LOW — confirmed — fix — `_getIndexSet` misleading "O(1)" comment; partition reconstruction duplicated
`SettlementFacet.sol:497-506, 550-553, 659-671` — extract `_conditionAndPartition`; correct the comment (it is a linear scan). Combines with GAS-002.

---

## INFORMATIONAL

### SEC-012 — INFO — confirmed — fix — Orphaned `ProtocolFeesWithdrawn` event
`Events.sol:205` — zero emit sites (dead since `LibFeeManager` removal). Delete the declaration. (regression REMAINING-2)

### SEC-013 — INFO — confirmed — fix — v2.0 `setTradingFeesBps` / fee fields are live-but-dead
`AdminConfigFacet.sol:138-148, 160-168` — writes `makerTradingFeeBps`/`takerTradingFeeBps`, read nowhere by settlement; an admin foot-gun. Delete the selector + fields (fine for the fresh deploy), narrow `getFees`. (regression REMAINING-3)

### SEC-014 — INFO — confirmed — fix — `ERC1155Facet.setApprovalForAll` emits `ApprovalForAll` twice
`ERC1155Facet.sol:21-24; LibERC1155.sol:30-37` — facet and library both emit. Remove the facet's `emit`.

### BIZ-008 — INFO — confirmed — defer — `minFillAmount` is a signed-but-ignored order field
`LibDoefinOrder.sol:18-34` — intentionally not enforced since SCRUM-121/122; kept for hash stability. Add a NatSpec note. Must be applied if GAS-001 is not executed pre-deploy.

### CPX-A2 — INFO — confirmed — defer — Residual v2.0 type zoo in `LibDoefinStorage`
~12 deprecated types + 2 `AppStorage`-embedded structs. Delete the standalone enums/structs post-launch; keep the embedded structs (slot/`__gap` hazard).

### CPX-A4567 — INFO — confirmed — defer — Bundled cosmetic / doc nits
Magic numbers (`0x1626ba7e`, `10000`), "Fix N" comments, stale NatSpec, floating `^0.8.6` pragmas vs the pinned 0.8.20 build, loop-index style. One post-launch cleanup commit.

---

## GAS (severity capped at MEDIUM)

### GAS-001 — MEDIUM — confirmed — defer — Four dead `DoefinOrder` fields inflate Base-L2 calldata
`LibDoefinOrder.sol` — `minFillAmount`/`orderType`/`quoteCurrency`/`exchangeRate` unread; 128 dead calldata bytes/order. Removal is a **breaking EIP-712/ABI change** needing byte-for-byte backend coordination — schedule as an explicit pre-deploy decision item, not bundled with security fixes.

### GAS-002 — MEDIUM — confirmed — fix — Registry slots re-resolved in Mint/Merge
`SettlementFacet.sol` — ~9-12 redundant warm SLOADs per Mint/Merge. Resolve metadata once into a `MatchContext` struct. Combines with CPX-007.

### GAS-003 — LOW — confirmed — fix — Settlement-path fee transfers not coalesced (narrow residue — most batching blocked by distinct debtors).

### GAS-004 — LOW — confirmed — fix — `_computeFee` re-resolves `unitPerPair`/`feeReceiver` per call — read once at the maker-loop top. Keep the `_computeFee` guards.

### GAS-005 — MEDIUM — confirmed — fix — `optimizer runs=1` mistuned — `SettlementFacet` has 10.7 KiB headroom. Sweep `runs ∈ {200,1000,100000}`, pick the highest that beats baseline without breaching EIP-170.

### GAS-006 — LOW — confirmed — fix — `matchOrders` double-walks `makerFillAmounts` — accumulate in the main loop. Apply with CPX-006.

### GAS-007 — LOW — confirmed — fix — `unchecked` for loop counters + the four guarded subtractions only. Keep all guards; do NOT `unchecked` the fee/collateral multiplications.

---

## Slither — 27 raw results, all triaged

| Detector | Hits | Disposition |
|---|---|---|
| `arbitrary-send-erc20` | 9 | Folded into SEC-001 (intended signed-spend pattern; genuine gap = missing token check) |
| `divide-before-multiply` | 1 | false-positive — intentional floor-to-bucket |
| `uninitialized-local` | 2 | false-positive — EVM-zero-init accumulators |
| `calls-loop` | 1 | false-positive — owner-bounded, try/catch, off settlement path |
| `timestamp` | 7 | false-positive — coarse-grained expiry/staleness |
| `assembly` | 7 | 3 corroborate SEC-005; 4 false-positive (EIP-2535/7201 storage pattern) |
| `low-level-calls` | 1 | Folded into SEC-005 |

No Slither result is a standalone confirmed finding.

## Mythril — 3 results
SettlementFacet clean; SignatureVerifierFacet SWC-113 false-positive; NonceManagerFacet SWC-116 false-positive. See `triage-notes.md`.

## Fuzzing — no findings
Medusa 22/22 tests pass; Echidna 50,000-call campaign sustained `0/6` failures. All 6 `echidna_*` invariants hold — corroborates that SEC-007 and BIZ-001 are not live insolvency bugs at this commit.

## Regression checklist verdict

| ID | Verdict | Canonical |
|----|---------|-----------|
| CRITICAL-1 | **resolved** | — (remainder construction makes collateral conservation structural; fuzzing confirms) |
| NEW-2 | open (MEDIUM) | SEC-004 |
| NEW-3 | open (MEDIUM) | SEC-004 |
| NEW-4 | **resolved** | residual → SEC-007 |
| NEW-5 | open (MEDIUM) | SEC-003 |
| REMAINING-1 | open (MEDIUM) | SEC-005 |
| REMAINING-2 | open (info) | SEC-012 |
| REMAINING-3 | open (info) | SEC-013 |

**2 resolved, 6 open, 0 regressed. No regression item open at CRITICAL/HIGH.**

## Triage gate verdict (advisory)

**NO-GO** until SEC-001 and SEC-002 are `fixed-clean`. After those two — with no storage/selector collision, no facet over 24 KiB, all economic invariants holding under fuzzing — the project moves to **CONDITIONAL-GO**: only MEDIUM/LOW/info remain, each needing a fix or a written accept-risk note. Non-`fix` decisions needing orchestrator sign-off: SEC-007, SEC-008, SEC-009, SEC-010, BIZ-008, CPX-005, CPX-A2, CPX-A4567, GAS-001.
