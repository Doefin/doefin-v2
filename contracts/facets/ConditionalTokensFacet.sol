// SPDX-License-Identifier: MIT
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {LibCTHelpers} from "../libraries/LibCTHelpers.sol";
import {LibERC1155} from "../libraries/LibERC1155.sol";
import {IConditionalTokens} from "../interfaces/IConditionalTokens.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LibCTFCondition} from "../libraries/LibCTFCondition.sol";

contract ConditionalTokensFacet is IConditionalTokens {
    event DebugUint256(string label, uint256 value);
    function prepareCondition(address oracle, bytes32 questionId, uint256 outcomeSlotCount) external override {
        bytes32 conditionId = LibCTFCondition.prepareCondition(oracle, questionId, outcomeSlotCount);

        emit ConditionPreparation(conditionId, oracle, questionId, outcomeSlotCount);
    }

    function reportPayouts(bytes32 questionId, uint256[] calldata payouts) external override {
        uint256 outcomeSlotCount = payouts.length;
        require(outcomeSlotCount > 1, "ConditionalTokens: invalid payout length");

        bytes32 conditionId = LibCTHelpers.getConditionId(msg.sender, questionId, outcomeSlotCount);
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        require(ds.conditionalTokens.payoutNumerators[conditionId].length == outcomeSlotCount, "ConditionalTokens: condition not prepared");
        require(ds.conditionalTokens.payoutDenominator[conditionId] == 0, "ConditionalTokens: already resolved");

        uint256 den = 0;
        for (uint256 i = 0; i < outcomeSlotCount; i++) {
            uint256 num = payouts[i];
            require(ds.conditionalTokens.payoutNumerators[conditionId][i] == 0, "ConditionalTokens: payout already set");
            ds.conditionalTokens.payoutNumerators[conditionId][i] = num;
            den += num;
        }

        require(den > 0, "ConditionalTokens: all zero payouts");
        ds.conditionalTokens.payoutDenominator[conditionId] = den;

        emit ConditionResolution(conditionId, msg.sender, questionId, outcomeSlotCount, ds.conditionalTokens.payoutNumerators[conditionId]);
    }

    function splitPosition(
        address collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256 amount,
        uint256[] calldata partition
    ) external override {
        require(partition.length > 1, "ConditionalTokens: trivial partition");
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        uint256 outcomeSlotCount = ds.conditionalTokens.payoutNumerators[conditionId].length;
        require(outcomeSlotCount > 0, "ConditionalTokens: condition not prepared");

        _validateCollateral(collateralToken, amount);

        uint256 fullIndexSet = (1 << outcomeSlotCount) - 1;
        uint256 freeIndexSet = fullIndexSet;

        uint256[] memory positionIds = new uint256[](partition.length);
        uint256[] memory amounts = new uint256[](partition.length);

        for (uint256 i = 0; i < partition.length; i++) {
            uint256 indexSet = partition[i];
            require(indexSet > 0 && indexSet < fullIndexSet, "ConditionalTokens: invalid index set");
            require((indexSet & freeIndexSet) == indexSet, "ConditionalTokens: partition not disjoint");
            freeIndexSet ^= indexSet;

            bytes32 collectionId = LibCTHelpers.getCollectionId(parentCollectionId, conditionId, indexSet);
            positionIds[i] = LibCTHelpers.getPositionId(collateralToken, collectionId);
            amounts[i] = amount;
        }

        if (freeIndexSet == 0) {
            if (parentCollectionId == bytes32(0)) {
                require(IERC20(collateralToken).transferFrom(msg.sender, address(this), amount), "ConditionalTokens: collateral transfer failed");
            } else {
                uint256 parentPosId = LibCTHelpers.getPositionId(collateralToken, parentCollectionId);
                LibERC1155._burn(msg.sender, parentPosId, amount);
            }
        } else {
            uint256 mergedSet = fullIndexSet ^ freeIndexSet;
            bytes32 mergedCollId = LibCTHelpers.getCollectionId(parentCollectionId, conditionId, mergedSet);
            uint256 mergedPosId = LibCTHelpers.getPositionId(collateralToken, mergedCollId);
            LibERC1155._burn(msg.sender, mergedPosId, amount);
        }

        LibERC1155._batchMint(msg.sender, positionIds, amounts, "");

        emit PositionSplit(msg.sender, collateralToken, parentCollectionId, conditionId, partition, amount);
    }

    function _validateCollateral(address collateralToken, uint256 amount) internal view {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        require(ds.adminConfigStorage.isAllowed[collateralToken], "ConditionalTokens: Collateral not allowed");

        uint256 unit = ds.adminConfigStorage.unitPerPair[collateralToken];
        require(amount % unit == 0, "ConditionalTokens: Collateral amount not aligned to unit");
    }

    function mergePositions(
        address collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256[] calldata partition,
        uint256 amount
    ) external override {
        require(partition.length > 1, "ConditionalTokens: trivial partition");
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        uint256 outcomeSlotCount = ds.conditionalTokens.payoutNumerators[conditionId].length;
        require(outcomeSlotCount > 0, "ConditionalTokens: condition not prepared");

        uint256 fullIndexSet = (1 << outcomeSlotCount) - 1;
        uint256 freeIndexSet = fullIndexSet;

        uint256[] memory positionIds = new uint256[](partition.length);
        uint256[] memory amounts = new uint256[](partition.length);

        for (uint256 i = 0; i < partition.length; i++) {
            uint256 indexSet = partition[i];
            require(indexSet > 0 && indexSet < fullIndexSet, "ConditionalTokens: invalid index set");
            require((indexSet & freeIndexSet) == indexSet, "ConditionalTokens: partition not disjoint");
            freeIndexSet ^= indexSet;

            bytes32 collectionId = LibCTHelpers.getCollectionId(parentCollectionId, conditionId, indexSet);
            positionIds[i] = LibCTHelpers.getPositionId(collateralToken, collectionId);
            amounts[i] = amount;
        }

        LibERC1155._batchBurn(msg.sender, positionIds, amounts);

        if (freeIndexSet == 0) {
            if (parentCollectionId == bytes32(0)) {
                require(IERC20(collateralToken).transfer(msg.sender, amount), "ConditionalTokens: collateral transfer failed");
            } else {
                uint256 parentPosId = LibCTHelpers.getPositionId(collateralToken, parentCollectionId);
                LibERC1155._mint(msg.sender, parentPosId, amount, "");
            }
        } else {
            uint256 mergedSet = fullIndexSet ^ freeIndexSet;
            bytes32 mergedCollId = LibCTHelpers.getCollectionId(parentCollectionId, conditionId, mergedSet);
            uint256 mergedPosId = LibCTHelpers.getPositionId(collateralToken, mergedCollId);
            LibERC1155._mint(msg.sender, mergedPosId, amount, "");
        }

        emit PositionsMerge(msg.sender, collateralToken, parentCollectionId, conditionId, partition, amount);
    }

    function redeemPositions(
        address collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256[] calldata indexSets
    ) external override {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        uint256 den = ds.conditionalTokens.payoutDenominator[conditionId];
        require(den > 0, "ConditionalTokens: condition not resolved");

        uint256 outcomeSlotCount = ds.conditionalTokens.payoutNumerators[conditionId].length;
        require(outcomeSlotCount > 0, "ConditionalTokens: condition not prepared");

        uint256 totalPayout = 0;

        uint256 fullIndexSet = (1 << outcomeSlotCount) - 1;

        for (uint256 i = 0; i < indexSets.length; i++) {
            uint256 indexSet = indexSets[i];
            require(indexSet > 0 && indexSet < fullIndexSet, "ConditionalTokens: invalid index set");

            bytes32 collId = LibCTHelpers.getCollectionId(parentCollectionId, conditionId, indexSet);
            uint256 posId = LibCTHelpers.getPositionId(collateralToken, collId);

            uint256 payoutNumerator = 0;
            for (uint256 j = 0; j < outcomeSlotCount; j++) {
                if ((indexSet & (1 << j)) != 0) {
                    payoutNumerator += ds.conditionalTokens.payoutNumerators[conditionId][j];
                }
            }

            uint256 stake = LibERC1155.balanceOf(msg.sender, posId);
            if (stake > 0) {
                uint256 payout = (stake * payoutNumerator) / den;
                totalPayout += payout;
                LibERC1155._burn(msg.sender, posId, stake);
            }
        }

        if (totalPayout > 0) {
            if (parentCollectionId == bytes32(0)) {
                address feeReceiver = ds.adminConfigStorage.feeReceiver;
                uint256 feeBps = ds.adminConfigStorage.resolutionFeeBps;

                require(feeReceiver != address(0), "ConditionalTokens: invalid feeReceiver");

                uint256 feeAmount = (totalPayout * feeBps) / 10_000; // fee in basis points
                uint256 userAmount = totalPayout - feeAmount;

                if (feeAmount > 0) {
                    require(IERC20(collateralToken).transfer(feeReceiver, feeAmount), "ConditionalTokens: fee transfer failed");
                }

                require(IERC20(collateralToken).transfer(msg.sender, userAmount), "ConditionalTokens: user payout failed");

                emit ResolutionFeePaid(msg.sender, feeReceiver, feeAmount, userAmount);
            } else {
                uint256 parentPosId = LibCTHelpers.getPositionId(collateralToken, parentCollectionId);
                LibERC1155._mint(msg.sender, parentPosId, totalPayout, "");
            }
        }

        emit PayoutRedemption(msg.sender, collateralToken, parentCollectionId, conditionId, indexSets, totalPayout);
    }

    function getPositionId(address collateralToken, bytes32 collectionId, uint256 indexSet) external view override returns (uint256) {
        return LibCTHelpers.getPositionId(collateralToken, LibCTHelpers.getCollectionId(collectionId, bytes32(0), indexSet));
    }

    function getPayoutNumerators(bytes32 conditionId) external view override returns (uint256[] memory) {
        return LibDoefinStorage.diamondStorage().conditionalTokens.payoutNumerators[conditionId];
    }
}
