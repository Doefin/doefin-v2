# Claude Code Instructions for Oracle Adapter Integration

## Context
You're working on Doefin V2, a decentralized exchange for Bitcoin difficulty options. We've just implemented an Oracle Adapter system that bridges the V1 Bitcoin block header oracle with the V2 CTF framework. The system handles 4 question types: DifficultyThreshold, DifficultyRange, BlockCount, and MiningDuration.

## What's Been Completed
1. ✅ LibDoefinStorage updated with Oracle Adapter structs and constants
2. ✅ LibOracleAdapter implemented with resolution logic
3. ✅ LibCTFCondition._reportPayouts() extracted for CTF integration
4. ✅ DoefinV1BlockHeaderOracle integrated with LibOracleAdapter
5. ✅ LibConditionMetadata created for encoding/decoding/validation
6. ✅ ConditionManagerFacet.createConditionWithMetadata() implemented

## Critical Issues to Fix First

### 1. Remove Unused Variable
**File:** `contracts/facets/ConditionManagerFacet.sol`
**Function:** `createConditionWithMetadata()`
**Issue:** `settlementTrigger` is calculated but never used
**Fix:** Remove the variable and change `_validateAndStoreQuestion()` to return `void`

### 2. Add Missing Import
**File:** `contracts/facets/ConditionManagerFacet.sol`
**Missing:** `import {LibCTHelpers} from "../libraries/LibCTHelpers.sol";`
**Reason:** Used in `_validateAndStoreQuestion()` for `getConditionId()`

### 3. Remove Resolved Fields from Storage Structs
**File:** `contracts/libraries/LibDoefinStorage.sol`
**Issue:** All 4 question structs have `resolved` and `winningIndex` fields, but we decided to remove questions from storage after resolution
**Fix:** Remove these fields from:
- `DifficultyThresholdQuestion`
- `DifficultyRangeQuestion`
- `BlockCountQuestion`
- `MiningDurationQuestion`

**Then update LibOracleAdapter.sol** to remove all references to `question.resolved = true` and `question.winningIndex = X`

## Next Priority Tasks

### Task 1: Create OracleAdapterFacet for Query Functions
Create a new facet with view functions:

```solidity
// contracts/facets/OracleAdapterFacet.sol
contract OracleAdapterFacet {
    // Query functions for frontend
    function getQuestionsAtBlock(uint256 blockHeight) external view returns (...);
    function getQuestionsAtTimestamp(uint256 timestamp) external view returns (...);
    function getTotalQuestionsCreated() external view returns (uint256);
    function getTotalQuestionsResolved() external view returns (uint256);
    function getBlockTimestamp(uint256 blockHeight) external view returns (uint256);
    function getTimestampBlock(uint256 timestamp) external view returns (uint256);
}
```

### Task 2: Add Missing Errors
**File:** `contracts/libraries/Errors.sol`
**Add these at the end of ORACLE ADAPTER ERRORS section:**
```solidity
error OracleAdapter_QuestionAlreadyExists();
error OracleAdapter_InvalidQuestionType();
error OracleAdapter_BucketsNotSorted();
error OracleAdapter_DuplicateBucketValue();
```

### Task 3: Write Unit Tests
Create comprehensive tests for:
- `test/LibOracleAdapter.t.sol` - Resolution logic tests
- `test/LibConditionMetadata.t.sol` - Encoding/decoding/validation tests
- `test/OracleIntegration.t.sol` - End-to-end flow tests

Focus on edge cases:
- Empty arrays
- Boundary conditions
- Ring buffer wraparound
- Multiple questions at same block

### Task 4: Add Question-Specific Events
**File:** `contracts/libraries/Events.sol`
**Add these events:**
```solidity
event QuestionCreated(
    bytes32 indexed questionId,
    bytes32 indexed conditionId,
    QuestionType questionType,
    uint256 settlementTrigger,
    address indexed creator
);

event QuestionResolved(
    bytes32 indexed questionId,
    bytes32 indexed conditionId,
    uint256 winningIndex,
    uint256 actualValue,
    uint256 blockHeight
);
```

**Update LibConditionMetadata and LibOracleAdapter** to emit these events

## Code Review Checklist
When reviewing or modifying the code, check:
- [ ] No storage layout changes to existing structs (Diamond pattern safety)
- [ ] All arrays have length checks before access
- [ ] Ring buffer index calculations use modulo correctly
- [ ] Timestamp bucketing uses integer division properly
- [ ] All external calls have proper error handling
- [ ] Gas optimization: prefer `calldata` over `memory` for external functions
- [ ] Events emitted for all state changes
- [ ] NatSpec comments on all public/external functions

## Architecture Notes
- **Oracle = Diamond contract (address(this))** - Not a separate contract
- **6-block settlement delay** - Hardcoded, no reorg handling needed
- **O(1) lookup** - Using mappings, not arrays for condition storage
- **Gas refund pattern** - Pop from arrays after resolution
- **Timestamp bucketing** - 600 seconds (10 min) for efficient lookup

## Testing Strategy
1. **Unit Tests** - Test each library function in isolation
2. **Integration Tests** - Test full create→submit→resolve flow
3. **Fuzzing** - Test with random bucket values, timestamps, block heights
4. **Gas Benchmarks** - Measure cost of creation and resolution
5. **Testnet Deploy** - Validate on Sepolia before mainnet

## Common Pitfalls to Avoid
- ❌ Don't use `msg.sender` in libraries (use parameters)
- ❌ Don't modify existing storage struct order (Diamond pattern)
- ❌ Don't forget settlement delay when calculating trigger
- ❌ Don't use `memory` for large arrays in external functions
- ❌ Don't assume ring buffer has 17 blocks (use constant)
- ❌ Don't forget to validate bucket arrays are sorted

## Files to Work With
**Core Implementation:**
- `contracts/libraries/LibDoefinStorage.sol` - Storage definitions
- `contracts/libraries/LibOracleAdapter.sol` - Resolution coordinator
- `contracts/libraries/LibConditionMetadata.sol` - Encoding/decoding
- `contracts/libraries/LibCTFCondition.sol` - CTF integration
- `contracts/facets/ConditionManagerFacet.sol` - Condition creation
- `contracts/facets/DoefinV1BlockHeaderOracle.sol` - Block submission

**Supporting Files:**
- `contracts/libraries/Errors.sol` - Error definitions
- `contracts/libraries/Events.sol` - Event definitions
- `contracts/libraries/BlockHeaderUtils.sol` - Bitcoin utilities

## Success Criteria
The integration is complete when:
1. ✅ All compiler errors resolved
2. ✅ All tests passing (unit + integration)
3. ✅ Gas benchmarks reasonable (<500k for resolution)
4. ✅ Testnet deployment successful
5. ✅ End-to-end flow validated: create → submit blocks → auto-resolve
6. ✅ Frontend can query and display question status

## Questions to Consider
- How should we handle duplicate questions? (Same params, different salt?)
- Should we allow question cancellation before resolution?
- Do we need pause/unpause for emergencies?
- Should resolution be callable by anyone or restricted?

---

**Start with the 3 critical fixes above, then proceed to Task 1 (Query Functions). Run tests after each change.**