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
import {LibConstants} from "./LibConstants.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

library LibCTFCondition {
    using SafeERC20 for IERC20;

    /// @dev Prepares a new condition by initializing payout numerators.
    /// Can be called from both low-level (CTF-compatible) and high-level (managed) flows.
    function prepareCondition(address oracle, bytes32 questionId, uint8 outcomeSlotCount) internal returns (bytes32 conditionId) {
        if (oracle == address(0)) {
            revert Errors.InvalidOracleAddress();
        }
        // CTF-006: as upstream Gnosis CTF — a condition needs at least two outcomes.
        if (outcomeSlotCount < 2) revert Errors.InvalidOutcomeSlotCount();

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
        // CTF-008: the public path never runs as the Diamond itself — that case skipped the
        // collateral movement and is reserved for the lock-holding internal variants.
        if (sender == address(this)) revert Errors.SelfCallNotAllowed();
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
                // CTF-004: once the condition has resolved, turning a full set back into
                // collateral is a redemption — charge the same resolution fee, or winners
                // bypass it by pairing their tokens with (worthless) losing ones.
                uint256 fee = LibDoefinStorage.appStorage().conditionalTokens.payoutDenominator[conditionId] != 0
                    ? (amount * resolutionFeeBps(conditionId)) / LibConstants.BPS_DENOMINATOR
                    : 0;
                if (fee > 0) {
                    LibAdminConfigStorage.adminConfigStorage().accruedFees[collateralToken] += fee;
                    emit Events.FeeAccrued(collateralToken, fee, LibConstants.FEE_KIND_RESOLUTION);
                }
                IERC20(collateralToken).safeTransfer(sender, amount - fee);
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
        // CTF-008: see _mergePositions — a self-call would mint positions without collateral.
        if (sender == address(this)) revert Errors.SelfCallNotAllowed();
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

        // CTF-001 / CTF-002: only a canonical root split defines a settlement market — no parent,
        // a full partition, ascending singletons [1, 2, 4, …]. Any other split (partial, reordered,
        // nested) is ordinary CTF use and leaves the registry alone, so no caller can choose a
        // market's outcome set, outcome order, parent collection or condition mapping. Settlement
        // treats a registered pair as complete outcomes; a registered partial set let a Merge pay
        // full collateral for an incomplete one.
        if (_isCanonicalRootPartition(parentCollectionId, freeIndexSet, partition)) {
            LibPositionRegistry.registerPositionPairs(positionIds, partition, conditionId, parentCollectionId, collateralToken);
        }

        LibReentrancyGuard._nonReentrantBefore();
        if (freeIndexSet == 0) {
            if (parentCollectionId == bytes32(0)) {
                // `sender` is `msg.sender` at the public entrypoint
                // (`ConditionalTokensFacet.splitPosition`); a user splits their own
                // collateral — they cannot pass a third-party `from`.
                // slither-disable-next-line arbitrary-send-erc20
                IERC20(collateralToken).safeTransferFrom(sender, address(this), amount);
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

    /// @notice Split position inside the caller's reentrancy window — the caller MUST hold the lock.
    /// @dev Only for SettlementFacet (or another caller holding nonReentrant); CTF-008 enforces the
    ///      lock instead of assuming it. With sender == address(this) the collateral pull is skipped
    ///      (it is already in the Diamond), but the ERC-1155 mint to the Diamond is not an
    ///      external call only because LibERC1155 skips the acceptance check for self-transfers.
    function _splitPositionInternal(
        address sender,
        address collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256 amount,
        uint256[] memory partition
    ) internal {
        LibReentrancyGuard._enforceEntered();
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
                    // `_splitPositionInternal` is only called by `SettlementFacet._settleMint`
                    // with `sender = address(this)`; the `sender != address(this)` branch is
                    // structurally unreachable but kept for parity with `_splitPosition`.
                    // slither-disable-next-line arbitrary-send-erc20
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

    /// @notice Merge positions inside the caller's reentrancy window — the caller MUST hold the lock.
    /// @dev Only for SettlementFacet (or another caller holding nonReentrant); CTF-008 enforces the
    ///      lock instead of assuming it. See _splitPositionInternal for the self-transfer note.
    function _mergePositionsInternal(
        address sender,
        address collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256[] memory partition,
        uint256 amount
    ) internal {
        LibReentrancyGuard._enforceEntered();
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

    /// @dev CTF-006: payout numerators may sum to at most 2^64 − 1, so redemption's
    ///      `stake * numerator` cannot overflow for any realistic stake.
    uint256 internal constant MAX_PAYOUT_DENOMINATOR = type(uint64).max;

    function _reportPayouts(address oracle, bytes32 questionId, uint256[] memory payouts) internal {
        // CTF-006: at least two outcomes, as upstream (a single-slot vector was accepted).
        if (payouts.length < 2 || payouts.length > type(uint8).max) {
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
        if (den > MAX_PAYOUT_DENOMINATOR) revert Errors.InvalidPayouts();
        ds.conditionalTokens.payoutDenominator[conditionId] = den;
        _snapshotResolutionFee(conditionId);

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

    /**
     * @notice Resolve `conditionId` as void: every outcome pays an equal share (numerators all 1).
     * @dev CTF-005 — the only payout writer was `_reportPayouts`, bound to the condition's oracle,
     *      so a condition that can never be reported (a stalled oracle, an orphaned question)
     *      locked one-sided collateral until an emergency upgrade. A void is a refund: the
     *      resolution fee is snapshotted as 0. Callers gate who may void and when.
     * @param conditionId The condition to resolve as void
     * @param oracle The condition's oracle, for the ConditionResolution event
     * @param questionId The condition's question, for the ConditionResolution event
     * @custom:reverts ConditionNotPrepared, ConditionAlreadyResolved
     */
    function _voidPayouts(bytes32 conditionId, address oracle, bytes32 questionId) internal {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        uint256[] storage numerators = ds.conditionalTokens.payoutNumerators[conditionId];
        uint256 slots = numerators.length;
        if (slots == 0) revert Errors.ConditionNotPrepared();
        if (ds.conditionalTokens.payoutDenominator[conditionId] != 0) revert Errors.ConditionAlreadyResolved();

        for (uint256 i = 0; i < slots;) {
            numerators[i] = 1;
            unchecked { ++i; }
        }
        ds.conditionalTokens.payoutDenominator[conditionId] = slots;
        LibAdminConfigStorage.adminConfigStorage().resolutionFeeAtResolution[conditionId] =
            LibAdminConfigStorage.ResolutionFeeSnapshot({set: true, bps: 0});

        emit Events.ConditionResolution(conditionId, oracle, questionId, uint8(slots), numerators);
    }

    /// @notice Resolution fee (bps) charged on payouts of `conditionId` — the rate captured when it
    ///         resolved (CTF-007), or the live rate for conditions resolved before snapshots existed.
    /// @param conditionId The condition whose payouts are being paid
    /// @return The fee in basis points
    function resolutionFeeBps(bytes32 conditionId) internal view returns (uint16) {
        LibAdminConfigStorage.AdminConfigStorage storage acs = LibAdminConfigStorage.adminConfigStorage();
        LibAdminConfigStorage.ResolutionFeeSnapshot storage snap = acs.resolutionFeeAtResolution[conditionId];
        return snap.set ? snap.bps : acs.resolutionFeeBps;
    }

    /// @dev Capture the live resolution fee for `conditionId` (CTF-007).
    function _snapshotResolutionFee(bytes32 conditionId) internal {
        LibAdminConfigStorage.AdminConfigStorage storage acs = LibAdminConfigStorage.adminConfigStorage();
        acs.resolutionFeeAtResolution[conditionId] = LibAdminConfigStorage.ResolutionFeeSnapshot({set: true, bps: acs.resolutionFeeBps});
    }

    /// @dev True for a split from collateral (no parent) over every outcome, listed as ascending
    ///      singletons: partition[i] == 1 << i. `freeIndexSet == 0` means the partition is full.
    function _isCanonicalRootPartition(
        bytes32 parentCollectionId,
        uint256 freeIndexSet,
        uint256[] memory partition
    ) internal pure returns (bool) {
        if (parentCollectionId != bytes32(0) || freeIndexSet != 0) return false;
        for (uint256 i = 0; i < partition.length;) {
            if (partition[i] != uint256(1) << i) return false;
            unchecked { ++i; }
        }
        return true;
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
