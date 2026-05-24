# SCRUM-236 — business-logic review of design doc v2

_Reviewer: sc-business-logic · 2026-05-24 · design doc commit: `e27918f` · architecture review: `audit/SCRUM-236-architecture-review.md`_

Scope: stage-1 read-only invariant review of `docs/SCRUM-236-fee-bank-design.md` (v2),
cross-checked against the 22 invariants pinned in
`audit/business-logic/invariants.md` and the actual code touch surface
(`SettlementFacet` four fee-debit sites, `ConditionalTokensFacet._handlePayoutTransfer`,
`LibAdminConfigStorage`, `DoefinInvariantHarness`).

## Verdict at a glance

| Item | Verdict | Headline |
|---|---|---|
| 1. INV-SOLV-4 (revised) formal statement | ACCEPT-WITH-PRECISIONS | Statement is correct; floor MUST be deleted (loud), tolerance attribution rewrite is correct, ERC20 precondition is the right shape. |
| 2. INV-SOLV-1 fee-flow clause rewrite | ACCEPT — exact text proposed | Collateral-flow assertion preserved verbatim; one sentence replaces three. |
| 3. INV-SOLV-3 fee-flow clause rewrite | ACCEPT — exact text proposed | Buyer↔seller collateral flow preserved; Diamond ERC20 balance is now `Δ = takerFee+makerFee` not 0. |
| 4. INV-FEE-NEW formal statement | ACCEPT-WITH-REFINEMENT | Per-token quantifier confirmed; harness needs two new test-only mappings; assertion timing is "after every fuzz tick". |
| 5. Conflict check INV-FEE-NEW vs INV-FEE-3 | NO CONFLICT | Operator-fill path credits `accruedFees`, not `msg.sender`. Strengthens INV-FEE-3. |
| 6. Conflict check INV-FEE-NEW vs INV-FEE-5 | NO CONFLICT | Orthogonal — INV-FEE-5 bounds the rate, INV-FEE-NEW conserves the debit. |
| 7. INV-SOLV-4 META-CHECK Diamond-as-`from` walk | ACCEPT — all 5 sites preserve | Every existing site is symmetric in either `outstandingPairs` or `accruedFees`. |
| 8. `fee == 0` symmetric case | ACCEPT | Correct behaviour; required for both INV-FEE-NEW symmetry and the CR-3291973203-regression. |
| 9. CR-3291973200 subsumption completeness | ACCEPT-WITH-CAVEAT | Floor removal is the necessary fix; INV-FEE-NEW symmetry is a stronger complement, not a replacement. Both required. |
| 10. Anything else | 1 LOW-INFO edge case | Resolution-fee floor-division surplus is **NOT** an INV-FEE-NEW violation under the design's actual semantics. Plus 3 minor follow-ups. |

Bucket count: **8 ACCEPT**, **2 ACCEPT-WITH-REFINEMENT/PRECISIONS**, **2 NO-CONFLICT** (items 5/6), **0 BLOCK**, **0 REJECT**.

---

## Per-item

### 1. INV-SOLV-4 (revised) — formal restatement

**Verdict: ACCEPT-WITH-PRECISIONS.** Statement is correct; floor removal and ERC20
precondition pin-downs are correct; tolerance attribution is correct.

**Proposed formal statement** (replaces `audit/business-logic/invariants.md:144-146`):

> **Fuzz encoding:** global property — for every collateral token `t` configured via
> `AdminConfigFacet.addCollateralToken`,
>
> ```
> collateralToken.balanceOf(diamond) + ROUNDING_TOLERANCE
>     >= outstandingPairs[t] + acs.accruedFees[t]
> ```
>
> where `outstandingPairs[t]` is the cumulative `splitDeposited - mergeWithdrawn -
> redeemedAmount` for `t`, measured in collateral base units (per-wei, NOT
> floored to whole `unit`s — the harness must NOT apply `(outstandingPairs / UNIT) * UNIT`).
> `acs.accruedFees[t]` is the exact accumulator from `LibAdminConfigStorage`
> (SCRUM-236) — every settlement / redemption leg increments it by exactly the per-leg
> `fee` (no division, no rounding). This is the master `echidna_diamond_solvent`
> property.

**Pin-downs (all correct; restated for the harness implementer):**

1. **Floor removal is mandatory.** Today the harness writes
   `backing = (outstandingPairs / UNIT) * UNIT` at
   `contracts/audit/DoefinInvariantHarness.sol:962`. Leaving the floor in while
   adding `+ accruedFees[t]` would still mask up to `UNIT - 1` wei of position-
   backing under-collateralization (CR-3291973200). Change the line to
   `return collateral.balanceOf(diamond) + ROUNDING_TOLERANCE >= outstandingPairs + acs.accruedFees[address(collateral)];`
   — that is the single-token harness today; the multi-token form is what
   gets quantified in the formal statement above. Update the NatSpec at lines
   211-213 (which currently says "1 pair worth UNIT") to "measured in collateral
   base units" per the CR-3291973200 fix.

2. **`ROUNDING_TOLERANCE = 1_000` wei stays.** After the redesign the
   right-hand side gains `accruedFees[t]`, which is **exact** — every accrual is a
   direct `acs.accruedFees[t] += fee` SSTORE with no division. The tolerance still
   only needs to cover the position-backing rounding slack (the 1-wei per
   complementary/mint/merge integer-division surplus documented in INV-PRICE-1/2).
   The harness NatSpec must be updated to say: "the tolerance is now attributable
   **entirely** to position-backing rounding (the 1-wei surplus per
   `floorDiv(P*f, unit)` integer division); fee accounting is exact."

3. **Standard-ERC20 precondition is the right shape.** Without it INV-SOLV-4
   (revised) is unsound: a fee-on-transfer collateral makes
   `balanceOf(Diamond, t)` grow by `fee - tax` while `accruedFees[t]` grows by
   `fee` — the LHS falls below the RHS by `tax`, with no SC bug. The text the
   design doc proposes — "Collateral tokens added via `addCollateralToken` are
   assumed to be standard ERC20 — no fee-on-transfer, no rebasing, no callback
   hooks. INV-SOLV-4 holds only under this precondition. Enforcement is by
   governance, not by code." — is correct. It belongs in `invariants.md` as a
   `**Precondition**` paragraph immediately preceding the revised INV-SOLV-4
   statement, AND as a code comment in `addCollateralToken` referencing
   "INV-SOLV-4-revised".

### 2. INV-SOLV-1 — fee-flow clause rewrite

**Verdict: ACCEPT.** Below is the exact replacement.

**Current text (`audit/business-logic/invariants.md:78-81`):**

> - **Enforced:** `SettlementFacet.sol` `_settleMint` (lines ~529-574). By construction —
>   `takerCollateral` is the remainder, so the sum telescopes to `f` for *all* price inputs
>   with no rounding gap. The fees (`takerFee`, `makerFee`) are transferred separately,
>   *directly to `feeReceiver`*, and never enter the Diamond's collateral balance.

**Proposed replacement** (one-sentence delta — only the trailing fee sentence
changes; the `takerCollateral` remainder explanation is preserved verbatim):

> - **Enforced:** `SettlementFacet.sol` `_settleMint` (lines ~529-574). By construction —
>   `takerCollateral` is the remainder, so the sum telescopes to `f` for *all* price inputs
>   with no rounding gap. The fees (`takerFee`, `makerFee`) are transferred via
>   `safeTransferFrom(payer, address(this), fee)` to the Diamond and credited to
>   `LibAdminConfigStorage.adminConfigStorage().accruedFees[order.collateralToken]`
>   (SCRUM-236 pull-payment model); each accrual emits `Events.FeeAccrued(token, fee,
>   FEE_KIND_TRADING)`. Fees co-mingle with position-backing collateral in the Diamond's
>   ERC-20 balance but are kept distinguishable by the `accruedFees` accumulator
>   (INV-SOLV-4-revised, INV-FEE-NEW).

**Constraint preserved (architect §5(d)):** the **collateral-flow assertion** in the
fuzz-encoding block at lines 82-85 — `collateralToken.balanceOf(diamond)_after -
_before == f` — stays valid IF the fees are also pulled into the Diamond on this
hop. After SCRUM-236 the per-hop delta is `f + takerFee + makerFee`, not `f`. Either:

- **Option A (preferred):** keep the existing assertion and split the fee assertion
  out — `collateralToken.balanceOf(diamond)_after - _before == f + takerFee + makerFee`
  AND `acs.accruedFees[t]_after - _before == takerFee + makerFee`.
- **Option B:** decompose into two ratchet measurements
  `Δ(balanceOf(diamond)) == f + Δ(accruedFees[t])`. Same content, more verbose.

Recommend Option A; it matches the existing fuzz-encoding voice. The fuzz-encoding
block update is also part of the rewrite (call out to the implementer).

### 3. INV-SOLV-3 — fee-flow clause rewrite

**Verdict: ACCEPT.** Below is the exact replacement.

**Current text (`audit/business-logic/invariants.md:120-131`):**

> ### INV-SOLV-3 — Complementary settlement never touches Diamond collateral
> `_settleComplementary` performs only `safeTransferFrom` *between* the two counterparties
> and the feeReceiver, plus one ERC-1155 transfer from seller to buyer. The Diamond's own
> ERC-20 balance and its own ERC-1155 balance are unchanged.
>
> - **Enforced:** `SettlementFacet.sol` `_settleComplementary` (lines ~446-501). All
>   `IERC20.safeTransferFrom` calls move funds buyer→seller, buyer→feeReceiver,
>   seller→feeReceiver; the position-token transfer is seller→buyer. The Diamond is the
>   ERC-1155 operator but not a `from`/`to`.
> - **Fuzz encoding:** assert `collateralToken.balanceOf(diamond)` unchanged and
>   `erc1155.balanceOf(diamond, posId)` unchanged across a fuzzed complementary settlement.
> - **Status:** HOLDS.

**Proposed replacement** (heading title changes; ERC-1155 invariant preserved
verbatim; collateral-flow flips from "unchanged" to "+ totalFees"):

> ### INV-SOLV-3 — Complementary settlement is collateral-neutral on the swap leg
> `_settleComplementary` performs `safeTransferFrom` between the two counterparties for
> the swap leg (buyer → seller), plus two `safeTransferFrom`s of the per-party fees from
> each counterparty INTO the Diamond (SCRUM-236 pull-payment model), plus one ERC-1155
> transfer from seller to buyer. The Diamond is a `to` for the two fee transfers and is
> not involved in the swap leg; its ERC-1155 balance is unchanged.
>
> - **Enforced:** `SettlementFacet.sol` `_settleComplementary` (lines ~446-501).
>   `IERC20.safeTransferFrom` calls move funds buyer→seller (swap),
>   buyer→`address(this)` (buyerFee), seller→`address(this)` (sellerFee); each fee
>   transfer is followed by `acs.accruedFees[token] += fee` and `emit
>   Events.FeeAccrued(token, fee, FEE_KIND_TRADING)`. The position-token transfer is
>   seller→buyer; the Diamond is the ERC-1155 operator but not a `from`/`to` on that leg.
> - **Fuzz encoding:** for a fuzzed complementary settlement assert
>   `collateralToken.balanceOf(diamond)_after - _before == buyerFee + sellerFee` AND
>   `acs.accruedFees[token]_after - _before == buyerFee + sellerFee` AND
>   `erc1155.balanceOf(diamond, posId)` unchanged. The buyer→seller swap flow is
>   preserved as `collateralToken.balanceOf(seller)_after - _before == collateralAmount -
>   sellerFee` AND `collateralToken.balanceOf(buyer)_before - _after == collateralAmount +
>   buyerFee`.
> - **Status:** HOLDS.

**Constraint preserved (architect §5(d)):** the buyer↔seller swap-leg flow
(`collateralAmount` moves from buyer to seller, paid at the maker's price) is
the **load-bearing economic assertion** — that is fully preserved as the third
fuzz-encoding clause.

### 4. INV-FEE-NEW — formal statement

**Verdict: ACCEPT-WITH-REFINEMENT.**

**Proposed formal entry** (new section, drop in between INV-FEE-5 and
INV-FILL-1 in `audit/business-logic/invariants.md`):

> ### INV-FEE-NEW — Fee-accounting symmetry (SCRUM-236)
>
> For every settlement / redemption leg that debits a payer's collateral by `fee` wei,
> `acs.accruedFees[token]` MUST be credited by *exactly* `fee` wei. **Per-token
> quantified** across the full collateral allow-list:
>
> ```
> ∀ token ∈ allowed-collaterals (acs.isAllowed[token] == true):
>     sumFeeAccrued[token] == acs.accruedFees[token] + sumFeesWithdrawn[token]
> ```
>
> where `sumFeeAccrued[token]` is the cumulative sum of all `Events.FeeAccrued(token,
> amount, kind).amount` for that token since deploy (equivalently: the cumulative sum
> of all per-leg `fee` *increments* against `accruedFees[token]`, since every accrual
> increments the accumulator by exactly the emitted event's `amount`), and
> `sumFeesWithdrawn[token]` is the cumulative sum of all `Events.FeesWithdrawn(token,
> feeReceiver, amount).amount`.
>
> - **Enforced:** every fee transfer site — `_settleComplementary`,
>   `_settleMint`, `_settleMerge`, `_executeOperatorFill`, `_handlePayoutTransfer` —
>   executes `safeTransferFrom(payer, address(this), fee)` (or, for `_handlePayoutTransfer`
>   and `_settleMerge` where the collateral is already in the Diamond, NO extra transfer)
>   followed atomically by `acs.accruedFees[token] += fee` and `emit
>   Events.FeeAccrued(token, fee, kind)`. The only decrement path is `withdrawFees`,
>   which performs `acs.accruedFees[token] -= w` and emits `Events.FeesWithdrawn`.
> - **`fee == 0` case:** no accrual increment AND no `FeeAccrued` emission. Symmetry
>   holds trivially (both sides increment by 0); preserves the CR-3291973203 regression
>   check (no spurious zero-amount event).
> - **Fuzz encoding:** the harness maintains test-only counters
>   `mapping(address => uint256) sumFeeAccrued` and `mapping(address => uint256)
>   sumFeesWithdrawn`. Each `fuzz_*` wrapper increments `sumFeeAccrued[t]` by the
>   per-leg fee on a successful `matchOrders`/`fillOrder`/`redeemPositions` call (and
>   by the `feeAmount` computed from `resolutionFeeBps` on the redemption path), and
>   the new `fuzz_withdrawFees` driver increments `sumFeesWithdrawn[t]` by `w` on a
>   successful `withdrawFees(t, amount)` call. `echidna_fee_accounting_symmetry`
>   asserts the per-token equation for every allow-listed token AFTER every fuzz tick.
> - **Reset:** both `sumFeeAccrued` and `sumFeesWithdrawn` start at 0 at constructor
>   exit (no fees can be accrued during constructor — the seed split is fee-free).
> - **Status:** HOLDS (post-SCRUM-236).

**Refinements vs the design doc's one-liner:**

1. **`sumFeeAccrued` semantics pinned.** Two definitions could exist —
   (a) sum of `FeeAccrued.amount` event-amount values; (b) sum of per-leg `fee`
   *parameter* values. These are identical IF the contract emits `FeeAccrued`
   exactly when it increments `accruedFees`. The design doc requires this
   (§4: "Emitted on every fee debit"; §6.5: "decrement → transfer → emit" — same
   for accrual). So either definition works; the statement uses (a) as canonical
   because it's externally observable, with (b) as the implementation reality.

2. **Per-token counters live in the harness, NOT the contract.** Adding
   cumulative counters to `AdminConfigStorage` would (a) cost 2 SSTORE per
   accrual + 1 SSTORE per withdraw (architect C2), and (b) be redundant with
   event emission. The harness already proves a similar property via
   `lastFeeReceiverBalance`; the new mappings are the right home.

3. **Assertion timing: after every fuzz tick** (matches `echidna_*`
   convention). NOT per settlement op — Echidna's standard run model evaluates
   `echidna_*` after every state-mutating call. The harness wrapper updates
   `sumFeeAccrued[t]` on the success branch BEFORE the next echidna tick, so
   `echidna_fee_accounting_symmetry` sees a consistent (`accruedFees`,
   `sumFeeAccrued`, `sumFeesWithdrawn`) triple.

4. **Withdraw driver granularity.** The `fuzz_withdrawFees(uint128
   rawAmount)` driver MUST also exercise the `type(uint256).max` drain path —
   recommend `if (rawAmount % 16 == 0) amount = type(uint256).max;` so ~6% of
   ticks drain. This pins the `w = (amount == max ? accrued : amount)`
   resolution branch.

### 5. Conflict check — INV-FEE-NEW vs INV-FEE-3

**Verdict: NO CONFLICT — INV-FEE-NEW strengthens INV-FEE-3.**

Walking the operator-fill path (`SettlementFacet._executeOperatorFill`, current
lines 759-809) under SCRUM-236:

- Today (lines 791-794, sell-side 803-806): `safeTransferFrom(order.maker,
  feeReceiver, fee)` (buy-side) or `safeTransferFrom(msg.sender, feeReceiver, fee)`
  (sell-side). `feeReceiver` is the sink. `msg.sender` (the operator) is the
  trade counterparty (receives/pays `netCollateral`), never the fee sink.
  INV-FEE-3 today says: "the operator (`msg.sender` of `matchOrders`/`fillOrder`)
  is **never** a fee recipient."
- Under SCRUM-236: the fee `safeTransferFrom` becomes
  `safeTransferFrom(payer, address(this), fee)` — `payer` is `order.maker` (buy-side)
  or `msg.sender` / the operator (sell-side, where the operator pays a fee out
  of its own collateral). The sink is `address(this)` (the Diamond). The
  Diamond then credits `acs.accruedFees[token]` and emits `FeeAccrued`.

Two sub-questions to confirm:

**(a) Sell-side: the operator is the payer when `order.side == 1`. Does that make
the operator a fee SINK?** No. The operator is the *payer* of the fee (the fee
comes out of the operator's collateral, like a maker rebate-not-rebate), but
the *recipient* is the Diamond (which then credits `accruedFees`, owner-withdrawable).
The operator's collateral balance after the leg is `op_before - netCollateral -
fee`; the operator never receives `fee` back, so it is not a fee sink. INV-FEE-3
holds. (Stronger now: the operator never even touches `feeReceiver` — pre-SCRUM-236
the operator's `safeTransferFrom` paid `feeReceiver` directly; post-SCRUM-236 the
operator's `safeTransferFrom` pays the Diamond. Same net effect, smaller surface.)

**(b) Does INV-FEE-NEW's `accruedFees[token] += fee` clause violate INV-FEE-3?**
No — `accruedFees` is an admin-treasury accumulator, not "the operator." The
sink is `address(this)` (the Diamond / protocol treasury); the operator is the
authenticated `msg.sender` for the entry function but is structurally distinct
from the fee accumulator. INV-FEE-3's text "**feeReceiver** is the only fee
sink" is mildly outdated under SCRUM-236 (the sink is now `accruedFees[token]`
within the Diamond, which subsequently flows to `feeReceiver` via `withdrawFees`),
but the *intent* — the operator is not a fee sink — is preserved and strengthened.

**Recommendation** (out of scope for this review, but a follow-on edit on
INV-FEE-3): under SCRUM-236, rewrite INV-FEE-3 as:

> ### INV-FEE-3 — `accruedFees[token]` is the sole fee sink at settlement; `feeReceiver` is the sole withdraw destination
> All settlement / redemption fees credit `LibAdminConfigStorage.adminConfigStorage().accruedFees[token]`
> on accrual. The operator (`msg.sender` of `matchOrders` / `fillOrder`) is **never** a fee
> recipient; on `fillOrder` the operator is the trade counterparty and receives/pays
> *collateral* (`netCollateral`), but the `fee` leg always credits `accruedFees`. On
> `withdrawFees(token, amount)` the Diamond debits `accruedFees[token]` and `safeTransfer`s
> the amount to `acs.feeReceiver` (the sole withdraw destination).

This is a clean strengthening — preserves the operator-not-a-sink guarantee
and adds the two-stage flow. **Strongly recommend** this edit accompany
SCRUM-236 implementation, but it does not block the design.

### 6. Conflict check — INV-FEE-NEW vs INV-FEE-5

**Verdict: NO CONFLICT — orthogonal.**

INV-FEE-5 (`audit/business-logic/invariants.md:334-344`) bounds the **rate**:
`maxFeeRateBps ∈ [0, MAX_FEE_RATE_BPS_CAP = 1000]`, set by `AdminConfigFacet.setMaxFeeRate`
via `LibDiamond.enforceIsContractOwner`. INV-FEE-NEW conserves the **debit** as
a flow-accounting identity. They operate on different axes:

- INV-FEE-5: input-validation property on the configuration setter.
- INV-FEE-NEW: state-flow property across the settlement lifecycle.

Neither references `feeReceiver` (INV-FEE-5 is about the *rate*, INV-FEE-NEW
is about the *accumulator*). The withdraw destination (`feeReceiver`) is
implicit in INV-FEE-NEW via `sumFeesWithdrawn`, but is gated by
`AdminConfigFacet.setFeeReceiver` (a separate setter not covered by INV-FEE-5
today — the IDed-as-"set by owner only" guarantee for `feeReceiver` lives
implicitly under the access-control posture). No overlap, no contradiction.

**Note on a future hardening (out of scope):** if a reviewer wants to fold
`setFeeReceiver` into INV-FEE-5's text — "all fee governance setters are
owner-only" — that's a one-line extension. Not required for SCRUM-236.

### 7. INV-SOLV-4 META-CHECK — enumerate Diamond-as-`from` sites

**Verdict: ACCEPT — all 5 existing sites preserve `balance >= outstandingPairs + accruedFees`.**

Per §6.1 of the design doc, every `safeTransfer` / `safeTransferFrom` where the
Diamond is `from` (i.e. decreases `balanceOf(Diamond, t)`) must symmetrically
decrease `outstandingPairs[t]` (CTF backing) or `accruedFees[t]` (fee bank).
Walking every site in the current code + the new `withdrawFees`:

1. **`SettlementFacet._settleMerge` lines 735-741** — `safeTransfer(taker.maker,
   takerNet)` + `safeTransfer(maker.maker, makerNet)` + `safeTransfer(feeReceiver,
   totalFees)`.
   - **POST-SCRUM-236:** the third call becomes `acs.accruedFees[token] +=
     totalFees` (no external transfer). The first two calls debit
     `takerNet + makerNet == f - totalFees`. The CTF merge inside
     `_mergePositionsInternal` credits the Diamond by `+f` collateral
     (Diamond is the sender, so `safeTransfer` is skipped per line 197 — the
     burn alone delivers the `f` collateral notional). Net balance delta:
     `+f - (takerNet + makerNet) = +totalFees`. `outstandingPairs[t]` decreases
     by `f` (harness ratchet at line 740). `accruedFees[t]` increases by
     `totalFees`. **Preservation check:** LHS = `+totalFees`. RHS = `-f +
     totalFees`. Δ(LHS) >= Δ(RHS) iff `totalFees >= -f + totalFees`, i.e.
     `f >= 0`. **HOLDS.**
   - **Caveat / implementer note:** the `_settleMerge` code post-SCRUM-236 must
     *eliminate* the `safeTransfer(feeReceiver, totalFees)` external call AND
     replace it with the accrual + emit. The narrow refactor must NOT leave both
     paths (double-accounting). Verify in code review.

2. **`ConditionalTokensFacet._handlePayoutTransfer` lines 226, 237** — `safeTransfer(recipient,
   amount)` (zero-fee branch) AND `safeTransfer(feeReceiver, feeAmount)` +
   `safeTransfer(recipient, userAmount)` (fee branch).
   - **POST-SCRUM-236:** the `safeTransfer(feeReceiver, feeAmount)` becomes an
     internal accrual (`acs.accruedFees[token] += feeAmount`); the
     `safeTransfer(recipient, userAmount)` remains. The Diamond's balance
     decreases by `userAmount`; `outstandingPairs[t]` decreases by `amount`
     (the redeemed payout — the harness ratchet must subtract `amount` from
     its `outstandingPairs` view on redemption); `accruedFees[t]` increases
     by `feeAmount`.
   - **Preservation check:** LHS Δ = `-userAmount = -(amount - feeAmount)`.
     RHS Δ = `-amount + feeAmount = -(amount - feeAmount)`. EQUAL. **HOLDS.**
   - **Harness note:** the current `DoefinInvariantHarness` does NOT exercise
     `redeemPositions` (only Mint/Merge/Complementary/Fill). To exercise the
     resolution-fee branch of INV-FEE-NEW, the harness should add a
     `fuzz_redeem` driver that prepares + resolves a condition and calls
     `redeemPositions`. **Tracked as a SCRUM-236 follow-on harness gap** —
     not blocking, but flagged. See §10.

3. **`SettlementFacet._executeOperatorFill` sell-side lines 802-803, 805** —
   Diamond is `from` only on the ERC-1155 transfer (line 802) where it acts as
   the seller-side ERC-1155 operator (`LibERC1155.safeTransferFrom(address(this),
   order.maker, msg.sender, ...)`); the ERC-20 leg (line 803) has the operator
   as the `from`, NOT the Diamond. The fee leg (line 805) has the operator as
   the `from`, NOT the Diamond. **POST-SCRUM-236:** the line-805 fee becomes
   `safeTransferFrom(msg.sender, address(this), fee)` + accrual. The Diamond's
   ERC-20 balance increases by `+fee`, `accruedFees[t]` increases by `+fee`,
   `outstandingPairs[t]` unchanged. Preservation: LHS Δ = `+fee`, RHS Δ =
   `+fee`. EQUAL. **HOLDS.**
   - The Diamond is never `from` on any ERC-20 transfer on the buy-side of
     `_executeOperatorFill` (lines 790, 793, 797 — order.maker pays, operator
     receives, Diamond acts as the ERC-1155 operator). Unchanged by SCRUM-236.

4. **`LibCTFCondition._mergePositionsInternal` line 198** — `safeTransfer(sender,
   amount)`. In every Doefin v3 path the `sender` is `address(this)` (Diamond
   calls itself from `_settleMerge`), so the `safeTransfer` is short-circuited
   by the `if (sender != address(this))` guard at line 197 and never executes.
   The transfer back to the Diamond's balance is implicit in the CTF burn
   semantics. **Therefore: Diamond is NEVER `from` on this path under SCRUM-236.**
   HOLDS trivially.
   - User-facing `_mergePositions` (line 60): `safeTransfer(sender, amount)`
     where `sender` is a non-Diamond EOA/SCW (the merge caller). Diamond IS
     `from`. The harness ratchet decrements `outstandingPairs[t]` by `amount`
     (the merge burns `amount` of each outcome and recovers `amount` collateral
     to the caller). Preservation: LHS Δ = `-amount`, RHS Δ = `-amount`.
     EQUAL. **HOLDS.**

5. **`AdminConfigFacet.withdrawFees` (new, per §6.7 of design)** —
   `acs.accruedFees[token] -= w` then `safeTransfer(feeReceiver, w)` then
   `emit FeesWithdrawn`. Diamond is `from`. Preservation: LHS Δ = `-w`,
   `outstandingPairs[t]` Δ = 0, `accruedFees[t]` Δ = `-w`. RHS Δ = `-w`.
   EQUAL. **HOLDS.**
   - The local check `w <= acs.accruedFees[token]` (line ~234 of design
     pseudocode) is necessary AND sufficient given the harness invariant
     `accruedFees[t] >= 0` (Solidity 0.8.20 checked arithmetic forbids
     underflow regardless). The `feeReceiver == address(0)` post-check
     prevents `safeTransfer` to the zero address (which would also revert,
     but fail-closed earlier is cleaner per §6.7).

**Walkthrough result:** all 5 sites preserve `balance >= outstandingPairs +
accruedFees`. **No site violates INV-SOLV-4-revised.**

**Future-facet hazard (architect §6 item 1 meta-check):** any *new* facet that
adds a Diamond-as-`from` transfer (treasury rebalancer, cross-position
swap, etc.) MUST be added to this walk before merge. The §6.1 meta-check
text should be promoted to a **reviewer checklist gate** that fires whenever
a PR adds an `IERC20.safeTransfer*(...)` call where the from-address is
`address(this)` (or is omitted, which defaults to Diamond on the
`safeTransfer` call). Worth banking as a `.coderabbit.yml` `path_instructions`
addition for `contracts/facets/*.sol`.

### 8. `fee == 0` symmetric case

**Verdict: ACCEPT — correct behaviour; required for both INV-FEE-NEW symmetry and CR-3291973203-regression.**

Walking the spec:

- Design §4 "Removed / renamed": "When `fee == 0`, **no accrual increment
  AND no `FeeAccrued` emission** — preserves the CR-3291973203-regression-check
  behaviour."
- Today's code (e.g. `SettlementFacet._settleComplementary` lines 554, 561)
  already has `if (buyerFee > 0) { ... emit FeeCharged(...) }` — the design
  preserves this guard, just swaps the transfer-and-emit body for an
  accrual-and-emit body. The accrual MUST be inside the `if (fee > 0)` block,
  not outside.

**INV-FEE-NEW symmetry under `fee == 0`:**

- LHS (`sumFeeAccrued[t]`) Δ = 0 (no emit).
- RHS (`accruedFees[t]`) Δ = 0 (no SSTORE).
- Equation `sumFeeAccrued == accruedFees + sumFeesWithdrawn` is preserved
  trivially (both sides static).

**CR-3291973203 regression:** the original CR finding was about the
**redemption** path's hard `feeReceiver == address(0)` revert blocking
`redeemPositions` on a zero-fee deploy. Under SCRUM-236 the `feeReceiver`
check moves to `withdrawFees`, so the redemption path no longer cares about
`feeReceiver`. Per the design's per-fee-site walk: when `resolutionFeeBps ==
0` the `_handlePayoutTransfer` zero-fee branch (today: line 224-230) just
transfers the full payout and returns — no `accruedFees` increment, no
`FeeAccrued` emit, no `InvalidFeeReceiver` check. This is the correct
behaviour and is required for the CR-3291973203 fix.

**Edge case worth pinning in the test plan:** "operator passes `fee == 0`
when `maxFeeRateBps > 0`" — `_validateFee` short-circuits at line 830 (`if
(fee == 0) return;`), so the call proceeds with no accrual. The harness's
`_legFee` helper currently computes a non-zero fee from `FEE_BPS = 25` — to
exercise the symmetric branch the harness should also have a `_legFee_zero()`
variant or randomize fee = 0 ~50% of ticks. **Minor harness gap; non-blocking.**

### 9. CR-3291973200 subsumption completeness

**Verdict: ACCEPT-WITH-CAVEAT — floor removal is the necessary fix for CR-3291973200; INV-FEE-NEW symmetry is a stronger complement, not a replacement. Both are required to fully resolve.**

Walking the subsumption claim:

- **CR-3291973200's narrow defect:** `echidna_diamond_solvent()` floors
  required backing via `(outstandingPairs / UNIT) * UNIT`, masking up to
  `UNIT - 1` wei of under-collateralization.
- **SCRUM-236's claim (§5.INV-SOLV-4 pin-down #1):** removing the floor +
  adding `accruedFees[t]` to the RHS subsumes the finding.

**Is the floor removal sufficient on its own to fully resolve CR-3291973200?**
YES — the original defect is purely the floor. Even without SCRUM-236, dropping
the floor (returning `collateral.balanceOf(diamond) + ROUNDING_TOLERANCE >=
outstandingPairs`) closes the sub-`UNIT` blind spot. CR-3291973200's
remediation diff (in `audit/coderabbit-triage/PR-23.md` lines 422-434) does
exactly this and stands on its own.

**Does SCRUM-236 also need INV-FEE-NEW symmetry to fully resolve?** NO for the
CR-3291973200 surface specifically (which is only about the floor), but YES
for the *broader* SCRUM-236 surface — without the per-token symmetry, a
reviewer cannot reason about whether un-withdrawn fees are correctly
distinguishable from position-backing. INV-FEE-NEW is the load-bearing
*addition* that justifies the `+ accruedFees[t]` on the RHS of INV-SOLV-4.
Without INV-FEE-NEW, an attacker (or an accidental future facet) could:

- Credit `accruedFees[t]` without actually transferring collateral in, and
  INV-SOLV-4 would still hold trivially while the Diamond is actually
  under-collateralized.
- Transfer collateral OUT of the Diamond (e.g. via a treasury rebalance)
  without decrementing `accruedFees[t]`, and INV-SOLV-4 would START to fail
  but the harness has no way to localize the bug to the fee bank vs the
  position backing.

INV-FEE-NEW provides the *forensic* second invariant that pins fee bookkeeping
independently of position bookkeeping. **Both must land for the SCRUM-236
surface to be fully covered.**

**Conclusion:** the design doc's framing ("floor removal subsumes
CR-3291973200") is correct *for the original CR defect*; the additional
INV-FEE-NEW is needed to make the new co-mingling surface (the §6.1 meta-check)
auditable. SCRUM-236 needs both.

### 10. Anything else

**One LOW-INFO rounding-edge clarification + 3 minor follow-ups.**

**(A) Resolution-fee floor-division surplus is NOT an INV-FEE-NEW violation.**

The redemption path computes `feeAmount = (amount * feeBps) /
LibConstants.BPS_DENOMINATOR` and `userAmount = amount - feeAmount` (file
`ConditionalTokensFacet.sol:232-233`). The floor-division on `feeAmount`
truncates up to `(BPS_DENOMINATOR - 1)/BPS_DENOMINATOR < 1` wei in favour of
the redeemer (the user gets the rounding surplus). Under SCRUM-236:

- `accruedFees[t]` is incremented by exactly `feeAmount` (the *truncated* value
  the contract computed).
- The `FeeAccrued.amount` event field carries exactly `feeAmount`.
- `sumFeeAccrued[t]` therefore tracks the truncated `feeAmount`.

INV-FEE-NEW's predicate is `sumFeeAccrued == accruedFees + sumFeesWithdrawn`.
Both sides reference the SAME truncated `feeAmount`, so symmetry holds
exactly. The 1-wei-per-redemption "lost to redeemer" surplus is NOT a
"fee debited but not credited" scenario — it is "fee never computed in
the first place" (the contract never sees it as fee; it gets paid to the
user). **HOLDS.**

For the harness: `sumFeeAccrued[t]` must be incremented by the SAME
`feeAmount = (amount * feeBps) / 10000` that the contract computes — NOT by
`amount * feeBps / 10000` computed with full-precision arithmetic. Easy to
get wrong; pin in the harness implementation note.

**(B) Settlement-fee rounding direction.**

The trading-fee accruals (`_settleComplementary`, `_settleMint`, `_settleMerge`,
`_executeOperatorFill`) take the fee amount as a `uint128` parameter from the
operator — no floor-division happens contract-side. `_validateFee` computes
`maxAllowed = (cashValue * maxFeeRateBps) / BPS_DENOMINATOR` (also a floor)
purely for the bound check; the actual `fee` is what the operator passes.
Therefore there is NO contract-side rounding to worry about on the trading
fees — INV-FEE-NEW's `sumFeeAccrued[t] == ∑ fee_i` is exact by construction.

**(C) Edge case: collateral allow-list removal between accrual and withdraw.**

Design §7 specifies the post-delist withdraw test:
`addCollateralToken(USDC)` → fee-bearing trade → `removeCollateralToken(USDC)`
→ `withdrawFees(USDC)` succeeds. Verify INV-FEE-NEW's quantifier handles this:
the equation is quantified over `acs.isAllowed[token] == true`, but if a token
is delisted between accrual and withdraw, the equation must STILL hold for
that delisted token (because both `accruedFees[t]` and `sumFeesWithdrawn[t]`
keep tracking it).

**Refinement to INV-FEE-NEW quantifier:**

> ∀ token ∈ {ever-allow-listed-collaterals ∪ currently-allow-listed-collaterals}:
>     sumFeeAccrued[token] == acs.accruedFees[token] + sumFeesWithdrawn[token]

Equivalently, "∀ token such that `sumFeeAccrued[token] > 0` OR
`acs.accruedFees[token] > 0`" — i.e. any token the contract has *ever* seen.
The harness mapping covers this automatically (it only ratchets up).

Sharpen the design's quantifier in implementation to avoid a subtle gap where
a delisted token's `accruedFees` becomes "unobservable" by the predicate.
**One-line documentation fix** in the formal statement above; not a code change.

**(D) Reentrancy posture on the new `withdrawFees`.**

Design §6.2 specifies the entire `withdrawFees` body sits inside
`LibReentrancyGuard._nonReentrantBefore/After`. Note that the existing
`SettlementFacet.matchOrders` / `fillOrder` are `nonReentrant`, but
`AdminConfigFacet.setX` setters today are NOT guarded (they don't make
external calls). `withdrawFees` is the first AdminConfig surface to make an
external call, so it MUST add the guard. The design has this; calling out for
the implementer that this is the FIRST AdminConfig setter to be guarded
(historical convention is "AdminConfig setters don't need guards").

## Open questions for the design author (if any)

**None blocking.** Two clarifications would help the implementer but do not
require design changes:

- **Q1.** Should INV-FEE-3 be rewritten as part of SCRUM-236 (per §5
  recommendation above), or deferred to a separate `invariants.md` refresh
  pass? Recommend folding into SCRUM-236 since the implementer is already
  touching the fee model — fold the one-paragraph rewrite into the SCRUM-236
  PR as a single-file edit on `audit/business-logic/invariants.md`.

- **Q2.** Should the `fuzz_redeem` driver (needed to exercise INV-FEE-NEW's
  resolution-fee branch, per §7 walkthrough item 2) land in SCRUM-236 or in
  a follow-on harness ticket? Recommend SCRUM-236, since the harness is
  already in scope per §6.12 and the symmetry property is partially
  unobserved without it.

## Recommendation

`READY-FOR-IMPLEMENTATION`.

The design doc v2 is invariant-coherent. All 4 invariant rewrites
(INV-SOLV-1, INV-SOLV-3, INV-SOLV-4 revised, INV-FEE-NEW new) compose without
conflict against the existing 22 invariants; the meta-check on Diamond-as-`from`
transfers is satisfied by every existing site; the `fee == 0` symmetric case
is correctly handled; CR-3291973200's narrow defect is subsumed by the floor
removal (with INV-FEE-NEW as the load-bearing complement for the broader
co-mingling surface).

The exact replacement text for INV-SOLV-1 (§2) and INV-SOLV-3 (§3), and the
formal INV-FEE-NEW entry (§4), are ready for the implementer to drop into
`audit/business-logic/invariants.md` in the same SCRUM-236 commit as the
contract changes. Recommend also folding the §5 INV-FEE-3 rewrite into the
same PR for consistency.

Two minor follow-ons (a `fuzz_redeem` driver in the harness; a quantifier
refinement to "ever-allow-listed tokens") are non-blocking and explicitly
called out in §10.
