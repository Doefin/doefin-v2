# Contract Size Optimization Plan (Updated)

Last updated: 2025-12-08

## Current Measurements (Hardhat `size-contracts`)
- OrderCreationFacet: 25.021 KiB (over 24 KiB limit)
- MarketExecutionFacet: 21.557 KiB (under limit but close)
- Others: < 10 KiB
- Root cause: `OrderCreationFacet` calls `LibOrderbook._tryFillImmediately`, which drags in `LibMatchEngine`, `LibSettlement`, and `LibTradeSettlement`.

## Key Requirements
- **Preserve immediate fill for limit orders** in a single call (current behavior).
- Reduce `OrderCreationFacet` below 24 KiB.

## Agreed Architectural Adjustments
1) **Split creation from matching while keeping a one-call path for immediate fill**
   - Introduce `createOrderWithoutMatching` in `LibOrderbook` (returns `orderId`).
   - Expose `tryFillOrder(orderId)` in `LibOrderbook` (renamed from `_tryFillImmediately`).
   - Keep `OrderCreationFacet` as a thin creator calling only `createOrderWithoutMatching` (no matching inside).
   - Add a thin facet entry (new `OrderFillFacet` or extend `MarketExecutionFacet`) with `createLimitOrderAndMatch(...)` that:
     1) calls `createOrderWithoutMatching(...)`
     2) immediately calls `tryFillOrder(orderId)` to preserve the current one-transaction immediate fill for limits.
   - `createMarketOrder` can live in the same fill facet if desired.

2) **Low-risk immediate bytecode reductions**
   - Remove duplicate cross-currency validation in `LibOrderbook.createOrder` (it validates inline and then calls `LibQuoteCurrency.validateCrossCurrencyOrder`). Keep a single validation path.
   - Extract duplicated cross-currency math and pricing into helpers (per original guide):
     - `LibCrossCurrencyHelper`: exchange-rate fetch + staleness/zero checks, effective price for sorting/matching, cross-currency type guards.
     - `LibCollateralCalculations`: collateral value → quote amount → fee/total for lock/release/settlement.
     - `LibOrderValidation`: basic params + cross-currency config validation once.
   - Wire helpers into:
     - `LibEscrowLogic` (lock/release collateral paths)
     - `LibTradeSettlement` (cross-currency fee/payment computation)
     - `LibOrderbook._insertSorted` (price computation for ordering)
     - `LibMatchEngine` (effective price and crossing logic)

3) **Facet sizing expectations after split**
   - `OrderCreationFacet`: should drop well below 24 KiB once matching is removed.
   - New/extended fill facet: should stay under 24 KiB; shared helpers further reduce transitive inlining for both this facet and `MarketExecutionFacet`.

## Implementation Steps
- LibOrderbook
  - Rename `createOrder` → `createOrderWithoutMatching` (returning `orderId`).
  - Rename `_tryFillImmediately` → `tryFillOrder` (internal) and reuse from the fill facet.
  - Remove the second cross-currency validation pass; rely on consolidated validation.
- Facets
  - Update `OrderCreationFacet` to call only `createOrderWithoutMatching`.
  - Add `OrderFillFacet` (or extend `MarketExecutionFacet`) with `createLimitOrderAndMatch` (create → tryFill) and optional `createMarketOrder` wrapper.
  - Update deployment scripts to include the new facet.
- Helper Libraries
  - Add `LibCrossCurrencyHelper`, `LibCollateralCalculations`, `LibOrderValidation` as described; refactor call sites in escrow, settlement, match engine, and orderbook sorting.
- Validation & Tests
  - Re-run `npx hardhat size-contracts` to confirm sizes.
  - Update tests/front-end calls: use `createLimitOrderAndMatch` for immediate fill; `createOrder` for pure listing.

## Rationale
- Decoupling creation from matching removes the heavy settlement chain from `OrderCreationFacet` while a dedicated fill facet preserves one-call immediate fills.
- Consolidated helpers remove duplicated inlined code (exchange-rate fetch, quote price calc, collateral/fee math, validation), shrinking all dependent facets.
- Minimal behavior changes: immediate fill remains available via the new entry; pure creation remains unchanged.

## Notes
- Keep storage layout untouched; changes are limited to logic and new helper libraries.
- Monitor `MarketExecutionFacet` after helper refactors; expected to shrink further from shared code.
