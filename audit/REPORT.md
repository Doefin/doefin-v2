# Doefin v3 — Mainnet-Readiness Audit Report

**Subject:** Doefin v3 EIP-2535 Diamond — settlement core, for a fresh Base mainnet deployment
**Commit audited:** `015097c1c7f8b6a5d70be21972eb345bf1082c06` · branch `feature/mainnet-audit-system`
**Date:** 2026-05-17 · **Method:** multi-agent audit — 5 tools + 4 domain reviews + dual-engine fuzzing

---

## Verdict: CONDITIONAL-GO

The audit found **2 High-severity mainnet blockers** (SEC-001, SEC-002). **Both have been fixed and re-verified `fixed-clean`** — so the project is no longer NO-GO. It is **not yet a full GO**: 4 Medium findings remain open and each needs either a fix or a written accepted-risk decision, and 2 items are deferred pending a team decision / backend coordination.

- **NO-GO → resolved:** SEC-001, SEC-002 fixed-clean (Slither unchanged 27→27, all 6 fuzz invariants hold post-fix, 84/84 SettlementFacet tests pass incl. 13 new + negative-control).
- **For a full GO:** resolve SEC-004, SEC-005, SEC-006, BIZ-001 (fix or accept-risk with a written rationale); decide SEC-007 (design intent) and GAS-001 (backend-coordinated ABI change).
- **No Critical findings. No storage/selector collision. No facet over 24 KiB. All economic invariants hold under 50k-call Echidna + Medusa fuzzing.**

---

## Executive summary

The Doefin v3 settlement core (`SettlementFacet`, `SignatureVerifierFacet`, `NonceManagerFacet` + admin/access/oracle-adapter facets) was audited at a frozen commit by a coordinated agent team across four domains — security, business logic, gas, complexity — supported by Slither, Mythril, Echidna, Medusa, and solhint, plus a purpose-built Solidity invariant-fuzzing harness that deploys the full Diamond in-process.

**27 confirmed findings** (after deduplication and false-positive triage of 27 raw Slither results + 3 Mythril results): 0 Critical, 2 High, 7 Medium, 12 Low, 6 Informational. The two High findings are both *new* (not regressions of the prior SC-008 review) and both reachable only by a **compromised operator** — but per the audit's trust model that is a mainnet-blocking severity. Both are now fixed.

The prior SC-008 **CRITICAL-1** (price-sum solvency) is confirmed **resolved** — the current remainder-based collateral math makes conservation a structural identity, corroborated by 50,000-call fuzzing. Six minor regression items remain open, none at Critical/High severity.

---

## Scope & method

**In scope:** `SettlementFacet`, `SignatureVerifierFacet`, `NonceManagerFacet`, `AccessControlFacet`, `AdminConfigFacet`, `MarketDataFacet`, `ERC1155Facet`/`ERC1155ReceiverFacet`, `OracleAdapterFacet`, `OracleManagerFacet`, `BlockScholesOracleAdapter`, and their libraries. **Out of scope** (per `audit-exclusion-guidance.md`): Gnosis-imported CTF, block-header v1, Diamond-reference boilerplate, mocks.

**Trust model:** the operator is trusted for liveness and correct matching; the audit explicitly enumerates compromised-operator impact as High-context.

**Tooling:** all tools run in a Dockerized Trail of Bits `eth-security-toolbox` (amd64). Slither (whole-project), Mythril (per facet), Echidna + Medusa (against `contracts/audit/DoefinInvariantHarness.sol`), solhint, hardhat-gas-reporter, solidity-coverage. See `security/` and `security/audit-protocol.md`.

---

## Findings

| Severity | Count | Status |
|---|---|---|
| Critical | 0 | — |
| High | 2 | **both fixed-clean** (SEC-001, SEC-002) |
| Medium | 7 | 1 fixed (SEC-003); 4 open (SEC-004/005/006, BIZ-001); 2 deferred (SEC-007, GAS-001) |
| Low | 12 | 2 fixed (BIZ-004, BIZ-006); 3 accept-risk; 7 open (cleanup) |
| Informational | 6 | open (documentation / dead-code cleanup) |

Full per-finding detail: **`audit/findings-ledger.md`**. False-positive justifications: **`audit/triage-notes.md`**.

### Mainnet blockers — FIXED

- **SEC-001 (High)** — `_settleComplementary` never verified `taker.collateralToken == maker.collateralToken` (the mint/merge paths did). A compromised operator could pair a maker SELL in token A with a taker BUY in token B, settling wholly in token B — mispricing by up to 1e12×. **Fixed:** token-match guard added as the first statement of `_settleComplementary`.
- **SEC-002 (High)** — no collateral-allowlist / non-zero-`unit` gate on the settlement hot path; a zero-fee order against a removed or mis-configured token settled at a wrong price with no revert. **Fixed:** central gate in `_validateOrder` (`isAllowed` + `unitPerPair != 0`), covering both `matchOrders` and `fillOrder`.

### Phase 5 — fixes applied (5, all `fixed-clean`)

| ID | Sev | Fix |
|---|---|---|
| SEC-001 | High | `_settleComplementary` token-match guard |
| SEC-002 | High | `_validateOrder` collateral-allowlist + non-zero-unit gate |
| SEC-003 | Med | `_executeOperatorFill` zero-collateral + `< fee` guards (prevents free position tokens + underflow) |
| BIZ-004 | Low | `_validateOrder` rejects `pricePerToken > unit` |
| BIZ-006 | Low | `_validateOrder` rejects `side > 1` |

All confined to `SettlementFacet.sol`; no storage-layout or selector change (all upgrade-safe); +0.66 KiB (`SettlementFacet` 13.998 KiB, well under 24 KiB). 13 new tests, negative-control verified. Changes are in the working tree, **not committed** — pending your review. Detail: **`audit/fixes/changelog.md`**.

### Phase 6 — re-verification

| Check | Result |
|---|---|
| Slither, post-fix | 27 results — identical to pre-fix; no new finding from the guards |
| Echidna, post-fix | 15,072 calls — all 6 invariant properties pass |
| SettlementFacet tests | 84 passing, 0 failing (13 new) |
| Full suite | 517 passing (the 1 failure is pre-existing, out-of-scope CTF code) |
| Negative control | fixes reverted → 10 fix-dependent tests fail → fixes restored |
| Diff review | clean — 5 pure input-validation reverts, no fix-induced regression |

---

## Required before a full GO

**Resolve each (fix, or accept-risk with a written rationale + operational mitigation):**

- **SEC-004 (Med)** — domain-separator cache has no `chainId` guard and is inconsistent across the three facets (recompute everywhere, or add `cachedChainId`). Regression of NEW-2/NEW-3.
- **SEC-005 (Med)** — ECDSA recovery is triplicated; the `OracleManagerFacet` copy lacks the malleability check. Extract one `LibSignature`. Regression of REMAINING-1.
- **SEC-006 (Med)** — per-order `feeRateBps` honoured up to 5%; `.claude/CLAUDE.md` mis-states the fee recipient. Correct the doc; consider lowering `MAX_FEE_RATE_BPS`.
- **BIZ-001 (Med)** — `_settleMerge` can over-remit fees if `fee >= payout` (latent — gated today by the 5% cap; not reachable now, but re-arms on any future cap change). Use checked subtraction; add the merge-with-non-zero-fee test.

**Decide (deferred — not blocking, but settle before launch):**

- **SEC-007 (Med)** — Mint/Merge crossing checks allow an unfair-but-collateral-conserving settlement; confirm whether the price slack is intentional (SCRUM-121 "effective price"). If not, tighten to `== unit`.
- **GAS-001 (Med)** — 4 dead `DoefinOrder` fields cost ~27% of order calldata on Base L2. Removal is a breaking EIP-712/ABI change — coordinate byte-for-byte with the backend before the fresh deploy, or apply BIZ-008's NatSpec note instead.

**Recommended cleanup (Low/Info — non-blocking):** SEC-011 (operator-change event + zero-address guard), SEC-012/013/014 + CPX-A* (dead v2.0 code, double event emit, doc nits), BIZ-002/005, CPX-003/005/006/007, GAS-002..007. Accept-risk noted for SEC-008/009/010.

---

## Regression checklist (vs SC-008 reviews)

2 resolved, 6 open, 0 regressed — **no regression item open at Critical/High**.

| Item | Verdict |
|---|---|
| CRITICAL-1 (price-sum solvency) | **resolved** — structural; fuzzing confirms |
| NEW-4 (merge dust) | **resolved** — remainder math distributes the full fill |
| NEW-5 (zero-collateral fill) | **resolved this audit** — fixed as SEC-003 |
| NEW-2, NEW-3 (domain separator) | open (Med) → SEC-004 |
| REMAINING-1 (duplicate verifier) | open (Med) → SEC-005 |
| REMAINING-2, REMAINING-3 (dead v2.0 code) | open (Info) → SEC-012, SEC-013 |

---

## Fuzzing, coverage, size

- **Echidna** — 50,000-call campaign + a 15,072-call post-fix run: all 6 `echidna_*` invariants pass (collateral conservation, Diamond solvency, no-overfill, nonce monotonicity, fee-receiver growth, reentrancy latch).
- **Medusa** — 22/22 tests pass (same 6 invariants, second engine).
- **Coverage** — `SettlementFacet` 92.8% lines / 73.6% branch; uncovered branches map to BIZ-005 and the merge-fee gap (BIZ-001).
- **Size** — every in-scope facet under the 24 KiB EIP-170 limit; `SettlementFacet` 13.998 KiB post-fix.

---

## Residual risk register

- **Operator key** — the entire model trusts the operator for correct matching. SEC-001/002/003 are all compromised-operator findings now fixed, but operator-key security (HSM / multisig / monitoring) remains the primary operational control. Recommend documented key handling + a settlement-anomaly monitor + tested use of `pauseTrading`.
- **Admin misconfiguration** — `unitPerPair` / allowlist are owner-set; SEC-002's gate now fails-closed on a removed token, but a *wrong non-zero* `unitPerPair` is still mispriced. Recommend a deploy-time config checklist.
- **Cross-repo EIP-712 coupling** — `LibDoefinOrder` matches the backend encoder byte-for-byte today; GAS-001 (if taken) and any struct change must be coordinated across both repos.
- **Out-of-scope** — CTF and block-header v1 were excluded; the 1 pre-existing failing test (`BatchSubmissionBugRepro`) is in CTF code and should be triaged by that suite's owner before launch.

---

## Go / No-Go criteria

| Gate criterion | Status |
|---|---|
| Zero confirmed Critical/High not fixed-clean | ✅ (2 High, both fixed-clean) |
| No regression item open at Critical/High | ✅ |
| All economic invariants hold under fuzzing | ✅ (Echidna + Medusa) |
| No storage-collision / selector-collision finding | ✅ |
| No in-scope facet over 24 KiB | ✅ |
| No Critical/High invariant with zero test coverage | ✅ |
| Every remaining Medium fixed or accept-risk-noted | ⏳ SEC-004/005/006, BIZ-001 open |

**→ CONDITIONAL-GO.** The mainnet blockers are cleared; the gate to a full GO is the 4 open Medium findings (fix or written accept-risk) and the 2 deferred decisions.

---

## Artifacts

| File | Contents |
|---|---|
| `audit/00-scope.md` | Frozen scope, trust model, regression checklist |
| `audit/findings-ledger.md` | All 27 findings, full ledger schema |
| `audit/triage-notes.md` | False-positive justifications |
| `audit/findings/` | Raw per-domain reviews (security, business-logic, complexity) |
| `audit/business-logic/` | 30 invariants + test-coverage map |
| `audit/gas/report.md` | Gas findings |
| `audit/fixes/changelog.md` | Phase 5 fix changelog |
| `audit/output/` | Raw Slither / Mythril / Echidna / Medusa output |
| `audit/reverify/` | Phase 6 post-fix Slither + Echidna |
| `security/` | The Dockerized toolchain + the coordination protocol |
