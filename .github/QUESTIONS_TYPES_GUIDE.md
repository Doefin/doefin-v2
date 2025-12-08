# 4 Question Types - Detailed Descriptions

## 1. DifficultyThreshold (Binary Question)

### Description
**"Will Bitcoin mining difficulty be above [THRESHOLD] at block [HEIGHT]?"**

This is a simple yes/no prediction about whether Bitcoin's mining difficulty will exceed a specific value at a future block.

### Real-World Example
```
Question: "Will Bitcoin difficulty be above 90 trillion at block 870,000?"

Outcomes:
- [0] No  (difficulty ≤ 90T)
- [1] Yes (difficulty > 90T)

Resolution:
- Wait for block 870,000 + 6 blocks (settlement delay)
- Get actual difficulty from block 870,000
- If difficulty = 92T → Outcome [1] wins
- If difficulty = 88T → Outcome [0] wins
```

### Use Case
**Miners hedging against difficulty increases:**
- Miner expects difficulty to rise, hurting profitability
- Buys "Yes" tokens as insurance
- If difficulty rises above 90T, miner gets payout to offset lower mining revenue
- If difficulty stays low, miner keeps good mining profits but loses bet

### Parameters
```solidity
{
  threshold: 90000000000000,      // 90 trillion
  targetBlockHeight: 870000       // Block to check
}
```

### Trigger Type
**Block-based** - Resolves when block 870,006 arrives (870,000 + 6 delay)

---

## 2. DifficultyRange (Multi-Choice Question)

### Description
**"What range will Bitcoin mining difficulty be in at block [HEIGHT]?"**

This is a multiple-choice prediction where traders bet on which difficulty range will occur.

### Real-World Example
```
Question: "What will Bitcoin difficulty be at block 875,000?"

Buckets: [85T, 90T, 95T]

Outcomes:
- [0] Below 85T      (< 85,000,000,000,000)
- [1] 85T - 90T      (85T ≤ difficulty < 90T)
- [2] 90T - 95T      (90T ≤ difficulty < 95T)
- [3] 95T or higher  (≥ 95T)

Resolution:
- Actual difficulty at block 875,000 = 88T
- Winner: Outcome [1] (85T - 90T range)
```

### Use Case
**Speculators with nuanced views:**
- Trader A: "Difficulty will rise moderately" → Buys outcome [1]
- Trader B: "Difficulty will skyrocket" → Buys outcome [3]
- Trader C: "Difficulty will drop" → Buys outcome [0]
- More granular than binary yes/no

### Parameters
```solidity
{
  targetBlockHeight: 875000,
  buckets: [85000000000000, 90000000000000, 95000000000000]
}
```

### Trigger Type
**Block-based** - Resolves when block 875,006 arrives

---

## 3. BlockCount (Multi-Choice Question)

### Description
**"How many blocks will be mined between timestamp [START] and timestamp [END]?"**

This predicts Bitcoin's block production rate over a time period, which is affected by hashrate changes and difficulty adjustments.

### Real-World Example
```
Question: "How many blocks will be mined between Jan 1, 2025 00:00 UTC and Jan 8, 2025 00:00 UTC?"

Expected: ~1008 blocks (144 blocks/day × 7 days at 10min/block)

Count Buckets: [950, 1000, 1050]

Outcomes:
- [0] < 950 blocks     (slow production, hashrate dropped)
- [1] 950-1000 blocks  (slightly slow)
- [2] 1000-1050 blocks (normal to slightly fast)
- [3] ≥ 1050 blocks    (fast production, hashrate increased)

Resolution:
- Find block at Jan 1: Block #825,000
- Find block at Jan 8: Block #826,020
- Actual count: 1020 blocks
- Winner: Outcome [2]
```

### Use Case
**Mining pool operators managing expectations:**
- Pool operator expects hashrate increase → Network will mine blocks faster
- Buys outcome [3] to hedge: "If we mine more blocks than expected, we get payout"
- Also useful for speculators betting on hashrate trends

### Parameters
```solidity
{
  startTimestamp: 1704067200,    // Jan 1, 2025 00:00 UTC
  endTimestamp: 1704672000,      // Jan 8, 2025 00:00 UTC
  countBuckets: [950, 1000, 1050]
}
```

### Trigger Type
**Timestamp-based** - Resolves when current timestamp ≥ endTimestamp (Jan 8)

---

## 4. MiningDuration (Multi-Choice Question)

### Description
**"How long will it take to mine [COUNT] blocks starting from block [START]?"**

This is the inverse of BlockCount - predicting time duration instead of block count. Useful for estimating when difficulty adjustments will occur.

### Real-World Example
```
Question: "How long will it take to mine 2016 blocks starting from block 850,000?"

Expected: 20,160 minutes (~14 days at 10min/block)

Duration Buckets: [12 days, 14 days, 16 days] in seconds

Outcomes:
- [0] < 12 days   (1,036,800 sec) - Very fast, hashrate surged
- [1] 12-14 days  (1,036,800 - 1,209,600 sec) - Faster than normal
- [2] 14-16 days  (1,209,600 - 1,382,400 sec) - Normal to slow
- [3] ≥ 16 days   (≥ 1,382,400 sec) - Very slow, hashrate dropped

Resolution:
- Start: Block 850,000 at timestamp 1704067200
- End: Block 852,016 at timestamp 1705190400
- Actual duration: 13.0 days (1,123,200 seconds)
- Winner: Outcome [1] (12-14 days)
```

### Use Case
**Predicting difficulty adjustment timing:**
- Difficulty adjusts every 2016 blocks
- Traders want to know: "When will next adjustment happen?"
- If hashrate increasing → Blocks mine faster → Adjustment comes sooner
- Miners can plan operations around adjustment timing

### Real-World Trading Scenario
```
Miner's Strategy:
- Current difficulty: 80T
- Next adjustment expected to increase difficulty by 10%
- Miner buys outcome [0] "< 12 days"
  
If right:
- Blocks mine fast (high hashrate)
- Adjustment comes at day 11
- Miner's prediction wins
- Payout compensates for earlier difficulty increase

If wrong:
- Blocks mine slow (low hashrate)  
- Adjustment delayed to day 15
- Miner loses bet BUT gets extra days of easier mining
- Natural hedge!
```

### Parameters
```solidity
{
  startBlockHeight: 850000,
  blockCount: 2016,
  durationBuckets: [1036800, 1209600, 1382400]  // [12d, 14d, 16d] in seconds
}
```

### Trigger Type
**Block-based** - Resolves when block 852,022 arrives (850,000 + 2016 + 6 delay)

---

## Comparison Table

| Question Type | What It Predicts | Outcomes | Trigger | Best For |
|--------------|------------------|----------|---------|----------|
| **DifficultyThreshold** | Difficulty above/below threshold | 2 (Binary) | Block | Simple hedges |
| **DifficultyRange** | Which difficulty range | 4+ (Multi) | Block | Nuanced views |
| **BlockCount** | Blocks in time period | 4+ (Multi) | Timestamp | Hashrate trends |
| **MiningDuration** | Time to mine X blocks | 4+ (Multi) | Block | Timing predictions |

---

## Common Patterns Across All Types

### All Questions Share:
1. **Settlement Delay**: 6 blocks after trigger (prevents reorgs)
2. **Outcome Slots**: Binary (2) or Multi-choice (3-10 ranges)
3. **Payout Structure**: Winner gets 1, losers get 0
4. **CTF Integration**: Each outcome is an ERC1155 token
5. **Bucket Validation**: Ranges must be monotonically increasing

### Resolution Mechanics:
1. **Trigger fires** (block arrives or timestamp reached)
2. **Oracle reads Bitcoin data** from stored block headers
3. **Handler calculates winning outcome** based on actual value
4. **Payout reported to CTF** (winning outcome = 1)
5. **Traders redeem** winning tokens for collateral

---

## Advanced Examples

### Combining Multiple Questions

**Scenario:** Sophisticated miner creates portfolio

```
Position 1: DifficultyThreshold
- Buy "Yes" on difficulty > 90T at block 870,000
- Cost: 0.65 USDC per token
- Hedge against high difficulty

Position 2: MiningDuration  
- Buy outcome [1] "12-14 days" for next 2016 blocks
- Cost: 0.30 USDC per token
- Bet on fast block times

Position 3: BlockCount
- Sell outcome [0] "< 950 blocks" for next week
- Receive: 0.15 USDC per token
- Bet against low hashrate

Combined Strategy:
- If hashrate increases → Fast blocks + High difficulty
- Position 1 wins (high difficulty hedge)
- Position 2 wins (fast timing)
- Position 3 wins (high block count)
- All positions align with "bullish hashrate" thesis
```

### Market Making Example

```
Market Maker Strategy for DifficultyRange:

Current Difficulty: 88T
Question: "Difficulty at block 875,000?"
Buckets: [85T, 90T, 95T]

Offer prices:
- Outcome [0] (< 85T):   0.05 USDC (unlikely, difficulty rarely drops)
- Outcome [1] (85-90T):  0.40 USDC (current range, moderate probability)
- Outcome [2] (90-95T):  0.45 USDC (likely increase, high probability)
- Outcome [3] (≥ 95T):   0.10 USDC (possible but unlikely surge)

Total: 1.00 USDC (complete set)

Profit from spread + volatility + rebalancing
```

---

## Key Insights

### Why These 4 Types?

1. **DifficultyThreshold** - Simplest, most liquid (binary is easiest to trade)
2. **DifficultyRange** - More sophisticated, better price discovery
3. **BlockCount** - Captures hashrate dynamics over time
4. **MiningDuration** - Essential for difficulty adjustment timing

### What They Enable:

- ✅ **Risk Management** for miners
- ✅ **Speculation** on Bitcoin network trends  
- ✅ **Arbitrage** between related markets
- ✅ **Price Discovery** for Bitcoin mining metrics
- ✅ **Hedging Instruments** for mining operations

### Future Expansion Ideas:

5. **HashRateThreshold** - "Will network hashrate exceed X EH/s?"
6. **BlockNumberAtTimestamp** - "What block number at timestamp X?" (inverse of BlockCount)
7. **PoolDominance** - "Will pool X mine > Y% of blocks?"
8. **TransactionCount** - "How many transactions in blocks X-Y?"

---

This gives you a complete picture of how the 4 question types work, their use cases, and how they fit into the broader prediction market ecosystem! 🎯