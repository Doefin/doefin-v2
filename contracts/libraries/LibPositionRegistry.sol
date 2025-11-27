// SPDX-License-Identifier: AGPL-3.0
// Uses shared storage derived from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {Errors} from "./Errors.sol";
import {Events} from "./Events.sol";

library LibPositionRegistry {
    function getComplement(uint256 positionId) internal view returns (uint256) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        validatePositionId(positionId);

        bytes32 marketKey = ds.positionRegistry.marketKeyByPositionId[positionId];
        uint256[] memory positionIds = ds.positionRegistry.marketsByKey[marketKey].positionIds;

        if (positionIds.length != 2) {
            revert Errors.InvalidComplement();
        }

        if (positionIds[0] == positionId) {
            return positionIds[1];
        } else if (positionIds[1] == positionId) {
            return positionIds[0];
        } else {
            revert Errors.PositionNotFound();
        }
    }

    function getCollateralToken(uint256 positionId) internal view returns (address) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        validatePositionId(positionId);

        bytes32 marketKey = ds.positionRegistry.marketKeyByPositionId[positionId];
        return ds.positionRegistry.marketsByKey[marketKey].collateralToken;
    }

    function retrieveConditionId(uint256 positionId1, uint256 positionId2) internal view returns (bytes32) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        
        // Validate both positions exist
        validatePositionId(positionId1);
        validatePositionId(positionId2);
        
        // Get condition IDs for both positions
        bytes32 conditionId1 = ds.positionRegistry.conditionIdByPositionId[positionId1];
        bytes32 conditionId2 = ds.positionRegistry.conditionIdByPositionId[positionId2];
        
        // Ensure they belong to the same condition
        if (conditionId1 != conditionId2) revert Errors.InvalidMatch();
        
        return conditionId1;
    }

    function getConditionId(uint256 positionId) internal view returns (bytes32) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        validatePositionId(positionId);
        return ds.positionRegistry.conditionIdByPositionId[positionId];
    }

    function validatePositionId(uint256 positionId) internal view {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        if (ds.positionRegistry.marketKeyByPositionId[positionId] == bytes32(0)) {
            revert Errors.InvalidPositionId();
        }
    }

    function validateComplement(uint256 positionId, uint256 complementPositionId) internal view {
        validatePositionId(positionId);
        validatePositionId(complementPositionId);

        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        
        // They must belong to the same market
        bytes32 positionMarketKey = ds.positionRegistry.marketKeyByPositionId[positionId];
        bytes32 complementMarketKey = ds.positionRegistry.marketKeyByPositionId[complementPositionId];
        
        if (positionMarketKey != complementMarketKey) {
            revert Errors.InvalidComplement();
        }
    }

    function registerPositionPairs(
        uint256[] memory positionIds,
        uint256[] memory partitions,
        bytes32 conditionId,
        bytes32 parentCollectionId,
        address collateralToken
    ) internal {
        if (positionIds.length != partitions.length) revert Errors.MismatchedInputLengths();
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        
        // Create unique market key
        bytes32 marketKey = buildMarketKey(conditionId, parentCollectionId, collateralToken);

        LibDoefinStorage.MarketMetadata storage meta = ds.positionRegistry.marketsByKey[marketKey];
        
        if (meta.collateralToken == address(0)) {
            // First time registration for this specific market
            meta.collateralToken = collateralToken;
            meta.parentCollectionId = parentCollectionId;
            meta.positionIds = positionIds;
            meta.partitions = partitions;
            
            // Add this market key to the condition's market list
            ds.positionRegistry.marketKeysByCondition[conditionId].push(marketKey);
            
            emit Events.PositionPairsRegistered(
                conditionId,
                collateralToken,
                parentCollectionId,
                positionIds,
                partitions
            );
        } else {
            // Validate consistency for subsequent registrations
            if (meta.collateralToken != collateralToken || meta.parentCollectionId != parentCollectionId) {
                revert Errors.InvalidMatch();
            }
            
            // Ensure position/partition arrays are consistent
            if (
                meta.positionIds.length != positionIds.length ||
                meta.partitions.length != partitions.length
            ) {
                revert Errors.InvalidMatch();
            }
            
            for (uint256 i = 0; i < positionIds.length; i++) {
                if (
                    meta.positionIds[i] != positionIds[i] ||
                    meta.partitions[i] != partitions[i]
                ) {
                    revert Errors.InvalidMatch();
                }
            }
        }
        
        // Map each positionId to both conditionId and marketKey
        for (uint256 i = 0; i < positionIds.length; i++) {
            bytes32 existingMarketKey = ds.positionRegistry.marketKeyByPositionId[positionIds[i]];
            if (existingMarketKey != bytes32(0) && existingMarketKey != marketKey) {
                revert Errors.InvalidMatch();
            }
            ds.positionRegistry.marketKeyByPositionId[positionIds[i]] = marketKey;
            ds.positionRegistry.conditionIdByPositionId[positionIds[i]] = conditionId;
        }
    }
    
    // Get specific market metadata for a position
    function getMarketMetadata(uint256 positionId) internal view returns (LibDoefinStorage.MarketMetadata memory) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        validatePositionId(positionId);
        
        bytes32 marketKey = ds.positionRegistry.marketKeyByPositionId[positionId];
        return ds.positionRegistry.marketsByKey[marketKey];
    }

    function getMarketsForCondition(bytes32 conditionId) internal view returns (LibDoefinStorage.MarketMetadata[] memory) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        bytes32[] memory marketKeys = ds.positionRegistry.marketKeysByCondition[conditionId];
        
        LibDoefinStorage.MarketMetadata[] memory markets = new LibDoefinStorage.MarketMetadata[](marketKeys.length);
        for (uint256 i = 0; i < marketKeys.length; i++) {
            markets[i] = ds.positionRegistry.marketsByKey[marketKeys[i]];
        }
        return markets;
    }

    /// @notice Generate market key from condition, parent collection, and collateral token
    /// @param conditionId The condition identifier
    /// @param parentCollectionId The parent collection identifier  
    /// @param collateralToken The collateral token address
    /// @return Market key hash (condition + parent + collateral)
    function buildMarketKey(
        bytes32 conditionId,
        bytes32 parentCollectionId,
        address collateralToken
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(conditionId, parentCollectionId, collateralToken));
    }
    
    function getMarketCount(bytes32 conditionId) internal view returns (uint256) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        return ds.positionRegistry.marketKeysByCondition[conditionId].length;
    }
}
