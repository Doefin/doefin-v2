// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";

/**
 * @title IOracleManager
 * @notice Interface for the OracleManagerFacet that handles oracle registry and price management
 */
interface IOracleManager {
    // Registry Management Functions
    function registerAdapter(bytes32 adapterId, address adapterAddress, uint256 maxStaleness) external;

    function updateAdapterConfig(bytes32 adapterId, LibDoefinStorage.AdapterConfig calldata config) external;

    function removeAdapter(bytes32 adapterId) external;

    // Asset Configuration Functions
    function configureAsset(bytes32 assetId, bytes32[] calldata adapterPriority, uint256 maxStaleness, uint8 decimals) external;

    function updateAssetAdapterPriority(bytes32 assetId, bytes32[] calldata newPriority) external;

    // Price Update Functions
    function updatePrice(bytes32 assetId) external;

    function manualUpdatePrice(bytes32 assetId, uint256 price, uint256 timestamp, bytes32 nonce, bytes calldata signature) external;

    function emergencyUpdatePrice(bytes32 assetId, uint256 price, string calldata justification) external;

    // Price Query Functions
    function getPrice(bytes32 assetId) external view returns (uint256 price, uint256 timestamp, bool isPaused);

    function getAdapterInfo(bytes32 adapterId) external view returns (LibDoefinStorage.AdapterConfig memory);

    function getAssetOracleStatus(
        bytes32 assetId
    ) external view returns (LibDoefinStorage.AssetConfig memory assetConfig, LibDoefinStorage.PriceData memory priceData, bool isStale);

    // Admin Functions
    function setAuthorizedSigner(address signer) external;

    function setMaxManualUpdateAge(uint256 maxAge) external;
}
