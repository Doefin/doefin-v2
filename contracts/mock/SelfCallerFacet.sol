// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.20;

import {IConditionalTokens} from "../interfaces/IConditionalTokens.sol";

/**
 * @title SelfCallerFacet
 * @notice TEST-ONLY facet (CTF-008): makes the Diamond call its own public split / merge, the
 *         situation any future multicall- or relay-style facet would create.
 * @dev Never cut into a production Diamond.
 */
contract SelfCallerFacet {
    function selfSplit(address collateralToken, bytes32 conditionId, uint256 amount) external {
        uint256[] memory partition = new uint256[](2);
        partition[0] = 1;
        partition[1] = 2;
        IConditionalTokens(address(this)).splitPosition(collateralToken, bytes32(0), conditionId, partition, amount);
    }

    function selfMerge(address collateralToken, bytes32 conditionId, uint256 amount) external {
        uint256[] memory partition = new uint256[](2);
        partition[0] = 1;
        partition[1] = 2;
        IConditionalTokens(address(this)).mergePositions(collateralToken, bytes32(0), conditionId, partition, amount);
    }
}
