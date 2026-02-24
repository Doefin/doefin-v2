# Doefin V2 Architecture

This document provides a comprehensive overview of the Doefin V2 protocol architecture.

## 🏗️ High-Level Architecture

Doefin V2 is built using the Diamond Standard (EIP-2535), enabling a modular and upgradeable smart contract system for Bitcoin prediction markets.

```
┌─────────────────────────────────────────────────────────────┐
│                    Diamond Proxy                            │
├─────────────────────────────────────────────────────────────┤
│  Function Selector → Facet Address Mapping                 │
│  Delegatecall Routing to Implementation Facets             │
└─────────────────────────────────────────────────────────────┘
                               │
                    ┌──────────┼──────────┐
                    │          │          │
         ┌──────────▼─┐   ┌────▼────┐   ┌─▼────────┐
         │   Core     │   │ Oracle  │   │  Admin   │
         │  Facets    │   │ Facets  │   │ Facets   │
         └────────────┘   └─────────┘   └──────────┘
```

## 🔧 Core Components

### 1. Diamond Proxy System

**Diamond.sol**: Main proxy contract that routes function calls to appropriate facets.

**Key Features:**
- Single entry point for all functionality
- Upgradeable without changing contract address 
- Gas-efficient function routing via assembly
- Supports unlimited contract size through faceting

**Storage Pattern:**
```solidity
// Diamond storage uses deterministic slot positioning
bytes32 constant DIAMOND_STORAGE_POSITION = keccak256("diamond.standard.diamond.storage");
bytes32 constant DOEFIN_STORAGE_POSITION = keccak256("doefin.storage");
```

### 2. Core Trading Facets

#### ConditionalTokensFacet
Manages conditional token lifecycle based on Gnosis CTF:

```solidity
interface IConditionalTokens {
    function prepareCondition(address oracle, bytes32 questionId, uint8 outcomeSlotCount) external;
    function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external;
    function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external;
    function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external;
}
```

#### MarketExecutionFacet  
Handles order matching and execution:

```solidity
interface IMarketExecution {
    function fillOrders(uint256 takerId, uint256[] calldata makerIds) external;
}
```

#### OrderCreationFacet
Manages order book operations:

```solidity
interface IOrderCreation {
    function createOrder(
        uint256 positionId,
        address collateralToken, 
        uint256 amount,
        uint256 pricePerToken,
        uint256 minFillAmount,
        uint256 expiry,
        bool fillOrKill,
        OrderDirection direction,
        ExecutionType executionType,
        CrossCurrencyData memory crossCurrencyData
    ) external;
}
```

### 3. Oracle System

#### DoefinV1BlockHeaderOracle
Validates Bitcoin block headers and tracks network metrics:

**Core Functions:**
- `submitBlockHeader()`: Submit new Bitcoin block for validation
- `validateBlockHeader()`: Verify block meets consensus rules  
- `retrieveDifficulty()`: Get difficulty at specific block height
- `setUnsetConditionResult()`: Resolve prediction market outcomes

**Validation Rules:**
1. Previous block hash linkage
2. Timestamp validation (>median of previous 11 blocks)  
3. Proof of work verification (SHA256 double hash)
4. Difficulty adjustment verification (every 2016 blocks)

#### OracleAdapterFacet
Interfaces between block oracle and prediction markets:

- Maps block data to conditional token outcomes
- Handles different question types (threshold, range, count, duration)
- Provides automated settlement triggers

### 4. Storage Architecture  

#### LibDoefinStorage
Central storage library defining all protocol state:

```solidity
library LibDoefinStorage {
    bytes32 constant STORAGE_POSITION = keccak256("doefin.storage");
    
    struct AppStorage {
        // ERC1155 state
        ERC1155Storage erc1155Storage;
        
        // Oracle state  
        BlockHeaderOracleStorage blockHeaderOracleStorage;
        OracleAdapterStorage oracleAdapterStorage;
        
        // Trading state
        OrderbookStorage orderbookStorage;
        MatchEngineStorage matchEngineStorage;
        SettlementStorage settlementStorage;
        
        // Configuration
        AdminConfigStorage adminConfigStorage;
        AccessControlStorage accessControlStorage;
    }
}
```

## 📊 Question Types & Data Structures

### 1. Difficulty Threshold Questions
Binary outcomes based on Bitcoin difficulty level:

```solidity
struct DifficultyThresholdQuestion {
    bytes32 questionId;
    bytes32 conditionId;  
    uint256 threshold;
    uint256 targetBlockHeight;
    // Outcomes: [0] = No (≤ threshold), [1] = Yes (> threshold)
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
    // Example: buckets=[85T, 90T, 95T] → [<85T, 85-90T, 90-95T, ≥95T]
}
```

### 3. Block Count Questions
Blocks mined in time window:

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
Time to mine specific block count:

```solidity
struct MiningDurationQuestion {
    bytes32 questionId;
    bytes32 conditionId;
    uint256 startBlockHeight;
    uint256 blockCount;
    uint256[] durationBuckets; // Duration boundaries in seconds
}
```

## 🔄 Trading Flow

### Order Creation Flow

1. **User submits order** via OrderCreationFacet
2. **Validate parameters** (amount, price, expiry)
3. **Check collateral** balance and allowance
4. **Store order** in OrderbookStorage
5. **Emit OrderCreated** event
6. **Auto-match** if market order

### Order Matching Flow

1. **Match engine** identifies compatible orders
2. **Calculate fill amounts** respecting partial fill rules
3. **Execute transfers** of collateral and positions
4. **Update order states** (filled/partial/cancelled)
5. **Emit trade events** for off-chain indexing

### Settlement Flow

1. **Oracle** reports block header data
2. **Condition resolution** based on actual outcomes
3. **Payout calculation** for each outcome position
4. **Enable redemption** for position holders
5. **Automated settlement** for mature positions

## 🔐 Access Control & Security

### Role-Based Access Control

```solidity
library LibAccessControl {
    bytes32 constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes32 constant ORACLE_ROLE = keccak256("ORACLE_ROLE");  
    bytes32 constant MARKET_MAKER_ROLE = keccak256("MARKET_MAKER_ROLE");
}
```

### Security Mechanisms

1. **Reentrancy Protection**: All external calls protected
2. **Integer Overflow**: Solidity 0.8.20+ built-in protection  
3. **Access Control**: Role-based function access
4. **Oracle Manipulation Resistance**: Multi-block validation
5. **Front-Running Protection**: Commit-reveal for sensitive ops

## 📈 Gas Optimization Strategies

### 1. Storage Packing
Efficient struct packing to minimize storage slots:

```solidity
struct Order {
    uint256 positionId;        // 32 bytes
    uint128 amount;           // 16 bytes  
    uint128 pricePerToken;    // 16 bytes
    uint64 expiry;            // 8 bytes
    uint64 minFillAmount;     // 8 bytes  
    uint32 createdAt;         // 4 bytes
    // Total: 3 storage slots (96 bytes)
}
```

### 2. Batch Operations
Multiple orders processed in single transaction to amortize gas costs.

### 3. Proxy Optimization  
Diamond standard provides minimal proxy overhead with efficient function routing.

### 4. Library Architecture
Shared logic in libraries reduces deployment costs and enables code reuse.

## 🔌 Integration Points

### External Protocols

1. **Gnosis CTF**: Conditional token standard compliance
2. **ERC20 Tokens**: Multi-collateral support (USDC, DAI, WETH, etc.)  
3. **Price Oracles**: Chainlink/other oracles for cross-currency rates
4. **DEX Protocols**: Potential arbitrage integrations

### Off-Chain Components

1. **Relayer Network**: Meta-transactions and gasless trading
2. **Indexing Service**: Event monitoring and trade history
3. **Market Making Bots**: Automated liquidity provision
4. **Bitcoin Node**: Block header data source

## 🔄 Upgrade Patterns

### Diamond Facet Upgrades

1. **Add Facet**: Deploy new facet with additional functionality
2. **Replace Facet**: Update existing facet with new implementation  
3. **Remove Facet**: Deprecate outdated functionality
4. **Modify Selectors**: Add/remove specific function selectors

### Storage Compatibility

- New storage variables appended only
- Existing storage layouts preserved
- Version tracking for migration scripts
- Backward compatibility maintained

### Initialization Scripts

```solidity
contract UpgradeInitializer {
    function upgrade() external {
        // Perform any necessary storage migrations
        // Update configuration parameters  
        // Initialize new facet state
    }
}
```

## 📊 Performance Characteristics

### Throughput
- **Orders per second**: ~50-100 (depending on gas limit)
- **Batch size**: Up to 20 orders per transaction
- **Settlement latency**: 1-3 blocks post-oracle update

### Storage Efficiency 
- **Order storage**: ~3 storage slots per order
- **Position tracking**: Efficient mapping structures
- **Historical data**: Event-based with off-chain indexing

### Gas Consumption
- **Order creation**: ~150k gas
- **Order matching**: ~180k gas  
- **Position split**: ~120k gas
- **Oracle update**: ~300k gas

This architecture provides a scalable, secure, and upgradeable foundation for decentralized Bitcoin prediction markets while maintaining gas efficiency and composability with the broader DeFi ecosystem.