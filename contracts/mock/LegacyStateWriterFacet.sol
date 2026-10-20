// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.20;

import {LibPositionRegistry} from "../libraries/LibPositionRegistry.sol";

/**
 * @title LegacyStateWriterFacet
 * @notice TEST-ONLY facet: reproduces state that a deployment from before the SCRUM-214 cut can
 *         hold but the fixed code can no longer create.
 *         - registerLegacyMarket (CTF-001): a market-registry entry written directly, as a pre-fix
 *           splitPosition did for any partition. Since the fix only a canonical root split
 *           registers, so this is the only way to drive SettlementFacet._conditionAndPartition's
 *           full-partition guard.
 * @dev Never cut into a production Diamond.
 */
contract LegacyStateWriterFacet {
    /// @notice Register `positionIds` / `partitions` as the market of (condition, parent, collateral).
    function registerLegacyMarket(
        uint256[] calldata positionIds,
        uint256[] calldata partitions,
        bytes32 conditionId,
        bytes32 parentCollectionId,
        address collateralToken
    ) external {
        LibPositionRegistry.registerPositionPairs(positionIds, partitions, conditionId, parentCollectionId, collateralToken);
    }
}
