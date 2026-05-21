# Proposal: Budget Model + 1:Many Matching

## Problem Statement

Three related issues in the current matching and settlement design:

1. **Race condition on market orders.** The matcher enforces `aggregate_price_bound` (the
   simulate-predicted VWAP) as the fill ceiling. When another order fills the cheap tier
   first, the remaining taker order is stuck — not because the fills are outside the user's
   signed commitment, but because the stale simulate prediction is too strict. A fill at
   effective price 600,000 is rejected even though the user signed `price_per_token = 606,000`.

2. **1:1 matching.** The matching service always emits one taker vs. one maker, even when
   multiple makers are available. The taker fills 400k tokens in one on-chain tx, then needs
   a second tx for the remaining 1,300k. The fills are not atomic; the second tx can fail if
   the second maker cancels between transactions.

3. **Settlement prices are wrong for Mint and Merge.** In `_settleMint`, the taker always
   pays `taker.pricePerToken × fill / unit` regardless of how generous the maker is. A BUY NO
   order at 450,000 gives the taker no price improvement; the surplus `(P_t + P_m − unit)` is
   absorbed. The mirror problem exists in `_settleMerge`. Only `_settleComplementary` correctly
   fills at maker's price (already implemented — no change needed there).

---

## Core Concept: Effective Price

Every match type can be expressed through a single abstraction:

| Taker side | Match type | Maker order | Effective price |
|-----------|-----------|-------------|-----------------|
| BUY YES | Complementary | SELL YES @ P_m | P_m |
| BUY YES | Mint | BUY NO @ P_m | unit − P_m |
| SELL YES | Complementary | BUY YES @ P_m | P_m |
| SELL YES | Merge | SELL NO @ P_m | unit − P_m |

Crossing condition is always the same rule:
- **BUY**: `effective_price ≤ price_per_token`
- **SELL**: `effective_return ≥ price_per_token`

`price_per_token` is the user's signed commitment: the maximum average price (BUY) or minimum
average return (SELL). It is the only enforcement bound the matcher needs. `aggregate_price_bound`
is redundant and will be removed.

**This applies equally to market orders and limit orders.** The matcher does not distinguish
between them. `price_per_token` is derived from simulate for market orders and set directly by
the user for limit orders, but the matching algorithm is identical in both cases. 1:many
grouping works for limit orders too.

---

## Algorithm: 1:Many Walk

```
Input:  taker order (price_per_token = P_t, amount = Q, side = BUY or SELL)
Output: one or more MatchCandidates, each with multiple makers. The match type is
        tracked per maker; one matchOrders call can settle makers of mixed match types.

1. Gather all crossing makers across relevant match types:

   BUY taker:
     Complementary candidates: SELL YES orders where P_m ≤ P_t
                               effective_price = P_m
     Mint candidates:          BUY NO orders where P_m ≥ unit − P_t
                               effective_price = unit − P_m

   SELL taker:
     Complementary candidates: BUY YES orders where P_m ≥ P_t
                               effective_return = P_m
     Merge candidates:         SELL NO orders where P_m ≤ unit − P_t
                               effective_return = unit − P_m

2. Sort all candidates together by effective_price ascending (BUY)
   or effective_return descending (SELL). Break ties by created_at ascending.

3. Walk the sorted list:
   - fill_i = min(taker_remaining, maker_i_remaining, respecting min_fill_amount)
   - Accumulate makers (the match type is tracked per maker; a single
     matchOrders call can carry makers of mixed match types — the
     Diamond routes each leg by its own match type)
   - taker_remaining -= fill_i
   - Stop when taker_remaining == 0 or list exhausted

4. Emit MatchCandidates covering the makers that received fills. Makers of
   different match types may be settled together in one matchOrders call.

VWAP invariant: since every effective_price ≤ P_t (BUY) or ≥ P_t (SELL),
any weighted average also satisfies the bound. No separate VWAP check needed.
```

---

## Worked Examples

All examples use `unit = 1,000,000`. Prices are integers in [0, 1,000,000].
All collateral amounts are in the same raw unit (e.g. mUSDT with 6 decimals).

---

### Example 1 — BUY, pure Mint 1:many (price improvement)

**Taker:** BUY YES at `P_t = 606,000`, amount = 1,700,000 tokens

| Maker | Type | P_m | Effective price | Available |
|-------|------|-----|-----------------|-----------|
| A | Mint (BUY NO) | 450,000 | 550,000 | 400,000 |
| B | Mint (BUY NO) | 400,000 | 600,000 | 2,000,000 |

Both cross: 550k ≤ 606k and 600k ≤ 606k ✓

**Walk (effective_price ascending):**

| Step | Maker | Fill | Taker pays | Maker pays |
|------|-------|------|------------|------------|
| 1 | A @ 450k | 400,000 | (1M−450k)×400k/1M = **220,000** | 450k×400k/1M = 180,000 |
| 2 | B @ 400k | 1,300,000 | (1M−400k)×1.3M/1M = **780,000** | 400k×1.3M/1M = 520,000 |

Total: 1,700,000 YES tokens received.
Taker pays: 220,000 + 780,000 = **1,000,000** collateral.
Average: 1,000,000 / 1,700,000 × 1,000,000 = **588,235 per token** ≤ 606,000 ✓

*Old model (taker always pays P_t):* taker would pay 606,000 × 1,700,000 / 1,000,000 = **1,030,200** — 30,200 extra absorbed by the contract.

**Output:** one Mint MatchCandidate, two makers, one on-chain transaction.

---

### Example 2 — BUY, mixed Complementary + Mint

**Taker:** BUY YES at `P_t = 600,000`, amount = 2,000,000 tokens

| Maker | Type | P_m | Effective price | Available |
|-------|------|-----|-----------------|-----------|
| A | Comp (SELL YES) | 520,000 | 520,000 | 500,000 |
| B | Mint (BUY NO) | 470,000 | 530,000 | 800,000 |
| C | Comp (SELL YES) | 560,000 | 560,000 | 700,000 |
| D | Mint (BUY NO) | 420,000 | 580,000 | 1,000,000 |
| E | Comp (SELL YES) | 610,000 | 610,000 | 500,000 — **no cross** (> 600k) |

**Walk (effective_price ascending):**

| Step | Maker | Fill | Taker pays | Taker remaining |
|------|-------|------|------------|-----------------|
| 1 | A (Comp, 520k) | 500,000 | 520k×500k/1M = **260,000** | 1,500,000 |
| 2 | B (Mint, eff 530k) | 800,000 | 530k×800k/1M = **424,000** | 700,000 |
| 3 | C (Comp, 560k) | 700,000 | 560k×700k/1M = **392,000** | 0 |

D never reached — taker fully filled after step 3.

Total: 2,000,000 YES tokens.
Total pays: 260,000 + 424,000 + 392,000 = **1,076,000**.
Average: 1,076,000 / 2,000,000 × 1,000,000 = **538,000 per token** ≤ 600,000 ✓

**Output:** the makers from the same sorted walk, with the match type tracked per maker:
- Complementary makers: A (500k), C (700k) — taker_fill = 1,200,000
- Mint maker: B (800k) — taker_fill = 800,000

All five makers can be passed to a single `matchOrders` call (the Diamond routes each leg
by its own match type), so the whole 2,000,000-token fill settles in one atomic
transaction. The settlement loop processes them in effective-price order — Mint maker B
(effective 530k) before the more expensive Complementary makers.

---

### Example 3 — Race condition fix (0x7dd5 scenario)

This is the live bug from 2026-04-30.

**Initial book:**
- BUY NO @ 450,000 → effective YES = 550,000 — 400,000 tokens
- BUY NO @ 400,000 → effective YES = 600,000 — 2,000,000 tokens

**Both 0xb154 and 0x7dd5** submitted from the same simulate run.
Simulate VWAP = (550k×400k + 600k×1,300k) / 1,700k = **588,235**.
Both orders: `price_per_token = 606,000`, `aggregate_price_bound = 588,235`.

Order 0xb154 fills first (1,700,000 tokens across both tiers). Now only 700,000 tokens remain of BUY NO @ 400k.

**Old matcher (aggregate_price_bound enforcement):**

0x7dd5 attempts to fill BUY NO @ 400k → effective = 600,000.
VWAP check: 600,000 > `aggregate_price_bound` 588,235 → **REJECT**.
0x7dd5 is permanently stuck. Its signed commitment of 606,000 is never honoured.

**New matcher (price_per_token enforcement):**

0x7dd5 attempts to fill BUY NO @ 400k → effective = 600,000.
Check: 600,000 ≤ `price_per_token` 606,000 → **PROCEED**.
Fill = min(1,700,000, 700,000) = 700,000 tokens.
Taker pays 600,000 × 700,000 / 1,000,000 = 420,000 collateral.
Order partially filled (700k / 1,700k). Stays open awaiting new NO supply.

---

### Example 4 — SELL, pure Merge 1:many

**Taker:** SELL YES at `P_t = 350,000` (floor), amount = 2,000,000 tokens

| Maker | Type | P_m | Effective return | Available |
|-------|------|-----|------------------|-----------|
| A | Merge (SELL NO) | 200,000 | 800,000 | 500,000 |
| B | Merge (SELL NO) | 280,000 | 720,000 | 700,000 |
| C | Merge (SELL NO) | 620,000 | 380,000 | 1,500,000 |

All cross (P_t + P_m ≤ unit): 350k+200k=550k ✓, 350k+280k=630k ✓, 350k+620k=970k ✓

**Walk (effective_return descending):**

| Step | Maker | Fill | Taker receives | Maker receives |
|------|-------|------|----------------|----------------|
| 1 | A (eff 800k) | 500,000 | 800k×500k/1M = **400,000** | 200k×500k/1M = 100,000 |
| 2 | B (eff 720k) | 700,000 | 720k×700k/1M = **504,000** | 280k×700k/1M = 196,000 |
| 3 | C (eff 380k) | 800,000 | 380k×800k/1M = **304,000** | 620k×800k/1M = 496,000 |

Total: 2,000,000 YES tokens sold.
Total taker receives: 400,000 + 504,000 + 304,000 = **1,208,000** collateral.
Average: 1,208,000 / 2,000,000 × 1,000,000 = **604,000 per token** ≫ floor 350,000 ✓

*Note:* maker A and B get generous returns (less than their NO tokens are worth) while maker C barely clears the floor. All three committed voluntarily — taker captures the spread from the generous makers.

**Output:** one Merge MatchCandidate, three makers, one on-chain transaction.

---

### Example 5 — SELL, mixed Complementary + Merge

**Taker:** SELL YES at `P_t = 400,000` (floor), amount = 2,000,000 tokens

| Maker | Type | P_m | Effective return | Available |
|-------|------|-----|------------------|-----------|
| A | Merge (SELL NO) | 150,000 | 850,000 | 400,000 |
| B | Comp (BUY YES) | 750,000 | 750,000 | 300,000 |
| C | Merge (SELL NO) | 250,000 | 750,000 | 600,000 |
| D | Comp (BUY YES) | 500,000 | 500,000 | 500,000 |
| E | Merge (SELL NO) | 550,000 | 450,000 | 600,000 |
| F | Comp (BUY YES) | 380,000 | 380,000 | 500,000 — **no cross** (< 400k floor) |

B and C tie at 750,000 — broken by timestamp (B older, goes first).

**Walk (effective_return descending):**

| Step | Maker | Fill | Taker receives | Remaining |
|------|-------|------|----------------|-----------|
| 1 | A (Merge, eff 850k) | 400,000 | 850k×400k/1M = **340,000** | 1,600,000 |
| 2 | B (Comp, eff 750k) | 300,000 | 750k×300k/1M = **225,000** | 1,300,000 |
| 3 | C (Merge, eff 750k) | 600,000 | 750k×600k/1M = **450,000** | 700,000 |
| 4 | D (Comp, eff 500k) | 500,000 | 500k×500k/1M = **250,000** | 200,000 |
| 5 | E (Merge, eff 450k) | 200,000 | 450k×200k/1M = **90,000** | 0 |

F never reached — taker fully filled.

Total: 2,000,000 YES tokens sold.
Total receives: 340k + 225k + 450k + 250k + 90k = **1,355,000** collateral.
Average: 1,355,000 / 2,000,000 × 1,000,000 = **677,500 per token** ≫ floor 400,000 ✓

**Output:** the makers from the sorted walk, with the match type tracked per maker:
- Merge makers: A (400k), C (600k), E (200k) — taker_fill = 1,200,000
- Complementary makers: B (300k), D (500k) — taker_fill = 800,000

All five makers can be passed to a single `matchOrders` call (mixed match types are
supported — the Diamond routes each leg by its own type), so the full 2,000,000-token
fill settles in one atomic transaction.

---

### Example 6 — Limit order 1:many (no difference from market order)

**Taker:** BUY YES *limit* at `P_t = 580,000` (user-specified), amount = 1,500,000 tokens

| Maker | Type | P_m | Effective price | Available |
|-------|------|-----|-----------------|-----------|
| A | Comp (SELL YES) | 540,000 | 540,000 | 600,000 |
| B | Mint (BUY NO) | 430,000 | 570,000 | 900,000 |
| C | Comp (SELL YES) | 590,000 | 590,000 | 800,000 — **no cross** (> 580k) |

**Walk:**

| Step | Maker | Fill | Taker pays |
|------|-------|------|------------|
| 1 | A (Comp, 540k) | 600,000 | 540k×600k/1M = **324,000** |
| 2 | B (Mint, eff 570k) | 900,000 | 570k×900k/1M = **513,000** |

Total: 1,500,000 tokens, pays **837,000**.
Average: 837,000 / 1,500,000 × 1,000,000 = **558,000 per token** ≤ 580,000 ✓

The matcher applies the same algorithm regardless of whether `price_per_token` came from simulate or was typed directly by the user.

---

### Example 7 — Partial fill (insufficient crossing supply)

**Taker:** BUY YES at `P_t = 600,000`, amount = 3,000,000 tokens

| Maker | Type | P_m | Effective price | Available |
|-------|------|-----|-----------------|-----------|
| A | Comp (SELL YES) | 570,000 | 570,000 | 800,000 |
| B | Mint (BUY NO) | 410,000 | 590,000 | 1,000,000 |
| C | Mint (BUY NO) | 390,000 | 610,000 | 2,000,000 — **no cross** (> 600k) |
| D | Comp (SELL YES) | 620,000 | 620,000 | 500,000 — **no cross** (> 600k) |

Crossing supply: 800,000 + 1,000,000 = **1,800,000** tokens — below the requested 3,000,000.

**Walk:**

| Step | Maker | Fill | Taker pays |
|------|-------|------|------------|
| 1 | A (Comp, 570k) | 800,000 | **456,000** |
| 2 | B (Mint, eff 590k) | 1,000,000 | **590,000** |
| — | No more crossing makers | — | — |

Taker receives 1,800,000 tokens (of 3,000,000 requested), pays 1,046,000.
Order **partially filled** — remaining = 1,200,000, status = PartiallyFilled.
Order stays open. When new makers arrive at effective_price ≤ 600,000 they will fill against the remaining 1,200,000.

---

## SC Agent Tasks

**File:** `contracts/facets/SettlementFacet.sol`
**Prerequisite:** SC-006 (remove `registerPositionPairs` from `_splitPositionInternal`) should
land first or alongside, as both touch `_settleMint`.

### SC-Task A: Update `_settleMint` — fill at effective price

**Location:** `_settleMint` (~line 467)

Change the collateral split from taker-price-based to maker-price-based:

**Current:**
```solidity
uint256 takerCollateral = (uint256(taker.pricePerToken) * uint256(fillAmount)) / unit;
uint256 makerCollateral = uint256(fillAmount) - takerCollateral;

uint256 makerExpected = (uint256(maker.pricePerToken) * uint256(fillAmount)) / unit;
if (makerCollateral > makerExpected + 1) revert Errors.InvalidMatch();
```

**New:**
```solidity
// Validate crossing: taker's ceiling ≥ effective price (unit − maker.price)
if (uint256(taker.pricePerToken) + uint256(maker.pricePerToken) < unit) {
    revert Errors.InvalidMatch();
}

// Taker pays the effective price: complement of maker's BUY NO price
// Maker pays exactly their committed price
uint256 makerCollateral = (uint256(maker.pricePerToken) * uint256(fillAmount)) / unit;
uint256 takerCollateral = uint256(fillAmount) - makerCollateral;
```

No other changes in `_settleMint`. The split call and token distribution below are unaffected.
The old safety check is replaced by the explicit crossing guard above.

Add a brief comment after the arithmetic:
```solidity
// 1-wei rounding surplus (from integer division) flows to taker by construction.
// Do not add a makerExpected + 1 tolerance — this is intentional.
```

**Fee note:** The taker's fee is computed on `taker.pricePerToken` (their signed price), not
on the effective fill price `(unit − maker.pricePerToken)`. This is intentional — the fee
commitment is part of the signed order and does not change based on price improvement received.

### SC-Task B: Update `_settleMerge` — fill at effective price

**Location:** `_settleMerge` (~line 536)

Change the payout split from taker-price-based to maker-price-based:

**Current:**
```solidity
uint256 takerPayout = (uint256(taker.pricePerToken) * uint256(fillAmount)) / unit;
uint256 makerPayout = uint256(fillAmount) - takerPayout;

uint256 makerExpected = (uint256(maker.pricePerToken) * uint256(fillAmount)) / unit;
if (makerPayout > makerExpected + 1) revert Errors.InvalidMatch();
```

**New:**
```solidity
// Validate crossing: taker's floor ≤ effective return (unit − maker.price)
if (uint256(taker.pricePerToken) + uint256(maker.pricePerToken) > unit) {
    revert Errors.InvalidMatch();
}

// Maker receives exactly their committed price
// Taker receives the remainder: complement of maker's SELL NO price
uint256 makerPayout = (uint256(maker.pricePerToken) * uint256(fillAmount)) / unit;
uint256 takerPayout = uint256(fillAmount) - makerPayout;
```

Add the same rounding comment after the arithmetic (same reasoning as SC-Task A).

### SC-Task C: Confirm `_settleComplementary` (no change needed)

`_settleComplementary` already fills at `maker.pricePerToken` (line 442):
```solidity
uint256 collateralAmount = (uint256(maker.pricePerToken) * uint256(fillAmount)) / unit;
```
This is already correct. Verify it remains unchanged and the crossing guard
(`if (buyerPrice < sellerPrice) revert`) stays in place.

### SC-Task D: Tests

After SC-Task A and B, verify the following scenarios:

**Mint — price improvement to taker:**
- Taker BUY YES at P_t = 606,000, Maker BUY NO at P_m = 450,000, fill = 1,000,000
- Expected: taker pays 450,000 collateral (= P_m × fill / unit), NOT 606,000
- Maker pays 450,000 (their committed price), taker pays 550,000... wait

  Actually: `makerCollateral = 450,000 × 1,000,000 / 1,000,000 = 450,000`
  `takerCollateral = 1,000,000 − 450,000 = 550,000`
  Taker pays 550,000 (effective = unit − P_m = 550,000) ✓

- Old behavior (for comparison): taker would pay 606,000 collateral

**Mint — at-limit fill (no improvement):**
- Taker BUY YES at P_t = 600,000, Maker BUY NO at P_m = 400,000, fill = 1,000,000
- Effective = 600,000 = P_t (exactly at limit)
- takerCollateral = 600,000, makerCollateral = 400,000 ✓

**Mint — invalid crossing:**
- Taker P_t = 500,000, Maker P_m = 400,000 → 500,000 + 400,000 = 900,000 < unit
- Must revert with InvalidMatch() ✓

**Merge — price improvement to taker:**
- Taker SELL YES at P_t = 400,000, Maker SELL NO at P_m = 300,000, fill = 1,000,000
- makerPayout = 300,000, takerPayout = 700,000 (effective = 700,000 ≥ P_t = 400,000) ✓

**Merge — invalid crossing:**
- Taker P_t = 700,000, Maker P_m = 400,000 → 700,000 + 400,000 = 1,100,000 > unit
- Must revert with InvalidMatch() ✓

---

## SC Agent Tasks (continued)

### SC-Task E: Remove `minFillAmount` enforcement from `_checkFillAmount`

**Location:** `contracts/facets/SettlementFacet.sol` — `_checkFillAmount` (~line 335) and its 3 call sites

**Step 1 — Remove the enforcement lines:**
```solidity
// Delete these lines only:
if (minFillAmount > 0 && fillAmount < minFillAmount && uint256(fillAmount) != remaining) {
    revert Errors.FillBelowMinimum(orderHash, fillAmount, minFillAmount);
}
```
The overflow/remaining check above them is unchanged.

**Step 2 — Drop `minFillAmount` from the function signature:**

Remove the `uint128 minFillAmount` parameter from `_checkFillAmount` and update all 3 call
sites to match:
- Line 108: `matchOrders` taker check
- Line 119: `matchOrders` maker loop check
- Line 163: `fillOrder` check — not referenced in the original proposal but calls the same
  function; the enforcement disappears here automatically once the parameter is removed

**Step 3 — `Errors.FillBelowMinimum` becomes dead code.** Safe to delete from `Errors.sol`.

**Why:** `minFillAmount` was a guard against dust fills but creates a deadlock in 1:many walks
where the last partial fill is legitimately below the minimum. Complex order types (FOK, IOC,
etc.) that subsume this behavior will be designed separately. For now the field is kept in the
order struct and EIP-712 hash (removing it would invalidate all existing signed orders) but
is silently ignored on-chain.

---

## Backend Tasks

**Files:** `match-engine/app/services/matching_service.py`,
`api-service/app/services/v3/clob_service.py`

### BE-Task 0: Remove `min_fill_amount` enforcement from matcher and `compute_fill_amount`

**Location:** `shared/settlement/match_types.py:134-137`, `matching_service.py` call sites

Remove the minimum-fill checks from `compute_fill_amount`. Keep the `min_fill_amount` field
on `DoefinOrder`, `OrderIntent` DB model, and API schema — the EIP-712 struct must not change.
Frontend continues sending `"0"` (already the default).

**Current (`match_types.py`):**
```python
if taker_min_fill > 0 and fill < taker_min_fill:
    return None
if maker_min_fill > 0 and fill < maker_min_fill:
    return None
```

**New:** delete those four lines and the `taker_min_fill` / `maker_min_fill` parameters from
the function signature. Update all three call sites in `matching_service.py` accordingly
(lines ~366, ~521, ~654).

Also remove the matching-service local variables that compute `buy_min` / `sell_min`
(lines ~782-783) and pass them to `compute_fill_amount`.

### BE-Task 1: Replace `aggregate_price_bound` enforcement with `price_per_token`

**Location:** `matching_service.py` — `_would_breach_bound` (or its call sites)

The current check computes a running VWAP and compares to `order.aggregate_price_bound`.
Replace the bound with `order.price_per_token`. This is a one-line change at the call site.

Effect: orders like 0x7dd5 (signed at 606,000) will now match against the 400k NO tier at
effective 600,000 instead of being permanently stuck.

### BE-Task 2: Implement 1:many grouping in all three match finders

**Location:** `matching_service.py` — `_find_complementary_matches`, `_find_mint_matches`,
`_find_merge_matches`

Currently each inner-loop iteration emits a separate `MatchCandidate` (1:1). Refactor each
finder to accumulate all qualifying makers for a single taker into one `MatchCandidate`:

```python
# Collect across inner loop instead of emitting per-pair:
maker_orders = []
maker_fills = []
maker_fees = []
...
for maker in sorted_makers:
    fill = compute_fill_amount(rem_taker, rem_maker, ...)
    if fill is None: continue
    if _would_breach_price(taker, fill, effective_price): break/continue
    
    maker_orders.append(_intent_to_doefin_order(maker))
    maker_fills.append(fill)
    maker_fees.append(fee)
    rem_taker -= fill
    if rem_taker <= 0: break

if maker_orders:
    candidates.append(MatchCandidate(
        maker_orders=tuple(maker_orders),
        maker_fill_amounts=tuple(maker_fills),
        taker_fill_amount=sum(maker_fills),
        ...
    ))
```

### BE-Task 3: Cross-type sorting (mixed Complementary + Mint for BUY, Comp + Merge for SELL)

**Location:** `matching_service.py` — `find_matches_for_position` (and `find_matches`)

After gathering complementary and mint/merge candidates separately, emit them in effective_price
order. The Diamond determines the match type per maker, so a single `matchOrders` call can
settle makers of mixed match types; candidates may stay separate for clarity but they are
produced in the correct price-priority order so the settlement loop processes cheap fills first.

For the initial implementation, simple inter-list sorting is sufficient:
```python
# After gathering both lists:
all_candidates = comp_candidates + mint_candidates
all_candidates.sort(key=lambda c: c.best_effective_price)  # new property on MatchCandidate
```

### BE-Task 4: Update `simulate_market_order` in `clob_service.py`

**Location:** `api-service/app/services/v3/clob_service.py`

`aggregate_price_bound` is no longer used by the matcher. It can be set to `None` /
removed from the simulate response. `signed_price_per_token` (the worst fill price × slippage)
remains unchanged — it is still needed as the on-chain ceiling.

The simulate walk itself does not need to change. The budget walk already correctly computes
`signed_price_per_token` based on the worst effective fill price.

### BE-Task 5: Schema and dead-code cleanup (follow-on, not blocking)

Once SC and BE changes are deployed and verified, remove in one pass:

**`aggregate_price_bound`:**
- `OrderIntent` DB model column + migration
- Order creation API request schema
- Frontend API spec (`docs/frontend-developer-guide-v3.md`)

**VWAP fill-collateral tracking** (was used only for `aggregate_price_bound` enforcement):
- `MatchCandidate.taker_fill_collateral` and `maker_fill_collaterals` fields
  (`shared/settlement/models.py:66-67`)
- The write in `settlement_service.py:382-391` that sets `fill_collateral` on `OrderFill`
- `OrderFill.fill_collateral` DB column + migration
- Tests `test_scrum93_mint_merge_vwap.py` and assertions in `test_scrum88_aggregate_bound.py`
  that assert specific collateral values (the broader bound-enforcement tests in that file
  will also need updating)

---

## Does This Change Anything for Limit Orders?

**No structural change.** The algorithm treats limit orders and market orders identically:

- `price_per_token` is the ceiling (BUY) or floor (SELL) in both cases
- 1:many grouping applies to both — a large limit buy for 5M tokens fills against multiple
  makers in one atomic transaction
- `aggregate_price_bound` is already `null` for limit orders; its removal is a no-op
- Price improvement flows to limit order takers too (they pay maker's effective price, not
  their own `price_per_token`)

The only conceptual difference is that limit orders have user-specified prices and amounts,
while market orders get these from simulate. The matcher does not need to know which is which.

---

## Deployment Order

1. **SC-006** (partition order fix) — **already done** (commit `ee332b5` on `feature/SCRUM-120-Remove-position-registry-from-internal-split`)
2. **SC-Task A + B + E** (settlement price changes + min_fill removal) — one PR; SC-006 is already present on the branch so it ships together
3. **BE-Task 0** (min_fill enforcement removal) — prerequisite for correct 1:many walk; safe to land immediately alongside SC-Task E
4. **BE-Task 1** (bound swap) — safe to deploy independently; fixes the race condition immediately
5. **BE-Task 2** (1:many grouping) — depends on BE-Tasks 0 and 1 being stable
6. **BE-Task 3** (cross-type sorting) — additive improvement on top of BE-Task 2
7. **BE-Task 4** (simulate cleanup) — safe once BE-Tasks 1–2 are deployed
8. **BE-Task 5** (schema + dead-code cleanup) — last, after full verification

BE-Task 1 is the highest-priority fix (unblocks 0x7dd5 and any future market order in the
same situation). SC-Tasks A+B+E and BE-Task 0 are independent and can be worked in parallel.

---

## Summary of Changes

| Task | Component | Change | Reason |
|------|-----------|--------|--------|
| SC-006 | `LibCTFCondition._splitPositionInternal` | Remove `registerPositionPairs` call — **already done** (ee332b5 on `feature/SCRUM-120-Remove-position-registry-from-internal-split`) | Fix `InvalidMatch()` on partition order |
| SC-Task A | `SettlementFacet._settleMint` | Fill at `unit − maker.price`, not `taker.price` | Price improvement to taker |
| SC-Task B | `SettlementFacet._settleMerge` | Payout at `unit − maker.price`, not `taker.price` | Price improvement to taker |
| SC-Task C | `SettlementFacet._settleComplementary` | No change — already uses maker's price | Already correct |
| SC-Task E | `SettlementFacet._checkFillAmount` | Remove min-fill guard | Enables clean 1:many walk; order types redesigned later |
| BE-Task 0 | `match_types.compute_fill_amount` + matcher call sites | Remove `min_fill_amount` enforcement | Matches SC-Task E; field kept in struct |
| BE-Task 1 | Matcher bound check | `price_per_token` instead of `aggregate_price_bound` | Fix race condition (0x7dd5 class) |
| BE-Task 2 | Matcher grouping | 1:many per taker per match type | Atomic fills, fewer on-chain transactions |
| BE-Task 3 | Matcher ordering | Cross-type sort by effective price | Optimal execution order |
| BE-Task 4 | Simulate response | Remove `aggregate_price_bound` from output | Field is redundant |
| BE-Task 5 | Schema + dead code | Remove `aggregate_price_bound`, VWAP collateral fields, `fill_collateral` DB column | Cleanup |
