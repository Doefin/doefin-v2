// SPDX-License-Identifier: AGPL-3.0
// Uses shared storage derived from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {LibCTHelpers} from "../libraries/LibCTHelpers.sol";
import {LibERC1155} from "../libraries/LibERC1155.sol";
import {IConditionalTokens} from "../interfaces/IConditionalTokens.sol";
import {LibCTFCondition} from "../libraries/LibCTFCondition.sol";
import {LibAccessControl} from "../libraries/LibAccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract ConditionalTokensFacet is IConditionalTokens {
    using SafeERC20 for IERC20;

    function prepareCondition(address oracle, bytes32 questionId, uint8 outcomeSlotCount) external override {
        require(LibAccessControl.isOnwer(msg.sender), "AccessControl: must be owner");
        bytes32 conditionId = LibCTFCondition.prepareCondition(oracle, questionId, outcomeSlotCount);

        emit ConditionPreparation(conditionId, oracle, questionId, outcomeSlotCount);
    }

    function reportPayouts(bytes32 questionId, uint256[] calldata payouts) external override {
        require(payouts.length <= type(uint8).max, "Too many outcome slots");
        uint8 outcomeSlotCount = uint8(payouts.length);
        require(outcomeSlotCount > 1, "ConditionalTokens: invalid payout length");

        bytes32 conditionId = LibCTHelpers.getConditionId(msg.sender, questionId, outcomeSlotCount);
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        uint256[] storage numerators = ds.conditionalTokens.payoutNumerators[conditionId];

        require(numerators.length == outcomeSlotCount, "ConditionalTokens: condition not prepared");
        require(ds.conditionalTokens.payoutDenominator[conditionId] == 0, "ConditionalTokens: already resolved");

        uint256 den = 0;
        for (uint256 i = 0; i < outcomeSlotCount; i++) {
            uint256 num = payouts[i];
            require(numerators[i] == 0, "ConditionalTokens: payout already set");
            numerators[i] = num;
            den += num;
        }

        require(den > 0, "ConditionalTokens: all zero payouts");
        ds.conditionalTokens.payoutDenominator[conditionId] = den;

        emit ConditionResolution(conditionId, msg.sender, questionId, outcomeSlotCount, numerators);
    }

    function splitPosition(
        address collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256 amount,
        uint256[] calldata partition
    ) external override {
        _validateCollateral(collateralToken, amount);

        (uint256 fullIndexSet, uint256 freeIndexSet, uint256[] memory positionIds, uint256[] memory amounts) = _validateAndBuildPartitionPositions(
            collateralToken,
            parentCollectionId,
            conditionId,
            partition,
            amount
        );

        if (freeIndexSet == 0) {
            if (parentCollectionId == bytes32(0)) {
                IERC20(collateralToken).safeTransferFrom(msg.sender, address(this), amount);
            } else {
                uint256 parentPosId = LibCTHelpers.getPositionId(collateralToken, parentCollectionId);
                LibERC1155._burn(msg.sender, parentPosId, amount);
            }
        } else {
            uint256 mergedSet = fullIndexSet ^ freeIndexSet;
            uint256 mergedPosId = _getPositionId(collateralToken, parentCollectionId, conditionId, mergedSet);
            LibERC1155._burn(msg.sender, mergedPosId, amount);
        }

        LibERC1155._batchMint(msg.sender, positionIds, amounts, "");

        emit PositionSplit(msg.sender, collateralToken, parentCollectionId, conditionId, partition, amount);
    }

    function mergePositions(
        address collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256[] calldata partition,
        uint256 amount
    ) external override {
        (uint256 fullIndexSet, uint256 freeIndexSet, uint256[] memory positionIds, uint256[] memory amounts) = _validateAndBuildPartitionPositions(
            collateralToken,
            parentCollectionId,
            conditionId,
            partition,
            amount
        );

        LibERC1155._batchBurn(msg.sender, positionIds, amounts);

        if (freeIndexSet == 0) {
            if (parentCollectionId == bytes32(0)) {
                IERC20(collateralToken).safeTransfer(msg.sender, amount);
            } else {
                uint256 parentPosId = LibCTHelpers.getPositionId(collateralToken, parentCollectionId);
                LibERC1155._mint(msg.sender, parentPosId, amount, "");
            }
        } else {
            uint256 mergedSet = fullIndexSet ^ freeIndexSet;
            uint256 mergedPosId = _getPositionId(collateralToken, parentCollectionId, conditionId, mergedSet);
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

        uint8 outcomeSlotCount = uint8(ds.conditionalTokens.payoutNumerators[conditionId].length);
        require(outcomeSlotCount > 0, "ConditionalTokens: condition not prepared");

        uint256 totalPayout = 0;

        uint256 fullIndexSet = (1 << outcomeSlotCount) - 1;

        for (uint256 i = 0; i < indexSets.length; i++) {
            uint256 indexSet = indexSets[i];
            require(indexSet > 0 && indexSet < fullIndexSet, "ConditionalTokens: invalid index set");

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
            }
        }

        emit PayoutRedemption(msg.sender, collateralToken, parentCollectionId, conditionId, indexSets, totalPayout);
    }

    function _validateCollateral(address collateralToken, uint256 amount) internal view {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        require(ds.adminConfigStorage.isAllowed[collateralToken], "ConditionalTokens: Collateral not allowed");

        uint256 unit = ds.adminConfigStorage.unitPerPair[collateralToken];
        require(amount % unit == 0, "ConditionalTokens: Collateral amount not aligned to unit");
    }

    function _handlePayoutTransfer(address collateralToken, address recipient, uint256 amount) internal {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        address feeReceiver = ds.adminConfigStorage.feeReceiver;
        uint256 feeBps = ds.adminConfigStorage.resolutionFeeBps;

        require(feeReceiver != address(0), "ConditionalTokens: invalid feeReceiver");

        uint256 feeAmount = (amount * feeBps) / 10_000;
        uint256 userAmount = amount - feeAmount;

        if (feeAmount > 0) {
            IERC20(collateralToken).safeTransfer(feeReceiver, feeAmount);
        }
        IERC20(collateralToken).safeTransfer(recipient, userAmount);

        emit ResolutionFeePaid(recipient, feeReceiver, feeAmount, userAmount);
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

    function _validateAndBuildPartitionPositions(
        address collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256[] calldata partition,
        uint256 amount
    ) internal view returns (uint256 fullIndexSet, uint256 freeIndexSet, uint256[] memory positionIds, uint256[] memory amounts) {
        require(partition.length > 1, "ConditionalTokens: trivial partition");
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        uint8 outcomeSlotCount = uint8(ds.conditionalTokens.payoutNumerators[conditionId].length);
        require(outcomeSlotCount > 0, "ConditionalTokens: condition not prepared");

        fullIndexSet = (1 << outcomeSlotCount) - 1;
        freeIndexSet = fullIndexSet;

        positionIds = new uint256[](partition.length);
        amounts = new uint256[](partition.length);

        for (uint256 i = 0; i < partition.length; i++) {
            uint256 indexSet = partition[i];
            require(indexSet > 0 && indexSet < fullIndexSet, "ConditionalTokens: invalid index set");
            require((indexSet & freeIndexSet) == indexSet, "ConditionalTokens: partition not disjoint");
            freeIndexSet ^= indexSet;

            positionIds[i] = _getPositionId(collateralToken, parentCollectionId, conditionId, indexSet);
            amounts[i] = amount;
        }
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
