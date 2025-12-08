# Cross-Currency Order Matching Issue - Debug Prompt

## Problem Statement

A cross-currency order matching system is **99% functional** but has one critical issue: **automatic matching between compatible cross-currency orders is not executing**. Orders are created successfully, price calculations work correctly, but settlement doesn't trigger when a new order should match an existing order.

## Current Status

**Working (9/10 tests passing):**
- ✅ Cross-currency order creation (buy & sell)
- ✅ Collateral locking (quote currency for buys, position tokens for sells)
- ✅ Price calculation with 1e36 scaling to avoid precision loss
- ✅ Price comparison logic (converts taker price to quote currency)
- ✅ Fee calculations in quote currency
- ✅ Validation (quote currency allowed, exchange rates, oracle staleness)
- ✅ Buy/Sell maker settlement routing
- ✅ Oracle adapter error handling

**Not Working (1/10 tests failing):**
- ❌ Automatic matching during order creation (`_tryFillImmediately()` flow)

## System Architecture

### Order Matching Flow
```
OrderCreationFacet.createOrder()
  ↓
LibOrderbook._tryFillImmediately(orderId)
  ↓
LibMatchEngine.findPotentialMatchesForOrder(orderId)
  ↓  [Returns array of matching order IDs]
  ↓
LibSettlement.fillOrders(takerId, makerIds[])
  ↓
LibTradeSettlement._handleCrossCurrencySettlement()
  ↓
_settleCrossCurrencyBuyMaker() OR _settleCrossCurrencySellMaker()
```

### Key Components

**LibMatchEngine** (`contracts/libraries/LibMatchEngine.sol`):
- `findPotentialMatchesForOrder()`: Finds compatible orders
- `_findCrossingOrderIds()`: Filters orders by price crossing
- For cross-currency: Converts prices to quote currency (1e36 scaled) for comparison
- Price check logic: Buy taker matches if `makerPrice < takerPrice`, Sell taker matches if `makerPrice > takerPrice`

**LibQuoteCurrency** (`contracts/libraries/LibQuoteCurrency.sol`):
- `calculateQuoteCurrencyPrice()`: Converts collateral-denominated price to quote currency
- Formula: `(pricePerToken * quoteUnitPerPair * 1e36) / (collateralUnitPerPair * exchangeRate)`
- Returns 1e36-scaled price to preserve precision
- `areOrdersCompatible()`: Both must be CrossCurrency type, same quote currency

**LibTradeSettlement** (`contracts/libraries/LibTradeSettlement.sol`):
- `_isCrossCurrencySettlement()`: Checks if maker order is CrossCurrency
- `_handleCrossCurrencySettlement()`: Routes to buy or sell maker settlement
- `_settleCrossCurrencyBuyMaker()`: Maker pays quote currency, receives position tokens
- `_settleCrossCurrencySellMaker()`: Maker receives quote currency, pays position tokens

## Test Scenario (Failing)

**Setup:**
- 2 traders with BTC positions and USDT balances
- Exchange rate: 96,000 USDT per BTC (as `96000e18`)
- BTC decimals: 8, USDT decimals: 6
- Position: YES token for a Bitcoin difficulty condition

**Order 1 (Trader1 - Maker):**
- Type: CrossCurrency BUY
- Position: YES (positionId)
- Amount: 100,000 micro-units (0.001 BTC worth)
- Price: 650,000 (0.0065 BTC per token)
- Collateral: USDT (quote currency)
- Locked: 6,837 micro-USDT (calculated correctly)
- Direction: Buy

**Order 2 (Trader2 - Taker):**
- Type: CrossCurrency SELL  
- Position: YES (same positionId)
- Amount: 100,000 micro-units
- Price: 650,000 (same price)
- Collateral: BTC positions (has position tokens)
- Direction: Sell

**Expected:** Orders should match automatically when Order 2 is created
**Actual:** No settlement occurs, both orders remain in orderbook

**Evidence from Logs:**
```
DEBUG: Checking price crossing - effectivePrice: 66354166666666666
DEBUG: Converted to quote price: 67708333333333333
DEBUG: Sell check - price < takerPrice? true  ← Price comparison PASSES
```

But then:
- Only 3 events emitted: TransferSingle, ERC1155CollateralLocked, OrderCreated
- **NO** CrossCurrencySettlement event
- **NO** OrderMatched event
- Trader2 USDT balance unchanged (should have increased)

## Key Observations

1. **Price comparison logic works** - Debug logs confirm the crossing check passes
2. **Orders are complementary** - Opposite directions (Buy vs Sell), same position
3. **Both are CrossCurrency type** - Compatibility check should pass
4. **Same quote currency** - Both use USDT
5. **Collateral locked correctly** - Trader1 locked 6,837 micro-USDT, Trader2 locked position tokens

## Debugging Hints

The issue is likely in one of these areas:

1. **`findPotentialMatchesForOrder()` returning empty array** - Even though price check passes, maybe the order isn't added to the return array
   - Check the loop logic after price comparison in `_findCrossingOrderIds()`
   - Verify cross-currency orders are added to complementary orderbooks correctly

2. **`LibSettlement.fillOrders()` failing silently** - Maybe validation fails or reverts are caught
   - Check `_validateOrder()` calls
   - Check `_validateCrossCurrencyMatch()` 
   - Look for try-catch blocks swallowing errors

3. **Orderbook retrieval issue** - Maybe sell orders aren't finding buy orders
   - In `LibMatchEngine.retrieveTheBooksAndMatchType()`, verify:
     - Buy taker gets `ds.orderbookStorage.buyOrdersByPosition[positionId]` (complementary)
     - Sell taker gets `ds.orderbookStorage.buyOrdersByPosition[positionId]` (complementary)

4. **Cross-currency compatibility check too strict** - Maybe additional validation beyond `areOrdersCompatible()`
   - Check `_areOrdersCompatibleForCrossCurrency()` in LibMatchEngine
   - Check `_validateCrossCurrencyMatch()` in LibSettlement

## Files to Focus On

- `contracts/libraries/LibMatchEngine.sol` (lines 45-160)
- `contracts/libraries/LibOrderbook.sol` (lines 150-175 - `_tryFillImmediately`)
- `contracts/libraries/LibSettlement.sol` (lines 26-70, 380-420)
- `contracts/libraries/LibTradeSettlement.sol` (lines 46-47, 531-598)
- `test/unit/ExchangeFacet/ExchangeFacet.crossCurrency.test.js` (lines 460-605 - failing test)

## Suggested Approach

1. Add console.log in `findPotentialMatchesForOrder()` to see what's returned
2. Add console.log in `_tryFillImmediately()` to confirm it's called
3. Check if `LibSettlement.fillOrders()` is reached
4. Verify orderbook storage - are orders actually in the complementary books?
5. Check for silent reverts or error conditions

## Configuration

- Exchange rate format: `parseEther("96000")` → 96000000000000000000000 (96000e18)
- BTC unit: 1e8 (100,000,000)
- USDT unit: 1e6 (1,000,000)
- Price scaling in matching: 1e36 (for precision)

## Recent Fixes Applied

1. **Price calculation precision** - Changed from 1e18 to 1e36 scaling to avoid underflow:
   ```solidity
   quoteCurrencyPrice = (order.pricePerToken * quoteUnitPerPair * 1e36) / (collateralUnitPerPair * exchangeRate);
   ```

2. **Taker price conversion** - Added logic to convert taker's collateral price to quote currency for comparison:
   ```solidity
   if (takerOrder.orderType == LibDoefinStorage.OrderType.CrossCurrency) {
       (uint256 takerQuotePrice, bool isStale) = LibQuoteCurrency.calculateQuoteCurrencyPrice(takerOrder, useOracleRate);
       takerPriceForComparison = takerQuotePrice;
   }
   ```

3. **Settlement routing** - Fixed hardcoded BuyMaker to route based on direction:
   ```solidity
   if (makerOrder.direction == LibDoefinStorage.OrderDirection.Buy) {
       _settleCrossCurrencyBuyMaker(settlementExecCtx, quoteCurrencyToken, makerQuotePayment, takerQuotePayment);
   } else {
       _settleCrossCurrencySellMaker(settlementExecCtx, quoteCurrencyToken, makerQuotePayment, takerQuotePayment);
   }
   ```

---

**Goal:** Identify why `findPotentialMatchesForOrder()` or `fillOrders()` isn't executing the settlement when compatible cross-currency orders exist.

## Test Command

```bash
npx hardhat test test/unit/ExchangeFacet/ExchangeFacet.crossCurrency.test.js --grep "should match cross-currency orders"
```
