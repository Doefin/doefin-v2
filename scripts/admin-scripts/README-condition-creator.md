# Bitcoin Difficulty Condition Creator

Simple script to create Bitcoin difficulty prediction markets using `createConditionWithMetadata()`.

## Quick Setup

### 1. Environment Variables
Set in your `.env` file:
```bash
DIAMOND_ADDRESS=0xe705E1eBafF4270DC5ce74D405068221Ec3e1ABd
```

### 2. Configure Question Parameters
Edit these variables in the script:

```javascript
// === SIMPLE CONFIGURATION - EDIT THESE VALUES DIRECTLY ===
const TARGET_BLOCK_HEIGHT = 933408;  // Bitcoin block number to target
const TARGET_DIFFICULTY = "147000000000000";  // Target difficulty (147T)
```

**For Threshold Questions:**
- `TARGET_BLOCK_HEIGHT`: Bitcoin block number when to check difficulty
- `TARGET_DIFFICULTY`: Difficulty threshold (in raw format, 147T = "147000000000000")

### 3. Run Script
```bash
npx hardhat run scripts/admin-scripts/4b-create-condition-with-metadata.js --network baseSepolia
```

## Question Types

**Current:** DifficultyThreshold (Binary: Will difficulty ≥ threshold at target block?)

**To change question type:** Modify `QUESTION_CONFIG.type` in script:
- `QuestionType.DifficultyThreshold` - Binary threshold
- `QuestionType.DifficultyRange` - Multiple difficulty buckets
- `QuestionType.BlockCount` - Block count in time period
- `QuestionType.MiningDuration` - Mining duration predictions

## Output
Script will output:
- Condition ID (for trading)
- Question ID (for oracle)
- Environment variables to add to `.env`

## Prerequisites
- Oracle must be initialized with Bitcoin blocks (run `setup-bitcoin-oracle.js` first)
- Account must have market maker role