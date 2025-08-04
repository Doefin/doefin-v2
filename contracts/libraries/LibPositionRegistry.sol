// SPDX-License-Identifier: AGPL-3.0
// Uses shared storage derived from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";

library LibPositionRegistry {
    function getComplement(uint256 positionId) internal view returns (uint256) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        validatePositionId(positionId);

        bytes32 conditionId = ds.positionRegistry.conditionIdByPositionId[positionId];
        uint256[] memory positionIds = ds.positionRegistry.marketsByCondition[conditionId].positionIds;

        if (positionIds[0] == positionId) {
            return positionIds[1];
        } else if (positionIds[1] == positionId) {
            return positionIds[0];
        } else {
            revert("PositionRegistry: positionId not found in condition");
        }
    }

    function getCollateralToken(uint256 positionId) internal view returns (address) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        bytes32 conditionId = ds.positionRegistry.conditionIdByPositionId[positionId];
        address collateralToken = ds.positionRegistry.marketsByCondition[conditionId].collateralToken;

        return collateralToken;
    }

    function retrieveConditionId(uint256 positionId1, uint256 positionId2) internal view returns (bytes32) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        bytes32 conditionId1 = ds.positionRegistry.conditionIdByPositionId[positionId1];
        bytes32 conditionId2 = ds.positionRegistry.conditionIdByPositionId[positionId2];
        require(conditionId1 == conditionId2, "PositionRegistry: Invalid Match");
        return conditionId1;
    }

    function getConditionId(uint256 positionId) internal view returns (bytes32) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        return ds.positionRegistry.conditionIdByPositionId[positionId];
    }

    function validatePositionId(uint256 positionId) internal view {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        if (ds.positionRegistry.conditionIdByPositionId[positionId] == 0) revert("PositionRegistry: Invalid positionId");
    }

    function validateComplement(uint256 positionId, uint256 complementPositionId) internal view {
        if (getComplement(positionId) != complementPositionId) revert("PositionRegistry: Invalid complement");
    }

    function registerPositionPairs(
        uint256[] memory positionIds,
        uint256[] memory partitions,
        bytes32 conditionId,
        bytes32 parentCollectionId,
        address collateralToken
    ) internal {
        require(positionIds.length == partitions.length, "PositionRegistry: Mismatched input lengths");
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        LibDoefinStorage.MarketMetadata storage meta = ds.positionRegistry.marketsByCondition[conditionId];
        if (meta.collateralToken == address(0)) {
            meta.collateralToken = collateralToken;
            meta.parentCollectionId = parentCollectionId;
            meta.positionIds = positionIds;
            meta.partitions = partitions;
        }

        for (uint256 i = 0; i < positionIds.length; i++) {
            ds.positionRegistry.conditionIdByPositionId[positionIds[i]] = conditionId;
        }
    }

    function getMarketMetadata(uint256 positionId) internal view returns (LibDoefinStorage.MarketMetadata memory positionMeta) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        bytes32 conditionId = ds.positionRegistry.conditionIdByPositionId[positionId];
        positionMeta = ds.positionRegistry.marketsByCondition[conditionId];
    }
}
