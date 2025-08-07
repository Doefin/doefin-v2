// SPDX-License-Identifier: AGPL-3.0
// Uses shared storage derived from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {LibEscrowLogic} from "./LibEscrowLogic.sol";
import {LibPositionRegistry} from "./LibPositionRegistry.sol";
import {LibMatchEngine} from "./LibMatchEngine.sol";
import {LibOrderbook} from "../libraries/LibOrderbook.sol";
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

            if(!makerOrder.active) revert Errors.OrderNotActive();

            if (matchExec.matchType == LibDoefinStorage.MatchType.Complementary) {
                if(makerOrder.positionId != takerOrder.positionId) revert Errors.PositionIdMismatch();
                if(makerOrder.direction == takerOrder.direction) revert Errors.SameDirectionForComplementary();
            } else {
                if(makerOrder.direction != takerOrder.direction) revert Errors.DifferentOrderDirectionForNonComplementary();
                LibPositionRegistry.validateComplement(takerOrder.positionId, makerOrder.positionId);
            }

            uint256 effectivePrice = LibMatchEngine.effectiveTakerPrice(makerOrder, takerOrder.direction, matchExec.matchType);

            uint256 availableAmount = takerOrder.remainingAmount > makerOrder.remainingAmount
                ? makerOrder.remainingAmount
                : takerOrder.remainingAmount;

            uint256 fillableAmount = availableAmount;

            if (takerOrder.targetAvgPrice != 0) {
                uint256 afordableAmount = computeMaxFillableAtPrice(takerOrder, totalValue, effectivePrice, collateralUnit);

                fillableAmount = afordableAmount > availableAmount ? availableAmount : afordableAmount;
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
            LibDoefinStorage.SettlemetExecutionContext memory settlementExecCtx = LibDoefinStorage.SettlemetExecutionContext({
                fillableAmount: fillableAmount,
                takerOrder: takerOrder,
                makerOrder: makerOrder,
                matchType: matchExec.matchType
            });

            LibEscrowLogic.settlementDispatcher(settlementExecCtx);
            emit Events.MarketOrderMatch(
                takerOrder.taker,
                makerOrder.orderId,
                makerOrder.maker,
                fillableAmount,
                effectivePrice,
                matchExec.matchType
            );
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

        for (uint256 i = 0; i < makerIds.length && takerOrder.remainingAmount > 0; i++) {
            LibDoefinStorage.Order storage makerOrder = ds.orderbookStorage.orders[makerIds[i]];

            if (!makerOrder.active) revert Errors.OrderNotActive();
            if (makerOrder.expiry != 0 && block.timestamp >= makerOrder.expiry) revert Errors.OrderExpired();

            (bool crossing, LibDoefinStorage.MatchType matchType, uint256 price) =
                _isCrossing(takerOrder, makerOrder);
            if (!crossing) revert Errors.InvalidMatch();

            uint256 fillAmount = takerOrder.remainingAmount < makerOrder.remainingAmount
                ? takerOrder.remainingAmount
                : makerOrder.remainingAmount;

            if (fillAmount < takerOrder.minFillAmount || fillAmount < makerOrder.minFillAmount) {
                revert Errors.InvalidAmounts();
            }

            takerOrder.remainingAmount -= fillAmount;
            makerOrder.remainingAmount -= fillAmount;

            LibDoefinStorage.TakerOrderContext memory takerCtx = LibDoefinStorage.TakerOrderContext({
                taker: takerOrder.maker,
                positionId: takerOrder.positionId,
                amount: takerOrder.amount,
                remainingAmount: takerOrder.remainingAmount,
                targetAvgPrice: takerOrder.pricePerToken,
                fillOrKill: false,
                direction: takerOrder.direction
            });

            LibDoefinStorage.SettlemetExecutionContext memory settlementExecCtx =
                LibDoefinStorage.SettlemetExecutionContext({
                    fillableAmount: fillAmount,
                    takerOrder: takerCtx,
                    makerOrder: makerOrder,
                    matchType: matchType
                });

            LibEscrowLogic.settlementDispatcher(settlementExecCtx);

            if (takerOrder.remainingAmount == 0) {
                takerOrder.active = false;
                LibOrderbook.removeOrderFromOrderbook(takerOrder);
                emit Events.OrderCompletelyFilled(
                    takerOrder.orderId,
                    takerOrder.maker,
                    makerOrder.maker,
                    takerOrder.amount,
                    price
                );
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
                emit Events.OrderCompletelyFilled(
                    makerOrder.orderId,
                    makerOrder.maker,
                    takerOrder.maker,
                    makerOrder.amount,
                    price
                );
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

    function _isCrossing(
        LibDoefinStorage.Order storage takerOrder,
        LibDoefinStorage.Order storage makerOrder
    ) internal view returns (bool crossing, LibDoefinStorage.MatchType matchType, uint256 price) {
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

        crossing = takerOrder.direction == LibDoefinStorage.OrderDirection.Buy
            ? takerOrder.pricePerToken >= price
            : takerOrder.pricePerToken <= price;
    }
}
