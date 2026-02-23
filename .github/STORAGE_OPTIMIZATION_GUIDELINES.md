# Storage Optimization Guidelines

**Purpose**: Instructions for identifying and evaluating storage optimization opportunities in Solidity contracts, particularly within Diamond pattern (EIP-2535) architectures.

---

## Overview

Storage operations (SSTORE/SLOAD) are among the most expensive operations in Ethereum smart contracts. This guide helps identify opportunities to reduce gas costs through strategic storage optimization while avoiding premature optimization and maintaining code quality.

---

## Quick Reference: When to Optimize Storage

### ✅ Optimize When:
- Feature is rarely used (< 10% of transactions)
- Struct/mapping accessed in every transaction (hot path)
- Contract approaching 24 KB size limit
- Users complaining about gas costs
- Production data shows clear bottleneck

### ❌ Don't Optimize When:
- Feature in active development
- No production usage data available
- Optimization adds significant complexity (> 8 hours effort)
- Gas savings < 20,000 per transaction
- Breaking change required for existing deployments

---

## Identification Process

### Step 1: Profile Current Gas Usage

Use Hardhat gas reporter or manual profiling:

```javascript
// In hardhat.config.js
module.exports = {
  gasReporter: {
    enabled: true,
    currency: 'USD',
    outputFile: 'gas-report.txt',
    noColors: true,
  }
};
```

Run tests and identify expensive functions:
```bash
npx hardhat test --gas-reporter
```

**Look for**:
- Functions with > 300,000 gas usage
- Storage writes (SSTORE) as top gas consumers
- Repeated patterns across multiple functions

---

### Step 2: Identify Conditional Storage Patterns

**Search Pattern**: Look for structs/fields that are only populated in specific conditions.

#### Example 1: Feature-Specific Configuration (CrossCurrencyConfig case)

```solidity
// RED FLAG: Always stored, rarely used
struct Order {
    // ... common fields used by ALL orders
    uint256 amount;
    address maker;
    
    // 🚩 OPTIMIZATION OPPORTUNITY
    CrossCurrencyConfig crossCurrencyConfig;  // Only used by 5% of orders
}
```

**How to Identify**:
```bash
# Search for conditional checks around field usage
grep -r "if.*orderType.*CrossCurrency" contracts/
grep -r "if.*feature.*Enabled" contracts/

# Search for validation that checks "if field is zero"
grep -r "if.*== address(0)" contracts/
grep -r "if.*== 0)" contracts/
```

**Questions to Ask**:
1. Is this field only used when certain flags/enums are set?
2. Do validation functions check if field is zero/empty?
3. Can this field be moved to a separate mapping keyed by primary ID?
4. What percentage of records actually use this field?

---

#### Example 2: Optional Metadata

```solidity
// RED FLAG: Optional data in main struct
struct Asset {
    address token;
    uint256 balance;
    
    // 🚩 OPTIMIZATION OPPORTUNITY
    string description;      // Only set by admin, rarely accessed
    string imageUrl;         // Only for UI display
    mapping(uint256 => PriceHistory) history;  // Only for analytics
}
```

**Optimization Strategy**:
```solidity
// BETTER: Separate mappings for optional data
struct Asset {
    address token;
    uint256 balance;
}

mapping(address => string) public assetDescriptions;  // Admin-only, set separately
mapping(address => string) public assetImageUrls;    // UI-only
mapping(address => mapping(uint256 => PriceHistory)) public assetHistory;  // Analytics
```

---

### Step 3: Calculate Potential Savings

#### Gas Cost Reference (as of 2024-2025)

| Operation | Cold Access | Warm Access | Notes |
|-----------|-------------|-------------|-------|
| SSTORE (new value) | 22,100 | 5,000 | Writing to previously zero storage |
| SSTORE (modify) | 5,000 | 5,000 | Updating existing non-zero value |
| SLOAD | 2,100 | 100 | Reading from storage |
| Memory operation | 3 | 3 | RAM access (negligible) |

#### Calculation Formula

**Savings for moving field to mapping**:

```
Standard Case (field not used):
  Current Cost: 3 × SSTORE = 3 × 22,100 = 66,300 gas
  New Cost: 0 (no mapping write)
  SAVINGS: 66,300 gas

Special Case (field is used):
  Current Cost: 3 × SSTORE = 66,300 gas (inline)
  New Cost: 3 × SSTORE = 66,300 gas (mapping)
  SAVINGS: 0 gas
  OVERHEAD: +1 SLOAD per access = +2,100 gas per read
```

**Net Benefit Calculation**:
```
Let:
  P = Percentage of records that use the field (e.g., 0.05 for 5%)
  N = Total number of records created
  S = Storage slots saved (e.g., 3)
  R = Average number of reads per record lifecycle (e.g., 2)

Total Savings = N × (1-P) × S × 22,100
Total Overhead = N × P × R × 2,100

Net Savings = Total Savings - Total Overhead

Example (CrossCurrency case):
  N = 10,000 orders
  P = 0.05 (5% cross-currency)
  S = 3 slots
  R = 2 reads

Total Savings = 10,000 × 0.95 × 3 × 22,100 = 630,855,000 gas
Total Overhead = 10,000 × 0.05 × 2 × 2,100 = 2,100,000 gas
Net Savings = 628,755,000 gas (~628M gas)

At $2,000 ETH and 20 gwei:
  Cost Savings = 628M × 20 × 10^-9 × 2000 = $25,140
```

---

### Step 4: Assess Refactoring Complexity

Use this checklist to estimate effort:

#### Complexity Factors

| Factor | Low (1-2 hrs) | Medium (3-5 hrs) | High (6+ hrs) |
|--------|---------------|------------------|---------------|
| **Files affected** | 1-3 | 4-8 | 9+ |
| **Access points** | 1-10 | 11-30 | 31+ |
| **Test changes** | Minimal | Moderate | Extensive |
| **Migration needed** | No | Optional | Required |
| **Interface changes** | No | Internal only | Public API |

#### Search Commands to Assess Scope

```bash
# Count access points for a field
grep -r "\.fieldName" contracts/ | wc -l

# Find all struct definitions
grep -r "struct.*{" contracts/

# Find all files that reference the struct
grep -rl "StructName" contracts/

# Find external/public functions that use the field
grep -B5 "\.fieldName" contracts/ | grep -E "(function.*external|function.*public)"
```

#### Effort Decision Matrix

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

---

## Common Storage Optimization Patterns

### Pattern 1: Separate Mapping for Conditional Data

**Before**:
```solidity
struct Record {
    uint256 id;
    address owner;
    OptionalConfig config;  // Only used sometimes
}

mapping(uint256 => Record) records;
```

**After**:
```solidity
struct Record {
    uint256 id;
    address owner;
}

mapping(uint256 => Record) records;
mapping(uint256 => OptionalConfig) configs;  // Separate mapping
```

**When to Use**:
- Field used in < 30% of records
- Field contains multiple storage slots (> 32 bytes)
- Easy to key by same ID as main record

**Trade-offs**:
- ✅ Saves gas for common case
- ✅ Cleaner separation of concerns
- ⚠️ More verbose access code
- ⚠️ Additional SLOAD for special case
- ⚠️ Requires cleanup logic

---

### Pattern 2: Bit Packing for Flags/Small Values

**Before**:
```solidity
struct Order {
    OrderType orderType;        // 1 byte (but uses 32 bytes)
    OrderDirection direction;   // 1 byte (but uses 32 bytes)
    ExecutionType executionType;// 1 byte (but uses 32 bytes)
    bool active;                // 1 byte (but uses 32 bytes)
    bool fillOrKill;            // 1 byte (but uses 32 bytes)
}
// Total: 5 storage slots (160 bytes)
```

**After**:
```solidity
struct Order {
    uint8 flags;  // Bit-packed: [7:6]=orderType, [5:4]=direction, [3:2]=executionType, [1]=active, [0]=fillOrKill
}
// Total: 1 storage slot (32 bytes)

// Helper functions
function getOrderType(uint8 flags) internal pure returns (OrderType) {
    return OrderType((flags >> 6) & 0x03);
}

function setOrderType(uint8 flags, OrderType orderType) internal pure returns (uint8) {
    return (flags & 0x3F) | (uint8(orderType) << 6);
}
```

**When to Use**:
- Multiple small fields (< 8 bits each)
- Fields always accessed together
- Performance-critical hot path

**Trade-offs**:
- ✅ Massive gas savings (4 slots = ~88k gas)
- ✅ Single SLOAD for all flags
- ⚠️ Reduced readability
- ⚠️ More complex helper functions
- ⚠️ Risk of bit manipulation bugs

**Complexity**: Medium (3-5 hours)

---

### Pattern 3: Lazy Initialization

**Before**:
```solidity
struct User {
    address addr;
    uint256 totalOrders;     // Initialized to 0 for all users
    uint256 totalVolume;     // Initialized to 0 for all users
    uint256 lastActive;      // Initialized to 0 for all users
}

mapping(address => User) users;

function registerUser(address user) external {
    users[user] = User(user, 0, 0, 0);  // Wastes 3 SSTOREs for zeros
}
```

**After**:
```solidity
struct User {
    address addr;
    uint256 totalOrders;
    uint256 totalVolume;
    uint256 lastActive;
}

mapping(address => User) users;

function registerUser(address user) external {
    // Only set non-zero field
    users[user].addr = user;
    // Other fields remain zero (no SSTORE needed)
}

function incrementOrders(address user) external {
    if (users[user].addr == address(0)) revert UserNotRegistered();
    users[user].totalOrders++;  // First write: 22,100 gas (zero → non-zero)
}
```

**When to Use**:
- Struct has many zero-default fields
- Fields updated independently over time
- User registration separate from first usage

**Trade-offs**:
- ✅ Saves gas on initialization (22k per avoided slot)
- ✅ Pay-as-you-go model (only pay for what you use)
- ⚠️ First access more expensive (cold SSTORE)
- ⚠️ Requires existence checks before access

**Complexity**: Low (1-2 hours)

---

### Pattern 4: Storage vs Memory for Temporary Data

**Before**:
```solidity
struct TempCalculation {
    uint256 intermediateResult;
    uint256 adjustment;
    uint256 finalResult;
}

TempCalculation storage temp;  // 🚩 Using storage for temporary data

function calculate() external {
    temp.intermediateResult = step1();  // SSTORE: 22,100 gas
    temp.adjustment = step2();          // SSTORE: 22,100 gas
    temp.finalResult = step3();         // SSTORE: 22,100 gas
    // Total: 66,300 gas wasted
}
```

**After**:
```solidity
struct TempCalculation {
    uint256 intermediateResult;
    uint256 adjustment;
    uint256 finalResult;
}

function calculate() external {
    TempCalculation memory temp;  // ✅ Use memory for temporary data
    temp.intermediateResult = step1();  // Memory: ~3 gas
    temp.adjustment = step2();          // Memory: ~3 gas
    temp.finalResult = step3();         // Memory: ~3 gas
    // Total: ~9 gas (66,291 gas saved!)
    
    // Only persist final result if needed
    finalResults[msg.sender] = temp.finalResult;  // SSTORE: 22,100 gas
}
```

**When to Use**:
- Data only needed within single transaction
- Complex calculations with intermediate steps
- No cross-transaction persistence needed

**Trade-offs**:
- ✅ Massive gas savings (99% reduction for temp data)
- ✅ No cleanup needed
- ✅ Thread-safe (no shared state)
- ⚠️ Data lost after transaction

**Complexity**: Low (1 hour)

---

### Pattern 5: Packed Arrays for Homogeneous Data

**Before**:
```solidity
struct Order {
    uint8 status;      // 1 byte in 32-byte slot
    uint16 feeBps;     // 2 bytes in 32-byte slot
    uint32 timestamp;  // 4 bytes in 32-byte slot
}

Order[] public orders;  // Each order uses 3 storage slots
```

**After**:
```solidity
// Pack multiple orders into single slots
uint256[] public packedOrders;  // Each slot holds ~7 orders (32 bytes / 7 bytes ≈ 4.5)

// Packing: [status:8][feeBps:16][timestamp:32] = 56 bits = 7 bytes per order

function packOrder(uint8 status, uint16 feeBps, uint32 timestamp) internal pure returns (uint56) {
    return uint56(status) << 48 | uint56(feeBps) << 32 | uint56(timestamp);
}

function unpackOrder(uint56 packed) internal pure returns (uint8 status, uint16 feeBps, uint32 timestamp) {
    status = uint8(packed >> 48);
    feeBps = uint16(packed >> 32);
    timestamp = uint32(packed);
}
```

**When to Use**:
- Array of small structs (< 32 bytes total)
- Batch operations common
- Sequential access pattern

**Trade-offs**:
- ✅ Saves storage slots (3x → 1x)
- ✅ Better for batch reads
- ⚠️ Complex packing/unpacking logic
- ⚠️ Fixed schema (hard to add fields)
- ⚠️ Max 32 bytes per slot

**Complexity**: High (6+ hours)

---

## Optimization Workflow

### Phase 1: Discovery (2-3 hours)

1. **Run gas profiler** on test suite
2. **Identify expensive functions** (> 300k gas)
3. **List storage-heavy structs** (> 5 fields)
4. **Search for conditional patterns**:
   ```bash
   grep -r "if.*orderType" contracts/
   grep -r "if.*\..*== address(0)" contracts/
   grep -r "if.*\..*== 0)" contracts/
   ```
5. **Calculate usage percentages** (review events/logs)

### Phase 2: Analysis (1-2 hours)

6. **Estimate gas savings** using formula from Step 3
7. **Count access points**:
   ```bash
   grep -r "\.fieldName" contracts/ | wc -l
   ```
8. **Assess complexity** using decision matrix
9. **Check migration needs** (production data exists?)
10. **Document findings** in tracking issue

### Phase 3: Decision (30 min)

11. **Apply decision matrix**:
    - Savings > 100k + Low complexity = Do now ✅
    - Savings > 100k + High complexity = Document & plan 📋
    - Savings < 50k = Skip ❌
12. **Get team approval** if High complexity
13. **Create implementation ticket** or documentation

### Phase 4: Implementation (Variable)

14. **Create feature branch** (`feature/storage-optimization-ISSUE`)
15. **Implement changes** per documented pattern
16. **Update all access points** (use multi-file search)
17. **Update tests** (gas assertions may change)
18. **Verify gas savings** with profiler

### Phase 5: Validation (2-3 hours)

19. **Run full test suite** (must pass 100%)
20. **Compare gas reports** (before/after)
21. **Deploy to testnet** and verify
22. **Code review** focusing on storage safety
23. **Merge and document** savings

---

## Storage Safety Rules (Diamond Pattern Specific)

### ⚠️ Critical Rules for EIP-2535

1. **Never remove fields from structs**
   ```solidity
   // ❌ DANGEROUS
   struct AppStorage {
       uint256 field1;
       // uint256 field2;  // Removing this corrupts storage!
       uint256 field3;
   }
   
   // ✅ SAFE: Mark as deprecated instead
   struct AppStorage {
       uint256 field1;
       uint256 field2_DEPRECATED;  // Keep slot, don't use
       uint256 field3;
   }
   ```

2. **Never reorder fields in structs**
   ```solidity
   // ❌ DANGEROUS
   struct AppStorage {
       uint256 field2;  // Swapped!
       uint256 field1;  // Swapped!
   }
   
   // ✅ SAFE: Always append new fields
   struct AppStorage {
       uint256 field1;
       uint256 field2;
       uint256 field3_NEW;  // Append only
   }
   ```

3. **Never change field types** (different slot sizes)
   ```solidity
   // ❌ DANGEROUS
   struct AppStorage {
       uint128 field1;  // Was uint256 before!
   }
   
   // ✅ SAFE: Add new field with new type
   struct AppStorage {
       uint256 field1_DEPRECATED;
       uint128 field1_v2;
   }
   ```

4. **Always use same storage library**
   ```solidity
   // ❌ DANGEROUS: Multiple storage libraries
   library LibStorageA {
       bytes32 constant POSITION = keccak256("storage.a");
   }
   library LibStorageB {
       bytes32 constant POSITION = keccak256("storage.b");
   }
   
   // ✅ SAFE: Single AppStorage in one library
   library LibDoefinStorage {
       function appStorage() internal pure returns (AppStorage storage ds) {
           assembly { ds.slot := 0 }
       }
   }
   ```

---

## Testing Checklist

### Gas Testing
- [ ] Baseline gas report generated (before optimization)
- [ ] Post-optimization gas report generated
- [ ] Savings match expected calculations (±10%)
- [ ] No regressions in unrelated functions

### Functional Testing
- [ ] All existing tests pass
- [ ] New tests for optimization edge cases
- [ ] Test cleanup logic (if separate mapping added)
- [ ] Test with zero/empty values
- [ ] Test with boundary values (max uint, etc.)

### Integration Testing
- [ ] Full order lifecycle (create → match → settle → cancel)
- [ ] Cross-facet interactions work correctly
- [ ] Events still emit correct data
- [ ] View functions return correct values

### Storage Testing
- [ ] Verify storage slots not corrupted (use `hardhat-storage-layout`)
- [ ] Test migration if production deployment exists
- [ ] Verify cleanup doesn't leave orphaned data
- [ ] Check mapping keys don't collide

### Tools for Testing

```bash
# Install storage layout plugin
npm install --save-dev hardhat-storage-layout

# Generate storage layout report
npx hardhat check

# Compare before/after layouts
npx hardhat storage-layout --contract OrderCreationFacet > before.txt
# ... make changes ...
npx hardhat storage-layout --contract OrderCreationFacet > after.txt
diff before.txt after.txt
```

---

## Documentation Requirements

For each optimization, document:

### In Code Comments
```solidity
/**
 * @notice CrossCurrencyConfig stored in separate mapping for gas optimization
 * @dev Standard orders (95% of volume) save ~60k gas by not storing empty config
 *      Cross-currency orders pay ~2k extra gas per config access (SLOAD)
 * @dev Added: v2.1.0 (Nov 2025) - See CROSS_CURRENCY_STORAGE_OPTIMIZATION.md
 */
mapping(uint256 => CrossCurrencyConfig) public crossCurrencyConfigs;
```

### In Optimization Document
- **Before/After Code**: Show clear comparison
- **Gas Savings Calculation**: Show math with real numbers
- **Affected Files**: Complete list with line numbers
- **Migration Strategy**: If production deployment
- **Test Plan**: What needs testing
- **Rollback Plan**: How to undo if issues arise

### In Commit Message
```
feat: optimize storage for standard orders (DOE-XXX)

- Moved CrossCurrencyConfig to separate mapping
- Saves ~60k gas per standard order creation
- Cross-currency orders pay ~2k extra per access
- Net savings: ~57M gas per 1000 mixed orders

Affected files:
- LibDoefinStorage.sol: Add crossCurrencyConfigs mapping
- LibOrderbook.sol: Update create/cancel logic
- LibQuoteCurrency.sol: Update 8 access points
- (+ 8 more files)

Breaking changes: None (internal storage only)

Testing: All tests pass, gas reports confirm savings
```

---

## Red Flags to Avoid

### ❌ Don't Optimize If:

1. **Unclear Usage Patterns**
   - No production data available
   - Feature still in development
   - Usage percentages unknown

2. **Complex Migration Required**
   - Production deployment with active data
   - No clear migration path
   - Risk of data loss

3. **Readability Severely Impacted**
   - Bit manipulation everywhere
   - Requires extensive comments to understand
   - Junior devs can't maintain

4. **Minimal Savings**
   - < 20,000 gas saved per transaction
   - < $1 saved at current gas prices
   - Optimization takes > 4 hours

5. **External Dependencies**
   - Public struct in external interface
   - Third-party integrations rely on structure
   - Breaking change to published API

---

## Example: Full Analysis Template

Use this template for documenting potential optimizations:

```markdown
# Storage Optimization: [Feature Name]

## Summary
- **Current Cost**: XXX gas
- **Optimized Cost**: YYY gas
- **Savings**: ZZZ gas (MM%)
- **Complexity**: Low/Medium/High
- **Recommendation**: Implement Now / Document for Later / Skip

## Current Implementation
[Code snippet showing current approach]

## Problem
- Field X uses N storage slots
- Only used in P% of cases
- Wastes Z gas per transaction

## Proposed Solution
[Code snippet showing optimized approach]

## Impact Analysis
- **Files Affected**: N files
- **Access Points**: M locations
- **Test Changes**: Low/Medium/High
- **Migration**: Required/Optional/None

## Gas Calculation
[Show detailed math]

## Implementation Plan
1. Phase 1: ...
2. Phase 2: ...
3. Testing: ...

## Risk Assessment
- Risk 1: ...
- Risk 2: ...
- Mitigation: ...

## Decision
[Approved/Deferred/Rejected] by [Name] on [Date]
```

---

## Tools & Resources

### Hardhat Plugins
```bash
npm install --save-dev hardhat-gas-reporter
npm install --save-dev hardhat-storage-layout
npm install --save-dev hardhat-contract-sizer
```

### Analysis Tools
- **eth-gas-reporter**: Track gas usage per function
- **solidity-coverage**: Ensure optimizations don't break tests
- **slither**: Static analysis for storage bugs

### Reference Documentation
- [EVM Opcodes Gas Costs](https://www.evm.codes/)
- [Solidity Storage Layout](https://docs.soliditylang.org/en/latest/internals/layout_in_storage.html)
- [EIP-2535 Diamond Standard](https://eips.ethereum.org/EIPS/eip-2535)
- [Foundry Gas Snapshots](https://book.getfoundry.sh/forge/gas-snapshots)

---

## Summary Checklist

Before implementing any storage optimization:

- [ ] Gas profiling shows clear bottleneck (> 100k gas savings potential)
- [ ] Usage data confirms field is conditional (< 30% usage)
- [ ] Complexity assessment shows reasonable effort (< 8 hours)
- [ ] No breaking changes to external interfaces
- [ ] Migration strategy documented (if needed)
- [ ] Test plan covers all edge cases
- [ ] Team approval obtained (if High complexity)
- [ ] Documentation prepared (code comments + separate doc)
- [ ] Rollback plan ready

If all checkboxes pass: ✅ **Proceed with optimization**  
If any checkbox fails: ⚠️ **Document and defer** or ❌ **Skip entirely**

---

**Document Version**: 1.0  
**Last Updated**: November 27, 2025  
**Author**: GitHub Copilot (AI Assistant)  
**Purpose**: Standardize storage optimization identification and evaluation process
