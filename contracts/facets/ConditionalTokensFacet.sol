// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {LibAdminConfigStorage} from "../libraries/LibAdminConfigStorage.sol";
import {LibConstants} from "../libraries/LibConstants.sol";
import {LibCTHelpers} from "../libraries/LibCTHelpers.sol";
import {LibERC1155} from "../libraries/LibERC1155.sol";
import {IConditionalTokens} from "../interfaces/IConditionalTokens.sol";
import {LibCTFCondition} from "../libraries/LibCTFCondition.sol";
import {LibDiamond} from "../libraries/LibDiamond.sol";
import {LibReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {Errors} from "../libraries/Errors.sol";
import {Events} from "../libraries/Events.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title ConditionalTokensFacet
 * @author Doefin
 * @notice Diamond facet implementing Gnosis Conditional Token Framework (CTF) functionality
 * @dev Provides core CTF operations: condition preparation, position splitting/merging, and payout redemption
 * @dev Integrates with Doefin's fee system and supports both direct and parent position redemptions
 * @dev Based on Gnosis CTF contracts with custom fee handling and enhanced security features
 */
contract ConditionalTokensFacet is IConditionalTokens {
    using SafeERC20 for IERC20;

    /**
     * @notice Prepares a new condition for outcome prediction
     * @dev Creates a condition that can be used to split collateral into outcome positions
     * @dev Only contract owner can prepare conditions to maintain quality control
     * @dev Generates a unique condition ID based on oracle, question, and outcome count
     * @param oracle The address authorized to resolve this condition
     * @param questionId Unique identifier for the question being asked
     * @param outcomeSlotCount Number of possible outcomes (must be >= 2)
     * @custom:emits ConditionPreparation with condition details
     * @custom:reverts NotContractOwner if caller is not contract owner
     * @custom:security Owner-only access prevents spam conditions
     * @custom:note Condition must be resolved by the specified oracle to enable redemptions
     */
    function prepareCondition(address oracle, bytes32 questionId, uint8 outcomeSlotCount) external override {
        LibDiamond.enforceIsContractOwner();
        bytes32 conditionId = LibCTFCondition.prepareCondition(oracle, questionId, outcomeSlotCount);

        emit Events.ConditionPreparation(conditionId, oracle, questionId, outcomeSlotCount);
    }

    /**
     * @notice Reports the payout vector for a resolved condition
     * @dev Only the designated oracle can report payouts to resolve the condition
     * @dev Payout values determine redemption ratios for each outcome position
     * @dev Array length must match the outcomeSlotCount from condition preparation
     * @param questionId The unique identifier for the question being resolved
     * @param payouts Array of payout numerators for each outcome (denominator is sum of all)
     * @custom:emits PayoutReported (via LibCTFCondition implementation)
     * @custom:reverts if msg.sender is not the oracle the condition was prepared for
     * @custom:reverts InvalidPayouts if payout array doesn't match expected format
     * @custom:security Oracle-only access ensures trusted resolution
     * @custom:note Payouts are normalized: winning outcome = 1, losing outcomes = 0 for binary markets
     */
    function reportPayouts(bytes32 questionId, uint256[] calldata payouts) external override {
        // Convert calldata to memory for library call
        uint256[] memory payoutsMemory = new uint256[](payouts.length);
        for (uint256 i = 0; i < payouts.length; i++) {
            payoutsMemory[i] = payouts[i];
        }

        // Call library function with msg.sender as oracle
        LibCTFCondition._reportPayouts(msg.sender, questionId, payoutsMemory);
    }

    /**
     * @notice Splits collateral tokens into conditional outcome positions
     * @dev Converts collateral tokens into ERC1155 position tokens representing possible outcomes
     * @dev User must have approved this contract to spend their collateral tokens
     * @dev Position tokens can be traded before condition resolution
     * @param collateralToken The ERC20 token being used as collateral
     * @param parentCollectionId The parent collection (typically 0x0 for root positions)
     * @param conditionId The condition identifier determining possible outcomes
     * @param partition Array specifying which outcomes to create positions for
     * @param amount Amount of collateral tokens to split into positions
     * @custom:emits PositionSplit with split details
     * @custom:reverts InsufficientBalance if user doesn't have enough collateral
     * @custom:reverts InsufficientAllowance if approval is insufficient
     * @custom:note Partition array determines which outcome positions are minted
     * @custom:gas Cost scales with number of outcomes in partition
     */
    function splitPosition(
        address collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256[] calldata partition,
        uint256 amount
    ) external override {
        LibCTFCondition._splitPosition(msg.sender, collateralToken, parentCollectionId, conditionId, amount, partition);

        emit Events.PositionSplit(msg.sender, collateralToken, parentCollectionId, conditionId, partition, amount);
    }

    /**
     * @notice Merges conditional outcome positions back into collateral tokens
     * @dev Opposite of splitPosition - burns position tokens and returns collateral
     * @dev User must own sufficient position tokens for all outcomes in the partition
     * @dev Only possible with complete sets of positions covering all outcomes
     * @param collateralToken The ERC20 token that will be returned
     * @param parentCollectionId The parent collection (must match original split)
     * @param conditionId The condition identifier (must match original split)
     * @param partition Array specifying which position tokens to merge
     * @param amount Amount of position tokens to merge back to collateral
     * @custom:emits PositionsMerge with merge details
     * @custom:reverts InsufficientBalance if user doesn't own enough position tokens
     * @custom:reverts InvalidPartition if partition doesn't represent complete set
     * @custom:note Merge requires holding all outcome positions in equal amounts
     * @custom:gas Cheaper than individual sales when market outcome is uncertain
     */
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

    /**
     * @notice Redeems position tokens for collateral after condition resolution
     * @dev Burns winning position tokens and transfers collateral minus resolution fees
     * @dev Supports both direct collateral redemption and parent position minting
     * @dev Only works after condition has been resolved with reported payouts
     * @param collateralToken The ERC20 token to redeem (must match position)
     * @param parentCollectionId The parent collection (0x0 for direct redemption)
     * @param conditionId The resolved condition identifier
     * @param indexSets Array of outcome index sets representing positions to redeem
     * @custom:emits PayoutRedemption with redemption details
     * @custom:emits PayoutRedemptionFeePaid if resolution fee applied
     * @custom:emits PayoutRedeemedToParentPosition for parent collection redemptions
     * @custom:reverts ConditionNotResolved if condition hasn't been resolved
     * @custom:reverts ConditionNotPrepared if condition was never prepared
     * @custom:reverts InvalidIndexSet if index set is invalid
     * @custom:security Reentrancy protection on external token transfers
     * @custom:note Resolution fees are deducted from payout amount
     * @custom:gas Cost scales with number of position types being redeemed
     */
    function redeemPositions(
        address collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256[] calldata indexSets
    ) external override {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        uint256 den = ds.conditionalTokens.payoutDenominator[conditionId];
        if (den == 0) revert Errors.ConditionNotResolved();

        uint8 outcomeSlotCount = uint8(ds.conditionalTokens.payoutNumerators[conditionId].length);
        if (outcomeSlotCount == 0) revert Errors.ConditionNotPrepared();

        uint256 totalPayout = 0;

        uint256 fullIndexSet = (1 << outcomeSlotCount) - 1;

        for (uint256 i = 0; i < indexSets.length; i++) {
            uint256 indexSet = indexSets[i];
            if (indexSet == 0 || indexSet >= fullIndexSet) revert Errors.InvalidIndexSet();

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

    /**
     * @notice Handles payout transfers with resolution fee deduction
     * @dev Internal function managing fee calculation and distribution during redemption
     * @dev Applies resolution fee if configured and transfers remainder to recipient
     * @dev Uses reentrancy protection for external token transfers
     * @param collateralToken The ERC20 token being transferred
     * @param recipient The address receiving the payout
     * @param amount The gross payout amount before fees
     * @custom:emits PayoutRedemptionFeePaid if fees are applied
     * @custom:reverts InvalidFeeReceiver if fee receiver not configured but fees enabled
     * @custom:security Protected against reentrancy attacks during transfers
     * @custom:note Zero fee configuration bypasses fee deduction entirely
     */
    function _handlePayoutTransfer(address collateralToken, address recipient, uint256 amount) internal {
        LibAdminConfigStorage.AdminConfigStorage storage acs = LibAdminConfigStorage.adminConfigStorage();

        address feeReceiver = acs.feeReceiver;
        uint16 feeBps = acs.resolutionFeeBps;

        if (feeReceiver == address(0)) revert Errors.InvalidFeeReceiver();

        if (feeBps == 0) {
            LibReentrancyGuard._nonReentrantBefore();
            IERC20(collateralToken).safeTransfer(recipient, amount);
            LibReentrancyGuard._nonReentrantAfter();

            return;
        }

        uint256 feeAmount = (amount * feeBps) / LibConstants.BPS_DENOMINATOR;
        uint256 userAmount = amount - feeAmount;

        LibReentrancyGuard._nonReentrantBefore();
        IERC20(collateralToken).safeTransfer(feeReceiver, feeAmount);
        IERC20(collateralToken).safeTransfer(recipient, userAmount);
        LibReentrancyGuard._nonReentrantAfter();

        emit Events.PayoutRedemptionFeePaid(recipient, feeReceiver, feeAmount, userAmount);
    }

    /**
     * @notice Calculates position ID for a given collateral token and collection
     * @dev Internal helper for position identification in conditional token system
     * @dev Position IDs are deterministic based on token, collection, and index set
     * @param collateralToken The ERC20 token backing the position
     * @param parentCollectionId The parent collection identifier
     * @param conditionId The condition this position belongs to
     * @param indexSet The outcome index set this position represents
     * @return The unique ERC1155 position token ID
     * @custom:note Position IDs are globally unique across all conditions and tokens
     * @custom:view Pure calculation with no storage access
     */
    function _getPositionId(
        address collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256 indexSet
    ) internal view returns (uint256) {
        bytes32 collId = LibCTHelpers.getCollectionId(parentCollectionId, conditionId, indexSet);
        return LibCTHelpers.getPositionId(collateralToken, collId);
    }

    /**
     * @notice Calculates condition ID for given oracle, question, and outcome count
     * @dev Public helper function for deterministic condition ID generation
     * @dev Condition IDs are globally unique across all questions and oracles
     * @param oracle The address authorized to resolve the condition
     * @param questionId The unique question identifier
     * @param outcomeSlotCount The number of possible outcomes
     * @return The unique condition identifier
     * @custom:note Useful for off-chain applications to predict condition IDs
     * @custom:pure Deterministic calculation with no storage dependencies
     */
    function getConditionId(address oracle, bytes32 questionId, uint8 outcomeSlotCount) external pure returns (bytes32) {
        return LibCTHelpers.getConditionId(oracle, questionId, outcomeSlotCount);
    }

    function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) external view returns (bytes32) {
        return LibCTHelpers.getCollectionId(parentCollectionId, conditionId, indexSet);
    }

    function getPositionId(address collateralToken, bytes32 collectionId) external pure returns (uint256) {
        return LibCTHelpers.getPositionId(collateralToken, collectionId);
    }

    /**
     * @notice Retrieves payout numerators for a resolved condition
     * @dev Returns the payout distribution reported by the oracle for condition resolution
     * @dev Payout denominators are calculated as the sum of all numerators
     * @param conditionId The condition identifier to query
     * @return Array of payout numerators for each outcome (empty if unresolved)
     * @custom:view Read-only access to resolution data
     * @custom:note For binary markets: winning outcome = [1,0] or [0,1], ties = [1,1]
     */
    function getPayoutNumerators(bytes32 conditionId) external view override returns (uint256[] memory) {
        return LibDoefinStorage.appStorage().conditionalTokens.payoutNumerators[conditionId];
    }
}
