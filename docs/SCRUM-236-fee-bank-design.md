# SCRUM-236 — SC fee bank · pull-payment model · design

> Branch: `SCRUM-236-SCFeeBankPullPayment` (off `v3/dev`)
> Status: **design — pending architect review**
> Origin: Surfaced by [CR-3291973203](../audit/coderabbit-triage/PR-23.md) on PR #23 (`_handlePayoutTransfer` zero-fee bypass DoS). The user pivoted from a narrow patch to a unified pull-payment fee bank for both trading and resolution fees.

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
                                                            accruedFees[token] += fee
                                                            emit FeeAccrued(token, fee, TRADING)

redeem leg:   safeTransfer(feeReceiver, feeAmount)         (collateral already in Diamond)
                                                            accruedFees[token] += feeAmount
                                                            emit FeeAccrued(token, feeAmount, RESOLUTION)

withdraw:     n/a                                          admin only:
                                                            withdrawFees(token, amount)
                                                              if amount == type(uint256).max:
                                                                  amount = accruedFees[token]
                                                              require amount > 0
                                                              require amount <= accruedFees[token]
                                                              require feeReceiver != address(0)
                                                              accruedFees[token] -= amount
                                                              safeTransfer(feeReceiver, amount)
                                                              emit FeesWithdrawn(token, feeReceiver, amount)
```

### What this eliminates / improves

| Concern | Result |
|---|---|
| Zero-fee deploy DoS | **Eliminated.** `feeReceiver` only matters at withdraw time. |
| Misconfigured `feeReceiver` mid-life | Fees stay safely banked; admin fixes `feeReceiver`, then withdraws. No funds at risk. |
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

Added to `LibAdminConfigStorage.AdminConfigStorage` (namespace `doefin.admin-config.storage`):

```solidity
/// @notice Fees accrued in the Diamond per collateral token, awaiting admin withdrawal.
/// @dev SCRUM-236 — pull-payment model. Increments on every settlement leg (trading) and
///      every `redeemPositions` (resolution). Decrements only via `withdrawFees`.
/// @dev INV-SOLV-4 (updated): `balanceOf(Diamond, token) >= outstandingPairs[token] + accruedFees[token]`.
mapping(address token => uint256 accrued) accruedFees;
```

No `__gap` change — EIP-7201 namespaces are 256-slot-aligned by design.

## 4. ABI deltas

### Added

| Surface | Selector | Access | Notes |
|---|---|---|---|
| `AdminConfigFacet.withdrawFees(address token, uint256 amount)` | new | `onlyOwner` (`LibDiamond.enforceIsContractOwner`) | `amount = type(uint256).max` ⇒ drain. Reverts `ZeroAmount`, `InsufficientAccruedFees`, `InvalidFeeReceiver`. Emits `FeesWithdrawn`. |
| `AdminConfigFacet.getAccruedFees(address token) returns (uint256)` | new | view | Convenience getter for off-chain. |
| `Events.FeeAccrued(address indexed token, uint256 amount, uint8 kind)` | new | — | `kind`: 0 = TRADING, 1 = RESOLUTION. Emitted on every fee debit. |
| `Events.FeesWithdrawn(address indexed token, address indexed feeReceiver, uint256 amount)` | new | — | Emitted on every successful `withdrawFees`. |
| `Errors.InsufficientAccruedFees()` | new | — | Withdraw amount > accrued. |
| `Errors.NoFeesAccrued()` | new | — | (Used when full-drain is requested and accrual is 0.) |

### Removed / renamed

| Surface | Status |
|---|---|
| `Events.FeeCharged(address feeReceiver, uint256 amount)` | **Removed.** Replaced by `FeeAccrued` (which is more informative — adds `token` indexer and `kind`). |
| Per-leg external transfers to `feeReceiver` | **Removed** from `_settleComplementary`, `_settleMint`, `_settleMerge`, `_executeOperatorFill`, `_handlePayoutTransfer`. Replaced by `accruedFees[token] += fee` + `emit FeeAccrued`. |

### Unchanged

| Surface | Status |
|---|---|
| `setFeeReceiver(address)` | Unchanged — `feeReceiver` is now used as the withdraw destination instead of the per-trade recipient. The `NoChangeRequired` no-op guard stays. |
| `setMaxFeeRate(uint16)` | Unchanged. The `NoChangeRequired` no-op guard MUST be added per CR-3291973202 (in scope for SCRUM-236). |
| `setResolutionFeeBps(uint16)` | Unchanged. |
| `_validateFee` | Unchanged (cap + `fee <= proceeds`). |
| `feeReceiver` (storage field) | Unchanged. Validation moves from per-trade reverts to a withdraw-time revert. |

## 5. Invariant updates

### INV-SOLV-4 (crown jewel) — REVISED

**Before:**
> `balanceOf(Diamond, token) + ROUNDING_TOLERANCE >= outstandingPairs[token]`

**After:**
> `balanceOf(Diamond, token) + ROUNDING_TOLERANCE >= outstandingPairs[token] + accruedFees[token]`

Co-mingling rule: the Diamond's ERC20 balance must cover *both* outstanding position backing *and* the un-withdrawn fee accrual. This is the load-bearing invariant of the redesign.

### INV-FEE-NEW (new) — fee accounting symmetry

For every settlement / redemption leg that debits a payer's collateral by `fee` wei, `accruedFees[token]` must be credited by *exactly* `fee` wei. The harness must assert:

```
sum over all FeeAccrued.amount events == accruedFees[token] + sum over all FeesWithdrawn.amount events
```

(Both sides reset at deploy.)

### INV-FEE-1 / INV-FEE-3 / INV-FEE-5 (existing) — no change

- INV-FEE-1: `fee <= cashValue × maxFeeRateBps / 10000` — `_validateFee` unchanged.
- INV-FEE-3: Operator is never a fee sink (`msg.sender` is not credited fees).
- INV-FEE-5: `feeReceiver` set by owner only — `setFeeReceiver` unchanged.

## 6. Security review checklist (for `sc-manual-reviewer`)

1. **Co-mingling.** `withdrawFees(token, amount)` must NOT be able to transfer collateral that backs outstanding positions. The check `amount <= accruedFees[token]` is necessary AND sufficient — but only if every fee debit credits `accruedFees` exactly (INV-FEE-NEW). Verify across all 5 fee-debit sites.
2. **Reentrancy.** `withdrawFees` performs an external `safeTransfer`. Use the existing `LibReentrancyGuard` (`_nonReentrantBefore/After`) — same shape as `_handlePayoutTransfer`.
3. **Access control.** `withdrawFees` must be `LibDiamond.enforceIsContractOwner()` only. No operator path. No `marketMaker` path.
4. **Integer arithmetic.** `accruedFees[token] -= amount` happens AFTER the `<=` check — no underflow possible.
5. **Event ordering.** Emit `FeesWithdrawn` AFTER the transfer (or guard with reentrancy so it doesn't matter).
6. **Stuck `feeReceiver`.** If `feeReceiver` is set to a non-payable / reverting contract, `withdrawFees` reverts and fees stay banked. Admin can re-`setFeeReceiver` and retry. No funds lost.
7. **The `type(uint256).max` drain idiom.** Implementation must convert this to `accruedFees[token]` BEFORE the bounds check, not after. (`amount = (amount == type(uint256).max) ? accruedFees[token] : amount;` then `if (amount == 0) revert ZeroAmount; if (amount > accruedFees[token]) revert InsufficientAccruedFees;`).
8. **Diamond self-transferFrom.** `_settleMint` already does `safeTransferFrom(taker.maker, address(this), takerCollateral)` — adding `safeTransferFrom(taker.maker, address(this), takerFee)` on the same hop is structurally identical; no new self-transfer concern. (Note: optimisation candidate — fold the two transfers into one.)
9. **Storage isolation.** `accruedFees` lives in the admin-config namespace; the settlement namespace does not access it directly — it goes through `LibAdminConfigStorage.adminConfigStorage().accruedFees[...]`.
10. **Front-running.** `withdrawFees` is admin-only; front-running not applicable. A malicious admin can already misuse `setFeeReceiver` — the model is trust-bound at the owner level (consistent with the rest of the protocol).

## 7. Test plan (for `sc-test-engineer`)

### Unit
- `withdrawFees(token, amount)`:
  - `amount == 0` ⇒ revert `ZeroAmount`.
  - `amount > accruedFees[token]` ⇒ revert `InsufficientAccruedFees`.
  - `feeReceiver == address(0)` ⇒ revert `InvalidFeeReceiver`.
  - non-owner caller ⇒ revert `NotContractOwner`.
  - happy path: `accruedFees[token]` decrements by `amount`, `feeReceiver` ERC20 balance increases by `amount`, event emitted.
  - drain: `amount == type(uint256).max` ⇒ `accruedFees[token]` drops to 0, full balance moves.
- `_handlePayoutTransfer` zero-fee bypass (the original CR-3291973203 case): `redeemPositions` succeeds when `resolutionFeeBps == 0 && feeReceiver == address(0)`.
- Settlement legs: each of `_settleComplementary` / `_settleMint` / `_settleMerge` / `_executeOperatorFill` increments `accruedFees[token]` by the per-leg `fee` and emits `FeeAccrued(.., TRADING)`.
- Redemption: `_handlePayoutTransfer` increments `accruedFees[token]` by `feeAmount` and emits `FeeAccrued(.., RESOLUTION)`.

### Invariant (echidna harness)
- Update `echidna_diamond_solvent` to assert `balanceOf(diamond) + ROUNDING_TOLERANCE >= outstandingPairs + accruedFees[collateral]` (and also fixes CR-3291973200's flooring bug as a side effect).
- New invariant `echidna_fee_accounting_symmetry`: track `sumFeeAccrued` and `sumFeesWithdrawn` as harness state; assert `sumFeeAccrued == accruedFees[token] + sumFeesWithdrawn`.

### Characterization
- Existing fee-related characterization tests will likely all FAIL on the first run — the recipient of every fee-bearing trade changes from `feeReceiver` to `address(this)`. Update assertions; this is expected.

## 8. Open design questions (architect to confirm or override)

1. **`FeeAccrued.kind` as `uint8` enum vs `bytes32` topic?** `uint8` saves indexer cost; `bytes32` is more general. Default: `uint8` (`0=TRADING`, `1=RESOLUTION`).
2. **Should `withdrawFees` emit per-event or batched?** Per-event keeps the audit trail simple. Default: per-event.
3. **Should `withdrawFees(token=address(0), amount)` mean "all tokens"?** Tempting, but adds a loop with unbounded `allowedTokens.length`. Default: **single-token only**; the admin calls `withdrawFees` once per active collateral token (typically 1–3 tokens in production).
4. **Should `accruedFees` be exposed in the loupe / `MarketDataFacet`?** A `getAccruedFees(token)` view on `AdminConfigFacet` is enough. `MarketDataFacet` stays market-scoped. Default: yes — on `AdminConfigFacet`, not `MarketDataFacet`.

## 9. Workstream plan

1. **`sc-architecture-reviewer`** — validates this design doc end-to-end. Critiques the storage placement, withdraw semantics, invariant statements, event/error shape, the `type(uint256).max` drain idiom. Output: a review file at `audit/SCRUM-236-architecture-review.md` with `accept | revise | reject` for each section.
2. **`sc-business-logic`** — derives the formal **INV-SOLV-4 (revised)** and **INV-FEE-NEW** statements; cross-checks against the existing 22 invariants for conflicts. Output: appended to `audit/business-logic/invariants.md` under a new section or a sibling file.
3. **`sc-developer`** — implements the design, after architecture + business-logic sign-off. Splits commits per logical unit per project convention. Updates tests as it goes.
4. **`sc-manual-reviewer`** — final security pass on the implemented code; focus on the security checklist above. Read-only.
5. **`sc-gas-optimizer`** *(optional)* — quantifies the gas delta on the settlement hot path; useful audit-evidence material.

## 10. Out-of-scope (for SCRUM-236, surface here so we don't lose them)

- **CR-3291973202** (`setMaxFeeRate` `NoChangeRequired` guard) — **IS** in scope (already in the AdminConfigFacet touch surface).
- **CR-3291973200** (echidna_diamond_solvent floor bug) — **IS** in scope (the INV-SOLV-4 revision rewrites this anyway).
- Per-token withdraw cap (e.g. `maxWithdrawPerCall`) — not needed; admin-only access already caps abuse vector.
- Multi-token `withdrawAllFees()` convenience — defer until product asks for it.
- Frontend admin UI for fee withdrawal — separate frontend ticket once SC lands.

## 11. Rollout

- Branch: `SCRUM-236-SCFeeBankPullPayment` off `v3/dev`.
- Lands on `v3/dev` BEFORE the audit freeze.
- Atomic SC change — no in-flight EIP-712 schema impact, no backend or frontend coordination required.
- Backend ABI regeneration after merge (`shared/scw/encoder.py` byte-parity not affected; new event added to the indexer's interest list optionally).
