// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {LibCTHelpers} from "../libraries/LibCTHelpers.sol";
import {LibERC1155} from "../libraries/LibERC1155.sol";
import {IConditionalTokens} from "../interfaces/IConditionalTokens.sol";
import {LibCTFCondition} from "../libraries/LibCTFCondition.sol";
import {LibAccessControl} from "../libraries/LibAccessControl.sol";
import {Errors} from "../libraries/Errors.sol";
import {Events} from "../libraries/Events.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract ConditionalTokensFacet is IConditionalTokens {
    using SafeERC20 for IERC20;

    function prepareCondition(address oracle, bytes32 questionId, uint8 outcomeSlotCount) external override {
        if(!LibAccessControl.isOwner(msg.sender)) {
            revert Errors.NotAuthorized();
        }
        bytes32 conditionId = LibCTFCondition.prepareCondition(oracle, questionId, outcomeSlotCount);

        emit Events.ConditionPreparation(conditionId, oracle, questionId, outcomeSlotCount);
    }

    function reportPayouts(bytes32 questionId, uint256[] calldata payouts) external override {
        if(payouts.length == 0 || payouts.length > type(uint8).max) {
            revert Errors.InvalidPayoutLength();
        }
        uint8 outcomeSlotCount = uint8(payouts.length);

        bytes32 conditionId = LibCTHelpers.getConditionId(msg.sender, questionId, outcomeSlotCount);
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        uint256[] storage numerators = ds.conditionalTokens.payoutNumerators[conditionId];

        if(numerators.length != outcomeSlotCount) {
            revert Errors.ConditionNotPrepared();
        }
        if(ds.conditionalTokens.payoutDenominator[conditionId] != 0) {
            revert Errors.ConditionAlreadyResolved();
        }

        uint256 den = 0;
        for (uint256 i = 0; i < outcomeSlotCount; i++) {
            uint256 num = payouts[i];
            if(numerators[i] != 0) {
                revert Errors.PayoutAlreadySet();
            }
            numerators[i] = num;
            den += num;
        }

        if(den == 0) {
            revert Errors.AllZeroPayouts();
        }
        ds.conditionalTokens.payoutDenominator[conditionId] = den;

        emit Events.ConditionResolution(conditionId, msg.sender, questionId, outcomeSlotCount, numerators);
    }

    function splitPosition(
        address collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256 amount,
        uint256[] calldata partition
    ) external override {
        LibCTFCondition._splitPosition(msg.sender, collateralToken, parentCollectionId, conditionId, amount, partition);

        emit Events.PositionSplit(msg.sender, collateralToken, parentCollectionId, conditionId, partition, amount);
    }

    function mergePositions(
        address collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256[] calldata partition,
        uint256 amount
    ) external override {
        LibCTFCondition._mergePositions(msg.sender, collateralToken, parentCollectionId, conditionId, partition, amount);

        emit Events.PositionsMerge(msg.sender, collateralToken, parentCollectionId, conditionId, partition, amount);
    }

    function redeemPositions(
        address collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256[] calldata indexSets
    ) external override {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        uint256 den = ds.conditionalTokens.payoutDenominator[conditionId];
        if(den == 0) 
            revert Errors.ConditionNotResolved();

        uint8 outcomeSlotCount = uint8(ds.conditionalTokens.payoutNumerators[conditionId].length);
        if(outcomeSlotCount == 0) 
            revert Errors.ConditionNotPrepared();

        uint256 totalPayout = 0;

        uint256 fullIndexSet = (1 << outcomeSlotCount) - 1;

        for (uint256 i = 0; i < indexSets.length; i++) {
            uint256 indexSet = indexSets[i];
            if(indexSet == 0 || indexSet >= fullIndexSet) 
                revert Errors.InvalidIndexSet();

            uint256 posId = _getPositionId(collateralToken, parentCollectionId, conditionId, indexSet);
            uint256 stake = LibERC1155.balanceOf(msg.sender, posId);
            if (stake == 0) {
                continue;
            }

            uint256 payoutNumerator = 0;
            uint256[] memory conditionPayoutNumerators = ds.conditionalTokens.payoutNumerators[conditionId];
            for (uint256 j = 0; j < outcomeSlotCount; j++) {
                if ((indexSet & (1 << j)) != 0) {
                    payoutNumerator += conditionPayoutNumerators[j];
                }
            }

            uint256 payout = (stake * payoutNumerator) / den;
            totalPayout += payout;
            LibERC1155._burn(msg.sender, posId, stake);
        }

        if (totalPayout > 0) {
            if (parentCollectionId == bytes32(0)) {
                _handlePayoutTransfer(collateralToken, msg.sender, totalPayout);
            } else {
                uint256 parentPosId = LibCTHelpers.getPositionId(collateralToken, parentCollectionId);
                LibERC1155._mint(msg.sender, parentPosId, totalPayout, "");
                emit Events.PayoutRedeemedToParentPosition(msg.sender, collateralToken, parentCollectionId, conditionId, parentPosId, totalPayout);
            }
        }

        emit Events.PayoutRedemption(msg.sender, collateralToken, parentCollectionId, conditionId, indexSets, totalPayout);
    }

    function _handlePayoutTransfer(address collateralToken, address recipient, uint256 amount) internal {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        address feeReceiver = ds.adminConfigStorage.feeReceiver;
        uint256 feeBps = ds.adminConfigStorage.resolutionFeeBps;

        if(feeReceiver == address(0)) 
            revert Errors.InvalidFeeReceiver();

        if (feeBps == 0) {
            IERC20(collateralToken).safeTransfer(recipient, amount);

            return;
        }

        uint256 feeAmount = (amount * feeBps) / 10_000;
        uint256 userAmount = amount - feeAmount;

        IERC20(collateralToken).safeTransfer(feeReceiver, feeAmount);
        IERC20(collateralToken).safeTransfer(recipient, userAmount);

        emit Events.PayoutRedemptionFeePaid(recipient, feeReceiver, feeAmount, userAmount);
    }

    function _getPositionId(
        address collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256 indexSet
    ) internal view returns (uint256) {
        bytes32 collId = LibCTHelpers.getCollectionId(parentCollectionId, conditionId, indexSet);
        return LibCTHelpers.getPositionId(collateralToken, collId);
    }

    function getConditionId(address oracle, bytes32 questionId, uint8 outcomeSlotCount) external pure returns (bytes32) {
        return LibCTHelpers.getConditionId(oracle, questionId, outcomeSlotCount);
    }

    function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint indexSet) external view returns (bytes32) {
        return LibCTHelpers.getCollectionId(parentCollectionId, conditionId, indexSet);
    }

    function getPositionId(address collateralToken, bytes32 collectionId) external pure returns (uint) {
        return LibCTHelpers.getPositionId(collateralToken, collectionId);
    }

    function getPayoutNumerators(bytes32 conditionId) external view override returns (uint256[] memory) {
        return LibDoefinStorage.diamondStorage().conditionalTokens.payoutNumerators[conditionId];
    }
}
