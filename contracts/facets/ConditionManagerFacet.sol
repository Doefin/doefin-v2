// SPDX-License-Identifier: MIT
pragma solidity ^0.8.6;

import { LibDoefinStorage } from "../libraries/LibDoefinStorage.sol";
import { LibCTHelpers} from "../libraries/LibCTHelpers.sol";
import { IConditionManager } from "../interfaces/IConditionManager.sol";


contract ConditionManagerFacet is IConditionManager {
    using LibDoefinStorage for LibDoefinStorage.DiamondStorage;

    function createCondition(
        address oracle,
        bytes32 questionId,
        uint outcomeSlotCount,
        string calldata metadataURI
    ) external override returns (bytes32 conditionId) {
        require(outcomeSlotCount > 1 && outcomeSlotCount <= 256, "Invalid outcome slot count");
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        conditionId = LibCTHelpers.getConditionId(oracle, questionId, outcomeSlotCount);

        require(ds.conditionManager.conditions[conditionId].oracle == address(0), "Condition already exists");

        ds.conditionManager.conditions[conditionId] = LibDoefinStorage.Condition({
            oracle: oracle,
            questionId: questionId,
            outcomeSlotCount: outcomeSlotCount,
            metadataURI: metadataURI,
            active: true,
            __gap: [uint256(0),0,0,0,0,0,0,0,0,0]
        });

        emit ConditionCreated(conditionId, oracle, questionId, metadataURI);
    }

    function getCondition(bytes32 conditionId)
        external
        view
        override
        returns (address oracle, bytes32 questionId, uint outcomeSlotCount, string memory metadataURI)
    {
        LibDoefinStorage.Condition storage cond = LibDoefinStorage.diamondStorage().conditionManager.conditions[conditionId];
        return (cond.oracle, cond.questionId, cond.outcomeSlotCount, cond.metadataURI);
    }

    function cancelCondition(bytes32 conditionId) external override {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        LibDoefinStorage.Condition storage cond = ds.conditionManager.conditions[conditionId];

        require(cond.oracle != address(0), "Condition does not exist");
        require(cond.active, "Condition already inactive");

        cond.active = false;
        emit ConditionCancelled(conditionId);
    }
}
