# SCRUM-236 — manual security review

_Reviewer: sc-manual-reviewer · 2026-05-24 · branch: SCRUM-236-SCFeeBankPullPayment · head: 5940ca7_

Frame: adversarial last-line read against the v2 design doc and the architecture / business-logic reviews. Read-only. Code locations cited from the working tree at head 5940ca7. Findings are written as recommendations only; no production file was modified.

## Verdict at a glance

| Section | Verdict | Headline |
|---|---|---|
| §A.1 Co-mingling META-CHECK | ACCEPT | All 5 production Diamond-as-`from` ERC20 sites preserve `balance >= outstandingPairs + accruedFees`; enumeration written below verbatim. |
| §A.2 Reentrancy boundary | ACCEPT | `withdrawFees` body (decrement + safeTransfer + emit) is fully inside `LibReentrancyGuard._nonReentrantBefore/After`. |
| §A.3 Access control | ACCEPT | Only gate is `LibDiamond.enforceIsContractOwner()`; no `marketMaker` / `operator` path. |
| §A.4 Integer arithmetic | ACCEPT | Explicit `w <= accrued` check + 0.8.20 default checked sub; underflow impossible. Uses cached `accrued` local. |
| §A.5 Event ordering | ACCEPT | Order is `decrement → transfer → emit`, all inside guard. Matches design §6.5 verbatim. |
| §A.6 Stuck `feeReceiver` | ACCEPT | `feeReceiver == 0` reverts `InvalidFeeReceiver` before any state mutation; banked funds preserved. |
| §A.7 `type(uint256).max` drain | ACCEPT | Resolved into local `w`; param not mutated; drain-when-empty resolves to `w == 0 → ZeroAmount`. |
| §A.8 Diamond self-transferFrom | ACCEPT | 4 trading-fee sites mirror `_settleMint`'s collateral pull; `slither-disable` suppression with documented rationale. |
| §A.9 Storage isolation | ACCEPT | Every read/write of `accruedFees` goes through `LibAdminConfigStorage.adminConfigStorage().accruedFees[...]`. |
| §A.10 Front-running | n/a | Admin-only; no MEV surface. Documented in design §6.10. |
| §A.11 Collateral allow-list precondition | ACCEPT | `LibAdminConfigStorage.AdminConfigStorage.isAllowed` NatSpec references INV-SOLV-4-revised; `invariants.md` carries the precondition paragraph. |
| §A.12 Harness invariants | ACCEPT-WITH-NOTE | All 5 expected pieces present and correct. One harness-only observation logged as FIND-1 (LOW). |
| §A.13 Pause integration | ACCEPT | `withdrawFees` is NOT gated by `notPaused` modifier or `tradingPaused` check. Matches design §6.13. |
| §A.14 Multisig owner composition | ACCEPT | No `tx.origin` / EOA-only check anywhere on the withdraw path; `enforceIsContractOwner` is Safe-compatible. |
| §B Drop of `feeReceiver` parameter | ACCEPT | Parameter genuinely removed from `_settleComplementary` / `_settleMint` / `_settleMerge` / `_executeOperatorFill` / `_settleAgainstMaker`; `_executeSettlement` no longer carries it; `ISettlement` external surface unchanged. SLOAD-per-`matchOrders` saving is real. |
| §C Reentrancy regression test | ACCEPT-WITH-FOLLOW-UP | Outer-ring framing is correct under the malicious-ERC20 reentry. FIND-2 (LOW) recommends adding a malicious-owner reentry case under SCRUM-213. |
| §D INV-SOLV-1 / -3 / -4 / -FEE-3 / -FEE-NEW in invariants.md | ACCEPT | All five restatements present and match the business-logic review's exact wording; per-token quantifier on INV-FEE-NEW; floor removed; standard-ERC20 precondition load-bearing paragraph. |
| §E Anything else (adversarial) | 1 finding | FIND-3 (INFO): `_executeOperatorFill` sell-side fee transfer has no `slither-disable` annotation despite being a "from msg.sender" call — cosmetic only. |

**Recommendation:** `READY-FOR-MERGE`

---

## §A — §6 architecture-review security-checklist items, walked

### §A.1 — Co-mingling META-CHECK: enumeration of Diamond-as-`from` ERC20 transfers

Verified `ripgrep`-equivalent walk of all `safeTransfer(` and `safeTransferFrom(address(this), ...)` callsites in `contracts/` (production sources only — harness and mocks excluded). FIVE production sites where the Diamond's ERC20 balance is debited. Each is paired with its symmetric `outstandingPairs` or `accruedFees` decrement.

| # | Site | Line | Type | Symmetric decrement | Preserves INV-SOLV-4? |
|---|------|------|------|----------------------|----------------------|
| 1 | `SettlementFacet._settleMerge` | `:751` `safeTransfer(taker.maker, takerNet)` and `:752` `safeTransfer(maker.maker, makerNet)` | Diamond → seller | `outstandingPairs -= f` via `_mergePositionsInternal` CTF burn; `accruedFees += takerFee + makerFee` (lines 762–767) | YES — net Diamond delta = `+f - (takerNet+makerNet) = +totalFees`; `accruedFees` Δ = `+totalFees`, `outstandingPairs` Δ = `-f`; LHS – RHS Δ = `0`. HOLDS. |
| 2 | `ConditionalTokensFacet._handlePayoutTransfer` (zero-fee branch) | `:234` `safeTransfer(recipient, amount)` | Diamond → redeemer | `outstandingPairs -= amount` (via CTF burn in `redeemPositions`); `accruedFees` unchanged (feeBps == 0 path) | YES — LHS Δ = `-amount`, RHS Δ = `-amount`. EQUAL. HOLDS. |
| 3 | `ConditionalTokensFacet._handlePayoutTransfer` (fee branch) | `:258` `safeTransfer(recipient, userAmount)` | Diamond → redeemer | `outstandingPairs -= amount`; `accruedFees += feeAmount` (line 248) | YES — LHS Δ = `-userAmount = -(amount - feeAmount)`, RHS Δ = `-amount + feeAmount = -(amount - feeAmount)`. EQUAL. HOLDS. |
| 4 | `LibCTFCondition._mergePositions` (user-facing merge) | `:60` `safeTransfer(sender, amount)` (guarded `sender != address(this)`) | Diamond → user | `outstandingPairs -= amount` (CTF burn at `:54`) | YES — LHS Δ = `-amount`, `outstandingPairs` Δ = `-amount`, `accruedFees` Δ = `0`. EQUAL. HOLDS. **NOTE:** `LibCTFCondition._mergePositionsInternal:198` has the same `safeTransfer` but the `sender != address(this)` guard at `:197` makes it dead code under SCRUM-236 (the only caller `_settleMerge` passes `address(this)`). Counted once for clarity. |
| 5 | `AdminConfigFacet.withdrawFees` (NEW) | `:276` `safeTransfer(feeReceiver, w)` | Diamond → feeReceiver | `accruedFees[token] -= w` (line 275, BEFORE the transfer) | YES — LHS Δ = `-w`, `outstandingPairs` Δ = `0`, `accruedFees` Δ = `-w`. EQUAL. HOLDS. |

**META-CHECK COUNT: 5 (matches the design doc / architect / business-logic review).**

No path decreases `balanceOf(Diamond, token)` without symmetrically decreasing `outstandingPairs[token]` or `accruedFees[token]`. INV-SOLV-4-revised holds across the production surface.

### §A.2 — Reentrancy guard boundary

`AdminConfigFacet.withdrawFees` lines 274–278:

```
LibReentrancyGuard._nonReentrantBefore();
acs.accruedFees[token] = accrued - w;       // effect
IERC20(token).safeTransfer(feeReceiver, w);  // interaction
emit Events.FeesWithdrawn(token, feeReceiver, w);  // log
LibReentrancyGuard._nonReentrantAfter();
```

The decrement, the safeTransfer, AND the event emission all sit between the `_nonReentrantBefore` / `_nonReentrantAfter` calls. Matches design §6.2 / §6.5 verbatim. Verified via the reentrancy-regression test at `test/unit/AdminConfigFacet/AdminConfigFacet.WithdrawFees.test.js:212-270` — the malicious-ERC20's reentry attempt during `safeTransfer` reverts inside the inner `withdrawFees` and the outer call completes cleanly with no double-spend.

### §A.3 — Access control

`withdrawFees` line 257: `LibDiamond.enforceIsContractOwner();` is the first instruction. No `marketMaker` or `operator` enforcement path. No second access-control check anywhere in the function body.

### §A.4 — Integer arithmetic

Lines 265–268 do `uint256 accrued = acs.accruedFees[token]; uint256 w = ...; if (w > accrued) revert InsufficientAccruedFees(w, accrued);`. The `accrued` value is cached once (one SLOAD) and used twice for the bound check AND the decrement at line 275 (`accrued - w`). The cached value prevents a race-with-yourself or a re-read inconsistency (which would matter only if there were intermediate external calls — there are none). 0.8.20 default checked subtraction backstops any logic error.

### §A.5 — Event ordering

Order at lines 275–277: storage decrement → `safeTransfer` → `emit FeesWithdrawn`. All three sit inside the reentrancy guard. An off-chain indexer never sees a `FeesWithdrawn` for a call that subsequently reverts (the emit is the last operation; any revert in the transfer reverts the entire tx, including the SSTORE).

### §A.6 — Stuck `feeReceiver`

Line 269–270: `address feeReceiver = acs.feeReceiver; if (feeReceiver == address(0)) revert Errors.InvalidFeeReceiver();`. This check is reached AFTER the `w == 0` and `w > accrued` checks but BEFORE the storage decrement and external call. A misconfigured (or never-set) `feeReceiver` reverts cleanly with no state change. Banked fees remain claimable after the owner re-runs `setFeeReceiver`. Verified by unit test `AdminConfigFacet.WithdrawFees.test.js:120-141`, which patches `feeReceiver` to `address(0)` via `hardhat_setStorageAt` and asserts the revert.

### §A.7 — `type(uint256).max` drain idiom

Line 266: `uint256 w = (amount == type(uint256).max) ? accrued : amount;` — local variable, parameter NOT mutated. Line 267: `if (w == 0) revert Errors.ZeroAmount();` — the drain-when-empty case (`max` resolved against `accrued == 0` yields `w == 0`) resolves to `ZeroAmount`, NOT a silent no-op. Single error path for "nothing to withdraw" (no `NoFeesAccrued` surface — collapsed to `ZeroAmount` per architect C1 Option B). Bound check `w > accrued` is **also** post-resolution. Matches design §6.7 pseudocode exactly. Unit-tested at `AdminConfigFacet.WithdrawFees.test.js:93-99` (drain-when-empty) and `:163-177` (drain happy path).

### §A.8 — Diamond self-transferFrom

The 4 trading-fee sites are structurally identical to the pre-existing `_settleMint` collateral pull pattern at lines 632–634:

| Site | Line | Pattern |
|------|------|---------|
| `_settleComplementary` buyerFee | `:562` | `IERC20(token).safeTransferFrom(buyerAddr, address(this), buyerFee);` |
| `_settleComplementary` sellerFee | `:570` | `IERC20(token).safeTransferFrom(sellerAddr, address(this), sellerFee);` |
| `_settleMint` takerFee | `:642` | `IERC20(token).safeTransferFrom(taker.maker, address(this), takerFee);` |
| `_settleMint` makerFee | `:648` | `IERC20(token).safeTransferFrom(maker.maker, address(this), makerFee);` |
| `_executeOperatorFill` buy-side fee | `:822` | `IERC20(token).safeTransferFrom(order.maker, address(this), fee);` |
| `_executeOperatorFill` sell-side fee | `:838` | `IERC20(token).safeTransferFrom(msg.sender, address(this), fee);` |

`_settleMerge` does NOT pull external collateral for fees — the collateral is already in the Diamond after `_mergePositionsInternal`, so it just accrues internally (lines 762, 766). Each pull is preceded by `if (fee > 0)` so fee-zero is a true no-op (no transfer, no SSTORE, no event). Confirmed by the unit test `AdminConfigFacet.WithdrawFees.test.js:276-317` (matchOrders with fee == 0 emits no `FeeAccrued`).

The `slither-disable-next-line arbitrary-send-erc20` annotation is present on every external pull (lines 552, 561, 569, 631, 633, 641, 647, 814, 821) with documented signature-authorization rationale matching the existing _settleMint pattern.

### §A.9 — Storage isolation

Every read/write of `accruedFees` goes through `LibAdminConfigStorage.adminConfigStorage().accruedFees[...]`:

- `SettlementFacet._settleComplementary:560,562-564,568,570-572`
- `SettlementFacet._settleMint:639,642-644,648-650`
- `SettlementFacet._settleMerge:760,762-763,766-767`
- `SettlementFacet._executeOperatorFill:820,822-824,837,839-840`
- `ConditionalTokensFacet._handlePayoutTransfer:225,248`
- `AdminConfigFacet.withdrawFees:265,275`
- `AdminConfigFacet.getAccruedFees:289`

No raw `assembly { sstore }` write into the slot; no cross-namespace direct access. The harness `IAdminConfig.getAccruedFees` and `withdrawFees` calls go through the same surface.

### §A.10 — Front-running

n/a. `withdrawFees` is `enforceIsContractOwner` only; non-owner txes revert pre-state. No mempool MEV surface.

### §A.11 — Collateral allow-list precondition

The standard-ERC20 precondition is documented in two places:

- `LibAdminConfigStorage.sol:30-34` — NatSpec on `isAllowed`: *"INV-SOLV-4-revised (SCRUM-236) assumes any allow-listed token is a standard ERC-20 — no fee-on-transfer, no rebasing, no callback hooks. Enforced by governance (this owner-only allow-list), not by code."*
- `audit/business-logic/invariants.md:153-159` — the load-bearing Precondition paragraph immediately above INV-SOLV-4-revised.

The architect's request ("a code comment in `addCollateralToken` referencing INV-SOLV-4-revised") was satisfied on the storage field's NatSpec rather than on the function body — that is structurally equivalent for any future reader of `addCollateralToken` (it reads the field's `isAllowed` mapping). ACCEPT as-is; the alternative would have been a duplicate comment on the function. No regression.

### §A.12 — Harness invariants (`DoefinInvariantHarness.sol`)

All 5 expected pieces present and correct:

**(a) Floor removed in `echidna_diamond_solvent`** — `:1165-1169` is exactly `return collateral.balanceOf(diamond) + ROUNDING_TOLERANCE >= outstandingPairs + accrued;` with `accrued = IAdminConfig(diamond).getAccruedFees(address(collateral))`. The pre-SCRUM-236 `(outstandingPairs / UNIT) * UNIT` floor is gone. `outstandingPairs` is now ratcheted per-wei (lines 541, 752, 812, 951, 984, 1092). HOLDS for sub-UNIT solvency too — CR-3291973200 is genuinely subsumed.

**(b) `echidna_fee_receiver_plus_accrued_only_grows`** — `:1205-1209` reads `balanceOf(FEE_RECEIVER) + accruedFees` and asserts `>= lastFeeReceiverPlusAccrued`. The ratchet `_syncFeeReceiverHighWater()` (`:689-695`) is called at the end of every `fuzz_*` wrapper. Correct rewrite (sum of bank + paid-out) — every fee debit increases the bank, every withdraw moves bank → FEE_RECEIVER (zero net change).

**(c) `echidna_fee_accounting_symmetry`** — `:1221-1225`: `sumFeeAccrued[address(collateral)] == accrued + sumFeesWithdrawn[address(collateral)]`. Per-token mapping; the architect-required `∀ token` quantifier is materially satisfied for the single-token harness (collateral is the only allow-listed token, so the per-token assertion IS the full quantifier here).

**(d) `fuzz_withdrawFees(uint128 rawAmount)`** — `:1000-1032`. Clamps rawAmount to `[1, accrued]` and takes the `type(uint256).max` drain branch when `rawAmount % 16 == 0` (~6% of ticks — matches business-logic review §4 refinement #4). Increments `sumFeesWithdrawn[collateral]` by the resolved `w` (correctly using `accrued` for the drain branch and `amount` otherwise). Empty-bank case exercises the `ZeroAmount` revert path explicitly.

**(e) `fuzz_redeem(uint128 rawAmount)`** — `:1044-1105`. Resolves the dedicated `redeemConditionId` market on first call, redeems outcome-A. **HARNESS-ONLY NOTE (FIND-1 below):** The resolution-fee branch of INV-FEE-NEW is technically exercised but only with `resolutionFeeBps == 0` (the harness does not call `setResolutionFeeBps`). `feeAmount` always computes to 0 in line 1082, so `_recordFeeAccrued(token, 0)` is a no-op (`amount > 0` guard at line 705). The FEE_KIND_RESOLUTION path with `feeAmount > 0` is not driven under fuzz. Not a production-grade issue — the resolution-fee accrual logic is unit-tested separately — but worth flagging.

The pre-existing `echidna_collateral_conserved` (`:1134-1145`) is unchanged and remains correct under SCRUM-236 (the closed-system sum is invariant — fees just relocate from FEE_RECEIVER's balance to the Diamond's balance within the same sum).

### §A.13 — Pause integration

`withdrawFees` is NOT decorated with the `notPaused` modifier and does not read `LibSettlementStorage.settlementStorage().tradingPaused` directly. Confirmed by grep. Matches design §6.13 — pausing trading must not block the owner from sweeping fees. ACCEPT.

### §A.14 — Multisig owner composition

Walked the path:
- `withdrawFees:257` calls `LibDiamond.enforceIsContractOwner()`.
- `LibDiamond.enforceIsContractOwner` compares `msg.sender` to `diamondStorage().contractOwner` — Safe-compatible (the Safe address is the owner, `msg.sender` IS the Safe at execution time).
- No `tx.origin` reference anywhere in `AdminConfigFacet` (grep clean).
- No `extcodesize == 0` or "is EOA" check on the withdraw path.

SCRUM-213 (parent branch context) composes cleanly. No code change required.

---

## §B — Drop of the `feeReceiver` parameter (dev footnote 2)

Walked the dispatch path:

- `matchOrders:84-169` — no `feeReceiver` local hoist. The pre-SCRUM-236 hoist of `acs.feeReceiver` to a local once-per-call is gone (line 126 comment confirms: *"SCRUM-236: `feeReceiver` is no longer hoisted — per-trade fee transfers were removed"*).
- `_settleAgainstMaker:181-225` — no `feeReceiver` parameter; calls `_executeSettlement` with 9 args (matchType + 8 actuals, no fee receiver).
- `_executeSettlement:469-487` — no `feeReceiver` parameter; dispatches to `_settleComplementary` / `_settleMint` / `_settleMerge` with 7 / 8 / 8 args respectively.
- `_settleComplementary:505-577`, `_settleMint:589-672`, `_settleMerge:680-770`, `_executeOperatorFill:785-843` — none take a `feeReceiver` parameter. Each helper that needs to credit `accruedFees` resolves `LibAdminConfigStorage.adminConfigStorage()` locally inside its `if (fee > 0)` block (lines 560, 568, 639, 760, 820, 837). This is one extra SLOAD per fee leg (vs the pre-bank one-per-`matchOrders` hoist) BUT removes the unconditional `acs.feeReceiver` SLOAD from every `matchOrders` call regardless of fee-zero.

**Gas claim** — re-verified by reading the call-graph:
- Pre-SCRUM-236: `matchOrders` did `address feeReceiver = acs.feeReceiver;` (1 SLOAD) once per call, regardless of how many legs.
- Post-SCRUM-236: each leg's `_settleX` does `LibAdminConfigStorage.adminConfigStorage()` (slot derivation, no SLOAD) inside `if (fee > 0)`; an `accruedFees[token]` SLOAD+SSTORE pair on the increment.

The "1 SLOAD per `matchOrders`" saving is real (the per-call hoist is gone). Per-leg work is unchanged for fee-zero legs and one extra SLOAD per fee-positive leg for the `accruedFees[token]` read — but that SLOAD is now necessary work (it backs the accumulator) so it doesn't count as overhead. Net: small win on the common case, neutral on the fee-bearing case.

**Interface check** — `ISettlement.sol:14-37` is unchanged. The parameter was internal-only; no external API impact. ACCEPT.

---

## §C — Reentrancy regression test (dev footnote 1)

Walked the mock's `transfer` hook (`MaliciousReentrantERC20.sol:46-59`):
- The hook fires inside `_update` only when `from == target` (the Diamond) AND `armed == true`.
- On the inner re-entry, `target.call(call)` invokes `withdrawFees(this, reentryAmount)` against the Diamond. The caller of that inner call is **the malicious ERC20 contract itself** (the call originates from inside the ERC20's `_update`, so `msg.sender` at the inner `withdrawFees` is the ERC20's address, not the original owner).
- `enforceIsContractOwner` evaluates `msg.sender != contractOwner` → reverts `NotContractOwner()` BEFORE the reentrancy guard at line 274.

So the dev's framing is correct: **access control is the outer ring**. The inner call cannot pass the ownership gate because the inner `msg.sender` is the malicious token, not the original owner. The reentrancy guard is the second-line defence — it would catch the inner call IF the inner caller were also the owner. The test acceptance of `ReentrantCall()` OR `NotContractOwner()` is appropriate.

The security property asserted by the outer call ("outer call either completes cleanly OR reverts cleanly with no partial state") IS proven: the test verifies (a) outer succeeded (`bad.balanceOf(feeReceiver) == seed`), (b) bank zeroed (`getAccruedFees(bad) == 0`), (c) inner re-entry recorded but FAILED (`reentryAttempted == true && reentrySucceeded == false`), and (d) the captured revert data matches one of the two known gates. No double-spend.

**FIND-2 (LOW, follow-up):** the test does not exercise a reentrancy attempt from a contract that IS the contract owner (e.g., a malicious Safe module under SCRUM-213). The two-layer defence WOULD still work — `LibReentrancyGuard._nonReentrantBefore` would catch the inner call after the outer call already set `_status = _ENTERED` — but it is structurally untested. Recommend adding a follow-up test using a `MaliciousReentrantOwner` mock (or, since the Safe address can be deterministically computed, transferring ownership to a small Safe-like mock that fires `withdrawFees` from its `receive` or `Module.execTransactionFromModule` callback). Not blocking; the access-control test is the more likely real-world failure mode and IS covered.

---

## §D — INV-SOLV-1, INV-SOLV-3, INV-SOLV-4, INV-FEE-3, INV-FEE-NEW in `invariants.md`

Walked each against the business-logic review's restated text:

**INV-SOLV-1 (`invariants.md:63-95`)** — the trailing fee-flow paragraph (lines 80–86) matches the business-logic review §2 verbatim: *"fees are transferred via `safeTransferFrom(payer, address(this), fee)` to the Diamond and credited to `LibAdminConfigStorage.adminConfigStorage().accruedFees[order.collateralToken]` … each accrual emits `Events.FeeAccrued(token, fee, FEE_KIND_TRADING)`."* The fuzz-encoding at lines 87–93 carries Option A (the architect-preferred split): `Δ(balanceOf(diamond)) == f + Δ(accruedFees[t])` with the explicit per-clause assertion. ACCEPT.

**INV-SOLV-3 (`invariants.md:128-148`)** — title changed from "never touches Diamond collateral" to "is collateral-neutral on the swap leg". Fee-flow text matches business-logic review §3: *"two `safeTransferFrom`s of the per-party fees from each counterparty INTO the Diamond … Diamond is a `to` for the two fee transfers"*. Fuzz-encoding preserves the buyer↔seller swap-leg assertion (`balanceOf(seller) Δ = collateralAmount - sellerFee`, `balanceOf(buyer) Δ = -(collateralAmount + buyerFee)`) — the load-bearing economic property is preserved as the third fuzz-clause. ACCEPT.

**INV-SOLV-4 (`invariants.md:150-207`)** — the load-bearing **Precondition** paragraph (lines 152–159) is verbatim from business-logic review §1 pin-down #3. The fuzz-encoding (lines 182–196) has the `accruedFees[t]` term added and is explicit that *"the harness must NOT apply `(outstandingPairs / UNIT) * UNIT`"*. Tolerance attribution (lines 197–202) matches pin-down #2 verbatim. Floor-removal pin (lines 203–206) names CR-3291973200 and references the harness location explicitly. The META-CHECK paragraph (lines 175–181) lists all 5 sites. ACCEPT.

**INV-FEE-3 (`invariants.md:366-389`)** — heading rewritten to "`accruedFees[token]` is the sole fee sink at settlement; `feeReceiver` is the sole withdraw destination". Body explicitly walks the two-stage flow (settlement → `accruedFees`, `withdrawFees` → `feeReceiver`). Operator-never-a-sink guarantee preserved. Matches business-logic review §5 recommendation verbatim. Status correctly flagged "HOLDS (strengthened)". ACCEPT.

**INV-FEE-NEW (`invariants.md:420-468`)** — per-token quantifier present at line 427 with the "ever-allow-listed-collaterals ∪ currently-allow-listed-collaterals" union (covers the delisting case per business-logic review §10(C)). Harness encoding pins the per-token counters at lines 450–457. Reset clause at lines 458–459. Conflict checks against INV-FEE-3 / -5 at lines 460–462 (matches business-logic review §5/§6 verdicts). The resolution-fee rounding pin (lines 463–467) requires harness-side `sumFeeAccrued` to use the SAME truncated `(amount * feeBps) / BPS_DENOMINATOR` the contract uses — which is exactly what the harness's `_recordFeeAccrued(collateral, feeAmount)` call in `fuzz_redeem` does (line 1082 computes `feeAmount` via the same `floorDiv` shape). ACCEPT.

---

## §E — Anything else (adversarial)

Tried to break the model along the 7 angles in the brief:

1. **Non-owner trigger of `withdrawFees` via callback / delegate / library indirection?** Walked the call graph from every external entrypoint into `withdrawFees`. The function is reachable only via direct selector lookup against `AdminConfigFacet`. No `delegatecall` from a user-controlled facet into `AdminConfigFacet`. No library helper calls `withdrawFees`. The reentrancy regression test (above) shows the only sneaky path — re-entry from a malicious-ERC20 hook — is double-defended by `enforceIsContractOwner` AND `LibReentrancyGuard`. CLEAN.

2. **Operator drain via fee-rate manipulation?** Operator cannot call `setMaxFeeRate` (owner-only). Operator can pass `fee` parameters but each is bounded by `_validateFee` (rate cap) AND `fee <= proceeds` (where applicable). Even with `maxFeeRateBps = 1000` (10%), maximally extracting fees through self-matching would still land them in `accruedFees`, NOT in the operator's pocket — `accruedFees` is owner-only swept. Operator can starve users (liveness, accepted in the trust model) but cannot drain. CLEAN.

3. **Fee-on-transfer ERC20 ALREADY on the allow-list (legacy footgun)?** Confirmed: the only defence is the precondition. No in-code guard (the architect explicitly recommended against one — same posture as Polymarket V2). The precondition is documented in `LibAdminConfigStorage.sol:30-34` AND `invariants.md:152-159` as load-bearing. If the owner adds a fee-on-transfer token, INV-SOLV-4-revised silently fails — but this is a known governance-attestation hazard, not a code bug. The audit report should flag this prominently for the deployer checklist (no SC fix possible without a balance-check-before-after wrapper on every `safeTransferFrom`, which the team explicitly declined). CLEAN as documented.

4. **`withdrawFees(token, type(uint256).max)` sandwiched by a settlement that decrements `accruedFees`?** Walked the flow: nothing in the contract DECREMENTS `accruedFees` outside `withdrawFees` itself. Settlement only INCREMENTS. A front-running settlement tx would only increase `accruedFees` before the withdraw, which means the drain captures more, not less. There is no inverse path. Even if a future facet added a `accruedFees -= x` site (e.g. a refund), the worst-case is the drain succeeds with `w = accrued_at_call_time` (correctly using the cached `accrued` local at line 265). CLEAN.

5. **Re-entrant ERC20 callback during `_settleX` fee-debit crediting `accruedFees` twice?** The `matchOrders` / `fillOrder` outer entrypoints are decorated with the `nonReentrant` modifier (lines 95, 276). Any re-entry from the `safeTransferFrom` hook during a fee debit would hit `LibReentrancyGuard._nonReentrantBefore` and revert `ReentrantCall()`. Double-crediting requires re-entering before the first SSTORE finalizes, which the outer guard prevents. CLEAN.

6. **`_handlePayoutTransfer` with `feeBps == 0 && feeReceiver != address(0)` producing `FeeAccrued(.., RESOLUTION, 0)` event spam?** No. Lines 232–237 explicitly short-circuit on `feeBps == 0`: just the transfer + return, no `accruedFees` SSTORE, no `FeeAccrued` emission. Fee-zero is a TRUE no-op. CR-3291973203 regression check holds. CLEAN.

7. **State transition where `accruedFees[token]` increments without `FeeAccrued` emission?** Walked every `accruedFees += ` site (8 sites: 2 in `_settleComplementary`, 2 in `_settleMint`, 2 in `_settleMerge`, 2 in `_executeOperatorFill`, 1 in `_handlePayoutTransfer`). Every one is immediately followed by `emit Events.FeeAccrued(...)` in the same block. No silent increment. The off-chain indexer's `sumFeeAccrued` reconstruction is correct. CLEAN.

**One INFO finding worth recording (FIND-3 below):** `_executeOperatorFill` sell-side fee transfer at line 838 lacks the `slither-disable-next-line arbitrary-send-erc20` annotation that every other Diamond-pulling site has. The transfer is structurally safe (`msg.sender` is the authenticated operator, see comment on lines 830–831), so the annotation is decorative — but the asymmetry with the buy-side at line 821 is cosmetic and may confuse a future reviewer or a Slither re-baseline.

---

## Findings

### FIND-1 · LOW · Harness `fuzz_redeem` does not exercise FEE_KIND_RESOLUTION with `feeAmount > 0`

- **Location:** `contracts/audit/DoefinInvariantHarness.sol:1044-1105` (specifically the `_recordFeeAccrued(collateral, feeAmount)` call at `:1094`)
- **What:** The harness does not call `IAdminConfig.setResolutionFeeBps(>0)` in its constructor (lines 493–502 only set `setMaxFeeRate`). So `resBps` at line 1081 is always 0, `feeAmount` at line 1082 is always 0, and the symmetry invariant trivially holds for the redemption path (0 == 0). The resolution-fee branch of INV-FEE-NEW (the one that exercises the `accruedFees[token] += feeAmount` path in `_handlePayoutTransfer:248`) is structurally unexercised under fuzz.
- **Reproducer:** Run Echidna; `fuzz_redeem` will fire, but `sumFeeAccrued` will not gain any resolution-fee contribution. A bug that asymmetrically credited resolution fees would still pass `echidna_fee_accounting_symmetry` because both sides stay at 0.
- **Spec citation:** business-logic review §10(A) requires the harness's `sumFeeAccrued` to be incremented by the SAME truncated `(amount * feeBps) / BPS_DENOMINATOR` the contract computes. The plumbing is right (line 1082 uses the same formula); only the seeded `resBps` is wrong.
- **Impact:** Harness-only; production code is correct. Lowers fuzz coverage on one of the two INV-FEE-NEW branches.
- **Recommendation:** Add a one-liner in `_configureProtocol` (around line 499): `IAdminConfig(diamond).setResolutionFeeBps(100);` (1%, well below `BPS_DENOMINATOR`). Re-baseline the harness — the existing `_recordFeeAccrued` plumbing then materializes a non-zero `feeAmount` per `fuzz_redeem` tick. This is a harness-only change.
- **Severity:** LOW (test-coverage gap, not a production defect).

### FIND-2 · LOW · No reentrancy test from a malicious OWNER context

- **Location:** `test/unit/AdminConfigFacet/AdminConfigFacet.WithdrawFees.test.js:212-270` (the existing reentrancy regression test)
- **What:** The existing test proves the OUTER ring (`enforceIsContractOwner`) catches reentry from a malicious-ERC20 contract. It does NOT prove the INNER ring (`LibReentrancyGuard`) catches reentry from a context where the inner caller IS the owner — e.g., a Safe module that registers itself as the owner and fires `withdrawFees` from a callback. The two-layer defence is structurally correct (and the inner guard would fire on the second call), but the property is untested.
- **Reproducer:** Add a `MaliciousReentrantOwner` mock that:
  1. Holds the Diamond ownership.
  2. In a `receive()` or similar callback fired from the malicious-ERC20's transfer hook, calls `Diamond.withdrawFees(...)` AGAIN.
  Without the `LibReentrancyGuard`, the inner call would pass `enforceIsContractOwner` (the malicious owner IS the owner) and double-spend. The test should assert the inner call reverts with `ReentrantCall()`.
- **Spec citation:** Design §6.2 — the guard MUST wrap the entire body precisely so that a malicious-owner context cannot exploit the gap. SCRUM-213 (Safe-as-owner) makes this a realistic scenario.
- **Impact:** Code is correct; coverage is incomplete. A future regression that moved the `_nonReentrantBefore` after the storage decrement would not be caught by the existing test.
- **Recommendation:** Add a `MaliciousReentrantOwner` test mirror under `contracts/mock/`. Track as a follow-up SCRUM ticket; non-blocking for this merge.
- **Severity:** LOW (defence-in-depth coverage gap).

### FIND-3 · INFORMATIONAL · Asymmetric `slither-disable` annotation on `_executeOperatorFill` sell-side fee transfer

- **Location:** `contracts/facets/SettlementFacet.sol:838`
- **What:** Every other Diamond-pulling `safeTransferFrom` site carries a `// slither-disable-next-line arbitrary-send-erc20` annotation with rationale. Line 838 (`_executeOperatorFill` sell-side fee pull: `IERC20(...).safeTransferFrom(msg.sender, address(this), fee)`) does not. The transfer is structurally safe (`msg.sender` is the authenticated operator, see comment lines 830–831) and Slither's `arbitrary-send-erc20` detector likely doesn't fire because `msg.sender` is not a parameter-derived address. But the asymmetry with the buy-side at line 821 — which DOES carry the annotation — is cosmetic and might confuse a future reviewer.
- **Spec citation:** none; this is style consistency.
- **Recommendation:** Add the annotation to line 838 for consistency (no behaviour change). Alternatively, remove the annotation from line 821 if the operator-`msg.sender` argument applies there too. Pick one and apply consistently.
- **Severity:** INFORMATIONAL (style only; no security implication).

---

## Recommendation

**`READY-FOR-MERGE`** with the three minor findings above tracked as non-blocking follow-ups.

The SCRUM-236 implementation cleanly executes the v2 design doc. The §6.1 META-CHECK enumeration is complete and verified (5 sites). All architectural-review §6 items 1–14 are satisfied; the business-logic review's invariant restatements are present verbatim in `invariants.md`; the harness is faithful to the new model with the floor removed and the per-token symmetry invariant in place. The reentrancy regression test proves the outer-ring property; the inner-ring property is structurally correct but untested (FIND-2). The harness's `fuzz_redeem` driver materially exercises the resolution path but with `resolutionFeeBps == 0`, leaving one INV-FEE-NEW branch (resolution-fee positive case) under-fuzzed (FIND-1).

No CRITICAL, no HIGH, no MEDIUM. Three findings: 2 LOW + 1 INFO, all non-blocking.

The branch is safe to land on `v3/dev` ahead of the audit freeze.
