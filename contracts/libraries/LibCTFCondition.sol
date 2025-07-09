// SPDX-License-Identifier: MIT
pragma solidity ^0.8.6;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {LibCTHelpers} from "./LibCTHelpers.sol";

library LibCTFCondition {
    /// @dev Prepares a new condition by initializing payout numerators.
    /// Can be called from both low-level (CTF-compatible) and high-level (managed) flows.
    function prepareCondition(address oracle, bytes32 questionId, uint256 outcomeSlotCount) internal returns (bytes32 conditionId) {
        require(outcomeSlotCount > 1 && outcomeSlotCount <= 256, "ConditionalTokens: invalid outcome count");

        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        conditionId = LibCTHelpers.getConditionId(oracle, questionId, outcomeSlotCount);

        require(ds.conditionalTokens.payoutNumerators[conditionId].length == 0, "ConditionalTokens: already prepared");

        ds.conditionalTokens.payoutNumerators[conditionId] = new uint256[](outcomeSlotCount);
    }

    function enforceConditionIsActive(bytes32 conditionId) internal view {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        require(ds.conditionManager.conditions[conditionId].active, "ConditionalTokens: condition inactive");
    }
}
