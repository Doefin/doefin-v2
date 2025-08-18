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

            if (!makerOrder.active) revert Errors.OrderNotActive();

            if (matchExec.matchType == LibDoefinStorage.MatchType.Complementary) {
                if (makerOrder.positionId != takerOrder.positionId) revert Errors.PositionIdMismatch();
                if (makerOrder.direction == takerOrder.direction) revert Errors.SameDirectionForComplementary();
            } else {
                if (makerOrder.direction != takerOrder.direction) revert Errors.DifferentOrderDirectionForNonComplementary();
                LibPositionRegistry.validateComplement(takerOrder.positionId, makerOrder.positionId);
            }

            uint256 effectivePrice = LibMatchEngine.effectiveTakerPrice(makerOrder, takerOrder.direction, matchExec.matchType);

            uint256 availableAmount = takerOrder.remainingAmount > makerOrder.remainingAmount
                ? makerOrder.remainingAmount
                : takerOrder.remainingAmount;

            uint256 fillableAmount = availableAmount;

            if (takerOrder.targetAvgPrice != 0) {
                uint256 affordableAmount = computeMaxFillableAtPrice(takerOrder, totalValue, effectivePrice, collateralUnit);

                fillableAmount = affordableAmount > availableAmount ? availableAmount : affordableAmount;
            }

            if (fillableAmount == 0) {
                continue;
            }

            // Update maker order
            makerOrder.remainingAmount -= fillableAmount;
            if (makerOrder.remainingAmount == 0) {
                makerOrder.active = false;
            }

            // Update filled/cost accounting
            takerOrder.remainingAmount -= fillableAmount;
            totalValue += (fillableAmount * effectivePrice) / collateralUnit;

            // Create context for execution
            LibDoefinStorage.SettlementExecutionContext memory settlementExecCtx = LibDoefinStorage.SettlementExecutionContext({
                fillableAmount: fillableAmount,
                takerOrder: takerOrder,
                makerOrder: makerOrder,
                matchType: matchExec.matchType,
                executionType: LibDoefinStorage.ExecutionType.Market
            });

            LibTradeSettlement.settlementDispatcher(settlementExecCtx);
            emit Events.MarketOrderMatch(takerOrder.taker, makerOrder.orderId, makerOrder.maker, fillableAmount, effectivePrice, matchExec.matchType);
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

    /// Computes the maximum fillable amount for a limit order at a specific price.
    /// @param takerOrder The limit order to evaluate.
    /// @param totalValue The total value of the order.
    /// @param currentPrice The current market price.
    /// @param collateralUnit The collateral unit used for calculations.
    /// @dev Kept computeMaxFillableAtPrice for testing and debugging purposes
    function computeMaxFillableAtPriceForLimitOrder(
        LibDoefinStorage.Order memory takerOrder,
        uint256 totalValue,
        uint256 currentPrice,
        uint256 collateralUnit
    ) internal pure returns (uint256 maxFillable) {
        bool isBuy = takerOrder.direction == LibDoefinStorage.OrderDirection.Buy;

        if ((isBuy && currentPrice <= takerOrder.pricePerToken) || (!isBuy && currentPrice >= takerOrder.pricePerToken)) {
            // No constraint violation at this price — can take all available
            return type(uint256).max;
        }

        uint256 totalFilledTokens = takerOrder.amount - takerOrder.remainingAmount;

        // Calculate numerator and denominator in fixed-point (collateralUnit)

        uint256 numerator;
        uint256 denominator;

        if (isBuy) {
            numerator = takerOrder.pricePerToken * totalFilledTokens - totalValue;
            denominator = currentPrice - takerOrder.pricePerToken;
        } else {
            numerator = takerOrder.pricePerToken * totalFilledTokens - totalValue;
            denominator = takerOrder.pricePerToken - currentPrice;
        }

        // If denominator == 0 or numerator overflows, return 0 fillable
        if (denominator == 0 || numerator > type(uint256).max / collateralUnit) {
            return 0;
        }

        // Since all values are scaled to collateralUnit, rescale numerator
        maxFillable = numerator / denominator;
    }

    function computeMaxFillableAtPrice(
        LibDoefinStorage.TakerOrderContext memory takerOrder,
        uint256 totalValue,
        uint256 currentPrice,
        uint256 collateralUnit
    ) internal pure returns (uint256 maxFillable) {
        bool isBuy = takerOrder.direction == LibDoefinStorage.OrderDirection.Buy;

        if ((isBuy && currentPrice <= takerOrder.targetAvgPrice) || (!isBuy && currentPrice >= takerOrder.targetAvgPrice)) {
            // No constraint violation at this price — can take all available
            return type(uint256).max;
        }

        uint256 totalFilledTokens = takerOrder.amount - takerOrder.remainingAmount;

        // Calculate numerator and denominator in fixed-point (collateralUnit)

        uint256 numerator;
        uint256 denominator;

        if (isBuy) {
            numerator = takerOrder.targetAvgPrice * totalFilledTokens - totalValue;
            denominator = currentPrice - takerOrder.targetAvgPrice;
        } else {
            numerator = takerOrder.targetAvgPrice * totalFilledTokens - totalValue;
            denominator = takerOrder.targetAvgPrice - currentPrice;
        }

        // If denominator == 0 or numerator overflows, return 0 fillable
        if (denominator == 0 || numerator > type(uint256).max / collateralUnit) {
            return 0;
        }

        // Since all values are scaled to collateralUnit, rescale numerator
        maxFillable = numerator / denominator;
    }

    function fillLimitOrders(uint256 takerId, uint256[] memory makerIds) internal {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        LibDoefinStorage.Order storage takerOrder = ds.orderbookStorage.orders[takerId];

        if (!takerOrder.active) revert Errors.OrderNotActive();
        if (takerOrder.expiry != 0 && block.timestamp >= takerOrder.expiry) revert Errors.OrderExpired();

        uint256 totalValue = 0;

        for (uint256 i = 0; i < makerIds.length && takerOrder.remainingAmount > 0; i++) {
            LibDoefinStorage.Order storage makerOrder = ds.orderbookStorage.orders[makerIds[i]];

            if (!makerOrder.active) revert Errors.OrderNotActive();
            if (makerOrder.expiry != 0 && block.timestamp >= makerOrder.expiry) revert Errors.OrderExpired();

            (bool crossing, LibDoefinStorage.MatchType matchType, uint256 price) = _isCrossing(takerOrder, makerOrder);
            if (!crossing) revert Errors.NotCrossingPrices();

            uint256 fillAmount = _min(takerOrder.remainingAmount, makerOrder.remainingAmount);
            if (takerOrder.executionType == LibDoefinStorage.ExecutionType.Market) {
                // Market execution logic - to respect the average price
                uint256 collateralUnit = ds.adminConfigStorage.unitPerPair[makerOrder.collateralToken];

                uint256 affordableAmount = computeMaxFillableAtPriceForLimitOrder(takerOrder, totalValue, price, collateralUnit);
                fillAmount = _min(affordableAmount, fillAmount);
                totalValue += (fillAmount * price) / collateralUnit;
            }

            if (fillAmount == 0 || (fillAmount < takerOrder.minFillAmount && takerOrder.remainingAmount == takerOrder.amount) || (fillAmount < makerOrder.minFillAmount && makerOrder.remainingAmount == makerOrder.amount)) {
                continue; // TODO: Move it to the LibMatch Engine to check for the minFillAmount
            }

            takerOrder.remainingAmount -= fillAmount;
            makerOrder.remainingAmount -= fillAmount;  

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

            LibDoefinStorage.SettlementExecutionContext memory settlementExecCtx = LibDoefinStorage.SettlementExecutionContext({
                fillableAmount: fillAmount,
                takerOrder: takerCtx,
                makerOrder: makerOrder,
                matchType: matchType,
                executionType: takerOrder.executionType
            });

            LibTradeSettlement.settlementDispatcher(settlementExecCtx);

            if (takerOrder.remainingAmount == 0) {
                takerOrder.active = false;
                LibOrderbook.removeOrderFromOrderbook(takerOrder);
                emit Events.OrderCompletelyFilled(takerOrder.orderId, takerOrder.maker, makerOrder.maker, takerOrder.amount, price);
            } else {
                emit Events.OrderPartiallyFilled(
                    takerOrder.orderId,
                    takerOrder.maker,
                    makerOrder.maker,
                    fillAmount,
                    takerOrder.remainingAmount,
                    price
                );
            }

            if (makerOrder.remainingAmount == 0) {
                makerOrder.active = false;
                LibOrderbook.removeOrderFromOrderbook(makerOrder);
                emit Events.OrderCompletelyFilled(makerOrder.orderId, makerOrder.maker, takerOrder.maker, makerOrder.amount, price);
            } else {
                emit Events.OrderPartiallyFilled(
                    makerOrder.orderId,
                    makerOrder.maker,
                    takerOrder.maker,
                    fillAmount,
                    makerOrder.remainingAmount,
                    price
                );
            }

            if (takerOrder.remainingAmount == 0) {
                break;
            }
        }
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function _isCrossing(LibDoefinStorage.Order storage takerOrder, LibDoefinStorage.Order storage makerOrder)
        internal
        view
        returns (
            bool crossing,
            LibDoefinStorage.MatchType matchType,
            uint256 price
        )
    {
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
}
