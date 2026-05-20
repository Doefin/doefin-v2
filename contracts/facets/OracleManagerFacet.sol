// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {IBaseOracleAdapter} from "../interfaces/IBaseOracleAdapter.sol";
import {IOracleManager} from "../interfaces/IOracleManager.sol";
import {LibDiamond} from "../libraries/LibDiamond.sol";
import {LibSignature} from "../libraries/LibSignature.sol";
import {Errors} from "../libraries/Errors.sol";
import {Events} from "../libraries/Events.sol";

/**
 * @title OracleManagerFacet
 * @author Doefin
 * @notice Diamond facet for comprehensive oracle management including adapters, assets, and price updates
 * @dev Implements IOracleManager interface for oracle adapter registration, asset configuration, and price management
 * @dev Features automatic failover, EIP-712 manual updates, emergency price updates, and comprehensive error handling
 * @dev Part of the Diamond pattern implementation providing modular oracle infrastructure management
 * @custom:facet Oracle management with adapter registration and price update coordination
 * @custom:diamond Part of the EIP-2535 Diamond Standard implementation
 * @custom:failover Automatic adapter failover and trading pause/resume functionality
 * @custom:eip EIP-712 signature verification for authorized manual price updates
 * @custom:emergency Emergency price update capabilities for oracle failure scenarios
 */
contract OracleManagerFacet is IOracleManager {
    using LibDoefinStorage for LibDoefinStorage.AppStorage;

    // Constants for EIP-712
    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant PRICE_TYPEHASH = keccak256("PriceData(bytes32 assetId,uint256 price,uint256 timestamp,bytes32 nonce)");

    /**
     * @notice Registers a new oracle adapter with the oracle management system
     * @dev Stores adapter configuration and validates that adapter ID is not already in use
     * @dev Only contract owner can register new adapters for security
     * @param adapterId Unique identifier for the adapter (e.g., keccak256("BlockscholesV1"))
     * @param adapterAddress Contract address of the oracle adapter implementing IBaseOracleAdapter
     * @param maxStaleness Maximum time in seconds before prices from this adapter are considered stale
     * @custom:access Only contract owner can register adapters
     * @custom:validation Ensures adapter ID uniqueness and prevents duplicate registrations
     * @custom:emits Events.AdapterRegistered with adapter details
     * @custom:revert Errors.AdapterAlreadyExists if adapter ID is already registered
     */
    function registerAdapter(bytes32 adapterId, address adapterAddress, uint256 maxStaleness) external override {
        LibDiamond.enforceIsContractOwner();
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        if (ds.oracleStorage.adapters[adapterId].adapterAddress != address(0)) {
            revert Errors.AdapterAlreadyExists(adapterId);
        }

        ds.oracleStorage.adapters[adapterId] = LibDoefinStorage.AdapterConfig({
            adapterAddress: adapterAddress,
            maxStaleness: maxStaleness,
            failureCount: 0,
            enabled: true
        });

        emit Events.AdapterRegistered(adapterId, adapterAddress, maxStaleness);
    }

    /**
     * @notice Updates configuration parameters for an existing oracle adapter
     * @dev Allows modification of adapter address, staleness settings, failure count, and enabled status
     * @dev Only contract owner can update adapter configurations for security
     * @param adapterId Identifier of the existing adapter to update
     * @param config New configuration structure containing all adapter parameters
     * @custom:access Only contract owner can update adapter configurations
     * @custom:validation Ensures adapter exists before allowing configuration updates
     * @custom:emits Events.AdapterConfigUpdated with new configuration details
     * @custom:revert Errors.AdapterNotRegistered if adapter ID is not found
     */
    function updateAdapterConfig(bytes32 adapterId, LibDoefinStorage.AdapterConfig calldata config) external override {
        LibDiamond.enforceIsContractOwner();
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        if (ds.oracleStorage.adapters[adapterId].adapterAddress == address(0)) {
            revert Errors.AdapterNotRegistered(adapterId);
        }
        ds.oracleStorage.adapters[adapterId] = config;

        emit Events.AdapterConfigUpdated(adapterId, config);
    }

    /**
     * @notice Removes (disables) an oracle adapter from the management system
     * @dev Completely deletes adapter configuration from storage
     * @dev Only contract owner can remove adapters for security
     * @dev Assets using this adapter should be reconfigured before removal
     * @param adapterId Identifier of the adapter to remove from the system
     * @custom:access Only contract owner can remove adapters
     * @custom:validation Ensures adapter exists before allowing removal
     * @custom:cleanup Completely deletes adapter configuration from storage
     * @custom:emits Events.AdapterRemoved with adapter identifier
     * @custom:revert Errors.AdapterNotRegistered if adapter ID is not found
     */
    function removeAdapter(bytes32 adapterId) external override {
        LibDiamond.enforceIsContractOwner();
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        if (ds.oracleStorage.adapters[adapterId].adapterAddress == address(0)) {
            revert Errors.AdapterNotRegistered(adapterId);
        }

        delete ds.oracleStorage.adapters[adapterId];

        emit Events.AdapterRemoved(adapterId);
    }

    // Asset Configuration Functions

    /**
     * @notice Configures comprehensive oracle settings for a specific asset
     * @dev Sets up adapter priority order, staleness thresholds, and decimal precision for an asset
     * @dev Validates that all adapters in priority list are properly registered
     * @dev Only contract owner can configure assets for security
     * @param assetId Asset identifier (e.g., keccak256("BTC-USD"))
     * @param adapterPriority Ordered array of adapter IDs to try (first = highest priority for failover)
     * @param maxStaleness Maximum time in seconds before this asset's price is considered stale
     * @param decimals Number of decimals for oracle price (0-18, where 0 defaults to 18 decimals)
     * @custom:access Only contract owner can configure asset oracle settings
     * @custom:validation Validates adapter registration and decimal precision limits
     * @custom:failover First adapter in priority array is tried first, with automatic failover
     * @custom:emits Events.AssetConfigured with asset configuration details
     * @custom:revert Errors.EmptyAdapterPriority if no adapters provided
     * @custom:revert Errors.InvalidOracleDecimals if decimals > 18
     * @custom:revert Errors.AdapterNotRegistered if any adapter in priority not registered
     */
    function configureAsset(bytes32 assetId, bytes32[] calldata adapterPriority, uint256 maxStaleness, uint8 decimals) external override {
        LibDiamond.enforceIsContractOwner();
        if (adapterPriority.length == 0) {
            revert Errors.EmptyAdapterPriority();
        }
        if (decimals > 18) {
            revert Errors.InvalidOracleDecimals(assetId, decimals);
        }

        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        // Verify all adapters in priority list are registered
        for (uint256 i = 0; i < adapterPriority.length; i++) {
            if (ds.oracleStorage.adapters[adapterPriority[i]].adapterAddress == address(0)) {
                revert Errors.AdapterNotRegistered(adapterPriority[i]);
            }
        }

        ds.oracleStorage.assetConfigs[assetId] = LibDoefinStorage.AssetConfig({
            adapterPriority: adapterPriority,
            maxStaleness: maxStaleness,
            tradingPaused: false,
            lastUpdateTimestamp: 0,
            decimals: decimals
        });

        emit Events.AssetConfigured(assetId, adapterPriority, maxStaleness);
    }

    /**
     * @notice Configures the maximum age allowed for manual price updates with EIP-712 signatures
     * @dev Sets time limit for accepting manually submitted price updates to prevent replay attacks
     * @dev Only contract owner can set this parameter for security
     * @dev Enforces reasonable bounds between 1 minute and 1 hour for practical usage
     * @param maxAge Maximum age in seconds (must be between 60 and 3600 seconds)
     * @custom:access Only contract owner can set maximum manual update age
     * @custom:validation Enforces minimum 60 seconds and maximum 3600 seconds bounds
     * @custom:security Prevents replay attacks by limiting acceptable signature age
     * @custom:emits Events.MaxManualUpdateAgeSet with new maximum age setting
     * @custom:revert Errors.InvalidMaxManualUpdateAge if age outside valid range
     */
    function setMaxManualUpdateAge(uint256 maxAge) external override {
        LibDiamond.enforceIsContractOwner();

        if (maxAge < 60 || maxAge > 3600) {
            revert Errors.InvalidMaxManualUpdateAge();
        }

        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        ds.oracleStorage.maxManualUpdateAge = maxAge;

        emit Events.MaxManualUpdateAgeSet(maxAge);
    }

    /**
     * @notice Updates the adapter priority order for an existing asset configuration
     * @dev Changes the failover sequence by reordering adapters for price update attempts
     * @dev Validates that all new adapters in priority list are properly registered
     * @dev Only contract owner can update adapter priorities for security
     * @param assetId Asset identifier for which to update adapter priority
     * @param newPriority New ordered array of adapter IDs (first = highest priority)
     * @custom:access Only contract owner can update asset adapter priorities
     * @custom:validation Ensures asset is configured and all new adapters are registered
     * @custom:failover Updates the automatic failover sequence for price updates
     * @custom:emits Events.AssetAdapterPriorityUpdated with new priority configuration
     * @custom:revert Errors.AssetNotConfigured if asset has no existing configuration
     * @custom:revert Errors.EmptyAdapterPriority if no adapters provided
     * @custom:revert Errors.AdapterNotRegistered if any adapter not registered
     */
    function updateAssetAdapterPriority(bytes32 assetId, bytes32[] calldata newPriority) external override {
        LibDiamond.enforceIsContractOwner();
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        if (ds.oracleStorage.assetConfigs[assetId].adapterPriority.length == 0) {
            revert Errors.AssetNotConfigured(assetId);
        }

        if (newPriority.length == 0) {
            revert Errors.EmptyAdapterPriority();
        }

        // Verify all adapters are registered
        for (uint256 i = 0; i < newPriority.length; i++) {
            if (ds.oracleStorage.adapters[newPriority[i]].adapterAddress == address(0)) {
                revert Errors.AdapterNotRegistered(newPriority[i]);
            }
        }

        ds.oracleStorage.assetConfigs[assetId].adapterPriority = newPriority;

        emit Events.AssetAdapterPriorityUpdated(assetId, newPriority);
    }

    // Price Update Functions

    /**
     * @notice Updates asset price using configured adapter priority with automatic failover implementation
     * @dev Implements comprehensive failover logic trying adapters in configured priority order
     * @dev Automatically pauses trading if all adapters fail and resumes when price updates succeed
     * @dev Validates price freshness using adapter-specific staleness thresholds
     * @dev Tracks adapter failure counts and resets on successful price updates
     * @param assetId Asset identifier to update price for
     * @custom:failover Tries adapters in priority order with automatic fallback on failures
     * @custom:validation Ensures asset is configured and validates price data freshness
     * @custom:state Updates price data, asset timestamps, and trading pause status
     * @custom:error Tracks adapter failures and increments failure counters
     * @custom:emits Events.PriceUpdated on success, Events.TradingPaused/Resumed on status changes
     * @custom:emits Events.AdapterFailed for individual adapter failures
     * @custom:emits Events.AllAdaptersFailed when all adapters fail
     * @custom:revert Errors.AssetNotConfigured if asset has no oracle configuration
     * @custom:revert Errors.AllOracleAdaptersFailed if all configured adapters fail
     */
    function updatePrice(bytes32 assetId) external override {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        LibDoefinStorage.AssetConfig storage assetConfig = ds.oracleStorage.assetConfigs[assetId];

        if (assetConfig.adapterPriority.length == 0) {
            revert Errors.AssetNotConfigured(assetId);
        }
        bytes32[] memory attemptedAdapters = new bytes32[](assetConfig.adapterPriority.length);

        // Try each adapter in priority order
        for (uint256 i = 0; i < assetConfig.adapterPriority.length; i++) {
            bytes32 adapterId = assetConfig.adapterPriority[i];
            attemptedAdapters[i] = adapterId;

            LibDoefinStorage.AdapterConfig storage adapterConfig = ds.oracleStorage.adapters[adapterId];

            if (!adapterConfig.enabled) {
                continue;
            }

            try IBaseOracleAdapter(adapterConfig.adapterAddress).getLatestPrice(assetId) returns (uint256 price, uint256 timestamp, bool isValid) {
                if (isValid && price > 0 && timestamp <= block.timestamp) {
                    // Check staleness against adapter's max staleness
                    if (block.timestamp - timestamp <= adapterConfig.maxStaleness) {
                        // Successful price update
                        ds.oracleStorage.priceData[assetId] = LibDoefinStorage.PriceData({
                            price: price,
                            timestamp: timestamp,
                            lastSuccessfulAdapterId: adapterId,
                            isValid: true
                        });

                        assetConfig.lastUpdateTimestamp = block.timestamp;

                        // Reset adapter failure count on success
                        adapterConfig.failureCount = 0;

                        // Resume trading if it was paused
                        if (assetConfig.tradingPaused) {
                            assetConfig.tradingPaused = false;
                            emit Events.TradingResumed(assetId, price, timestamp);
                        }

                        emit Events.PriceUpdated(assetId, price, timestamp, adapterId);
                        return;
                    } else {
                        // Price is valid but stale - don't count as adapter failure
                        emit Events.PriceStale(assetId, timestamp, block.timestamp);
                        continue;
                    }
                }
            } catch {
                // Adapter call failed
            }

            // Increment failure count for this adapter
            adapterConfig.failureCount++;
            emit Events.AdapterFailed(adapterId, assetId, adapterConfig.failureCount);
        }

        // All adapters failed - pause trading
        assetConfig.tradingPaused = true;
        emit Events.AllAdaptersFailed(assetId, attemptedAdapters);
        emit Events.TradingPaused(assetId);

        revert Errors.AllOracleAdaptersFailed(assetId);
    }

    /**
     * @notice Queries current price with automatic staleness checking and trading status
     * @dev Returns price data along with trading pause status based on staleness and configuration
     * @dev Performs automatic staleness calculation using configured asset-specific thresholds
     * @dev Essential for trading operations to determine if asset pricing is reliable
     * @param assetId Asset identifier to query price for
     * @return price Latest price value for the asset
     * @return timestamp Unix timestamp when price was last successfully updated
     * @return isPaused Whether trading is currently paused (due to staleness or manual pause)
     * @custom:view Read-only price query with staleness validation
     * @custom:validation Ensures asset is configured before returning price data
     * @custom:staleness Automatically calculates if price data exceeds staleness threshold
     * @custom:trading Returns trading pause status for external trading validation
     * @custom:revert Errors.AssetNotConfigured if asset has no oracle configuration
     */
    function getPrice(bytes32 assetId) external view override returns (uint256 price, uint256 timestamp, bool isPaused) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        LibDoefinStorage.AssetConfig storage assetConfig = ds.oracleStorage.assetConfigs[assetId];
        LibDoefinStorage.PriceData storage priceData = ds.oracleStorage.priceData[assetId];

        if (assetConfig.adapterPriority.length == 0) {
            revert Errors.AssetNotConfigured(assetId);
        }

        price = priceData.price;
        timestamp = priceData.timestamp;

        // Check if price is stale
        bool isStale = (block.timestamp - timestamp) > assetConfig.maxStaleness;
        isPaused = assetConfig.tradingPaused || isStale;
    }

    /**
     * @notice Manually updates asset price using EIP-712 signature verification for authorized updates
     * @dev Allows authorized signers to submit price updates with cryptographic signature verification
     * @dev Implements comprehensive replay attack protection using nonces and timestamp validation
     * @dev Automatically resumes trading if it was paused due to stale or failed oracle data
     * @param assetId Asset identifier to update price for
     * @param price New price value to set for the asset
     * @param timestamp Unix timestamp when this price data was generated
     * @param nonce Unique nonce for replay protection (must not have been used before)
     * @param signature EIP-712 signature from authorized signer proving authenticity
     * @custom:signature Uses EIP-712 structured data signing for secure price updates
     * @custom:authorization Only authorized signer can submit valid manual updates
     * @custom:replay Comprehensive nonce-based replay attack protection
     * @custom:validation Validates price, timestamp freshness, and signature authenticity
     * @custom:trading Automatically resumes trading if paused when valid price provided
     * @custom:emits Events.ManualPriceUpdate with update details and signer
     * @custom:revert Errors.InvalidPrice if price is zero
     * @custom:revert Errors.InvalidTimestamp if timestamp is in the future
     * @custom:revert Errors.SignatureExpired if price data exceeds maximum age
     * @custom:revert Errors.NonceAlreadyUsed if nonce has been used before
     * @custom:revert Errors.InvalidSignature or UnauthorizedSigner for authentication failures
     */
    function manualUpdatePrice(bytes32 assetId, uint256 price, uint256 timestamp, bytes32 nonce, bytes calldata signature) external override {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        if (price == 0) revert Errors.InvalidPrice();
        if (timestamp > block.timestamp) revert Errors.InvalidTimestamp();

        // Use configured maxManualUpdateAge, default to 300 seconds if not set
        uint256 maxAge = ds.oracleStorage.maxManualUpdateAge;
        if (maxAge == 0) maxAge = 300; // Fallback to default
        if (block.timestamp - timestamp > maxAge) revert Errors.SignatureExpired();

        if (ds.oracleStorage.usedNonces[nonce]) revert Errors.NonceAlreadyUsed();

        // Verify EIP-712 signature
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", _buildDomainSeparator(), keccak256(abi.encode(PRICE_TYPEHASH, assetId, price, timestamp, nonce)))
        );

        address recoveredSigner = _recoverSigner(digest, signature);
        if (recoveredSigner == address(0)) revert Errors.InvalidSignature();
        if (recoveredSigner != ds.oracleStorage.authorizedSigner) {
            revert Errors.UnauthorizedSigner();
        }

        // Mark nonce as used
        ds.oracleStorage.usedNonces[nonce] = true;

        // Update price
        ds.oracleStorage.priceData[assetId] = LibDoefinStorage.PriceData({
            price: price,
            timestamp: timestamp,
            lastSuccessfulAdapterId: keccak256("ManualUpdate"),
            isValid: true
        });

        // Update asset config
        LibDoefinStorage.AssetConfig storage assetConfig = ds.oracleStorage.assetConfigs[assetId];
        assetConfig.lastUpdateTimestamp = block.timestamp;

        // Resume trading if paused
        if (assetConfig.tradingPaused) {
            assetConfig.tradingPaused = false;
            emit Events.TradingResumed(assetId, price, timestamp);
        }

        emit Events.ManualPriceUpdate(assetId, price, timestamp, recoveredSigner);
    }

    /**
     * @notice Emergency price update for critical oracle failure scenarios requiring immediate intervention
     * @dev Allows contract owner to set price directly when all oracle adapters fail completely
     * @dev Bypasses all normal validation and immediately resumes trading with provided price
     * @dev Should only be used in extreme circumstances when oracle infrastructure fails
     * @param assetId Asset identifier to set emergency price for
     * @param price Emergency price value to set for the asset
     * @param justification Human-readable explanation for the emergency price update
     * @custom:access Only contract owner can perform emergency price updates
     * @custom:emergency Bypasses normal oracle validation for critical failure scenarios
     * @custom:validation Only validates that price is not zero
     * @custom:trading Immediately resumes trading with the emergency price
     * @custom:justification Requires human-readable justification for transparency
     * @custom:emits Events.EmergencyPriceUpdate with price and justification
     * @custom:emits Events.TradingResumed to indicate trading status change
     * @custom:revert Errors.InvalidPrice if emergency price is zero
     */
    function emergencyUpdatePrice(bytes32 assetId, uint256 price, string calldata justification) external override {
        LibDiamond.enforceIsContractOwner();
        if (price == 0) revert Errors.InvalidPrice();

        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        ds.oracleStorage.priceData[assetId] = LibDoefinStorage.PriceData({
            price: price,
            timestamp: block.timestamp,
            lastSuccessfulAdapterId: keccak256("EmergencyUpdate"),
            isValid: true
        });

        // Update asset config and resume trading
        LibDoefinStorage.AssetConfig storage assetConfig = ds.oracleStorage.assetConfigs[assetId];
        assetConfig.lastUpdateTimestamp = block.timestamp;
        assetConfig.tradingPaused = false;

        emit Events.EmergencyPriceUpdate(assetId, price, justification);
        emit Events.TradingResumed(assetId, price, block.timestamp);
    }

    // Query Functions

    /**
     * @notice Retrieves complete adapter configuration information for diagnostics and monitoring
     * @dev Returns all adapter parameters including address, staleness, failure count, and enabled status
     * @dev Essential for monitoring adapter health and configuration verification
     * @param adapterId Unique identifier of the adapter to query configuration for
     * @return Complete AdapterConfig struct with all adapter configuration parameters
     * @custom:view Read-only access to adapter configuration storage
     * @custom:monitoring Essential for adapter health monitoring and diagnostics
     * @custom:configuration Provides complete adapter parameter visibility
     * @custom:struct Returns LibDoefinStorage.AdapterConfig with all adapter details
     */
    function getAdapterInfo(bytes32 adapterId) external view override returns (LibDoefinStorage.AdapterConfig memory) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        return ds.oracleStorage.adapters[adapterId];
    }

    /**
     * @notice Retrieves comprehensive oracle status for an asset including configuration and staleness analysis
     * @dev Provides complete oracle health assessment combining configuration, price data, and staleness calculation
     * @dev Essential for diagnostics, monitoring, and debugging oracle-related issues
     * @param assetId Asset identifier to query complete oracle status for
     * @return assetConfig Complete asset configuration including adapter priority and settings
     * @return priceData Current price data with timestamp and last successful adapter
     * @return isStale Whether current price data exceeds configured staleness threshold
     * @custom:view Read-only comprehensive oracle status assessment
     * @custom:monitoring Complete oracle health visibility for diagnostics
     * @custom:staleness Automatic staleness calculation based on asset configuration
     * @custom:comprehensive Combines configuration, price data, and staleness in single call
     */
    function getAssetOracleStatus(
        bytes32 assetId
    ) external view override returns (LibDoefinStorage.AssetConfig memory assetConfig, LibDoefinStorage.PriceData memory priceData, bool isStale) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        assetConfig = ds.oracleStorage.assetConfigs[assetId];
        priceData = ds.oracleStorage.priceData[assetId];

        if (assetConfig.maxStaleness > 0 && priceData.timestamp > 0) {
            isStale = (block.timestamp - priceData.timestamp) > assetConfig.maxStaleness;
        } else {
            isStale = true; // No price data or config
        }
    }

    /**
     * @notice Sets the authorized signer address for manual price updates with EIP-712 signatures
     * @dev Configures which address can sign manual price updates for emergency situations
     * @dev Only contract owner can set authorized signer for security
     * @dev Emits event showing old and new signer for transparency
     * @param signer Address of the new authorized signer (cannot be zero address)
     * @custom:access Only contract owner can set authorized signer
     * @custom:validation Ensures signer address is not zero
     * @custom:security Critical for manual price update authorization control
     * @custom:emits Events.AuthorizedSignerUpdated with old and new signer addresses
     * @custom:revert Errors.ZeroAddress if signer is zero address
     */
    function setAuthorizedSigner(address signer) external override {
        LibDiamond.enforceIsContractOwner();
        if (signer == address(0)) revert Errors.ZeroAddress();
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        address oldSigner = ds.oracleStorage.authorizedSigner;
        ds.oracleStorage.authorizedSigner = signer;
        emit Events.AuthorizedSignerUpdated(oldSigner, signer);
    }

    // Internal helper functions

    /**
     * @dev Builds EIP-712 domain separator for signature verification
     * @dev Creates domain separator specific to this contract and chain for signature validation
     * @dev Uses contract address and chain ID to prevent cross-contract and cross-chain replay
     * @return EIP-712 domain separator hash for signature verification
     * @custom:eip Standard EIP-712 domain separator construction
     * @custom:security Prevents cross-contract and cross-chain signature replay attacks
     * @custom:internal Used internally for manual price update signature verification
     */
    function _buildDomainSeparator() internal view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("DoefinOracleManager"), keccak256("1"), block.chainid, address(this)));
    }

    /**
     * @dev Recovers signer address from EIP-712 signature using ECDSA.
     * @dev Delegates to {LibSignature.recoverMemory} so the v-normalization and the
     *      low-`s` malleability check are applied uniformly across all facets.
     * @param digest EIP-712 message hash to verify signature against
     * @param signature 65-byte ECDSA signature (r + s + v format)
     * @return Recovered signer address (zero if signature invalid or `s` is high)
     * @custom:audit SEC-005 — pre-fix this copy lacked v normalization AND the low-`s`
     *      malleability check entirely; a counterparty could replay or trivially
     *      malleate a signed manual-price-update message. Now routed through {LibSignature}.
     * @custom:revert Errors.InvalidSignatureLength if signature not exactly 65 bytes
     */
    function _recoverSigner(bytes32 digest, bytes memory signature) internal pure returns (address) {
        return LibSignature.recoverMemory(digest, signature);
    }
}
