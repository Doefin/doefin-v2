// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {LibCollateralManager} from "./LibCollateralManager.sol";
import {LibFeeManager} from "./LibFeeManager.sol";
import {LibPositionRegistry} from "./LibPositionRegistry.sol";
import {LibCTFCondition} from "./LibCTFCondition.sol";
import {LibERC1155} from "./LibERC1155.sol";
import {LibMatchEngine} from "./LibMatchEngine.sol";
import {LibQuoteCurrency} from "./LibQuoteCurrency.sol";
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
        // Check if this is a cross-currency trade
        if (_isCrossCurrencySettlement(settlementExecCtx)) {
            _handleCrossCurrencySettlement(settlementExecCtx);
            return;
        }

        // Standard settlement logic (unchanged)
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

        if (settlementExecCtx.executionType == LibDoefinStorage.ExecutionType.Market) {
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

        uint256 tradeEffectivePricePerToken = LibMatchEngine.effectiveTakerPrice(
            settlementExecCtx.makerOrder,
            settlementExecCtx.takerOrder.direction,
            settlementExecCtx.matchType
        );

        LibCollateralManager.refundSurplus(
            takerPaidPerToken,
            tradeEffectivePricePerToken,
            settlementExecCtx.fillableAmount,
            settlementExecCtx.takerOrder.taker,
            settlementExecCtx.makerOrder.collateralToken
        );
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
            uint256 currentAllowance = IERC20(collateralToken).allowance(settlementExecCtx.takerOrder.taker, address(this));
            if (currentAllowance < totalTakerPayment) {
                revert Errors.InsufficientERC20Allowance(settlementExecCtx.takerOrder.taker, collateralToken, totalTakerPayment, currentAllowance);
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

    // ========================================
    // CROSS-CURRENCY SETTLEMENT
    // ========================================

    /**
     * @notice Check if this settlement involves cross-currency orders
     * @param settlementExecCtx The settlement execution context
     * @return isCrossCurrency Whether this is a cross-currency settlement
     */
    function _isCrossCurrencySettlement(
        LibDoefinStorage.SettlementExecutionContext memory settlementExecCtx
    ) private pure returns (bool isCrossCurrency) {
        return (settlementExecCtx.makerOrder.orderType == LibDoefinStorage.OrderType.CrossCurrency);
    }

    /**
     * @notice Handle settlement for cross-currency orders
     * @param settlementExecCtx The settlement execution context
     */
    function _handleCrossCurrencySettlement(LibDoefinStorage.SettlementExecutionContext memory settlementExecCtx) private {
        // Cross-currency orders only support complementary matching
        if (settlementExecCtx.matchType != LibDoefinStorage.MatchType.Complementary) {
            revert Errors.NonComplementaryCrossCurrencyMatch();
        }

        // Validate cross-currency settlement requirements
        _validateCrossCurrencySettlement(settlementExecCtx);

        // Execute cross-currency complementary settlement with quote currency transfers
        _executeCrossCurrencyComplementaryMatch(settlementExecCtx);
    }

    /**
     * @notice Execute cross-currency complementary settlement
     * @param settlementExecCtx The settlement execution context
     */
    function _executeCrossCurrencyComplementaryMatch(LibDoefinStorage.SettlementExecutionContext memory settlementExecCtx) private {
        LibDoefinStorage.Order memory makerOrder = settlementExecCtx.makerOrder;
        LibDoefinStorage.TakerOrderContext memory takerOrder = settlementExecCtx.takerOrder;
        uint256 fillAmount = settlementExecCtx.fillableAmount;

        address quoteCurrencyToken = makerOrder.crossCurrencyConfig.quoteCurrencyToken;
        address collateralToken = makerOrder.collateralToken;

        bool useOracleRate = (makerOrder.crossCurrencyConfig.exchangeRateType == LibDoefinStorage.ExchangeRateType.Dynamic);
        uint256 exchangeRate;

        if (useOracleRate) {
            // Dynamic rate: fetch from oracle and check staleness
            (uint256 oracleRate, bool isStale) = LibQuoteCurrency.getOracleExchangeRate(quoteCurrencyToken, collateralToken);
            if (isStale) {
                revert Errors.OraclePriceStale();
            }
            exchangeRate = oracleRate;
        } else {
            // Fixed rate: use the rate from order config
            exchangeRate = makerOrder.crossCurrencyConfig.exchangeRate;
        }

        (uint256 makerQuoteFee, uint256 takerQuoteFee, uint256 makerQuotePayment, uint256 takerQuotePayment) = _computeCrossCurrencyFees(
            makerOrder,
            fillAmount,
            exchangeRate
        );

        if (makerOrder.direction == LibDoefinStorage.OrderDirection.Buy) {
            _settleCrossCurrencyBuyMaker(settlementExecCtx, quoteCurrencyToken, makerQuotePayment, takerQuotePayment);
        } else {
            _settleCrossCurrencySellMaker(settlementExecCtx, quoteCurrencyToken, makerQuotePayment, takerQuotePayment);
        }

        LibFeeManager.accrueFees(makerQuoteFee, takerQuoteFee, settlementExecCtx);

        emit Events.CrossCurrencySettlement(
            takerOrder.taker,
            makerOrder.maker,
            makerOrder.orderId,
            quoteCurrencyToken,
            fillAmount,
            exchangeRate,
            makerQuoteFee + takerQuoteFee
        );
    }

    /**
     * @notice Validate cross-currency settlement requirements
     * @param settlementExecCtx The settlement execution context
     */
    function _validateCrossCurrencySettlement(LibDoefinStorage.SettlementExecutionContext memory settlementExecCtx) private view {
        // Same validation as complementary match
        _validateComplementaryMatch(settlementExecCtx);

        // Additional cross-currency validations
        LibDoefinStorage.Order memory makerOrder = settlementExecCtx.makerOrder;

        // Validate quote currency is allowed
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        if (!ds.adminConfigStorage.isAllowed[makerOrder.crossCurrencyConfig.quoteCurrencyToken]) {
            revert Errors.TokenNotAllowed();
        }

        // Validate exchange rate
        if (makerOrder.crossCurrencyConfig.exchangeRate == 0) {
            revert Errors.InvalidExchangeRate();
        }
    }

    /**
     * @notice Compute fees for cross-currency settlement
     * @param makerOrder The maker order
     * @param fillAmount The fill amount
     * @return makerQuoteFee Maker fee in quote currency units
     * @return takerQuoteFee Taker fee in quote currency units
     * @return makerQuotePayment Maker payment in quote currency units
     * @return takerQuotePayment Taker payment in quote currency units
     * @dev Uses the same conversion formula as lockCollateral to avoid precision loss:
     *      collateralValue = (fillAmount × pricePerToken) ÷ collateralUnitPerPair
     *      totalQuoteValue = (collateralValue × exchangeRate) ÷ 1e18
     * @dev Payment direction:
     *      Buy maker: pays totalQuoteValue + fee
     *      Sell maker: receives totalQuoteValue - fee
     *      Taker receives/pays inverse amounts
     */
    function _computeCrossCurrencyFees(
        LibDoefinStorage.Order memory makerOrder,
        uint256 fillAmount,
        uint256 exchangeRate
    ) private view returns (uint256 makerQuoteFee, uint256 takerQuoteFee, uint256 makerQuotePayment, uint256 takerQuotePayment) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        uint256 collateralUnitPerPair = ds.adminConfigStorage.unitPerPair[makerOrder.collateralToken];

        uint256 collateralValue = (fillAmount * makerOrder.pricePerToken) / collateralUnitPerPair;
        uint256 totalQuoteValue = (collateralValue * exchangeRate) / 1e18;

        makerQuoteFee = (totalQuoteValue * makerOrder.orderFeeConfig.makerFeeBps) / 10_000;
        takerQuoteFee = (totalQuoteValue * makerOrder.orderFeeConfig.takerFeeBps) / 10_000;

        if (makerOrder.direction == LibDoefinStorage.OrderDirection.Buy) {
            makerQuotePayment = totalQuoteValue + makerQuoteFee;
            takerQuotePayment = totalQuoteValue - takerQuoteFee;
        } else {
            makerQuotePayment = totalQuoteValue - makerQuoteFee;
            takerQuotePayment = totalQuoteValue + takerQuoteFee;
        }
    }

    /**
     * @notice Settle cross-currency trade with buy maker
     * @param settlementExecCtx The settlement context
     * @param quoteCurrencyToken The quote currency token
     * @param makerQuotePayment Maker's quote currency payment
     * @param takerQuotePayment Taker's quote currency payment
     */
    function _settleCrossCurrencyBuyMaker(
        LibDoefinStorage.SettlementExecutionContext memory settlementExecCtx,
        address quoteCurrencyToken,
        uint256 makerQuotePayment,
        uint256 takerQuotePayment
    ) private {
        uint256 fillAmount = settlementExecCtx.fillableAmount;
        LibDoefinStorage.TakerOrderContext memory takerOrder = settlementExecCtx.takerOrder;
        LibDoefinStorage.Order memory makerOrder = settlementExecCtx.makerOrder;

        // Handle quote currency transfers based on execution type
        if (settlementExecCtx.executionType == LibDoefinStorage.ExecutionType.Market) {
            // Market order: Direct transfers
            LibReentrancyGuard._nonReentrantBefore();
            // Maker (buyer) pays quote currency directly
            uint256 makerAllowance = IERC20(quoteCurrencyToken).allowance(makerOrder.maker, address(this));
            if (makerAllowance < makerQuotePayment) {
                revert Errors.InsufficientERC20Allowance(makerOrder.maker, quoteCurrencyToken, makerQuotePayment, makerAllowance);
            }
            IERC20(quoteCurrencyToken).safeTransferFrom(makerOrder.maker, address(this), makerQuotePayment);
            // Taker (seller) receives quote currency
            IERC20(quoteCurrencyToken).safeTransfer(takerOrder.taker, takerQuotePayment);
            LibReentrancyGuard._nonReentrantAfter();
        } else {
            // Limit order: For cross-currency buy orders, the locked collateral is actually the quote currency
            // (even though makerOrder.collateralToken points to a different token)
            LibCollateralManager.consumeERC20Collateral(makerOrder.maker, quoteCurrencyToken, makerQuotePayment);
            // Taker (seller) receives quote currency
            LibReentrancyGuard._nonReentrantBefore();
            IERC20(quoteCurrencyToken).safeTransfer(takerOrder.taker, takerQuotePayment);
            LibReentrancyGuard._nonReentrantAfter();
        }

        // Transfer position tokens from taker to maker
        if (settlementExecCtx.executionType == LibDoefinStorage.ExecutionType.Market) {
            LibERC1155.safeTransferFrom(address(this), takerOrder.taker, makerOrder.maker, makerOrder.positionId, fillAmount, "");
        } else {
            LibCollateralManager.consumeERC1155Collateral(takerOrder.taker, makerOrder.positionId, fillAmount);
            LibERC1155._mint(makerOrder.maker, makerOrder.positionId, fillAmount, "");
        }
    }

    /**
     * @notice Settle cross-currency trade with sell maker
     * @param settlementExecCtx The settlement context
     * @param quoteCurrencyToken The quote currency token
     * @param makerQuotePayment Maker's quote currency payment
     * @param takerQuotePayment Taker's quote currency payment
     */
    function _settleCrossCurrencySellMaker(
        LibDoefinStorage.SettlementExecutionContext memory settlementExecCtx,
        address quoteCurrencyToken,
        uint256 makerQuotePayment,
        uint256 takerQuotePayment
    ) private {
        uint256 fillAmount = settlementExecCtx.fillableAmount;
        LibDoefinStorage.TakerOrderContext memory takerOrder = settlementExecCtx.takerOrder;
        LibDoefinStorage.Order memory makerOrder = settlementExecCtx.makerOrder;

        // Transfer position tokens from maker to taker
        if (settlementExecCtx.executionType == LibDoefinStorage.ExecutionType.Market) {
            LibERC1155.safeTransferFrom(address(this), makerOrder.maker, takerOrder.taker, makerOrder.positionId, fillAmount, "");
        } else {
            LibCollateralManager.consumeERC1155Collateral(makerOrder.maker, makerOrder.positionId, fillAmount);
            LibERC1155._mint(takerOrder.taker, makerOrder.positionId, fillAmount, "");
        }

        // Handle quote currency transfers based on execution type
        if (settlementExecCtx.executionType == LibDoefinStorage.ExecutionType.Market) {
            // Market order: Direct transfers
            LibReentrancyGuard._nonReentrantBefore();
            // Taker (buyer) pays quote currency directly
            uint256 takerAllowance = IERC20(quoteCurrencyToken).allowance(takerOrder.taker, address(this));
            if (takerAllowance < takerQuotePayment) {
                revert Errors.InsufficientERC20Allowance(takerOrder.taker, quoteCurrencyToken, takerQuotePayment, takerAllowance);
            }
            IERC20(quoteCurrencyToken).safeTransferFrom(takerOrder.taker, address(this), takerQuotePayment);
            // Maker (seller) receives quote currency
            IERC20(quoteCurrencyToken).safeTransfer(makerOrder.maker, makerQuotePayment);
            LibReentrancyGuard._nonReentrantAfter();
        } else {
            // Limit order: For cross-currency orders, taker buy orders lock quote currency as collateral
            LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
            LibDoefinStorage.Order storage takerOrderStorage = ds.orderbookStorage.orders[takerOrder.orderId];

            // Determine if external transfer is needed
            bool needsExternalTransfer = false;

            // For cross-currency buy orders (taker buying from sell maker), the locked collateral is quote currency
            if (
                takerOrderStorage.orderType == LibDoefinStorage.OrderType.CrossCurrency &&
                takerOrderStorage.direction == LibDoefinStorage.OrderDirection.Buy
            ) {
                // Cross-currency buy order - locked collateral is quote currency (storage-only operation)
                LibCollateralManager.consumeERC20Collateral(takerOrder.taker, quoteCurrencyToken, takerQuotePayment);
            } else if (takerOrderStorage.collateralToken == quoteCurrencyToken) {
                // Standard order with same currency - use locked collateral (storage-only operation)
                LibCollateralManager.consumeERC20Collateral(takerOrder.taker, quoteCurrencyToken, takerQuotePayment);
            } else {
                // Different currency - will need external transfer from taker's free balance
                needsExternalTransfer = true;
            }

            // Single reentrancy guard for all external ERC20 calls
            LibReentrancyGuard._nonReentrantBefore();

            if (needsExternalTransfer) {
                // Taker pays from free balance
                uint256 takerAllowance = IERC20(quoteCurrencyToken).allowance(takerOrder.taker, address(this));
                if (takerAllowance < takerQuotePayment) {
                    revert Errors.InsufficientERC20Allowance(takerOrder.taker, quoteCurrencyToken, takerQuotePayment, takerAllowance);
                }
                IERC20(quoteCurrencyToken).safeTransferFrom(takerOrder.taker, address(this), takerQuotePayment);
            }

            // Maker (seller) receives quote currency (always external call)
            IERC20(quoteCurrencyToken).safeTransfer(makerOrder.maker, makerQuotePayment);

            LibReentrancyGuard._nonReentrantAfter();
        }
    }
}
