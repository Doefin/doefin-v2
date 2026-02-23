# Doefin V2 Protocol Review (High-Level)

_Date: 2025-12-11_

## Critical Issues
- **Missing ownership checks**: `AccessControlFacet` lacks `LibDiamond.enforceIsContractOwner()` on `addMarketMaker` / `removeMarketMaker`, allowing anyone to toggle market-maker privileges.
- **No oracle freshness enforcement in trading paths**: `LibSettlement` / `LibOrderbook` do not consult `OracleManagerFacet.getPrice`; trades can execute while oracle price is stale/paused/zero. Must gate all trade flows on fresh price.
- **Reentrancy protections unused**: `LibReentrancyGuard` exists but is not applied to external state-changing entrypoints (order create/modify/cancel, fills, fee withdrawals, oracle updates). Token hooks (ERC777/1155 receivers) can reenter.
  - **Example Vulnerability:** The `createOrder` -> `fillOrders` -> `settlementDispatcher` call chain performs external token transfers before all state changes are written to storage. A malicious token contract could re-enter `createOrder`, exploiting the inconsistent state to fill an order multiple times and drain collateral.
  - **Recommendation:** Immediately apply the re-entrancy guard to all external functions that can initiate trades. The primary entry point is `OrderCreationFacet.createOrder`.
    ```solidity
    // In OrderCreationFacet.sol
    import {LibReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";

    function createOrder(...) external {
        LibReentrancyGuard._nonReentrantBefore();
        LibOrderbook.createOrder(...);
        LibReentrancyGuard._nonReentrantAfter();
    }
    ```
- **ERC1155 transfer wrapper risk**: `LibCollateralManager.lockERC1155Collateral` calls `LibERC1155.safeTransferFrom(address(this), user, address(this), ...)`; confirm `LibERC1155` uses `user` as `from`. If not, collateral locking can fail or bypass approvals.
- **Adapter ID hygiene**: `OracleManagerFacet.removeAdapter` deletes config, allowing ID reuse/rebind. In failover systems, prefer disable-only to avoid ambiguity and replay risks.

## High-Priority Improvements
- Add ownership guard to market-maker admin (AccessControlFacet).
- Integrate `_nonReentrantBefore/After` into all external mutative functions across facets; consider a shared modifier pattern per facet.
- Enforce oracle freshness in trading: before matching/settlement, call `IOracleManager.getPrice(assetId)`; revert if `isPaused` or `price==0`. Auto-pause on stale inside `getPrice` or enforce at call sites.
- Prevent adapter priority duplicates and require all referenced adapters registered/enabled when configuring assets; avoid `delete` and use `enabled=false` to disable.
- Require non-zero price in `getPrice` responses for trading; otherwise revert.
- Publish and pin EIP-712 domain parameters (name/version/chainId/diamond address) used by `manualUpdatePrice`; emit event for `maxManualUpdateAge` changes.

## Medium / Gas & Size
- Use `unchecked { ++i; }` and cache `length` in tight loops (orderbook insert, match engine, adapter iteration) to shave gas.
- Cache `unitPerPair`/fee bps from storage once per function.
- Consider data-structure change for orderbook (price-level buckets or heap) to avoid O(n) inserts/shifts in `_insertSorted` and matching. The current implementation is a significant gas bottleneck. A doubly linked list implemented with mappings is a standard, gas-efficient alternative.
- Hardhat optimizer runs are `1` for size; if bytecode headroom allows, consider 200–400 runs for lower runtime gas. For a protocol where runtime cost is critical, `1000` runs is recommended.
- **Sub-optimal Struct Packing:** Several key structs (`Order`, `AdapterConfig`, `AssetConfig`) are not packed efficiently. Re-ordering fields to group smaller data types can save significant gas on storage operations.
  - **Example (`AdapterConfig`):**
    ```solidity
    // Inefficient (4 slots)
    struct AdapterConfig {
        uint256 maxStaleness;
        uint256 failureCount;
        address adapterAddress;
        bool enabled;
    }

    // Gas-Efficient (1-2 slots)
    struct AdapterConfig {
        address adapterAddress; // 20 bytes
        uint64 maxStaleness;   // 8 bytes
        uint32 failureCount;   // 4 bytes
        bool enabled;          // 1 byte
    }
    ```

## Security & Ops Hygiene
- Two-step ownership transfer in `OwnershipFacet` (if absent); document process.
- Add global/market-level pause separate from oracle pause; gate trading and withdrawals when paused.
- Add slippage bounds on market orders (max slippage param) to reduce MEV/sandwich risk.
- Add `permit` support for ERC20 collateral to reduce approval griefing.
- Rate-limit or cap adapter list lengths in `updatePrice` to avoid griefing via long iteration.
- Emit events on all admin changes (most covered; ensure coverage for adapter enable/disable, maxManualUpdateAge).

## Testing Gaps to Cover
- Reentrancy with malicious ERC777/1155 receivers during order create/fill/cancel.
- Stale-oracle blocking: trades should revert when `tradingPaused` or price stale/zero.
- Adapter failover sequences: primary fail + secondary success, all fail → pause, then resume on success.
- Manual update EIP-712: signature replay prevention (`usedNonces`), wrong signer, stale timestamp, boundary ages.
- Fee withdrawal edge cases: zero receiver, partial withdrawal > balance, batch length mismatch.
- Cross-currency matching: incompatibility rejection and oracle stale handling for dynamic rates.

## File Pointers (reviewed)
- Storage: `contracts/libraries/LibDoefinStorage.sol`
- Trading core: `contracts/libraries/LibOrderbook.sol`, `LibMatchEngine.sol`, `LibSettlement.sol`, `LibTradeSettlement.sol`, `LibCollateralManager.sol`, `LibFeeManager.sol`
- Oracles: `contracts/facets/OracleManagerFacet.sol`
- Admin/Access: `contracts/facets/AccessControlFacet.sol`, `AdminConfigFacet.sol`
- Reentrancy utility: `contracts/libraries/LibReentrancyGuard.sol`
- Config: `hardhat.config.js`

## Next Actions (suggested)
1) Patch AccessControlFacet with ownership checks; add tests.
2) Add reentrancy guards to all external mutative entrypoints and test with malicious tokens.
3) Enforce oracle freshness in trading paths; add tests for stale/paused scenarios.
4) Adjust oracle adapter lifecycle (disable vs delete), duplicate-priority guard, and adapter enable checks.
5) Confirm/fix `LibERC1155.safeTransferFrom` semantics; add regression test for collateral locking/unlocking.
6) Apply micro-gas passes (unchecked loops, caching) where hot.
