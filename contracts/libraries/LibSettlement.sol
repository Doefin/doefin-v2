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
    /**
     * @notice Execute market order using precomputed route (for MarketExecutionFacet)
     */
    function executeMatchedRoute(
        LibDoefinStorage.TakerOrderContext memory takerOrder, 
        LibDoefinStorage.Match[] memory matches
    ) internal {
        _executeMatches(takerOrder, matches, LibDoefinStorage.ExecutionType.Market);
    }

    /**
     * @notice Fill limit orders against maker orders (for ExchangeFacet via LibOrderbook)  
     */
    function fillLimitOrders(uint256 takerId, uint256[] memory makerIds) internal {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        LibDoefinStorage.Order storage takerOrderStorage = ds.orderbookStorage.orders[takerId];
        _validateOrder(takerOrderStorage);

        // Build taker context from stored order
        LibDoefinStorage.TakerOrderContext memory takerCtx = LibDoefinStorage.TakerOrderContext({
            taker: takerOrderStorage.maker,
            positionId: takerOrderStorage.positionId,
            amount: takerOrderStorage.amount,
            remainingAmount: takerOrderStorage.remainingAmount,
            targetAvgPrice: takerOrderStorage.pricePerToken,
            takerPaidFeeBps: takerOrderStorage.orderFeeConfig.makerFeeBps,
            fillOrKill: takerOrderStorage.fillOrKill,
            direction: takerOrderStorage.direction
        });

        // Generate and execute matches
        LibDoefinStorage.Match[] memory matches = _generateMatches(takerCtx, takerOrderStorage, makerIds);
        _executeMatches(takerCtx, matches, takerOrderStorage.executionType);
        _updateStoredTakerOrder(takerId, takerCtx, matches, msg.sender);
    }

    // ========================================
    // INTERNAL EXECUTION ENGINE 
    // ========================================

    /**
     * @notice Unified execution engine for both market and limit orders
     */
    function _executeMatches(
        LibDoefinStorage.TakerOrderContext memory takerOrder,
        LibDoefinStorage.Match[] memory matches,
        LibDoefinStorage.ExecutionType executionType
    ) internal {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        uint256 totalValue = 0;
        
        for (uint256 i = 0; i < matches.length && takerOrder.remainingAmount > 0; ++i) {
            LibDoefinStorage.Match memory matchExec = matches[i];
            LibDoefinStorage.Order storage makerOrder = ds.orderbookStorage.orders[matchExec.matchedOrderId];
            uint256 collateralUnit = ds.adminConfigStorage.unitPerPair[makerOrder.collateralToken];
            
            _validateOrder(makerOrder);

            // Validate crossing and get effective price
            (bool crossing, LibDoefinStorage.MatchType matchType, uint256 effectivePrice) = _isCrossing(
                takerOrder, executionType, makerOrder
            );
            if (!crossing) revert Errors.NotCrossingPrices();

            // Use pre-calculated fill amount, but double-check current state
            uint256 fillableAmount = _min(
                matchExec.amount,
                _min(takerOrder.remainingAmount, makerOrder.remainingAmount)
            );
            
            if (fillableAmount == 0) continue;

            // Update states
            takerOrder.remainingAmount -= fillableAmount;
            totalValue += (fillableAmount * effectivePrice) / collateralUnit;
            _updateOrderAfterFill(makerOrder, takerOrder.taker, fillableAmount, effectivePrice);

            // Execute settlement
            LibTradeSettlement.settlementDispatcher(_buildSettlementCtx(
                fillableAmount, takerOrder, makerOrder, matchType, executionType
            ));

            // Emit market order events
            if (executionType == LibDoefinStorage.ExecutionType.Market) {
                emit Events.MarketOrderMatch(
                    takerOrder.taker, makerOrder.orderId, makerOrder.maker, 
                    fillableAmount, effectivePrice, matchType
                );
            }
        }

        // Handle market order completion
        if (executionType == LibDoefinStorage.ExecutionType.Market) {
            if (takerOrder.fillOrKill && takerOrder.remainingAmount > 0) {
                revert Errors.FillOrKillFailed();
            }
            emit Events.MarketOrderExecuted(
                takerOrder.taker, takerOrder.positionId, takerOrder.direction,
                takerOrder.amount, takerOrder.amount - takerOrder.remainingAmount, totalValue
            );
        }
    }

    /**
     * @notice Generate valid match executions with constraints
     */
    function _generateMatches(
        LibDoefinStorage.TakerOrderContext memory takerCtx,
        LibDoefinStorage.Order storage takerOrderStorage,
        uint256[] memory makerIds
    ) internal view returns (LibDoefinStorage.Match[] memory matches) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        
        LibDoefinStorage.Match[] memory tempMatches = new LibDoefinStorage.Match[](makerIds.length);
        uint256 matchCount = 0;
        uint256 totalValue = 0;
        uint256 tempRemainingAmount = takerCtx.remainingAmount;

        for (uint256 i = 0; i < makerIds.length && tempRemainingAmount > 0; i++) {
            LibDoefinStorage.Order storage makerOrder = ds.orderbookStorage.orders[makerIds[i]];
            _validateOrder(makerOrder);

            (bool crossing, LibDoefinStorage.MatchType matchType, uint256 effectivePrice) = _isCrossing(
                takerCtx, takerOrderStorage.executionType, makerOrder
            );
            if (!crossing) continue;

            uint256 fillAmount = _min(tempRemainingAmount, makerOrder.remainingAmount);
            if (fillAmount == 0) continue;

            // Apply market order affordability constraints
            if (takerOrderStorage.executionType == LibDoefinStorage.ExecutionType.Market) {
                uint256 collateralUnit = ds.adminConfigStorage.unitPerPair[makerOrder.collateralToken];
                uint256 affordableAmount = _computeMaxFillableAtPrice(
                    takerCtx.targetAvgPrice, totalValue, effectivePrice, collateralUnit,
                    takerCtx.amount - tempRemainingAmount,
                    takerCtx.direction == LibDoefinStorage.OrderDirection.Buy
                );
                fillAmount = _min(affordableAmount, fillAmount);
                if (fillAmount > 0) {
                    totalValue += (fillAmount * effectivePrice) / collateralUnit;
                }
            }

            // Check minimum fill amounts
            if (fillAmount == 0 ||
                (fillAmount < takerOrderStorage.minFillAmount && tempRemainingAmount == takerCtx.amount) ||
                (fillAmount < makerOrder.minFillAmount && makerOrder.remainingAmount == makerOrder.amount)) {
                continue;
            }

            tempMatches[matchCount] = LibDoefinStorage.Match({
                matchedOrderId: makerIds[i],
                amount: fillAmount,
                effectivePrice: effectivePrice,
                matchType: matchType
            });

            tempRemainingAmount -= fillAmount;
            matchCount++;
        }

        // Resize to actual matches
        matches = new LibDoefinStorage.Match[](matchCount);
        for (uint256 i = 0; i < matchCount; i++) {
            matches[i] = tempMatches[i];
        }
    }

    /**
     * @notice Update stored taker order state after execution
     */
    function _updateStoredTakerOrder(
        uint256 takerId,
        LibDoefinStorage.TakerOrderContext memory takerCtx,
        LibDoefinStorage.Match[] memory matches,
        address executor
    ) internal {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        LibDoefinStorage.Order storage takerOrder = ds.orderbookStorage.orders[takerId];
        
        uint256 filledAmount = takerOrder.remainingAmount - takerCtx.remainingAmount;
        if (filledAmount == 0) return;

        takerOrder.remainingAmount = takerCtx.remainingAmount;
        
        // Calculate metrics
        uint256 weightedAvgPrice = _calculateWeightedAvgPrice(matches, filledAmount);
        address primaryCounterparty = matches.length > 0 ? 
            _getOrderMaker(matches[matches.length - 1].matchedOrderId) : executor;
        
        if (takerOrder.remainingAmount == 0) {
            takerOrder.active = false;
            LibOrderbook.removeOrderFromOrderbook(takerOrder);
            emit Events.OrderCompletelyFilled(
                takerOrder.orderId, takerOrder.maker, primaryCounterparty, 
                takerOrder.amount, weightedAvgPrice
            );
        } else {
            emit Events.OrderPartiallyFilled(
                takerOrder.orderId, takerOrder.maker, primaryCounterparty,
                filledAmount, takerOrder.remainingAmount, weightedAvgPrice
            );
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
        LibDoefinStorage.Order storage order,
        address counterparty,
        uint256 fillAmount,
        uint256 price
    ) internal {
        if (fillAmount > order.remainingAmount) fillAmount = order.remainingAmount;
        
        order.remainingAmount -= fillAmount;
        if (order.remainingAmount == 0) {
            order.active = false;
            LibOrderbook.removeOrderFromOrderbook(order);
            emit Events.OrderCompletelyFilled(order.orderId, order.maker, counterparty, order.amount, price);
        } else {
            emit Events.OrderPartiallyFilled(order.orderId, order.maker, counterparty, fillAmount, order.remainingAmount, price);
        }
    }

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
        LibDoefinStorage.TakerOrderContext memory takerOrder,
        LibDoefinStorage.ExecutionType executionType,
        LibDoefinStorage.Order storage makerOrder
    ) internal view returns (bool crossing, LibDoefinStorage.MatchType matchType, uint256 price) {
        // Determine match type
        if (takerOrder.direction != makerOrder.direction) {
            if (takerOrder.positionId != makerOrder.positionId) {
                return (false, LibDoefinStorage.MatchType.Complementary, 0);
            }
            matchType = LibDoefinStorage.MatchType.Complementary;
        } else {
            LibPositionRegistry.validateComplement(takerOrder.positionId, makerOrder.positionId);
            matchType = takerOrder.direction == LibDoefinStorage.OrderDirection.Buy
                ? LibDoefinStorage.MatchType.Mint : LibDoefinStorage.MatchType.Merge;
        }

        price = LibMatchEngine.effectiveTakerPrice(makerOrder, takerOrder.direction, matchType);

        // Check price crossing
        if (executionType == LibDoefinStorage.ExecutionType.Market) {
            crossing = true;
        } else {
            crossing = takerOrder.direction == LibDoefinStorage.OrderDirection.Buy
                ? takerOrder.targetAvgPrice >= price : takerOrder.targetAvgPrice <= price;
        }
    }

    function _calculateWeightedAvgPrice(
        LibDoefinStorage.Match[] memory matches,
        uint256 totalFilledAmount
    ) internal pure returns (uint256) {
        if (matches.length == 0 || totalFilledAmount == 0) return 0;
        
        uint256 totalWeightedValue = 0;
        for (uint256 i = 0; i < matches.length; i++) {
            totalWeightedValue += matches[i].amount * matches[i].effectivePrice;
        }
        return totalWeightedValue / totalFilledAmount;
    }

    function _getOrderMaker(uint256 orderId) internal view returns (address) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        return ds.orderbookStorage.orders[orderId].maker;
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