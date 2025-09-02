// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {LibPositionRegistry} from "../libraries/LibPositionRegistry.sol";
import {IMarketData} from "../interfaces/IMarketData.sol";
import {Errors} from "../libraries/Errors.sol";

contract MarketDataFacet is IMarketData {
    /// @notice Get all markets for a given condition (now returns all markets across different collaterals/parents)
    /// @param conditionId The condition identifier
    /// @return markets Array of market metadata for all markets associated with the condition
    function getMarketsByCondition(bytes32 conditionId) external view override returns (LibDoefinStorage.MarketMetadata[] memory markets) {
        // Use the new registry function that returns all markets for a condition
        return LibPositionRegistry.getMarketsForCondition(conditionId);
    }

    /// @notice Get all position IDs across all markets for a given condition
    /// @param conditionId The condition identifier
    /// @return positionIds Array of all position IDs associated with the condition
    function getAllPositionIdsByCondition(bytes32 conditionId) external view returns (uint256[] memory positionIds) {
        LibDoefinStorage.MarketMetadata[] memory markets = LibPositionRegistry.getMarketsForCondition(conditionId);
        
        // Calculate total position count
        uint256 totalPositions = 0;
        for (uint256 i = 0; i < markets.length; i++) {
            totalPositions += markets[i].positionIds.length;
        }
        
        // Build combined array
        positionIds = new uint256[](totalPositions);
        uint256 index = 0;
        for (uint256 i = 0; i < markets.length; i++) {
            for (uint256 j = 0; j < markets[i].positionIds.length; j++) {
                positionIds[index] = markets[i].positionIds[j];
                index++;
            }
        }
    }

    /// @notice Get position IDs for a specific market (condition + collateral + parent)
    /// @param conditionId The condition identifier
    /// @param collateralToken The collateral token address
    /// @param parentCollectionId The parent collection identifier
    /// @return positionIds Array of position IDs for the specific market
    function getPositionIdsByMarket(
        bytes32 conditionId,
        address collateralToken,
        bytes32 parentCollectionId
    ) external view returns (uint256[] memory positionIds) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        
        // Create the market key
        bytes32 marketKey = keccak256(abi.encodePacked(conditionId, parentCollectionId, collateralToken));
        
        LibDoefinStorage.MarketMetadata storage metadata = ds.positionRegistry.marketsByKey[marketKey];
        
        // Validate market exists
        if (metadata.collateralToken == address(0)) {
            revert Errors.ConditionDoesNotExist();
        }
        
        return metadata.positionIds;
    }

    /// @notice Get market metadata for a specific position
    /// @param positionId The position identifier
    /// @return metadata Complete market metadata including collateral token, parent collection, position IDs, and partitions
    function getMarketMetadata(uint256 positionId) external view override returns (LibDoefinStorage.MarketMetadata memory metadata) {
        // Use existing validation from LibPositionRegistry
        return LibPositionRegistry.getMarketMetadata(positionId);
    }

    /// @notice Get market metadata for a specific market combination
    /// @param conditionId The condition identifier
    /// @param collateralToken The collateral token address
    /// @param parentCollectionId The parent collection identifier
    /// @return metadata Complete market metadata for the specific market
    function getMarketMetadataByMarket(
        bytes32 conditionId,
        address collateralToken,
        bytes32 parentCollectionId
    ) external view returns (LibDoefinStorage.MarketMetadata memory metadata) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        
        // Create the market key
        bytes32 marketKey = keccak256(abi.encodePacked(conditionId, parentCollectionId, collateralToken));
        
        LibDoefinStorage.MarketMetadata storage storedMetadata = ds.positionRegistry.marketsByKey[marketKey];
        
        // Validate market exists
        if (storedMetadata.collateralToken == address(0)) {
            revert Errors.ConditionDoesNotExist();
        }
        
        return storedMetadata;
    }

    /// @notice Get the collateral token address for a position
    /// @param positionId The position identifier
    /// @return collateralToken The address of the collateral token
    function getCollateralToken(uint256 positionId) external view override returns (address collateralToken) {
        return LibPositionRegistry.getCollateralToken(positionId);
    }

    /// @notice Get the collateral token unit/digits for a position
    /// @param positionId The position identifier
    /// @return unit The unit per pair for the collateral token
    function getCollateralUnit(uint256 positionId) external view override returns (uint256 unit) {
        // Validate position first
        LibPositionRegistry.validatePositionId(positionId);

        // Get collateral token
        address collateralToken = LibPositionRegistry.getCollateralToken(positionId);

        // Get unit from admin config storage
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        return ds.adminConfigStorage.unitPerPair[collateralToken];
    }

    /// @notice Get the condition ID for a position
    /// @param positionId The position identifier
    /// @return conditionId The condition identifier
    function getConditionId(uint256 positionId) external view override returns (bytes32 conditionId) {
        // Validate position first
        LibPositionRegistry.validatePositionId(positionId);

        // Use existing mapping
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        return ds.positionRegistry.conditionIdByPositionId[positionId];
    }

    /// @notice Get the complement position ID for a given position
    /// @param positionId The position identifier
    /// @return complementId The complement position ID
    function getComplement(uint256 positionId) external view override returns (uint256 complementId) {
        // Use existing library function
        return LibPositionRegistry.getComplement(positionId);
    }

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
        override
        returns (
            bytes32 conditionId,
            address collateralToken,
            uint256 unit,
            uint256 complementId,
            LibDoefinStorage.MarketMetadata memory metadata
        )
    {
        // Validate position exists once
        LibPositionRegistry.validatePositionId(positionId);

        // Get all information efficiently
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        conditionId = ds.positionRegistry.conditionIdByPositionId[positionId];
        collateralToken = LibPositionRegistry.getCollateralToken(positionId);
        complementId = LibPositionRegistry.getComplement(positionId);
        metadata = LibPositionRegistry.getMarketMetadata(positionId);

        // Get unit from admin config storage
        if (!ds.adminConfigStorage.isAllowed[collateralToken]) {
            revert Errors.TokenNotAllowed();
        }
        unit = ds.adminConfigStorage.unitPerPair[collateralToken];
    }
}
