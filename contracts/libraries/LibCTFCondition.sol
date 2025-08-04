// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {LibCTHelpers} from "./LibCTHelpers.sol";
import {LibERC1155} from "./LibERC1155.sol";
import {Errors} from "./Errors.sol";
import {LibPositionRegistry} from "./LibPositionRegistry.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

library LibCTFCondition {
    using SafeERC20 for IERC20;

    /// @dev Prepares a new condition by initializing payout numerators.
    /// Can be called from both low-level (CTF-compatible) and high-level (managed) flows.
    function prepareCondition(address oracle, bytes32 questionId, uint8 outcomeSlotCount) internal returns (bytes32 conditionId) {
        if(oracle == address(0)) {
            revert Errors.InvalidOracleAddress();
        }

        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        conditionId = LibCTHelpers.getConditionId(oracle, questionId, outcomeSlotCount);

        if(ds.conditionalTokens.payoutNumerators[conditionId].length > 0) {
            revert Errors.ConditionAlreadyPrepared();
        }

        ds.conditionalTokens.payoutNumerators[conditionId] = new uint256[](outcomeSlotCount);
    }

    function _mergePositions(
        address sender,
        address collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256[] memory partition,
        uint256 amount
    ) internal {
        (uint256 fullIndexSet, uint256 freeIndexSet, uint256[] memory positionIds, uint256[] memory amounts) = _validateAndBuildPartitionPositions(
            collateralToken,
            parentCollectionId,
            conditionId,
            partition,
            amount
        );

        LibERC1155._batchBurn(sender, positionIds, amounts);

        if (freeIndexSet == 0) {
            if (parentCollectionId == bytes32(0)) {
                if (sender != address(this)) {
                    IERC20(collateralToken).safeTransfer(sender, amount);
                }
            } else {
                uint256 parentPosId = LibCTHelpers.getPositionId(collateralToken, parentCollectionId);
                LibERC1155._mint(sender, parentPosId, amount, "");
            }
        } else {
            uint256 mergedSet = fullIndexSet ^ freeIndexSet;
            uint256 mergedPosId = _getPositionId(collateralToken, parentCollectionId, conditionId, mergedSet);
            LibERC1155._mint(sender, mergedPosId, amount, "");
        }
    }

    function _splitPosition(
        address sender,
        address collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256 amount,
        uint256[] memory partition
    ) internal {
        _validateCollateral(collateralToken, amount);

        (uint256 fullIndexSet, uint256 freeIndexSet, uint256[] memory positionIds, uint256[] memory amounts) = _validateAndBuildPartitionPositions(
            collateralToken,
            parentCollectionId,
            conditionId,
            partition,
            amount
        );

        LibPositionRegistry.registerPositionPairs(positionIds, partition, conditionId, parentCollectionId, collateralToken);

        if (freeIndexSet == 0) {
            if (parentCollectionId == bytes32(0)) {
                if (sender != address(this)) {
                    IERC20(collateralToken).safeTransferFrom(sender, address(this), amount);
                }
            } else {
                uint256 parentPosId = LibCTHelpers.getPositionId(collateralToken, parentCollectionId);
                LibERC1155._burn(sender, parentPosId, amount);
            }
        } else {
            uint256 mergedSet = fullIndexSet ^ freeIndexSet;
            uint256 mergedPosId = _getPositionId(collateralToken, parentCollectionId, conditionId, mergedSet);
            LibERC1155._burn(sender, mergedPosId, amount);
        }

        LibERC1155._batchMint(sender, positionIds, amounts, "");
    }

    function _validateCollateral(address collateralToken, uint256 amount) internal view {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        if(!ds.adminConfigStorage.isAllowed[collateralToken]) {
            revert Errors.TokenNotAllowed();
        }

        uint256 unit = ds.adminConfigStorage.unitPerPair[collateralToken];

        if(amount % unit != 0) {
            revert Errors.CollateralNotAligned();
        }
    }

    function _validateAndBuildPartitionPositions(
        address collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256[] memory partition,
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

    function _getPositionId(
        address collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256 indexSet
    ) internal view returns (uint256) {
        bytes32 collId = LibCTHelpers.getCollectionId(parentCollectionId, conditionId, indexSet);
        return LibCTHelpers.getPositionId(collateralToken, collId);
    }

    function enforceConditionIsActive(bytes32 conditionId) internal view {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        require(ds.conditionManager.conditions[conditionId].active, "ConditionalTokens: condition inactive");
    }
}
