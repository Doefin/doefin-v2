# Doefin V3 Architecture

This document provides an overview of the Doefin V3 protocol architecture.

## High-Level Architecture

Doefin V3 is a prediction market platform on Base L2, built on the Diamond Standard
(EIP-2535). It uses a **hybrid model**: an **off-chain orderbook** with **on-chain
settlement** (the Polymarket model). Users sign orders off-chain; an authorized operator
submits matched orders to the Diamond for trustless on-chain settlement.

The previous v2.0 on-chain CLOB (order creation, on-chain matching, cross-currency
trading) has been removed. Only settlement, conditional-token (CTF), and Bitcoin oracle
facets remain.

```
┌─────────────────────────────────────────────────────────────┐
│                    Diamond Proxy                            │
├─────────────────────────────────────────────────────────────┤
│  Function Selector → Facet Address Mapping                  │
│  Delegatecall Routing to Implementation Facets              │
└─────────────────────────────────────────────────────────────┘
                               │
            ┌──────────────┬───┴───┬──────────────┐
            │              │       │              │
      ┌─────▼─────┐  ┌─────▼────┐ ┌▼──────┐ ┌─────▼─────┐
      │ Settlement│  │   CTF    │ │ Oracle│ │   Admin   │
      │  Facets   │  │  Facets  │ │ Facets│ │  Facets   │
      └───────────┘  └──────────┘ └───────┘ └───────────┘
```

## Core Components

### 1. Diamond Proxy System

**Diamond.sol**: Main proxy contract that routes function calls to the appropriate facet
via function-selector lookup and `delegatecall`.

**Key Features:**
- Single entry point for all functionality
- Upgradeable without changing the contract address
- Gas-efficient function routing via assembly
- Supports unlimited contract size through faceting

**Storage Pattern:**
```solidity
// Diamond storage uses deterministic slot positioning
bytes32 constant DIAMOND_STORAGE_POSITION = keccak256("diamond.standard.diamond.storage");
bytes32 constant DOEFIN_STORAGE_POSITION = keccak256("doefin.storage");
bytes32 constant SETTLEMENT_STORAGE_POSITION = keccak256("doefin.settlement.storage");
```

### 2. Facet Inventory

#### Settlement Facets

- **`SettlementFacet`** — `matchOrders()` and `fillOrder()`, operator management, fee
  collection. Operator-only entry point: validates signatures and order validity,
  determines the match type per maker, and executes the settlement path.
- **`SignatureVerifierFacet`** — EIP-712 domain separator, order hashing, signature
  verification (ECDSA `ecrecover` for EOAs, EIP-1271 for smart-contract wallets).
- **`NonceManagerFacet`** — `incrementNonce()`, `cancelOrder()`,
  `cancelOrdersForPosition()` for off-chain order cancellation.

#### CTF Core Facets

- **`ConditionalTokensFacet`** — `splitPosition()`, `mergePositions()`,
  `redeemPositions()`. Based on the Gnosis Conditional Tokens Framework.
- **`ConditionManagerFacet`** — `prepareCondition()`, `resolveCondition()`.
- **`ERC1155Facet` / `ERC1155ReceiverFacet`** — position-token standard.

#### Oracle Facets (Bitcoin condition resolution)

- **`DoefinV1BlockHeaderOracleFacet`** — Bitcoin block header submission and verification.
- **`OracleAdapterFacet`** — view-only access to Bitcoin difficulty / block-count /
  duration questions used to resolve conditions.

These facets resolve Bitcoin-based prediction-market conditions. They are **not** a
cross-currency price oracle — that subsystem (`OracleManagerFacet`,
`BlockScholesOracleAdapter`, the price-feed adapter registry) has been fully removed.

#### Infrastructure Facets

- **`DiamondCutFacet` / `DiamondLoupeFacet` / `OwnershipFacet`** — Diamond standard.
- **`AccessControlFacet` / `AdminConfigFacet`** — admin management and protocol config.
- **`MarketDataFacet`** — read-only market queries.

### 3. Conditional Token Interface

```solidity
interface IConditionalTokens {
    function prepareCondition(address oracle, bytes32 questionId, uint8 outcomeSlotCount) external;
    function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external;
    function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external;
    function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external;
}
```

### 4. Oracle System

#### DoefinV1BlockHeaderOracleFacet
Validates Bitcoin block headers and tracks network metrics:

**Core Functions:**
- `submitNextBlock()` — submit a new Bitcoin block for validation
- block-header validation — verify a block meets consensus rules
- difficulty retrieval — get difficulty at a specific block height

**Validation Rules:**
1. Previous block hash linkage
2. Timestamp validation (> median of the previous 11 blocks)
3. Proof-of-work verification (SHA-256 double hash)
4. Difficulty-adjustment verification (every 2016 blocks)

#### OracleAdapterFacet
View-only facet that exposes Bitcoin question data for condition resolution. It maps
block data to conditional-token outcomes and supports difficulty-threshold,
difficulty-range, block-count, and mining-duration question types.

### 5. Storage Architecture

#### LibDoefinStorage
Central storage library defining shared protocol state at `keccak256("doefin.storage")`:

```solidity
library LibDoefinStorage {
    bytes32 constant STORAGE_POSITION = keccak256("doefin.storage");

    struct AppStorage {
        // ERC1155 position-token state
        ERC1155Storage erc1155Storage;

        // Bitcoin oracle state
        BlockHeaderOracleStorage blockHeaderOracleStorage;
        OracleAdapterStorage oracleAdapterStorage;

        // Configuration
        AdminConfigStorage adminConfigStorage;
        AccessControlStorage accessControlStorage;
        // ...
    }
}
```

The deprecated v2.0 on-chain orderbook storage (`OrderbookStorageStruct`, the v2.0 `Order`
struct, `Match`, `MatchEngineStorage`, the old `SettlementStorage`) and all cross-currency
storage (`OracleStorage`, `AdapterConfig`, `PriceData`, `conversionPaths`,
`CrossCurrencyData`) have been removed.

#### LibSettlementStorage
Isolated v3 settlement storage at `keccak256("doefin.settlement.storage")`. Holds the
operator address, the trading-paused flag, per-order filled amounts, and nonce
bookkeeping. Follows the EIP-7201 namespaced-storage pattern.

## Question Types & Data Structures

### 1. Difficulty Threshold Questions
Binary outcomes based on Bitcoin difficulty level:

```solidity
struct DifficultyThresholdQuestion {
    bytes32 questionId;
    bytes32 conditionId;
    uint256 threshold;
    uint256 targetBlockHeight;
    // Outcomes: [0] = No (<= threshold), [1] = Yes (> threshold)
}
```

### 2. Difficulty Range Questions
Multi-outcome difficulty brackets:

```solidity
struct DifficultyRangeQuestion {
    bytes32 questionId;
    bytes32 conditionId;
    uint256 targetBlockHeight;
    uint256[] buckets; // Range boundaries
}
```

### 3. Block Count Questions
Blocks mined in a time window:

```solidity
struct BlockCountQuestion {
    bytes32 questionId;
    bytes32 conditionId;
    uint256 startTimestamp;
    uint256 endTimestamp;
    uint256[] countBuckets;
}
```

### 4. Mining Duration Questions
Time to mine a specific block count:

```solidity
struct MiningDurationQuestion {
    bytes32 questionId;
    bytes32 conditionId;
    uint256 startBlockHeight;
    uint256 blockCount;
    uint256[] durationBuckets; // Duration boundaries in seconds
}
```

## Trading Flow (Hybrid Model)

### Off-Chain Order Creation
1. A user signs a `DoefinOrder` (EIP-712) off-chain. No collateral is locked at this point.
2. The order is submitted to the off-chain orderbook service.

### Off-Chain Matching
1. The off-chain match engine finds crossing orders and groups one taker against one or
   more makers.
2. For each maker, the engine determines the match type (Complementary, Mint, or Merge)
   and computes the per-leg fee amount.

### On-Chain Settlement
1. The authorized operator calls `SettlementFacet.matchOrders()` with the signed taker and
   maker orders, fill amounts, and operator-supplied fee amounts.
2. The contract verifies every signature, validates each order, enforces fill caps and the
   fee ceiling, and executes the appropriate settlement path per maker.
3. Collateral and ERC1155 position tokens are transferred atomically.

### Condition Resolution & Redemption
1. The Bitcoin oracle reports block-header data.
2. The condition is resolved based on the actual outcome.
3. Position holders call `redeemPositions()` to redeem winning positions for collateral;
   a `resolutionFeeBps` redemption fee is applied at this step.

## Settlement Paths

There are three settlement paths. A single `matchOrders()` call can settle one taker
against a **mix** of these match types — the match type is determined per maker.

| Path | Taker vs Maker | Mechanism |
|------|----------------|-----------|
| **Complementary** | Buy A vs Sell A | Direct token-for-collateral swap |
| **Mint** | Buy A vs Buy B (complement) | `splitPosition()` mints both outcomes from pooled collateral |
| **Merge** | Sell A vs Sell B (complement) | `mergePositions()` redeems collateral from a complete set |

There is no cross-currency settlement path.

## Fee Model

Trading fees follow the operator-supplied Polymarket V2 pattern:

- Fees are **not signed** by the maker and are **not computed on-chain**. The off-chain
  operator computes the symmetric bell-curve fee
  (`fee ∝ min(price, 1-price) * fillAmount`) and supplies the per-leg fee amounts to
  `matchOrders()` / `fillOrder()`.
- The contract enforces an admin-configurable ceiling in `SettlementFacet._validateFee`:
  `fee <= cashValue * maxFeeRateBps / 10000` and `fee <= proceeds`. The check is
  **fail-closed** — a `maxFeeRateBps` of 0 forbids any non-zero fee.
- `maxFeeRateBps` is set via `AdminConfigFacet.setMaxFeeRate`, bounded by the hard ceiling
  constant `MAX_FEE_RATE_BPS_CAP = 1000` (10%).
- Fees are paid to the admin-configurable `feeReceiver` (set via
  `AdminConfigFacet.setFeeReceiver`). The operator is the authorized `msg.sender` for
  settlement but never receives fees.
- A separate `resolutionFeeBps` redemption fee, charged in `ConditionalTokensFacet` when
  winning positions are redeemed, is distinct from trading fees.

## Access Control & Security

### Role-Based Access Control

```solidity
library LibAccessControl {
    bytes32 constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes32 constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    bytes32 constant MARKET_MAKER_ROLE = keccak256("MARKET_MAKER_ROLE");
}
```

The settlement entry points (`matchOrders`, `fillOrder`) are additionally restricted to
the single authorized operator address held in `LibSettlementStorage`.

### Security Mechanisms

1. **Reentrancy protection** — all settlement and CTF external calls are guarded.
2. **Integer overflow** — Solidity 0.8.20+ built-in protection.
3. **Access control** — role-based plus operator-only settlement.
4. **Signature verification** — EIP-712 with chain-id binding; EIP-1271 support for SCWs.
5. **Oracle manipulation resistance** — multi-block confirmation on Bitcoin headers.
6. **Fail-closed fee ceiling** — `_validateFee` rejects fees above the admin cap.

## Conventions

- Solidity 0.8.20, optimizer enabled (`runs: 1`), `viaIR`.
- Hardhat + Mocha + Chai for testing.
- Central `Errors.sol` for custom errors (no revert strings) and `Events.sol` for events.
- Libraries use `internal` functions, are named `Lib*`, and carry comprehensive NatSpec.
- Storage structs use the `__gap` pattern for upgrade safety.
- All facets must be under 24 KiB (`npx hardhat size-contracts`).

## Integration Points

### External Protocols
1. **Gnosis CTF** — conditional-token standard for outcome positions.
2. **ERC20 tokens** — collateral support (e.g. USDC).
3. **Bitcoin network** — block-header data source for condition resolution.

### Off-Chain Components
1. **Orderbook service** — stores and matches signed orders.
2. **Settlement operator** — authorized submitter of matched orders to the Diamond.
3. **Indexing service** — event monitoring and trade history.
4. **Bitcoin node** — block-header data source.

## Upgrade Patterns

### Diamond Facet Upgrades
1. **Add facet** — deploy a new facet with additional functionality.
2. **Replace facet** — update an existing facet implementation.
3. **Remove facet** — deprecate outdated functionality.
4. **Modify selectors** — add or remove specific function selectors.

### Storage Compatibility
- New storage variables are appended only.
- Existing storage layouts are preserved.
- The `__gap` pattern reserves space in storage structs for future fields.

This architecture provides a scalable, secure, and upgradeable foundation for
decentralized Bitcoin prediction markets with off-chain matching and trustless on-chain
settlement.
