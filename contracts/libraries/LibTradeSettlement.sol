// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {LibCollateralManager} from "./LibCollateralManager.sol";
import {LibFeeManager} from "./LibFeeManager.sol";
import {LibPositionRegistry} from "./LibPositionRegistry.sol";
import {LibCTFCondition} from "./LibCTFCondition.sol";
import {LibERC1155} from "./LibERC1155.sol";
import {LibMatchEngine} from "./LibMatchEngine.sol";
import {LibReentrancyGuard} from "./LibReentrancyGuard.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Errors} from "./Errors.sol";
import {Events} from "./Events.sol";

/**
 * @title LibTradeSettlement
 * @notice Handles all trade settlement operations for different match types
 */
library LibTradeSettlement {
    using SafeERC20 for IERC20;

    /**
     * @notice Execute settlement for a trade (delegates to LibTradeSettlement)
     * @param settlementExecCtx The settlement execution context
     */
    function settlementDispatcher(LibDoefinStorage.SettlementExecutionContext memory settlementExecCtx) internal {
        // Validate settlement context first
        validateSettlementContext(settlementExecCtx);

        // Execute the settlement
        executeSettlement(settlementExecCtx);
    }

    // ----------------------------------------
    // Settlement Dispatcher
    // ----------------------------------------

    /**
     * @notice Main settlement dispatcher that routes to appropriate settlement handler
     * @param settlementExecCtx The settlement execution context
     */
    function executeSettlement(LibDoefinStorage.SettlementExecutionContext memory settlementExecCtx) private {
        if (settlementExecCtx.matchType == LibDoefinStorage.MatchType.Complementary) {
            _handleComplementaryMatch(settlementExecCtx);
        } else if (settlementExecCtx.matchType == LibDoefinStorage.MatchType.Mint) {
            _handleMintMatch(settlementExecCtx);
        } else if (settlementExecCtx.matchType == LibDoefinStorage.MatchType.Merge) {
            _handleMergeMatch(settlementExecCtx);
        } else {
            revert Errors.InvalidMatch();
        }
    }

    // ----------------------------------------
    // Mint Match Settlement
    // ----------------------------------------

    /**
     * @notice Handle settlement for mint matches (split operations)
     * @param settlementExecCtx The settlement execution context
     */
    function _handleMintMatch(LibDoefinStorage.SettlementExecutionContext memory settlementExecCtx) internal {
        // Calculate fees and contributions
        (uint256 makerFee, uint256 takerFee, uint256 makerContribution, uint256 takerContribution) = LibFeeManager.computeMintFees(
            settlementExecCtx.makerOrder,
            settlementExecCtx.fillableAmount
        );

        address collateralToken = settlementExecCtx.makerOrder.collateralToken;

        // Accrue protocol fees
        LibFeeManager.accrueFees(makerFee, takerFee, settlementExecCtx);

        _executeMintMatch(settlementExecCtx, collateralToken, makerContribution, takerContribution, makerFee, takerFee);
    }

    /**
     * @notice Execute mint match when taker is buying
     * @param settlementExecCtx The settlement execution context
     * @param collateralToken The collateral token address
     * @param makerContribution Maker's contribution to the mint
     * @param takerContribution Taker's contribution to the mint
     * @param makerFee Maker's fee amount
     * @param takerFee Taker's fee amount
     */
    function _executeMintMatch(
        LibDoefinStorage.SettlementExecutionContext memory settlementExecCtx,
        address collateralToken,
        uint256 makerContribution,
        uint256 takerContribution,
        uint256 makerFee,
        uint256 takerFee
    ) internal {
        uint256 takerTotalPayment = takerContribution + takerFee;

        // Consume maker's ERC20 collateral
        LibCollateralManager.consumeERC20Collateral(settlementExecCtx.makerOrder.maker, collateralToken, makerContribution + makerFee);
        
        if (settlementExecCtx.executionType == LibDoefinStorage.ExecutionType.Market){
            // Validate taker has sufficient allowance
            uint256 allowance = IERC20(collateralToken).allowance(settlementExecCtx.takerOrder.taker, address(this));
            if (allowance < takerTotalPayment) {
                revert Errors.InsufficientERC20Allowance(settlementExecCtx.takerOrder.taker, collateralToken, takerTotalPayment, allowance);
            }
            LibReentrancyGuard._nonReentrantBefore();
            // Collect taker's ERC20 contribution
            IERC20(collateralToken).safeTransferFrom(settlementExecCtx.takerOrder.taker, address(this), takerTotalPayment);
            LibReentrancyGuard._nonReentrantAfter();

        } else {

            // If it's a limit order check for refund, and consume from the taker's locked collateral 
            _manageRefund(settlementExecCtx);

            // Consume the rest to pay for mint operation
            LibCollateralManager.consumeERC20Collateral(settlementExecCtx.takerOrder.taker, collateralToken, takerContribution + takerFee);
        }

        // Execute the split operation
        _executeSplitOperation(settlementExecCtx);

        // Distribute the newly minted position tokens
        _distributePositionTokens(settlementExecCtx);
    }

    // ----------------------------------------
    // Merge Match Settlement
    // ----------------------------------------

    /**
     * @notice Handle settlement for merge matches (merge operations)
     * @param settlementExecCtx The settlement execution context
     */
    function _handleMergeMatch(LibDoefinStorage.SettlementExecutionContext memory settlementExecCtx) internal {
        // Calculate fees and contributions
        (uint256 makerFee, uint256 takerFee, uint256 makerContribution, uint256 takerContribution) = LibFeeManager.computeMintFees(
            settlementExecCtx.makerOrder,
            settlementExecCtx.fillableAmount
        );

        address collateralToken = settlementExecCtx.makerOrder.collateralToken;

        // Accrue protocol fees
        LibFeeManager.accrueFees(makerFee, takerFee, settlementExecCtx);
        
        // Consume maker's ERC1155 tokens
        LibCollateralManager.consumeERC1155Collateral(
            settlementExecCtx.makerOrder.maker,
            settlementExecCtx.makerOrder.positionId,
            settlementExecCtx.fillableAmount
        );

        if (settlementExecCtx.executionType == LibDoefinStorage.ExecutionType.Market) {
            LibReentrancyGuard._nonReentrantBefore();
            // Receive taker's ERC1155 tokens
            LibERC1155.safeTransferFrom(
                address(this),
                settlementExecCtx.takerOrder.taker,
                address(this),
                settlementExecCtx.takerOrder.positionId,
                settlementExecCtx.fillableAmount,
                ""
            );
            LibReentrancyGuard._nonReentrantAfter();
        } else {
            // If it's limit order, It should consume from taker's collateral
            LibCollateralManager.consumeERC1155Collateral(
                settlementExecCtx.takerOrder.taker,
                settlementExecCtx.takerOrder.positionId,
                settlementExecCtx.fillableAmount
            );
        }

        // Execute the merge operation
        _executeMergeOperation(settlementExecCtx);

        // Distribute the merged collateral
        _distributeMergedCollateral(settlementExecCtx, collateralToken, makerContribution, takerContribution, makerFee, takerFee);
    }

    // ----------------------------------------
    // Complementary Match Settlement
    // ----------------------------------------

    /**
     * @notice Handle settlement for complementary matches (direct position trading)
     * @param settlementExecCtx The settlement execution context
     */
    function _handleComplementaryMatch(LibDoefinStorage.SettlementExecutionContext memory settlementExecCtx) internal {
        // Calculate fees
        (uint256 makerFee, uint256 takerFee, uint256 cost) = LibFeeManager.computeTradeExecutionFees(settlementExecCtx);

        // Accrue protocol fees
        LibFeeManager.accrueFees(makerFee, takerFee, settlementExecCtx);

        // Handle different taker directions
        if (settlementExecCtx.takerOrder.direction == LibDoefinStorage.OrderDirection.Sell) {
            _executeComplementaryMatchForSellTaker(settlementExecCtx, cost, makerFee, takerFee);
        } else {
            _executeComplementaryMatchForBuyTaker(settlementExecCtx, cost, makerFee, takerFee);
        }
    }

    /**
     * @notice Execute complementary match when taker is selling
     * @param settlementExecCtx The settlement execution context
     * @param cost The base cost of the trade
     * @param makerFee The maker's fee amount
     * @param takerFee The taker's fee amount
     */
    function _executeComplementaryMatchForSellTaker(
        LibDoefinStorage.SettlementExecutionContext memory settlementExecCtx,
        uint256 cost,
        uint256 makerFee,
        uint256 takerFee
    ) internal {
        address collateralToken = settlementExecCtx.makerOrder.collateralToken;

        // Maker pays: consume ERC20 collateral
        uint256 totalMakerPayment = cost + makerFee;
        LibCollateralManager.consumeERC20Collateral(settlementExecCtx.makerOrder.maker, collateralToken, totalMakerPayment);

        // Taker receives: cost minus taker fee
        uint256 takerReceives = cost - takerFee;

        // GUARD ONLY THE EXTERNAL CALLS
        LibReentrancyGuard._nonReentrantBefore();
        IERC20(collateralToken).safeTransfer(settlementExecCtx.takerOrder.taker, takerReceives);

        if (settlementExecCtx.executionType == LibDoefinStorage.ExecutionType.Market) {
            // Transfer position tokens directly from taker to maker
            LibERC1155.safeTransferFrom(
                address(this),
                settlementExecCtx.takerOrder.taker,
                settlementExecCtx.makerOrder.maker,
                settlementExecCtx.makerOrder.positionId,
                settlementExecCtx.fillableAmount,
                ""
            );
        } else {
            // Consume taker's ERC1155 tokens
            LibCollateralManager.consumeERC1155Collateral(
                settlementExecCtx.takerOrder.taker,
                settlementExecCtx.takerOrder.positionId,
                settlementExecCtx.fillableAmount
            );

            // Transfer from the locked collateral to maker, and consume from it.
            LibERC1155.safeTransferFrom(
                address(this),
                address(this),
                settlementExecCtx.makerOrder.maker,
                settlementExecCtx.makerOrder.positionId,
                settlementExecCtx.fillableAmount,
                ""
            );
        }

        LibReentrancyGuard._nonReentrantAfter();
    }

    function _manageRefund(LibDoefinStorage.SettlementExecutionContext memory settlementExecCtx) internal {
        uint256 takerFeePaid = (settlementExecCtx.takerOrder.takerPaidFeeBps * settlementExecCtx.takerOrder.targetAvgPrice) / 10_000;
        uint256 takerPaidPerToken = settlementExecCtx.takerOrder.targetAvgPrice + takerFeePaid;

        uint256 tradeEffectivePricePerToken = LibMatchEngine.effectiveTakerPrice(settlementExecCtx.makerOrder, settlementExecCtx.takerOrder.direction, settlementExecCtx.matchType);

        LibCollateralManager.refundSurplus(takerPaidPerToken, tradeEffectivePricePerToken, settlementExecCtx.fillableAmount, settlementExecCtx.takerOrder.taker, settlementExecCtx.makerOrder.collateralToken);
    }
    /**
     * @notice Execute complementary match when taker is buying
     * @param settlementExecCtx The settlement execution context
     * @param cost The base cost of the trade
     * @param makerFee The maker's fee amount
     * @param takerFee The taker's fee amount
     */
    function _executeComplementaryMatchForBuyTaker(
        LibDoefinStorage.SettlementExecutionContext memory settlementExecCtx,
        uint256 cost,
        uint256 makerFee,
        uint256 takerFee
    ) internal {
        address collateralToken = settlementExecCtx.makerOrder.collateralToken;

        // Consume maker's ERC1155 tokens
        LibCollateralManager.consumeERC1155Collateral(
            settlementExecCtx.makerOrder.maker,
            settlementExecCtx.makerOrder.positionId,
            settlementExecCtx.fillableAmount
        );

        // Maker receives: cost minus maker fee
        uint256 makerReceives = cost - makerFee;

        if (settlementExecCtx.executionType == LibDoefinStorage.ExecutionType.Market) {
            // Taker pays: collect ERC20 from taker
            uint256 totalTakerPayment = cost + takerFee;
            LibReentrancyGuard._nonReentrantBefore();
            if(IERC20(collateralToken).allowance(settlementExecCtx.takerOrder.taker, address(this)) < totalTakerPayment) {
                revert Errors.InsufficientERC20Allowance(settlementExecCtx.takerOrder.taker, collateralToken, totalTakerPayment, IERC20(collateralToken).allowance(settlementExecCtx.takerOrder.taker, address(this)));
            }
            IERC20(collateralToken).safeTransferFrom(settlementExecCtx.takerOrder.taker, address(this), totalTakerPayment);
            LibReentrancyGuard._nonReentrantAfter();

        } else {
            // Check for refund and consume from taker's locked collateral
            _manageRefund(settlementExecCtx);
            // Consume the rest to pay for maker
            LibCollateralManager.consumeERC20Collateral(settlementExecCtx.takerOrder.taker, collateralToken, cost + takerFee);
        }

        IERC20(collateralToken).safeTransfer(settlementExecCtx.makerOrder.maker, makerReceives);

        LibERC1155.safeTransferFrom(
            address(this),
            address(this),
            settlementExecCtx.takerOrder.taker,
            settlementExecCtx.makerOrder.positionId,
            settlementExecCtx.fillableAmount,
            ""
        );
    }

    // ----------------------------------------
    // CTF Operations
    // ----------------------------------------

    /**
     * @notice Execute split operation for mint matches
     * @param settlementExecCtx The settlement execution context
     */
    function _executeSplitOperation(LibDoefinStorage.SettlementExecutionContext memory settlementExecCtx) internal {
        LibDoefinStorage.MarketMetadata memory marketMetadata = LibPositionRegistry.getMarketMetadata(settlementExecCtx.makerOrder.positionId);

        bytes32 conditionId = LibPositionRegistry.retrieveConditionId(
            settlementExecCtx.makerOrder.positionId,
            settlementExecCtx.takerOrder.positionId
        );

        LibCTFCondition._splitPosition(
            address(this),
            marketMetadata.collateralToken,
            marketMetadata.parentCollectionId,
            conditionId,
            settlementExecCtx.fillableAmount,
            marketMetadata.partitions
        );
    }

    /**
     * @notice Execute merge operation for merge matches
     * @param settlementExecCtx The settlement execution context
     */
    function _executeMergeOperation(LibDoefinStorage.SettlementExecutionContext memory settlementExecCtx) internal {
        LibDoefinStorage.MarketMetadata memory marketMetadata = LibPositionRegistry.getMarketMetadata(settlementExecCtx.makerOrder.positionId);

        bytes32 conditionId = LibPositionRegistry.retrieveConditionId(
            settlementExecCtx.makerOrder.positionId,
            settlementExecCtx.takerOrder.positionId
        );

        LibCTFCondition._mergePositions(
            address(this),
            marketMetadata.collateralToken,
            marketMetadata.parentCollectionId,
            conditionId,
            marketMetadata.partitions,
            settlementExecCtx.fillableAmount
        );
    }

    // ----------------------------------------
    // Token Distribution
    // ----------------------------------------

    /**
     * @notice Distribute position tokens after split operation
     * @param settlementExecCtx The settlement execution context
     */
    function _distributePositionTokens(LibDoefinStorage.SettlementExecutionContext memory settlementExecCtx) internal {

        LibReentrancyGuard._nonReentrantBefore();
        // Transfer maker's desired position tokens
        LibERC1155.safeTransferFrom(
            address(this),
            address(this),
            settlementExecCtx.makerOrder.maker,
            settlementExecCtx.makerOrder.positionId,
            settlementExecCtx.fillableAmount,
            ""
        );

        // Transfer taker's desired position tokens
        LibERC1155.safeTransferFrom(
            address(this),
            address(this),
            settlementExecCtx.takerOrder.taker,
            settlementExecCtx.takerOrder.positionId,
            settlementExecCtx.fillableAmount,
            ""
        );
        LibReentrancyGuard._nonReentrantAfter();
    }

    /**
     * @notice Distribute merged collateral after merge operation
     * @param settlementExecCtx The settlement execution context
     * @param collateralToken The collateral token address
     * @param makerContribution Maker's contribution amount
     * @param takerContribution Taker's contribution amount
     * @param makerFee Maker's fee amount
     * @param takerFee Taker's fee amount
     */
    function _distributeMergedCollateral(
        LibDoefinStorage.SettlementExecutionContext memory settlementExecCtx,
        address collateralToken,
        uint256 makerContribution,
        uint256 takerContribution,
        uint256 makerFee,
        uint256 takerFee
    ) internal {
        // Calculate net amounts after fees
        uint256 makerReceives = makerContribution - makerFee;
        uint256 takerReceives = takerContribution - takerFee;

        LibReentrancyGuard._nonReentrantBefore();
        // Distribute ERC20 collateral to both parties
        if (makerReceives > 0) {
            IERC20(collateralToken).safeTransfer(settlementExecCtx.makerOrder.maker, makerReceives);
        }

        if (takerReceives > 0) {
            IERC20(collateralToken).safeTransfer(settlementExecCtx.takerOrder.taker, takerReceives);
        }

        LibReentrancyGuard._nonReentrantAfter();
    }

    // ----------------------------------------
    // Settlement Validation
    // ----------------------------------------

    /**
     * @notice Validate settlement context before execution
     * @param settlementExecCtx The settlement execution context
     */
    function validateSettlementContext(LibDoefinStorage.SettlementExecutionContext memory settlementExecCtx) private view {
        // Validate fillable amount
        if (settlementExecCtx.fillableAmount == 0) {
            revert Errors.ZeroAmount();
        }

        // Match type specific validations
        if (settlementExecCtx.matchType == LibDoefinStorage.MatchType.Complementary) {
            _validateComplementaryMatch(settlementExecCtx);
        } else {
            _validateMintMergeMatch(settlementExecCtx);
        }
    }

    /**
     * @notice Validate complementary match requirements
     * @param settlementExecCtx The settlement execution context
     */
    function _validateComplementaryMatch(LibDoefinStorage.SettlementExecutionContext memory settlementExecCtx) private pure {
        // For complementary matches, positions must be the same
        if (settlementExecCtx.makerOrder.positionId != settlementExecCtx.takerOrder.positionId) {
            revert Errors.PositionIdMismatch();
        }

        // Directions must be opposite
        if (settlementExecCtx.makerOrder.direction == settlementExecCtx.takerOrder.direction) {
            revert Errors.SameDirectionForComplementary();
        }
    }

    /**
     * @notice Validate mint/merge match requirements
     * @param settlementExecCtx The settlement execution context
     */
    function _validateMintMergeMatch(LibDoefinStorage.SettlementExecutionContext memory settlementExecCtx) private view {
        // For mint/merge matches, directions must be the same
        if (settlementExecCtx.makerOrder.direction != settlementExecCtx.takerOrder.direction) {
            revert Errors.DifferentOrderDirectionForNonComplementary();
        }

        // Positions must be complements
        LibPositionRegistry.validateComplement(settlementExecCtx.takerOrder.positionId, settlementExecCtx.makerOrder.positionId);
    }
}
