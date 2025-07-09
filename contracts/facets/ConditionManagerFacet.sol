// SPDX-License-Identifier: AGPL-3.0
// Derived from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {LibAccessControl} from "../libraries/LibAccessControl.sol";
import {LibCTFCondition} from "../libraries/LibCTFCondition.sol";
import {IConditionManager} from "../interfaces/IConditionManager.sol";

contract ConditionManagerFacet is IConditionManager {
    using LibDoefinStorage for LibDoefinStorage.DiamondStorage;

    function createCondition(
        address oracle,
        bytes32 questionId,
        uint8 outcomeSlotCount,
        string calldata metadataURI
    ) external override returns (bytes32 conditionId) {
        LibAccessControl.enforceIsMarketMaker();
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
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

        emit ConditionCreated(conditionId, oracle, questionId, outcomeSlotCount, metadataURI);
    }

    function getCondition(
        bytes32 conditionId
    ) external view override returns (address oracle, bytes32 questionId, uint8 outcomeSlotCount, string memory metadataURI) {
        LibDoefinStorage.Condition storage cond = LibDoefinStorage.diamondStorage().conditionManager.conditions[conditionId];
        return (cond.oracle, cond.questionId, cond.outcomeSlotCount, cond.metadataURI);
    }

    function cancelCondition(bytes32 conditionId) external override {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        LibDoefinStorage.Condition storage cond = ds.conditionManager.conditions[conditionId];
        require(cond.creator == msg.sender || LibAccessControl.isOnwer(msg.sender), "ConditionalManager: Not authorized to cancel this condition");

        require(cond.oracle != address(0), "ConditionalManager: Condition does not exist");
        require(cond.active, "ConditionalManager: Condition already inactive");

        cond.active = false;
        emit ConditionCancelled(conditionId);
    }
}
