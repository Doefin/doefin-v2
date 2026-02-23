# Doefin Diamond: Size, Gas, and Safety Notes

## Focus Areas
- Orderbook/matching/settlement (size/gas hot paths)
- Cross-currency pricing/oracle usage
- Reentrancy and fund-moving entrypoints
- Conditional Tokens / position lifecycle
- Block header oracle and adapter flow
- Diamond pattern hygiene

## High-Impact Recommendations

### 1) Orderbook data structure (gas + size)
**Issue:** `_insertSorted` shifts arrays; `removeOrderFromOrderbook` scans linearly. O(n) inserts/removes inflate gas and bytecode.

**Action:** add `mapping(uint256 => uint256) orderIndex` per side+position; do swap-pop deletes and O(1) inserts.

```solidity
// Pseudocode: store index for O(1) remove
mapping(uint256 => mapping(uint256 => mapping(bool => uint256))) orderIndex; // positionId => orderId => isBuy => idx

function _insertOrder(uint256 positionId, bool isBuy, uint256 orderId, uint256 price) internal {
    uint256[] storage book = isBuy ? buyOrders[positionId] : sellOrders[positionId];
    uint256 idx = _binarySearch(book, price, isBuy);
    book.push(orderId);
    // shift via swap-pop if not at end
    for (uint256 i = book.length - 1; i > idx; i--) {
        book[i] = book[i - 1];
        orderIndex[positionId][book[i]][isBuy] = i;
    }
    book[idx] = orderId;
    orderIndex[positionId][orderId][isBuy] = idx;
}

function _removeOrder(uint256 positionId, bool isBuy, uint256 orderId) internal {
    uint256[] storage book = isBuy ? buyOrders[positionId] : sellOrders[positionId];
    uint256 idx = orderIndex[positionId][orderId][isBuy];
    uint256 last = book[book.length - 1];
    book[idx] = last;
    orderIndex[positionId][last][isBuy] = idx;
    book.pop();
    delete orderIndex[positionId][orderId][isBuy];
}
```

### 2) Skip-on-stale instead of revert (matching/FX)
**Issue:** Cross-currency price lookups can revert on stale oracle data; settlement reverts on non-crossing matches, halting entire tx.

**Action:** treat stale/oracle failure as "skip order" in simulation and settlement.

```solidity
(uint256 quotePrice, bool isStale) = LibQuoteCurrency.calculateQuoteCurrencyPrice(order, useOracleRate);
if (isStale || quotePrice == 0) {
    // skip this order, continue loop
    continue;
}
```

In `LibSettlement._executeMatches` replace revert on `NotCrossingPrices` with a `continue;` so one bad maker does not brick a batch fill.

### 3) Reentrancy guard on fund-moving entrypoints
**Issue:** Some flows guard internally, but facet entrypoints that lock/release collateral or transfer fees are unguarded.

**Action:** wrap external functions that move funds (order create/cancel/modify, fill routes, fee withdrawals, payout redemption) with `LibReentrancyGuard._nonReentrantBefore/After`.

```solidity
function cancelOrder(uint256 orderId) external {
    LibReentrancyGuard._nonReentrantBefore();
    LibOrderbook.cancelOrder(orderId, msg.sender);
    LibReentrancyGuard._nonReentrantAfter();
}
```

### 4) Enforce non-empty, validated conversion paths
**Issue:** `setConversionPath` accepts empty/unsorted arrays.

**Action:** require `assetIds.length > 0` and ascending/unique.

```solidity
if (assetIds.length == 0) revert Errors.InvalidConversionPath();
for (uint256 i = 1; i < assetIds.length; i++) {
    if (assetIds[i] <= assetIds[i-1]) revert Errors.InvalidConversionPath();
}
```

### 5) Cross-currency rate snapshot (optional)
**Issue:** Dynamic FX is re-read each compare; stale causes reverts and extra gas.

**Action:** store `exchangeRate` + `rateTimestamp` at order creation; enforce max age at match time.

```solidity
struct CrossCurrencySnapshot { uint256 rate; uint64 ts; }
// On create (dynamic): snapshot current oracle rate
(order.crossCurrencyConfig.exchangeRate, order.crossCurrencyConfig.rateTimestamp) = _oracleRateNow();
// On match: require block.timestamp - rateTimestamp < MAX_AGE
```

### 6) Condition payout authorization
**Issue:** `_reportPayouts` allows any caller as oracle; compromised oracle address can grief.

**Action:** gate by allowlist (owner/oracle role) before accepting payouts.

```solidity
if (!LibAccessControl.isOwner(msg.sender) && msg.sender != expectedOracle) revert Errors.NotAuthorized();
```

### 7) Block header oracle submission
**Issue:** `submitNextBlock/submitBatchBlocks` are permissionless; griefable if not intended.

**Action:** add relayer allowlist or staking; or move to pull-based proof submission with slashing.

### 8) Min price tick / bounds
**Issue:** Prices allowed (0, unit-1) can create edge math in mint/merge paths.

**Action:** enforce `pricePerToken >= MIN_TICK` and `pricePerToken <= unitPerPair - MIN_TICK` (choose tick per collateral decimals).


## Gas Micro-Optimizations
- Cache `unitPerPair`, fee bps, `order.createdAt` in locals inside loops.
- Use `unchecked { ++i; }` in tight loops after bounds checks.
- Avoid copying calldata arrays to memory if not mutated (e.g., iterate `matches` calldata directly in `fillMarketOrderWithRoute`).
- Hoist `book.length` and reuse during insert/remove loops.

## Contract Size Practices
- Keep facets focused (already done); move heavy pure/view helpers to libs and split `LibMatchEngine` (pricing vs routing) to keep facets <24KB.
- Drop unused events/errors; group similar errors to shrink bytecode.
- Prefer internal lib calls over facet-to-facet externals to reduce selector bloat.

## Diamond Hygiene
- `diamondCut` owner-guarded; loupe present. Keep init idempotent (LibDoefinStorage initialized flag exists).
- Consider a pause/kill-switch facet for trading/oracle updates.
- Document storage layout and gaps; maintain versioned initializers with emits on upgrades.

## Targeted Test Cases
- Orderbook index mapping: insert/remove/modify preserves ordering and indexes.
- Matching with stale oracle data is skipped (not reverted).
- Fill-or-kill market orders where some makers go non-crossing mid-tx.
- Cross-currency matches with incompatible quote currencies or stale FX.
- Block header oracle reorg path and condition settlement batching.
- Condition cancellation → split/merge/order creation blocked if desired policy.

## Quick Win Patch Set (suggested next steps)
1) Order index + swap-pop removal for O(1) delete; cached reads and unchecked loops in orderbook/match.
2) Skip-on-stale/skip-on-non-crossing in match engine + settlement; minFill recheck before emitting matches.
3) Reentrancy guards on fund-moving entrypoints; conversion path validation; feeReceiver set in init.

I can implement the above as a small series of PR-sized patches if you want me to proceed.
