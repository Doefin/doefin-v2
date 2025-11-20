// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {IBaseOracleAdapter} from "../interfaces/IBaseOracleAdapter.sol";
import "../libraries/Errors.sol";

/**
 * @title MockOracleAdapter
 * @notice Mock oracle adapter for development and testing
 * @dev Allows setting prices and failure modes for testing oracle failover logic
 */
contract MockOracleAdapter is IBaseOracleAdapter {
    mapping(bytes32 => uint256) private prices;
    mapping(bytes32 => uint256) private timestamps;
    mapping(bytes32 => bool) private validityFlags;
    mapping(bytes32 => bool) private shouldFail;

    bytes32[] private supportedAssets;
    address public owner;

    string public constant ADAPTER_NAME = "MockOracleV1";
    string public constant ADAPTER_VERSION = "1.0.0";

    event PriceSet(bytes32 indexed assetId, uint256 price, uint256 timestamp);
    event FailureModeSet(bytes32 indexed assetId, bool shouldFail);
    event AssetAdded(bytes32 indexed assetId);

    modifier onlyOwner() {
        if (msg.sender != owner) {
            revert Errors.NotOwner();
        }
        _;
    }

    constructor() {
        owner = msg.sender;

        // Initialize with some common assets for testing
        bytes32 btcUsd = keccak256("BTC-USD");
        bytes32 usdUsdc = keccak256("USD-USDC");
        bytes32 usdUsdt = keccak256("USD-USDT");

        supportedAssets.push(btcUsd);
        supportedAssets.push(usdUsdc);
        supportedAssets.push(usdUsdt);

        // Set default prices (with 8 decimal places for BTC, 6 for stablecoins)
        prices[btcUsd] = 45000_00000000; // $45,000 BTC
        prices[usdUsdc] = 1_000000; // $1.00 USDC
        prices[usdUsdt] = 1_000000; // $1.00 USDT

        timestamps[btcUsd] = block.timestamp;
        timestamps[usdUsdc] = block.timestamp;
        timestamps[usdUsdt] = block.timestamp;

        validityFlags[btcUsd] = true;
        validityFlags[usdUsdc] = true;
        validityFlags[usdUsdt] = true;

        emit AssetAdded(btcUsd);
        emit AssetAdded(usdUsdc);
        emit AssetAdded(usdUsdt);
    }

    /**
     * @notice Get the latest price for a specific asset
     * @param assetId The asset identifier
     * @return price The latest price
     * @return timestamp The timestamp when this price was set
     * @return isValid Whether the price data is valid
     */
    function getLatestPrice(bytes32 assetId) external view override returns (uint256 price, uint256 timestamp, bool isValid) {
        // Simulate failure if configured
        if (shouldFail[assetId]) {
            revert("Mock adapter configured to fail");
        }

        price = prices[assetId];
        timestamp = timestamps[assetId];
        isValid = validityFlags[assetId] && price > 0;
    }

    /**
     * @notice Get all asset IDs that this adapter supports
     * @return Array of supported asset identifiers
     */
    function getSupportedAssets() external view override returns (bytes32[] memory) {
        return supportedAssets;
    }

    /**
     * @notice Get metadata about this oracle adapter
     * @return name Human-readable name of the adapter
     * @return version Version string of the adapter
     */
    function getAdapterMetadata() external pure override returns (string memory name, string memory version) {
        return (ADAPTER_NAME, ADAPTER_VERSION);
    }

    // Admin functions for testing

    /**
     * @notice Set price for an asset (testing only)
     * @param assetId Asset to set price for
     * @param price New price
     */
    function setPrice(bytes32 assetId, uint256 price) external onlyOwner {
        prices[assetId] = price;
        timestamps[assetId] = block.timestamp;
        validityFlags[assetId] = true;

        emit PriceSet(assetId, price, block.timestamp);
    }

    /**
     * @notice Set price with custom timestamp (testing only)
     * @param assetId Asset to set price for
     * @param price New price
     * @param timestamp Custom timestamp
     */
    function setPriceWithTimestamp(bytes32 assetId, uint256 price, uint256 timestamp) external onlyOwner {
        prices[assetId] = price;
        timestamps[assetId] = timestamp;
        validityFlags[assetId] = true;

        emit PriceSet(assetId, price, timestamp);
    }

    /**
     * @notice Configure failure mode for an asset (testing only)
     * @param assetId Asset to configure
     * @param _shouldFail Whether getLatestPrice should revert for this asset
     */
    function setFailure(bytes32 assetId, bool _shouldFail) external onlyOwner {
        shouldFail[assetId] = _shouldFail;

        emit FailureModeSet(assetId, _shouldFail);
    }

    /**
     * @notice Set validity flag for an asset (testing only)
     * @param assetId Asset to configure
     * @param isValid Whether the price should be marked as valid
     */
    function setValidity(bytes32 assetId, bool isValid) external onlyOwner {
        validityFlags[assetId] = isValid;
    }

    /**
     * @notice Add support for a new asset (testing only)
     * @param assetId New asset to support
     * @param initialPrice Initial price for the asset
     */
    function addAsset(bytes32 assetId, uint256 initialPrice) external onlyOwner {
        // Check if asset already exists
        bool exists = false;
        for (uint256 i = 0; i < supportedAssets.length; i++) {
            if (supportedAssets[i] == assetId) {
                exists = true;
                break;
            }
        }

        if (!exists) {
            supportedAssets.push(assetId);
            emit AssetAdded(assetId);
        }

        prices[assetId] = initialPrice;
        timestamps[assetId] = block.timestamp;
        validityFlags[assetId] = true;

        emit PriceSet(assetId, initialPrice, block.timestamp);
    }

    /**
     * @notice Transfer ownership (testing only)
     * @param newOwner New owner address
     */
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) {
            revert Errors.InvalidAddress();
        }
        owner = newOwner;
    }

    // View functions for debugging

    /**
     * @notice Check if an asset is configured to fail
     * @param assetId Asset to check
     * @return Whether the asset is set to fail
     */
    function getFailureMode(bytes32 assetId) external view returns (bool) {
        return shouldFail[assetId];
    }

    /**
     * @notice Get validity flag for an asset
     * @param assetId Asset to check
     * @return Whether the asset's price is marked as valid
     */
    function getValidityFlag(bytes32 assetId) external view returns (bool) {
        return validityFlags[assetId];
    }

    /**
     * @notice Get raw price data for an asset (without failure simulation)
     * @param assetId Asset to check
     * @return price Stored price
     * @return timestamp Stored timestamp
     * @return isValid Stored validity flag
     */
    function getRawPriceData(bytes32 assetId) external view returns (uint256 price, uint256 timestamp, bool isValid) {
        return (prices[assetId], timestamps[assetId], validityFlags[assetId]);
    }
}
