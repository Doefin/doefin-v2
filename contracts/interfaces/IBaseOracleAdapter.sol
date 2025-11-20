// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

/**
 * @title IBaseOracleAdapter
 * @notice Minimal interface that all oracle adapters must implement
 * @dev This interface provides a standardized way to fetch price data from different oracle providers
 *      Each adapter handles provider-specific logic internally (API calls, on-chain data, signatures)
 */
interface IBaseOracleAdapter {
    /**
     * @notice Get the latest price for a specific asset
     * @param assetId The asset identifier (e.g., keccak256("BTC-USD"))
     * @return price The latest price in the adapter's native precision
     * @return timestamp The timestamp when this price was last updated
     * @return isValid Whether the price data is valid and fresh
     */
    function getLatestPrice(bytes32 assetId) external view returns (uint256 price, uint256 timestamp, bool isValid);

    /**
     * @notice Get all asset IDs that this adapter supports
     * @return Array of supported asset identifiers
     */
    function getSupportedAssets() external view returns (bytes32[] memory);

    /**
     * @notice Get metadata about this oracle adapter
     * @return name Human-readable name of the adapter (e.g., "BlockscholesV1")
     * @return version Version string of the adapter
     */
    function getAdapterMetadata() external view returns (string memory name, string memory version);
}
