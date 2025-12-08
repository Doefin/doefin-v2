---
applyTo: '**'
---
# Oracle Registry Implementation Instructions

## Context & Architecture

You are implementing an extensible oracle registry system for Doefin V2, a Diamond-pattern (EIP-2535) decentralized exchange for Bitcoin difficulty options. The system must support multiple oracle providers (BlockScholes, Chainlink, Pyth, etc.) with automatic failover capabilities and comprehensive failure handling.

**Critical Storage Constraints**: This project has experienced storage corruption issues from initialization logic. All oracle-related storage MUST be added to the existing `LibDoefinStorage` structure. Never create separate storage libraries for oracle functionality. Never modify existing storage slot positions.

## Core Components to Implement

### 1. Storage Structure (LibDoefinStorage)

Add oracle-related storage to the existing `DoefinStorage` struct:

**Oracle Registry Mapping**:
- `mapping(bytes32 => AdapterConfig) adapters` - Maps adapter IDs (e.g., keccak256("BlockscholesV1")) to their configuration
- Each `AdapterConfig` contains: adapter contract address, max staleness duration, failure counter, and enabled status

**Asset Configuration Mapping**:
- `mapping(bytes32 => AssetConfig) assetConfigs` - Maps asset IDs (e.g., keccak256("BTC-USD")) to their oracle configuration
- Each `AssetConfig` contains: ordered array of adapter IDs (priority list), max staleness for this asset, trading pause status, last update timestamp

**Price Data Mapping**:
- `mapping(bytes32 => PriceData) priceData` - Maps asset IDs to their current price information
- Each `PriceData` contains: current price, last update timestamp, last successful adapter ID, price validity status

### 2. Oracle Adapter Interface (IBaseOracleAdapter)

Create a minimal interface that all oracle adapters must implement:

**Required Functions**:
- `getLatestPrice(bytes32 assetId)` - Returns (uint256 price, uint256 timestamp, bool isValid)
- `getSupportedAssets()` - Returns array of supported asset IDs
- `getAdapterMetadata()` - Returns adapter name and version for identification

**Design Philosophy**: Keep the interface minimal and generic. Each adapter implementation handles provider-specific logic (API calls, on-chain data reading, signature verification).

### 3. OracleManagerFacet (Diamond Facet)

This facet manages the oracle registry and handles all oracle-related operations.

**Registry Management Functions**:
- `registerAdapter(bytes32 adapterId, address adapterAddress, uint256 maxStaleness)` - Admin function to add new oracle adapters
- `updateAdapterConfig(bytes32 adapterId, AdapterConfig config)` - Admin function to modify adapter settings
- `removeAdapter(bytes32 adapterId)` - Admin function to disable an adapter

**Asset Configuration Functions**:
- `configureAsset(bytes32 assetId, bytes32[] adapterPriority, uint256 maxStaleness)` - Set which adapters to use for an asset and in what order
- `updateAssetAdapterPriority(bytes32 assetId, bytes32[] newPriority)` - Change the failover order for an asset

**Price Update Functions**:
- `updatePrice(bytes32 assetId)` - External function (callable by keeper) that tries adapters in priority order
- `manualUpdatePrice(bytes32 assetId, uint256 price, uint256 timestamp, bytes signature)` - Accepts EIP-712 signed prices from BlockScholes for fallback scenarios
- `emergencyUpdatePrice(bytes32 assetId, uint256 price, string justification)` - Emergency multisig function for complete oracle failures

**Price Query Functions**:
- `getPrice(bytes32 assetId)` - Returns (price, timestamp, isPaused) with automatic staleness checking
- `getAdapterInfo(bytes32 adapterId)` - Returns adapter configuration and status
- `getAssetOracleStatus(bytes32 assetId)` - Returns complete oracle health info for an asset

### 4. Automatic Failover Logic

**Price Update Flow**:
1. Keeper calls `updatePrice(assetId)`
2. Facet retrieves asset's adapter priority array from storage
3. For each adapter ID in order:
   - Look up adapter address from registry
   - Call `adapter.getLatestPrice(assetId)`
   - If valid (price > 0, timestamp fresh, isValid = true):
     - Update storage with new price
     - Reset adapter failure counter
     - Emit `PriceUpdated(assetId, price, timestamp, adapterId)`
     - Return success
   - If invalid or reverts:
     - Increment adapter's `failureCount`
     - Emit `AdapterFailed(adapterId, assetId, failureCount)`
     - Continue to next adapter
4. If all adapters fail:
   - Set `assetConfig.tradingPaused = true`
   - Emit `AllAdaptersFailed(assetId, attemptedAdapters)`
   - Revert with descriptive error

**Critical**: This entire flow must happen within a single transaction. No separate keeper calls between adapter attempts.

### 5. Staleness Protection (Circuit Breaker)

**Automatic Staleness Checks**:
- Every call to `getPrice(assetId)` must check: `block.timestamp - priceData.timestamp > assetConfig.maxStaleness`
- If stale:
  - Set `assetConfig.tradingPaused = true`
  - Emit `PriceStale(assetId, lastUpdateTimestamp, currentTimestamp)`
  - Return price with `isPaused = true`

**Trading Facet Integration**:
- All trading execution functions must call `getPrice(assetId)` before processing trades
- Must check the returned `isPaused` boolean
- Must revert with "Trading paused: stale oracle" if paused

**Trading Resume Logic**:
- When a successful price update occurs while trading is paused
- Automatically set `tradingPaused = false`
- Emit `TradingResumed(assetId, newPrice, timestamp)`

### 6. Mock Oracle Adapter (Development)

For testing and development, create a `MockOracleAdapter` that implements `IBaseOracleAdapter`:

**Mock Functionality**:
- Stores settable prices per asset ID
- Admin function `setPrice(bytes32 assetId, uint256 price)` for testing different scenarios
- Admin function `setFailure(bytes32 assetId, bool shouldFail)` for testing failover logic
- Returns hardcoded timestamp (block.timestamp) and configurable validity

**Development Usage**: Deploy MockOracleAdapter, register it with "MockV1" ID, configure all assets to use it during development.

### 7. EIP-712 Signature Verification (Manual Updates)

**Signature Structure**:
- Domain: chain ID, verifying contract address, version
- Message: assetId, price, timestamp, nonce (for replay protection)
- Signer: BlockScholes authorized signer address (stored in admin config)

**Verification Flow**:
1. `manualUpdatePrice` receives price data + signature
2. Reconstruct EIP-712 hash from provided data
3. Recover signer address using `ecrecover`
4. Verify signer matches stored authorized address
5. Check nonce hasn't been used (prevent replay)
6. Verify timestamp is recent (< 5 minutes old)
7. Update price if all checks pass

**Anti-Replay**: Maintain `mapping(bytes32 => bool) usedNonces` to track used signature nonces.

## Critical Implementation Requirements

### Storage Safety
- **NEVER** create a new storage library for oracle data
- **ALWAYS** add oracle storage to existing `LibDoefinStorage`
- **NEVER** remove or reorder existing storage variables
- **ALWAYS** append new storage to the end of existing structures
- **VERIFY** storage layout doesn't overlap with CTF or orderbook storage

### Access Control
- Registry management functions: Admin-only (use existing admin modifiers)
- Price update function: Public/keeper (no restriction, permissionless)
- Manual update function: Public but requires valid signature
- Emergency update function: Emergency multisig only

### Gas Optimization
- Adapter failover should be gas-efficient (limit priority array to ~5 adapters max)
- Price queries should be view functions (no state changes)
- Use packed structs where possible to minimize storage slots

### Event Emission
- Emit events for every adapter attempt (success and failure)
- Emit events for all registry changes (adapter added/removed/updated)
- Emit events for trading pause/resume state changes
- Emit events for manual and emergency price updates with justification

### Error Handling
- Use descriptive custom errors (e.g., `AdapterNotRegistered(bytes32 adapterId)`)
- Never silently fail during price updates
- Always emit events before reverting for observability

## Testing Considerations

### Unit Tests Required
- Adapter registration and removal
- Asset configuration with priority arrays
- Price updates with single adapter success
- Failover logic when primary adapter fails
- Complete failure scenario (all adapters fail)
- Staleness detection and trading pause
- EIP-712 signature verification
- Emergency update authorization

### Integration Tests Required
- Full update flow with mock adapters
- Staleness triggering during live trading attempts
- Trading resume after successful price update
- Multiple assets with different adapter configurations

### Development Environment Setup
- Deploy MockOracleAdapter
- Register with OracleManagerFacet
- Configure BTC-USD, USD-USDT, USD-USDC assets to use mock
- Provide helper functions for setting mock prices in tests

## Implementation Priority

1. **Phase 1**: Storage structure in LibDoefinStorage + IBaseOracleAdapter interface
2. **Phase 2**: OracleManagerFacet with registry management and basic price queries
3. **Phase 3**: Automatic failover logic and staleness protection
4. **Phase 4**: MockOracleAdapter for development testing
5. **Phase 5**: EIP-712 signature verification for manual updates
6. **Phase 6**: Emergency update mechanism with multisig
7. **Phase 7**: Integration with existing trading facets

## Integration Notes

### With Existing Facets
- Trading execution facets must call `IOracleManager(address(this)).getPrice(assetId)` before processing trades
- Must handle `isPaused` return value appropriately
- Should display oracle status in position opening UI

### Asset ID Conventions
- Use consistent hashing: `keccak256(abi.encodePacked("BTC-USD"))`
- Document all supported asset IDs
- Maintain mapping of human-readable names to asset IDs

### Adapter ID Conventions
- Format: `keccak256(abi.encodePacked("ProviderNameV1"))`
- Examples: "BlockscholesV1", "ChainlinkV1", "PythV1"
- Version in ID allows deploying updated adapters without breaking existing references

## Future Considerations

- Support for range-based queries (min/max prices over time periods)
- TWAP (Time-Weighted Average Price) calculations
- Volatility data from oracle providers
- Historical price data storage for on-chain analytics

---

**Critical Reminders**:
- This is a Diamond-pattern contract - follow facet separation principles
- Storage corruption has been an issue - be extremely careful with LibDoefinStorage modifications
- The system must work trustlessly - no admin intervention should be required for normal operation
- All oracle failures must be observable through events for backend monitoring