# Claude Code Instructions: Refactor to Dispatcher Pattern

## Context
You're refactoring the Doefin V2 Oracle Adapter system from a monolithic architecture to a dispatcher pattern. This will make adding new question types much easier and reduce coupling between components.

**Current State:**
- 4 question types: DifficultyThreshold, DifficultyRange, BlockCount, MiningDuration
- Logic scattered across 4-5 files with large switch statements
- Each new question type requires modifying multiple core files

**Goal State:**
- Centralized dispatcher that routes to isolated handler libraries
- Each question type in its own handler file
- Core contracts remain stable when adding new types

## Architecture Overview

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

---

## Phase 1: Create Handler Interface Pattern

### Step 1.1: Create Handler Directory Structure
```bash
contracts/
├── handlers/                          # NEW directory
│   ├── DifficultyThresholdHandler.sol
│   ├── DifficultyRangeHandler.sol
│   ├── BlockCountHandler.sol
│   └── MiningDurationHandler.sol
├── libraries/
│   └── LibQuestionDispatcher.sol      # NEW file
```

### Step 1.2: Create Handler Template

Each handler must implement this exact pattern:

```solidity
library [QuestionType]Handler {
    
    // REQUIRED: Metadata struct for this question type
    struct Metadata {
        // Question-specific parameters
    }
    
    // REQUIRED: Encode metadata to bytes
    function encode(Metadata memory meta) internal pure returns (bytes memory)
    
    // REQUIRED: Decode bytes to metadata
    function decode(bytes memory data) internal pure returns (Metadata memory)
    
    // REQUIRED: Validate question parameters
    function validate(
        bytes memory metadata,
        uint8 outcomeSlotCount,
        uint256 currentBlockHeight
    ) internal view returns (bool)
    
    // REQUIRED: Calculate when this question can be resolved
    // triggerType: 0 = block-based, 1 = timestamp-based
    function getTrigger(
        bytes memory metadata,
        uint256 currentBlockHeight
    ) internal pure returns (uint8 triggerType, uint256 triggerValue)
    
    // REQUIRED: Store question in appropriate storage location
    function store(
        bytes32 questionId,
        bytes32 conditionId,
        bytes memory metadata,
        uint256 triggerValue
    ) internal
    
    // REQUIRED: Resolve the question and return payout vector
    function resolve(
        bytes memory metadata,
        uint8 outcomeSlotCount
    ) internal view returns (uint256[] memory payouts)
}
```

### Step 1.3: Extract DifficultyThresholdHandler

**Source files to extract from:**
- `LibConditionMetadata.sol` - validation logic
- `LibOracleAdapter.sol` - resolution logic
- `ConditionManagerFacet.sol` - storage logic

**Create:** `contracts/handlers/DifficultyThresholdHandler.sol`

**Extract these pieces:**
```solidity
// From LibConditionMetadata:
- encodeDifficultyThreshold() → encode()
- decodeDifficultyThreshold() → decode()
- validateDifficultyThreshold() → validate()

// From ConditionManagerFacet._validateAndStoreQuestion():
- DifficultyThreshold case storage logic → store()

// From LibOracleAdapter:
- _resolveDifficultyThresholdQuestion() → resolve()
- Calculate settlement trigger logic → getTrigger()
```

**Key transformations:**
1. Move validation from `validateDifficultyThreshold(...)` to handler's `validate(...)`
2. Move resolution from `_resolveDifficultyThresholdQuestion(...)` to handler's `resolve(...)`
3. Keep helper functions private within handler (e.g., `_getBlockDifficulty`)
4. Remove all references to LibConditionMetadata functions - everything self-contained

**Template structure:**
```solidity
// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {BlockHeaderUtils} from "../libraries/BlockHeaderUtils.sol";
import {Errors} from "../libraries/Errors.sol";

library DifficultyThresholdHandler {
    
    struct Metadata {
        uint256 threshold;
        uint256 targetBlockHeight;
    }
    
    function encode(Metadata memory meta) internal pure returns (bytes memory) {
        return abi.encode(meta.threshold, meta.targetBlockHeight);
    }
    
    function decode(bytes memory data) internal pure returns (Metadata memory) {
        (uint256 threshold, uint256 targetBlockHeight) = abi.decode(data, (uint256, uint256));
        return Metadata(threshold, targetBlockHeight);
    }
    
    function validate(
        bytes memory metadata,
        uint8 outcomeSlotCount,
        uint256 currentBlockHeight
    ) internal pure returns (bool) {
        // Extract from validateDifficultyThreshold in LibConditionMetadata
        // Return bool instead of reverting
    }
    
    function getTrigger(
        bytes memory metadata,
        uint256 currentBlockHeight
    ) internal pure returns (uint8 triggerType, uint256 triggerValue) {
        Metadata memory meta = decode(metadata);
        triggerType = 0; // Block-based
        triggerValue = meta.targetBlockHeight + LibDoefinStorage.SETTLEMENT_DELAY;
    }
    
    function store(
        bytes32 questionId,
        bytes32 conditionId,
        bytes memory metadata,
        uint256 triggerValue
    ) internal {
        // Extract from ConditionManagerFacet._validateAndStoreQuestion()
        // DifficultyThreshold case
    }
    
    function resolve(
        bytes memory metadata,
        uint8 outcomeSlotCount
    ) internal view returns (uint256[] memory payouts) {
        // Extract from LibOracleAdapter._resolveDifficultyThresholdQuestion()
        // Remove storage parameter, work only with metadata
    }
    
    // Private helpers
    function _getBlockDifficulty(uint256 blockHeight) private view returns (uint256) {
        // Copy from LibOracleAdapter
    }
}
```

### Step 1.4: Repeat for Other Handlers

Create in order:
1. ✅ `DifficultyThresholdHandler.sol` (simplest - good template)
2. `DifficultyRangeHandler.sol` (similar to threshold)
3. `MiningDurationHandler.sol` (block-based)
4. `BlockCountHandler.sol` (timestamp-based)

**For each handler:**
- Extract validation from `LibConditionMetadata.sol`
- Extract resolution from `LibOracleAdapter.sol`
- Extract storage from `ConditionManagerFacet.sol`
- Make self-contained with private helpers
- Test compilation after each handler

---

## Phase 2: Create Dispatcher

### Step 2.1: Create LibQuestionDispatcher.sol

**Location:** `contracts/libraries/LibQuestionDispatcher.sol`

**Structure:**
```solidity
// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {DifficultyThresholdHandler} from "../handlers/DifficultyThresholdHandler.sol";
import {DifficultyRangeHandler} from "../handlers/DifficultyRangeHandler.sol";
import {BlockCountHandler} from "../handlers/BlockCountHandler.sol";
import {MiningDurationHandler} from "../handlers/MiningDurationHandler.sol";

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
        } else if (questionType == LibDoefinStorage.QuestionType.DifficultyRange) {
            return DifficultyRangeHandler.validate(metadata, outcomeSlotCount, currentBlockHeight);
        } else if (questionType == LibDoefinStorage.QuestionType.BlockCount) {
            return BlockCountHandler.validate(metadata, outcomeSlotCount, currentBlockHeight);
        } else if (questionType == LibDoefinStorage.QuestionType.MiningDuration) {
            return MiningDurationHandler.validate(metadata, outcomeSlotCount, currentBlockHeight);
        }
        return false;
    }
    
    // Dispatch trigger calculation
    function getResolutionTrigger(
        LibDoefinStorage.QuestionType questionType,
        bytes memory metadata,
        uint256 currentBlockHeight
    ) internal pure returns (uint8 triggerType, uint256 triggerValue) {
        if (questionType == LibDoefinStorage.QuestionType.DifficultyThreshold) {
            return DifficultyThresholdHandler.getTrigger(metadata, currentBlockHeight);
        } else if (questionType == LibDoefinStorage.QuestionType.DifficultyRange) {
            return DifficultyRangeHandler.getTrigger(metadata, currentBlockHeight);
        } else if (questionType == LibDoefinStorage.QuestionType.BlockCount) {
            return BlockCountHandler.getTrigger(metadata, currentBlockHeight);
        } else if (questionType == LibDoefinStorage.QuestionType.MiningDuration) {
            return MiningDurationHandler.getTrigger(metadata, currentBlockHeight);
        }
        revert("Unknown question type");
    }
    
    // Dispatch storage
    function storeQuestion(
        LibDoefinStorage.QuestionType questionType,
        bytes32 questionId,
        bytes32 conditionId,
        bytes memory metadata,
        uint256 triggerValue
    ) internal {
        if (questionType == LibDoefinStorage.QuestionType.DifficultyThreshold) {
            DifficultyThresholdHandler.store(questionId, conditionId, metadata, triggerValue);
        } else if (questionType == LibDoefinStorage.QuestionType.DifficultyRange) {
            DifficultyRangeHandler.store(questionId, conditionId, metadata, triggerValue);
        } else if (questionType == LibDoefinStorage.QuestionType.BlockCount) {
            BlockCountHandler.store(questionId, conditionId, metadata, triggerValue);
        } else if (questionType == LibDoefinStorage.QuestionType.MiningDuration) {
            MiningDurationHandler.store(questionId, conditionId, metadata, triggerValue);
        } else {
            revert("Unknown question type");
        }
    }
    
    // Dispatch resolution
    function resolveQuestion(
        LibDoefinStorage.QuestionType questionType,
        bytes memory metadata,
        uint8 outcomeSlotCount
    ) internal view returns (uint256[] memory) {
        if (questionType == LibDoefinStorage.QuestionType.DifficultyThreshold) {
            return DifficultyThresholdHandler.resolve(metadata, outcomeSlotCount);
        } else if (questionType == LibDoefinStorage.QuestionType.DifficultyRange) {
            return DifficultyRangeHandler.resolve(metadata, outcomeSlotCount);
        } else if (questionType == LibDoefinStorage.QuestionType.BlockCount) {
            return BlockCountHandler.resolve(metadata, outcomeSlotCount);
        } else if (questionType == LibDoefinStorage.QuestionType.MiningDuration) {
            return MiningDurationHandler.resolve(metadata, outcomeSlotCount);
        }
        revert("Unknown question type");
    }
}
```

**Critical:** Each dispatch function follows same pattern:
1. If statement for each question type
2. Call corresponding handler function
3. Return or revert if unknown type

---

## Phase 3: Refactor Core Contracts

### Step 3.1: Update ConditionManagerFacet

**File:** `contracts/facets/ConditionManagerFacet.sol`

**Changes:**

1. **Add imports:**
```solidity
import {LibQuestionDispatcher} from "../libraries/LibQuestionDispatcher.sol";
// Remove: import {LibConditionMetadata} from "../libraries/LibConditionMetadata.sol";
```

2. **Replace createConditionWithMetadata() entirely:**

**Old signature:**
```solidity
function createConditionWithMetadata(
    LibDoefinStorage.QuestionType questionType,
    bytes calldata metadata,
    uint8 outcomeSlotCount,
    string calldata metadataURI,
    bytes32 salt
) external returns (bytes32 conditionId, bytes32 questionId)
```

**Keep same signature, replace implementation:**
```solidity
function createConditionWithMetadata(
    LibDoefinStorage.QuestionType questionType,
    bytes calldata metadata,
    uint8 outcomeSlotCount,
    string calldata metadataURI,
    bytes32 salt
) external returns (bytes32 conditionId, bytes32 questionId) {
    LibAccessControl.enforceIsMarketMaker();
    
    if (outcomeSlotCount <= 1) {
        revert Errors.InvalidOutcomeSlotCount();
    }
    
    LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
    uint256 currentBlockHeight = ds.blockHeaderOracleStorage.currentBlockHeight;
    
    // Validate using dispatcher
    bool isValid = LibQuestionDispatcher.validate(
        questionType,
        metadata,
        outcomeSlotCount,
        currentBlockHeight
    );
    
    if (!isValid) {
        revert Errors.ValueOutOfRange();
    }
    
    // Generate questionId
    questionId = keccak256(abi.encode(questionType, keccak256(metadata), salt));
    
    // Prepare condition in CTF
    conditionId = LibCTFCondition.prepareCondition(address(this), questionId, outcomeSlotCount);
    
    // Get trigger using dispatcher
    (uint8 triggerType, uint256 triggerValue) = LibQuestionDispatcher.getResolutionTrigger(
        questionType,
        metadata,
        currentBlockHeight
    );
    
    // Store using dispatcher
    LibQuestionDispatcher.storeQuestion(
        questionType,
        questionId,
        conditionId,
        metadata,
        triggerValue
    );
    
    // Store condition metadata
    ds.conditionalTokens.conditions[conditionId] = LibDoefinStorage.Condition({
        oracle: address(this),
        questionId: questionId,
        outcomeSlotCount: outcomeSlotCount,
        metadataURI: metadataURI,
        active: true,
        creator: msg.sender
    });
    
    ds.oracleAdapterStorage.totalQuestionsCreated++;
    
    emit Events.ConditionCreated(conditionId, address(this), questionId, outcomeSlotCount, metadataURI, msg.sender);
    
    return (conditionId, questionId);
}
```

3. **Delete _validateAndStoreQuestion() entirely** - no longer needed

4. **Remove unused settlementTrigger variable** (as discussed earlier)

### Step 3.2: Update LibOracleAdapter

**File:** `contracts/libraries/LibOracleAdapter.sol`

**Challenge:** Resolution currently uses type-specific structs from storage. We need to either:
- **Option A:** Keep type-specific resolution loops (recommended for now)
- **Option B:** Store metadata with questions for generic resolution

**Recommended: Option A (Minimal Changes)**

**Changes:**

1. **Add import:**
```solidity
import {DifficultyThresholdHandler} from "../handlers/DifficultyThresholdHandler.sol";
import {DifficultyRangeHandler} from "../handlers/DifficultyRangeHandler.sol";
import {BlockCountHandler} from "../handlers/BlockCountHandler.sol";
import {MiningDurationHandler} from "../handlers/MiningDurationHandler.sol";
```

2. **Update resolution functions to use handlers:**

**Old:**
```solidity
function _resolveDifficultyThresholdQuestion(
    LibDoefinStorage.DifficultyThresholdQuestion storage question,
    uint256 blockHeight
) private {
    // Inline resolution logic
    uint256 actualDifficulty = _getBlockDifficulty(question.targetBlockHeight);
    
    uint256[] memory payouts = new uint256[](2);
    if (actualDifficulty > question.threshold) {
        payouts[1] = 1;
    } else {
        payouts[0] = 1;
    }
    
    question.resolved = true;
    question.winningIndex = ...;
    
    LibCTFCondition._reportPayouts(...);
    ds.oracleAdapterStorage.totalQuestionsResolved++;
}
```

**New:**
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
    
    question.resolved = true;
    question.winningIndex = payouts[1] == 1 ? 1 : 0;
    
    // Report to CTF
    LibCTFCondition._reportPayouts(address(this), question.questionId, payouts);
    
    ds.oracleAdapterStorage.totalQuestionsResolved++;
}
```

3. **Repeat for all 4 resolution functions:**
   - `_resolveDifficultyThresholdQuestion`
   - `_resolveDifficultyRangeQuestion`
   - `_resolveBlockCountQuestion`
   - `_resolveMiningDurationQuestion`

4. **Delete helper functions that moved to handlers:**
   - `_getBlockDifficulty` (now in DifficultyThresholdHandler and DifficultyRangeHandler)
   - `_findBucketIndex` (now in each handler that needs it)
   - Any other helpers that were extracted

5. **Keep these helper functions:**
   - `getTimestampBucket`
   - `_updateAuxiliaryMappings`
   - `_findBlockByTimestamp`
   - `_getBlockHeaderByNumber`
   - `_getLatestBlockHeader`

### Step 3.3: Delete/Archive LibConditionMetadata.sol

**File:** `contracts/libraries/LibConditionMetadata.sol`

**Action:** Delete this file entirely

**Reason:** All encoding/decoding/validation logic is now in handlers

**Before deleting, verify:**
- No imports of LibConditionMetadata remain
- All functions migrated to handlers
- Tests updated to use handlers directly

---

## Phase 4: Update Storage (Optional Optimization)

### Current Storage Structure (Keep As-Is for Now)
```solidity
struct OracleAdapterStorage {
    mapping(uint256 => DifficultyThresholdQuestion[]) blockToThresholdQuestions;
    mapping(uint256 => DifficultyRangeQuestion[]) blockToRangeQuestions;
    mapping(uint256 => MiningDurationQuestion[]) blockToDurationQuestions;
    mapping(uint256 => BlockCountQuestion[]) timestampToBlockCountQuestions;
    // ...
}
```

**Keep this structure** - It's gas-efficient and type-safe

**Future optimization (after testing):** Consider unified storage with metadata
```solidity
struct ResolutionMetadata {
    uint8 questionType;
    bytes metadata;
    bytes32 questionId;
    bytes32 conditionId;
    uint8 outcomeSlotCount;
}

mapping(uint256 => ResolutionMetadata[]) blockToResolutions;
mapping(uint256 => ResolutionMetadata[]) timestampToResolutions;
```

---

## Phase 5: Testing Strategy

### Step 5.1: Unit Test Each Handler
```solidity
// test/handlers/DifficultyThresholdHandler.t.sol
contract DifficultyThresholdHandlerTest is Test {
    function test_encode_decode() public {
        // Test encoding/decoding
    }
    
    function test_validate_success() public {
        // Test validation with valid params
    }
    
    function test_validate_failure() public {
        // Test validation with invalid params
    }
    
    function test_getTrigger() public {
        // Test trigger calculation
    }
    
    function test_resolve() public {
        // Test resolution logic
    }
}
```

### Step 5.2: Integration Tests
```solidity
// test/integration/OracleDispatcher.t.sol
contract OracleDispatcherTest is Test {
    function test_createAndResolve_allTypes() public {
        // Create condition for each type
        // Submit blocks
        // Verify resolution
    }
}
```

### Step 5.3: Regression Tests
- Run all existing tests
- Verify no behavior changes
- Check gas usage hasn't increased significantly

---

## Phase 6: Verification Checklist

### Before Merging:

- [ ] All 4 handlers created and compile successfully
- [ ] LibQuestionDispatcher created with all 4 dispatch functions
- [ ] ConditionManagerFacet refactored to use dispatcher
- [ ] LibOracleAdapter updated to call handlers
- [ ] LibConditionMetadata.sol deleted
- [ ] All imports updated
- [ ] No compiler errors or warnings
- [ ] All existing tests pass
- [ ] New handler unit tests added
- [ ] Gas benchmarks comparable to old implementation
- [ ] Code review completed
- [ ] Documentation updated

### Files Modified Summary:
```
NEW FILES (4 handlers + 1 dispatcher):
+ contracts/handlers/DifficultyThresholdHandler.sol
+ contracts/handlers/DifficultyRangeHandler.sol  
+ contracts/handlers/BlockCountHandler.sol
+ contracts/handlers/MiningDurationHandler.sol
+ contracts/libraries/LibQuestionDispatcher.sol

MODIFIED FILES (2):
~ contracts/facets/ConditionManagerFacet.sol (simplified)
~ contracts/libraries/LibOracleAdapter.sol (calls handlers)

DELETED FILES (1):
- contracts/libraries/LibConditionMetadata.sol
```

---

## Common Pitfalls to Avoid

### ❌ Don't:
1. Change storage layout in LibDoefinStorage (Diamond pattern safety)
2. Make handlers use external calls (keep everything internal)
3. Forget to handle all 4 types in each dispatcher function
4. Leave dead code in LibOracleAdapter after refactor
5. Forget to update tests
6. Skip compilation after each handler creation

### ✅ Do:
1. Extract one handler at a time and test compilation
2. Keep helper functions private within handlers
3. Follow exact handler interface pattern
4. Test each handler in isolation
5. Verify gas costs haven't significantly increased
6. Update documentation as you go

---

## Rollback Plan

If issues arise:
1. Revert to previous commit (before refactor)
2. Keep handler files for reference
3. Implement handlers one at a time with testing
4. Merge incrementally, not all at once

---

## Success Criteria

Refactoring is complete when:
1. ✅ All tests pass
2. ✅ Gas costs within 5% of original
3. ✅ Adding new question type only requires:
   - Add enum variant (1 line)
   - Create handler file (~120 lines)
   - Add 4 dispatch cases (20 lines)
4. ✅ Code review approved
5. ✅ No regression in functionality

---

## Post-Refactor Benefits

After refactoring, adding new question types will be:
- **80% less code in core contracts** (4 lines vs 150 lines)
- **50% less time** (2 hours vs 4+ hours)
- **70% less bug risk** (isolated testing)
- **100% easier to review** (one handler file vs 5 modified files)

---

**Start with Phase 1, Step 1.3 (DifficultyThresholdHandler) and work sequentially. Test after each phase.**

Good luck! 🚀