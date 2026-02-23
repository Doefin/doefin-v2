# Multi-Currency Orderbook Refactor – Knowledge Base

## 1. Goal & Motivation

The primary goal of this refactor is to **eliminate stale pricing issues** and **enable flexible cross-currency trading** by introducing **multiple isolated orderbooks per currency**.

### Key Problems in the Previous Design
- Single orderbook per position mixed:
  - standard orders
  - cross-currency orders
- Increased risk of stale prices
- Inefficient traversal and matching
- Limited extensibility for multi-currency trading

### Core Idea
> Split orderbooks not only by position and direction, but also by **pricing currency**, allowing better isolation, safer matching, and cleaner logic.

---

## 2. Orderbook Architecture

### Old Model
```solidity
buyOrdersByPosition[positionId]
sellOrdersByPosition[positionId]
````

### New Model

```solidity
buyOrdersByPositionAndCurrency[bookId]
sellOrdersByPositionAndCurrency[bookId]
```

Where:

```solidity
bookId = keccak256(
  abi.encodePacked(positionId, pricingCurrency)
)
```

### Benefits

* Prevents stale price interaction between currencies
* Enables efficient filtering and traversal
* Allows users to trade and list in **any currency**
* Keeps standard and cross-currency liquidity isolated

---

## 3. Order Types (Finalized – No Further Expansion)

### 3.1 Standard Orders

* Priced and settled in **collateral token**
* Stored in collateral-based books
* Can only match against **Standard orders**

### 3.2 Fixed Orders

* Minted using a collateral token (e.g. BTC)
* Listed and priced in a **quote currency** (e.g. USDT)
* Considered **cross-currency orders**

### 3.3 Dynamic Orders

* Similar to Fixed orders, but:

  * Listed in **collateral token**
  * Price derived from **oracle exchange rate**
  * Includes a **floor rate** (worst acceptable exchange rate)
* Floor rate meaning:

  * BUY → minimum acceptable exchange rate
  * SELL → maximum acceptable exchange rate

---

## 4. Pricing Currency Logic

Pricing currency is determined as follows:

| Order Type | Pricing Currency                 |
| ---------- | -------------------------------- |
| Standard   | Collateral token                 |
| Fixed      | Quote currency                   |
| Dynamic    | Quote currency (effective price) |

> Even though Dynamic orders are listed in collateral terms, **effective price is always computed in quote currency**.

This ensures:

* Consistent comparisons
* No duplicate conversions during settlement
* Cleaner fee and execution logic

### 4.1 Cross-Currency Price Conversion

For cross-currency order matching, all prices must be normalized to quote currency:

**Fixed Orders**:
- `pricePerToken` already in quote currency (e.g., USDT) → use directly

**Dynamic Orders**: 
- `pricePerToken` in collateral currency (e.g., BTC) → convert using oracle
- Conversion: `BTC price × oracle_rate = USDT price`
- Applied to both taker and maker Dynamic orders

**Cross-Currency Book Retrieval**:
- **Dynamic book**: `keccak256(positionId, collateralToken)` - contains Dynamic orders priced in BTC
- **Fixed book**: `keccak256(positionId, quoteCurrency)` - contains Fixed orders priced in USDT

This design enables proper price comparison between Fixed and Dynamic orders in the same quote currency domain.

---

## 5. Matching Engine Rules

### 5.1 Matching Priority

* **Price-time priority only**
* No preference based on:

  * order type
  * currency
  * maker/taker classification beyond price

### 5.2 Effective Price

* The **effective price** is the actual execution price
* Always expressed in **quote currency** for cross-currency orders
* Computed once during matching
* Reused during settlement (no recomputation)

---

## 6. Matching Scope & Filtering Rules

### Fundamental Rule

> **Standard orders only match with Standard orders**
> **Cross-currency orders only match with Cross-currency orders**

### Filtering Happens At

```solidity
LibMatchEngine.findPotentialMatchesForOrder()
```

Not during settlement.

---

## 7. Orderbook Retrieval Logic

### 7.1 Standard Order Matching

Retrieve **two complementary books**:

1. **Primary complementary book**

   * Same position ID
   * Same collateral token
   * Complementary direction
   * Standard orders only

2. **Sibling position book**

   * Sibling of the original position
   * Same collateral
   * Same direction

---

### 7.2 Cross-Currency Order Matching

Retrieve **two complementary books**:

1. **Collateral-based complementary book**

   * Same position ID
   * Same collateral
   * Complementary direction
   * Cross-currency orders only

2. **Quote-currency complementary book**

   * Same position ID
   * Quote currency instead of collateral
   * Complementary direction
   * Cross-currency orders only

This design:

* Avoids unnecessary traversal
* Ensures only valid liquidity is inspected
* Keeps price domains isolated

---

## 8. Dynamic Order Sorting Strategy

* Dynamic orders are **sorted by collateral token**
* **Not sorted by oracle exchange rate**
* Exchange-rate-based ordering is applied only:

  * when a taker arrives
  * during filtering and effective price computation

> No periodic resorting is performed due to oracle updates.

---

## 9. Floor Rate Enforcement

### When Checked

* During **matching/filtering**
* NOT during settlement

### Behavior

* If current oracle exchange rate violates the floor rate:

  * Order is **excluded from potential matches**
  * No revert
  * Simply skipped

---

## 10. Oracle Integration Rules

### Order Creation

* Always allowed
* Even if oracle is stale

### Matching

* For any incoming **cross-currency order**:

  * Oracle freshness **must be checked**
  * If stale → **matching process stops**
  * Only matching is halted, not the protocol

### Settlement

* Assumes oracle validation already happened
* No duplicate oracle checks

---

## 11. MatchType Enum (Simplified)

Previous expansion was deemed unnecessary.

### Final Model

```solidity
enum MatchType {
  None,
  Complementary,
  Mint,
  Merge,
  CrossCurrency
}
```

All Fixed/Dynamic combinations are handled internally under `CrossCurrency`.

* No fee differentiation
* No settlement branching
* Only effective price computation differs

---

## 12. Restrictions & Non-Goals

### Explicitly Not Supported (For Now)

* Mint / Merge for cross-currency matches
* Order routing or multi-hop matching
* Liquidity aggregation across books
* Currency exposure limits
* Stop-loss or oracle-triggered order management
* Limits on number of currencies per position
* Analytics-layer aggregation

---

## 13. Design Philosophy Summary

* **Isolation over aggregation**
* **Explicit books over implicit filtering**
* **Matching-time validation over settlement-time checks**
* **Single effective price computation**
* **Gas efficiency via reduced traversal**
* **Flexibility for future expansion without premature complexity**

---

## 14. Key Takeaway

> Multiple currency-specific orderbooks are not a convenience feature —
> they are a **correctness and safety primitive**.

This refactor lays the foundation for:

* safer matching
* better price integrity
* scalable multi-currency trading
  without overengineering future features prematurely.

