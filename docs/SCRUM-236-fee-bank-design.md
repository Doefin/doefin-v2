# SCRUM-236 — SC fee bank · pull-payment model · design **v2**

> Branch: `SCRUM-236-SCFeeBankPullPayment` (off `v3/dev`)
> Status: **v2 — architecture review absorbed; pending business-logic review**
> Architecture review: `audit/SCRUM-236-architecture-review.md` (PROCEED-WITH-REVISIONS, all 7 REVISE items absorbed below)
> Origin: Surfaced by [CR-3291973203](../audit/coderabbit-triage/PR-23.md) on PR #23 (`_handlePayoutTransfer` zero-fee bypass DoS). The user pivoted from a narrow patch to a unified pull-payment fee bank for both trading and resolution fees.

## Changelog

- **v1** (commit `5af6d64`): initial design.
- **v1.1** (commit `87eedd3`): sharpened co-mingling framing — explicit that co-mingling is a NEW concern introduced by this redesign, not a pre-existing condition.
- **v2** (this revision): architecture review absorbed. Section-by-section deltas:
  - §3: explicit choice rationale for `LibAdminConfigStorage` (user call against architect's slight lean for new namespace); `__gap` precision; storage-layout-snapshot CI gate.
  - §4: `withdrawFees` gains `token == address(0)` guard; consolidated to one parameterized `InsufficientAccruedFees(requested, available)` error; backend indexer migration is **required**, not optional.
  - §5: floor removal in `echidna_diamond_solvent` is loud (not "augment", "**remove**"); standard-ERC20 collateral precondition explicit; INV-FEE-NEW has per-token quantifier; INV-SOLV-1/3 reword constraint spelled out.
  - §6: §6.1 meta-check requires enumerating every Diamond-as-`from` transfer; §6.2 reentrancy-guard wraps the entire withdraw body; §6.5 event-emit ordering pinned; new §6.11 collateral allow-list; new §6.12 harness invariants (rewrites + `fuzz_withdrawFees` driver); new §6.13 pause integration (no gate); new §6.14 multisig owner composition.
  - §7: new unit tests for `fee == 0`, delisted-token withdraw, reentrancy regression; per-token quantifier on the symmetry invariant; new `fuzz_withdrawFees` driver; renamed `echidna_fee_receiver_plus_accrued_only_grows`.
  - §8: all 4 open questions resolved with the architect's confirmations.
  - §9: workstream sequencing — sc-business-logic runs **in parallel** with architecture (this v2 was the trigger to run it next).
  - §10: backend indexer migration tracked.
  - §11: storage-snapshot regen + `settlement_abi.py` event signature additions made explicit.

## 1. Problem statement (today's model)

Two distinct on-chain fee transfers, both routed to a single configurable address (`acs.feeReceiver`):

| Fee type | Charged in | Recipient | Per-trade cost |
|---|---|---|---|
| Trading fee (operator-supplied, capped by `maxFeeRateBps`) | `SettlementFacet._settleComplementary` / `_settleMint` / `_settleMerge` / `_executeOperatorFill` | `safeTransferFrom(payer, acs.feeReceiver, fee)` per leg | 1× SSTORE + 1× external call per fee leg |
| Resolution fee (% of redemption, configured by `acs.resolutionFeeBps`) | `ConditionalTokensFacet._handlePayoutTransfer` | `safeTransfer(acs.feeReceiver, feeAmount)` | 1× SSTORE + 1× external call |

### Symptoms

1. **DoS on zero-fee deploys** (the original CR finding). If `resolutionFeeBps == 0 && feeReceiver == address(0)` (both Solidity defaults on a fresh v3 mainnet deploy), `redeemPositions` reverts because `_handlePayoutTransfer` checks `feeReceiver == 0` before the `feeBps == 0` short-circuit. Same shape on the trading side: `setMaxFeeRate(0)` with `feeReceiver == 0` is the only safe combination today.
2. **`feeReceiver` is hot.** A misconfigured `feeReceiver` mid-life affects every subsequent trade and redemption instantly. There is no "draft → review → withdraw" window.
3. **Per-leg gas.** Hot-path settlement pays a `safeTransferFrom` to `feeReceiver` on every fee leg — ~20–40k gas per leg that does not need to happen on every trade.
4. **No unified accounting on-chain.** Trading-fee revenue and resolution-fee revenue are indistinguishable in the chain state; both just leave the Diamond.

## 2. Proposed model — pull-payment fee bank

Both fee types **accrue inside the Diamond** (collateral-token balance) and are recorded in a single `mapping(address token => uint256)` accumulator. The admin withdraws on-demand via a new `withdrawFees(token, amount)` function that transfers from the Diamond to `acs.feeReceiver`.

```
                              CURRENT                                NEW
trade leg:    safeTransferFrom(payer, feeReceiver, fee)    safeTransferFrom(payer, address(this), fee)
                                                            acs.accruedFees[token] += fee
                                                            emit FeeAccrued(token, fee, TRADING)

redeem leg:   safeTransfer(feeReceiver, feeAmount)         (collateral already in Diamond)
                                                            acs.accruedFees[token] += feeAmount
                                                            emit FeeAccrued(token, feeAmount, RESOLUTION)

withdraw:     n/a                                          admin only:
                                                            withdrawFees(token, amount)
                                                              if token == address(0): revert InvalidTokenAddress
                                                              uint256 w = (amount == type(uint256).max)
                                                                  ? acs.accruedFees[token] : amount
                                                              if w == 0: revert ZeroAmount
                                                              if w > acs.accruedFees[token]:
                                                                  revert InsufficientAccruedFees(w, acs.accruedFees[token])
                                                              if acs.feeReceiver == address(0): revert InvalidFeeReceiver
                                                              acs.accruedFees[token] -= w     // effect
                                                              safeTransfer(acs.feeReceiver, w) // interaction
                                                              emit FeesWithdrawn(token, acs.feeReceiver, w)
                                                              (all of the above inside one
                                                              LibReentrancyGuard window)
```

### What this eliminates / improves

| Concern | Result |
|---|---|
| Zero-fee deploy DoS | **Eliminated.** `feeReceiver` only matters at withdraw time. |
| Misconfigured `feeReceiver` mid-life | Fees stay safely banked; admin fixes `feeReceiver`, then withdraws. No funds at risk. **Strict improvement** on the admin-error vector. |
| Per-leg gas (hot path) | Trading legs drop one external call; net ~20–40k gas saved per fee leg. Redemption leg: same delta. |
| Unified accounting | Single `accruedFees[token]` accumulator. Off-chain analytics derive trading vs resolution from the `FeeAccrued.kind` enum. |
| Audit surface | Smaller — one withdraw function with one access-control gate, vs the per-trade transfer surface. |

### What it does NOT change

- The EIP-712 `DoefinOrder` schema. No signed-field change.
- The backend match-engine ABI. Operator still passes per-leg `fee` *amounts* to `matchOrders` / `fillOrder`.
- The frontend. No new user-visible field.
- `MAX_FEE_RATE_BPS_CAP = 1000` (10%) ceiling.
- `_validateFee` (cap + `fee <= proceeds`) — every leg still validates before accrual.
- `resolutionFeeBps` mechanism — same percentage logic; only the recipient flow changes.

## 3. Storage additions (EIP-7201; fresh v3 deploy ⇒ layout change is free)

### (a) Placement — `LibAdminConfigStorage` (user call)

`accruedFees` is added to the existing `LibAdminConfigStorage.AdminConfigStorage` struct (namespace `doefin.admin-config.storage`):

```solidity
/// @notice Fees accrued in the Diamond per collateral token, awaiting admin withdrawal.
/// @dev SCRUM-236 — pull-payment model. Increments on every settlement leg (trading) and
///      every `redeemPositions` (resolution). Decrements only via `withdrawFees`.
/// @dev INV-SOLV-4 (revised): `balanceOf(Diamond, token) >= outstandingPairs[token] + accruedFees[token]`.
mapping(address token => uint256 accrued) accruedFees;
```

**Why this namespace, not a new `LibFeeBankStorage`:** the architect's review (§3(a)) leaned slightly toward a dedicated `doefin.fee-bank.storage` namespace on SRP grounds — separation of runtime accumulator from config policy, symmetry with `LibSettlementStorage`. The author's call is to keep it in `LibAdminConfigStorage` because the fee policy (`feeReceiver`, `resolutionFeeBps`, `maxFeeRateBps`) already lives there and `accruedFees` is the *escrowed counterpart* of that policy — a single read/write surface for fee administration. If the namespace ever needs to split (e.g. if treasury rebalancing primitives land), the EIP-7201 namespace move is mechanical. Recorded explicitly so a future reviewer sees the trade-off was considered, not defaulted.

### (b) `__gap` precision

EIP-7201 namespaces reserve a 256-slot aligned region per the formula in [LibAdminConfigStorage.sol:12-13](../contracts/libraries/LibAdminConfigStorage.sol#L12-L13). The struct can grow without a `__gap` *until it reaches 256 slots*. The current addition (one slot — a single `mapping` slot) is well within that envelope, so no `__gap` change is needed.

### (c) Storage-layout-snapshot CI gate

Adding `accruedFees` to `AdminConfigStorage` is an **intentional** layout change. The implementer must regenerate the snapshot at [test/storage/storage-layout-snapshot.test.js](../test/storage/storage-layout-snapshot.test.js) with `UPDATE_STORAGE_SNAPSHOT=true npx hardhat test test/storage/`. The snapshot regen lands in the same commit as the storage change.

## 4. ABI deltas

### Added

| Surface | Selector | Access | Notes |
|---|---|---|---|
| `AdminConfigFacet.withdrawFees(address token, uint256 amount)` | new | `onlyOwner` (`LibDiamond.enforceIsContractOwner`) | `amount = type(uint256).max` ⇒ drain. Reverts `InvalidTokenAddress` (token == 0), `ZeroAmount` (resolved amount == 0), `InsufficientAccruedFees(requested, available)` (resolved amount > accrued), `InvalidFeeReceiver` (feeReceiver == 0). Emits `FeesWithdrawn`. |
| `AdminConfigFacet.getAccruedFees(address token) returns (uint256)` | new | view | Convenience getter for off-chain. |
| `Events.FeeAccrued(address indexed token, uint256 amount, uint8 kind)` | new | — | `kind`: `0 = TRADING`, `1 = RESOLUTION`. Constants live in `LibConstants` (`FEE_KIND_TRADING`, `FEE_KIND_RESOLUTION`) to avoid magic numbers in settlement code. Emitted on every fee debit; `token` indexed for filterable queries. |
| `Events.FeesWithdrawn(address indexed token, address indexed feeReceiver, uint256 amount)` | new | — | Emitted on every successful `withdrawFees`. Deliberately no `kind` — by withdraw time fees are fungible; `FeeAccrued` already recorded the split. |
| `Errors.InsufficientAccruedFees(uint256 requested, uint256 available)` | new | — | Parameterized for off-chain debuggability (matches the `FillAmountMismatch(sumOfMakerFills, takerFillAmount)` precedent). Subsumes the originally-proposed `NoFeesAccrued` — the empty-bank case fires `ZeroAmount` after the `type(uint256).max → 0` resolution. |

### Removed / renamed

| Surface | Status |
|---|---|
| `Events.FeeCharged(address feeReceiver, uint256 amount)` | **Removed.** Replaced by `FeeAccrued` (more informative — adds `token` indexer and `kind`) and `FeesWithdrawn`. **Backend indexer migration is REQUIRED** (see §10/§11) — `match-engine/app/utils/settlement_abi.py` and any `shared/scw/encoder.py` event listener must drop `FeeCharged` and add `FeeAccrued` + `FeesWithdrawn`, otherwise the backend silently stops seeing fee flow. |
| Per-leg external transfers to `feeReceiver` | **Removed** from `_settleComplementary`, `_settleMint`, `_settleMerge`, `_executeOperatorFill`, `_handlePayoutTransfer`. Replaced by `acs.accruedFees[token] += fee` + `emit FeeAccrued`. When `fee == 0`, **no accrual increment AND no `FeeAccrued` emission** — preserves the CR-3291973203-regression-check behaviour. |

### Unchanged

| Surface | Status |
|---|---|
| `setFeeReceiver(address)` | Unchanged — `feeReceiver` is now used as the withdraw destination instead of the per-trade recipient. The `NoChangeRequired` no-op guard stays. |
| `setMaxFeeRate(uint16)` | Existing surface. The `NoChangeRequired` no-op guard MUST be added per **CR-3291973202** (in scope for SCRUM-236). |
| `setResolutionFeeBps(uint16)` | Unchanged. |
| `_validateFee` | Unchanged (cap + `fee <= proceeds`). |
| `feeReceiver` (storage field) | Unchanged. Validation moves from per-trade reverts to a withdraw-time revert. |

## 5. Invariant updates

### Why this matters — framing

The current v3 protocol deliberately keeps fees OUT of the Diamond's ERC20 balance. INV-SOLV-1 (mint, [audit/business-logic/invariants.md:80-81](../audit/business-logic/invariants.md#L80-L81)) states *"fees are transferred separately, directly to feeReceiver, and never enter the Diamond's collateral balance."* INV-SOLV-3 (complementary, [audit/business-logic/invariants.md:120-123](../audit/business-logic/invariants.md#L120-L123)) states *"the Diamond's own ERC-20 balance and its own ERC-1155 balance are unchanged."* So today the Diamond's ERC20 balance has exactly one job: back outstanding positions minted via `splitPosition` / `_settleMint` (the INV-SOLV-4 cumulative backing).

**SCRUM-236 changes that.** After this redesign the Diamond's ERC20 balance will have two jobs: (a) back outstanding positions, and (b) hold un-withdrawn fees. **This is the novelty** — co-mingling is not a pre-existing condition being formalised; it is a new condition the redesign deliberately creates so that fees benefit from pull-payment semantics. INV-SOLV-4 therefore has to be revised and a new fee-accounting symmetry invariant added so the accounting distinguishes the two pools inside one balance.

### INV-SOLV-4 (crown jewel) — REVISED

**Before:**
> `balanceOf(Diamond, token) + ROUNDING_TOLERANCE >= outstandingPairs[token]`

**After:**
> `balanceOf(Diamond, token) + ROUNDING_TOLERANCE >= outstandingPairs[token] + accruedFees[token]`

**Two pin-downs the implementer MUST respect** (architect §5(a)):

1. The current harness writes `backing = (outstandingPairs / UNIT) * UNIT` at [contracts/audit/DoefinInvariantHarness.sol:962](../contracts/audit/DoefinInvariantHarness.sol#L962). **The floor must be removed** — use `outstandingPairs` directly. This is CR-3291973200 being subsumed; without explicit floor removal, a reviewer could augment the right-hand side with `accruedFees[token]` and still mask sub-`UNIT` solvency violations. This is the *whole point* of the subsumption — be loud about it.
2. The `ROUNDING_TOLERANCE` of `1_000` wei does not change. After the redesign, `accruedFees[token]` is **exact** (a direct accumulator increment, no division), so the right-hand side is exact and the tolerance still only needs to cover position-backing rounding slack. Document this attribution change ("the tolerance is now attributable entirely to position-backing rounding, not fee rounding") in the harness NatSpec — auditors will ask.

### INV-SOLV-4 — standard-ERC20 precondition (NEW — architect §5(b))

INV-SOLV-4 (revised) is **unsound in the presence of a fee-on-transfer or rebasing ERC20.** A fee-on-transfer collateral makes `balanceOf(Diamond, token)` grow by **less** than the fee amount accrued to `accruedFees[token]`, and the invariant is violated *without any SC bug* — purely from the ERC20's transfer-tax behaviour. The current model is silent on this because fees never sat in the Diamond.

**Explicit precondition (load-bearing):**

> Collateral tokens added via `AdminConfigFacet.addCollateralToken` are assumed to be **standard ERC20** — no fee-on-transfer, no rebasing, no callback hooks. INV-SOLV-4 (revised) holds only under this precondition. Enforcement is by governance (the owner-only allow-list), not by code. (Same posture as Polymarket V2.)

The implementer must add a code comment in `addCollateralToken` referencing this invariant, and the manual reviewer's checklist verifies it (§6.11).

### INV-SOLV-1 / INV-SOLV-3 — REVISED (fee-flow clauses only)

The "fees never enter the Diamond's balance" clauses in INV-SOLV-1 and INV-SOLV-3 are factually overturned by SCRUM-236 — they need rewording to "fees credit `accruedFees[token]` inside the Diamond and exit only via `withdrawFees`." `sc-business-logic` will produce the exact replacement text. **Constraint for that rewrite (architect §5(d)):** the **collateral-flow assertions** must be preserved (mint adds exactly `f`, complementary is net-zero on Diamond ERC20). Only the fee-flow sentences move; the collateral-flow encodings remain.

### INV-FEE-NEW (new) — fee accounting symmetry

For every settlement / redemption leg that debits a payer's collateral by `fee` wei, `accruedFees[token]` must be credited by *exactly* `fee` wei. **Per-token quantified statement** (architect §5(c)(1)):

> `∀ token ∈ allowed-collaterals: sumFeeAccrued[token] == accruedFees[token] + sumFeesWithdrawn[token]`

The harness maintains test-only `mapping(address => uint256) sumFeeAccrued; mapping(address => uint256) sumFeesWithdrawn;` and asserts the equality after every fuzz tick. Both sides reset at deploy.

### INV-FEE-1 / INV-FEE-3 / INV-FEE-5 (existing) — no change

- INV-FEE-1: `fee <= cashValue × maxFeeRateBps / 10000` — `_validateFee` unchanged.
- INV-FEE-3: Operator is never a fee sink (`msg.sender` is not credited fees). Now stronger — operator never even sees fees; they go straight to `accruedFees`.
- INV-FEE-5: `feeReceiver` set by owner only — `setFeeReceiver` unchanged.

## 6. Security review checklist (for `sc-manual-reviewer`)

### 6.1 Co-mingling — the META-CHECK (NEW concern; primary security focus)

Today the Diamond's ERC20 balance backs outstanding positions only — fees flow direct-to-feeReceiver and never touch the Diamond. This PR adds a second use: un-withdrawn fees. `withdrawFees(token, amount)` must NOT be able to transfer collateral that backs outstanding positions.

The local check `amount <= accruedFees[token]` is necessary AND sufficient *provided* the contract has no other path that decreases `balanceOf(Diamond, token)` without symmetrically decreasing `outstandingPairs` or `accruedFees`. Today the only balance-decreasing paths are: `_mergePositionsInternal`, `_handlePayoutTransfer`, the new `withdrawFees`, and `redeemPositions` (which calls `_handlePayoutTransfer`).

**Reviewer requirement:** enumerate **every `safeTransfer` / `safeTransferFrom` where the Diamond is `from`**, and for each confirm it preserves `balance >= outstandingPairs + accruedFees`. A future facet (treasury rebalancer, etc.) could violate this invariant — the meta-check is the durable defence.

### 6.2 Reentrancy — guard scope

`withdrawFees` performs an external `safeTransfer`. Use the existing `LibReentrancyGuard` (`_nonReentrantBefore/After`) — same shape as `_handlePayoutTransfer`. **The guard MUST wrap the entire withdraw function body** — the `accruedFees[token] -= w` storage decrement, the `safeTransfer`, AND the `emit FeesWithdrawn` must all sit inside the guarded region. A malicious ERC20 hook must not be able to re-enter the Diamond mid-state via a loupe call.

### 6.3 Access control

`withdrawFees` is `LibDiamond.enforceIsContractOwner()` only. No `marketMaker` path. No `operator` path. Under SCRUM-213 the owner will be a Gnosis Safe; `enforceIsContractOwner` already handles this correctly (the Safe address is the owner) — no code change needed.

### 6.4 Integer arithmetic

Solidity 0.8.20 default checked arithmetic + the explicit `<=` check makes underflow impossible. `accruedFees[token] -= w` happens AFTER the `w <= accruedFees[token]` check.

### 6.5 Event ordering

`FeesWithdrawn` must emit **after** the storage decrement AND **after** the external `safeTransfer`, while still inside the reentrancy guard. Order: `decrement → transfer → emit`. This ensures off-chain indexers never see a `FeesWithdrawn` for a call that subsequently reverted.

### 6.6 Stuck `feeReceiver`

If `feeReceiver` is set to a non-payable / reverting contract, `withdrawFees` reverts and fees stay banked. Admin can re-`setFeeReceiver` and retry. No funds lost.

### 6.7 The `type(uint256).max` drain idiom

Implementation must convert this BEFORE the bounds check, using a local variable (no parameter mutation):

```solidity
function withdrawFees(address token, uint256 amount) external {
    LibDiamond.enforceIsContractOwner();
    if (token == address(0)) revert Errors.InvalidTokenAddress();

    LibAdminConfigStorage.AdminConfigStorage storage acs = LibAdminConfigStorage.adminConfigStorage();
    uint256 w = (amount == type(uint256).max) ? acs.accruedFees[token] : amount;
    if (w == 0) revert Errors.ZeroAmount();
    if (w > acs.accruedFees[token]) {
        revert Errors.InsufficientAccruedFees(w, acs.accruedFees[token]);
    }
    address feeReceiver = acs.feeReceiver;
    if (feeReceiver == address(0)) revert Errors.InvalidFeeReceiver();

    LibReentrancyGuard._nonReentrantBefore();
    acs.accruedFees[token] -= w;                          // effect
    IERC20(token).safeTransfer(feeReceiver, w);           // interaction
    emit Events.FeesWithdrawn(token, feeReceiver, w);     // log
    LibReentrancyGuard._nonReentrantAfter();
}
```

Drain-when-empty (`amount == type(uint256).max` with `accruedFees[token] == 0`) resolves to `w == 0` and reverts `ZeroAmount` — single error path for "nothing to withdraw."

### 6.8 Diamond self-transferFrom

`_settleMint` already does `safeTransferFrom(taker.maker, address(this), takerCollateral)` — adding `safeTransferFrom(taker.maker, address(this), takerFee)` on the same hop is structurally identical at the call-site level; no new self-transfer concern. (Optimisation candidate not in scope for SCRUM-236: fold `collateral + fee` into a single transferFrom.)

### 6.9 Storage isolation

`accruedFees` lives in the admin-config namespace (`doefin.admin-config.storage`); SettlementFacet and ConditionalTokensFacet access it via `LibAdminConfigStorage.adminConfigStorage().accruedFees[...]`. No cross-namespace storage write.

### 6.10 Front-running

`withdrawFees` is admin-only; front-running not applicable. Under the *current* model, an admin who delays calling `setFeeReceiver` after a misconfiguration loses fees on every trade in the interim. Under the *new* model, the admin has an arbitrarily-large window to fix `feeReceiver` because the fees are escrowed. **Strict improvement on the admin-error vector.**

### 6.11 Collateral allow-list semantics (NEW — architect §6 item 11)

Per §5 standard-ERC20 precondition: verify that `AdminConfigFacet.addCollateralToken` is documented as "owner-attested standard ERC20" and that there is a code comment in `addCollateralToken` referencing INV-SOLV-4-revised. Documentation only; no code change.

### 6.12 Harness invariants — REWRITES + new driver (NEW — architect §6 item 8)

The harness's existing invariants must be updated to match the new model:

- **`echidna_collateral_conserved`** ([DoefinInvariantHarness.sol:944](../contracts/audit/DoefinInvariantHarness.sol#L944)) — *still holds.* The closed-system sum `balanceOf(diamond) + balanceOf(harness) + balanceOf(FEE_RECEIVER) + Σ actors == totalCollateralMinted` is unchanged; fees just move from `FEE_RECEIVER` to `balanceOf(diamond)` inside that sum. Verify, don't rewrite.
- **`echidna_fee_receiver_only_grows`** ([DoefinInvariantHarness.sol:997](../contracts/audit/DoefinInvariantHarness.sol#L997)) — **silently breaks in meaning.** Under the new model, `FEE_RECEIVER`'s balance grows only when the owner calls `withdrawFees`, not per leg. Without a fuzz driver, the assertion holds vacuously while measuring nothing. **Rewrite as `echidna_fee_receiver_plus_accrued_only_grows`:** ratchet against `acs.accruedFees[token] + balanceOf(FEE_RECEIVER, token)`. This monotone-up quantity is the right invariant — together with `echidna_diamond_solvent` it pins the new fee-bank model.
- **New `fuzz_withdrawFees(uint256 fillAmount)` driver** — picks a random `amount ∈ [1, accruedFees[token]]` (clamped) and calls `withdrawFees(token, amount)` from the owner. This exercises the withdraw path under fuzzing, making the rewrites above non-vacuous. Add to the harness alongside `fuzz_matchMint`, `fuzz_matchMerge`, etc.
- **`echidna_diamond_solvent`** — see §5.INV-SOLV-4 above. The `(outstandingPairs / UNIT) * UNIT` floor is **removed**; the right-hand side becomes `outstandingPairs + accruedFees[collateral]`.
- **New `echidna_fee_accounting_symmetry`** — implements INV-FEE-NEW per-token (the harness maintains `sumFeeAccrued[token]` / `sumFeesWithdrawn[token]` as harness-side counters).

These are harness changes, not contract changes, but they are **in scope for SCRUM-236** — the security review depends on the harness being faithful to the new model.

### 6.13 Pause integration (NEW — architect cross-cutting C3)

`withdrawFees` is **NOT** gated by `SettlementAdminFacet.pauseTrading` / `isTradingPaused`. Fee withdrawal is an admin-treasury operation distinct from trading, and pausing should not prevent the owner from sweeping fees (a pause might be triggered *because* we want to sweep). The implementation must not add a `whenNotPaused` modifier or equivalent check. This decision is documented to forestall the question during manual review.

### 6.14 Multisig owner composition (NEW — architect cross-cutting C5)

The parent branch context is `SCRUM-213-MultiSigSetupForContractAdmin` — after SCRUM-213 lands, the Diamond owner is a Gnosis Safe. `LibDiamond.enforceIsContractOwner()` already handles this correctly (the Safe address is the owner; `msg.sender` is the Safe at execution time). No code change in SCRUM-236; the two tickets compose cleanly. Document this in the `withdrawFees` NatSpec ("owner-gated; under SCRUM-213 the owner is the Gnosis Safe").

## 7. Test plan (for `sc-developer` to implement, `sc-test-engineer` to verify)

### Unit
- `withdrawFees(token, amount)`:
  - `token == address(0)` ⇒ revert `InvalidTokenAddress`.
  - `amount == 0` ⇒ revert `ZeroAmount`.
  - `amount == type(uint256).max && accruedFees[token] == 0` ⇒ revert `ZeroAmount` (drain-when-empty resolves to 0).
  - `amount > accruedFees[token]` ⇒ revert `InsufficientAccruedFees(requested, available)`.
  - `feeReceiver == address(0)` ⇒ revert `InvalidFeeReceiver`.
  - non-owner caller ⇒ revert `NotContractOwner`.
  - happy path: `accruedFees[token]` decrements by `amount`, `feeReceiver` ERC20 balance increases by `amount`, event emitted with correct ordering.
  - drain: `amount == type(uint256).max && accruedFees[token] > 0` ⇒ `accruedFees[token]` drops to 0, full balance moves.
  - **withdraw post-delisting** (architect §7(2)): `addCollateralToken(USDC)` → fee-bearing trade → `removeCollateralToken(USDC)` → `withdrawFees(USDC)` SUCCEEDS (fees were lawfully accrued before delisting and remain owner-claimable).
- `_handlePayoutTransfer` zero-fee bypass (the original CR-3291973203 case): `redeemPositions` succeeds when `resolutionFeeBps == 0 && feeReceiver == address(0)`.
- Settlement legs: each of `_settleComplementary` / `_settleMint` / `_settleMerge` / `_executeOperatorFill` increments `accruedFees[token]` by the per-leg `fee` and emits `FeeAccrued(.., TRADING)`.
- **Fee-zero symmetric case** (architect §7(1)): when the operator legitimately passes `fee == 0`, `accruedFees[token]` is **unchanged** and `FeeAccrued` is **not** emitted. This is the regression check for the original CR-3291973203 logic — fee-zero must be a true no-op.
- Redemption: `_handlePayoutTransfer` increments `accruedFees[token]` by `feeAmount` and emits `FeeAccrued(.., RESOLUTION)`.
- **Reentrancy regression** (architect §7(3)): deploy a malicious `feeReceiver` contract that re-enters `withdrawFees` (or `matchOrders`) in its `receive`/`transfer` hook; assert the call reverts cleanly with `Reentrant`. Pins §6.2.

### Invariant (echidna harness)
- Update `echidna_diamond_solvent` per §5.INV-SOLV-4 (floor removed; new term added).
- Add `echidna_fee_accounting_symmetry` per §5.INV-FEE-NEW (per-token).
- Rewrite `echidna_fee_receiver_only_grows` → `echidna_fee_receiver_plus_accrued_only_grows` per §6.12.
- Add `fuzz_withdrawFees` driver per §6.12.
- `echidna_collateral_conserved` unchanged — verify it still holds.

### Characterization
- Existing fee-related characterization tests will fail on first run — the recipient of every fee-bearing trade changes from `feeReceiver` to `address(this)`. Migrate `Events.FeeCharged` assertions to `FeeAccrued` (plus a `FeesWithdrawn` follow-up where applicable). This is expected and accounted for.

## 8. Open questions — RESOLVED

| Q | Resolution (architect §8) |
|---|---|
| Q1 — `FeeAccrued.kind` as `uint8` enum vs `bytes32` topic? | **`uint8`.** Two values today (`TRADING=0`, `RESOLUTION=1`); a third (e.g. "redistribution") still fits. `bytes32` topic is overkill and costs an extra log topic slot. Constants defined in `LibConstants.FEE_KIND_TRADING` / `LibConstants.FEE_KIND_RESOLUTION` — no magic numbers in settlement code. |
| Q2 — `withdrawFees` emit per-event or batched? | **Per-event.** Single owner call → one `FeesWithdrawn` per `withdrawFees(token, amount)`. Per-token granularity is the natural query unit for off-chain treasury accounting. |
| Q3 — `withdrawFees(token == address(0), amount)` meaning "all tokens"? | **Single-token only.** The codebase has no enumerable allow-list; a multi-token drain would require adding `EnumerableSet.AddressSet` to `AdminConfigStorage` (a real layout change) just for admin convenience. The admin calls `withdrawFees(USDC)` once per active collateral (typically 1–3 tokens in production). If product needs batching later, add a separate `withdrawFeesBatch(address[], uint256[])` helper — do not overload `address(0)`. |
| Q4 — `getAccruedFees(token)` on `AdminConfigFacet` vs `MarketDataFacet`? | **`AdminConfigFacet`.** `MarketDataFacet` is market-scoped (positions, conditions, complements); fee-bank state is a configuration/treasury surface. |

## 9. Workstream plan — REVISED (architect §9)

**Parallel where safe; serialise on dependencies.**

```
┌────────────────────────────────────────────────────────────────────────┐
│  v2 (this revision) — design doc complete & coherent                   │
│  Architecture review: audit/SCRUM-236-architecture-review.md           │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
                       sc-business-logic
              (derives INV-SOLV-1/3/4 rewordings, INV-FEE-NEW
               formal statement, cross-checks against the
               existing 22 invariants for conflicts;
               output: audit/SCRUM-236-business-logic-review.md)
                                   │
                                   │  (any invariant conflicts → fold back into design doc as v3)
                                   ▼
                       sc-developer (impl + unit tests + harness update)
                                   │
                                   ▼
                       sc-test-engineer (echidna run on the updated
                       harness; characterization migration)
                                   │
                                   ▼
                       sc-manual-reviewer (final read-through against
                       the §6 security checklist)
                                   │
                                   ▼
                       sc-gas-optimizer (optional — quantifies hot-path
                       savings on the per-leg fee removal)
                                   │
                                   ▼
                       merge to v3/dev (before audit freeze)
```

**Sequencing intent** (architect §9):

- `sc-business-logic` runs **next** (this commit triggers it). The architecture review's §5(c)(d) gives directional guidance, but only `sc-business-logic` can formally derive the invariant rewordings against the existing 22 invariants and check for conflicts (especially INV-FEE-NEW vs INV-FEE-3 exclusivity, INV-SOLV-1 vs the new per-token quantifier formulation).
- Any conflict business-logic finds folds back into the design doc as v3 *before* `sc-developer` starts — no re-do.
- `sc-developer` is implicitly the test-engineer too (project convention: developer writes unit tests alongside the change). `sc-test-engineer` runs separately for the echidna/characterization suite, not the unit-test set.

## 10. Out-of-scope (for SCRUM-236, surface here so we don't lose them)

| Item | Why deferred |
|---|---|
| **Backend indexer migration** | `match-engine/app/utils/settlement_abi.py` and any `shared/scw/encoder.py` event listener MUST drop `FeeCharged` and add `FeeAccrued` + `FeesWithdrawn`. This is a coordinated SC + backend rollout. The SC ticket hands this off explicitly — listed here so it's not silently dropped (architect §10). |
| **CR-3291973204** (`getPositionInfo` broken-encapsulation in `MarketDataFacet`) | Not in this ticket's touch surface; lands as a separate item on PR #23. |
| **CR-3291973184** (A-2 dead-code remediation doc text) | Audit-doc fix; lands as a separate item on PR #23. |
| Per-token withdraw cap (e.g. `maxWithdrawPerCall`) | Not needed; admin-only access already caps the abuse vector. |
| Multi-token `withdrawAllFees()` convenience | Defer until product asks. |
| Frontend admin UI for fee withdrawal | Separate frontend ticket once SC lands. |
| Cumulative counters (`getCumulativeFeesAccrued(token)` / `getCumulativeFeesWithdrawn(token)`) | Forward-looking observability (architect C2). Costs 2 SSTORE per `FeeAccrued` + 1 SSTORE per `withdrawFees`. Defer; off-chain indexer can derive from events. |
| Fold `safeTransferFrom(payer, address(this), collateral + fee)` into single transferFrom | Gas optimisation; out of scope for SCRUM-236 — fold in a separate ticket after the bank lands and is gas-profiled. |

### In-scope items folded from CR ledger

- **CR-3291973203** (zero-fee DoS) — eliminated by design.
- **CR-3291973202** (`setMaxFeeRate` `NoChangeRequired` guard) — folded in (`AdminConfigFacet` is in the touch surface).
- **CR-3291973200** (`echidna_diamond_solvent` flooring bug) — subsumed by the INV-SOLV-4 revision rewrite (§5.INV-SOLV-4 pin-down #1).

## 11. Rollout

- **Branch:** `SCRUM-236-SCFeeBankPullPayment` off `v3/dev`.
- Lands on `v3/dev` **before the audit freeze**.
- Atomic SC change at the contract level — no in-flight EIP-712 schema impact, no signed-order migration.
- **Storage-layout-snapshot regeneration** (`UPDATE_STORAGE_SNAPSHOT=true npx hardhat test test/storage/`) must be in the SAME commit as the storage struct change. CI will fail otherwise (architect §11).
- **Backend coordination required:** `match-engine/app/utils/settlement_abi.py` adds the new event signatures (`FeeAccrued`, `FeesWithdrawn`) and removes `FeeCharged`. Frontend is unaffected (no user-facing field change). The SC merge is independent but the backend indexer should follow shortly after to preserve fee-flow visibility.
