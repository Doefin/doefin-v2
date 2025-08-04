// SPDX-License-Identifier: AGPL-3.0
// Uses shared storage derived from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {LibEscrowLogic} from "./LibEscrowLogic.sol";
import {LibPositionRegistry} from "./LibPositionRegistry.sol";
import {LibMatchEngine} from "./LibMatchEngine.sol";
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
}
