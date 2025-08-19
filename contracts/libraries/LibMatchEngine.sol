// SPDX-License-Identifier: AGPL-3.0
// Uses shared storage derived from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {LibPositionRegistry} from "./LibPositionRegistry.sol";
import {Errors} from "./Errors.sol";
import {Events} from "./Events.sol";

/// @title LibMatchEngine - Simulates and ranks order matches from multiple sources (orderbook, mint, merge)
library LibMatchEngine {
    using LibDoefinStorage for LibDoefinStorage.DiamondStorage;

    function simulateMarketOrder(
        uint256 positionId,
        uint256 desiredMarketAmount,
        LibDoefinStorage.OrderDirection direction
    ) internal view returns (LibDoefinStorage.MatchOrderRoute memory route) {
        uint256[] storage mintOrMergeOrders;
        uint256[] storage complementaryOrders;
        LibDoefinStorage.MatchType siblingMatchType;
        (complementaryOrders, mintOrMergeOrders, siblingMatchType) = retrieveTheBooksAndMatchType(positionId, direction);
        uint256 collateralUnit = retrieveCollateralUnit(positionId);
        LibDoefinStorage.SimulationContext memory simCtx = LibDoefinStorage.SimulationContext({
            complementaryOrders: complementaryOrders,
            mintOrMergeOrders: mintOrMergeOrders,
            siblingMatchType: siblingMatchType,
            direction: direction,
            collateralUnit: collateralUnit,
            desiredMarketAmount: desiredMarketAmount,
            matchCount: 0
        });

        return _simulateWithContext(simCtx);
    }

    function retrieveCollateralUnit(uint256 positionId) internal view returns (uint256) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        address collateralToken = LibPositionRegistry.getCollateralToken(positionId);
        return ds.adminConfigStorage.unitPerPair[collateralToken];
    }

    function findCrossingOrderIds(
        LibDoefinStorage.Order memory takerOrder,
        uint256[] storage complementaryOrders,
        uint256[] storage mintOrMergeOrders,
        LibDoefinStorage.MatchType siblingMatchType
    ) internal view returns (uint256[] memory makerIds) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        uint256 totalPotential = complementaryOrders.length + mintOrMergeOrders.length;
        uint256[] memory tempIds = new uint256[](totalPotential);
        uint256 remaining = takerOrder.remainingAmount;
        uint256 count = 0;
        uint256 i = 0;
        uint256 j = 0;

        while (remaining > 0 && (i < complementaryOrders.length || j < mintOrMergeOrders.length)) {
            bool compAvailable = i < complementaryOrders.length;
            bool sibAvailable = j < mintOrMergeOrders.length;
            LibDoefinStorage.Order memory compOrder;
            LibDoefinStorage.Order memory sibOrder;
            if (compAvailable) compOrder = ds.orderbookStorage.orders[complementaryOrders[i]];
            if (sibAvailable) sibOrder = ds.orderbookStorage.orders[mintOrMergeOrders[j]];

            (LibDoefinStorage.MatchExecution memory execution, bool pickComp, bool exhausted) = _pickBestOrder(
                compOrder,
                sibOrder,
                compAvailable && compOrder.remainingAmount > 0,
                sibAvailable && sibOrder.remainingAmount > 0,
                takerOrder.direction,
                siblingMatchType,
                remaining
            );
            if (exhausted) break;

            uint256 price = execution.effectivePrice;
            if (takerOrder.executionType != LibDoefinStorage.ExecutionType.Market) {
                // For limit orders, check price crossing
                if (takerOrder.direction == LibDoefinStorage.OrderDirection.Buy) {
                    if (price > takerOrder.pricePerToken) break;
                } else {
                    if (price < takerOrder.pricePerToken) break;
                }
            }

            uint256 fillAmount = execution.amount;
            LibDoefinStorage.Order memory best = pickComp ? compOrder : sibOrder;
            if (fillAmount < takerOrder.minFillAmount || fillAmount < best.minFillAmount) {
                if (pickComp) i++;
                else j++;
                continue;
            }
            tempIds[count] = best.orderId;
            count++;
            remaining -= fillAmount;
            if (pickComp) i++;
            else j++;
        }
        makerIds = new uint256[](count);
        for (uint256 k = 0; k < count; k++) makerIds[k] = tempIds[k];
    }

    function retrieveTheBooksAndMatchType(uint256 positionId, LibDoefinStorage.OrderDirection direction)
        internal
        view
        returns (
            uint256[] storage complementaryOrders,
            uint256[] storage mintOrMergeOrders,
            LibDoefinStorage.MatchType siblingMatchType
        )
    {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        // Determine sibling (complementary) position
        uint256 complementPositionId = LibPositionRegistry.getComplement(positionId);

        // Get orderbooks
        complementaryOrders = direction == LibDoefinStorage.OrderDirection.Buy
            ? ds.orderbookStorage.sellOrdersByPosition[positionId] // Buy YES → Sell YES (complementary)
            : ds.orderbookStorage.buyOrdersByPosition[positionId]; // Sell YES → Buy YES (complementary)

        // Get the match type
        if (direction == LibDoefinStorage.OrderDirection.Buy) {
            mintOrMergeOrders = ds.orderbookStorage.buyOrdersByPosition[complementPositionId]; // Buy NO → Mint YES
            siblingMatchType = LibDoefinStorage.MatchType.Mint;
        } else {
            mintOrMergeOrders = ds.orderbookStorage.sellOrdersByPosition[complementPositionId]; // Sell NO → Merge YES
            siblingMatchType = LibDoefinStorage.MatchType.Merge;
        }
    }

    function _computeBestMatchExecution(
        LibDoefinStorage.Order memory compOrder,
        LibDoefinStorage.Order memory sibOrder,
        LibDoefinStorage.OrderDirection direction,
        LibDoefinStorage.MatchType siblingMatchType,
        uint256 remaining
    ) internal view returns (LibDoefinStorage.MatchExecution memory execution, bool pickComp) {
        uint256 effCompPrice = effectiveTakerPrice(compOrder, direction, LibDoefinStorage.MatchType.Complementary);
        uint256 effSibPrice = effectiveTakerPrice(sibOrder, direction, siblingMatchType);

        pickComp = direction == LibDoefinStorage.OrderDirection.Buy ? effCompPrice <= effSibPrice : effCompPrice >= effSibPrice;

        LibDoefinStorage.Order memory best = pickComp ? compOrder : sibOrder;
        LibDoefinStorage.MatchType matchType = pickComp ? LibDoefinStorage.MatchType.Complementary : siblingMatchType;
        uint256 bestPrice = pickComp ? effCompPrice : effSibPrice;

        uint256 fillAmount = remaining < best.remainingAmount ? remaining : best.remainingAmount;

        execution = LibDoefinStorage.MatchExecution({
            matchedOrderId: best.orderId,
            matchType: matchType,
            amount: fillAmount,
            effectivePrice: bestPrice
        });
    }

    function _selectBestMatch(
        LibDoefinStorage.DiamondStorage storage ds,
        LibDoefinStorage.SimulationContext memory ctx,
        uint256 i,
        uint256 j,
        uint256 remaining
    ) internal view returns (LibDoefinStorage.MatchExecution memory execution, bool pickComp) {
        bool compAvailable = i < ctx.complementaryOrders.length;
        bool sibAvailable = j < ctx.mintOrMergeOrders.length;
        LibDoefinStorage.Order memory compOrder;
        LibDoefinStorage.Order memory sibOrder;
        if (compAvailable) compOrder = ds.orderbookStorage.orders[ctx.complementaryOrders[i]];
        if (sibAvailable) sibOrder = ds.orderbookStorage.orders[ctx.mintOrMergeOrders[j]];
        (execution, pickComp, ) = _pickBestOrder(
            compOrder,
            sibOrder,
            compAvailable && compOrder.remainingAmount > 0,
            sibAvailable && sibOrder.remainingAmount > 0,
            ctx.direction,
            ctx.siblingMatchType,
            remaining
        );
        if (!compAvailable && !sibAvailable) revert Errors.NoMatchableOrders();
    }
    function _pickBestOrder(
        LibDoefinStorage.Order memory compOrder,
        LibDoefinStorage.Order memory sibOrder,
        bool compAvailable,
        bool sibAvailable,
        LibDoefinStorage.OrderDirection direction,
        LibDoefinStorage.MatchType siblingMatchType,
        uint256 remaining
    ) internal view returns (LibDoefinStorage.MatchExecution memory execution, bool pickComp, bool exhausted) {
        if (!compAvailable && !sibAvailable) {
            return (execution, false, true); // exhausted
        }
        if (!compAvailable) {
            return _singleExecution(sibOrder, siblingMatchType, direction, remaining, false);
        }
        if (!sibAvailable) {
            return _singleExecution(compOrder, LibDoefinStorage.MatchType.Complementary, direction, remaining, true);
        }
        (execution, pickComp) = _computeBestMatchExecution(compOrder, sibOrder, direction, siblingMatchType, remaining);
        return (execution, pickComp, false);
    }

    function _singleExecution(
        LibDoefinStorage.Order memory order,
        LibDoefinStorage.MatchType matchType,
        LibDoefinStorage.OrderDirection direction,
        uint256 remaining,
        bool pickComp
    ) internal view returns (LibDoefinStorage.MatchExecution memory execution, bool, bool) {
        uint256 price = effectiveTakerPrice(order, direction, matchType);
        execution = LibDoefinStorage.MatchExecution({
            matchedOrderId: order.orderId,
            matchType: matchType,
            amount: remaining < order.remainingAmount ? remaining : order.remainingAmount,
            effectivePrice: price
        });
        return (execution, pickComp, false);
    }

    struct LoopContext {
        uint256 i;
        uint256 j;
        uint256 remaining;
        uint256 matchCount;
    }

    function _simulateWithContext(LibDoefinStorage.SimulationContext memory ctx)
        internal
        view
        returns (LibDoefinStorage.MatchOrderRoute memory route)
    {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        LibDoefinStorage.MatchExecution[] memory tempMatches = new LibDoefinStorage.MatchExecution[](
            ctx.complementaryOrders.length + ctx.mintOrMergeOrders.length
        );

        route.totalInputAmount = 0;
        route.totalOutputAmount = 0;

        LoopContext memory lc = LoopContext({i: 0, j: 0, remaining: ctx.desiredMarketAmount, matchCount: 0});

        while (lc.remaining > 0 && (lc.i < ctx.complementaryOrders.length || lc.j < ctx.mintOrMergeOrders.length)) {
            (LibDoefinStorage.MatchExecution memory execution, bool pickComp) = _selectBestMatch(ds, ctx, lc.i, lc.j, lc.remaining);

            tempMatches[lc.matchCount] = execution;
            route.totalInputAmount += execution.amount;
            route.totalOutputAmount += (execution.amount * execution.effectivePrice) / ctx.collateralUnit;
            lc.remaining -= execution.amount;
            lc.matchCount++;

            if (pickComp) lc.i++;
            else lc.j++;
        }

        // Shrink match array
        route.matches = new LibDoefinStorage.MatchExecution[](lc.matchCount);
        for (uint256 k = 0; k < lc.matchCount; k++) {
            route.matches[k] = tempMatches[k];
        }

        return route;
    }

    function effectiveTakerPrice(
        LibDoefinStorage.Order memory makerOrder,
        LibDoefinStorage.OrderDirection takerDirection,
        LibDoefinStorage.MatchType matchType
    ) internal view returns (uint256) {
        // Fee is applied differently based on Buy/Sell
        // For Buy: effective cost increases (taker pays more)
        // For Sell: effective revenue decreases (taker receives less)

        uint256 basePrice;

        if (matchType == LibDoefinStorage.MatchType.Complementary) {
            // Regular price
            basePrice = makerOrder.pricePerToken;
        } else {
            // Maker wants to buy one token → taker buying the opposite side
            // Price for taker = 1 - makerPrice
            LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
            uint256 unit = ds.adminConfigStorage.unitPerPair[makerOrder.collateralToken];
            basePrice = unit - makerOrder.pricePerToken;
        }
        if (takerDirection == LibDoefinStorage.OrderDirection.Buy) {
            return (basePrice * (10_000 + makerOrder.orderFeeConfig.takerFeeBps)) / 10_000;
        } else {
            return (basePrice * (10_000 - makerOrder.orderFeeConfig.takerFeeBps)) / 10_000;
        }
    }
}
