// SPDX-License-Identifier: AGPL-3.0
// Uses shared storage derived from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {LibPositionRegistry} from "./LibPositionRegistry.sol";
import {LibMatchEngine} from "./LibMatchEngine.sol";
import {LibOrderbook} from "./LibOrderbook.sol";
import {LibTradeSettlement} from "./LibTradeSettlement.sol";
import {Errors} from "./Errors.sol";
import {Events} from "./Events.sol";

library LibSettlement {
    function executeMatchedRoute(LibDoefinStorage.TakerOrderContext memory takerOrder, LibDoefinStorage.MatchExecution[] calldata matches) internal {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        uint256 totalValue = 0;
        for (uint256 i = 0; i < matches.length && takerOrder.remainingAmount > 0; ++i) {
            LibDoefinStorage.MatchExecution calldata matchExec = matches[i];
            LibDoefinStorage.Order storage makerOrder = ds.orderbookStorage.orders[matchExec.matchedOrderId];
            uint256 collateralUnit = ds.adminConfigStorage.unitPerPair[makerOrder.collateralToken];
            _validateOrder(makerOrder);

            (bool crossing, LibDoefinStorage.MatchType matchType, uint256 effectivePrice) = _isCrossing(
                takerOrder.direction,
                takerOrder.positionId,
                takerOrder.targetAvgPrice != 0 ? takerOrder.targetAvgPrice : 0,
                LibDoefinStorage.ExecutionType.Market,
                makerOrder
            );
            if (!crossing) revert Errors.NotCrossingPrices();

            uint256 availableAmount = _min(takerOrder.remainingAmount, makerOrder.remainingAmount);
            uint256 fillableAmount = availableAmount;
            if (takerOrder.targetAvgPrice != 0) {
                uint256 affordableAmount = _computeMaxFillableAtPrice(
                    takerOrder.targetAvgPrice,
                    totalValue,
                    effectivePrice,
                    collateralUnit,
                    takerOrder.amount - takerOrder.remainingAmount,
                    takerOrder.direction == LibDoefinStorage.OrderDirection.Buy
                );
                fillableAmount = _min(affordableAmount, availableAmount);
            }
            if (fillableAmount == 0) {
                continue;
            }
            takerOrder.remainingAmount -= fillableAmount;
            totalValue += (fillableAmount * effectivePrice) / collateralUnit;
            _updateOrderAfterFill(makerOrder, takerOrder.taker, fillableAmount, effectivePrice);
            LibTradeSettlement.settlementDispatcher(_buildSettlementCtx(
                fillableAmount,
                takerOrder,
                makerOrder,
                matchType,
                LibDoefinStorage.ExecutionType.Market
            ));
            emit Events.MarketOrderMatch(takerOrder.taker, makerOrder.orderId, makerOrder.maker, fillableAmount, effectivePrice, matchType);
        }
        if (takerOrder.fillOrKill && takerOrder.remainingAmount > 0) {
            revert Errors.FillOrKillFailed();
        }
        emit Events.MarketOrderExecuted(
            takerOrder.taker,
            takerOrder.positionId,
            takerOrder.direction,
            takerOrder.amount,
            takerOrder.remainingAmount,
            totalValue
        );
    }

    /**
     * @notice Computes the maximum fillable amount for a taker order at a specific price, respecting average price constraints.
     * @dev Used for both market and limit orders. The formula ensures the average price paid does not exceed the taker's target.
     * @param referencePrice The price constraint (pricePerToken for limit, targetAvgPrice for market).
     * @param totalValue The total value already filled for the order.
     * @param currentPrice The current match price.
     * @param collateralUnit The collateral unit for scaling.
     * @param totalFilledTokens The number of tokens already filled.
     * @param isBuy True if the taker is buying, false if selling.
     * @return maxFillable The maximum amount that can be filled at this price without violating constraints.
     */
    function _computeMaxFillableAtPrice(
        uint256 referencePrice,
        uint256 totalValue,
        uint256 currentPrice,
        uint256 collateralUnit,
        uint256 totalFilledTokens,
        bool isBuy
    ) internal pure returns (uint256 maxFillable) {
        if ((isBuy && currentPrice <= referencePrice) || (!isBuy && currentPrice >= referencePrice)) {
            return type(uint256).max;
        }
        uint256 numerator = referencePrice * totalFilledTokens - totalValue;
        uint256 denominator = isBuy ? (currentPrice - referencePrice) : (referencePrice - currentPrice);
        if (denominator == 0 || numerator > type(uint256).max / collateralUnit) {
            return 0;
        }

        maxFillable = numerator / denominator;
    }

    function computeMaxFillableAtPriceForLimitOrder(
        LibDoefinStorage.Order memory takerOrder,
        uint256 totalValue,
        uint256 currentPrice,
        uint256 collateralUnit
    ) internal pure returns (uint256) {
        return _computeMaxFillableAtPrice(
            takerOrder.pricePerToken,
            totalValue,
            currentPrice,
            collateralUnit,
            takerOrder.amount - takerOrder.remainingAmount,
            takerOrder.direction == LibDoefinStorage.OrderDirection.Buy
        );
    }

    function computeMaxFillableAtPrice(
        LibDoefinStorage.TakerOrderContext memory takerOrder,
        uint256 totalValue,
        uint256 currentPrice,
        uint256 collateralUnit
    ) internal pure returns (uint256) {
        return _computeMaxFillableAtPrice(
            takerOrder.targetAvgPrice,
            totalValue,
            currentPrice,
            collateralUnit,
            takerOrder.amount - takerOrder.remainingAmount,
            takerOrder.direction == LibDoefinStorage.OrderDirection.Buy
        );
    }

    function fillLimitOrders(uint256 takerId, uint256[] memory makerIds) internal {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        LibDoefinStorage.Order storage takerOrder = ds.orderbookStorage.orders[takerId];
        _validateOrder(takerOrder);
        uint256 totalValue = 0;
        for (uint256 i = 0; i < makerIds.length && takerOrder.remainingAmount > 0; i++) {
            LibDoefinStorage.Order storage makerOrder = ds.orderbookStorage.orders[makerIds[i]];
            _validateOrder(makerOrder);
            (bool crossing, LibDoefinStorage.MatchType matchType, uint256 price) = _isCrossing(
                takerOrder.direction,
                takerOrder.positionId,
                takerOrder.pricePerToken,
                takerOrder.executionType,
                makerOrder
            );
            if (!crossing) revert Errors.NotCrossingPrices();
            uint256 fillAmount = _min(takerOrder.remainingAmount, makerOrder.remainingAmount);
            if (takerOrder.executionType == LibDoefinStorage.ExecutionType.Market) {
                uint256 collateralUnit = ds.adminConfigStorage.unitPerPair[makerOrder.collateralToken];
                uint256 affordableAmount = computeMaxFillableAtPriceForLimitOrder(takerOrder, totalValue, price, collateralUnit);
                fillAmount = _min(affordableAmount, fillAmount);
                totalValue += (fillAmount * price) / collateralUnit;
            }
            if (fillAmount == 0 || (fillAmount < takerOrder.minFillAmount && takerOrder.remainingAmount == takerOrder.amount) || (fillAmount < makerOrder.minFillAmount && makerOrder.remainingAmount == makerOrder.amount)) {
                continue;
            }
            LibDoefinStorage.TakerOrderContext memory takerCtx = LibDoefinStorage.TakerOrderContext({
                taker: takerOrder.maker,
                positionId: takerOrder.positionId,
                amount: takerOrder.amount,
                remainingAmount: takerOrder.remainingAmount,
                targetAvgPrice: takerOrder.pricePerToken,
                takerPaidFeeBps: takerOrder.orderFeeConfig.makerFeeBps,
                fillOrKill: false,
                direction: takerOrder.direction
            });
            LibTradeSettlement.settlementDispatcher(_buildSettlementCtx(
                fillAmount,
                takerCtx,
                makerOrder,
                matchType,
                takerOrder.executionType
            ));
            _updateOrderAfterFill(takerOrder, makerOrder.maker, fillAmount, price);
            _updateOrderAfterFill(makerOrder, takerOrder.maker, fillAmount, price);
            if (takerOrder.remainingAmount == 0) {
                break;
            }
        }
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    // Extracted order validation
    function _validateOrder(LibDoefinStorage.Order storage order) internal view {
        if (!order.active) revert Errors.OrderNotActive();
        if (order.expiry != 0 && block.timestamp >= order.expiry) revert Errors.OrderExpired();
    }

    // Extracted order state update and events
    function _updateOrderAfterFill(
        LibDoefinStorage.Order storage order,
        address counterparty,
        uint256 fillAmount,
        uint256 price
    ) internal {
        // Only decrement, do not allow underflow
        if (fillAmount > order.remainingAmount) {
            fillAmount = order.remainingAmount;
        }
        order.remainingAmount -= fillAmount;
        if (order.remainingAmount == 0) {
            order.active = false;
            LibOrderbook.removeOrderFromOrderbook(order);
            emit Events.OrderCompletelyFilled(order.orderId, order.maker, counterparty, order.amount, price);
        } else {
            emit Events.OrderPartiallyFilled(order.orderId, order.maker, counterparty, fillAmount, order.remainingAmount, price);
        }
    }

    // Extracted settlement context creation
    function _buildSettlementCtx(
        uint256 fillableAmount,
        LibDoefinStorage.TakerOrderContext memory takerOrder,
        LibDoefinStorage.Order storage makerOrder,
        LibDoefinStorage.MatchType matchType,
        LibDoefinStorage.ExecutionType executionType
    ) internal pure returns (LibDoefinStorage.SettlementExecutionContext memory) {
        return LibDoefinStorage.SettlementExecutionContext({
            fillableAmount: fillableAmount,
            takerOrder: takerOrder,
            makerOrder: makerOrder,
            matchType: matchType,
            executionType: executionType
        });
    }

    function _isCrossing(
        LibDoefinStorage.OrderDirection takerDirection,
        uint256 takerPositionId,
        uint256 takerPricePerToken,
        LibDoefinStorage.ExecutionType takerExecutionType,
        LibDoefinStorage.Order storage makerOrder
    )
        internal
        view
        returns (
            bool crossing,
            LibDoefinStorage.MatchType matchType,
            uint256 price
        )
    {
        if (takerDirection != makerOrder.direction) {
            if (takerPositionId != makerOrder.positionId) {
                return (false, LibDoefinStorage.MatchType.Complementary, 0);
            }
            matchType = LibDoefinStorage.MatchType.Complementary;
        } else {
            LibPositionRegistry.validateComplement(takerPositionId, makerOrder.positionId);
            matchType = takerDirection == LibDoefinStorage.OrderDirection.Buy
                ? LibDoefinStorage.MatchType.Mint
                : LibDoefinStorage.MatchType.Merge;
        }
        price = LibMatchEngine.effectiveTakerPrice(makerOrder, takerDirection, matchType);
        if (takerExecutionType == LibDoefinStorage.ExecutionType.Market) {
            // Market orders always cross: price checks are bypassed for immediate execution
            crossing = true;
        } else {
            crossing = takerDirection == LibDoefinStorage.OrderDirection.Buy
                ? takerPricePerToken >= price
                : takerPricePerToken <= price;
        }
    }
}
