// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {LibPositionRegistry} from "../libraries/LibPositionRegistry.sol";
import {IMarketData} from "../interfaces/IMarketData.sol";
import {Errors} from "../libraries/Errors.sol";

contract MarketDataFacet is IMarketData {
    /// @notice Get all position IDs (markets) for a given condition
    /// @param conditionId The condition identifier
    /// @return positionIds Array of position IDs associated with the condition
    function getMarketsByCondition(bytes32 conditionId) 
        external view override returns (uint256[] memory positionIds) {
        
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        LibDoefinStorage.MarketMetadata storage metadata = ds.positionRegistry.marketsByCondition[conditionId];
        
        // Validate condition exists by checking if collateral token is set
        if (metadata.collateralToken == address(0)) {
            revert Errors.ConditionDoesNotExist();
        }
        
        return metadata.positionIds;
    }
    
    /// @notice Get market metadata for a specific position
    /// @param positionId The position identifier
    /// @return metadata Complete market metadata including collateral token, parent collection, position IDs, and partitions
    function getMarketMetadata(uint256 positionId) 
        external view override returns (LibDoefinStorage.MarketMetadata memory metadata) {
        
        // Use existing validation from LibPositionRegistry
        LibPositionRegistry.validatePositionId(positionId);
        
        // Leverage existing library function
        return LibPositionRegistry.getMarketMetadata(positionId);
    }
    
    /// @notice Get market metadata directly by condition ID (convenience function)
    /// @param conditionId The condition identifier
    /// @return metadata Complete market metadata for the condition
    function getMarketMetadataByCondition(bytes32 conditionId) 
        external view override returns (LibDoefinStorage.MarketMetadata memory metadata) {
        
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        LibDoefinStorage.MarketMetadata storage storedMetadata = ds.positionRegistry.marketsByCondition[conditionId];
        
        // Validate condition exists
        if (storedMetadata.collateralToken == address(0)) {
            revert Errors.ConditionDoesNotExist();
        }
        
        return storedMetadata;
    }

    /// @notice Get the collateral token address for a position
    /// @param positionId The position identifier
    /// @return collateralToken The address of the collateral token
    function getCollateralToken(uint256 positionId)
        external view override returns (address collateralToken) {
        
        // Validate position first
        LibPositionRegistry.validatePositionId(positionId);
        
        // Use existing library function
        return LibPositionRegistry.getCollateralToken(positionId);
    }

    /// @notice Get the collateral token unit/digits for a position
    /// @param positionId The position identifier
    /// @return unit The unit per pair for the collateral token
    function getCollateralUnit(uint256 positionId)
        external view override returns (uint256 unit) {
        
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
    function getConditionId(uint256 positionId)
        external view override returns (bytes32 conditionId) {
        
        // Validate position first
        LibPositionRegistry.validatePositionId(positionId);
        
        // Use existing library function
        return LibPositionRegistry.getConditionId(positionId);
    }

    /// @notice Get the complement position ID for a given position
    /// @param positionId The position identifier
    /// @return complementId The complement position ID
    function getComplement(uint256 positionId) 
        external view override returns (uint256 complementId) {
        
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
        external view override returns (
            bytes32 conditionId,
            address collateralToken,
            uint256 unit,
            uint256 complementId,
            LibDoefinStorage.MarketMetadata memory metadata
        ) {
        
        // Validate position exists once
        LibPositionRegistry.validatePositionId(positionId);
        
        // Get all information efficiently
        conditionId = LibPositionRegistry.getConditionId(positionId);
        collateralToken = LibPositionRegistry.getCollateralToken(positionId);
        complementId = LibPositionRegistry.getComplement(positionId);
        metadata = LibPositionRegistry.getMarketMetadata(positionId);
        
        // Get unit from admin config storage
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        if (!ds.adminConfigStorage.isAllowed[collateralToken]) {
            revert Errors.TokenNotAllowed();
        }
        unit = ds.adminConfigStorage.unitPerPair[collateralToken];
    }
}