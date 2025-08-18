// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";

interface IMarketData {
    /// @notice Get all position IDs (markets) for a given condition
    /// @param conditionId The condition identifier
    /// @return positionIds Array of position IDs associated with the condition
    function getMarketsByCondition(bytes32 conditionId) external view returns (uint256[] memory positionIds);

    /// @notice Get market metadata for a specific position
    /// @param positionId The position identifier
    /// @return metadata Complete market metadata including collateral token, parent collection, position IDs, and partitions
    function getMarketMetadata(uint256 positionId) external view returns (LibDoefinStorage.MarketMetadata memory metadata);

    /// @notice Get market metadata directly by condition ID (convenience function)
    /// @param conditionId The condition identifier
    /// @return metadata Complete market metadata for the condition
    function getMarketMetadataByCondition(bytes32 conditionId) external view returns (LibDoefinStorage.MarketMetadata memory metadata);

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
