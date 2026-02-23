# Orderbook Refactoring - Complete Design Clarifications

*This document captures ALL design principles, requirements, and clarifications from the complete conversation*

## Original Requirements & Vision

### Primary Objective
**"Refactor the orderbook framework to split orderbook based on the type of token used for trading"**

### Secondary Objective  
**"Support richer features for cross currency orders and matching"**

### User's Initial Implementation
- **From**: Position/direction-based books (`buyOrdersByPosition[positionId]`, `sellOrdersByPosition[positionId]`)
- **To**: Currency-based books using `buyOrdersByPositionAndCurrency[bookId]` where `bookId = keccak256(abi.encodePacked(positionId, pricingCurrency))`
- **Goal**: Enable flexible cross-currency trading and eliminate stale price issues

## Core Architecture Decisions

### Storage Strategy
- **Critical Rule**: All oracle storage MUST be added to existing `LibDoefinStorage.AppStorage` 
- **Never**: Create separate storage libraries (prevents storage corruption)
- **Approach**: Extend existing `OrderbookStorageStruct` with new currency-based mappings

### Order Type System
```solidity
enum OrderType {
    Standard,  // Priced in collateral token (e.g., BTC orders priced in BTC)
    Fixed,     // Cross-currency with predetermined exchange rate
    Dynamic    // Cross-currency with oracle rate + floor rate constraints
}
```

### Match Type Simplification
**User's Decision**: Simplify from 9 complex values to 5 essential values:
```solidity
enum MatchType {
    None,           // No match possible
    Complementary,  // Same position, opposite direction (standard matching)
    Mint,           // Buy complement position (split collateral into YES+NO)
    Merge,          // Sell complement position (merge YES+NO back to collateral)
    CrossCurrency   // Different currency books matching
}
```

### Book Retrieval Logic
**Key Design Principle**: "retrieveTheBooksAndMatchType() should handle both standard and cross-currency cases with unified approach"

#### Standard Orders:
- **Complementary book**: Same position, opposite direction, same currency
- **Sibling book**: Complement position for mint/merge operations

#### Cross-Currency Orders:
- **Complementary book**: Same position, opposite direction, filtered for cross-currency
- **Quote book**: Same position, quote currency book for cross-currency matching

## Cross-Currency Design Specifications

### Order Filtering Rules
**User Requirement**: "Cross-currency takers should only match with cross-currency makers"
**Implementation**: Enhanced filtering in `_findCrossingOrderIds()` to separate Standard vs Cross-currency orders

### Oracle Integration
**Dynamic Orders**: Must validate oracle staleness before matching
**Floor Rate Validation**: For Dynamic orders, check current rate against floor constraints:
- Buy orders: `currentRate >= floorRate` (floor is minimum acceptable)
- Sell orders: `currentRate <= floorRate` (floor is maximum acceptable)

### Cross-Currency Compatibility
**User Specification**: Orders must have compatible quote currencies to match
**Implementation**: `_areOrdersCompatibleForCrossCurrency()` function using `LibQuoteCurrency.areOrdersCompatible()`

## Pricing Logic Clarifications

### Current Implementation Analysis (January 6, 2026)
**Key Insight**: "If matchType is CrossCurrency then the order is not standard, right?"
**Implication**: The condition `if (makerOrderType != LibDoefinStorage.OrderType.Standard || matchType == LibDoefinStorage.MatchType.CrossCurrency)` may be redundant

### Fixed Order Rate Mechanism
**Critical Clarification**: "I never told you to use floor rate if its fixed, right?"
**Status**: Fixed orders should NOT use `crossCurrencyData.floorRate` - this was a previous version assumption
**Needs Decision**: What mechanism do Fixed orders use for exchange rates?

### Maker-Centric Pricing
**Current Behavior**: `bool useOracleRate = (makerOrderType == LibDoefinStorage.OrderType.Dynamic)`
**Analysis**: Effective price follows maker's order type, not taker's
**Open Question**: Should both maker and taker order types influence final pricing?

### Cross-Currency Scenarios (BTC Collateral + USDT Quote)
1. **Fixed + Fixed**: Uses maker's rate mechanism (TBD)
2. **Fixed Maker + Dynamic Taker**: Uses maker's rate, ignores oracle
3. **Dynamic + Dynamic**: Uses current oracle rate  
4. **Dynamic Maker + Fixed Taker**: Uses current oracle rate, not taker's rate

## Code Cleanup & Legacy Issues

### Redundant Function Removal
**User Guidance**: "Some of the existing logic belongs to the previous version and you have to mind it"
**Completed Cleanup**:
- ✅ Removed `simulateCrossCurrencyMarketOrder()`
- ✅ Removed `_filterCrossCurrencyCompatibleOrders()`
- ✅ Removed `calculateQuoteCurrencyWithRespectToMatchType()`
- ✅ Consolidated `_effectiveTakerPriceCrossCurrency()` into `effectiveTakerPrice()`

### Function Consolidation Philosophy
**User Feedback**: "If we need it just keep the method, no need to remove it"
**Lesson**: Don't inline functions unless clearly redundant - maintain modularity for readability

## Implementation Status

### ✅ Completed
- Currency-based orderbook storage structure
- MatchType enum simplification  
- Unified book retrieval logic in `retrieveTheBooksAndMatchType()`
- Standard vs Cross-currency order filtering
- Oracle staleness validation
- Floor rate constraint checking
- Legacy code cleanup

### 🔄 Needs Further Work
- Fixed order exchange rate mechanism design
- Cross-currency pricing logic refinement
- RouteSimulationFacet cross-currency implementation  
- Systematic removal of remaining legacy logic
- Testing and validation framework

### ❓ Open Design Questions
1. **Fixed Order Rates**: What's the exact mechanism for Fixed order exchange rates?
2. **Bi-directional Pricing**: Should both maker and taker order types influence final price?
3. **Condition Redundancy**: Should the OR condition be simplified based on CrossCurrency match type logic?
4. **Cross-Currency Book Rules**: Exact rules for which orders can match across different currency books?

## Key Technical Insights

### Book ID Generation
```solidity
bytes32 bookId = keccak256(abi.encodePacked(positionId, pricingCurrency));
```

### Pricing Currency Logic
- **Standard/Dynamic**: Priced in collateral token
- **Fixed**: Priced in quote currency

### Match Type Determination
- **Standard orders**: Can do Complementary, Mint, Merge
- **Cross-currency orders**: Only Complementary and CrossCurrency matches

## Next Phase Priorities

1. **Design Decisions**: Finalize Fixed order rate mechanism
2. **Logic Refinement**: Address pricing precedence and condition redundancy  
3. **Implementation**: Complete RouteSimulationFacet cross-currency support
4. **Testing**: Comprehensive validation of all cross-currency scenarios
5. **Documentation**: Update contract documentation to reflect new architecture

---

*This document represents the complete design foundation from the full conversation and should guide all future cross-currency development.*