# Doefin V2 Refactoring Master Plan

**Version**: 1.0  
**Date**: December 11, 2025  
**Status**: Planning Phase  
**Estimated Total Effort**: 30-40 hours

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Refactoring Initiatives](#refactoring-initiatives)
3. [Implementation Priority](#implementation-priority)
4. [Phase 1: Oracle Dispatcher Pattern](#phase-1-oracle-dispatcher-pattern)
5. [Phase 2: Cross-Currency Storage Optimization](#phase-2-cross-currency-storage-optimization)
6. [Testing Strategy](#testing-strategy)
7. [Risk Management](#risk-management)
8. [Success Metrics](#success-metrics)

---

## Executive Summary

This document consolidates three major refactoring initiatives for Doefin V2 to improve code maintainability, reduce gas costs, and enable easier feature additions:

### 1. Oracle Dispatcher Pattern Refactoring
**Goal**: Transform monolithic oracle question handling into a modular dispatcher pattern  
**Impact**: Adding new question types becomes 80% easier  
**LOC Impact**: +287 lines (+84%) - distributed across isolated handlers  
**Effort**: 18-22 hours  
**Priority**: HIGH (enables future features)

### 2. Cross-Currency Storage Optimization
**Goal**: Extract CrossCurrencyConfig from Order struct to reduce gas for standard orders  
**Impact**: Save ~60k gas per standard order creation  
**LOC Impact**: +30 lines (+3.5%) - minimal mechanical changes  
**Effort**: 12-18 hours  
**Priority**: MEDIUM (gas optimization, can be deferred)

### 3. Storage Optimization Guidelines
**Goal**: Establish systematic approach to identifying and implementing storage optimizations  
**Impact**: Prevent future storage waste, document best practices  
**Effort**: 0 hours (documentation only)  
**Priority**: HIGH (prevents future issues)

---

## Refactoring Initiatives

### Initiative 1: Oracle Dispatcher Pattern (HIGH PRIORITY)

#### Lines of Code Impact
**Current Code**: 343 lines (LibConditionMetadata: 180 + ConditionManagerFacet: 163)  
**After Refactoring**: ~630 lines (4 handlers: 480 + Dispatcher: 150)  
**Net Change**: **+287 lines (+84%)**  
**BUT**: Code is distributed across 5 isolated files instead of 2 monolithic files

**Why More Lines is Better**:
- Each handler is self-contained (~120 lines) and independently testable
- ConditionManagerFacet simplified from 163 → ~80 lines (-51%)
- LibConditionMetadata deleted entirely (-180 lines of coupled code)
- Adding new question type: +120 lines isolated vs +150 lines scattered across 4 files

#### Current Pain Points
- 4 question types scattered across 4-5 files with large switch statements
- Each new question type requires modifying multiple core files
- Tight coupling between ConditionManagerFacet and type-specific logic
- Validation, storage, and resolution logic mixed together

#### Proposed Solution
```
Old Flow:
ConditionManagerFacet → Large switch statement → Type-specific logic inline

New Flow:
ConditionManagerFacet → LibQuestionDispatcher → Handler Libraries
                                                   ├─ DifficultyThresholdHandler
                                                   ├─ DifficultyRangeHandler
                                                   ├─ BlockCountHandler
                                                   └─ MiningDurationHandler
```

#### Benefits
- **Maintainability**: Each question type in isolated file (~120 lines)
- **Scalability**: Adding new types only requires creating handler + 4 dispatch lines
- **Testing**: Unit test handlers in isolation
- **Code Quality**: Eliminate 150+ line switch statements

#### Key Files Created
```
contracts/
├── handlers/                          # NEW directory
│   ├── DifficultyThresholdHandler.sol
│   ├── DifficultyRangeHandler.sol
│   ├── BlockCountHandler.sol
│   └── MiningDurationHandler.sol
└── libraries/
    └── LibQuestionDispatcher.sol      # NEW file
```

#### Key Files Modified
- `contracts/facets/ConditionManagerFacet.sol` - Use dispatcher instead of inline logic
- `contracts/libraries/LibOracleAdapter.sol` - Call handlers for resolution

#### Key Files Deleted
- `contracts/libraries/LibConditionMetadata.sol` - Logic moved to handlers

---

### Initiative 2: Cross-Currency Storage Optimization (MEDIUM PRIORITY)

#### Lines of Code Impact
**Files Modified**: 848 lines across 3 core libraries (LibOrderbook: 256, LibQuoteCurrency: 179, LibTradeSettlement: 413)  
**Lines Changed**: ~30-40 lines total (helper functions + access pattern changes)  
**Net Change**: **+30 lines (+3.5%)**  

**Why Minimal LOC Change**:
- Only 10 access points need updating (found via grep)
- Changes are mechanical: `order.crossCurrencyConfig.X` → `_getConfig(order).X`
- One helper function added per library (~5 lines each)
- Storage struct changes are additions, not rewrites

#### Current Pain Points
- Every order stores 3 slots (96 bytes) for CrossCurrencyConfig
- 95%+ of orders are standard orders that don't use this feature
- Wasting ~60,000 gas per standard order creation

#### Current Structure
```solidity
struct Order {
    // ... common fields (9 slots)
    CrossCurrencyConfig crossCurrencyConfig;  // ❌ Always stored (3 slots)
    // ... other fields
}
```

#### Proposed Structure
```solidity
struct Order {
    // ... common fields (9 slots)
    // CrossCurrencyConfig removed
    // ... other fields
}

struct OrderbookStorageStruct {
    mapping(uint256 => Order) orders;
    mapping(uint256 => CrossCurrencyConfig) crossCurrencyConfigs;  // ✅ Separate mapping
    // ...
}
```

#### Gas Impact Analysis

| Order Type | Current Cost | Optimized Cost | Impact |
|------------|--------------|----------------|--------|
| Standard Order | ~240k gas | ~180k gas | **-60k gas ✅** |
| Cross-Currency Order | ~240k gas | ~246k gas | +6k gas ⚠️ |
| **Net Benefit** (95% standard) | - | - | **-57k avg ✅** |

#### Key Changes Required
- **Storage**: LibDoefinStorage.sol - Add crossCurrencyConfigs mapping
- **Creation**: LibOrderbook.sol - Conditional config storage
- **Access**: LibQuoteCurrency.sol, LibTradeSettlement.sol, LibEscrowLogic.sol - Map lookups
- **Cleanup**: LibOrderbook.sol - Delete mapping entry on cancel
- **Tests**: Update 10+ test files

#### Migration Strategies
1. **Clean Redeployment** (recommended for testnet)
2. **Migration Facet** (for production with existing orders)
3. **Dual Support Period** (gradual transition)

---

### Initiative 3: Storage Optimization Guidelines (DOCUMENTATION)

#### Purpose
Establish systematic methodology for:
1. Identifying storage optimization opportunities
2. Calculating expected gas savings
3. Assessing refactoring complexity
4. Making go/no-go decisions
5. Safe implementation in Diamond pattern

#### Key Decision Matrix

```
Savings         Complexity     Decision
----------------------------------------------
> 100k gas      Low            ✅ Do it now
> 100k gas      Medium         ✅ Do it now
> 100k gas      High           📋 Document & plan
50-100k gas     Low            ✅ Do it now
50-100k gas     Medium         📋 Document & plan
50-100k gas     High           ❌ Not worth it
< 50k gas       Any            ❌ Not worth it
```

#### Common Patterns Documented
1. Separate mapping for conditional data
2. Bit packing for flags/small values
3. Lazy initialization
4. Storage vs memory for temporary data
5. Packed arrays for homogeneous data

---

## Implementation Priority

### Recommended Sequence

#### Phase 1: Oracle Dispatcher Pattern (Weeks 1-3)
**Why First**: 
- Enables easier addition of new question types for future features
- Improves code quality and maintainability
- No storage migration complexity
- Clear architectural win

**Effort**: 18-22 hours  
**Risk**: LOW (new code pattern, doesn't modify storage)

#### Phase 2: Storage Optimization Guidelines (Week 3)
**Why Second**:
- Can be applied while working on Oracle refactor
- Helps validate decisions for future optimizations
- Zero implementation time (documentation only)

**Effort**: 0 hours (already documented)  
**Risk**: ZERO

#### Phase 3: Cross-Currency Storage Optimization (Weeks 4-6, or deferred)
**Why Last**:
- Can be deferred if testnet has no critical orders
- High complexity (15-20 files modified)
- Requires careful storage migration
- Gas optimization can wait until after feature completion

**Effort**: 12-18 hours  
**Risk**: MEDIUM-HIGH (storage changes in Diamond pattern)

---

## Phase 1: Oracle Dispatcher Pattern

### Detailed Implementation Plan

#### Step 1: Create Handler Interface Pattern (3-4 hours)

Each handler implements this exact interface:

```solidity
library [QuestionType]Handler {
    
    // Metadata struct for this question type
    struct Metadata {
        // Question-specific parameters
    }
    
    // REQUIRED FUNCTIONS:
    function encode(Metadata memory meta) internal pure returns (bytes memory)
    function decode(bytes memory data) internal pure returns (Metadata memory)
    function validate(bytes memory metadata, uint8 outcomeSlotCount, uint256 currentBlockHeight) internal view returns (bool)
    function getTrigger(bytes memory metadata, uint256 currentBlockHeight) internal pure returns (uint8 triggerType, uint256 triggerValue)
    function store(bytes32 questionId, bytes32 conditionId, bytes memory metadata, uint256 triggerValue) internal
    function resolve(bytes memory metadata, uint8 outcomeSlotCount) internal view returns (uint256[] memory payouts)
}
```

**Source Extraction Map**:
- `encode()` / `decode()` ← LibConditionMetadata.sol
- `validate()` ← LibConditionMetadata.sol (validation functions)
- `getTrigger()` ← ConditionManagerFacet.sol (trigger calculation)
- `store()` ← ConditionManagerFacet.sol (storage logic)
- `resolve()` ← LibOracleAdapter.sol (resolution logic)

**Handler Creation Sequence**:
1. ✅ DifficultyThresholdHandler (simplest - use as template)
2. DifficultyRangeHandler (similar to threshold)
3. MiningDurationHandler (block-based)
4. BlockCountHandler (timestamp-based)

#### Step 2: Create LibQuestionDispatcher (2 hours)

Central router with 4 dispatch functions:

```solidity
library LibQuestionDispatcher {
    
    // Dispatch validation to appropriate handler
    function validate(
        LibDoefinStorage.QuestionType questionType,
        bytes memory metadata,
        uint8 outcomeSlotCount,
        uint256 currentBlockHeight
    ) internal view returns (bool) {
        if (questionType == LibDoefinStorage.QuestionType.DifficultyThreshold) {
            return DifficultyThresholdHandler.validate(metadata, outcomeSlotCount, currentBlockHeight);
        }
        // ... else if for other types
        return false;
    }
    
    // Dispatch trigger calculation
    function getResolutionTrigger(...) internal pure returns (uint8, uint256)
    
    // Dispatch storage
    function storeQuestion(...) internal
    
    // Dispatch resolution
    function resolveQuestion(...) internal view returns (uint256[] memory)
}
```

#### Step 3: Refactor ConditionManagerFacet (2-3 hours)

**Before** (complex switch statement):
```solidity
function createConditionWithMetadata(...) external returns (bytes32, bytes32) {
    // 150+ lines of type-specific validation and storage
    if (questionType == QuestionType.DifficultyThreshold) {
        // Inline validation logic
        // Inline storage logic
        // Inline trigger calculation
    } else if (questionType == QuestionType.DifficultyRange) {
        // Repeat for each type...
    }
}
```

**After** (clean delegation):
```solidity
function createConditionWithMetadata(...) external returns (bytes32, bytes32) {
    // Validate using dispatcher
    bool isValid = LibQuestionDispatcher.validate(questionType, metadata, outcomeSlotCount, currentBlockHeight);
    if (!isValid) revert Errors.ValueOutOfRange();
    
    // Generate IDs
    questionId = keccak256(abi.encode(questionType, keccak256(metadata), salt));
    conditionId = LibCTFCondition.prepareCondition(address(this), questionId, outcomeSlotCount);
    
    // Get trigger using dispatcher
    (uint8 triggerType, uint256 triggerValue) = LibQuestionDispatcher.getResolutionTrigger(questionType, metadata, currentBlockHeight);
    
    // Store using dispatcher
    LibQuestionDispatcher.storeQuestion(questionType, questionId, conditionId, metadata, triggerValue);
    
    // Store condition metadata
    ds.conditionalTokens.conditions[conditionId] = LibDoefinStorage.Condition({...});
    
    emit Events.ConditionCreated(...);
}
```

**Delete**: `_validateAndStoreQuestion()` function (no longer needed)

#### Step 4: Update LibOracleAdapter (2-3 hours)

**Change Pattern** (example for DifficultyThreshold):

**Before**:
```solidity
function _resolveDifficultyThresholdQuestion(
    LibDoefinStorage.DifficultyThresholdQuestion storage question,
    uint256 blockHeight
) private {
    // Inline resolution logic (30+ lines)
    uint256 actualDifficulty = _getBlockDifficulty(question.targetBlockHeight);
    uint256[] memory payouts = new uint256[](2);
    if (actualDifficulty > question.threshold) {
        payouts[1] = 1;
    } else {
        payouts[0] = 1;
    }
    // ... update storage, emit events
}
```

**After**:
```solidity
function _resolveDifficultyThresholdQuestion(
    LibDoefinStorage.DifficultyThresholdQuestion storage question,
    uint256 blockHeight
) private {
    // Encode metadata from storage
    bytes memory metadata = DifficultyThresholdHandler.encode(
        DifficultyThresholdHandler.Metadata({
            threshold: question.threshold,
            targetBlockHeight: question.targetBlockHeight
        })
    );
    
    // Resolve using handler
    uint256[] memory payouts = DifficultyThresholdHandler.resolve(metadata, 2);
    
    // Update storage
    question.resolved = true;
    question.winningIndex = payouts[1] == 1 ? 1 : 0;
    
    // Report to CTF
    LibCTFCondition._reportPayouts(address(this), question.questionId, payouts);
    ds.oracleAdapterStorage.totalQuestionsResolved++;
}
```

**Repeat for all 4 resolution functions**.

#### Step 5: Delete LibConditionMetadata.sol (10 min)

All functionality migrated to handlers. Verify no imports remain.

#### Step 6: Testing (6-8 hours)

**Unit Tests** (one file per handler):
```javascript
// test/handlers/DifficultyThresholdHandler.t.sol
describe("DifficultyThresholdHandler", () => {
    it("should encode/decode metadata correctly");
    it("should validate valid parameters");
    it("should reject invalid parameters");
    it("should calculate correct trigger");
    it("should resolve correctly when above threshold");
    it("should resolve correctly when below threshold");
});
```

**Integration Tests**:
```javascript
// test/integration/OracleDispatcher.t.sol
describe("Oracle Dispatcher Integration", () => {
    it("should create and resolve all 4 question types");
    it("should handle multiple questions at same block");
    it("should fail gracefully for unknown types");
});
```

**Regression Tests**:
- Run all existing condition/oracle tests
- Verify gas costs within 5% of original

---

## Phase 2: Cross-Currency Storage Optimization

### Detailed Implementation Plan

#### Step 1: Storage Layer Changes (30 min)

**File**: `contracts/libraries/LibDoefinStorage.sol`

**Change 1**: Remove field from Order struct
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
    // ❌ REMOVED: CrossCurrencyConfig crossCurrencyConfig;
    OrderDirection direction;
    ExecutionType executionType;
    bool active;
    bool fillOrKill;
}
```

**Change 2**: Add mapping to OrderbookStorageStruct
```solidity
struct OrderbookStorageStruct {
    mapping(uint256 => Order) orders;
    mapping(uint256 => CrossCurrencyConfig) crossCurrencyConfigs;  // ✅ NEW
    uint256 nextOrderId;
    // ... other fields
}
```

#### Step 2: Order Creation/Cancellation (2 hours)

**File**: `contracts/libraries/LibOrderbook.sol`

**Update createOrder()**:
```solidity
// After storing order
ds.orderbookStorage.orders[orderId] = order;

// NEW: Conditionally store config
if (orderType == LibDoefinStorage.OrderType.CrossCurrency) {
    ds.orderbookStorage.crossCurrencyConfigs[orderId] = crossCurrencyConfig;
}
```

**Update cancelOrder()**:
```solidity
// After deleting order
delete ds.orderbookStorage.orders[orderId];

// NEW: Cleanup config if cross-currency
if (order.orderType == LibDoefinStorage.OrderType.CrossCurrency) {
    delete ds.orderbookStorage.crossCurrencyConfigs[orderId];
}
```

#### Step 3: Business Logic Updates (4-5 hours)

**Pattern**: Add helper function at top of each library:

```solidity
function _getConfig(LibDoefinStorage.Order storage order) private view returns (LibDoefinStorage.CrossCurrencyConfig storage) {
    LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
    return ds.orderbookStorage.crossCurrencyConfigs[order.orderId];
}
```

**Files to Update** (with access counts):
1. `LibQuoteCurrency.sol` - 8 references
2. `LibTradeSettlement.sol` - 6 references
3. `LibEscrowLogic.sol` - 6 references
4. `LibMatchEngine.sol` - Likely 2-4 references (needs verification)

**Replacement Pattern**:
```solidity
// BEFORE
order.crossCurrencyConfig.quoteCurrencyToken
order.crossCurrencyConfig.exchangeRate

// AFTER
LibDoefinStorage.CrossCurrencyConfig storage config = _getConfig(order);
config.quoteCurrencyToken
config.exchangeRate
```

#### Step 4: Testing Updates (3-4 hours)

**Test files requiring updates**:
- `test/unit/ExchangeFacet/ExchangeFacet.crossCurrency.basic.test.js`
- `test/unit/ExchangeFacet/ExchangeFacet.crossCurrency.test.js`
- All integration tests involving order lifecycle

**New test cases**:
```javascript
describe("CrossCurrency Storage Optimization", () => {
    it("should not store config for standard orders", async () => {
        // Create standard order
        // Verify crossCurrencyConfigs[orderId] is empty
    });
    
    it("should store config for cross-currency orders", async () => {
        // Create cross-currency order
        // Verify crossCurrencyConfigs[orderId] is populated
    });
    
    it("should cleanup config on cross-currency order cancel", async () => {
        // Create cross-currency order
        // Cancel order
        // Verify crossCurrencyConfigs[orderId] is deleted
    });
    
    it("should measure gas savings for standard orders", async () => {
        // Measure gas before optimization (baseline)
        // Measure gas after optimization
        // Verify ~60k savings
    });
});
```

#### Step 5: Migration Strategy (if needed)

**For Testnet** (recommended):
- Clean redeployment (no migration needed)

**For Production** (if orders exist):
1. Deploy CrossCurrencyMigrationFacet
2. Query all cross-currency order IDs off-chain
3. Batch migrate configs (50 orders per tx)
4. Verify migration completeness
5. Update facets via DiamondCut
6. Remove migration facet

---

## Testing Strategy

### Oracle Dispatcher Testing

#### Unit Tests
- **Handler Tests**: Each handler gets isolated test file
  - Encoding/decoding correctness
  - Validation edge cases
  - Trigger calculation
  - Resolution logic
  
#### Integration Tests
- End-to-end condition creation and resolution
- Multiple questions at same block/timestamp
- Dispatcher routing correctness
- Failure handling

#### Regression Tests
- All existing oracle/condition tests must pass
- Gas costs within 5% of baseline
- No behavioral changes

### Cross-Currency Optimization Testing

#### Functional Tests
- Standard order creation (config NOT stored)
- Cross-currency order creation (config stored)
- Order cancellation cleanup
- Order matching with config retrieval

#### Gas Measurement Tests
- Baseline standard order gas cost
- Optimized standard order gas cost
- Baseline cross-currency order gas cost
- Optimized cross-currency order gas cost
- Verify expected savings

#### Migration Tests (if applicable)
- Migration facet batch processing
- Migration verification
- Post-migration order functionality

---

## Risk Management

### Oracle Dispatcher Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Handler logic bugs | MEDIUM | Isolated unit tests per handler |
| Missing dispatch case | LOW | Compiler errors if missing return |
| Performance regression | LOW | Gas profiling required |
| Storage corruption | VERY LOW | No storage changes, new code only |

### Cross-Currency Optimization Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Storage corruption | HIGH | Never modify existing slot positions |
| Missed access patterns | HIGH | Comprehensive grep search + code review |
| Migration failure | MEDIUM | Extensive testnet testing first |
| Gas regression | LOW | Measure actual costs, acceptable trade-off |
| Integration breaking | MEDIUM | Maintain interfaces, document changes |

### General Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Diamond pattern violations | CRITICAL | Follow EIP-2535 strictly, never remove/reorder fields |
| Test coverage gaps | MEDIUM | Require 100% existing tests passing |
| Timeline overruns | LOW | Conservative estimates, phase-based approach |

---

## Success Metrics

### Oracle Dispatcher Success Criteria

- [ ] All 4 handlers created and compile successfully
- [ ] LibQuestionDispatcher created with all dispatch functions
- [ ] ConditionManagerFacet simplified (remove 150+ lines)
- [ ] LibConditionMetadata.sol deleted
- [ ] All existing tests pass
- [ ] Gas costs within 5% of baseline
- [ ] Code review approved
- [ ] Adding new question type takes < 2 hours (vs 4+ hours before)

### Cross-Currency Optimization Success Criteria

- [ ] Standard order gas reduced by ≥50,000
- [ ] Cross-currency order gas within 10% of current
- [ ] All tests pass with ≤10% modifications
- [ ] No mapping cleanup leaks (verified in tests)
- [ ] Zero production incidents in first 30 days
- [ ] Code maintainability improved (cleaner separation)

### Overall Project Success

- [ ] Phase 1 completed within 3 weeks
- [ ] Phase 2 completed within 3 weeks (or deferred decision made)
- [ ] Documentation updated for all changes
- [ ] Team trained on new patterns
- [ ] Future feature additions demonstrably faster/easier

---

## Timeline & Resource Allocation

### Conservative Timeline

**Phase 1: Oracle Dispatcher Pattern**
- Week 1: Handler creation (12 hours)
- Week 2: Dispatcher + facet refactoring (8 hours)
- Week 3: Testing + review (8 hours)
- **Total**: 28 hours over 3 weeks

**Phase 2: Cross-Currency Optimization** (optional)
- Week 4: Storage + creation logic (6 hours)
- Week 5: Business logic updates (8 hours)
- Week 6: Testing + deployment (6 hours)
- **Total**: 20 hours over 3 weeks

**Phase 3: Documentation** (concurrent)
- Applied throughout phases
- **Total**: 0 additional hours

### Aggressive Timeline (Higher Risk)

**Phase 1**: 2 weeks (condensed testing)
**Phase 2**: 2 weeks (condensed review)

**Not recommended** due to storage safety concerns in Diamond pattern.

---

## Decision Points

### Immediate Decisions Needed

1. **Approve Oracle Dispatcher Pattern?**
   - ✅ Recommended: YES (clear architectural improvement)
   - Timeline: Start immediately
   - Risk: LOW

2. **Approve Cross-Currency Optimization?**
   - 📋 Recommended: DEFER until after Phase 1
   - Rationale: High complexity, medium priority
   - Alternative: Consider simpler optimizations first (bit packing)

3. **Deployment Strategy?**
   - Testnet: Clean redeployment (no migration)
   - Mainnet: TBD based on order volume

### Future Review Points

- **After Phase 1 Week 1**: Review handler quality, adjust timeline if needed
- **After Phase 1 Completion**: Decide whether to proceed with Phase 2
- **After Phase 2 Week 1**: Review storage changes, verify no corruption

---

## Alternative Approaches Considered

### For Oracle Dispatcher

**Alternative 1: Keep Current Switch Statements**
- ❌ Rejected: Doesn't scale, high coupling

**Alternative 2: Use Registry Pattern**
- ❌ Rejected: Overkill for 4 types, adds gas overhead

**Alternative 3: Dispatcher Pattern** (SELECTED)
- ✅ Selected: Balance of simplicity and extensibility

### For Cross-Currency Optimization

**Alternative 1: Do Nothing**
- ⚠️ Viable: If gas costs acceptable to users

**Alternative 2: Bit Pack CrossCurrencyConfig**
- ✅ Lower risk alternative: Reduce from 3 slots to 2 slots
- Savings: ~20k gas instead of 60k
- Effort: 2-3 hours instead of 12-18

**Alternative 3: Separate Mapping** (SELECTED)
- ✅ Selected: Maximum savings, aligns with opt-in philosophy

**Alternative 4: Dual Support Period**
- ⚠️ Highest complexity: Use if production orders exist

---

## Appendices

### Appendix A: Complete File Change List

#### Oracle Dispatcher Pattern

**NEW FILES** (5):
- `contracts/handlers/DifficultyThresholdHandler.sol`
- `contracts/handlers/DifficultyRangeHandler.sol`
- `contracts/handlers/BlockCountHandler.sol`
- `contracts/handlers/MiningDurationHandler.sol`
- `contracts/libraries/LibQuestionDispatcher.sol`

**MODIFIED FILES** (2):
- `contracts/facets/ConditionManagerFacet.sol`
- `contracts/libraries/LibOracleAdapter.sol`

**DELETED FILES** (1):
- `contracts/libraries/LibConditionMetadata.sol`

#### Cross-Currency Optimization

**MODIFIED FILES** (11-15):
- `contracts/libraries/LibDoefinStorage.sol`
- `contracts/libraries/LibOrderbook.sol`
- `contracts/libraries/LibQuoteCurrency.sol`
- `contracts/libraries/LibTradeSettlement.sol`
- `contracts/libraries/LibEscrowLogic.sol`
- `contracts/libraries/LibMatchEngine.sol`
- `test/unit/ExchangeFacet/ExchangeFacet.crossCurrency.basic.test.js`
- `test/unit/ExchangeFacet/ExchangeFacet.crossCurrency.test.js`
- Plus 3-7 integration test files

### Appendix B: Gas Cost Reference

| Operation | Cold Access | Warm Access |
|-----------|-------------|-------------|
| SSTORE (zero → non-zero) | 22,100 | 22,100 |
| SSTORE (modify non-zero) | 5,000 | 5,000 |
| SLOAD | 2,100 | 100 |
| Memory operation | 3 | 3 |

### Appendix C: Diamond Pattern Safety Rules

**CRITICAL RULES** (violating these can brick the contract):

1. ❌ Never remove fields from structs
2. ❌ Never reorder fields in structs
3. ❌ Never change field types (different slot sizes)
4. ✅ Always append new fields to end
5. ✅ Use single AppStorage library
6. ✅ Mark deprecated fields instead of removing

### Appendix D: Reference Documentation

**Internal Documents**:
- `.github/instructions/OracleRegistry.instructions.md`
- `.github/copilot-instructions.md`
- `docs/Comprehensive_Analysis.md`

**External Resources**:
- [EIP-2535 Diamond Standard](https://eips.ethereum.org/EIPS/eip-2535)
- [Solidity Storage Layout](https://docs.soliditylang.org/en/latest/internals/layout_in_storage.html)
- [EVM Opcodes Gas Costs](https://www.evm.codes/)

---

## Conclusion

This refactoring plan provides a systematic approach to improving Doefin V2's architecture and gas efficiency. The phased approach allows for:

1. **Quick wins** with Oracle Dispatcher (low risk, high value)
2. **Deferred optimization** for Cross-Currency (can wait until after feature completion)
3. **Established patterns** via Storage Optimization Guidelines

**Recommended Action**: 
✅ **Approve Phase 1 (Oracle Dispatcher)** - Start immediately  
📋 **Defer Phase 2 (Cross-Currency)** - Review after Phase 1 completion  
✅ **Adopt Guidelines** - Use for all future optimizations

---

**Document Prepared By**: GitHub Copilot (AI Assistant)  
**Review Status**: Pending Team Review  
**Next Review Date**: TBD  
**Approval Required From**: Lead Developer, Technical Architect
