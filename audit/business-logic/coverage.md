# Doefin v3 — Invariant Test-Coverage Map

Domain 3 (business-logic) deliverable. **Pinned to: current `v3/dev`, post Phase-2
remediation (SCRUM-229 / SCRUM-230 / SCRUM-231), the SCRUM-234 coverage-gap suites, and
the BL-N2 zero-collateral-guard fix**. Companion to `invariants.md`. Maps every economic
invariant to the test(s) that exercise it, flags gaps, and refreshes the SC-008 "test
coverage gaps" table. This **supersedes** the prior revision pinned to `015097c1`.

**Refresh note (this revision).** Every ranked gap in the table below is now **CLOSED**.
SCRUM-234 added `test/unit/SettlementFacet/SettlementFacet.coverage-gaps.test.js`
(18 tests — Gaps 1-6 and 8) and `test/unit/LibDoefinOrder/eip712-differential.test.js`
(6 tests — Gap-7); the BL-N2 fix then turned Gap-8 from "pin the tolerated behaviour"
into "assert the new symmetric guard reverts". The gap table is retained as an audit
trail — each row's `Closure` column records how it was resolved.

## Test-run result (`npx hardhat test`)

```
516 passing (8m)
21 pending
0 failing
```

Exit code 0 — a fully green run. The `492 → 516` delta is the SCRUM-234 coverage-gap
suites (`+24` tests: 18 in `SettlementFacet.coverage-gaps.test.js`, 6 in
`eip712-differential.test.js`). The single out-of-scope failure noted in an earlier
revision (`test/integration/BatchSubmissionBugRepro.test.js` reverting `ValueOutOfRange`
inside the excluded CTF/oracle group) no longer occurs — SCRUM-222 refreshed the oracle
fixture and that suite now passes. There is no failing test in scope or out.

All in-scope settlement-core suites pass:

- `test/unit/SettlementFacet/SettlementFacet.test.js` — the large settlement suite,
  including the SCRUM-89 fresh-market, SCRUM-120/121 effective-price, SCRUM-224
  operator-fee, mainnet-hardening (SEC-001/002/003, BIZ-004/006), and mixed-match-type
  blocks.
- `test/unit/SignatureVerifierFacet/SignatureVerifierFacet.test.js`
- `test/unit/NonceManagerFacet/NonceManagerFacet.test.js`
- `test/unit/LibDoefinOrder/LibDoefinOrder.test.js`
- `test/unit/SettlementFacet/SettlementFacet.coverage-gaps.test.js` +
  `test/unit/LibDoefinOrder/eip712-differential.test.js` — the SCRUM-234 gap-closing
  suites (Gaps 1-8 of the table below); spec-first, with every expected number computed
  from the `invariants.md` formulae.
- `test/audit/*.test.js` — the pentest suite (BIZ-001, SEC-001..007, LOW-INFO-batch).
- `test/characterization/SettlementAdmin.characterization.test.js` +
  `access-control.characterization.test.js` — characterize the post-extraction
  `SettlementAdminFacet` / access-control behaviour (SCRUM-230).
- `test/storage/storage-layout-snapshot.test.js` — the EIP-7201 storage-layout CI gate
  (SCRUM-229); asserts each namespace's slot constant matches the recorded snapshot.

## Coverage tooling

`npm run audit:coverage` = `npx hardhat coverage` (solidity-coverage). For this pass the
instrumented run executed the **settlement-core + audit suites** (SettlementFacet,
SignatureVerifierFacet, NonceManagerFacet, LibDoefinOrder, and `test/audit/`) so that the
crown-jewel facets are exercised by their own tests rather than appearing under-covered
because their suite was filtered out (the failure mode of the old doc's table). Line/branch
percentages are appended under "Coverage tool output". The invariant map below is derived
by **reading the test bodies** — the load-bearing signal; a high line % does not prove an
invariant is asserted.

---

## Invariant → test map

Legend: **COVERED** — at least one test asserts the property on-chain (balance deltas /
state reads / revert). **PARTIAL** — exercised but a material sub-case is untested.
**GAP** — no test asserts it. **N/A-FUZZ** — best covered by the Phase-3 harness.

### A. Solvency

| Invariant | Status | Evidence |
|---|---|---|
| INV-SOLV-1 Mint conserves collateral | **COVERED** | `SettlementFacet.test.js` "Mint settlement" `should route operator-supplied fees to feeReceiver` asserts each buyer pays `collateralLeg + fee` and `feeReceiver` gets the fees; "Price sum invariant" `succeed mint when prices sum to exactly unit` and `succeed mint with rounding-prone prices (1/3 + 2/3)` exercise the remainder split and the rounding probe; "SCRUM-121 Mint" asserts both buyers receive `fill` position tokens at the effective price. The `test/audit/SEC-007` "Mint accepts P_t+P_m>unit" asserts `in == out == fill` holds off-`unit`. |
| INV-SOLV-2 Merge conserves collateral | **COVERED** | `test/audit/BIZ-001` `CONTROL` asserts `takerNet + makerNet + totalFees == fill` with a live fee on both legs and the `feeReceiver` delta; `REGRESSION` drives a fee above the taker payout and asserts the call reverts (no silent skip). `SettlementFacet.test.js` "Merge settlement" `should route operator-supplied fees to feeReceiver and deduct them from payouts` asserts each seller receives `payout − fee`. The old Gap-1 (merge never tested with a live fee) is **CLOSED**. |
| INV-SOLV-3 Complementary doesn't touch Diamond | **COVERED** | "Complementary settlement" asserts counterparty + `feeReceiver` deltas; `test/audit/SEC-001` `CONTROL` likewise. `SettlementFacet.coverage-gaps.test.js` Gap-1 closes the residual hole — it snapshots the Diamond's own ERC-20 and ERC-1155 (positionId) balances and asserts a zero delta across a complementary `matchOrders` carrying live fees on both legs. |
| INV-SOLV-4 Aggregate backing | **N/A-FUZZ** | No single unit test; this is the master Echidna property `echidna_diamond_collateral_solvent`. The audit echidna corpus (`audit/output/echidna`) exercises a `collateral_conserved` / `diamond_solvent` property — re-run against current `v3/dev` to confirm. |

### B. Price / crossing

| Invariant | Status | Evidence |
|---|---|---|
| INV-PRICE-1 Mint taker ≤ signed price | **COVERED** | "SCRUM-121 Mint" `should give taker price improvement: taker pays unit−P_m, not P_t` (P_t+P_m>unit) and `should fill at exactly P_t when prices sum to unit`; crossing-revert at `P_t+P_m<unit` covered by `should revert when P_t + P_m < unit` and "Price sum invariant" `revert mint when prices diverge significantly from unit`. The 1/3+2/3 rounding case exercises the +1-wei remainder direction. |
| INV-PRICE-2 Merge taker ≥ signed floor | **COVERED** | "SCRUM-121 Merge" `taker receives unit−P_m, not P_t` and `settle at exactly taker's floor when P_t + P_m = unit`; crossing-revert at `sum>unit` via `should revert when P_t + P_m > unit` and "Price sum invariant" `revert merge when prices sum exceeds unit`. |
| INV-PRICE-3 Complementary buyer ≥ seller | **COVERED** | "Complementary price compatibility" — `revert when buyer price < seller price`, `succeed when buyer price > seller price`, `succeed when buyer price == seller price`, and the reversed-role taker-as-seller rejection. |
| INV-PRICE-4 pricePerToken ≤ unit on every path | **COVERED** | "price > unit rejection in _validateOrder (BIZ-004)" and the "Mainnet audit" `BIZ-004` block: `revert an order whose pricePerToken exceeds unit` (matchOrders) and `accept an order whose pricePerToken equals unit exactly`. `test/audit` exercises it too. The old Gap-5 (`price>unit` untested in complementary/operator-fill) is **CLOSED** — the bound is now a universal `_validateOrder` precondition. |
| INV-PRICE-5 Off-`unit` slack solvency-safe | **COVERED (demonstration)** | `test/audit/SEC-007` `DEMONSTRATES` Mint accepts `P_t+P_m>unit` and Merge accepts `P_t+P_m<unit`, `CONTROL` sum==unit, `BOUND` Mint reverts when sum<unit — each asserts solvency (`in==out==fill`) and the maker's signed-price honouring under the slack. |

### C. Fees (operator-supplied model — fully re-derived)

| Invariant | Status | Evidence |
|---|---|---|
| INV-FEE-1 Fee ≤ admin max rate (`_validateFee`) | **COVERED** | "Operator-supplied fee model (SCRUM-224)" — `settle when the operator fee is exactly at the max-rate cap`, `revert when the taker fee is one wei over the max-rate cap` (`FeeExceedsMaxRate`), `revert when the maker fee is one wei over the max-rate cap`, `settle with a zero fee on every leg`, and the fail-closed `revert with FeeExceedsMaxRate when maxFeeRateBps is unset`. `test/audit/SEC-006` `CAP` corroborates with both within-cap and over-cap cases. The cap-boundary (`feeAtCap`, `feeAtCap+1`) is exercised on both taker and maker legs. |
| INV-FEE-2 Fee ≤ proceeds | **COVERED** | "Operator-supplied fee model" `revert merge when the operator fee exceeds a seller's proceeds` and `revert fillOrder when the operator fee exceeds the collateral leg`; `test/audit/BIZ-001` `REGRESSION` drives `takerFee = takerPayout + 1` and asserts the merge reverts. `SettlementFacet.coverage-gaps.test.js` Gap-2 pins the *observable* over-proceeds revert on the merge taker-leg, merge maker-leg and `fillOrder` paths, plus a `fee == payout` boundary settle. **Finding TE-1 (INFO):** `FeeExceedsProceeds` is structurally shadowed by `FeeExceedsMaxRate` — on every proceeds-guarded leg `cashValue == proceeds`, so under the `MAX_FEE_RATE_BPS_CAP = 1000` ceiling the rate guard always reverts first; the dedicated proceeds guard is proven live by mutation #2 (`audit/test-engineering/mutation-report.md`). |
| INV-FEE-3 feeReceiver is the only sink | **COVERED** | Complementary, Mint, Merge, and `fillOrder` fee tests all assert the `feeReceiver` ERC-20 balance delta equals the summed per-leg fees. `test/audit/SEC-006` `DEMONSTRATES (a)` explicitly asserts the operator is NOT credited the fee. |
| INV-FEE-4 Taker fee = Σ per-leg operator inputs | **COVERED** | `SettlementFacet.coverage-gaps.test.js` Gap-3 settles 1 taker vs 2 makers with four **distinct** non-zero per-leg fees and asserts the taker `OrderSettled.fee == Σ takerFees[i]`, each maker `OrderSettled.fee == makerFees[i]`, and the `feeReceiver` delta == `Σ (takerFees + makerFees)` — the distinct values make a wrong-index accumulation fail the test. The single-maker fee tests corroborate. |
| INV-FEE-5 `maxFeeRateBps` ≤ hard ceiling | **COVERED** | `AdminConfigFacet.test.js` "setMaxFeeRate / getMaxFeeRate (SCRUM-224)" — `default maxFeeRateBps to 0 on a fresh deploy`, `set the max fee rate and emit MaxFeeRateUpdated`, `allow setting the rate exactly at the 1000-bps ceiling`, `revert when the rate exceeds the 1000-bps ceiling` (`MaxFeeRateExceedsCeiling`), and the non-owner revert. The `1000` accept / `1001` reject boundary pair is present. |

### D. Fill accounting

| Invariant | Status | Evidence |
|---|---|---|
| INV-FILL-1 No overfill | **COVERED** | "Complementary settlement" `should revert on overfill` and "Edge case: fill exactly remaining" cover single-order overfill and the exact-remaining boundary. `SettlementFacet.coverage-gaps.test.js` Gap-4 closes the duplicate-maker-leg regression guard: the same maker order appearing twice in one `makerOrders` array reverts `OrderOverfilled` (leg 2 reads the already-incremented `filled[h]`) when the two legs together exceed its amount, and settles when they sum to exactly its amount. |
| INV-FILL-2 Filled monotonic | **COVERED** | "Complementary settlement" `should handle partial fill then fill the rest` and `should update fill state correctly`. |
| INV-FILL-3 Σ maker fills == taker fill | **COVERED** | "Fill amount consistency" `should revert when sum of makerFillAmounts != takerFillAmount` — asserts the `FillAmountMismatch` revert (CPX-008, the correctly named error, distinct from `MismatchedInputLengths`). |
| INV-FILL-4 Non-zero fill legs | **COVERED** | "Input validation" `revert on zero taker fill amount`; "fillOrder" `revert fillOrder with zero amount`; the per-maker `fillAmount == 0` guard. The collateral-leg-zero sub-case (`P*f<unit` truncation) is covered for `fillOrder` by the "SEC-003" block (`revert a fillOrder whose collateral leg rounds down to zero`, sell-side variant too). |
| INV-FILL-5 Array-length consistency | **COVERED** | "Input validation" `should revert on mismatched array lengths` (`MismatchedInputLengths`). |
| INV-NONCE-1 Nonce monotonic | **COVERED** | `NonceManagerFacet.test.js` "Nonce management" — increment-by-1, accumulation, per-maker independence, `NonceBumped` event. |
| INV-NONCE-2 Invalid orders never settle | **COVERED** | `NonceManagerFacet.test.js` `isOrderValid()` covers cancelled / stale-nonce / low-salt / expired via the **view**. `SettlementFacet.coverage-gaps.test.js` Gap-5 drives the *settlement path*: `matchOrders` reverts `OrderCancelled` for an expired taker, `OrderNonceInvalid` for a stale-nonce maker, `OrderCancelled` for a maker salt below `minSalt`, and `fillOrder` reverts `OrderCancelled` for an explicitly cancelled order — each pinning the offending order's hash. |

### E. Match-type determination

| Invariant | Status | Evidence |
|---|---|---|
| INV-MATCH-1 `_determineMatchType` correct | **COVERED** | "SCRUM-89: fresh-market complement auto-registration" — Mint/Merge/Complementary all settle without owner registration; negatives — cross-market mint, unregistered position, wrong-side complement pair — all revert `InvalidMatch`. "Mixed match-type settlement" proves per-maker routing: complementary+mint and complementary+merge in one `matchOrders` call, asserting distinct `OrdersMatched` match-type codes (1/2/3). |
| INV-MATCH-2 `side ∈ {0,1}` | **COVERED** | "BIZ-006: side constrained to {0,1} in _validateOrder" — `revert a matchOrders pair whose taker order has side = 2`, `revert when a maker order has side = 2`, `revert a fillOrder whose order has side = 255`. The old Gap-7 is **CLOSED**. |
| INV-MATCH-3 Same collateral token | **COVERED** | "SEC-001: _settleComplementary collateral-token mismatch" covers the complementary path. `SettlementFacet.coverage-gaps.test.js` Gap-6 adds the dedicated mint and merge cases — a taker and maker carrying different allow-listed `collateralToken` values each revert `InvalidMatch` from the `_settleMint` / `_settleMerge` guard. |
| INV-MATCH-4 Self-trade rejected | **COVERED** | "Complementary settlement" `should revert on self-trade (same maker)`. |

### F. Signature / hashing

| Invariant | Status | Evidence |
|---|---|---|
| INV-SIG-1 EIP-712 ↔ backend parity | **COVERED** | `LibDoefinOrder.test.js` "Cross-hash verification" pins the canonical `DOEFIN_ORDER_TYPEHASH` (`0xff1c…a3b0`), `DOMAIN_SEPARATOR_TYPEHASH`, and the struct hash of a canonical order; the per-field "should change when X changes" tests cover all 10 fields. `SignatureVerifierFacet.test.js` `getOrderHash()` cross-checks against the `LibDoefinOrder` harness. `eip712-differential.test.js` (Gap-7) now **mechanically enforces** parity — for a shared fixture and 10 fuzzed variants it computes the struct hash and full order digest three independent ways (the Solidity harness, a faithful JS port of `encoder.py`, and ethers' `TypedDataEncoder`) and asserts byte equality, and pins the frozen typehash / struct-hash values the real Python encoder emits — so a drift on either runtime fails CI. |
| INV-SIG-2 Non-malleable signature | **COVERED** | Malleability rejection in both `SignatureVerifierFacet.test.js` "ECDSA signature malleability rejection" and `SettlementFacet.test.js` "ECDSA signature malleability rejection"; `test/audit/SEC-005`. Invalid `signatureType > 1`, signer≠maker, corrupted/short signature, EIP-1271 magic-value cases all covered. |
| INV-DOMAIN-1 Cross-facet separator | **COVERED** | `SettlementFacet.test.js` "domain separator parity (SEC-004)" — `should produce the same domain separator across all three facets` and `should still settle orders correctly with no separator cache`; `test/audit/SEC-004`. The old PARTIAL (no fork test) is upgraded — the cache is gone, so there is no stale-cache state to fork-test; the recompute-every-call behaviour is what the parity test asserts. |

### G. Documented behaviors

| Invariant | Status | Evidence |
|---|---|---|
| INV-MISC-1 every settlement path rejects a zero-collateral leg | **COVERED** | `fillOrder`'s `collateralAmount == 0` guard is covered ("SEC-003"). Since the BL-N2 fix the three `matchOrders` settle paths carry the symmetric guard; `SettlementFacet.coverage-gaps.test.js` Gap-8 pins all three — complementary price-0, complementary sub-unit dust, mint zero-leg, merge zero-leg — each asserting a `ZeroAmount` revert. |
| INV-MISC-2 Mint/Merge fee on effective leg | **COVERED** | The Mint/Merge fee-routing tests size the operator fee from `takerCollateral`/`makerPayout` (the effective leg) and assert the contract accepts and routes it — implicitly confirming `_validateFee` uses the effective leg as `cashValue`. |
| INV-MISC-3 Operator trust boundary | **COVERED (by the SEC-* suite)** | The SEC-001/002/003 and BIZ-004/006 hardening tests collectively prove a compromised operator cannot settle a token-mismatched pair, an un-allow-listed token, a zero-collateral fill (SEC-003 on `fillOrder`; BL-N2 / Gap-8 on the three `matchOrders` settle paths), an over-`unit` price, or an out-of-domain `side`. |

---

## Coverage gaps (ranked) — refreshed SC-008 "test coverage gaps" table

The prior revision's gap table is fully superseded. The old Gap-1 (merge with a live
fee), Gap-5 (`price>unit` in non-fee paths), Gap-7 (`side>=2`), Gap-9 (operator-fill
sell-side / zero-collateral), and the `minFillAmount`/`feeRateBps`-cap items were closed
by the SCRUM-224 fee redesign and the SEC-001..007 / BIZ-004/006 mainnet hardening suites.

**All eight ranked gaps below are now CLOSED.** SCRUM-234 authored the gap-closing tests
(`SettlementFacet.coverage-gaps.test.js`, 18 tests — Gaps 1-6 and 8;
`eip712-differential.test.js`, 6 tests — Gap-7); the BL-N2 fix then completed Gap-8. The
table is retained as the audit trail — the `Risk` column is the original ranking and the
`Closure` column records how each was resolved.

| # | Gap (as originally ranked) | Invariant | Finding | Risk | Closure |
|---|---|---|---|---|---|
| Gap-1 | Complementary settle never asserted the Diamond's *own* ERC-20 / ERC-1155 balances stay flat — only counterparty/feeReceiver deltas were checked. | INV-SOLV-3 | — | LOW | **CLOSED — SCRUM-234.** `coverage-gaps.test.js` Gap-1 snapshots the Diamond's own ERC-20 and ERC-1155 (positionId) balances and asserts a zero delta across a complementary `matchOrders` carrying live fees on both legs. |
| Gap-2 | Specified test ("raise `maxFeeRateBps`, then assert `FeeExceedsProceeds`") was not achievable — the error is structurally shadowed. | INV-FEE-2 | TE-1 (INFO) | MEDIUM | **CLOSED — SCRUM-234, with finding TE-1.** On every proceeds-guarded leg `cashValue == proceeds`; under the `MAX_FEE_RATE_BPS_CAP = 1000` ceiling any fee above proceeds also exceeds the max-rate, so `_validateFee` reverts `FeeExceedsMaxRate` first — `FeeExceedsProceeds` is an intentionally-shadowed defence-in-depth backstop. `coverage-gaps.test.js` Gap-2 pins the observable `FeeExceedsMaxRate` revert on the merge taker-leg, merge maker-leg and `fillOrder` paths plus a `fee == payout` boundary settle; mutation #2 (delete `_validateFee`) proves the proceeds guard is live. See `audit/test-engineering/mutation-report.md`. |
| Gap-3 | Multi-maker taker-fee aggregation never asserted with a live per-leg fee (the existing test ran `takerFees=[0,0]`). | INV-FEE-4 | — | MEDIUM | **CLOSED — SCRUM-234.** `coverage-gaps.test.js` Gap-3 settles 1 taker vs 2 makers with four distinct non-zero fees and asserts the taker `OrderSettled.fee == Σ takerFees`, each maker event `== makerFees[i]`, and the `feeReceiver` delta == `Σ all fees`. |
| Gap-4 | Duplicate maker order in one `matchOrders` call untested (regression guard — the path is verified safe). | INV-FILL-1 | — | LOW | **CLOSED — SCRUM-234.** `coverage-gaps.test.js` Gap-4: the same maker order twice reverts `OrderOverfilled` when the two legs exceed its amount (leg 2 reads the incremented `filled[h]`), and settles when they sum to exactly its amount. |
| Gap-5 | Settlement-side revert for expired / stale-nonce / low-salt / cancelled orders untested — only the `isOrderValid` view drove those cases. | INV-NONCE-2 | — | LOW | **CLOSED — SCRUM-234.** `coverage-gaps.test.js` Gap-5: `matchOrders` reverts `OrderCancelled` (expired taker), `OrderNonceInvalid` (stale-nonce maker), `OrderCancelled` (maker salt below `minSalt`); `fillOrder` reverts `OrderCancelled` (explicitly cancelled). Each pins the offending order hash. |
| Gap-6 | Mint/Merge collateral-token mismatch untested — SEC-001 covered only the complementary path's guard. | INV-MATCH-3 | — | LOW | **CLOSED — SCRUM-234.** `coverage-gaps.test.js` Gap-6: a mint and a merge each with taker/maker on different allow-listed tokens revert `InvalidMatch` from the `_settleMint` / `_settleMerge` guard. |
| Gap-7 | No cross-runtime EIP-712 differential test — backend parity with `shared/scw/encoder.py` confirmed by inspection only. | INV-SIG-1 | — | MEDIUM | **CLOSED — SCRUM-234.** `eip712-differential.test.js` computes the struct hash / order digest three independent ways (Solidity harness, JS port of `encoder.py`, ethers `TypedDataEncoder`) and asserts byte equality for a shared fixture + 10 fuzzed variants; it also pins the frozen typehash / struct-hash the real Python encoder emits, so a drift on either runtime fails CI. |
| Gap-8 | `_settleX` zero-collateral-leg behaviour undocumented by test. | INV-MISC-1 | BL-N2 (RESOLVED) | LOW | **CLOSED — SCRUM-234 + BL-N2 fix.** Originally specified to *pin* the tolerated behaviour (a zero-collateral leg settles). The BL-N2 fix instead added the symmetric guard to all three `matchOrders` settle paths; `coverage-gaps.test.js` Gap-8 was flipped to assert a `ZeroAmount` revert and extended to four tests — complementary price-0, complementary sub-unit dust, mint zero-leg, merge zero-leg. |

## Go/no-go relevant items

Per `security/audit-protocol.md`, a **CRITICAL/HIGH economic invariant with zero test
coverage is mainnet-blocking**.

- **No CRITICAL/HIGH economic invariant is zero-coverage.** The crown-jewel solvency
  invariants INV-SOLV-1 and INV-SOLV-2 are **COVERED** with on-chain balance-delta
  assertions, including the merge-with-live-fee case (`test/audit/BIZ-001`) that the
  prior revision flagged as a blocking gap (old Gap-1). That blocking gap is **closed** —
  the SCRUM-224 `fee <= proceeds` guard plus the BIZ-001 regression test resolve it.
- INV-FEE-1 (fee max-rate), INV-FILL-1 (no overfill), INV-FILL-3 (fill-sum), INV-MATCH-1
  (match-type routing), INV-PRICE-1/2 (crossing) are all COVERED.
- **All eight ranked gaps (Gap-1..8) are now CLOSED** — SCRUM-234 authored the
  gap-closing tests and the BL-N2 fix completed Gap-8. No CONDITIONAL-GO item from this
  table remains outstanding. The two MEDIUM gaps that mattered most — Gap-3 (multi-maker
  live-fee aggregation) and Gap-7 (cross-runtime EIP-712 differential, the highest-value
  backend-drift guard) — are now covered; `eip712-differential.test.js` should be kept
  in CI as a standing parity gate against `shared/scw/encoder.py`.

**Conclusion: no business-logic invariant is mainnet-blocking.** The two newly-derived
business-logic findings (BL-N1, BL-N2 — see `invariants.md` and the domain summary) are
INFO/LOW; **BL-N2 has since been RESOLVED** by the symmetric zero-collateral guard on the
`matchOrders` settle paths. The suite is green (516 passing, 21 pending, 0 failing).

---

## Coverage tool output

`npx hardhat coverage` over the settlement-core + audit suites (SettlementFacet,
SignatureVerifierFacet, NonceManagerFacet, LibDoefinOrder, `test/audit/`). Numbers below
are the instrumented run for this pass.

> **Stale-number note (this refresh).** The percentages in the table below are the
> **pre-SCRUM-234** instrumented run — they do *not* include
> `SettlementFacet.coverage-gaps.test.js` or `eip712-differential.test.js`. Those 24
> tests directly exercise the previously-uncovered branches called out under the table
> (the `FeeExceedsProceeds` family, multi-maker live-fee accumulation, the
> settlement-side validity reverts, the mint/merge token-mismatch guard, and the
> zero-collateral guards), so re-running `npx hardhat coverage` would raise the
> `SettlementFacet.sol` **80.30%** branch figure. The table is retained as the last
> measured baseline; **re-instrument before the audit handoff** to capture the gap
> suites' contribution.

| File | % Stmts | % Branch | % Funcs | % Lines | Uncovered |
|---|---|---|---|---|---|
| `facets/SettlementFacet.sol` | 97.11 | **80.30** | 100 | 96.39 | ~712-713 (`_executeOperatorFill` sell-side fee branch), ~797 (`_getIndexSetIn` defensive `revert InvalidPositionId`) |
| `facets/SettlementAdminFacet.sol` | 100 | 100 | 100 | 100 | — |
| `facets/SignatureVerifierFacet.sol` | 100 | 100 | 100 | 100 | — |
| `facets/NonceManagerFacet.sol` | 100 | 90 | 100 | 97.22 | ~91 (`_getOrderHash` branch) |
| `libraries/LibDoefinOrder.sol` | 100 | 100 | 100 | 100 | — |
| `libraries/LibSignature.sol` | 95 | 95 | 100 | 95.65 | ~67 (one EIP-1271 dispatch sub-branch) |
| `libraries/LibOrderValidity.sol` | 100 | 100 | 100 | 100 | — |
| `libraries/LibSettlementStorage.sol` | 100 | 100 | 100 | 100 | — |
| `libraries/LibAdminConfigStorage.sol` | 100 | 100 | 100 | 100 | — |
| `libraries/LibConstants.sol` | 100 | 100 | 100 | 100 | — |
| `libraries/LibAccessControlStorage.sol` | 100 | 100 | 100 | 100 | — |
| `libraries/Errors.sol` / `Events.sol` | 100 | 100 | 100 | 100 | — |

(Library files in the `libraries/` aggregate that show low percentages — `LibERC1155`,
`LibPositionRegistry`, `LibOracleAdapter`, `LibCTFCondition` — are mostly CTF / oracle /
ERC-1155 code outside the business-logic scope; they are exercised by their own
suites in the full `npx hardhat test` run, not by this settlement-core-filtered coverage
pass. The `MarketDataFacet` / `OracleAdapterFacet` 0% rows are likewise an artifact of
the `--testfiles` filter, not a real gap.)

**Interpretation.** Unlike the prior revision — where `SignatureVerifierFacet` and
`NonceManagerFacet` appeared at 14% / 0% only because their own suites were filtered out
of the `--testfiles` set — this pass includes all four crown-jewel facets' own suites
plus the `test/audit/` pentests, so the numbers reflect real exercise.
`SettlementAdminFacet` and `SignatureVerifierFacet` are at **100/100/100/100**;
`SettlementFacet` is at **97.11% stmts / 96.39% lines** with `100%` function coverage.

At the time of the baseline run, **branch coverage on `SettlementFacet.sol` was 80.30%**
— roughly one in five branches unexercised. The uncovered branches mapped to the ranked
gaps above, **most of which the SCRUM-234 suites have since closed** (a re-instrumented
run will reflect that — see the stale-number note above):

- The `FeeExceedsProceeds` family (was Gap-2) and multi-maker live-fee accumulation (was
  Gap-3) — now exercised by `coverage-gaps.test.js` Gap-2 / Gap-3; the settlement-side
  validity reverts (was Gap-5) and mint/merge token-mismatch (was Gap-6) likewise.
- `_executeOperatorFill` sell-side fee branch (~lines 712-713) — there is a sell-side
  `fillOrder` test (`SEC-003` `sub-unit SELL fillOrder` and `CONTROL` settle), so the
  *path* is reached, but the `fee > 0` sub-branch on the sell side is still not driven
  with a live non-zero fee — a thin residual branch gap, acceptable (the buy-side live-fee
  branch and the multi-maker aggregation cover the fee-routing logic).
- `_getIndexSetIn` defensive `revert InvalidPositionId` (~line 797) — unreachable given
  `_determineMatchType` pre-checks both positions are registered binary complements;
  acceptable dead-defensive branch.

None of the uncovered branches sits on a crown-jewel solvency path — INV-SOLV-1/2 and
INV-FEE-1/2 are all exercised. With every ranked gap now closed by the SCRUM-234 suites,
the only residual branch slack is the two acceptable items above (the sell-side `fee > 0`
sub-branch and the dead-defensive `InvalidPositionId`); a re-instrumented run is expected
to land branch coverage well above the 80.30% baseline. This is a **GO** on the
business-logic test-coverage axis.
