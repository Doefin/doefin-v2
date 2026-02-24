// SPDX-License-Identifier: AGPL-3.0
// Uses shared storage derived from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {Errors} from "./Errors.sol";
import {Events} from "./Events.sol";

/**
 * @title LibPositionRegistry
 * @author Doefin
 * @notice Manages registration and lookup of position tokens and their relationships
 * @dev Tracks mapping between position IDs, condition IDs, market metadata, and complementary positions
 * @dev Essential for validating trades and enabling mint/merge operations in the conditional token framework
 */
library LibPositionRegistry {
    /**
     * @notice Finds the complementary position for a given position in a binary outcome market
     * @dev For binary markets (2 outcomes), returns the opposite position (YES ↔ NO)
     * @dev Validates that exactly 2 positions exist in the market before returning complement
     * @param positionId The position ID to find the complement for
     * @return The position ID of the complementary position
     * @custom:reverts InvalidPositionId if positionId is not registered
     * @custom:reverts InvalidComplement if market doesn't have exactly 2 positions
     * @custom:reverts PositionNotFound if positionId not found in market positions array
     * @custom:note Only works for binary markets; multi-outcome markets will revert
     */
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

    /**
     * @notice Retrieves the collateral token address for a given position
     * @dev Looks up the market metadata to determine which ERC20 token backs this position
     * @param positionId The position ID to query
     * @return The ERC20 token address used as collateral for this position
     * @custom:reverts InvalidPositionId if positionId is not registered
     * @custom:note All positions in the same market share the same collateral token
     */
    function getCollateralToken(uint256 positionId) internal view returns (address) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        validatePositionId(positionId);

        bytes32 marketKey = ds.positionRegistry.marketKeyByPositionId[positionId];
        return ds.positionRegistry.marketsByKey[marketKey].collateralToken;
    }

    /**
     * @notice Validates that two positions belong to the same condition and returns the condition ID
     * @dev Used during mint/merge operations to ensure positions are from the same prediction market
     * @dev Both positions must be registered and belong to the same conditional token condition
     * @param positionId1 First position ID to validate
     * @param positionId2 Second position ID to validate
     * @return The shared condition ID for both positions
     * @custom:reverts InvalidPositionId if either position is not registered
     * @custom:reverts InvalidMatch if positions belong to different conditions
     * @custom:note Essential for CTF compliance - positions must share condition for split/merge
     */
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

    /**
     * @notice Gets the condition ID associated with a specific position
     * @dev Each position belongs to exactly one condition in the conditional token framework
     * @param positionId The position ID to query
     * @return The condition ID that this position belongs to
     * @custom:reverts InvalidPositionId if positionId is not registered
     * @custom:note Condition ID is immutable once a position is registered
     */
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

    /**
     * @notice Registers position pairs for a new prediction market
     * @dev Creates market metadata and maps positions to conditions for order book operations
     * @dev Validates consistency if market already exists; creates new registration if not
     * @dev Each position gets mapped to both condition ID and market key for efficient lookup
     * @param positionIds Array of ERC1155 token IDs representing outcome positions
     * @param partitions Array of partition indices corresponding to each position
     * @param conditionId The condition ID from the conditional token framework
     * @param parentCollectionId The parent collection ID (typically 0x0 for root positions)
     * @param collateralToken ERC20 token address used as backing collateral
     * @custom:emits PositionPairsRegistered with complete market registration details
     * @custom:reverts MismatchedInputLengths if arrays have different lengths
     * @custom:reverts InvalidMatch if existing market has different parameters
     * @custom:reverts InvalidMatch if position already registered to different market
     * @custom:note First registration creates metadata; subsequent calls validate consistency
     * @custom:security Prevents double-registration with different parameters
     */
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

            emit Events.PositionPairsRegistered(conditionId, collateralToken, parentCollectionId, positionIds, partitions);
        } else {
            // Validate consistency for subsequent registrations
            if (meta.collateralToken != collateralToken || meta.parentCollectionId != parentCollectionId) {
                revert Errors.InvalidMatch();
            }

            // Ensure position/partition arrays are consistent
            if (meta.positionIds.length != positionIds.length || meta.partitions.length != partitions.length) {
                revert Errors.InvalidMatch();
            }

            for (uint256 i = 0; i < positionIds.length; i++) {
                if (meta.positionIds[i] != positionIds[i] || meta.partitions[i] != partitions[i]) {
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
    function buildMarketKey(bytes32 conditionId, bytes32 parentCollectionId, address collateralToken) internal pure returns (bytes32) {
        return keccak256(abi.encode(conditionId, parentCollectionId, collateralToken));
    }

    function getMarketCount(bytes32 conditionId) internal view returns (uint256) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        return ds.positionRegistry.marketKeysByCondition[conditionId].length;
    }
}
