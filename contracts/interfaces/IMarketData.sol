// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";

interface IMarketData {
    /// @notice Get all markets for a given condition (now returns all markets across different collaterals/parents)
    /// @param conditionId The condition identifier
    /// @return markets Array of market metadata for all markets associated with the condition
    function getMarketsByCondition(bytes32 conditionId) external view returns (LibDoefinStorage.MarketMetadata[] memory markets);

    /// @notice Get all position IDs across all markets for a given condition
    /// @param conditionId The condition identifier
    /// @return positionIds Array of all position IDs associated with the condition
    function getAllPositionIdsByCondition(bytes32 conditionId) external view returns (uint256[] memory positionIds);

    /// @notice Get position IDs for a specific market (condition + collateral + parent)
    /// @param conditionId The condition identifier
    /// @param collateralToken The collateral token address
    /// @param parentCollectionId The parent collection identifier
    /// @return positionIds Array of position IDs for the specific market
    function getPositionIdsByMarket(
        bytes32 conditionId,
        address collateralToken,
        bytes32 parentCollectionId
    ) external view returns (uint256[] memory positionIds);

    /// @notice Get market metadata for a specific position
    /// @param positionId The position identifier
    /// @return metadata Complete market metadata including collateral token, parent collection, position IDs, and partitions
    function getMarketMetadata(uint256 positionId) external view returns (LibDoefinStorage.MarketMetadata memory metadata);

    /// @notice Get market metadata for a specific market combination
    /// @param conditionId The condition identifier
    /// @param collateralToken The collateral token address
    /// @param parentCollectionId The parent collection identifier
    /// @return metadata Complete market metadata for the specific market
    function getMarketMetadataByMarket(
        bytes32 conditionId,
        address collateralToken,
        bytes32 parentCollectionId
    ) external view returns (LibDoefinStorage.MarketMetadata memory metadata);

    /// @notice Get the collateral token address for a position
    /// @param positionId The position identifier
    /// @return collateralToken The address of the collateral token
    function getCollateralToken(uint256 positionId) external view returns (address collateralToken);

    /// @notice Get the collateral token unit/digits for a position
    /// @param positionId The position identifier
    /// @return unit The unit per pair for the collateral token
    function getCollateralUnit(uint256 positionId) external view returns (uint256 unit);

    /// @notice Get the condition ID for a position
    /// @param positionId The position identifier
    /// @return conditionId The condition identifier
    function getConditionId(uint256 positionId) external view returns (bytes32 conditionId);

    /// @notice Get the complement position ID for a given position
    /// @param positionId The position identifier
    /// @return complementId The complement position ID
    function getComplement(uint256 positionId) external view returns (uint256 complementId);

    /// @notice Get comprehensive position information in one call
    /// @param positionId The position identifier
    /// @return conditionId The condition identifier
    /// @return collateralToken The collateral token address
    /// @return unit The collateral token unit
    /// @return complementId The complement position ID
    /// @return metadata The complete market metadata
    function getPositionInfo(uint256 positionId)
        external
        view
        returns (
            bytes32 conditionId,
            address collateralToken,
            uint256 unit,
            uint256 complementId,
            LibDoefinStorage.MarketMetadata memory metadata
        );
}
