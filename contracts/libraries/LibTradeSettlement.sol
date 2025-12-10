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
            uint256 allowance = IERC20(collateralToken).allowance(settlementExecCtx.takerOrder.maker, address(this));
            if (allowance < takerTotalPayment) {
                revert Errors.InsufficientERC20Allowance(settlementExecCtx.takerOrder.maker, collateralToken, takerTotalPayment, allowance);
            }
            // Collect taker's ERC20 contribution
            IERC20(collateralToken).safeTransferFrom(settlementExecCtx.takerOrder.maker, address(this), takerTotalPayment);
        } else {
            // If it's a limit order check for refund, and consume from the taker's locked collateral
            _manageRefund(settlementExecCtx);

            // Consume the rest to pay for mint operation
            LibCollateralManager.consumeERC20Collateral(settlementExecCtx.takerOrder.maker, collateralToken, takerContribution + takerFee);
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
            // Receive taker's ERC1155 tokens
            LibERC1155.safeTransferFrom(
                address(this),
                settlementExecCtx.takerOrder.maker,
                address(this),
                settlementExecCtx.takerOrder.positionId,
                settlementExecCtx.fillableAmount,
                ""
            );
        } else {
            // If it's limit order, It should consume from taker's collateral
            LibCollateralManager.consumeERC1155Collateral(
                settlementExecCtx.takerOrder.maker,
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

        IERC20(collateralToken).safeTransfer(settlementExecCtx.takerOrder.maker, takerReceives);

        if (settlementExecCtx.executionType == LibDoefinStorage.ExecutionType.Market) {
            // Transfer position tokens directly from taker to maker
            LibERC1155.safeTransferFrom(
                address(this),
                settlementExecCtx.takerOrder.maker,
                settlementExecCtx.makerOrder.maker,
                settlementExecCtx.makerOrder.positionId,
                settlementExecCtx.fillableAmount,
                ""
            );
        } else {
            // Consume taker's ERC1155 tokens
            LibCollateralManager.consumeERC1155Collateral(
                settlementExecCtx.takerOrder.maker,
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
    }

    function _manageRefund(LibDoefinStorage.SettlementExecutionContext memory settlementExecCtx) internal {
        uint256 takerFeePaid = (settlementExecCtx.takerOrder.makerFeeBps * settlementExecCtx.takerOrder.pricePerToken) / 10_000;
        uint256 takerPaidPerToken = settlementExecCtx.takerOrder.pricePerToken + takerFeePaid;

        uint256 tradeEffectivePricePerToken = LibMatchEngine.effectiveTakerPrice(
            settlementExecCtx.makerOrder,
            settlementExecCtx.takerOrder.direction,
            settlementExecCtx.matchType
        );

        LibCollateralManager.refundSurplus(
            takerPaidPerToken,
            tradeEffectivePricePerToken,
            settlementExecCtx.fillableAmount,
            settlementExecCtx.takerOrder.maker,
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

            uint256 currentAllowance = IERC20(collateralToken).allowance(settlementExecCtx.takerOrder.maker, address(this));
            if (currentAllowance < totalTakerPayment) {
                revert Errors.InsufficientERC20Allowance(settlementExecCtx.takerOrder.maker, collateralToken, totalTakerPayment, currentAllowance);
            }
            IERC20(collateralToken).safeTransferFrom(settlementExecCtx.takerOrder.maker, address(this), totalTakerPayment);
        } else {
            // Check for refund and consume from taker's locked collateral
            _manageRefund(settlementExecCtx);
            // Consume the rest to pay for maker
            LibCollateralManager.consumeERC20Collateral(settlementExecCtx.takerOrder.maker, collateralToken, cost + takerFee);
        }

        IERC20(collateralToken).safeTransfer(settlementExecCtx.makerOrder.maker, makerReceives);

        LibERC1155.safeTransferFrom(
            address(this),
            address(this),
            settlementExecCtx.takerOrder.maker,
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
            settlementExecCtx.takerOrder.maker,
            settlementExecCtx.takerOrder.positionId,
            settlementExecCtx.fillableAmount,
            ""
        );
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

        // Distribute ERC20 collateral to both parties
        if (makerReceives > 0) {
            IERC20(collateralToken).safeTransfer(settlementExecCtx.makerOrder.maker, makerReceives);
        }

        if (takerReceives > 0) {
            IERC20(collateralToken).safeTransfer(settlementExecCtx.takerOrder.maker, takerReceives);
        }
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
        if (settlementExecCtx.matchType != LibDoefinStorage.MatchType.Complementary) {
            revert Errors.NonComplementaryCrossCurrencyMatch();
        }

        LibDoefinStorage.Order memory makerOrder = settlementExecCtx.makerOrder;
        LibDoefinStorage.Order memory takerOrder = settlementExecCtx.takerOrder;
        uint256 fillAmount = settlementExecCtx.fillableAmount;
        address quoteCurrencyToken = makerOrder.quoteCurrencyToken;
        address collateralToken = makerOrder.collateralToken;

        bool useOracleRate = (makerOrder.exchangeRateType == LibDoefinStorage.ExchangeRateType.Dynamic);
        uint256 exchangeRate;

        if (useOracleRate) {
            (uint256 oracleRate, bool isStale) = LibQuoteCurrency.getOracleExchangeRate(quoteCurrencyToken, collateralToken);
            if (isStale) revert Errors.OraclePriceStale();
            exchangeRate = oracleRate;
        } else {
            exchangeRate = makerOrder.exchangeRate;
        }

        (uint256 makerQuoteFee, uint256 takerQuoteFee, uint256 makerQuotePayment, uint256 takerQuotePayment) = _computeCrossCurrencyFees(
            makerOrder,
            fillAmount,
            exchangeRate
        );
        LibDoefinStorage.ExecutionType executionType = settlementExecCtx.executionType;
        if (makerOrder.direction == LibDoefinStorage.OrderDirection.Buy) {
            _settleCrossCurrencyBuyMaker(makerOrder, takerOrder, fillAmount, executionType, quoteCurrencyToken, makerQuotePayment, takerQuotePayment);
        } else {
            _settleCrossCurrencySellMaker(
                makerOrder,
                takerOrder,
                fillAmount,
                executionType,
                quoteCurrencyToken,
                makerQuotePayment,
                takerQuotePayment
            );
        }
        LibFeeManager.accrueFees(makerQuoteFee, takerQuoteFee, settlementExecCtx);
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

        if (collateralUnitPerPair == 0) revert Errors.InvalidUnitPerPair();

        uint256 collateralValue = (fillAmount * makerOrder.pricePerToken) / collateralUnitPerPair;
        uint256 totalQuoteValue = (collateralValue * exchangeRate) / 1e18;

        makerQuoteFee = (totalQuoteValue * makerOrder.makerFeeBps) / 10_000;
        takerQuoteFee = (totalQuoteValue * makerOrder.takerFeeBps) / 10_000;

        if (makerOrder.direction == LibDoefinStorage.OrderDirection.Buy) {
            makerQuotePayment = totalQuoteValue + makerQuoteFee;
            takerQuotePayment = totalQuoteValue - takerQuoteFee;
        } else {
            makerQuotePayment = totalQuoteValue - makerQuoteFee;
            takerQuotePayment = totalQuoteValue + takerQuoteFee;
        }
    }

    function _settleCrossCurrencyBuyMaker(
        LibDoefinStorage.Order memory makerOrder,
        LibDoefinStorage.Order memory takerOrder,
        uint256 fillAmount,
        LibDoefinStorage.ExecutionType executionType,
        address quoteCurrencyToken,
        uint256 makerQuotePayment,
        uint256 takerQuotePayment
    ) private {
        // Handle quote currency transfers based on execution type
        if (executionType == LibDoefinStorage.ExecutionType.Market) {
            // Market order: Direct transfers
            // Maker (buyer) pays quote currency directly
            uint256 makerAllowance = IERC20(quoteCurrencyToken).allowance(makerOrder.maker, address(this));
            if (makerAllowance < makerQuotePayment) {
                revert Errors.InsufficientERC20Allowance(makerOrder.maker, quoteCurrencyToken, makerQuotePayment, makerAllowance);
            }
            IERC20(quoteCurrencyToken).safeTransferFrom(makerOrder.maker, address(this), makerQuotePayment);
            // Taker (seller) receives quote currency
            IERC20(quoteCurrencyToken).safeTransfer(takerOrder.maker, takerQuotePayment);
        } else {
            // Limit order: For cross-currency buy orders, the locked collateral is actually the quote currency
            // (even though makerOrder.collateralToken points to a different token)
            LibCollateralManager.consumeERC20Collateral(makerOrder.maker, quoteCurrencyToken, makerQuotePayment);
            // Taker (seller) receives quote currency
            IERC20(quoteCurrencyToken).safeTransfer(takerOrder.maker, takerQuotePayment);
        }

        // Transfer position tokens from taker to maker
        if (executionType == LibDoefinStorage.ExecutionType.Market) {
            LibERC1155.safeTransferFrom(address(this), takerOrder.maker, makerOrder.maker, makerOrder.positionId, fillAmount, "");
        } else {
            LibCollateralManager.consumeERC1155Collateral(takerOrder.maker, makerOrder.positionId, fillAmount);
            LibERC1155.safeTransferFrom(address(this), address(this), makerOrder.maker, makerOrder.positionId, fillAmount, "");
        }
    }

    function _settleCrossCurrencySellMaker(
        LibDoefinStorage.Order memory makerOrder,
        LibDoefinStorage.Order memory takerOrder,
        uint256 fillAmount,
        LibDoefinStorage.ExecutionType executionType,
        address quoteCurrencyToken,
        uint256 makerQuotePayment,
        uint256 takerQuotePayment
    ) private {
        // Transfer position tokens from maker to taker
        if (executionType == LibDoefinStorage.ExecutionType.Market) {
            LibERC1155.safeTransferFrom(address(this), makerOrder.maker, takerOrder.maker, makerOrder.positionId, fillAmount, "");
        } else {
            LibCollateralManager.consumeERC1155Collateral(makerOrder.maker, makerOrder.positionId, fillAmount);
            LibERC1155.safeTransferFrom(address(this), address(this), takerOrder.maker, makerOrder.positionId, fillAmount, "");
        }

        // Handle quote currency transfers based on execution type
        if (executionType == LibDoefinStorage.ExecutionType.Market) {
            // Market order: Direct transfers
            uint256 takerAllowance = IERC20(quoteCurrencyToken).allowance(takerOrder.maker, address(this));
            if (takerAllowance < takerQuotePayment) {
                revert Errors.InsufficientERC20Allowance(takerOrder.maker, quoteCurrencyToken, takerQuotePayment, takerAllowance);
            }
            IERC20(quoteCurrencyToken).safeTransferFrom(takerOrder.maker, address(this), takerQuotePayment);
            IERC20(quoteCurrencyToken).safeTransfer(makerOrder.maker, makerQuotePayment);
        } else {
            // Limit order: Determine payment source
            bool needsExternalTransfer = false;

            if (takerOrder.orderType == LibDoefinStorage.OrderType.CrossCurrency && takerOrder.direction == LibDoefinStorage.OrderDirection.Buy) {
                LibCollateralManager.consumeERC20Collateral(takerOrder.maker, quoteCurrencyToken, takerQuotePayment);
            } else if (takerOrder.collateralToken == quoteCurrencyToken) {
                LibCollateralManager.consumeERC20Collateral(takerOrder.maker, quoteCurrencyToken, takerQuotePayment);
            } else {
                needsExternalTransfer = true;
            }

            if (needsExternalTransfer) {
                uint256 takerAllowance = IERC20(quoteCurrencyToken).allowance(takerOrder.maker, address(this));
                if (takerAllowance < takerQuotePayment) {
                    revert Errors.InsufficientERC20Allowance(takerOrder.maker, quoteCurrencyToken, takerQuotePayment, takerAllowance);
                }
                IERC20(quoteCurrencyToken).safeTransferFrom(takerOrder.maker, address(this), takerQuotePayment);
            }

            IERC20(quoteCurrencyToken).safeTransfer(makerOrder.maker, makerQuotePayment);
        }
    }
}
