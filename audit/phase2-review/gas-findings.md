# Doefin v3 Mainnet Audit — Gas Optimization Findings (Phase 2)

**Domain:** gas  
**Auditor:** sc-gas-optimizer  
**Scope branch:** `SCRUM-213-MultiSigSetupForContractAdmin` (code state post-SCRUM-223/224/226)  
**Target deployment:** Base mainnet (OP-stack L2)  
**Date:** 2026-05-22

---

## Baseline

| Contract | Deployed size (KiB) | Headroom to 24 KiB |
|---|---|---|
| SettlementFacet | 13.68 | 10.32 |
| AdminConfigFacet | 3.12 | 20.88 |
| NonceManagerFacet | 2.36 | 21.64 |
| SignatureVerifierFacet | 1.90 | 22.10 |
| All other in-scope facets | < 7.5 | > 16 |

Only `DoefinInvariantHarness` (audit-only, excluded) exceeds the 48 KiB initcode limit.  
All production facets are within EIP-170. No mainnet-blocker size issue.

Compiler: solc 0.8.20, `optimizer: { enabled: true, runs: 1 }`, `viaIR: true`.

---

## Findings

---

### GAS-001: Optimizer `runs: 1` is the wrong trade-off for a constantly-called settlement contract

```
id:             GAS-001
domain:         gas
severity:       medium
status:         new
decision:       n/a
reverify:       pending
location:       hardhat.config.js:26
source:         gas
duplicate-of:   -
conflicts-with: -
regression-of:  -
swc:            -
upgrade-safe:   yes
```

**Description**

`hardhat.config.js` sets `optimizer: { runs: 1 }`. The `runs` parameter tells the optimizer how many times a function is expected to be executed: a low value minimizes *deploy* bytecode at the expense of *runtime* execution cost; a high value produces fatter bytecode that runs cheaper on every invocation.

`matchOrders` and `fillOrder` are the economic core of the protocol. They are called on every settled trade. `runs: 1` is the correct setting for a one-shot deploy helper; it is the wrong setting for a constant-throughput settlement engine.

Concretely, with `runs: 1` and `viaIR` enabled:
- Internal functions like `_verifySignature`, `_validateOrder`, `_checkFillAmount`, `_validateFee`, `_determineMatchType`, and each `_settleX` path are compiled as discrete call targets that require JUMP/JUMPI instructions with full stack setup.
- With `runs: 200` or higher, the optimizer inlines small helper functions, performs better constant propagation, and eliminates redundant condition checks. The result is fewer opcodes on the hot path.

**Gas impact**

Estimating the savings from `runs: 1` to `runs: 200` is compiler-dependent, but the contributing factors are:

- JUMP opcode cost: 8 gas each. The hot path through `_settleAgainstMaker` involves at least 8–12 internal function calls per maker leg. Inlining eliminates these entirely where profitable.
- Stack frame setup cost per internal call: 20–60 gas depending on argument count.
- Conservative estimate: **300–1,000 gas saved per `matchOrders` call** (1 maker, complementary settlement).

At 1,000,000 `matchOrders` calls (plausible monthly volume for an active protocol):  
300M–1B gas saved per month. On Base at typical L2 execution prices, this is non-trivial.

**Size headroom check**

`SettlementFacet` is currently 13.68 KiB with `runs: 1`. Moving to `runs: 200` typically grows bytecode by 15–40%. Worst case: 13.68 × 1.4 ≈ 19.15 KiB, leaving 4.85 KiB margin under the 24 KiB limit. The headroom is sufficient.

A per-contract override is possible in Hardhat if any other facet cannot tolerate the size increase (none currently approach the limit).

**Recommendation**

Change `hardhat.config.js`:

```js
// Before
optimizer: { enabled: true, runs: 1 }

// After — start with 200; benchmark against actual test suite gas report
optimizer: { enabled: true, runs: 200 }
```

If any facet grows beyond 23 KiB, apply a per-contract override:

```js
overrides: {
  "contracts/facets/SettlementFacet.sol": {
    settings: { optimizer: { enabled: true, runs: 200 } }
  }
}
```

Benchmark with `REPORT_GAS=true npx hardhat test` before and after to confirm savings.

**upgrade-safe:** yes — bytecode-only change, no storage layout or ABI effect.  
**effort:** low (config change + benchmark).

---

### GAS-002: Domain separator recomputes `keccak256` of constant strings on every call

```
id:             GAS-002
domain:         gas
severity:       medium
status:         new
decision:       n/a
reverify:       pending
location:       contracts/libraries/LibDoefinOrder.sol:95-120
source:         gas
duplicate-of:   -
conflicts-with: -
regression-of:  -
swc:            -
upgrade-safe:   yes
```

**Description**

`LibDoefinOrder.diamondDomainSeparator(address)` calls `domainSeparator("Doefin Exchange", "3", block.chainid, verifyingContract)`. The `domainSeparator` function takes the name and version as `string memory` parameters and computes:

```solidity
keccak256(bytes(name))     // "Doefin Exchange" -- string alloc + keccak every call
keccak256(bytes(version))  // "3"               -- string alloc + keccak every call
```

Both strings are compile-time constants. However, because they are passed as `string memory`, the compiler must allocate memory and run `keccak256` at runtime on every invocation. The EIP-712 specification (and standard implementations such as OpenZeppelin `EIP712.sol`) precomputes these as `bytes32 constant` values to avoid this.

`diamondDomainSeparator` is called once per `matchOrders` and once per `fillOrder` call — it is on the hot path.

**Gas impact**

- `keccak256` of a 15-byte string: ~36 gas (base 30 + 6 per word).
- `keccak256` of a 1-byte string: ~30 gas.
- Memory allocation and copy for each string: ~50–100 gas.
- Total per call: **~150–200 gas** saved by precomputing both hashes as constants.

**Recommendation**

Add compile-time constants and a streamlined `diamondDomainSeparator`:

```solidity
// Before (LibDoefinOrder.sol)
function diamondDomainSeparator(address verifyingContract) internal view returns (bytes32) {
    return domainSeparator("Doefin Exchange", "3", block.chainid, verifyingContract);
}

// After
bytes32 internal constant NAME_HASH    = keccak256("Doefin Exchange");
bytes32 internal constant VERSION_HASH = keccak256("3");

function diamondDomainSeparator(address verifyingContract) internal view returns (bytes32) {
    return keccak256(
        abi.encode(
            DOMAIN_SEPARATOR_TYPEHASH,
            NAME_HASH,
            VERSION_HASH,
            block.chainid,
            verifyingContract
        )
    );
}
```

The public `domainSeparator(string, string, uint256, address)` function can remain for external callers if needed; `diamondDomainSeparator` switches to the constant path.

**upgrade-safe:** yes — the hash output is identical; only the computation path changes.  
**effort:** low (add two constants, refactor one internal function).

---

### GAS-003: `_validateFee` re-reads `maxFeeRateBps` from storage on every call; not hoisted alongside `feeReceiver`

```
id:             GAS-003
domain:         gas
severity:       low
status:         new
decision:       n/a
reverify:       pending
location:       contracts/facets/SettlementFacet.sol:803-808, 122-123
source:         gas
duplicate-of:   -
conflicts-with: -
regression-of:  -
swc:            -
upgrade-safe:   yes
```

**Description**

`matchOrders` (line 123) correctly hoists `feeReceiver` from storage once before the maker loop. `feeReceiver` lives in `AdminConfigStorage` at the same storage slot as `resolutionFeeBps` and `maxFeeRateBps` (all three are in a single packed 32-byte slot: `address feeReceiver` (20 bytes) + `uint16 resolutionFeeBps` (2 bytes) + `uint16 maxFeeRateBps` (2 bytes)).

However, `_validateFee` reads `maxFeeRateBps` independently on every call:

```solidity
// SettlementFacet.sol:805
uint16 maxFeeRateBps = LibDoefinStorage.appStorage().adminConfigStorage.maxFeeRateBps;
```

For a single-maker complementary settlement, `_validateFee` is called twice (once for buyer fee, once for seller fee). After the first warm read, the second costs 100 gas (warm SLOAD). These reads are redundant: since `feeReceiver` was read cold at line 123, the slot containing `maxFeeRateBps` is already warm for the remainder of the transaction.

The issue is larger in `fillOrder`: `fillOrder` does not hoist `feeReceiver` before calling `_executeOperatorFill`. Inside `_executeOperatorFill`, `feeReceiver` is read cold (2,100 gas), and then `_validateFee` reads `maxFeeRateBps` — warm (100 gas) since the slot was just read. If `feeReceiver` were hoisted to the `fillOrder` body and passed as a parameter (mirroring `matchOrders`), and `maxFeeRateBps` similarly hoisted and passed to `_validateFee`, both reads would be consolidated.

**Gas impact**

Per `matchOrders` call with N makers (all fees non-zero):
- Without optimization: 2N warm SLOADs for `maxFeeRateBps` (first is warm because `feeReceiver` was read cold = same slot).
- With optimization (hoist `maxFeeRateBps` at line 122–123 and pass to `_validateFee`): 1 warm SLOAD total.
- Savings: (2N − 1) × 100 gas. For N = 3 makers: **500 gas saved**.

Per `fillOrder` call: savings are minimal (feeReceiver + maxFeeRateBps reads are already ordered correctly; `_validateFee` sees a warm slot). Benefit is primarily structural clarity.

**Recommendation**

Hoist `maxFeeRateBps` alongside `feeReceiver` in `matchOrders`, and thread it through `_settleAgainstMaker` → `_executeSettlement` → `_settleX` → `_validateFee`:

```solidity
// matchOrders body (after line 123)
uint256 takerUnit = ds.adminConfigStorage.unitPerPair[takerOrder.collateralToken];
address feeReceiver = ds.adminConfigStorage.feeReceiver;
uint16 maxFeeRateBps = ds.adminConfigStorage.maxFeeRateBps;  // same slot, warm read

// Pass maxFeeRateBps through to _validateFee, replacing the internal appStorage() call
function _validateFee(uint128 fee, uint256 cashValue, uint16 maxFeeRateBps) internal pure {
    if (fee == 0) return;
    uint256 maxAllowed = (cashValue * uint256(maxFeeRateBps)) / 10000;
    if (uint256(fee) > maxAllowed) revert Errors.FeeExceedsMaxRate();
}
```

Similarly in `fillOrder`, hoist `feeReceiver` and `maxFeeRateBps` before calling `_executeOperatorFill` and pass them as parameters.

**upgrade-safe:** yes — no storage layout change; pure refactor.  
**effort:** medium (signature changes propagate through multiple internal functions).

---

### GAS-004: `LibDoefinStorage.Condition` struct has suboptimal field ordering — 2 avoidable storage slots

```
id:             GAS-004
domain:         gas
severity:       medium
status:         new
decision:       n/a
reverify:       pending
location:       contracts/libraries/LibDoefinStorage.sol:109-116
source:         gas
duplicate-of:   -
conflicts-with: -
regression-of:  -
swc:            -
upgrade-safe:   no
```

**Description**

The `Condition` struct in `LibDoefinStorage` has the following field order:

```solidity
struct Condition {
    bytes32 questionId;       // slot 0 — 32 bytes
    string metadataURI;       // slot 1 — dynamic reference
    address oracle;           // slot 2 — 20 bytes (12 bytes wasted)
    uint8 outcomeSlotCount;   // slot 3 — 1 byte  (31 bytes wasted)
    bool active;              // slot 4 — 1 byte  (31 bytes wasted)
    address creator;          // slot 5 — 20 bytes (12 bytes wasted)
}
```

`oracle` (20 bytes), `outcomeSlotCount` (1 byte), and `active` (1 byte) total 22 bytes — they fit in a single 32-byte slot. But because `metadataURI` (a dynamic string reference) occupies slot 1 and the remaining fields are declared in the order shown, the compiler assigns each small field its own slot rather than packing them with `oracle`.

Reordering to place `oracle`, `outcomeSlotCount`, and `active` consecutively immediately after `questionId` causes them to pack into one slot:

```solidity
// Optimized
struct Condition {
    bytes32 questionId;       // slot 0
    address oracle;           // slot 1, bytes 0–19
    uint8 outcomeSlotCount;   // slot 1, byte 20
    bool active;              // slot 1, byte 21
    address creator;          // slot 2, bytes 0–19
    string metadataURI;       // slot 3 — dynamic reference
}
```

This reduces the struct from 6 storage slots to 4.

**Gas impact**

Every condition creation (ConditionManagerFacet) writes all fields. With the current layout:
- 6 new slot writes × 20,000 gas (SSTORE cold) = 120,000 gas (excluding the dynamic string data).

With optimized layout:
- 4 new slot writes × 20,000 gas = 80,000 gas.
- **Savings: 40,000 gas per condition created.**

Additionally, `LibCTFCondition.enforceConditionIsActive` reads `conditions[conditionId].active`. With the current layout, `active` is in slot 4 (its own word); with optimized layout, it shares slot 1 with `oracle` and `outcomeSlotCount`, so any function that already read `oracle` gets `active` for free on the warm read.

**upgrade-safe:** no — this is a storage layout change. On a **fresh deploy** (v3 mainnet), there are no existing `Condition` records to migrate, so the change is free to make pre-deploy.  
**effort:** low (reorder fields in the struct; update `ConditionManagerFacet` struct-literal assignments to match new order).

---

### GAS-005: `LibReentrancyGuard._nonReentrantBefore` performs a dead "initialize on first use" check on every call

```
id:             GAS-005
domain:         gas
severity:       low
status:         new
decision:       n/a
reverify:       pending
location:       contracts/libraries/LibReentrancyGuard.sol:33-48
source:         gas
duplicate-of:   -
conflicts-with: -
regression-of:  -
swc:            -
upgrade-safe:   yes
```

**Description**

`_nonReentrantBefore` contains:

```solidity
// Initialize on first use
if (ds.reentrancyStorage._status == 0) {
    ds.reentrancyStorage._status = _NOT_ENTERED;
}
```

`DiamondInit.init()` sets `reentrancyStorage._status = 1` (`_NOT_ENTERED`) during deployment. The guard therefore enters every `matchOrders` and `fillOrder` call with `_status == 1`. The `if (_status == 0)` branch is dead code on all mainnet calls. The extra comparison costs approximately 3 gas per call and is never taken.

**Gas impact**

~3 gas per `matchOrders` / `fillOrder` call. Negligible individually, but the dead branch also increases bytecode size marginally.

**Recommendation**

Remove the initialization guard from `_nonReentrantBefore`. Initialization responsibility belongs to `DiamondInit`, which already handles it. Add a `require` to `DiamondInit` instead if belt-and-suspenders assurance is needed.

```solidity
// Before
function _nonReentrantBefore() internal {
    LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
    if (ds.reentrancyStorage._status == 0) {           // dead after DiamondInit
        ds.reentrancyStorage._status = _NOT_ENTERED;
    }
    if (ds.reentrancyStorage._status == _ENTERED) {
        revert Errors.ReentrantCall();
    }
    ds.reentrancyStorage._status = _ENTERED;
}

// After
function _nonReentrantBefore() internal {
    LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
    if (ds.reentrancyStorage._status == _ENTERED) {
        revert Errors.ReentrantCall();
    }
    ds.reentrancyStorage._status = _ENTERED;
}
```

**upgrade-safe:** yes — no storage layout change; DiamondInit already ensures `_status` is non-zero at deploy time.  
**effort:** trivial.

---

### GAS-006: Settlement collateral multiplication not wrapped in `unchecked` where provably safe

```
id:             GAS-006
domain:         gas
severity:       low
status:         new
decision:       n/a
reverify:       pending
location:       contracts/facets/SettlementFacet.sol:551, 604, 697, 750
source:         gas
duplicate-of:   -
conflicts-with: -
regression-of:  -
swc:            -
upgrade-safe:   yes
```

**Description**

Four places in the settlement hot path compute a collateral amount via:

```solidity
uint256 collateralAmount = (uint256(price) * uint256(fillAmount)) / unit;
```

where `price` is `uint128` and `fillAmount` is `uint128`. Solidity 0.8+ adds overflow checks by default (~30–40 gas per checked multiplication). These multiplications are provably safe under the invariants enforced at call time:

- `price <= unit` is enforced by `_validateOrder` (BIZ-004) before any settle helper is reached.
- `unit` is set by the admin as a "collateral precision unit" (e.g. `1e6` for USDC, `1e18` for ETH). No real collateral token has a unit near `2^128`.
- Therefore `price <= unit << 2^128`, and `price * fillAmount <= unit * (2^128 - 1)`. Since `unit` is practically `<= 1e18 << 2^128`, the product is safely below `2^256`.

The four sites are:
- `_settleComplementary` line 551: execution price multiplication.
- `_settleMint` line 604: maker collateral computation.
- `_settleMerge` line 697: maker payout computation.
- `_executeOperatorFill` line 750: collateral amount computation.

**Gas impact**

~30–40 gas per unchecked multiplication, at 4 sites: **120–160 gas per settlement call**.

**Recommendation**

Wrap the multiplications in `unchecked` with an inline invariant comment:

```solidity
// Before (SettlementFacet.sol:551)
uint256 collateralAmount = (uint256(maker.pricePerToken) * uint256(fillAmount)) / unit;

// After
// Overflow-safe: pricePerToken <= unit (BIZ-004) and unit is a practical collateral scale (<= 1e18)
// so price * fillAmount < 2^128 * 1e18 << 2^256.
uint256 collateralAmount;
unchecked {
    collateralAmount = (uint256(maker.pricePerToken) * uint256(fillAmount)) / unit;
}
```

Apply identically at lines 604, 697, 750.

**upgrade-safe:** yes — behavior is identical when the invariant holds; if a caller somehow violated the invariant, the previous code would have reverted on overflow whereas unchecked code would wrap. But the invariant is enforced by `_validateOrder` on the hot path before any of these lines are reached.  
**effort:** low (4 one-line changes with comments).

---

### GAS-007: `cancelOrders` loop missing `unchecked` counter increment

```
id:             GAS-007
domain:         gas
severity:       low
status:         new
decision:       n/a
reverify:       pending
location:       contracts/facets/NonceManagerFacet.sol:85
source:         gas
duplicate-of:   -
conflicts-with: -
regression-of:  -
swc:            -
upgrade-safe:   yes
```

**Description**

`cancelOrders` iterates over an array of `DoefinOrder` structs:

```solidity
for (uint256 i; i < orders.length; ++i) {
```

The increment `++i` is a checked pre-increment. Since `i` is a `uint256` that is bounded by `orders.length` (which is bounded by the calldata size, far below `type(uint256).max`), the overflow check is impossible to trigger. The same pattern applies to loops in `LibERC1155` (lines 24, 83, 119, 147), `LibPositionRegistry` (lines 183, 191, 215), and `LibCTFCondition` (lines 234, 272).

**Gas impact**

~30–40 gas saved per loop iteration. For a batch of 10 orders: **~300–400 gas**.

**Recommendation**

Use `unchecked { ++i; }` for all loop counters where overflow is impossible:

```solidity
// Before
for (uint256 i; i < orders.length; ++i) { ... }

// After
for (uint256 i; i < orders.length;) {
    // ... loop body ...
    unchecked { ++i; }
}
```

Apply to:
- `NonceManagerFacet.cancelOrders` line 85
- `LibERC1155.balanceOfBatch` line 24
- `LibERC1155.safeBatchTransferFrom` line 83
- `LibERC1155._batchMint` line 119
- `LibERC1155._batchBurn` line 147
- `LibPositionRegistry.registerPositionPairs` lines 183, 191
- `LibPositionRegistry.getMarketsForCondition` line 215
- `LibCTFCondition._reportPayouts` line 234
- `LibCTFCondition._validateAndBuildPartitionPositions` line 272

Note: the settlement hot path main loop (`matchOrders` line 133) and `_getIndexSetIn` (line 865) already use `unchecked { ++i; }`. The above are secondary paths.

**upgrade-safe:** yes — no storage or ABI changes.  
**effort:** low (mechanical change across multiple files).

---

### GAS-008: `LibDoefinOrder.diamondDomainSeparator` is recomputed once per `matchOrders`/`fillOrder` call but not cached within a single `_settleAgainstMaker` iteration

```
id:             GAS-008
domain:         gas
severity:       informational
status:         new
decision:       n/a
reverify:       pending
location:       contracts/facets/SettlementFacet.sol:107, 242
source:         gas
duplicate-of:   -
conflicts-with: -
regression-of:  -
swc:            -
upgrade-safe:   yes
```

**Description**

Both `matchOrders` (line 107) and `fillOrder` (line 241) compute `_getDomainSeparator()` once and cache it in a local `domainSep` variable. This is then passed to each per-maker call. The design is correct: the domain separator is computed once per external call, not per maker.

This finding is informational only — the current implementation is already correct. It is recorded to confirm that the auditor verified the caching pattern as part of the hot-path review.

No change needed.

**upgrade-safe:** yes  
**effort:** none

---

### GAS-009: `MarketDataFacet.getCollateralUnit` calls `validatePositionId` and `getCollateralToken` separately, causing double lookup of `marketKeyByPositionId`

```
id:             GAS-009
domain:         gas
severity:       informational
status:         new
decision:       n/a
reverify:       pending
location:       contracts/facets/MarketDataFacet.sol:205-215
source:         gas
duplicate-of:   -
conflicts-with: -
regression-of:  -
swc:            -
upgrade-safe:   yes
```

**Description**

`getCollateralUnit` calls `LibPositionRegistry.validatePositionId(positionId)` (which reads `marketKeyByPositionId[positionId]`) and then `LibPositionRegistry.getCollateralToken(positionId)` (which reads `marketKeyByPositionId[positionId]` again). The second read is a warm SLOAD (100 gas) since the slot was already accessed in the same transaction.

This is a view function — not on the settlement hot path. The warm read cost is 100 gas, which is negligible.

The same pattern appears in `getPositionInfo`, which calls `validatePositionId`, `getCollateralToken`, `getComplement`, and `getMarketMetadata` in sequence, each independently reading `marketKeyByPositionId`. All reads after the first are warm.

No change is required. Recorded for completeness.

**upgrade-safe:** yes  
**effort:** none (informational)

---

## Appendix — Minor Nits Not Warranting Formal Findings

**A1. `balanceOfBatch` re-calls `appStorage()` inside loop (LibERC1155.sol:26)**  
`appStorage()` is a `pure` function that sets a storage pointer via `assembly { ds.slot := position }`. It performs no SLOAD. The repeated call costs ~3 gas per iteration (assembly instruction). Hoisting the pointer outside the loop saves ~3N gas for N elements. Not worth a formal finding.

**A2. `LibSignature.verifyEIP1271` uses `try/catch` (~100 gas overhead vs raw `staticcall`)**  
The `try/catch` pattern adds overhead but provides the safety of a typed dispatch and proper ABI decoding of the return value. The security benefit outweighs the ~100 gas cost. This is on the EIP-1271 path (smart wallets only), not the EOA hot path.

**A3. ERC1155 `safeTransferFrom` with `""` empty bytes**  
The empty bytes literal `""` allocates a zero-length `bytes memory` value (~100 gas overhead). For the settlement paths that call this repeatedly, replacing `""` with a module-level `bytes memory _EMPTY = ""` constant does not help because `bytes memory` cannot be `constant` in Solidity. The cost is minimal and unavoidable without changing the ERC1155 interface.

**A4. Transient storage (EIP-1153) for reentrancy guard**  
`TLOAD`/`TSTORE` opcodes (EIP-1153, available since Cancun) would reduce the reentrancy guard from ~8,000 gas (cold SLOAD + 2 SSTOREs) to ~400 gas (2 TSTOREs + 2 TLOADs). However, Solidity 0.8.20 does not natively support transient storage syntax. Using raw assembly would introduce security risks. Upgrade Solidity to 0.8.24+ to gain native `transient` keyword support — but that is a compiler upgrade, not a gas optimization in isolation. File as a future enhancement.

**A5. `_isBinaryComplement` and `_conditionAndPartition` duplicate reads of `marketKeyByPositionId`**  
For MINT and MERGE paths, `_isBinaryComplement` reads `marketKeyByPositionId[takerPos]` and `marketKeyByPositionId[makerPos]` cold, then `_getIndexSetIn` (called from `_conditionAndPartition`) reads them warm (100 gas each). The warm reads are acceptable; refactoring to pass the market key through would save ~200 gas but at significant code complexity cost.

---

## Summary

| Finding | Severity | Hot path? | Est. savings/call | Effort |
|---|---|---|---|---|
| GAS-001 Optimizer runs:1 | medium | yes | 300–1,000 gas | low |
| GAS-002 Domain sep string keccak | medium | yes | ~150–200 gas | low |
| GAS-003 maxFeeRateBps not hoisted | low | yes | ~100–500 gas (N makers) | medium |
| GAS-004 Condition struct packing | medium | no (create) | ~40,000 gas / condition | low |
| GAS-005 Reentrancy dead init check | low | yes | ~3 gas | trivial |
| GAS-006 Unchecked collateral mul | low | yes | ~120–160 gas | low |
| GAS-007 Loop unchecked increments | low | no (cancel) | ~30–40 gas/iter | low |
| GAS-008 Domain sep caching confirmed | informational | — | 0 (already correct) | none |
| GAS-009 Double marketKey lookup | informational | no (view) | ~100 gas | none |

**Findings count by severity:**
- Medium: 3 (GAS-001, GAS-002, GAS-004)
- Low: 4 (GAS-003, GAS-005, GAS-006, GAS-007)
- Informational: 2 (GAS-008, GAS-009)

**Top 5 highest-impact findings:**

1. **GAS-001** — `runs: 1` optimizer setting. Every hot-path call pays a permanent runtime tax. 300–1,000 gas per `matchOrders` call, compounding across the protocol lifetime. Fix is a config change.
2. **GAS-004** — `Condition` struct field ordering. 40,000 gas saved per market/condition created. Pre-deploy only (storage layout change). Fix is a struct reorder.
3. **GAS-002** — Domain separator string hashing. ~150–200 gas per settlement call (hot path). Fix is two constant declarations.
4. **GAS-006** — Unchecked collateral multiplication. ~120–160 gas per settlement call at 4 sites. Fix is adding `unchecked` with invariant comments.
5. **GAS-003** — `maxFeeRateBps` hoisting. Up to 500 gas per multi-maker `matchOrders` call. Fix is a moderate refactor of `_validateFee` signature.
