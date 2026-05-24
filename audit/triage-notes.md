# Doefin v3 Mainnet Audit — Triage Notes

Written justification for every `false-positive` and `wont-fix` call, and the adjudicated cross-domain conflicts. Companion to `audit/findings-ledger.md`.

## False-positive justifications

**FP-1 — Slither `divide-before-multiply` (`LibOracleAdapter.getTimestampBucket`).** Gate (c) — detector misreads an intentional pattern. `(timestamp / BUCKET) * BUCKET` is a deliberate floor-to-bucket; divide-then-multiply *is* the algorithm. No precision-loss bug.

**FP-2 — Slither `uninitialized-local` (`matchOrders` `totalTakerFee`, `totalMakerFill`).** Gate (c). Both are loop accumulators; the EVM zero-initializes locals and they are summed with Solidity 0.8 checked addition. Reading either before the loop yields a defined 0.

**FP-3 — Slither `calls-loop` (`OracleManagerFacet.updatePrice`).** Gate (c). The loop is bounded by an owner-configured `adapterPriority` array; every external call is wrapped in `try/catch`; it is off the settlement path (v3 `SettlementFacet` does not consult oracle storage).

**FP-4 — Slither `timestamp` (7 hits).** Gate (d) — documented, intentional design. All uses are `block.timestamp` comparisons for order-expiry and oracle-staleness — coarse-grained windows (minutes to days). A miner's ±~15s influence cannot meaningfully shift them; no randomness is derived from `block.timestamp`. It is the correct primitive for time-based expiry.

**FP-5 — Slither `assembly` (4 of 7 hits — the `LibDoefinStorage` / `LibSettlementStorage` slot accessors).** Gate (c). These are the standard EIP-2535 / EIP-7201 namespaced-storage accessors: a `keccak256`-derived constant slot bound to a struct pointer via inline assembly — the canonical Diamond storage pattern. (The other 3 `assembly` hits, in the verifier `_recoverSigner` blocks, are NOT false-positive — they corroborate SEC-005.)

**FP-6 — Mythril SWC-113 "Multiple Calls in a Single Transaction" (`SignatureVerifierFacet.verifyOrderSignature`).** Gate (c). The function makes exactly one external call — a `view` `IERC1271.isValidSignature` on the maker's own SCW. There is no prior call whose failure could block it, and it is a pure verification helper with no state to leave inconsistent.

**FP-7 — Mythril SWC-116 "Dependence on predictable environment variable" (`NonceManagerFacet.isOrderValid`, `block.timestamp`).** Gate (d) — same rationale as FP-4. `order.expiration` is a coarse-grained, maker-signed `uint64` timestamp; miner drift is immaterial; no randomness is derived from it.

**Not dismissed:** Slither `arbitrary-send-erc20` (9 hits) → folded into SEC-001; `low-level-calls` (1 hit) → folded into SEC-005. These are deduplicated into confirmed findings, not gated out.

## wont-fix

None. No finding carries `status: wont-fix`. The `accept-risk` findings (SEC-008, SEC-009, SEC-010) remain `confirmed` with a written rationale in their ledger blocks — accepted with orchestrator sign-off, not dismissed. The `defer` findings (SEC-007, BIZ-008, CPX-005, CPX-A2, CPX-A4567, GAS-001) likewise stay `confirmed`.

## Adjudicated cross-domain conflicts

- **GAS-001 vs BIZ-008** — removal supersedes documentation; not contradictory. GAS-001 deferred (breaking ABI change, needs backend coordination, non-blocking). BIZ-008's NatSpec note is the fallback if GAS-001 slips past launch.
- **GAS-006 vs CPX-006** — the aggregate fill-sum is a consistency check, not a solvency guard (per-maker and taker `_checkFillAmount` independently bound every fill). Deferring it weakens nothing. Apply both as one combined work-item.
- **GAS-003 vs SEC-014** — unrelated (SEC-014 is the `ApprovalForAll` event; GAS-003 is fee `Transfer` logs). No real conflict. Constraint recorded: do not coalesce in a way that drops a per-leg log a distinct economic party relies on.
- **GAS-004 / GAS-007 vs Security** — both gas findings explicitly preserve every `revert`/bounds guard. No "remove a check" recommendation survives triage.
- **SEC-007 vs BIZ-001** — same function (`_settleMerge`), distinct bugs: SEC-007 is the price-sum fairness window; BIZ-001 is the latent fee-over-remit. Both kept.
