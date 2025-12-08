# Cross-Currency Order Price-Time Priority Design

## Executive Summary

This document addresses a critical design challenge in the cross-currency order matching system: maintaining accurate price-time priority when orders use different exchange rate types (Fixed vs Dynamic) that can diverge over time due to oracle price fluctuations.

**Recommendation:** Implement **Just-In-Time price calculation during matching execution** rather than reorganizing the orderbook on every price update.

---

## The Problem

### Background

Cross-currency orders allow users to trade positions using quote currencies (USDT, ETH, etc.) while the system's orderbook is denominated in a collateral currency (BTC). Orders store:

- `pricePerToken`: Price in **collateral currency** (BTC)
- `exchangeRateType`: Fixed or Dynamic
- `exchangeRate`: The exchange rate used for conversion

### The Challenge

**Price-Time Priority Violation:** Orders sorted by collateral price may not reflect true price priority in quote currency terms when exchange rates fluctuate.

### Example Scenario

```
Market: Bitcoin Difficulty Options
Collateral Token: BTC (8 decimals)
Quote Currency: USD

Order 1 (Fixed Rate):
  - pricePerToken: 0.000005 BTC
  - exchangeRateType: Fixed
  - exchangeRate: 96,000 USD/BTC
  - Effective USD price: 0.000005 × 96,000 = 0.48 USD per token
  - Created: 10:00 AM

Order 2 (Dynamic Rate):
  - pricePerToken: 0.000006 BTC  
  - exchangeRateType: Dynamic
  - Current oracle rate: 78,000 USD/BTC
  - Effective USD price: 0.000006 × 78,000 = 0.468 USD per token
  - Created: 10:05 AM
```

**Problem:**
- Orderbook sorts by `pricePerToken`: Order 1 (0.000005) comes before Order 2 (0.000006)
- In quote currency (USD): Order 2 (0.468) is actually cheaper than Order 1 (0.48)
- A buy order willing to pay 0.475 USD should match Order 2 first (better price)
- But orderbook traversal would encounter Order 1 first

**When It Gets Worse:**
If BTC/USD rate drops from 96,000 to 78,000:
- Order 1 (fixed at 96k): Still effectively 0.48 USD
- Order 2 (dynamic at 78k): Now 0.468 USD
- Order 2 becomes the better price, but orderbook doesn't reflect this

---

## Current Implementation Analysis

### Order Creation & Storage

**Location:** `contracts/libraries/LibOrderbook.sol`

Orders are inserted sorted by collateral price (`pricePerToken`):

```solidity
function _insertSorted(LibDoefinStorage.Order memory order) internal {
    // ...
    uint256 price = order.pricePerToken;
    
    // Cross-currency orders: convert to quote currency price for sorting
    if (order.orderType == LibDoefinStorage.OrderType.CrossCurrency) {
        bool useOracleRate = (order.crossCurrencyConfig.exchangeRateType == 
            LibDoefinStorage.ExchangeRateType.Dynamic);
        (uint256 quoteCurrencyPrice, bool isStale) = 
            LibQuoteCurrency.calculateQuoteCurrencyPrice(order, useOracleRate);
        price = quoteCurrencyPrice;
    }
    
    // Binary search insertion...
}
```

**Current Behavior:**
- ✅ Cross-currency orders ARE converted to quote currency price at insertion
- ⚠️ Dynamic orders use oracle rate **at insertion time**
- ❌ If oracle rate changes, the stored sort order becomes stale

### Order Matching

**Location:** `contracts/libraries/LibMatchEngine.sol`

Matching uses live price calculation:

```solidity
function effectiveTakerPrice(
    LibDoefinStorage.Order memory makerOrder,
    LibDoefinStorage.OrderDirection takerDirection,
    LibDoefinStorage.MatchType matchType
) internal view returns (uint256) {
    if (makerOrder.orderType == LibDoefinStorage.OrderType.CrossCurrency) {
        return _effectiveTakerPriceCrossCurrency(makerOrder, takerDirection, matchType);
    }
    // Standard pricing...
}

function _effectiveTakerPriceCrossCurrency(...) internal view returns (uint256) {
    bool useOracleRate = (makerOrder.crossCurrencyConfig.exchangeRateType == 
        LibDoefinStorage.ExchangeRateType.Dynamic);
    
    // Live price calculation - fetches current oracle rate if dynamic
    (uint256 quoteCurrencyPrice, bool isStale) = 
        LibQuoteCurrency.calculateQuoteCurrencyPrice(makerOrder, useOracleRate);
    // ...
}
```

**Current Behavior:**
- ✅ Live oracle rates are fetched during matching
- ✅ Effective prices include current exchange rates
- ⚠️ Orderbook traversal still uses storage order (which may be stale)

### The Gap

**What's working:**
- Individual price calculations are accurate
- Oracle integration is functional
- Fee application is correct

**What's broken:**
- Orderbook iteration assumes sort order reflects current prices
- Dynamic rate changes invalidate the sort order
- Best order selection may skip better options that are further in the array

---

## Solution Options

### Option 1: Just-In-Time Price Calculation ✅ **RECOMMENDED**

**Strategy:** Accept that orderbook sort order is approximate; calculate live prices during matching to make final selection.

#### How It Works

1. **Orderbook storage remains unchanged**
   - Keep orders sorted by `pricePerToken` (collateral currency)
   - This provides a reasonable starting point for iteration

2. **During matching, calculate live effective prices**
   - Fetch current oracle rates for dynamic orders
   - Calculate quote currency prices on-the-fly
   - Compare orders based on these live prices

3. **Order selection uses live prices, not storage order**
   - `_computeBestMatchExecution` compares live effective prices
   - Price-time priority is evaluated with current exchange rates
   - The "best" order is determined dynamically

#### Implementation Changes

**File:** `contracts/libraries/LibMatchEngine.sol`

**Current `_findCrossingOrderIds` logic:**
```solidity
while (remaining > 0 && (i < complementaryOrders.length || j < mintOrMergeOrders.length)) {
    // Gets orders from storage
    if (compAvailable) compOrder = ds.orderbookStorage.orders[complementaryOrders[i]];
    if (sibAvailable) sibOrder = ds.orderbookStorage.orders[mintOrMergeOrders[j]];
    
    // Picks best based on stored state
    (LibDoefinStorage.Match memory execution, bool pickComp, bool exhausted) = 
        _pickBestOrder(...);
    
    // Uses execution.effectivePrice for limit check
    if (takerOrder.executionType != LibDoefinStorage.ExecutionType.Market) {
        if (takerOrder.direction == LibDoefinStorage.OrderDirection.Buy) {
            if (price > takerPriceForComparison) break;
        }
    }
}
```

**Proposed enhancement:**
- Add oracle price caching at transaction start
- Ensure `_pickBestOrder` → `_computeBestMatchExecution` → `effectiveTakerPrice` chain always uses live prices
- Already implemented! Just needs verification that storage order doesn't cause early termination

#### Advantages

✅ **Gas efficient** - No orderbook reorganization  
✅ **Accurate** - Always uses current oracle prices  
✅ **Simple** - Minimal code changes  
✅ **Safe** - No storage modifications during price updates  
✅ **Already partially implemented** - Most logic exists  

#### Disadvantages

⚠️ **Iteration efficiency** - May need to scan more orders if best one is deeper  
⚠️ **Gas cost variance** - Different positions in book cost different gas  
🔶 **Not "true" CLOB** - Visual orderbook doesn't reflect live prices  

#### Gas Analysis

**Per order evaluated:**
- Storage read: ~2.1k gas (SLOAD)
- Oracle call: ~2-5k gas (view, cached)
- Price calculation: ~1-2k gas
- **Total: ~5-10k gas per order**

**For typical matching (10 orders scanned):**
- Total: ~50-100k gas
- **Acceptable for DEX operations**

**Optimization opportunity:**
Cache oracle rates at transaction start:
```solidity
struct OracleCache {
    mapping(bytes32 => uint256) rates;
    mapping(bytes32 => uint256) timestamps;
}
```

---

### Option 2: Periodic Orderbook Reorganization ❌ **NOT RECOMMENDED**

**Strategy:** Rebuild orderbook when exchange rates change significantly.

#### How It Would Work

1. **Monitor oracle price changes**
   - Track deviation from last reorganization
   - Trigger rebuild at X% change threshold

2. **Rebuild orderbook on trigger**
   - Remove all orders from storage arrays
   - Recalculate quote currency prices
   - Re-sort and re-insert orders

3. **Keeper-driven or automatic**
   - External keeper calls reorganize function
   - Or automatic on every oracle update

#### Why Not

❌ **Extremely gas intensive** - O(n log n) on-chain sorting  
❌ **When to trigger?** - Every oracle update? Threshold-based? Manual?  
❌ **MEV vulnerability** - Keepers can front-run for favorable ordering  
❌ **Storage corruption risk** - Complex array manipulation  
❌ **Breaks atomicity** - Orders may execute during reorganization  
❌ **Multiple currencies** - Need separate triggers per currency pair  

**Estimated gas cost:**
- 100 orders: ~2-5M gas per reorganization
- Multiple times per hour in volatile markets
- **Prohibitively expensive**

---

### Option 3: Separate Orderbooks for Fixed/Dynamic ⚠️ **ALTERNATIVE**

**Strategy:** Maintain separate books for fixed vs dynamic rate orders.

#### How It Would Work

**Storage structure:**
```solidity
struct OrderbookStorage {
    // Existing
    mapping(uint256 => uint256[]) buyOrdersByPosition;
    mapping(uint256 => uint256[]) sellOrdersByPosition;
    
    // New - separate books by rate type
    mapping(uint256 => uint256[]) fixedRateBuyOrders;
    mapping(uint256 => uint256[]) dynamicRateBuyOrders;
    mapping(uint256 => uint256[]) fixedRateSellOrders;
    mapping(uint256 => uint256[]) dynamicRateSellOrders;
}
```

**Matching logic:**
```solidity
function _findBestOrder() internal view returns (Order memory) {
    // Get best from fixed book (use stored collateral price)
    Order memory bestFixed = _getBestFromBook(fixedRateOrders);
    
    // Get best from dynamic book (calculate with current oracle price)
    Order memory bestDynamic = _getBestFromBook(dynamicRateOrders);
    uint256 dynamicLivePrice = calculateLivePrice(bestDynamic);
    
    // Compare and pick best
    return (bestFixed.price <= dynamicLivePrice) ? bestFixed : bestDynamic;
}
```

#### Advantages

✅ Fixed orders remain sorted correctly  
✅ Dynamic orders can be evaluated with live prices  
✅ No reorganization needed  
🔶 Clean separation of concerns  

#### Disadvantages

⚠️ **Breaks price-time priority across types** - Fixed order at 10:00 vs Dynamic at 9:59  
⚠️ **Doubled storage** - More mappings, more gas for writes  
⚠️ **Complex iteration** - Need to check both books  
⚠️ **Migration complexity** - Existing orders need classification  

**Verdict:** Possible but adds complexity for marginal benefit over Option 1.

---

## Recommended Implementation Plan

### Phase 1: Validation & Testing

**Verify current behavior:**

1. Create test case with the example scenario:
   ```javascript
   it("should match best quote currency price despite orderbook sort order", async () => {
     // Order 1: 0.000005 BTC at fixed 96k rate = 0.48 USD
     // Order 2: 0.000006 BTC at dynamic 78k rate = 0.468 USD
     // Buy order at 0.475 USD should match Order 2
   });
   ```

2. Confirm `effectiveTakerPrice` uses live oracle rates
3. Verify orderbook traversal in `_findCrossingOrderIds` doesn't early-terminate incorrectly

**Expected findings:**
- Current implementation likely works for complementary matches
- May have issues with limit orders that check price and break early
- Orderbook visualization may confuse users (shows stale order)

### Phase 2: Optimization

**Add oracle caching:**

```solidity
// In LibDoefinStorage
struct OracleRateCache {
    uint256 rate;
    uint256 timestamp;
    bool isValid;
}

struct TradingSessionCache {
    mapping(bytes32 => OracleRateCache) oracleRates;
}
```

**Implementation:**
```solidity
function _getCachedOrFreshOracleRate(
    address quoteCurrency,
    address collateral,
    TradingSessionCache storage cache
) internal view returns (uint256 rate, bool isStale) {
    bytes32 cacheKey = keccak256(abi.encodePacked(quoteCurrency, collateral));
    
    // Check cache
    if (cache.oracleRates[cacheKey].isValid && 
        block.timestamp == cache.oracleRates[cacheKey].timestamp) {
        return (cache.oracleRates[cacheKey].rate, false);
    }
    
    // Fetch fresh
    (rate, isStale) = LibQuoteCurrency.getOracleExchangeRate(quoteCurrency, collateral);
    
    // Cache for this transaction
    cache.oracleRates[cacheKey] = OracleRateCache({
        rate: rate,
        timestamp: block.timestamp,
        isValid: !isStale
    });
    
    return (rate, isStale);
}
```

**Benefit:** Avoid redundant oracle calls within same transaction (~10-20k gas savings)

### Phase 3: Enhanced Price Discovery

**Optional look-ahead mechanism:**

```solidity
// In LibMatchEngine._findCrossingOrderIds
uint256 constant LOOK_AHEAD_DEPTH = 5;

// When checking orders, scan ahead to catch dynamic orders that may be better
for (uint256 lookahead = 0; lookahead < LOOK_AHEAD_DEPTH; lookahead++) {
    uint256 nextIdx = i + lookahead;
    if (nextIdx >= complementaryOrders.length) break;
    
    Order memory nextOrder = ds.orderbookStorage.orders[complementaryOrders[nextIdx]];
    if (nextOrder.orderType == OrderType.CrossCurrency && 
        nextOrder.crossCurrencyConfig.exchangeRateType == ExchangeRateType.Dynamic) {
        
        uint256 livePrice = effectiveTakerPrice(nextOrder, ...);
        if (isBetterPrice(livePrice, currentBestPrice)) {
            // Use this order instead
        }
    }
}
```

**When to use:** High-volatility markets where dynamic orders frequently flip

### Phase 4: Monitoring & Events

**Add observability:**

```solidity
event OrderSkippedDueToPriceFluctuation(
    uint256 indexed orderId,
    uint256 storedSortPrice,
    uint256 liveEffectivePrice,
    uint256 betterOrderId
);

event DynamicRatePriceUpdate(
    uint256 indexed orderId,
    uint256 oldEffectivePrice,
    uint256 newEffectivePrice,
    uint256 exchangeRate
);
```

**Analytics:**
- Track how often dynamic orders "jump" position
- Measure gas costs of look-ahead vs. savings from better matches
- Monitor user fairness metrics

---

## Edge Cases & Considerations

### 1. Rapid Oracle Price Changes

**Scenario:** Oracle rate changes mid-transaction

**Handling:**
- Oracle calls are view functions - use latest rate
- Within single transaction, cache is consistent
- Across transactions, different users see different rates
- **Acceptable:** Similar to any DEX with price oracles

### 2. Stale Oracle Protection

**Current implementation:**
```solidity
(uint256 quoteCurrencyPrice, bool isStale) = 
    LibQuoteCurrency.calculateQuoteCurrencyPrice(order, useOracleRate);

if (isStale) {
    revert Errors.OraclePriceStale();
}
```

**Behavior:**
- Dynamic orders become unmatchable if oracle is stale
- Fixed orders continue to work
- **Correct:** Safety over liveness

### 3. Mixed Order Types in Same Book

**Scenario:** 
```
Book: [Standard Order, CrossCurrency Fixed, CrossCurrency Dynamic, Standard Order]
```

**Handling:**
- Standard orders: Use `pricePerToken` directly
- Cross-currency: Calculate quote price
- Skip incompatible matches (Standard can't match CrossCurrency)
- **Current code handles this** in `_findCrossingOrderIds` lines 130-150

### 4. Fee Calculation Consistency

**Important:** Fees must be applied consistently across:
- Order insertion sorting
- Matching price comparison
- Settlement execution

**Current implementation:**
- `effectiveTakerPrice` applies taker fees ✅
- `effectiveMakerPrice` applies maker fees ✅
- Settlement uses these functions ✅
- **Consistent**

### 5. User Experience

**Problem:** UI shows orderbook in collateral currency, but matches happen in quote currency

**Solutions:**
1. **Display both prices:**
   ```
   Order: 0.000005 BTC (≈ $0.48 at current rate)
   ```

2. **Show live vs. stored for dynamic orders:**
   ```
   Dynamic Order: $0.468 (live) | Placed at: $0.52
   ```

3. **Indicate sort order is approximate:**
   ```
   ⚠️ Prices shown are indicative. Actual match uses live exchange rates.
   ```

---

## Testing Plan

### Unit Tests

**File:** `test/unit/ExchangeFacet/ExchangeFacet.crossCurrency.priceTime.test.js`

```javascript
describe("Cross-Currency Price-Time Priority", () => {
  
  it("should match dynamic order with better live price over fixed order", async () => {
    // Setup: BTC collateral, USD quote
    // Order 1: Fixed at 96k rate, effective $0.48
    // Order 2: Dynamic at 78k rate, effective $0.468
    // Expectation: Order 2 matches first
  });
  
  it("should respect time priority when live prices are equal", async () => {
    // Two dynamic orders with same live effective price
    // Older order should match first
  });
  
  it("should handle oracle price change between order creation and matching", async () => {
    // Create dynamic order at rate X
    // Update oracle to rate Y
    // Match should use rate Y
  });
  
  it("should revert on stale oracle for dynamic orders", async () => {
    // Create dynamic order
    // Make oracle stale (advance time past staleness threshold)
    // Matching should revert
  });
  
  it("should allow fixed orders to match when oracle is stale", async () => {
    // Fixed order should work regardless of oracle status
  });
});
```

### Integration Tests

**File:** `test/integration/crossCurrency.matching.test.js`

```javascript
describe("Cross-Currency Matching Integration", () => {
  
  it("should handle mixed orderbook with multiple rate types", async () => {
    // Create: Standard, Fixed CC, Dynamic CC, Standard, Dynamic CC
    // Match market order
    // Verify correct selection based on effective prices
  });
  
  it("should maintain fairness across multiple matches", async () => {
    // Large market order matching 10+ maker orders
    // Mix of fixed and dynamic
    // Verify total execution price is optimal
  });
  
  it("should handle rapid oracle updates", async () => {
    // Create dynamic order
    // Update oracle multiple times
    // Match orders between each update
    // Verify each match uses current rate at match time
  });
});
```

### Gas Benchmarks

```javascript
describe("Gas Costs", () => {
  
  it("benchmark: standard order matching", async () => {
    // Baseline gas cost
  });
  
  it("benchmark: fixed cross-currency matching", async () => {
    // Should be similar to standard
  });
  
  it("benchmark: dynamic cross-currency matching", async () => {
    // May be higher due to oracle call
  });
  
  it("benchmark: mixed book with 10 orders", async () => {
    // Measure iteration cost
  });
});
```

---

## Migration & Deployment

### No Breaking Changes Required

✅ Storage layout unchanged  
✅ Existing orders remain valid  
✅ No data migration needed  

### Verification Steps

1. Deploy to testnet
2. Create test orders (standard, fixed CC, dynamic CC)
3. Verify matching behavior with oracle updates
4. Monitor gas costs
5. Check event logs for correct price calculations
6. Frontend integration testing

### Rollout Plan

1. **Phase 1:** Deploy enhanced matching logic
2. **Phase 2:** Add monitoring events
3. **Phase 3:** Update frontend to show live prices
4. **Phase 4:** Enable look-ahead optimization (optional)

---

## Future Enhancements

### 1. Off-Chain Orderbook Indexer

**Concept:** Maintain off-chain index with live-calculated prices

**Benefits:**
- Fast price discovery for UI
- Can show "live orderbook" with current rates
- No on-chain gas cost

**Implementation:**
- Listen to OrderCreated events
- Subscribe to oracle price updates
- Recalculate order prices in real-time
- Serve via API for frontend

### 2. Optimistic Order Matching

**Concept:** Allow keepers to submit pre-computed match routes

**Benefits:**
- Lower gas for complex matches
- Better price discovery

**Risk:** Need verification to prevent manipulation

### 3. Multi-Currency Atomic Swaps

**Concept:** Match across different quote currencies

**Example:**
- Order A: BTC collateral, USD quote
- Order B: BTC collateral, ETH quote
- Match using USD/ETH conversion

**Requires:** Multi-hop oracle rate calculation

---

## Conclusion

**Recommendation:** Implement **Option 1 - Just-In-Time Price Calculation**

**Key Points:**
1. ✅ Orderbook sort order is **approximate** - optimized for iteration
2. ✅ Final matching uses **live oracle prices** - accurate execution
3. ✅ Price-time priority is **preserved** based on live effective prices
4. ✅ Minimal code changes - most logic already exists
5. ✅ Gas efficient - no orderbook reorganization

**Next Steps:**
1. Add comprehensive test coverage for price-time priority edge cases
2. Implement oracle rate caching for gas optimization
3. Add monitoring events for price fluctuation tracking
4. Update frontend to display both stored and live prices
5. Consider optional look-ahead mechanism for high-volatility periods

**Trade-offs Accepted:**
- Orderbook visualization shows approximate order (not live-sorted)
- Users need education that displayed order may not reflect execution order
- Slightly higher gas cost for dynamic rate calculation during matching

**Trade-offs Avoided:**
- ❌ No expensive on-chain sorting
- ❌ No storage reorganization complexity
- ❌ No MEV-vulnerable keeper triggers
- ❌ No broken atomicity during reorganization

This approach balances **accuracy, efficiency, and safety** while working within the constraints of on-chain execution and maintaining the Diamond architecture's modularity.

---

## References

**Related Files:**
- `contracts/libraries/LibMatchEngine.sol` - Order matching logic
- `contracts/libraries/LibOrderbook.sol` - Orderbook management  
- `contracts/libraries/LibQuoteCurrency.sol` - Cross-currency calculations
- `contracts/libraries/LibTradeSettlement.sol` - Settlement execution
- `contracts/libraries/LibDoefinStorage.sol` - Storage structures

**Related Documentation:**
- `.github/DEBUG_CROSS_CURRENCY_MATCHING.md` - Cross-currency debugging guide
- `.github/copilot-instructions.md` - Project architecture overview
- `contracts/facets/ORDER_EXECUTION_DEV.md` - Order execution flow

**Created:** November 24, 2025  
**Author:** Technical Architecture Review  
**Status:** Recommendation - Pending Implementation
