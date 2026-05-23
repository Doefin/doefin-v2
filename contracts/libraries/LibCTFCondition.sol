// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.20;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {LibAdminConfigStorage} from "./LibAdminConfigStorage.sol";
import {LibCTHelpers} from "./LibCTHelpers.sol";
import {LibERC1155} from "./LibERC1155.sol";
import {Errors} from "./Errors.sol";
import {Events} from "./Events.sol";
import {LibPositionRegistry} from "./LibPositionRegistry.sol";
import {LibReentrancyGuard} from "./LibReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

library LibCTFCondition {
    using SafeERC20 for IERC20;

    /// @dev Prepares a new condition by initializing payout numerators.
    /// Can be called from both low-level (CTF-compatible) and high-level (managed) flows.
    function prepareCondition(address oracle, bytes32 questionId, uint8 outcomeSlotCount) internal returns (bytes32 conditionId) {
        if (oracle == address(0)) {
            revert Errors.InvalidOracleAddress();
        }

        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        conditionId = LibCTHelpers.getConditionId(oracle, questionId, outcomeSlotCount);

        if (ds.conditionalTokens.payoutNumerators[conditionId].length > 0) {
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

        LibReentrancyGuard._nonReentrantBefore();
        LibERC1155._batchBurn(sender, positionIds, amounts);

        if (freeIndexSet == 0) {
            if (parentCollectionId == bytes32(0)) {
                /// @dev Skip token transfer when contract calls itself to avoid circular transfers
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
        LibReentrancyGuard._nonReentrantAfter();
    }

    function _splitPosition(
        address sender,
        address collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256 amount,
        uint256[] memory partition
    ) internal {
        if (!LibAdminConfigStorage.adminConfigStorage().isAllowed[collateralToken]) {
            revert Errors.TokenNotAllowed();
        }

        (uint256 fullIndexSet, uint256 freeIndexSet, uint256[] memory positionIds, uint256[] memory amounts) = _validateAndBuildPartitionPositions(
            collateralToken,
            parentCollectionId,
            conditionId,
            partition,
            amount
        );

        LibPositionRegistry.registerPositionPairs(positionIds, partition, conditionId, parentCollectionId, collateralToken);

        LibReentrancyGuard._nonReentrantBefore();
        if (freeIndexSet == 0) {
            if (parentCollectionId == bytes32(0)) {
                /// @dev Skip token transfer when contract calls itself to avoid circular transfers
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

        LibReentrancyGuard._nonReentrantAfter();
    }

    /// @notice Split position without reentrancy guard — caller MUST already hold the lock.
    /// @dev Only for use by SettlementFacet (or other internal callers that hold nonReentrant).
    ///      When sender == address(this), no external calls are made (safeTransferFrom is skipped),
    ///      so there is no reentrancy risk.
    function _splitPositionInternal(
        address sender,
        address collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256 amount,
        uint256[] memory partition
    ) internal {
        if (!LibAdminConfigStorage.adminConfigStorage().isAllowed[collateralToken]) {
            revert Errors.TokenNotAllowed();
        }

        (uint256 fullIndexSet, uint256 freeIndexSet, uint256[] memory positionIds, uint256[] memory amounts) = _validateAndBuildPartitionPositions(
            collateralToken,
            parentCollectionId,
            conditionId,
            partition,
            amount
        );

        // Registry was already populated by the initial splitPosition that seeded
        // this market. Settlement mints must not re-run the consistency check —
        // it is order-sensitive and the partition here is derived from taker/maker
        // assignment, not the canonical registration order.

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

    /// @notice Merge positions without reentrancy guard — caller MUST already hold the lock.
    /// @dev Only for use by SettlementFacet (or other internal callers that hold nonReentrant).
    ///      When sender == address(this), no external calls are made (safeTransfer is skipped),
    ///      so there is no reentrancy risk.
    function _mergePositionsInternal(
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

    function _reportPayouts(address oracle, bytes32 questionId, uint256[] memory payouts) internal {
        if (payouts.length == 0 || payouts.length > type(uint8).max) {
            revert Errors.InvalidPayoutLength();
        }
        uint8 outcomeSlotCount = uint8(payouts.length);

        bytes32 conditionId = LibCTHelpers.getConditionId(oracle, questionId, outcomeSlotCount);
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        uint256[] storage numerators = ds.conditionalTokens.payoutNumerators[conditionId];

        if (numerators.length != outcomeSlotCount) {
            revert Errors.ConditionNotPrepared();
        }
        if (ds.conditionalTokens.payoutDenominator[conditionId] != 0) {
            revert Errors.ConditionAlreadyResolved();
        }

        uint256 den = 0;
        for (uint256 i = 0; i < outcomeSlotCount;) {
            uint256 num = payouts[i];
            if (numerators[i] != 0) {
                revert Errors.PayoutAlreadySet();
            }
            numerators[i] = num;
            den += num;
            unchecked { ++i; } // GAS-007: counter is bounded by outcomeSlotCount
        }

        if (den == 0) {
            revert Errors.AllZeroPayouts();
        }
        ds.conditionalTokens.payoutDenominator[conditionId] = den;

        emit Events.ConditionResolution(conditionId, oracle, questionId, outcomeSlotCount, numerators);
    }

    function _validateAndBuildPartitionPositions(
        address collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256[] memory partition,
        uint256 amount
    ) internal view returns (uint256 fullIndexSet, uint256 freeIndexSet, uint256[] memory positionIds, uint256[] memory amounts) {
        if (partition.length <= 1) {
            revert Errors.TrivialPartition();
        }
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        uint8 outcomeSlotCount = uint8(ds.conditionalTokens.payoutNumerators[conditionId].length);
        if (outcomeSlotCount == 0) revert Errors.ConditionNotPrepared();

        fullIndexSet = (1 << outcomeSlotCount) - 1;
        freeIndexSet = fullIndexSet;

        positionIds = new uint256[](partition.length);
        amounts = new uint256[](partition.length);

        for (uint256 i = 0; i < partition.length;) {
            uint256 indexSet = partition[i];
            if (indexSet == 0 || indexSet >= fullIndexSet) revert Errors.InvalidIndexSet();
            if ((indexSet & freeIndexSet) != indexSet) revert Errors.PartitionNotDisjoint();
            freeIndexSet ^= indexSet;

            positionIds[i] = _getPositionId(collateralToken, parentCollectionId, conditionId, indexSet);
            amounts[i] = amount;
            unchecked { ++i; } // GAS-007: counter is bounded by partition.length
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
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        if (!ds.conditionalTokens.conditions[conditionId].active) {
            revert Errors.ConditionNotActive();
        }
    }
}
