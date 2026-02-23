# Contract Size Optimization Guide
## OrderCreationFacet Size Reduction Strategy

**Date:** November 27, 2025  
**Current Size:** 24.983 KB (25,583 bytes)  
**Target Size:** < 24 KB (Mainnet deployment limit)  
**Expected Final Size:** 10-13 KB after all optimizations

---

## Executive Summary

The `OrderCreationFacet` contract exceeds the 24 KB deployment limit despite containing only 64 lines of code. The root cause is **transitive library inlining** - the Solidity compiler with `runs: 1` and `viaIR: true` inlines all internal library functions into the facet bytecode.

### Dependency Chain Analysis

```
OrderCreationFacet (64 lines)
  └─> LibOrderbook.createOrder (338 lines)
      ├─> LibEscrowLogic (169 lines)
      │   ├─> LibCollateralManager (353 lines)
      │   ├─> LibFeeManager (278 lines)
      │   └─> LibQuoteCurrency (321 lines)
      ├─> LibMatchEngine (447 lines)
      │   ├─> LibPositionRegistry (188 lines)
      │   └─> LibQuoteCurrency (321 lines) ← DUPLICATE
      ├─> LibSettlement (450 lines)
      │   ├─> LibTradeSettlement (790 lines)
      │   │   ├─> LibCollateralManager (353 lines) ← DUPLICATE
      │   │   ├─> LibFeeManager (278 lines) ← DUPLICATE
      │   │   ├─> LibQuoteCurrency (321 lines) ← DUPLICATE
      │   │   ├─> LibCTFCondition (189 lines)
      │   │   └─> LibPositionRegistry (188 lines) ← DUPLICATE
      │   └─> LibQuoteCurrency (321 lines) ← DUPLICATE
      └─> LibQuoteCurrency (321 lines) ← DUPLICATE
```

**Total transitive dependencies: ~5,400+ lines being inlined**

---

## Code Duplication Patterns Identified

### Pattern 1: Cross-Currency Exchange Rate Fetching
**Occurrences:** 11 locations  
**Estimated Waste:** ~2.2 KB

**Locations:**
- `LibOrderbook.sol`: Lines 72-80, 261-265
- `LibEscrowLogic.sol`: Lines 44-46, 94-97
- `LibMatchEngine.sol`: Lines 106-110, 412-415
- `LibSettlement.sol`: Lines 420-423
- `LibTradeSettlement.sol`: Lines 556-557, 639-640

**Duplicated Code:**
```solidity
bool useOracleRate = (order.crossCurrencyConfig.exchangeRateType == LibDoefinStorage.ExchangeRateType.Dynamic);
(uint256 exchangeRate, bool isStale) = LibQuoteCurrency.getOracleExchangeRate(
    order.crossCurrencyConfig.quoteCurrencyToken,
    order.collateralToken
);
if (isStale) revert Errors.OraclePriceStale();
if (exchangeRate == 0) revert Errors.InvalidExchangeRate();
```

---

### Pattern 2: Quote Currency Price Calculation
**Occurrences:** 7 locations  
**Estimated Waste:** ~1.75 KB

**Locations:**
- `LibOrderbook.sol`: Lines 260-265, 279-286
- `LibMatchEngine.sol`: Lines 104-110, 370-415
- `LibSettlement.sol`: Lines 418-423

**Duplicated Code:**
```solidity
if (order.orderType == LibDoefinStorage.OrderType.CrossCurrency) {
    bool useOracleRate = (order.crossCurrencyConfig.exchangeRateType == LibDoefinStorage.ExchangeRateType.Dynamic);
    (uint256 quoteCurrencyPrice, bool isStale) = LibQuoteCurrency.calculateQuoteCurrencyPrice(order, useOracleRate);
    if (isStale) revert Errors.OraclePriceStale();
    price = quoteCurrencyPrice;
}
```

---

### Pattern 3: Collateral Value & Quote Amount Calculation
**Occurrences:** 9 locations  
**Estimated Waste:** ~3.6 KB

**Locations:**
- `LibEscrowLogic.sol`: Lines 34-55 (lockCollateral), 84-105 (releaseCollateral)
- `LibTradeSettlement.sol`: Line 645
- `LibCollateralManager.sol`: Line 46

**Duplicated Code:**
```solidity
// Get unit per pair values
LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
uint256 quoteUnitPerPair = ds.adminConfigStorage.unitPerPair[quoteCurrency];
uint256 collateralUnitPerPair = ds.adminConfigStorage.unitPerPair[order.collateralToken];

// Calculate collateral value
uint256 collateralValue = (order.amount * order.pricePerToken) / collateralUnitPerPair;
uint256 quoteAmount;

// Get exchange rate
if (order.crossCurrencyConfig.exchangeRateType == LibDoefinStorage.ExchangeRateType.Dynamic) {
    (uint256 exchangeRate, bool isStale) = LibQuoteCurrency.getOracleExchangeRate(quoteCurrency, order.collateralToken);
    if (isStale) revert Errors.OraclePriceStale();
    quoteAmount = (collateralValue * exchangeRate) / 1e18;
} else {
    uint256 fixedRate = order.crossCurrencyConfig.exchangeRate;
    quoteAmount = (collateralValue * fixedRate) / 1e18;
}

// Calculate fees
uint256 quoteFee = (quoteAmount * order.orderFeeConfig.makerFeeBps) / 10000;
uint256 totalQuoteRequired = quoteAmount + quoteFee;
```

---

### Pattern 4: Cross-Currency Type Checking
**Occurrences:** 14 locations  
**Estimated Waste:** ~2.1 KB

**Found in:**
- `LibEscrowLogic.sol`: Lines 34, 84
- `LibTradeSettlement.sol`: Line 524
- `LibSettlement.sol`: Lines 361, 366, 399, 404, 409, 418
- `LibMatchEngine.sol`: Lines 104, 133, 370
- `LibOrderbook.sol`: Lines 260, 279

**Pattern:**
```solidity
if (order.orderType == LibDoefinStorage.OrderType.CrossCurrency) {
    // Repeated validation/calculation logic
}
```

---

### Pattern 5: Fee Calculation Variations
**Occurrences:** 6 variations  
**Estimated Waste:** ~1.8 KB

**Found in:**
- `LibFeeManager.computeTradeExecutionFees`
- `LibFeeManager.computeMintFees`
- `LibCollateralManager.lockERC20Collateral`
- `LibTradeSettlement._computeCrossCurrencyFees`

**Duplicate Patterns:**
```solidity
uint256 fee = (amount * feeBps) / 10_000;
uint256 cost = (amount * price) / unitPerPair;
uint256 totalRequired = cost + fee;
```

---

## Optimization Strategy

### Phase 1: Facet Split (IMMEDIATE - 2-3 hours)
**Goal:** Break dependency chain between order creation and settlement  
**Expected Savings:** 5-8 KB  
**Priority:** ⚡ CRITICAL - Do this first

#### Current Problem
`LibOrderbook.createOrder` calls `_tryFillImmediately` (line 153), which pulls in:
- `LibMatchEngine.findPotentialMatchesForOrder`
- `LibSettlement.fillOrders`
- `LibTradeSettlement.settlementDispatcher`
- All settlement dependencies (~3,000 lines)

#### Solution: Split into Two Facets

**File 1: `OrderCreationFacet.sol` (Limit Orders Only)**
```solidity
// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibOrderbook} from "../libraries/LibOrderbook.sol";
import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {IOrderCreation} from "../interfaces/IOrderCreation.sol";

/**
 * @title OrderCreationFacet
 * @notice Handles creation of LIMIT orders only (no immediate matching)
 * @dev Split from original to reduce contract size below 24KB
 */
contract OrderCreationFacet is IOrderCreation {
    using LibDoefinStorage for LibDoefinStorage.AppStorage;

    /**
     * @notice Create a new LIMIT order (no immediate execution)
     * @dev This version does NOT attempt immediate matching
     */
    function createOrder(
        uint256 positionId,
        address collateralToken,
        uint256 amount,
        uint256 pricePerToken,
        uint256 minFillAmount,
        uint256 expiry,
        bool fillOrKill,
        LibDoefinStorage.OrderDirection direction,
        LibDoefinStorage.ExecutionType executionType,
        LibDoefinStorage.OrderType orderType,
        LibDoefinStorage.CrossCurrencyConfig memory crossCurrencyConfig
    ) external {
        // Revert if market order - use MarketOrderFacet instead
        if (executionType == LibDoefinStorage.ExecutionType.Market) {
            revert("Use MarketOrderFacet for market orders");
        }

        // Create limit order without immediate matching
        LibOrderbook.createOrderWithoutMatching(
            positionId,
            collateralToken,
            amount,
            pricePerToken,
            minFillAmount,
            expiry,
            fillOrKill,
            direction,
            executionType,
            orderType,
            crossCurrencyConfig
        );
    }
}
```

**File 2: `MarketOrderFacet.sol` (Market Orders with Matching)**
```solidity
// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibOrderbook} from "../libraries/LibOrderbook.sol";
import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {IMarketOrder} from "../interfaces/IMarketOrder.sol";

/**
 * @title MarketOrderFacet
 * @notice Handles creation and immediate execution of MARKET orders
 * @dev Separated from OrderCreationFacet to isolate settlement dependencies
 */
contract MarketOrderFacet is IMarketOrder {
    using LibDoefinStorage for LibDoefinStorage.AppStorage;

    /**
     * @notice Create and immediately execute a market order
     */
    function createMarketOrder(
        uint256 positionId,
        address collateralToken,
        uint256 amount,
        uint256 pricePerToken,
        uint256 minFillAmount,
        uint256 expiry,
        bool fillOrKill,
        LibDoefinStorage.OrderDirection direction,
        LibDoefinStorage.OrderType orderType,
        LibDoefinStorage.CrossCurrencyConfig memory crossCurrencyConfig
    ) external {
        // Create order and attempt immediate matching
        uint256 orderId = LibOrderbook.createOrderWithoutMatching(
            positionId,
            collateralToken,
            amount,
            pricePerToken,
            minFillAmount,
            expiry,
            fillOrKill,
            direction,
            LibDoefinStorage.ExecutionType.Market,
            orderType,
            crossCurrencyConfig
        );

        // Try to fill immediately
        LibOrderbook.tryFillOrder(orderId);
    }
}
```

#### Required Library Changes

**File: `LibOrderbook.sol`**

**Change 1: Rename `createOrder` to `createOrderWithoutMatching`**
```solidity
// OLD (line 18)
function createOrder(

// NEW
function createOrderWithoutMatching(
```

**Change 2: Remove `_tryFillImmediately` call**
```solidity
// OLD (around line 151-153)
emit Events.OrderCreated(...);

_tryFillImmediately(orderId);
}

// NEW
emit Events.OrderCreated(...);

// Return orderId for market order handling
return orderId;
}
```

**Change 3: Make `_tryFillImmediately` public as `tryFillOrder`**
```solidity
// OLD (line 155)
function _tryFillImmediately(uint256 orderId) internal {

// NEW
function tryFillOrder(uint256 orderId) internal {
```

**Change 4: Update function signature to return orderId**
```solidity
// OLD (line 18)
) internal returns (uint256 orderId) {

// NEW
) internal returns (uint256 orderId) {
```

#### Interface Updates

**File: `IOrderCreation.sol`**
```solidity
// Keep existing interface (no changes needed)
```

**File: `IMarketOrder.sol` (NEW)**
```solidity
// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";

interface IMarketOrder {
    function createMarketOrder(
        uint256 positionId,
        address collateralToken,
        uint256 amount,
        uint256 pricePerToken,
        uint256 minFillAmount,
        uint256 expiry,
        bool fillOrKill,
        LibDoefinStorage.OrderDirection direction,
        LibDoefinStorage.OrderType orderType,
        LibDoefinStorage.CrossCurrencyConfig memory crossCurrencyConfig
    ) external;
}
```

#### Deployment Script Updates

**File: `scripts/deploy.js`**

Add `MarketOrderFacet` to facet cuts:
```javascript
const facets = [
  "DiamondCutFacet",
  "DiamondLoupeFacet",
  "OwnershipFacet",
  "AccessControlFacet",
  "AdminConfigFacet",
  "ConditionalTokensFacet",
  "ERC1155Facet",
  "ERC1155ReceiverFacet",
  "ConditionManagerFacet",
  "OrderCreationFacet",        // Now handles LIMIT orders only
  "MarketOrderFacet",           // NEW - handles MARKET orders
  "OrderManagementFacet",
  "ExchangeViewFacet",
  "MarketDataFacet",
  "MarketExecutionFacet",
  "RouteSimulationFacet",
  "OracleManagerFacet"
];
```

#### Testing Changes

**Update all tests that call `createOrder` for market orders:**

```javascript
// OLD
await diamond.createOrder(
    positionId,
    collateralToken,
    amount,
    price,
    minFill,
    expiry,
    false,
    direction,
    ExecutionType.Market, // Market order
    orderType,
    crossCurrencyConfig
);

// NEW
await diamond.createMarketOrder(
    positionId,
    collateralToken,
    amount,
    price,
    minFill,
    expiry,
    false,
    direction,
    orderType,
    crossCurrencyConfig
);
```

**Files to update:**
- `test/integration/*.test.js`
- `test/unit/*.test.js`
- `scripts/admin-scripts/*.js`

---

### Phase 2: Create Helper Libraries (HIGH PRIORITY - 1 day)
**Goal:** Extract duplicated cross-currency and collateral logic  
**Expected Savings:** 6-8 KB  
**Priority:** HIGH

#### Step 2.1: Create `LibCrossCurrencyHelper.sol`

**File: `contracts/libraries/LibCrossCurrencyHelper.sol`**
```solidity
// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {LibQuoteCurrency} from "./LibQuoteCurrency.sol";
import {Errors} from "./Errors.sol";

/**
 * @title LibCrossCurrencyHelper
 * @notice Consolidated helper functions for cross-currency order operations
 * @dev Reduces code duplication across LibOrderbook, LibEscrowLogic, LibMatchEngine, LibSettlement
 */
library LibCrossCurrencyHelper {
    
    /**
     * @notice Get validated exchange rate for an order
     * @param order The order to get exchange rate for
     * @return rate The exchange rate (1e18 scaled)
     * @dev Automatically handles Dynamic vs Fixed exchange rates
     *      Validates staleness and non-zero rate
     *      Reverts if oracle data is stale or rate is invalid
     */
    function getValidatedExchangeRate(
        LibDoefinStorage.Order memory order
    ) internal view returns (uint256 rate) {
        // For non-cross-currency orders, return 1:1 rate
        if (order.orderType != LibDoefinStorage.OrderType.CrossCurrency) {
            return 1e18;
        }

        // Dynamic rate: fetch from oracle
        if (order.crossCurrencyConfig.exchangeRateType == LibDoefinStorage.ExchangeRateType.Dynamic) {
            (uint256 exchangeRate, bool isStale) = LibQuoteCurrency.getOracleExchangeRate(
                order.crossCurrencyConfig.quoteCurrencyToken,
                order.collateralToken
            );
            
            if (isStale) {
                revert Errors.OraclePriceStale();
            }
            if (exchangeRate == 0) {
                revert Errors.InvalidExchangeRate();
            }
            
            return exchangeRate;
        }
        
        // Fixed rate: use configured rate
        uint256 fixedRate = order.crossCurrencyConfig.exchangeRate;
        if (fixedRate == 0) {
            revert Errors.InvalidExchangeRate();
        }
        
        return fixedRate;
    }

    /**
     * @notice Get effective price for an order (handles cross-currency conversion)
     * @param order The order to get price for
     * @return price The effective price (quote currency if cross-currency, else collateral)
     * @return isStale Whether the price calculation used stale oracle data
     * @dev Used in order matching and sorting logic
     */
    function getEffectivePrice(
        LibDoefinStorage.Order memory order
    ) internal view returns (uint256 price, bool isStale) {
        // Standard orders: return collateral price directly
        if (order.orderType != LibDoefinStorage.OrderType.CrossCurrency) {
            return (order.pricePerToken, false);
        }
        
        // Cross-currency orders: calculate quote currency price
        bool useOracleRate = (order.crossCurrencyConfig.exchangeRateType == LibDoefinStorage.ExchangeRateType.Dynamic);
        return LibQuoteCurrency.calculateQuoteCurrencyPrice(order, useOracleRate);
    }

    /**
     * @notice Calculate quote amount from collateral value
     * @param collateralValue The collateral value to convert
     * @param exchangeRate The exchange rate (1e18 scaled)
     * @return quoteAmount The calculated quote amount
     * @dev Standard formula: quoteAmount = (collateralValue × exchangeRate) ÷ 1e18
     */
    function calculateQuoteAmount(
        uint256 collateralValue,
        uint256 exchangeRate
    ) internal pure returns (uint256 quoteAmount) {
        return (collateralValue * exchangeRate) / 1e18;
    }

    /**
     * @notice Check if an order is cross-currency
     * @param order The order to check
     * @return isCrossCurrency True if cross-currency order
     */
    function isCrossCurrency(
        LibDoefinStorage.Order memory order
    ) internal pure returns (bool) {
        return order.orderType == LibDoefinStorage.OrderType.CrossCurrency;
    }

    /**
     * @notice Check if an order uses dynamic exchange rate
     * @param order The order to check
     * @return isDynamic True if using dynamic (oracle) exchange rate
     */
    function usesDynamicRate(
        LibDoefinStorage.Order memory order
    ) internal pure returns (bool) {
        return isCrossCurrency(order) && 
               order.crossCurrencyConfig.exchangeRateType == LibDoefinStorage.ExchangeRateType.Dynamic;
    }
}
```

#### Step 2.2: Create `LibCollateralCalculations.sol`

**File: `contracts/libraries/LibCollateralCalculations.sol`**
```solidity
// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {LibCrossCurrencyHelper} from "./LibCrossCurrencyHelper.sol";

/**
 * @title LibCollateralCalculations
 * @notice Consolidated collateral calculation logic
 * @dev Reduces duplication between LibEscrowLogic, LibCollateralManager, LibTradeSettlement
 */
library LibCollateralCalculations {
    
    /**
     * @notice Result structure for collateral calculations
     */
    struct CollateralResult {
        uint256 baseAmount;      // Base collateral/quote amount
        uint256 fee;             // Fee amount
        uint256 total;           // Total = baseAmount + fee
    }

    /**
     * @notice Calculate ERC20 collateral requirements for standard order
     * @param amount The position token amount
     * @param pricePerToken The price per token
     * @param unitPerPair The collateral unit per pair
     * @param feeBps The fee in basis points
     * @return result Calculated amounts
     * @dev Formula:
     *      baseAmount = (amount × pricePerToken) ÷ unitPerPair
     *      fee = (baseAmount × feeBps) ÷ 10,000
     *      total = baseAmount + fee
     */
    function calculateERC20Required(
        uint256 amount,
        uint256 pricePerToken,
        uint256 unitPerPair,
        uint256 feeBps
    ) internal pure returns (CollateralResult memory result) {
        result.baseAmount = (amount * pricePerToken) / unitPerPair;
        result.fee = (result.baseAmount * feeBps) / 10_000;
        result.total = result.baseAmount + result.fee;
    }

    /**
     * @notice Calculate cross-currency collateral requirements
     * @param order The cross-currency order
     * @param amount The position token amount
     * @return result Calculated amounts in quote currency
     * @dev Process:
     *      1. Calculate collateral value: (amount × pricePerToken) ÷ collateralUnitPerPair
     *      2. Get validated exchange rate (Dynamic or Fixed)
     *      3. Convert to quote currency: (collateralValue × exchangeRate) ÷ 1e18
     *      4. Calculate fee and total
     */
    function calculateCrossCurrencyRequired(
        LibDoefinStorage.Order memory order,
        uint256 amount
    ) internal view returns (CollateralResult memory result) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        
        // Get unit per pair values
        uint256 collateralUnitPerPair = ds.adminConfigStorage.unitPerPair[order.collateralToken];
        
        // Calculate collateral value
        uint256 collateralValue = (amount * order.pricePerToken) / collateralUnitPerPair;
        
        // Get validated exchange rate
        uint256 exchangeRate = LibCrossCurrencyHelper.getValidatedExchangeRate(order);
        
        // Convert to quote currency
        result.baseAmount = LibCrossCurrencyHelper.calculateQuoteAmount(collateralValue, exchangeRate);
        
        // Calculate fee
        result.fee = (result.baseAmount * order.orderFeeConfig.makerFeeBps) / 10_000;
        result.total = result.baseAmount + result.fee;
    }

    /**
     * @notice Calculate collateral requirements (auto-detects order type)
     * @param order The order to calculate for
     * @param amount The position token amount
     * @param feeBps The fee in basis points (ignored for cross-currency)
     * @return result Calculated amounts
     */
    function calculateCollateralRequired(
        LibDoefinStorage.Order memory order,
        uint256 amount,
        uint256 feeBps
    ) internal view returns (CollateralResult memory result) {
        if (LibCrossCurrencyHelper.isCrossCurrency(order)) {
            return calculateCrossCurrencyRequired(order, amount);
        } else {
            LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
            uint256 unitPerPair = ds.adminConfigStorage.unitPerPair[order.collateralToken];
            return calculateERC20Required(amount, order.pricePerToken, unitPerPair, feeBps);
        }
    }
}
```

#### Step 2.3: Update Existing Libraries to Use Helpers

**Refactor `LibEscrowLogic.sol` - lockCollateral function**

Replace lines 34-55 with:
```solidity
function lockCollateral(LibDoefinStorage.Order memory order) internal {
    if (order.direction == LibDoefinStorage.OrderDirection.Buy) {
        if (LibCrossCurrencyHelper.isCrossCurrency(order)) {
            // Cross-currency: lock quote currency
            address quoteCurrency = order.crossCurrencyConfig.quoteCurrencyToken;
            LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
            uint256 quoteUnitPerPair = ds.adminConfigStorage.unitPerPair[quoteCurrency];

            // Use helper to calculate required amounts
            LibCollateralCalculations.CollateralResult memory calc = 
                LibCollateralCalculations.calculateCrossCurrencyRequired(order, order.amount);

            LibCollateralManager.lockERC20Collateral(
                order.maker,
                quoteCurrency,
                calc.total,
                quoteUnitPerPair,
                0 // Fee already included in calc.total
            );
        } else {
            // Standard: lock collateral token
            LibCollateralManager.lockERC20Collateral(
                order.maker,
                order.collateralToken,
                order.amount,
                order.pricePerToken,
                order.orderFeeConfig.makerFeeBps
            );
        }
    } else {
        // Sell orders: lock position tokens
        LibCollateralManager.lockERC1155Collateral(
            order.maker,
            order.positionId,
            order.amount
        );
    }
}
```

**Refactor `LibEscrowLogic.sol` - releaseCollateral function**

Replace lines 84-105 with similar pattern using helpers.

**Refactor `LibOrderbook.sol` - _insertSorted function**

Replace lines 260-290 with:
```solidity
function _insertSorted(LibDoefinStorage.Order memory order) internal {
    LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
    uint256[] storage book = order.direction == LibDoefinStorage.OrderDirection.Buy
        ? ds.orderbookStorage.buyOrdersByPosition[order.positionId]
        : ds.orderbookStorage.sellOrdersByPosition[order.positionId];

    // Get effective price ONCE using helper
    (uint256 price, bool isStale) = LibCrossCurrencyHelper.getEffectivePrice(order);
    if (isStale) revert Errors.OraclePriceStale();

    // Binary search for insertion point
    uint256 left = 0;
    uint256 right = book.length;

    while (left < right) {
        uint256 mid = (left + right) / 2;
        LibDoefinStorage.Order storage existingOrder = ds.orderbookStorage.orders[book[mid]];
        
        // Get existing order price using helper
        (uint256 existingPrice, bool existingIsStale) = LibCrossCurrencyHelper.getEffectivePrice(existingOrder);
        if (existingIsStale) revert Errors.OraclePriceStale();

        // Compare prices with time priority
        bool shouldInsertBefore = _shouldInsertBefore(
            price,
            existingPrice,
            order.createdAt,
            existingOrder.createdAt,
            order.direction
        );

        if (shouldInsertBefore) {
            right = mid;
        } else {
            left = mid + 1;
        }
    }

    // Insert at position left
    book.push(order.orderId);
    for (uint256 j = book.length - 1; j > left; j--) {
        book[j] = book[j - 1];
    }
    book[left] = order.orderId;
}

// Extract comparison logic to separate function
function _shouldInsertBefore(
    uint256 price,
    uint256 existingPrice,
    uint256 createdAt,
    uint256 existingCreatedAt,
    LibDoefinStorage.OrderDirection direction
) private pure returns (bool) {
    if (price == existingPrice) {
        // Price-time priority: earlier orders come first
        return createdAt >= existingCreatedAt;
    }
    
    // Price priority
    if (direction == LibDoefinStorage.OrderDirection.Sell) {
        return price < existingPrice; // Ascending for sell
    } else {
        return price > existingPrice; // Descending for buy
    }
}
```

**Similar refactorings needed in:**
- `LibMatchEngine.sol` (lines 104-110, 370-415)
- `LibSettlement.sol` (lines 418-423)
- `LibTradeSettlement.sol` (lines 556-557, 639-640)

---

### Phase 3: Consolidate Validation Logic (MEDIUM PRIORITY - 2-3 days)
**Goal:** Create centralized validation functions  
**Expected Savings:** 1-2 KB  
**Priority:** MEDIUM

#### Create `LibOrderValidation.sol`

**File: `contracts/libraries/LibOrderValidation.sol`**
```solidity
// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {LibQuoteCurrency} from "./LibQuoteCurrency.sol";
import {LibCrossCurrencyHelper} from "./LibCrossCurrencyHelper.sol";
import {Errors} from "./Errors.sol";

/**
 * @title LibOrderValidation
 * @notice Consolidated order validation logic
 * @dev Reduces duplication across LibOrderbook, LibQuoteCurrency, LibSettlement
 */
library LibOrderValidation {
    
    /**
     * @notice Validate basic order parameters
     * @param amount Order amount
     * @param pricePerToken Price per token
     * @param minFillAmount Minimum fill amount
     * @param expiry Expiry timestamp
     * @param unitsPerPair Units per pair for collateral
     */
    function validateBasicParams(
        uint256 amount,
        uint256 pricePerToken,
        uint256 minFillAmount,
        uint256 expiry,
        uint256 unitsPerPair
    ) internal view {
        if (unitsPerPair == 0) {
            revert Errors.TokenNotAllowed();
        }
        if (pricePerToken >= unitsPerPair || pricePerToken == 0) {
            revert Errors.InvalidPrice();
        }
        if (amount < minFillAmount || amount == 0) {
            revert Errors.InvalidAmounts();
        }
        if (expiry != 0 && expiry <= block.timestamp) {
            revert Errors.OrderCreatedWithPastExpiry();
        }
    }

    /**
     * @notice Validate cross-currency order configuration
     * @param order The order to validate
     * @dev Performs ALL cross-currency validations in one place:
     *      - Quote currency token is valid and allowed
     *      - Quote currency differs from collateral
     *      - Exchange rate is valid
     *      - Buy orders use Fixed rate
     *      - Dynamic rate orders have valid oracle data
     */
    function validateCrossCurrency(
        LibDoefinStorage.Order memory order
    ) internal view {
        // Skip if not cross-currency
        if (!LibCrossCurrencyHelper.isCrossCurrency(order)) {
            // Validate no cross-currency config is present
            if (order.crossCurrencyConfig.quoteCurrencyToken != address(0) ||
                order.crossCurrencyConfig.exchangeRate != 0 ||
                uint8(order.crossCurrencyConfig.exchangeRateType) != 0) {
                revert Errors.UnexpectedCrossCurrencyConfig();
            }
            return;
        }

        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        // Validate quote currency token
        if (order.crossCurrencyConfig.quoteCurrencyToken == address(0)) {
            revert Errors.InvalidQuoteCurrencyToken();
        }
        
        uint256 quoteUnitPerPair = ds.adminConfigStorage.unitPerPair[order.crossCurrencyConfig.quoteCurrencyToken];
        if (quoteUnitPerPair == 0) {
            revert Errors.TokenNotAllowed();
        }

        // Validate quote differs from collateral
        if (order.crossCurrencyConfig.quoteCurrencyToken == order.collateralToken) {
            revert Errors.SameCollateralAndQuoteCurrency();
        }

        // Validate exchange rate
        if (order.crossCurrencyConfig.exchangeRate == 0) {
            revert Errors.InvalidExchangeRate();
        }

        // Buy orders must use Fixed exchange rate
        if (order.direction == LibDoefinStorage.OrderDirection.Buy &&
            order.crossCurrencyConfig.exchangeRateType != LibDoefinStorage.ExchangeRateType.Fixed) {
            revert Errors.BuyOrdersMustUseFixedRate();
        }

        // Validate oracle for dynamic rates
        if (LibCrossCurrencyHelper.usesDynamicRate(order)) {
            (uint256 exchangeRate, bool isStale) = LibQuoteCurrency.getOracleExchangeRate(
                order.crossCurrencyConfig.quoteCurrencyToken,
                order.collateralToken
            );
            if (isStale) {
                revert Errors.OraclePriceStale();
            }
            if (exchangeRate == 0) {
                revert Errors.InvalidExchangeRate();
            }
        }
    }

    /**
     * @notice Validate order for creation
     * @param order The order to validate
     * @param unitsPerPair Units per pair for collateral token
     * @dev Combines basic and cross-currency validation
     */
    function validateOrderCreation(
        LibDoefinStorage.Order memory order,
        uint256 unitsPerPair
    ) internal view {
        validateBasicParams(
            order.amount,
            order.pricePerToken,
            order.minFillAmount,
            order.expiry,
            unitsPerPair
        );
        
        validateCrossCurrency(order);
    }
}
```

#### Update `LibOrderbook.createOrderWithoutMatching`

Replace validation logic (lines 30-90) with:
```solidity
function createOrderWithoutMatching(
    uint256 positionId,
    address collateralToken,
    uint256 amount,
    uint256 pricePerToken,
    uint256 minFillAmount,
    uint256 expiry,
    bool fillOrKill,
    LibDoefinStorage.OrderDirection direction,
    LibDoefinStorage.ExecutionType executionType,
    LibDoefinStorage.OrderType orderType,
    LibDoefinStorage.CrossCurrencyConfig memory crossCurrencyConfig
) internal returns (uint256 orderId) {
    LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
    uint256 unitsPerPair = ds.adminConfigStorage.unitPerPair[collateralToken];

    // Generate order ID
    orderId = ds.orderbookStorage.nextOrderId++;

    // Get market fees
    LibDoefinStorage.OrderFeeConfig memory orderFeeConfig = LibEscrowLogic.getMarketFees();

    // Build order struct
    LibDoefinStorage.Order memory order = LibDoefinStorage.Order({
        orderId: orderId,
        maker: msg.sender,
        positionId: positionId,
        collateralToken: collateralToken,
        amount: amount,
        remainingAmount: amount,
        minFillAmount: minFillAmount,
        pricePerToken: pricePerToken,
        expiry: expiry,
        createdAt: block.timestamp,
        orderType: orderType,
        orderFeeConfig: orderFeeConfig,
        crossCurrencyConfig: crossCurrencyConfig,
        direction: direction,
        executionType: executionType,
        active: true,
        fillOrKill: fillOrKill
    });

    // Consolidated validation
    LibOrderValidation.validateOrderCreation(order, unitsPerPair);

    // Lock collateral for limit orders
    if (order.executionType == LibDoefinStorage.ExecutionType.Limit) {
        LibEscrowLogic.lockCollateral(order);
    }

    // Store order
    ds.orderbookStorage.orders[orderId] = order;
    if (order.executionType == LibDoefinStorage.ExecutionType.Limit) {
        _insertSorted(order);
    }

    // Emit event
    emit Events.OrderCreated(
        orderId,
        msg.sender,
        positionId,
        collateralToken,
        amount,
        pricePerToken,
        minFillAmount,
        expiry,
        direction,
        executionType,
        fillOrKill,
        orderFeeConfig.makerFeeBps,
        orderFeeConfig.takerFeeBps,
        orderType,
        crossCurrencyConfig.quoteCurrencyToken,
        crossCurrencyConfig.exchangeRateType,
        crossCurrencyConfig.exchangeRate
    );

    return orderId;
}
```

---

### Phase 4: Remove Redundant Checks (LOW PRIORITY - 1 day)
**Goal:** Eliminate repeated type checking  
**Expected Savings:** ~2 KB  
**Priority:** LOW

#### Pattern to Remove

Throughout the codebase, replace:
```solidity
if (order.orderType == LibDoefinStorage.OrderType.CrossCurrency) {
    // do something
}
```

With helper function calls:
```solidity
if (LibCrossCurrencyHelper.isCrossCurrency(order)) {
    // do something
}
```

**Benefit:** Reduces bytecode duplication and improves readability.

**Files to update:**
- `LibEscrowLogic.sol`
- `LibTradeSettlement.sol`
- `LibSettlement.sol`
- `LibMatchEngine.sol`

---

## Size Reduction Estimates

| Phase | Action | Estimated Savings | Cumulative Size |
|-------|--------|------------------|-----------------|
| **Start** | - | - | **24.98 KB** |
| **Phase 1** | Split OrderCreationFacet | 5-8 KB | **17-20 KB** ✅ |
| **Phase 2** | Helper libraries | 6-8 KB | **9-14 KB** ✅ |
| **Phase 3** | Validation consolidation | 1-2 KB | **7-13 KB** ✅ |
| **Phase 4** | Remove redundant checks | 1-2 KB | **5-12 KB** ✅ |

**Final Target: 10-12 KB (well below 24 KB limit)**

---

## Implementation Checklist

### Phase 1: Facet Split ⚡
- [ ] Create `MarketOrderFacet.sol`
- [ ] Create `IMarketOrder.sol` interface
- [ ] Rename `LibOrderbook.createOrder` → `createOrderWithoutMatching`
- [ ] Remove `_tryFillImmediately` call from order creation
- [ ] Make `_tryFillImmediately` → `tryFillOrder` (callable by MarketOrderFacet)
- [ ] Update `OrderCreationFacet.sol` to reject market orders
- [ ] Update deployment script with new facet
- [ ] Update all tests using market orders
- [ ] Run test suite
- [ ] Compile and verify size reduction

### Phase 2: Helper Libraries
- [ ] Create `LibCrossCurrencyHelper.sol`
- [ ] Create `LibCollateralCalculations.sol`
- [ ] Refactor `LibEscrowLogic.lockCollateral`
- [ ] Refactor `LibEscrowLogic.releaseCollateral`
- [ ] Refactor `LibOrderbook._insertSorted`
- [ ] Refactor `LibMatchEngine` functions
- [ ] Refactor `LibSettlement` functions
- [ ] Refactor `LibTradeSettlement` functions
- [ ] Run test suite
- [ ] Compile and verify size reduction

### Phase 3: Validation Consolidation
- [ ] Create `LibOrderValidation.sol`
- [ ] Refactor `LibOrderbook` validation
- [ ] Refactor `LibQuoteCurrency` validation
- [ ] Remove duplicated validation from other libraries
- [ ] Run test suite
- [ ] Compile and verify size reduction

### Phase 4: Cleanup
- [ ] Replace all `order.orderType == CrossCurrency` with helper calls
- [ ] Remove unused code
- [ ] Optimize remaining functions
- [ ] Final test suite run
- [ ] Final compile and size check

---

## Testing Strategy

### Unit Tests
- [ ] Test `LibCrossCurrencyHelper.getValidatedExchangeRate`
- [ ] Test `LibCrossCurrencyHelper.getEffectivePrice`
- [ ] Test `LibCollateralCalculations.calculateERC20Required`
- [ ] Test `LibCollateralCalculations.calculateCrossCurrencyRequired`
- [ ] Test `LibOrderValidation.validateOrderCreation`
- [ ] Test `OrderCreationFacet.createOrder` (limit orders only)
- [ ] Test `MarketOrderFacet.createMarketOrder`

### Integration Tests
- [ ] Test order creation flow (limit)
- [ ] Test market order execution flow
- [ ] Test cross-currency order creation
- [ ] Test order matching after refactor
- [ ] Test settlement after refactor
- [ ] Verify gas costs haven't increased significantly (<5%)

### Deployment Tests
- [ ] Deploy to local Hardhat network
- [ ] Verify all facets compile under 24 KB
- [ ] Test Diamond proxy functionality
- [ ] Run admin scripts to populate test data
- [ ] Execute integration test scenarios

---

## Gas Cost Considerations

### Expected Gas Changes

**Slight increases expected (~2-5%):**
- Helper library calls add JUMP opcodes
- Function call overhead for validation
- Minimal impact on user experience

**Trade-off justification:**
- Deployment becomes possible on mainnet
- Code maintainability improves significantly
- Reduced duplication lowers audit complexity
- Gas increase is acceptable for deployment capability

### Gas Optimization Tips

1. **Keep helper functions `internal`** - Already done, maintains inlining where beneficial
2. **Use `memory` not `storage` for helper inputs** - Reduces SLOAD operations
3. **Cache storage reads** - Already done in most places
4. **Minimize cross-library calls** - Group related logic together

---

## Important Notes

### Storage Safety
- ✅ All changes maintain existing storage layout
- ✅ New libraries don't introduce storage variables
- ✅ Diamond pattern compatibility preserved
- ✅ No risk of storage collisions

### Backwards Compatibility
- ⚠️ **Breaking change:** Market orders now use different facet
- ✅ Frontend updates required to call `createMarketOrder` instead of `createOrder`
- ✅ Limit orders continue to work with `createOrder`
- ✅ All existing limit orders remain valid

### Deployment Considerations
- New facet (`MarketOrderFacet`) must be added to deployment script
- Diamond upgrade required for existing deployments
- Test thoroughly on testnet before mainnet deployment

---

## Maintenance Guidelines

### Adding New Cross-Currency Logic
1. Always use `LibCrossCurrencyHelper` functions
2. Don't duplicate exchange rate fetching
3. Use `LibCollateralCalculations` for collateral math
4. Add tests for new scenarios

### Code Review Checklist
- [ ] No duplicated cross-currency logic
- [ ] All exchange rate fetches use helper
- [ ] Collateral calculations use helper library
- [ ] Validation uses consolidated functions
- [ ] Tests updated for changes
- [ ] Gas impact measured

---

## Rollback Plan

If issues arise during implementation:

### Phase 1 Rollback
1. Remove `MarketOrderFacet` from deployment
2. Revert `LibOrderbook` changes
3. Restore original `OrderCreationFacet`
4. Revert test changes

### Phase 2/3/4 Rollback
1. Comment out helper library imports
2. Restore original function implementations
3. Keep helper libraries for future use
4. Document issues for resolution

---

## Success Criteria

- ✅ `OrderCreationFacet` size < 24 KB
- ✅ All tests passing
- ✅ Gas cost increase < 5%
- ✅ Diamond deployment successful
- ✅ Integration tests pass
- ✅ Code coverage maintained

---

---

## Additional Facet Optimizations

### Overview of All Large Facets

| Facet | Current Size | Lines of Code | Status | Action Required |
|-------|--------------|---------------|--------|-----------------|
| **OrderCreationFacet** | 24.98 KB | 63 | 🔴 CRITICAL | Phase 1-4 above |
| **MarketExecutionFacet** | 21.60 KB | 48 | ⚠️ HIGH | Apply Phase 2 optimizations |
| **OrderManagementFacet** | 7.87 KB | 45 | ✅ OK | Monitor after changes |
| **ConditionalTokensFacet** | 7.37 KB | 210 | ✅ OK | Potential for reduction |
| **AdminConfigFacet** | 7.27 KB | 245 | ✅ OK | Split if needed |
| **RouteSimulationFacet** | 6.69 KB | 20 | ✅ OK | Perfect (thin wrapper) |
| **OracleManagerFacet** | 6.14 KB | 388 | ⚠️ MONITOR | Inline code, watch growth |

---

### MarketExecutionFacet (21.60 KB) ⚠️

**Current State:**
- Only 48 lines of code but 21.60 KB compiled
- Pulls in entire settlement chain like OrderCreationFacet
- **Will automatically shrink after Phase 2 helper libraries are implemented**

**Dependencies:**
```
MarketExecutionFacet (48 lines)
  └─> LibSettlement (450 lines)
      ├─> LibTradeSettlement (790 lines)
      │   ├─> LibCollateralManager (353 lines)
      │   ├─> LibFeeManager (278 lines)
      │   ├─> LibQuoteCurrency (321 lines)
      │   ├─> LibCTFCondition (189 lines)
      │   └─> LibPositionRegistry (188 lines)
      └─> LibMatchEngine (447 lines)
          └─> LibQuoteCurrency (321 lines - duplicate)
```

**Optimization Strategy:**
1. ✅ **No immediate action needed** - will shrink automatically when Phase 2 helper libraries are implemented
2. After Phase 2, expected size: **13-15 KB** (safe)
3. If still over 20 KB after Phase 2, consider splitting into:
   - `MatchedRouteExecutionFacet` (fillMarketOrderWithRoute)
   - `DirectMatchingFacet` (fillOrders)

**Code Quality:** Excellent - already properly delegating to libraries

---

### OracleManagerFacet (6.14 KB) ⚠️

**Current State:**
- 388 lines of actual implementation code
- Compiles to only 6.14 KB (efficient!)
- **Contains inline logic that could grow**

**Concern:**
Unlike other facets that are thin wrappers, this facet has significant inline implementation:
- Price update logic with adapter failover (lines 150-220)
- EIP-712 signature verification (lines 240-290)
- Emergency update logic

**Optimization Strategy:**

**Option 1: Extract to Library (Recommended)**
Create `LibOracleManager.sol` and move logic:

```solidity
// contracts/libraries/LibOracleManager.sol
library LibOracleManager {
    /**
     * @notice Update price with automatic failover
     */
    function updatePriceWithFailover(
        bytes32 assetId,
        bytes32[] memory adapterPriority
    ) internal returns (uint256 price, uint256 timestamp) {
        // Move lines 150-220 here
        // ...
    }

    /**
     * @notice Verify EIP-712 signature
     */
    function verifyPriceSignature(
        bytes32 assetId,
        uint256 price,
        uint256 timestamp,
        bytes32 nonce,
        bytes memory signature
    ) internal view returns (bool) {
        // Move signature verification logic here
        // ...
    }
}
```

Then `OracleManagerFacet` becomes:
```solidity
function updatePrice(bytes32 assetId) external override {
    LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
    bytes32[] memory adapterPriority = ds.oracleStorage.assetConfigs[assetId].adapterPriority;
    
    (uint256 price, uint256 timestamp) = LibOracleManager.updatePriceWithFailover(assetId, adapterPriority);
    
    // Store and emit...
}
```

**Estimated Savings:** 1-2 KB  
**Priority:** LOW (current size is acceptable, but prevents future growth)

---

### AdminConfigFacet (7.27 KB)

**Current State:**
- 245 lines of mostly simple setters/getters
- Compiles to 7.27 KB
- Relatively efficient given line count

**Optimization Opportunities:**

**1. Split into Two Facets (If Growth Expected)**
```solidity
// AdminConfigFacet - Core token/fee management
- addCollateralToken
- removeCollateralToken
- setFeeReceiver
- setTradingFeesBps
- setResolutionFeeBps

// AdminConfigViewFacet - Read-only queries
- isAllowedCollateral
- getCollateralUnit
- getFees
- getMarketMakerStatus
- etc.
```

**2. Extract Cross-Currency Configuration**
If cross-currency conversion paths grow complex:
```solidity
// AdminCrossCurrencyConfigFacet - NEW
- configureCrossCurrencyPath
- getCrossCurrencyPath
- validateCrossCurrencyPair
```

**Estimated Savings:** 2-3 KB if split  
**Priority:** LOW (current size acceptable)

---

### ConditionalTokensFacet (7.37 KB)

**Current State:**
- 210 lines implementing CTF operations
- Compiles to 7.37 KB
- Pulls in large dependencies (LibCTFCondition, LibERC1155)

**Optimization Strategy:**

**1. Already Well-Structured** ✅
- Properly delegates to `LibCTFCondition`
- Minimal inline logic

**2. Potential Savings from Phase 2**
After helper libraries are created, refactor CTF libraries to use:
- `LibCrossCurrencyHelper` for any cross-currency position operations
- `LibCollateralCalculations` for split/merge cost calculations

**3. Monitor After Phase 2**
- Expected to shrink slightly (0.5-1 KB) from shared helper usage
- Should remain well under 10 KB

**Priority:** LOW (already efficient)

---

### RouteSimulationFacet (6.69 KB) ⭐

**Current State:**
- Only 20 lines of code!
- Perfect thin wrapper pattern
- Compiles to 6.69 KB because it pulls in LibMatchEngine (447 lines)

**Analysis:**
This is **architecturally perfect** - demonstrates why the facet pattern works:
- Minimal code in facet
- All logic in library
- Size is appropriate for functionality

**Optimization:**
- ✅ No optimization needed
- Will automatically shrink 1-2 KB after Phase 2 (LibMatchEngine uses LibQuoteCurrency helpers)
- **Use this as reference for other facets**

---

### OrderManagementFacet (7.87 KB)

**Current State:**
- Only 45 lines (thin wrapper)
- Compiles to 7.87 KB
- Delegates to LibOrderbook

**Optimization:**
- ✅ Already optimal structure
- Will automatically shrink 2-3 KB after Phase 2 (LibOrderbook refactoring)
- **No action needed**

---

## Global Optimization: Shared Helper Impact

After implementing Phase 2 helper libraries, **ALL facets that use order/collateral logic will shrink:**

| Facet | Current | After Phase 2 | Savings |
|-------|---------|---------------|---------|
| OrderCreationFacet | 24.98 KB | 9-14 KB | ~10-15 KB |
| MarketExecutionFacet | 21.60 KB | 13-15 KB | ~6-8 KB |
| OrderManagementFacet | 7.87 KB | 5-6 KB | ~1-2 KB |
| RouteSimulationFacet | 6.69 KB | 5-6 KB | ~0.5-1 KB |
| **Total Reduction** | | | **~18-26 KB** |

**Key Insight:** The helper libraries eliminate duplication across **multiple facets simultaneously**, not just OrderCreationFacet!

---

## Priority Recommendations

### Immediate (Phase 1)
1. ✅ Split OrderCreationFacet → market vs limit orders
2. ✅ This alone gets you deployable on mainnet

### High Priority (Phase 2)
1. ✅ Create LibCrossCurrencyHelper
2. ✅ Create LibCollateralCalculations
3. ✅ Benefits **4 facets simultaneously**

### Medium Priority (Phase 3)
1. Create LibOrderValidation
2. Monitor OracleManagerFacet growth

### Low Priority (Phase 4)
1. Consider splitting AdminConfigFacet if it grows
2. Extract OracleManagerFacet inline logic to library
3. Optimize remaining small patterns

---

## Long-Term Architecture Guidelines

### ✅ Good Patterns (Keep Doing This)
- **RouteSimulationFacet:** 20-line thin wrapper
- **MarketExecutionFacet:** Delegates everything to libraries
- **OrderManagementFacet:** No inline logic, pure delegation

### ⚠️ Patterns to Avoid
- **OracleManagerFacet:** 388 lines of inline code (works now, but risky)
- Duplicating logic across multiple libraries
- Large inline implementations in facets

### 🎯 Target Architecture
```
Facet (thin wrapper, <100 lines)
  ↓
Library (business logic, reusable)
  ↓
Helper Libraries (shared utilities)
  ↓
Storage (LibDoefinStorage)
```

**Facet Responsibility:** Input validation, access control, event emission, delegation  
**Library Responsibility:** Business logic, calculations, state changes  
**Helper Responsibility:** Shared calculations, type checking, conversions

---

## Size Monitoring Strategy

### Set Up Size Alerts

Add to your CI/CD pipeline:
```javascript
// hardhat.config.js
contractSizer: {
  alphaSort: true,
  runOnCompile: true,
  disambiguatePaths: false,
  strict: true, // NEW: Fail if over limit
  only: [':.*Facet$'], // Only check facets
}

// Add size check script
// scripts/check-contract-sizes.js
const maxSize = 24 * 1024; // 24 KB

artifacts.forEach(artifact => {
  if (artifact.deployedBytecode.length / 2 > maxSize) {
    console.error(`❌ ${artifact.name} exceeds 24 KB`);
    process.exit(1);
  }
});
```

### Monthly Size Review Checklist

- [ ] Run `npx hardhat size-contracts`
- [ ] Check if any facet > 20 KB (warning threshold)
- [ ] Review added libraries for duplication
- [ ] Verify helper libraries are being used
- [ ] Update this guide with new patterns

---

## References

### Related Files
- `contracts/facets/OrderCreationFacet.sol`
- `contracts/facets/MarketExecutionFacet.sol`
- `contracts/facets/OrderManagementFacet.sol`
- `contracts/facets/OracleManagerFacet.sol`
- `contracts/libraries/LibOrderbook.sol`
- `contracts/libraries/LibEscrowLogic.sol`
- `contracts/libraries/LibMatchEngine.sol`
- `contracts/libraries/LibSettlement.sol`
- `contracts/libraries/LibTradeSettlement.sol`
- `contracts/libraries/LibQuoteCurrency.sol`
- `contracts/libraries/LibCollateralManager.sol`

### Documentation
- EIP-2535 Diamond Standard: https://eips.ethereum.org/EIPS/eip-2535
- Solidity Contract Size Limits: https://docs.soliditylang.org/en/latest/contracts.html#contract-size
- Optimizer Settings: https://docs.soliditylang.org/en/latest/using-the-compiler.html#optimizer-options

---

## Appendix: Quick Reference

### When to Split a Facet

Split when:
- ✅ Size > 24 KB (required for deployment)
- ✅ Size > 20 KB (proactive, leaves headroom)
- ✅ Facet handles distinctly different operations (market vs limit orders)
- ✅ Functions have different access control requirements

Don't split when:
- ❌ Size < 15 KB (unnecessary complexity)
- ❌ Functions are tightly coupled
- ❌ Would create circular dependencies
- ❌ Loss of cohesion

### When to Create a Helper Library

Create helper when:
- ✅ Same calculation appears 3+ times
- ✅ Pattern appears across multiple libraries
- ✅ Logic is >20 lines and repeated
- ✅ Can reduce total codebase size >500 bytes

Don't create helper when:
- ❌ Used in only one place
- ❌ Logic is <10 lines
- ❌ Adds more overhead than it saves
- ❌ Makes code harder to understand

---

**Document Version:** 1.1  
**Last Updated:** November 27, 2025  
**Status:** Ready for Implementation  
**Changes:** Added comprehensive analysis of all large facets and long-term architecture guidelines
