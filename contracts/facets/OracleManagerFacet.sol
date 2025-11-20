// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {IBaseOracleAdapter} from "../interfaces/IBaseOracleAdapter.sol";
import {IOracleManager} from "../interfaces/IOracleManager.sol";
import {LibDiamond} from "../libraries/LibDiamond.sol";
import {Errors} from "../libraries/Errors.sol";
import {Events} from "../libraries/Events.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/**
 * @title OracleManagerFacet
 * @notice Manages oracle adapters, asset configurations, and price updates with failover support
 * @dev This facet implements the IOracleManager interface and handles all oracle-related operations
 */
contract OracleManagerFacet is IOracleManager {
    using LibDoefinStorage for LibDoefinStorage.AppStorage;

    // Constants for EIP-712
    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant PRICE_TYPEHASH = keccak256("PriceData(bytes32 assetId,uint256 price,uint256 timestamp,bytes32 nonce)");

    /**
     * @notice Register a new oracle adapter
     * @param adapterId Unique identifier for the adapter (e.g., keccak256("BlockscholesV1"))
     * @param adapterAddress Contract address of the adapter
     * @param maxStaleness Maximum time in seconds before prices from this adapter are considered stale
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
     * @notice Update configuration for an existing adapter
     * @param adapterId Adapter to update
     * @param config New configuration
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
     * @notice Remove (disable) an oracle adapter
     * @param adapterId Adapter to remove
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
     * @notice Configure oracle settings for an asset
     * @param assetId Asset identifier (e.g., keccak256("BTC-USD"))
     * @param adapterPriority Ordered array of adapter IDs to try (first = highest priority)
     * @param maxStaleness Maximum time before this asset's price is considered stale
     */
    function configureAsset(bytes32 assetId, bytes32[] calldata adapterPriority, uint256 maxStaleness) external override {
        LibDiamond.enforceIsContractOwner();
        if (adapterPriority.length == 0) {
            revert Errors.EmptyAdapterPriority();
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
            lastUpdateTimestamp: 0
        });

        emit Events.AssetConfigured(assetId, adapterPriority, maxStaleness);
    }

    /**
     * @notice Update the adapter priority order for an asset
     * @param assetId Asset to update
     * @param newPriority New priority order
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
     * @notice Update price for an asset using the configured adapter priority
     * @param assetId Asset to update
     * @dev This function implements automatic failover logic
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

        revert("All oracle adapters failed");
    }

    /**
     * @notice Query price with automatic staleness checking
     * @param assetId Asset to query
     * @return price Latest price
     * @return timestamp When price was last updated
     * @return isPaused Whether trading is currently paused
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
     * @notice Manual price update with EIP-712 signature verification
     * @param assetId Asset to update
     * @param price New price
     * @param timestamp Price timestamp
     * @param nonce Unique nonce for replay protection
     * @param signature EIP-712 signature from authorized signer
     */
    function manualUpdatePrice(bytes32 assetId, uint256 price, uint256 timestamp, bytes32 nonce, bytes calldata signature) external override {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        if (price == 0) revert Errors.InvalidPrice();
        if (timestamp > block.timestamp) revert Errors.InvalidTimestamp();
        if (block.timestamp - timestamp > 300) revert Errors.SignatureExpired(); // 5 minute max age
        if (ds.oracleStorage.usedNonces[nonce]) revert Errors.NonceAlreadyUsed();

        // Verify EIP-712 signature
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", _buildDomainSeparator(), keccak256(abi.encode(PRICE_TYPEHASH, assetId, price, timestamp, nonce)))
        );

        address recoveredSigner = _recoverSigner(digest, signature);
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
     * @notice Emergency price update for complete oracle failures
     * @param assetId Asset to update
     * @param price Emergency price
     * @param justification Human-readable justification
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
     * @notice Get adapter information
     * @param adapterId Adapter to query
     * @return Adapter configuration
     */
    function getAdapterInfo(bytes32 adapterId) external view override returns (LibDoefinStorage.AdapterConfig memory) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        return ds.oracleStorage.adapters[adapterId];
    }

    /**
     * @notice Get complete oracle status for an asset
     * @param assetId Asset to query
     * @return assetConfig Asset configuration
     * @return priceData Current price data
     * @return isStale Whether the price is considered stale
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
     * @notice Set authorized signer for manual updates
     * @param signer Address of the authorized signer
     */
    function setAuthorizedSigner(address signer) external override {
        LibDiamond.enforceIsContractOwner();
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        ds.oracleStorage.authorizedSigner = signer;
    }

    // Internal helper functions

    function _buildDomainSeparator() internal view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("DoefinOracleManager"), keccak256("1"), block.chainid, address(this)));
    }

    function _recoverSigner(bytes32 digest, bytes memory signature) internal pure returns (address) {
        if (signature.length != 65) {
            revert Errors.InvalidSignatureLength();
        }

        bytes32 r;
        bytes32 s;
        uint8 v;

        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }

        return ecrecover(digest, v, r, s);
    }
}
