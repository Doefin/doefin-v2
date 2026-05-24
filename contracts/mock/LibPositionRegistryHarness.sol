// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibPositionRegistry} from "../libraries/LibPositionRegistry.sol";
import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";

/**
 * @title LibPositionRegistryHarness
 * @notice Test-only harness exposing the internal functions of
 *         `LibPositionRegistry`. In production the library is reached only
 *         through `LibCTFCondition._splitPosition` (which derives well-formed,
 *         CTF-consistent arguments) and `MarketDataFacet` (view lookups). Its
 *         input-validation and re-registration-consistency branches therefore
 *         cannot be driven with arbitrary arguments through any facet. This
 *         harness drives them directly, on its own EIP-7201 `AppStorage`
 *         namespace. Mirrors the existing `DoefinOrderHarness` pattern.
 */
contract LibPositionRegistryHarness {
    function registerPositionPairs(
        uint256[] calldata positionIds,
        uint256[] calldata partitions,
        bytes32 conditionId,
        bytes32 parentCollectionId,
        address collateralToken
    ) external {
        LibPositionRegistry.registerPositionPairs(
            positionIds, partitions, conditionId, parentCollectionId, collateralToken
        );
    }

    function getComplement(uint256 positionId) external view returns (uint256) {
        return LibPositionRegistry.getComplement(positionId);
    }

    function getConditionId(uint256 positionId) external view returns (bytes32) {
        return LibPositionRegistry.getConditionId(positionId);
    }

    function getCollateralToken(uint256 positionId) external view returns (address) {
        return LibPositionRegistry.getCollateralToken(positionId);
    }

    function validatePositionId(uint256 positionId) external view {
        LibPositionRegistry.validatePositionId(positionId);
    }

    function getMarketMetadata(uint256 positionId)
        external
        view
        returns (LibDoefinStorage.MarketMetadata memory)
    {
        return LibPositionRegistry.getMarketMetadata(positionId);
    }

    function getMarketsForCondition(bytes32 conditionId)
        external
        view
        returns (LibDoefinStorage.MarketMetadata[] memory)
    {
        return LibPositionRegistry.getMarketsForCondition(conditionId);
    }

    function buildMarketKey(bytes32 conditionId, bytes32 parentCollectionId, address collateralToken)
        external
        pure
        returns (bytes32)
    {
        return LibPositionRegistry.buildMarketKey(conditionId, parentCollectionId, collateralToken);
    }
}
