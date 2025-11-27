# Doefin V2 Order Creation & Execution - Developer Guide

This document explains the two main approaches for creating and executing orders in Doefin V2, with technical details and call sequences for each path.

---

## 1. Order Creation Endpoint (currently `createLimitOrder`)

### Supported Order Types
- Limit Orders
- Market Orders

### Sequence Overview
1. **User calls** the `createLimitOrder` endpoint (name subject to change).
3. **Facet Delegation** Facet calls `LibOrderbook.createOrder` (handles order creation, matching, and execution path computation)
3. **Lib logic** lock collaterals for the limit orders, since user payout for market order is determined at the settlement
4. For any order it checks `_tryFillImmediately`:
    - The contract checks for potential matches in the order book.
    - If matches exist, the order is executed immediately.
    - Treat price of the market order as an average price (User is not willing to pay higher for buy or pay lower for sell in average)
5. **Execution path** is computed on-chain within `LibOrderbook` using `LibMatchEngine.findPotentialMatchesForOrder`.
6. **Settlement** and passed the potential makerOrderIds to the `LibSettlement.fillLimitOrders` (this name also subject to change).


### Technical Notes
- All logic is handled atomically in one transaction.
- User does not need to provide execution path; it is computed by the contract.

---

## 2. Market Execution with Precomputed Route

### Supported Order Types
- Market Orders only

### Sequence Overview
1. **User or off-chain service** computes the execution path (route) for the market order.
    - Can use `RouteSimulationFacet.simulateMarketOrder` on-chain, or custom logic off-chain.
2. **User calls** `MarketExecutionFacet.fillMarketOrderWithRoute`, passing the computed route.
3. **Contract executes** the market order using the provided route.
4. **Settlement** and state updates are handled by `LibSettlement`.

### Function & Library Call Sequence
- `RouteSimulationFacet.simulateMarketOrder` (optional, for on-chain route computation)
    - Returns `MatchExecution[]` route
- `MarketExecutionFacet.fillMarketOrderWithRoute`
    - Constructs `TakerOrderContext` (using order params)
    - Calls `LibSettlement.executeMatchedRoute` (executes trades based on provided route)

### Technical Notes
- User has full control over the execution path.
- Useful for advanced routing, batch execution, or off-chain optimization.
- Requires user/integrator to simulate and provide the route.

### Suggested Refactoring

#### Remove Market Order

After the order is created and `_tryFillImmediately` is checked, handle the fillOrKill flag and remove market order from the order book.

#### LibSettlement

Refactor `fillLimitOrders` so it first generates a `MatchExecution[]` array from the order book to capture all potential fills for the taker order. Execution of these fills and settlements is then delegated to `executeMatchedRoute` instead of being performed inline.

#### Auth Match Flag

Before calling `_tryFillImmediately` in `LibOrderbook.createOrder`, the `autoMatchFlag` is checked. When enabled, limit orders are filled automatically (Market order will fail since we're not able to compute the routes). This flag serves as a toggle between automatic execution and manual execution via `MarketExecutionFacet` using precomputed routes for both limit and market orders. It’s especially useful at this stage for testing and benchmarking, allowing comparison between precomputed-route execution and the standard automatic flow.
