# Cross-Currency Storage Optimization

**Status**: 📋 Documented for Future Implementation  
**Priority**: Medium (Gas Optimization)  
**Estimated Effort**: 12-18 hours  
**Target Version**: V2.x or Major Upgrade

---

## Executive Summary

This document outlines a storage optimization strategy to reduce gas costs for standard orders by extracting the `CrossCurrencyConfig` struct from the `Order` struct into a separate mapping. Currently, every order (standard and cross-currency) stores 3 storage slots (96 bytes) for cross-currency configuration, even though 95%+ of orders are standard orders that don't use this feature.

**Expected Benefits**:
- **Gas Savings**: ~60,000-80,000 gas saved per standard order creation
- **Storage Efficiency**: 3 fewer storage slots (SSTORE operations) per standard order
- **Cleaner Architecture**: Cross-currency feature becomes truly opt-in at storage level

**Trade-offs**:
- Cross-currency orders pay slightly more gas (1 extra SLOAD per config access)
- High refactoring complexity: 15-20 files, 100+ code locations
- Requires careful storage migration strategy for existing orders

---

## Current Architecture

### Storage Layout (LibDoefinStorage.sol)

```solidity
struct CrossCurrencyConfig {
    address quoteCurrencyToken;      // 20 bytes (1 slot)
    ExchangeRateType exchangeRateType; // 1 byte (shares slot)
    uint256 exchangeRate;             // 32 bytes (1 slot)
}
// Total: 3 storage slots (96 bytes)

struct Order {
    uint256 orderId;
    address maker;
    uint256 positionId;
    address collateralToken;
    uint256 amount;
    uint256 remainingAmount;
    uint256 minFillAmount;
    uint256 pricePerToken;
    uint256 expiry;
    uint256 createdAt;
    OrderType orderType;
    OrderFeeConfig orderFeeConfig;
    CrossCurrencyConfig crossCurrencyConfig;  // ❌ PROBLEM: Always stored, rarely used
    OrderDirection direction;
    ExecutionType executionType;
    bool active;
    bool fillOrKill;
}

struct OrderbookStorageStruct {
    mapping(uint256 => Order) orders;
    uint256 nextOrderId;
    // ... other fields
}
```

### Current Access Pattern

```solidity
// Direct field access (gas-efficient but wastes storage)
LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[orderId];
address quoteCurrency = order.crossCurrencyConfig.quoteCurrencyToken;
uint256 rate = order.crossCurrencyConfig.exchangeRate;
```

### Gas Cost Analysis (Current)

**Standard Order Creation**:
- Order struct write: ~20,000 gas per slot × ~12 slots = ~240,000 gas
- **Wasted CrossCurrencyConfig**: 3 slots × 20,000 gas = **60,000 gas wasted**

**Cross-Currency Order Creation**:
- Order struct write: ~240,000 gas
- CrossCurrencyConfig is used: 60,000 gas justified

---

## Proposed Architecture

### New Storage Layout

```solidity
struct Order {
    uint256 orderId;
    address maker;
    uint256 positionId;
    address collateralToken;
    uint256 amount;
    uint256 remainingAmount;
    uint256 minFillAmount;
    uint256 pricePerToken;
    uint256 expiry;
    uint256 createdAt;
    OrderType orderType;
    OrderFeeConfig orderFeeConfig;
    // ✅ REMOVED: CrossCurrencyConfig crossCurrencyConfig;
    OrderDirection direction;
    ExecutionType executionType;
    bool active;
    bool fillOrKill;
}

struct OrderbookStorageStruct {
    mapping(uint256 => Order) orders;
    mapping(uint256 => CrossCurrencyConfig) crossCurrencyConfigs;  // ✅ NEW: Separate mapping
    uint256 nextOrderId;
    // ... other fields
}
```

### New Access Pattern

```solidity
// Mapping lookup (slightly more gas but only for cross-currency orders)
LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[orderId];
LibDoefinStorage.CrossCurrencyConfig storage config = ds.orderbookStorage.crossCurrencyConfigs[orderId];
address quoteCurrency = config.quoteCurrencyToken;
uint256 rate = config.exchangeRate;
```

### Gas Cost Analysis (Proposed)

**Standard Order Creation**:
- Order struct write: ~180,000 gas (3 fewer slots)
- **Savings**: 60,000 gas per standard order ✅

**Cross-Currency Order Creation**:
- Order struct write: ~180,000 gas
- CrossCurrencyConfig mapping write: ~60,000 gas
- **Total**: ~240,000 gas (same as before)

**Cross-Currency Order Access** (during matching):
- Extra SLOAD for config: ~2,100 gas per access
- Typical matching involves 2-3 accesses: ~6,300 gas overhead
- **Trade-off**: Cross-currency orders pay ~6,000 more gas during matching

**Net Impact**:
- Standard orders (95% of volume): **Save 60,000 gas** ✅
- Cross-currency orders (5% of volume): **Pay 6,000 extra gas** ⚠️
- Overall: **Significant net savings**

---

## Complete Migration Plan

### Phase 1: Storage Layer Changes

#### File: `contracts/libraries/LibDoefinStorage.sol`

**Change 1: Remove field from Order struct**
```solidity
// BEFORE (line ~175)
struct Order {
    // ... other fields
    CrossCurrencyConfig crossCurrencyConfig;  // REMOVE THIS LINE
    OrderDirection direction;
    // ...
}

// AFTER
struct Order {
    // ... other fields
    // CrossCurrencyConfig moved to separate mapping
    OrderDirection direction;
    // ...
}
```

**Change 2: Add mapping to OrderbookStorageStruct**
```solidity
// BEFORE (line ~191)
struct OrderbookStorageStruct {
    mapping(uint256 => Order) orders;
    uint256 nextOrderId;
    // ...
}

// AFTER
struct OrderbookStorageStruct {
    mapping(uint256 => Order) orders;
    mapping(uint256 => CrossCurrencyConfig) crossCurrencyConfigs;  // ADD THIS LINE
    uint256 nextOrderId;
    // ...
}
```

**Estimated Time**: 30 minutes

---

### Phase 2: Order Creation/Cancellation Logic

#### File: `contracts/libraries/LibOrderbook.sol`

**Change 1: Update createOrder() function (~line 127)**
```solidity
// BEFORE
ds.orderbookStorage.orders[orderId] = order;

// AFTER
ds.orderbookStorage.orders[orderId] = order;
if (orderType == LibDoefinStorage.OrderType.CrossCurrency) {
    ds.orderbookStorage.crossCurrencyConfigs[orderId] = crossCurrencyConfig;
}
```

**Change 2: Update cancelOrder() function (~line 188)**
```solidity
// BEFORE
delete ds.orderbookStorage.orders[orderId];

// AFTER
delete ds.orderbookStorage.orders[orderId];
if (order.orderType == LibDoefinStorage.OrderType.CrossCurrency) {
    delete ds.orderbookStorage.crossCurrencyConfigs[orderId];
}
```

**Change 3: Update validation logic (~line 48-92)**
```solidity
// BEFORE (inline validation)
if (orderType == LibDoefinStorage.OrderType.CrossCurrency) {
    if (crossCurrencyConfig.quoteCurrencyToken == address(0)) {
        revert Errors.InvalidQuoteCurrencyToken();
    }
    // ... more validation using crossCurrencyConfig directly
}

// AFTER (validation remains similar but note config won't be in order struct)
// Validation logic can remain mostly the same since it happens before storage write
```

**Estimated Time**: 2 hours

---

### Phase 3: Business Logic Library Updates

#### File: `contracts/libraries/LibQuoteCurrency.sol` (8 references)

**Helper Function Pattern** (recommended approach):
```solidity
// ADD THIS HELPER at top of library
function _getConfig(LibDoefinStorage.Order storage order) private view returns (LibDoefinStorage.CrossCurrencyConfig storage) {
    LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
    return ds.orderbookStorage.crossCurrencyConfigs[order.orderId];
}
```

**Change Pattern for All 8 References**:
```solidity
// BEFORE (line 94, 99, 105, 126, 155, 162, 168)
order.crossCurrencyConfig.quoteCurrencyToken
order.crossCurrencyConfig.exchangeRate
order.crossCurrencyConfig.exchangeRateType

// AFTER
LibDoefinStorage.CrossCurrencyConfig storage config = _getConfig(order);
config.quoteCurrencyToken
config.exchangeRate
config.exchangeRateType
```

**Locations to Update**:
- Line 94: `getOracleExchangeRate()` call
- Line 99: Exchange rate retrieval
- Line 105: Quote unit per pair lookup
- Line 126: Quote currency comparison (maker vs taker)
- Line 155: Unit per pair validation
- Line 162: Exchange rate type check
- Line 168: Exchange rate validation

**Estimated Time**: 2 hours

---

#### File: `contracts/libraries/LibTradeSettlement.sol` (6 references)

**Locations to Update**:
- Line 549: `quoteCurrencyToken` access
- Line 552: `exchangeRateType` check
- Line 564: `exchangeRate` retrieval
- Line 605: `quoteCurrencyToken` validation
- Line 610: `exchangeRate` validation

**Pattern**:
```solidity
// BEFORE
makerOrder.crossCurrencyConfig.quoteCurrencyToken

// AFTER
LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
LibDoefinStorage.CrossCurrencyConfig storage config = ds.orderbookStorage.crossCurrencyConfigs[makerOrder.orderId];
config.quoteCurrencyToken
```

**Estimated Time**: 1.5 hours

---

#### File: `contracts/libraries/LibEscrowLogic.sol` (6 references)

**Locations to Update**:
- Line 35: Quote currency token access
- Line 47: Exchange rate type check
- Line 53: Fixed rate retrieval
- Line 92: Quote currency token access
- Line 104: Exchange rate type check
- Line 111: Fixed rate retrieval

**Estimated Time**: 1.5 hours

---

### Phase 4: Interface Updates

#### File: `contracts/interfaces/IExchange.sol`

**No changes required** - `CrossCurrencyConfig` is still passed as memory parameter.

#### File: `contracts/interfaces/IOrderCreation.sol`

**No changes required** - Interface signatures remain the same.

**Estimated Time**: 0 hours (no changes)

---

### Phase 5: Facet Updates

#### File: `contracts/facets/OrderCreationFacet.sol`

**No changes required** - Still receives config as parameter, passes to library.

#### File: `contracts/facets/OrderManagementFacet.sol`

**Change in cancelOrder()** - Library handles cleanup, no facet changes needed.

**Estimated Time**: 0 hours (no changes)

---

### Phase 6: Test Utility Updates

#### File: `test/utils/crossCurrencyUtils.js`

**No changes required** - Helper functions still create config objects the same way.

#### File: `test/utils/orderUtils.js`

**No changes required** - Test utilities pass config to contracts, internal storage is opaque.

**Estimated Time**: 0 hours (verification only)

---

### Phase 7: Test Suite Updates

**Files Requiring Review**:
- `test/unit/ExchangeFacet/ExchangeFacet.crossCurrency.basic.test.js`
- `test/unit/ExchangeFacet/ExchangeFacet.crossCurrency.test.js`
- All integration tests involving order lifecycle

**Testing Focus**:
1. **Order Creation**: Verify configs stored in mapping
2. **Order Cancellation**: Verify mapping cleanup occurs
3. **Order Matching**: Verify config retrieval works correctly
4. **Gas Measurements**: Measure actual savings for standard vs cross-currency orders
5. **Edge Cases**: 
   - Cancelling cross-currency order twice
   - Accessing non-existent config for standard order
   - Modifying orders (if supported)

**New Test Cases to Add**:
```javascript
describe("CrossCurrency Storage Optimization", () => {
  it("should not store config for standard orders", async () => {
    const orderId = await createStandardOrder();
    const config = await getStoredConfig(orderId);
    expect(config.quoteCurrencyToken).to.equal(ethers.constants.AddressZero);
  });

  it("should store config only for cross-currency orders", async () => {
    const orderId = await createCrossCurrencyOrder();
    const config = await getStoredConfig(orderId);
    expect(config.quoteCurrencyToken).to.not.equal(ethers.constants.AddressZero);
  });

  it("should clean up config on order cancellation", async () => {
    const orderId = await createCrossCurrencyOrder();
    await cancelOrder(orderId);
    const config = await getStoredConfig(orderId);
    expect(config.quoteCurrencyToken).to.equal(ethers.constants.AddressZero);
  });
});
```

**Estimated Time**: 3-4 hours

---

## Complete File List (15-20 Files)

### ✅ Files Requiring Code Changes (11 files)

1. **contracts/libraries/LibDoefinStorage.sol** - Storage structure changes
2. **contracts/libraries/LibOrderbook.sol** - Order creation/cancellation logic
3. **contracts/libraries/LibQuoteCurrency.sol** - 8 config access points
4. **contracts/libraries/LibTradeSettlement.sol** - 6 config access points
5. **contracts/libraries/LibEscrowLogic.sol** - 6 config access points
6. **contracts/libraries/LibMatchEngine.sol** - Likely has compatibility checks
7. **test/unit/ExchangeFacet/ExchangeFacet.crossCurrency.basic.test.js**
8. **test/unit/ExchangeFacet/ExchangeFacet.crossCurrency.test.js**
9. **test/integration/** - Any integration tests for full order lifecycle

### 📄 Files Requiring Review Only (5 files)

10. **contracts/interfaces/IExchange.sol** - Verify no interface changes needed
11. **contracts/interfaces/IOrderCreation.sol** - Verify no interface changes needed
12. **contracts/facets/OrderCreationFacet.sol** - Verify delegates correctly
13. **contracts/facets/OrderManagementFacet.sol** - Verify cleanup works
14. **test/utils/crossCurrencyUtils.js** - Verify helpers still work
15. **test/utils/orderUtils.js** - Verify helpers still work

### 📋 Documentation Files to Update (3 files)

16. **CONTRACT_SIZE_OPTIMIZATION_GUIDE.md** - Update with new pattern
17. **CROSS_CURRENCY_PRICE_TIME_PRIORITY.md** - Update code examples
18. **README.md** - Update architecture section if mentioned

---

## Storage Migration Strategy

### Option 1: Clean Redeployment (Recommended for Pre-Production)

**When to Use**: If no production orders exist or can be wiped.

**Steps**:
1. Deploy new Diamond with updated storage layout
2. Re-register all facets
3. Reconfigure collateral tokens, market makers, etc.
4. No data migration needed

**Pros**: Clean, simple, no migration complexity  
**Cons**: Loses all existing orders

---

### Option 2: Migration Facet (For Production)

**When to Use**: If production orders must be preserved.

**Steps**:
1. Deploy `CrossCurrencyMigrationFacet` with migration logic
2. Add facet to Diamond via DiamondCut
3. Run migration function (admin-only, gas-intensive)
4. Verify all cross-currency orders migrated correctly
5. Remove migration facet

**Migration Facet Pseudocode**:
```solidity
contract CrossCurrencyMigrationFacet {
    function migrateCrossCurrencyConfigs(uint256[] calldata orderIds) external onlyAdmin {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        
        for (uint256 i = 0; i < orderIds.length; i++) {
            uint256 orderId = orderIds[i];
            LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[orderId];
            
            if (order.orderType == LibDoefinStorage.OrderType.CrossCurrency) {
                // Read from old location (still in Order struct during migration)
                LibDoefinStorage.CrossCurrencyConfig memory config = order.crossCurrencyConfig;
                
                // Write to new mapping
                ds.orderbookStorage.crossCurrencyConfigs[orderId] = config;
                
                // Zero out old location (optional, saves gas)
                delete order.crossCurrencyConfig;
            }
        }
    }
    
    function verifyMigration(uint256 orderId) external view returns (bool) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[orderId];
        LibDoefinStorage.CrossCurrencyConfig storage config = ds.orderbookStorage.crossCurrencyConfigs[orderId];
        
        return config.quoteCurrencyToken != address(0) && order.orderType == LibDoefinStorage.OrderType.CrossCurrency;
    }
}
```

**Migration Process**:
1. **Pre-Migration**: Query all active cross-currency order IDs off-chain
2. **Batch Migration**: Call `migrateCrossCurrencyConfigs()` in batches of ~50 orders
3. **Verification**: Call `verifyMigration()` for each order
4. **Completion**: Remove migration facet, update documentation

**Pros**: Preserves existing orders  
**Cons**: High complexity, gas costs, multi-step process

---

### Option 3: Dual Support Period (Hybrid Approach)

**When to Use**: For gradual migration with zero downtime.

**Steps**:
1. Deploy updated code that reads from **both locations** (old field AND new mapping)
2. New orders use new mapping only
3. Old orders continue to work via old field
4. After all old orders expire/cancel naturally (30-90 days), remove dual support
5. Deploy final version that only uses new mapping

**Reading Logic**:
```solidity
function _getConfigSafe(LibDoefinStorage.Order storage order) private view returns (LibDoefinStorage.CrossCurrencyConfig memory) {
    LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
    
    // Try new mapping first
    LibDoefinStorage.CrossCurrencyConfig storage mappingConfig = ds.orderbookStorage.crossCurrencyConfigs[order.orderId];
    if (mappingConfig.quoteCurrencyToken != address(0)) {
        return mappingConfig;
    }
    
    // Fall back to old field for legacy orders
    return order.crossCurrencyConfig;
}
```

**Pros**: Zero downtime, no forced migration  
**Cons**: Code complexity during transition, longer timeline

---

## Deployment Checklist

### Pre-Deployment
- [ ] Complete all code changes across 11 files
- [ ] Update all tests and verify passing
- [ ] Run gas profiling to confirm expected savings
- [ ] Update documentation (CONTRACT_SIZE_OPTIMIZATION_GUIDE.md, etc.)
- [ ] Code review by 2+ developers
- [ ] Security review if possible (focus on storage layout changes)

### Deployment (Option 1: Clean Redeployment)
- [ ] Backup current contract state (if needed)
- [ ] Deploy new Diamond.sol
- [ ] Deploy all updated facets
- [ ] Register facets via DiamondCut
- [ ] Configure collateral tokens
- [ ] Configure market makers
- [ ] Run smoke tests on testnet
- [ ] Deploy to mainnet

### Deployment (Option 2: With Migration)
- [ ] Deploy CrossCurrencyMigrationFacet
- [ ] Add migration facet via DiamondCut
- [ ] Query all active cross-currency order IDs
- [ ] Run migration in batches
- [ ] Verify all orders migrated successfully
- [ ] Deploy updated facets (with new access patterns)
- [ ] Update facets via DiamondCut
- [ ] Run verification tests
- [ ] Remove migration facet

### Post-Deployment
- [ ] Verify standard order creation costs ~60k less gas
- [ ] Verify cross-currency orders still work correctly
- [ ] Monitor for any unexpected behavior
- [ ] Update public documentation
- [ ] Announce changes to users/integrators

---

## Risk Assessment

### High Risk Areas ⚠️

1. **Storage Corruption Risk**: Diamond pattern storage is sensitive
   - **Mitigation**: Extensive testing, never modify existing slot positions
   - **Severity**: Critical (could brick contract)

2. **Missed Access Patterns**: 100+ locations to update
   - **Mitigation**: Comprehensive grep search, thorough code review
   - **Severity**: High (could cause runtime failures)

3. **Migration Failure**: If production orders exist
   - **Mitigation**: Test migration extensively on testnet with realistic data
   - **Severity**: High (could lose order data)

### Medium Risk Areas ⚠️

4. **Gas Regressions**: Cross-currency orders become more expensive
   - **Mitigation**: Measure actual gas costs, acceptable trade-off
   - **Severity**: Medium (affects user experience)

5. **Integration Breaking**: External integrators may rely on Order struct
   - **Mitigation**: Maintain interfaces, document breaking changes
   - **Severity**: Medium (requires integrator updates)

### Low Risk Areas ✅

6. **Test Suite Failures**: Some tests may break initially
   - **Mitigation**: Allocate time for test updates
   - **Severity**: Low (development-only impact)

---

## Alternative Optimizations (Lower Risk)

Before implementing this high-complexity refactoring, consider these alternatives:

### 1. **Pack CrossCurrencyConfig More Efficiently**
```solidity
struct CrossCurrencyConfig {
    address quoteCurrencyToken;     // 20 bytes
    uint8 exchangeRateType;         // 1 byte  (same slot as address)
    uint88 reserved;                // 11 bytes padding
    uint256 exchangeRate;           // 32 bytes (separate slot)
}
// Current: 3 slots → Could optimize to 2 slots (saves 20k gas)
```
**Effort**: 2-3 hours | **Savings**: ~20k gas per order

### 2. **Use Bit Packing for Order Flags**
```solidity
struct Order {
    // ... existing fields
    uint8 orderType;        // Could pack into single byte with direction, executionType
    OrderDirection direction;
    ExecutionType executionType;
    bool active;
    bool fillOrKill;
}
// Could pack all 5 fields into 1 slot
```
**Effort**: 4-5 hours | **Savings**: ~60k gas per order

### 3. **Extract View Functions to Dedicated Facet**
```solidity
// Move all view functions from OrderCreationFacet to OrderViewFacet
// Reduces OrderCreationFacet size (currently 24.941 KiB)
```
**Effort**: 2-3 hours | **Savings**: Contract size reduction (no gas impact)

### 4. **Use Internal Library Functions**
```solidity
// Convert external library calls to internal where possible
// Saves DELEGATECALL overhead
```
**Effort**: 3-4 hours | **Savings**: ~5k gas per external call avoided

---

## Success Metrics

### Quantitative Metrics
- [ ] Standard order creation gas reduced by ≥50,000
- [ ] Cross-currency order creation gas remains within 10% of current
- [ ] Contract size for OrderCreationFacet reduced by ≥2 KiB
- [ ] All existing tests pass with ≤10% modifications
- [ ] Zero production incidents in first 30 days post-deployment

### Qualitative Metrics
- [ ] Code maintainability improved (cleaner separation of concerns)
- [ ] Storage architecture more intuitive for future developers
- [ ] Documentation reflects actual implementation accurately

---

## Timeline Estimate

### Conservative Timeline (Recommended)
- **Week 1**: Code changes + unit tests (12 hours)
- **Week 2**: Integration tests + gas profiling (8 hours)
- **Week 3**: Code review + security review (8 hours)
- **Week 4**: Testnet deployment + migration testing (8 hours)
- **Week 5**: Mainnet deployment + monitoring (4 hours)

**Total**: 40 hours over 5 weeks

### Aggressive Timeline (Higher Risk)
- **Day 1-2**: Code changes (12 hours)
- **Day 3**: Testing (6 hours)
- **Day 4**: Review + deployment (4 hours)

**Total**: 22 hours over 4 days

---

## Related Issues & Future Work

### Related Optimizations
- **Issue #[TBD]**: Implement bit packing for order flags
- **Issue #[TBD]**: Extract view functions to reduce facet sizes
- **Issue #[TBD]**: Optimize CrossCurrencyConfig struct packing

### Future Enhancements
- **Sparse Mapping Cleanup**: Implement garbage collection for very old cancelled orders
- **Config Sharing**: If multiple orders use identical configs, could deduplicate
- **Lazy Loading**: Only load config when needed in matching logic

### Documentation to Update
- Architecture diagrams showing new storage layout
- Gas cost comparison tables in README
- Migration guide for integrators
- API documentation (if external interfaces change)

---

## Decision Record

**Date**: November 27, 2025  
**Decision**: Documented for future implementation  
**Rationale**: 
- High complexity (12-18 hours) for optimization that can wait
- Current focus should be on oracle integration completion
- Contract size issue (OrderCreationFacet 24.941 KiB) may be solvable with lower-risk alternatives
- Gas profiling should be done with production-like workloads before committing to major refactoring

**Revisit Criteria**:
- [ ] Oracle integration complete and tested
- [ ] Production gas cost data shows standard orders are primary bottleneck
- [ ] Lower-risk optimizations (bit packing, view function extraction) already implemented
- [ ] Time allocated for thorough testing and migration planning

**Approved By**: [To be filled]  
**Review Date**: [To be scheduled for Q1 2026]

---

## References

- **EIP-2535 Diamond Standard**: https://eips.ethereum.org/EIPS/eip-2535
- **Solidity Storage Layout**: https://docs.soliditylang.org/en/latest/internals/layout_in_storage.html
- **Gas Costs Reference**: https://www.evm.codes/
- **Related Code Review**: Feature branch DOE-286-ShortPutOrderLogicImplementation

---

**Document Version**: 1.0  
**Last Updated**: November 27, 2025  
**Author**: GitHub Copilot (AI Assistant)  
**Reviewers**: [Pending]
