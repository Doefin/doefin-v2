// SPDX-License-Identifier: AGPL-3.0
// Uses shared storage derived from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {LibPositionRegistry} from "./LibPositionRegistry.sol";
import {LibMatchEngine} from "./LibMatchEngine.sol";
import {LibOrderbook} from "./LibOrderbook.sol";
import {LibTradeSettlement} from "./LibTradeSettlement.sol";
import {LibQuoteCurrency} from "./LibQuoteCurrency.sol";
import {LibCrossCurrencySettlement} from "./LibCrossCurrencySettlement.sol";
import {Errors} from "./Errors.sol";
import {Events} from "./Events.sol";

library LibSettlement {
    /**
     * @notice Fill orders against maker orders (for ExchangeFacet via LibOrderbook)
     */
    function fillOrders(uint256 takerId, uint256[] memory makerIds) internal {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        LibDoefinStorage.Order storage takerOrderStorage = ds.orderbookStorage.orders[takerId];
        _validateOrder(takerOrderStorage);

        // Copy to memory for execution
        LibDoefinStorage.Order memory takerOrder = takerOrderStorage;

        // Execute matches in single pass
        _executeMatches(takerOrder, makerIds);
        _updateStoredTakerOrder(takerId, takerOrder);
    }

    // ========================================
    // INTERNAL EXECUTION ENGINE
    // ========================================

    /**
     * @notice Unified execution engine for both market and limit orders
     */
    function _executeMatches(LibDoefinStorage.Order memory takerOrder, uint256[] memory makerIds) internal {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        uint256 totalValue = 0;
        uint256 totalFilledSoFar = 0;

        for (uint256 i = 0; i < makerIds.length && takerOrder.remainingAmount > 0; ++i) {
            LibDoefinStorage.Order storage makerOrder = ds.orderbookStorage.orders[makerIds[i]];
            _validateOrder(makerOrder);

            // Validate crossing and get effective price
            (bool crossing, LibDoefinStorage.MatchType matchType, uint256 effectivePrice) = _isCrossing(takerOrder, makerOrder);

            if (!crossing) continue;

            // Calculate fillable amount
            uint256 fillAmount = _min(takerOrder.remainingAmount, makerOrder.remainingAmount);
            if (fillAmount == 0) continue;

            uint256 collateralUnit = ds.adminConfigStorage.unitPerPair[makerOrder.collateralToken];

            // Apply market order affordability constraints
            if (takerOrder.executionType == LibDoefinStorage.ExecutionType.Market && totalFilledSoFar > 0) {
                uint256 affordableAmount = _computeMaxFillableAtPrice(
                    takerOrder.pricePerToken,
                    totalValue,
                    effectivePrice,
                    collateralUnit,
                    totalFilledSoFar,
                    takerOrder.direction == LibDoefinStorage.OrderDirection.Buy
                );
                fillAmount = _min(affordableAmount, fillAmount);
            }

            // Check minimum fill amounts
            if (
                fillAmount == 0 ||
                (fillAmount < takerOrder.minFillAmount && totalFilledSoFar == 0) ||
                (fillAmount < makerOrder.minFillAmount && makerOrder.remainingAmount == makerOrder.amount)
            ) {
                continue;
            }

            // Update states
            takerOrder.remainingAmount -= fillAmount;
            totalFilledSoFar += fillAmount;
            totalValue += (fillAmount * effectivePrice) / collateralUnit;

            _updateOrderAfterFill(makerOrder, takerOrder, fillAmount, effectivePrice, matchType);

            // Execute settlement - convert to context for backward compatibility
            LibTradeSettlement.settlementDispatcher(
                LibDoefinStorage.SettlementExecutionContext({
                    fillableAmount: fillAmount,
                    takerOrder: _orderToContext(takerOrder),
                    makerOrder: makerOrder,
                    matchType: matchType,
                    executionType: takerOrder.executionType
                })
            );
        }

        // Handle market order completion
        if (takerOrder.executionType == LibDoefinStorage.ExecutionType.Market) {
            if (takerOrder.fillOrKill && takerOrder.remainingAmount > 0) {
                revert Errors.FillOrKillFailed();
            }
        }
    }

    /**
     * @notice Update stored taker order state after execution
     */
    function _updateStoredTakerOrder(uint256 takerId, LibDoefinStorage.Order memory takerOrder) internal {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        LibDoefinStorage.Order storage takerOrderStorage = ds.orderbookStorage.orders[takerId];

        uint256 filledAmount = takerOrderStorage.remainingAmount - takerOrder.remainingAmount;
        if (filledAmount == 0) return;

        takerOrderStorage.remainingAmount = takerOrder.remainingAmount;

        if (takerOrderStorage.remainingAmount == 0) {
            takerOrderStorage.active = false;
            LibOrderbook.removeOrderFromOrderbook(takerOrderStorage);
        }
    }

    // ========================================
    // HELPER FUNCTIONS
    // ========================================

    function _validateOrder(LibDoefinStorage.Order storage order) internal view {
        if (!order.active) revert Errors.OrderNotActive();
        if (order.expiry != 0 && block.timestamp >= order.expiry) revert Errors.OrderExpired();
    }

    function _updateOrderAfterFill(
        LibDoefinStorage.Order storage makerOrder,
        LibDoefinStorage.Order memory takerOrder,
        uint256 fillAmount,
        uint256 takerEffectivePrice,
        LibDoefinStorage.MatchType matchType
    ) internal {
        if (fillAmount > makerOrder.remainingAmount) fillAmount = makerOrder.remainingAmount;

        makerOrder.remainingAmount -= fillAmount;
        bool makerComplete = makerOrder.remainingAmount == 0;

        if (makerComplete) {
            makerOrder.active = false;
            LibOrderbook.removeOrderFromOrderbook(makerOrder);
        }

        uint256 makerEffectivePrice = LibMatchEngine.effectiveMakerPrice(makerOrder);

        emit Events.TradeFilled(
            makerOrder.orderId,
            takerOrder.orderId,
            makerOrder.maker,
            takerOrder.maker, // taker is the order maker
            takerOrder.positionId,
            makerOrder.positionId,
            makerOrder.collateralToken,
            fillAmount,
            makerEffectivePrice,
            takerEffectivePrice,
            matchType,
            makerOrder.remainingAmount,
            takerOrder.remainingAmount,
            makerComplete,
            takerOrder.remainingAmount == 0,
            block.timestamp
        );
    }

    function _orderToContext(LibDoefinStorage.Order memory order) internal pure returns (LibDoefinStorage.TakerOrderContext memory) {
        return
            LibDoefinStorage.TakerOrderContext({
                orderId: order.orderId,
                taker: order.maker,
                positionId: order.positionId,
                amount: order.amount,
                remainingAmount: order.remainingAmount,
                targetAvgPrice: order.pricePerToken,
                takerPaidFeeBps: order.makerFeeBps,
                fillOrKill: order.fillOrKill,
                direction: order.direction
            });
    }

    function _isCrossing(
        LibDoefinStorage.Order memory takerOrder,
        LibDoefinStorage.Order storage makerOrder
    ) internal view returns (bool crossing, LibDoefinStorage.MatchType matchType, uint256 price) {
        // Cross-currency orders validation
        if (LibCrossCurrencySettlement.isCrossCurrencyTrade(takerOrder.orderId, makerOrder.orderId)) {
            return LibCrossCurrencySettlement.validateCrossCurrencyMatch(takerOrder, makerOrder);
        }

        // Standard order logic
        if (takerOrder.direction != makerOrder.direction) {
            if (takerOrder.positionId != makerOrder.positionId) {
                return (false, LibDoefinStorage.MatchType.Complementary, 0);
            }
            matchType = LibDoefinStorage.MatchType.Complementary;
        } else {
            LibPositionRegistry.validateComplement(takerOrder.positionId, makerOrder.positionId);
            matchType = takerOrder.direction == LibDoefinStorage.OrderDirection.Buy
                ? LibDoefinStorage.MatchType.Mint
                : LibDoefinStorage.MatchType.Merge;
        }

        price = LibMatchEngine.effectiveTakerPrice(makerOrder, takerOrder.direction, matchType);

        if (takerOrder.executionType == LibDoefinStorage.ExecutionType.Market) {
            crossing = true;
        } else {
            crossing = takerOrder.direction == LibDoefinStorage.OrderDirection.Buy
                ? takerOrder.pricePerToken >= price
                : takerOrder.pricePerToken <= price;
        }
    }

    function _computeMaxFillableAtPrice(
        uint256 referencePrice,
        uint256 totalValue,
        uint256 currentPrice,
        uint256 collateralUnit,
        uint256 totalFilledTokens,
        bool isBuy
    ) internal pure returns (uint256) {
        if ((isBuy && currentPrice <= referencePrice) || (!isBuy && currentPrice >= referencePrice)) {
            return type(uint256).max;
        }
        uint256 numerator = referencePrice * totalFilledTokens - totalValue;
        uint256 denominator = isBuy ? (currentPrice - referencePrice) : (referencePrice - currentPrice);
        if (denominator == 0 || numerator > type(uint256).max / collateralUnit) return 0;
        return numerator / denominator;
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
