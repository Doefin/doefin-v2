// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {LibAccessControl} from "../libraries/LibAccessControl.sol";
import {LibCTFCondition} from "../libraries/LibCTFCondition.sol";
import {IConditionManager} from "../interfaces/IConditionManager.sol";
import {Errors} from "../libraries/Errors.sol";
import {Events} from "../libraries/Events.sol";

contract ConditionManagerFacet is IConditionManager {
    using LibDoefinStorage for LibDoefinStorage.AppStorage;

    function createCondition(
        address oracle,
        bytes32 questionId,
        uint8 outcomeSlotCount,
        string calldata metadataURI
    ) external override returns (bytes32 conditionId) {
        LibAccessControl.enforceIsMarketMaker();
        if (outcomeSlotCount <= 1) {
            revert Errors.InvalidOutcomeSlotCount();
        }
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        conditionId = LibCTFCondition.prepareCondition(oracle, questionId, outcomeSlotCount);

        ds.conditionManager.conditions[conditionId] = LibDoefinStorage.Condition({
            oracle: oracle,
            questionId: questionId,
            outcomeSlotCount: outcomeSlotCount,
            metadataURI: metadataURI,
            active: true,
            creator: msg.sender,
            __gap: [uint256(0), 0, 0, 0, 0, 0, 0, 0, 0, 0]
        });

        emit Events.ConditionCreated(conditionId, oracle, questionId, outcomeSlotCount, metadataURI, msg.sender);
    }

    function getCondition(bytes32 conditionId)
        external
        view
        override
        returns (
            LibDoefinStorage.Condition memory
        )
    {
        LibDoefinStorage.Condition storage condition = LibDoefinStorage.appStorage().conditionManager.conditions[conditionId];
        return condition;
    }

    function cancelCondition(bytes32 conditionId) external override {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        LibDoefinStorage.Condition storage cond = ds.conditionManager.conditions[conditionId];
        if (cond.creator == address(0)) {
            revert Errors.ConditionDoesNotExist();
        }

        if (cond.creator != msg.sender && !LibAccessControl.isOwner(msg.sender)) {
            revert Errors.NotAuthorizedToCancel();
        }

        if (cond.oracle == address(0)) revert Errors.InvalidOracleAddress();

        if (!cond.active) revert Errors.ConditionAlreadyInactive();

        cond.active = false;
        emit Events.ConditionCancelled(conditionId, msg.sender);
    }
}
