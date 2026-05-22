# Doefin v3 — Economic Invariant Specification

Domain 3 (business-logic) deliverable. **Pinned to: current `v3/dev`, post Phase-2
remediation (SCRUM-229 / SCRUM-230 / SCRUM-231)** — i.e. after the v3 fee redesign
(SCRUM-223/224/226: 10-field order, operator-supplied fee model, cross-currency removal)
and the Phase-2 remediation (EIP-7201 namespacing, `SettlementAdminFacet` extraction,
`LibSignature` consolidation). This **supersedes** the prior revision pinned to
`015097c1`, which predated all of the above.

This is the canonical property list for the v3 settlement core. It is written to be
mechanically translatable into Echidna `echidna_*` properties — every invariant states
the **state**, the **bound**, and the **rounding tolerance** explicitly. It is the input
contract for the Phase-3 fuzzing harness (`contracts/audit/DoefinInvariantHarness.sol`).

## Scope and notation

- `SettlementFacet.matchOrders` / `fillOrder` are the only state-mutating settlement
  entry points reviewed here. `SettlementAdminFacet` (operator/pause) and
  `NonceManagerFacet` (cancellation/nonce) provide the governance/cancellation surface.
- `unit` = `LibAdminConfigStorage.adminConfigStorage().unitPerPair[token]` (USDC = `1e6`).
  Set per token by the owner via `AdminConfigFacet.addCollateralToken`; `_validateOrder`
  reverts `InvalidUnitPerPair` if `unit == 0`, so every order reaching a `_settleX`
  routine has `unit > 0`.
- `f` = fill amount for a given leg (`uint128`, non-zero — guarded).
- `P_t`, `P_m` = `taker.pricePerToken`, `maker.pricePerToken` (`uint128`). `_validateOrder`
  reverts `InvalidPrice` if `pricePerToken > unit`, so `0 <= P <= unit` for every order
  that reaches settlement.
- `filled[h]` = `LibSettlementStorage.settlementStorage().orderHashToFilledAmount[h]`.
- `takerFee_i` / `makerFee_i` = the **operator-supplied** per-leg fee amounts (`uint128`).
  They are NOT signed and NOT derived from the order — they are `matchOrders` /
  `fillOrder` calldata parameters.
- `maxFeeRateBps` = `adminConfigStorage().maxFeeRateBps` (`uint16`), admin-set via
  `AdminConfigFacet.setMaxFeeRate`, bounded by `MAX_FEE_RATE_BPS_CAP = 1000` (10%).
- `BPS_DENOMINATOR = 10_000` (`LibConstants`).
- `floorDiv` is integer division (Solidity `/`); `ceilDiv(a,b) = (a + b - 1) / b`.
- "Diamond" = the EIP-2535 proxy; it custodies ERC-20 collateral and is the issuer of
  ERC-1155 position tokens.

Each invariant carries: **ID**, **statement**, **where enforced / why it holds**, **fuzz
encoding**, and **status** (HOLDS / HOLDS-CONDITIONALLY / AT-RISK). AT-RISK and
HOLDS-CONDITIONALLY items map to entries in
`audit/findings/business-logic-findings.md`.

## What changed vs the `015097c1` revision

| Area | Old doc | This revision |
|---|---|---|
| Order struct | 15 fields, `INV-SIG-1` is a 15-field parity check | 10 fields; `INV-SIG-1` is a 10-field parity check (still PASS) |
| Fee model | `feeRateBps` signed in order; `_computeFee`; `MAX_FEE_RATE_BPS = 500`; `FeeTooHigh` | Operator-supplied per-leg fee amounts; `_validateFee` (pure); admin-set `maxFeeRateBps` ≤ `MAX_FEE_RATE_BPS_CAP = 1000`; `FeeExceedsMaxRate` / `FeeExceedsProceeds`. Whole "Fee invariants" section rewritten. |
| `side` domain | `INV-MATCH-2` AT-RISK (`side > 1` not enforced) | RESOLVED — `_validateOrder` reverts `InvalidMatch` for `side > 1` |
| Domain separator | `INV-DOMAIN-1` AT-RISK (cache, fork hazard) | RESOLVED — cache removed (SEC-004); all three facets recompute via `LibDoefinOrder.diamondDomainSeparator` |
| Merge solvency | `INV-SOLV-2` HOLDS-CONDITIONALLY (silent payout-skip, BIZ-001) | RESOLVED — every settle path enforces `fee <= proceeds`; merge has an explicit `FeeExceedsProceeds` revert before any transfer |
| `minFillAmount` | `INV-MISC-1` signed-but-ignored | field removed entirely; invariant deleted |
| Fill-sum mismatch | reverts `MismatchedInputLengths` | reverts `FillAmountMismatch(sumOfMakerFills, takerFillAmount)` (CPX-008) |
| `_validateOrder` | did not gate collateral allow-list / unit / price on the hot path | gates allow-list (`TokenNotAllowed`), `unit != 0` (`InvalidUnitPerPair`), `price <= unit` (`InvalidPrice`), `side <= 1` (`InvalidMatch`) |

---

## A. Solvency invariants (Diamond collateralization)

These are the crown-jewel properties. A violation is Diamond insolvency.

### INV-SOLV-1 — Mint conserves collateral exactly
After any successful `_settleMint` leg, the ERC-20 collateral transferred *into* the
Diamond equals the position-token notional minted:

```
takerCollateral + makerCollateral == f
```

where `makerCollateral = floorDiv(P_m * f, unit)` and
`takerCollateral = f - makerCollateral`. The Diamond then calls
`LibCTFCondition._splitPositionInternal(this, ..., f, partition)`, which — because
`sender == address(this)` — does **not** pull collateral from itself, and mints exactly
`f` of each of the two outcome tokens to the Diamond. The Diamond then transfers `f` of
position A to the taker and `f` of position B to the maker.

- **Enforced:** `SettlementFacet.sol` `_settleMint` (lines ~529-574). By construction —
  `takerCollateral` is the remainder, so the sum telescopes to `f` for *all* price inputs
  with no rounding gap. The fees (`takerFee`, `makerFee`) are transferred separately,
  *directly to `feeReceiver`*, and never enter the Diamond's collateral balance.
- **Fuzz encoding:** after a fuzzed mint, assert
  `collateralToken.balanceOf(diamond)_after - _before == f` AND
  `erc1155.balanceOf(taker, posA)` and `erc1155.balanceOf(maker, posB)` each increased
  by exactly `f`.
- **Status:** HOLDS. (Independent of the `P_t + P_m >= unit` crossing check — that check
  is order-fairness, not solvency; see INV-PRICE-1.)

### INV-SOLV-2 — Merge conserves collateral exactly
After any successful `_settleMerge` leg, the collateral *recovered* by the merge (`= f`)
equals the total collateral *paid out* (to taker, maker, and feeReceiver):

```
takerNet + makerNet + totalFees == f
```

with `makerPayout = floorDiv(P_m * f, unit)`, `takerPayout = f - makerPayout`,
`takerNet = takerPayout - takerFee`, `makerNet = makerPayout - makerFee`,
`totalFees = takerFee + makerFee`. Substituting telescopes to
`takerPayout + makerPayout == f`.

- **Enforced:** `SettlementFacet.sol` `_settleMerge` (lines ~583-657).
  `_mergePositionsInternal(this, ...)` burns `f` of each outcome token and credits the
  Diamond exactly `f` collateral. The payout transfers are now **unconditional** —
  `safeTransfer(taker, takerNet)` / `safeTransfer(maker, makerNet)` — and the prior
  silent-skip guards are gone.
- **Why it holds unconditionally (BIZ-001 resolved):** before any transfer, the function
  asserts `takerFee <= takerPayout` and `makerFee <= makerPayout`, reverting
  `FeeExceedsProceeds` otherwise (line ~640). Hence `takerNet`/`makerNet` never underflow
  and every party's payout is either paid in full or the whole call reverts. Solvency no
  longer depends on the fee cap. `_validateFee` additionally bounds each fee by the
  max-rate.
- **Fuzz encoding:** after a fuzzed merge, assert
  `collateralToken.balanceOf(diamond)_after == _before` (net-zero — the Diamond is a
  pass-through for merge), and `takerNet + makerNet + totalFees == f`. Drive `takerFee`
  above `takerPayout` and confirm a clean `FeeExceedsProceeds` revert (no underflow
  panic, no partial state).
- **Status:** HOLDS. The BIZ-001 silent-skip is resolved by the `fee <= proceeds` guard.

### INV-SOLV-3 — Complementary settlement never touches Diamond collateral
`_settleComplementary` performs only `safeTransferFrom` *between* the two counterparties
and the feeReceiver, plus one ERC-1155 transfer from seller to buyer. The Diamond's own
ERC-20 balance and its own ERC-1155 balance are unchanged.

- **Enforced:** `SettlementFacet.sol` `_settleComplementary` (lines ~446-501). All
  `IERC20.safeTransferFrom` calls move funds buyer→seller, buyer→feeReceiver,
  seller→feeReceiver; the position-token transfer is seller→buyer. The Diamond is the
  ERC-1155 operator but not a `from`/`to`.
- **Fuzz encoding:** assert `collateralToken.balanceOf(diamond)` unchanged and
  `erc1155.balanceOf(diamond, posId)` unchanged across a fuzzed complementary settlement.
- **Status:** HOLDS.

### INV-SOLV-4 — Aggregate position-token backing
For any condition/collateral market, the total ERC-1155 supply of the two outcome tokens
in circulation is fully backed: every outcome-token pair corresponds to `unit` collateral
deposited via `splitPosition` / `_settleMint` and not yet removed via
`mergePositions` / `_settleMerge` / `redeemPositions`.

- **Why it holds:** follows from INV-SOLV-1 (mint deposits `f`, issues `f`+`f`),
  INV-SOLV-2 (merge burns `f`+`f`, withdraws `f`), and the CTF split/merge accounting in
  `LibCTFCondition`. Settlement never mints or burns position tokens outside the
  `_splitPositionInternal` / `_mergePositionsInternal` calls — every other ERC-1155 op on
  the settlement paths is a *transfer* (conserves supply).
- **Fuzz encoding:** global property — track cumulative `splitDeposited - mergeWithdrawn`
  and assert `collateralToken.balanceOf(diamond) >= cumulativeUnredeemedBacking` after
  every call. This is the master `echidna_diamond_solvent` property.
- **Status:** HOLDS (derived).

---

## B. Price / crossing invariants (fair execution)

### INV-PRICE-1 — Mint taker is never charged above signed price
In `_settleMint` the taker's effective price is `(unit - P_m)`. The crossing check
`P_t + P_m >= unit` (i.e. `unit - P_m <= P_t`) guarantees the taker pays at most their
signed `P_t` per token:

```
takerCollateral == f - floorDiv(P_m * f, unit) == ceilDiv((unit - P_m) * f, unit)
                <= ceilDiv(P_t * f, unit)
```

- **Enforced:** `SettlementFacet.sol` `_settleMint`
  `if (P_t + P_m < unit) revert InvalidMatch()` (line ~523).
- **Rounding tolerance:** `takerCollateral` is the remainder, so the taker may pay up to
  **+1 wei** above the exact `floorDiv((unit - P_m) * f, unit)`. This is the documented
  "1-wei rounding surplus" (code comment line ~533) — exactly 1 wei, always in the
  taker's debit direction, never the maker's.
- **Maker side:** `makerCollateral = floorDiv(P_m * f, unit)` — the maker pays *exactly*
  their signed price (rounded down). The maker is never overcharged.
- **Fuzz encoding:** for a fuzzed mint with `P_t + P_m >= unit`, assert
  `takerPaid == f - floorDiv(P_m*f, unit)` AND
  `takerPaid <= floorDiv(P_t*f, unit) + 1` AND `makerPaid == floorDiv(P_m*f, unit)`.
- **Status:** HOLDS.

### INV-PRICE-2 — Merge taker never receives below signed floor
In `_settleMerge` the taker's effective return is `(unit - P_m)`. The crossing check
`P_t + P_m <= unit` guarantees the taker receives at least their signed `P_t` floor:

```
takerPayout == f - floorDiv(P_m * f, unit) >= floorDiv(P_t * f, unit)
```

- **Enforced:** `SettlementFacet.sol` `_settleMerge`
  `if (P_t + P_m > unit) revert InvalidMatch()` (line ~600). **Ordering note (old
  ledger BIZ-002, resolved):** this check now runs *before* `_mergePositionsInternal`,
  mirroring `_settleMint`'s checks-before-effects ordering.
- **Maker side:** `makerPayout = floorDiv(P_m * f, unit)` — the maker receives exactly
  their signed price. The ≤1-wei rounding surplus flows to the taker (credit direction).
- **Fuzz encoding:** for a fuzzed merge with `P_t + P_m <= unit`, assert
  `takerReceived (gross) == f - floorDiv(P_m*f, unit)` AND
  `takerReceived >= floorDiv(P_t*f, unit)` AND `makerReceived (gross) == floorDiv(P_m*f, unit)`.
- **Status:** HOLDS.

### INV-PRICE-3 — Complementary requires buyer price ≥ seller price
`_settleComplementary` reverts `InvalidMatch` unless `buyerPrice >= sellerPrice`, and
executes at the **maker's** price: `collateralAmount = floorDiv(P_maker * f, unit)`.

- **Enforced:** `SettlementFacet.sol` `_settleComplementary` (lines ~466-474).
- **Consequence:** the buyer pays the maker's price; if the buyer is the taker they may
  receive price improvement (pay `P_m <= P_t`); if the buyer is the maker they pay
  exactly their own price. The seller always receives the maker's price. No party
  transacts outside their signed bound.
- **Fuzz encoding:** for a fuzzed complementary settlement assert
  `collateralAmount == floorDiv(makerPrice * f, unit)` and that the call reverts whenever
  `buyerPrice < sellerPrice`.
- **Status:** HOLDS.

### INV-PRICE-4 — pricePerToken is bounded by unit on every path
`_validateOrder` reverts `InvalidPrice` if `uint256(order.pricePerToken) > unit`. This
runs for the taker and **every** maker on `matchOrders`, and for the single order on
`fillOrder`, *before* any settlement routing.

- **Enforced:** `SettlementFacet.sol` `_validateOrder` line ~338.
- **Closed gap vs old doc:** the old doc flagged that `price > unit` was only checked in
  `_computeFee` and only when `feeBps != 0`, leaving complementary / operator-fill paths
  unguarded (old BIZ-005). `_computeFee` is gone; the `price <= unit` bound is now a
  universal `_validateOrder` precondition, so every `_settleX` and `_executeOperatorFill`
  may trust `P <= unit` (this is what makes the `unchecked` price multiplications safe —
  `P * f <= unit * 2^128`, far below `2^256`).
- **Fuzz encoding:** fuzz `pricePerToken` over `0..2^128-1`; assert `matchOrders` /
  `fillOrder` revert `InvalidPrice` for any order with `pricePerToken > unit`.
- **Status:** HOLDS.

### INV-PRICE-5 — Off-`unit` price-sum slack is solvency-safe but not strictly fair
The mint crossing check accepts **any** `P_t + P_m >= unit` and the merge check accepts
**any** `P_t + P_m <= unit`. When the sum is strictly off `unit`, the remainder
construction (`takerCollateral = f - makerCollateral`) still keeps the Diamond solvent
(INV-SOLV-1/2), and the maker is always honoured at their signed price; but the taker's
effective price `(unit - P_m)` can differ from their signed `P_t`.

- **Where:** `_settleMint` line ~523 (`<`), `_settleMerge` line ~600 (`>`).
- **Impact:** this is *price improvement / slack distribution*, not solvency. The taker
  signed an order whose `P_t` is a ceiling (mint) or floor (merge); settling at the
  effective price never violates that signed bound — INV-PRICE-1/2 still hold. The
  operator is trusted to match fair pairs.
- **Fuzz encoding:** N/A as a violation property — fuzz `P_t`, `P_m` freely with
  `P_t + P_m >= unit` (mint) and assert INV-SOLV-1 + INV-PRICE-1 hold for every sum,
  not just `sum == unit`.
- **Status:** HOLDS for solvency and for the signed-price bound. The slack is an
  intentional consequence of the SCRUM-121 effective-price model — see **BL-N1**
  (newly-derived business-logic finding, INFO; see findings summary below).

---

## C. Fee invariants

The v3 fee model is **operator-supplied** (Polymarket V2 pattern). The fee is not signed,
not derived from the order, and not computed on-chain. The off-chain operator passes a
per-leg fee *amount* into `matchOrders` (`takerFees[]`, `makerFees[]`) / `fillOrder`
(`fee`). The contract only *validates* it.

### INV-FEE-1 — Fee is bounded by the admin max rate (`_validateFee`)
For every leg, the operator-supplied `fee` satisfies:

```
fee == 0   OR   fee <= floorDiv(cashValue * maxFeeRateBps, BPS_DENOMINATOR)
```

where `cashValue` is the **contract-derived per-party collateral leg** for that party
(never an operator-asserted value):

| Path | party | `cashValue` |
|---|---|---|
| Complementary | buyer | `collateralAmount = floorDiv(P_maker * f, unit)` |
| Complementary | seller | `collateralAmount` (same) |
| Mint | taker | `takerCollateral = f - floorDiv(P_m*f, unit)` |
| Mint | maker | `makerCollateral = floorDiv(P_m*f, unit)` |
| Merge | taker | `takerPayout = f - floorDiv(P_m*f, unit)` |
| Merge | maker | `makerPayout = floorDiv(P_m*f, unit)` |
| Operator-fill | order maker | `collateralAmount = floorDiv(P*f, unit)` |

- **Enforced:** `SettlementFacet._validateFee(fee, cashValue, maxFeeRateBps)` — a `pure`
  function (line ~736). Called per party on every path. Reverts `FeeExceedsMaxRate`.
- **Fail-closed:** `maxFeeRateBps == 0` makes `maxAllowed == 0`, so any non-zero fee
  reverts. A zero rate is **not** "unlimited" — this is a deliberate divergence from
  Polymarket CTF Exchange V2.
- **Fuzz encoding:** for every fuzzed leg recompute `maxAllowed` and assert: if
  `fee == 0` the call does not revert *on the fee check*; if `fee > maxAllowed` the whole
  `matchOrders`/`fillOrder` call reverts `FeeExceedsMaxRate`.
- **Status:** HOLDS.

### INV-FEE-2 — Fee never exceeds the party's proceeds (`fee <= proceeds`)
On every path where a fee is paid *out of* a party's collateral, the contract enforces
`fee <= proceeds` independently of the max-rate check:

- Complementary: `if (sellerFee > collateralAmount) revert FeeExceedsProceeds` (the
  seller's fee comes out of their proceeds; the buyer pays their fee on top, so no
  proceeds bound applies to `buyerFee`).
- Merge: `if (takerFee > takerPayout || makerFee > makerPayout) revert FeeExceedsProceeds`
  — each seller's fee is deducted from that seller's payout.
- Operator-fill: `if (fee > collateralAmount) revert FeeExceedsProceeds`.
- Mint: **no proceeds bound** — both buyers pay their fee *on top of* their collateral
  leg (a separate `safeTransferFrom`), so only the INV-FEE-1 max-rate bound applies.

- **Enforced:** `_settleComplementary` line ~482, `_settleMerge` line ~640,
  `_executeOperatorFill` line ~691.
- **Why this matters:** this is the guard that makes INV-SOLV-2 hold unconditionally
  (subsumes the old BIZ-001 checked-subtraction concern) and prevents the
  `payout - fee` / `collateral - fee` `unchecked` subtractions from underflowing.
- **Fuzz encoding:** drive a fee above the relevant `proceeds` value (but the test must
  set `maxFeeRateBps` high enough that INV-FEE-1 does not fire first) and assert a clean
  `FeeExceedsProceeds` revert with no state change and no underflow panic.
- **Status:** HOLDS.

### INV-FEE-3 — feeReceiver is the only fee sink
All fees route to `adminConfigStorage().feeReceiver`. The operator (`msg.sender` of
`matchOrders`/`fillOrder`) is **never** a fee recipient — on `fillOrder` the operator is
the trade counterparty and receives/pays *collateral*, but the `fee` leg always goes to
`feeReceiver`.

- **Enforced:** `_settleComplementary` (buyer/seller fee → `feeReceiver`), `_settleMint`
  (taker/maker fee → `feeReceiver`), `_settleMerge` (`totalFees` → `feeReceiver`),
  `_executeOperatorFill` (`fee` → `feeReceiver`). Each emits `Events.FeeCharged(feeReceiver, amount)`.
- **Fuzz encoding:** assert the `feeReceiver` ERC-20 balance delta equals the sum of all
  per-leg fees, and the operator's collateral balance delta excludes any fee component.
- **Status:** HOLDS. (The `.claude/CLAUDE.md` text is consistent — the operator is the
  authorized `msg.sender`, not a fee sink.)

### INV-FEE-4 — Taker fee on `matchOrders` is the sum of per-leg operator inputs
On `matchOrders`, the `OrderSettled` event for the taker reports
`totalTakerFee = Σ takerFees[i]` over all maker legs — a plain sum of operator-supplied
inputs, not a contract recomputation. Each `takerFees[i]` is independently bounded by
INV-FEE-1 (and, on complementary/merge legs, by INV-FEE-2) against *that leg's* taker
collateral.

- **Enforced:** `SettlementFacet.sol` `matchOrders` accumulates `totalTakerFee` in the
  loop (line ~157) and emits it (line ~165).
- **Fuzz encoding:** assert the `OrderSettled` taker event's `fee` field equals
  `Σ takerFees[i]`, and that every individual `takerFees[i]` passed its per-leg
  `_validateFee` / `fee <= proceeds` check.
- **Status:** HOLDS.

### INV-FEE-5 — `maxFeeRateBps` is bounded by the hard ceiling
`AdminConfigFacet.setMaxFeeRate` reverts `MaxFeeRateExceedsCeiling` if the requested rate
exceeds `MAX_FEE_RATE_BPS_CAP = 1000` (10%). Therefore at settlement
`maxFeeRateBps ∈ [0, 1000]` always, and the effective fee on any leg is at most 10% of
that leg's `cashValue`.

- **Enforced:** `AdminConfigFacet.sol` `setMaxFeeRate` line ~147.
- **Fuzz encoding:** assert `setMaxFeeRate(r)` reverts for any `r > 1000` and succeeds for
  `r <= 1000`; combined with INV-FEE-1, assert no settled leg's fee exceeds
  `floorDiv(cashValue * 1000, 10000)`.
- **Status:** HOLDS.

---

## D. Fill-accounting invariants

### INV-FILL-1 — An order is never overfilled
`filled[h] + f <= order.amount` for every settlement leg.

- **Enforced:** `_checkFillAmount` (`SettlementFacet.sol` lines ~344-355) reverts
  `OrderOverfilled` if `uint256(f) > order.amount - filled[h]`.
- **Duplicate-maker case (verified safe):** if the same maker order appears twice in
  `makerOrders`, `_settleAgainstMaker` writes `ss.orderHashToFilledAmount[makerHash] += f`
  (line ~220) *inside* the loop, so iteration `i+1`'s `_checkFillAmount` reads the
  already-incremented `filled[h]`. Two legs `f1, f2` against one maker hash require
  `f1 <= rem` and `f2 <= rem - f1` — the pair cannot overfill. The taker side is bound by
  `_checkFillAmount(takerHash, ...)` (line ~117) once before the loop, plus the
  `totalMakerFill == takerFillAmount` post-loop invariant; the taker hash is written once
  after the loop (line ~164) and the taker cannot be duplicated (single `takerOrder`).
- **Fuzz encoding:** assert `getFilledAmount(h) <= order.amount` for every order hash
  after every call; fuzz `makerOrders` containing the same order twice as a regression
  guard.
- **Status:** HOLDS (including the duplicate-maker case).

### INV-FILL-2 — Filled amount is monotonically non-decreasing
`filled[h]` only ever increases (`+=`), never decreases or resets.

- **Enforced:** `SettlementFacet.sol` lines ~164 (taker), ~220 (maker), ~264
  (`fillOrder`) — all `+=`.
- **Status:** HOLDS.

### INV-FILL-3 — Taker fill equals the sum of maker fills
`matchOrders` reverts `FillAmountMismatch(totalMakerFill, takerFillAmount)` unless
`Σ makerFillAmounts[i] == takerFillAmount`.

- **Enforced:** `SettlementFacet.sol` line ~161. CPX-008 — this is a distinct, correctly
  named error; the old code misreported `MismatchedInputLengths` here.
- **Fuzz encoding:** assert `matchOrders` reverts `FillAmountMismatch` with the exact
  `(Σ makerFillAmounts, takerFillAmount)` args whenever the sum differs.
- **Status:** HOLDS.

### INV-FILL-4 — Every fill leg is non-zero
`takerFillAmount != 0` and each `makerFillAmounts[i] != 0` (and `fillAmount != 0` in
`fillOrder`).

- **Enforced:** `matchOrders` line ~104 (`takerFillAmount == 0` → `ZeroAmount`),
  `_settleAgainstMaker` line ~194 (`fillAmount == 0` → `ZeroAmount`), `fillOrder`
  line ~246 (`fillAmount == 0` → `ZeroAmount`).
- **Note (collateral-leg zero, distinct property):** a non-zero *token* `f` can still
  produce a zero *collateral* leg when `P * f < unit` truncates to 0. All four
  settlement paths now guard this with `collateralAmount == 0 → ZeroAmount`:
  `_executeOperatorFill` (`fillOrder`, the SEC-003 guard) and — since the BL-N2 fix —
  `_settleComplementary` / `_settleMint` / `_settleMerge` (`matchOrders`). See INV-MISC-1.
- **Status:** HOLDS for both the token amount and the per-party collateral leg.

### INV-MISC / INV-FILL-5 — Array-length consistency on `matchOrders`
`matchOrders` reverts `MismatchedInputLengths` unless `makerOrders.length` equals each of
`makerFillAmounts.length`, `makerSignatures.length`, `makerSignatureTypes.length`,
`takerFees.length`, `makerFees.length`.

- **Enforced:** `SettlementFacet.sol` lines ~95-103.
- **Status:** HOLDS.

### INV-NONCE-1 — Nonce is strictly monotonic per maker
`incrementNonce` does `++ss.makerToNonce[msg.sender]`; the value only ever increases by 1
per call and is unbounded (`uint256`).

- **Enforced:** `NonceManagerFacet.sol` line ~36.
- **Status:** HOLDS.

### INV-NONCE-2 — A stale-nonce / low-salt / cancelled / expired order never settles
`_validateOrder` reverts if `ss.cancelledOrders[h]`, or
`order.nonce < ss.makerToNonce[maker]`, or
`order.salt < ss.makerPositionToMinSalt[maker][positionId]`, or
`order.expiration != 0 && block.timestamp >= order.expiration`.

- **Enforced:** `SettlementFacet.sol` `_validateOrder` lines ~316-325. The same predicate
  is the bool-returning `LibOrderValidity.check` used by `NonceManagerFacet.isOrderValid`
  for the off-chain orderbook (CPX-003 — single source of truth).
- **Fuzz encoding:** drive `matchOrders` / `fillOrder` against a cancelled, stale-nonce,
  low-salt, or expired order and assert the settlement-side revert (`OrderCancelled` /
  `OrderNonceInvalid`).
- **Status:** HOLDS.

---

## E. Match-type-determination invariants

### INV-MATCH-1 — `_determineMatchType` is total and correct on well-formed orders
For `side ∈ {0,1}` (guaranteed by INV-MATCH-2):

| taker.positionId vs maker.positionId | sides | result |
|---|---|---|
| equal | opposite (`taker.side != maker.side`) | COMPLEMENTARY |
| binary complements (registry: 2 positions, same market) | both `0` (BUY) | MINT |
| binary complements | both `1` (SELL) | MERGE |
| any other combination | — | revert `InvalidMatch` |

- **Enforced:** `SettlementFacet.sol` `_determineMatchType` (lines ~368-384) +
  `_isBinaryComplement` (lines ~392-403).
- **Sub-properties:**
  - same position / same side ⇒ `taker.side == maker.side` so the complementary branch
    is skipped, and `_isBinaryComplement(p, p)` is false (a position is not its own
    complement) ⇒ `InvalidMatch`. HOLDS.
  - cross-market pair ⇒ `marketKeyByPositionId` differ ⇒ `_isBinaryComplement` false ⇒
    `InvalidMatch`. HOLDS.
  - non-binary market (`positionIds.length != 2`) ⇒ false ⇒ mint/merge rejected. HOLDS.
  - unregistered position ⇒ `marketKey == bytes32(0)` ⇒ false ⇒ `InvalidMatch`. HOLDS.
- **Status:** HOLDS.

### INV-MATCH-2 — `side` is constrained to {0,1}
`_validateOrder` reverts `InvalidMatch` for any order with `order.side > 1` — checked
for the taker and every maker on `matchOrders`, and for the single order on `fillOrder`,
before match-type routing.

- **Enforced:** `SettlementFacet.sol` `_validateOrder` line ~328 (`if (order.side > 1)`).
- **Resolved vs old doc:** the prior revision flagged this AT-RISK (a `side = 2` maker
  could reach the complementary path with undefined buy/sell semantics). BIZ-006 added
  the explicit guard; the invariant now HOLDS.
- **Fuzz encoding:** fuzz `side` over `0..255`; assert `matchOrders` / `fillOrder` revert
  `InvalidMatch` for any leg with `side > 1`.
- **Status:** HOLDS.

### INV-MATCH-3 — Mint/Merge/Complementary positions share a collateral token
`_settleComplementary`, `_settleMint`, and `_settleMerge` each revert `InvalidMatch` if
`taker.collateralToken != maker.collateralToken`.

- **Enforced:** `SettlementFacet.sol` lines ~456 (complementary), ~520 (mint), ~594
  (merge). Without this guard a compromised operator could pair a maker order signed in
  token A with a taker in token B and the leg would execute wholly in one token (SEC-001).
- **Status:** HOLDS.

### INV-MATCH-4 — Self-trade is rejected
`_settleAgainstMaker` reverts `SelfTrade` if `makerOrder.maker == takerOrder.maker` for
any maker leg.

- **Enforced:** `SettlementFacet.sol` `_settleAgainstMaker` line ~195.
- **Status:** HOLDS.

---

## F. Signature / hashing invariants

### INV-SIG-1 — EIP-712 struct hash matches the backend encoder byte-for-byte
`LibDoefinOrder.DOEFIN_ORDER_TYPEHASH` and the field-encoding order in
`hash` / `hashCalldata` are identical to `shared/scw/encoder.py`
(`DOEFIN_ORDER_TYPE_STRING` + `compute_struct_hash`): **10 fields**, identical order,
identical types:

```
uint256 salt, address maker, address signer, bytes32 positionId,
address collateralToken, uint8 side, uint128 amount, uint128 pricePerToken,
uint64 expiration, uint256 nonce
```

The domain typehash (`EIP712Domain(string name,string version,uint256 chainId,address
verifyingContract)`), the domain `name`/`version` (`"Doefin Exchange"` / `"3"`), and the
`\x19\x01 || domainSeparator || structHash` framing also match
(`LibDoefinOrder.hashOrderCalldata` ↔ `encoder.compute_order_hash`).

- **Differential result: PASS.** Both sides are the frozen 10-field v3 struct. The
  removed fields (`minFillAmount`, `orderType`, `quoteCurrency`, `exchangeRate`,
  `feeRateBps`) are absent from both the Solidity struct and the Python encoder; the
  backend model uses `ConfigDict(extra="forbid")` so a drifted-back field fails loudly at
  construction. The canonical typehash
  `0xff1c8998850575465e0fe5d8e2ad1901f5487c91977a245a2901fc65cd90a3b0` is pinned in both
  `test/unit/LibDoefinOrder` and (implicitly) `encoder.DOEFIN_ORDER_TYPEHASH`.
- **Fuzz encoding:** for a fuzzed order, compute the struct hash in Solidity and in the
  Python encoder and assert byte equality (cross-runtime differential test).
- **Status:** HOLDS.

### INV-SIG-2 — Signature is non-malleable and binds signer
`LibSignature.verifyOrderSignature` (the single dispatch wrapper, CPX-001) rejects
`s > secp256k1n/2` (returns `address(0)` from `_recover`), rejects
`recovered == address(0)` or `recovered != order.signer`, requires `signer == maker` for
type 0 (EOA), dispatches to a registered signer or `IERC1271.isValidSignature` for
type 1, and reverts `InvalidOrderSignature` for any `signatureType > 1`.

- **Enforced:** `LibSignature.sol` `verifyOrderSignature` (lines ~102-128). Both
  `SettlementFacet` and `SignatureVerifierFacet` call this single function — the
  per-facet `_verifySignature` copies are gone (CPX-001).
- **Status:** HOLDS (this is a security-domain property; listed for completeness).

### INV-DOMAIN-1 — Domain separator is consistent across facets and fork-safe
`SettlementFacet`, `SignatureVerifierFacet`, and `NonceManagerFacet` all compute the
domain separator via `LibDoefinOrder.diamondDomainSeparator(address(this))`, which
recomputes from `block.chainid` and the precomputed `DOMAIN_NAME_HASH` /
`DOMAIN_VERSION_HASH` constants on every call. No facet caches it.

- **Enforced:** `SettlementFacet._getDomainSeparator`, `SignatureVerifierFacet._getDomainSeparator`,
  `NonceManagerFacet._getDomainSeparator` — all delegate to the same library function.
- **Resolved vs old doc:** the prior revision flagged AT-RISK across a chain fork because
  `SettlementFacet` cached the separator with no `chainId` guard. SEC-004 removed the
  cache; all three facets now recompute, so a fork cannot make a cancellation
  (NonceManagerFacet) hash differently than a settlement (SettlementFacet).
- **Status:** HOLDS.

---

## G. Miscellaneous documented behaviors (not bugs)

### INV-MISC-1 — every settlement path rejects a zero-collateral leg
All four settlement paths reject a leg whose per-party collateral component truncates to
0 (`floorDiv(P*f, unit) == 0`): `_executeOperatorFill` (`fillOrder`, the SEC-003 guard)
and the three `matchOrders` settle paths `_settleComplementary` / `_settleMint` /
`_settleMerge` (the BL-N2 guard).

- **Guards:** `_settleComplementary` reverts `ZeroAmount` when `collateralAmount == 0`;
  `_settleMint` when `makerCollateral == 0 || takerCollateral == 0`; `_settleMerge` when
  `makerPayout == 0 || takerPayout == 0` (checked before the CTF burn,
  checks-before-effects). A degenerate leg — `price == 0` or a dust `f` with
  `P*f < unit` — would otherwise move `f` position tokens for no payment.
- **Status:** HOLDS (enforced). **BL-N2** (newly-derived business-logic finding, LOW) is
  **RESOLVED** by the symmetric-guard fix — `matchOrders` and `fillOrder` now fail closed
  identically. Pinned by `coverage.md` Gap-8 (complementary price-0, complementary
  sub-unit dust, mint zero-leg, merge zero-leg).

### INV-MISC-2 — Mint/Merge taker fee `cashValue` uses the effective leg, not signed price
`_validateFee` for the Mint/Merge taker is bounded against `takerCollateral` /
`takerPayout` — the *effective* per-party collateral leg `(f - floorDiv(P_m*f, unit))` —
not against `floorDiv(P_t*f, unit)`. This is the correct cash value for the leg (it is
what the party actually pays/receives). Documented and intentional.

- **Status:** HOLDS (by design).

### INV-MISC-3 — Operator is trusted for match correctness, not for solvency or bounds
The operator chooses which orders to pair, the `fillAmount`s, and the fee amounts. The
contract independently enforces: signature validity, order validity (cancel/nonce/salt/
expiry), collateral allow-list, `unit != 0`, `price <= unit`, `side <= 1`, no overfill,
match-type legality, no self-trade, no zero-collateral leg, fee max-rate, fee ≤ proceeds,
and Diamond solvency by construction. A **compromised operator** cannot make the Diamond
insolvent, cannot overfill an order, cannot settle an invalid/expired order, cannot
settle a zero-collateral leg, and cannot route fees to itself — it *can* choose
unfair-but-in-bounds pairings (price slack within `[0, unit]`) and can halt liveness.

- **Status:** HOLDS (trust-model statement; the residual operator-fairness item is
  BL-N1, INFO — BL-N2 is now RESOLVED by the symmetric zero-collateral guard).

---

## Invariant → finding cross-reference

| Invariant | Status | Finding |
|---|---|---|
| INV-SOLV-1 | HOLDS | — |
| INV-SOLV-2 | HOLDS | — (old BIZ-001 resolved by `fee <= proceeds`) |
| INV-SOLV-3 / 4 | HOLDS | — |
| INV-PRICE-1 / 2 / 3 / 4 | HOLDS | — |
| INV-PRICE-5 | HOLDS (solvency + signed bound) | BL-N1 (INFO — slack observability) |
| INV-FEE-1 / 2 / 3 / 4 / 5 | HOLDS | — |
| INV-FILL-1 / 2 / 3 / 4 / 5 | HOLDS | — |
| INV-NONCE-1 / 2 | HOLDS | — |
| INV-MATCH-1 / 2 / 3 / 4 | HOLDS | — (old INV-MATCH-2 AT-RISK resolved by BIZ-006) |
| INV-SIG-1 / 2 | HOLDS | — |
| INV-DOMAIN-1 | HOLDS | — (old fork hazard resolved by SEC-004) |
| INV-MISC-1 | HOLDS (enforced) | BL-N2 (LOW — RESOLVED by symmetric zero-collateral guard) |
| INV-MISC-2 / 3 | HOLDS (by design) | — |

**No invariant is currently AT-RISK.** Every CRITICAL/HIGH economic invariant
(INV-SOLV-1..4, INV-FEE-1/2, INV-FILL-1/3) holds and — see `coverage.md` — is **COVERED**
by on-chain tests; the SCRUM-234 gap-closing suites closed all eight ranked coverage
gaps. The two newly-derived business-logic findings (BL-N1, BL-N2) are INFO/LOW and
non-blocking — BL-N2 has since been RESOLVED.

> **Finding ID note.** `BL-N1` / `BL-N2` are *newly-derived* in this regenerated pass;
> they deliberately do **not** reuse the `BIZ-00x` IDs from
> `audit/findings/business-logic-findings.md`, which are pinned to the stale `015097c1`
> commit and mostly RESOLVED (BIZ-001 by `fee <= proceeds`; the old INV-MATCH-2 / `side`
> gap = old ledger BIZ-006 by the `_validateOrder` `side > 1` revert; the old
> domain-cache concern by SEC-004). The findings ledger is out of scope for this
> regeneration and is not modified here.

## Master fuzz properties (for `DoefinInvariantHarness.sol`)

```
echidna_diamond_collateral_solvent()   // INV-SOLV-4: balanceOf(diamond) >= unredeemedBacking
echidna_mint_conserves()               // INV-SOLV-1: collateral in == f, minted == f each side
echidna_merge_conserves()              // INV-SOLV-2: takerNet + makerNet + totalFees == f, diamond net-zero
echidna_complementary_no_diamond_touch // INV-SOLV-3: diamond ERC-20 + ERC-1155 unchanged
echidna_no_overfill()                  // INV-FILL-1: getFilledAmount(h) <= amount  (fuzz duplicate maker legs)
echidna_fill_sum_matches()             // INV-FILL-3: Σ makerFills != takerFill => FillAmountMismatch
echidna_fee_within_max_rate()          // INV-FEE-1: fee <= floorDiv(cashValue*maxFeeRateBps,1e4)
echidna_fee_within_proceeds()          // INV-FEE-2: fee > proceeds => FeeExceedsProceeds (complementary/merge/fill)
echidna_fee_sink_is_feeReceiver()      // INV-FEE-3: operator balance excludes fee; feeReceiver delta == Σ fees
echidna_taker_not_overcharged_mint()   // INV-PRICE-1: takerPaid == f - floor(P_m*f/unit) <= floor(P_t*f/unit)+1
echidna_taker_floor_merge()            // INV-PRICE-2: takerReceived >= floor(P_t*f/unit)
echidna_price_le_unit()                // INV-PRICE-4: pricePerToken > unit => InvalidPrice
echidna_side_domain()                  // INV-MATCH-2: side > 1 => InvalidMatch
echidna_nonce_monotonic()              // INV-NONCE-1
echidna_invalid_order_never_settles()  // INV-NONCE-2: cancelled/stale/expired => revert
echidna_eip712_parity()                // INV-SIG-1: Solidity struct hash == Python encoder struct hash
```

## Newly-derived business-logic findings (this regeneration)

Not written to `audit/findings/business-logic-findings.md` (that ledger is out of scope
for this pass). Summarised here for the domain reviewer / go-no-go gate.

### BL-N1 — Off-`unit` price-sum slack is solvency-safe but not observable (INFO)
- **Where:** `_settleMint` crossing check `P_t + P_m < unit` (line ~523) and `_settleMerge`
  crossing check `P_t + P_m > unit` (line ~600).
- **What:** the crossing checks accept any sum `>= unit` (mint) / `<= unit` (merge), not
  only `== unit`. When the sum is strictly off `unit` the remainder construction keeps
  the Diamond solvent (INV-SOLV-1/2) and the maker is always honoured at their signed
  price, but the taker's effective price `(unit - P_m)` can be better than their signed
  `P_t` — i.e. the operator distributes slack. INV-PRICE-1/2 still hold (the taker's
  signed bound is never violated).
- **Impact:** no solvency or signed-bound violation; an operator-fairness / observability
  item only. A compromised operator could systematically settle at the in-bounds-but-
  unfair edge.
- **Recommendation:** INFO — add NatSpec on both crossing checks stating the slack is an
  intentional consequence of the SCRUM-121 effective-price model, and consider emitting
  the effective price (or `P_t`/`P_m` sum) in `OrdersMatched` for off-chain monitoring.
  No code-behaviour change required.

### BL-N2 — `matchOrders` settle paths had no dust collateral-zero guard (LOW — RESOLVED)
- **Where:** `_settleComplementary` / `_settleMint` / `_settleMerge` — none rejected a leg
  whose per-party collateral truncated to 0 (`floorDiv(P*f, unit) == 0`). Only
  `_executeOperatorFill` (`fillOrder`) had the explicit `collateralAmount == 0 →
  ZeroAmount` guard.
- **What:** a complementary leg with `P_maker == 0` or a dust `f` such that
  `P_maker * f < unit` transferred `f` position tokens for zero collateral. On Mint/Merge a
  zero on one party's leg simply shifted that party's `f`-share to the counterparty (still
  solvent). The asymmetry with `fillOrder` was the notable part.
- **Impact:** LOW — no contract insolvency; the operator is trusted to match
  non-degenerate pairs. It was a defence-in-depth / consistency gap, not an exploit.
- **Resolution (RESOLVED):** the symmetric guard was added to all three `matchOrders`
  settle paths — `_settleComplementary` reverts `ZeroAmount` on `collateralAmount == 0`;
  `_settleMint` on `makerCollateral == 0 || takerCollateral == 0`; `_settleMerge` on
  `makerPayout == 0 || takerPayout == 0` (hoisted above the CTF burn,
  checks-before-effects). `matchOrders` and `fillOrder` now fail closed identically.
  Pinned by `coverage.md` Gap-8 — complementary price-0, complementary sub-unit dust,
  mint zero-leg, and merge zero-leg tests, all asserting a `ZeroAmount` revert.
