# Doefin V2 Copilot Instructions

This codebase implements **Doefin V2**, a decentralized Bitcoin mining difficulty options platform built on the **EIP-2535 Diamond Standard**. Understanding the Diamond architecture is critical for productive work.

## Architecture Overview

### Diamond Pattern (EIP-2535)
This is NOT a traditional contract system. It uses the Diamond pattern for modularity:
- **Single proxy address** (`Diamond.sol`) that delegates to multiple facets
- **Facets** are implementation contracts containing business logic
- **LibDoefinStorage** is the ONLY storage contract - never create new storage libraries
- **All storage MUST be added to `AppStorage` struct** in `LibDoefinStorage.sol`

### Core Components
- **Facets** (`contracts/facets/`): Modular business logic (Exchange, Market Execution, CTF, etc.)
- **Libraries** (`contracts/libraries/`): Shared logic called by facets (LibOrderbook, LibSettlement, etc.)
- **Storage**: Centralized in `LibDoefinStorage.sol` - critical for avoiding storage corruption

## Key Patterns & Conventions

### Storage Management
```solidity
// ALWAYS add storage to existing AppStorage struct in LibDoefinStorage
struct AppStorage {
    ConditionalTokensStorage conditionalTokens;
    OrderbookStorageStruct orderbookStorage; 
    // Add new storage here - NEVER create separate storage libs
    YourNewStorage yourNewStorage; // ✅ Correct
}

// NEVER do this:
library LibYourNewStorage { // ❌ Wrong - causes storage corruption
    bytes32 constant POSITION = keccak256("your.storage");
    // ...
}
```

### Facet Development
- Facets are thin wrappers that delegate to libraries
- Use `LibDoefinStorage.appStorage()` to access storage
- Always implement corresponding interface in `contracts/interfaces/`
- Follow naming: `ExchangeFacet` → `IExchange` → `LibOrderbook`

### Order Execution Flow
Two distinct paths exist (see `ORDER_EXECUTION_DEV.md`):

1. **Immediate Execution**: `ExchangeFacet.createOrder()` → tries matching immediately
2. **Precomputed Route**: `RouteSimulationFacet.simulateMarketOrder()` → `MarketExecutionFacet.fillMarketOrderWithRoute()`

### Testing Patterns
- Use `scripts/admin-scripts/` numbered scripts for sequential setup
- Diamond deployment requires specific facet order (see `scripts/deploy.js`)
- Always use `test/utils.js` helpers for condition/position ID calculations

## Development Workflow

### Setup & Deployment
```bash
npm install
npx hardhat compile
npx hardhat run scripts/deploy.js --network localhost
```

### Testing
```bash
npx hardhat test                    # All tests
npx hardhat test test/diamondTest.js # Diamond-specific tests
```

### Admin Operations (Sequential)
```bash
# Follow numbered sequence in scripts/admin-scripts/
npx hardhat run scripts/admin-scripts/1-deploy-mock-token-and-add-collateral.js
npx hardhat run scripts/admin-scripts/2-add-market-maker.js
# ... continue sequence
```

## Critical Integration Points

### Conditional Tokens Framework (CTF)
- Position IDs calculated via elliptic curve math in `test/utils.js`
- Conditions created through `ConditionManagerFacet`
- Positions represent outcome tokens (YES/NO for binary markets)

### Order Matching System
- **LibMatchEngine**: Finds potential matches
- **LibSettlement**: Executes trades with proper collateral handling
- **Three match types**: Complementary, Mint (split), Merge

### Cross-Currency Orders
- Standard orders use collateral token for pricing
- CrossCurrency orders use quote currency (ETH, BTC) for pricing
- Exchange rates can be Fixed or Dynamic

## File Organization

### Must-Read Files
- `contracts/libraries/LibDoefinStorage.sol` - Storage layout (read first)
- `contracts/facets/ORDER_EXECUTION_DEV.md` - Order execution patterns
- `scripts/deploy.js` - Diamond deployment sequence
- `test/utils.js` - ID calculation helpers

### Adding New Features
1. Add storage to `LibDoefinStorage.AppStorage` if needed
2. Create library in `contracts/libraries/` for business logic
3. Create facet in `contracts/facets/` that calls library
4. Create interface in `contracts/interfaces/`
5. Add facet to deployment script
6. Write tests using numbered admin scripts pattern

## Oracle Integration (In Progress)
Following `.github/instructions/OracleRegistry.instructions.md`:
- Oracle adapters implement `IBaseOracleAdapter`
- Registry stored in `LibDoefinStorage.AppStorage` (NOT separate storage)
- Automatic failover with staleness protection
- Trading pauses on stale/failed oracles

## Environment Variables
```bash
DIAMOND_ADDRESS=0x...     # Deployed diamond address
ORACLE_ADDRESS=0x...      # Oracle address for conditions
SEPOLIA_RPC_URL=...       # RPC URLs
ARBITRUM_MAINNET_RPC_URL=...
PRIVATE_KEY=...           # Deployment key
ETHERSCAN_API_KEY=...     # For verification
```

## Common Pitfalls
- ❌ Creating new storage libraries (causes corruption)
- ❌ Modifying existing storage positions in `LibDoefinStorage`
- ❌ Forgetting to add new facets to deployment script
- ❌ Calling facet functions directly (use diamond address with facet ABI)
- ❌ Ignoring gas optimization (`viaIR: true` required in hardhat.config.js)

## Gas Optimization
- Use `viaIR: true` in Hardhat config (required for complex diamond)
- Libraries should be `internal` functions to avoid delegatecall overhead
- Pack structs efficiently (use uint16 for basis points, bool for flags)
- Use events for off-chain indexing instead of view functions where possible