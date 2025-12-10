// SPDX-License-Identifier: AGPL-3.0
// Uses shared storage derived from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {LibPositionRegistry} from "./LibPositionRegistry.sol";
import {LibQuoteCurrency} from "./LibQuoteCurrency.sol";
import {Errors} from "./Errors.sol";
import {Events} from "./Events.sol";

/// @title LibMatchEngine - Simulates and ranks order matches from multiple sources (orderbook, mint, merge)
library LibMatchEngine {
    using LibDoefinStorage for LibDoefinStorage.AppStorage;

    /// @notice Simulate a market order and return the best match route
    /// @dev Two distinct paths:
    ///      1. SELL: Specify shares to sell → get collateral revenue
    ///      2. BUY: Specify collateral budget → get shares received
    /// @param positionId The position token ID to trade
    /// @param sharesOrBudgetAmount For BUY: collateral budget to spend. For SELL: token shares to sell
    /// @param direction The order direction (Buy or Sell)
    /// @return route The match route with totalInputAmount and totalOutputAmount
    ///         - For BUY: totalInputAmount = shares received, totalOutputAmount = collateral spent
    ///         - For SELL: totalInputAmount = shares sold, totalOutputAmount = collateral received
    function simulateMarketOrder(
        uint256 positionId,
        uint256 sharesOrBudgetAmount,
        LibDoefinStorage.OrderDirection direction
    ) internal view returns (LibDoefinStorage.MatchOrderRoute memory route) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        uint256[] storage mintOrMergeOrders;
        uint256[] storage complementaryOrders;
        LibDoefinStorage.MatchType siblingMatchType;
        (complementaryOrders, mintOrMergeOrders, siblingMatchType) = retrieveTheBooksAndMatchType(positionId, direction);

        // Inline retrieveCollateralUnit
        address collateralToken = LibPositionRegistry.getCollateralToken(positionId);
        uint256 collateralUnit = ds.adminConfigStorage.unitPerPair[collateralToken];
        if (collateralUnit == 0) revert Errors.TokenNotAllowed();

        LibDoefinStorage.SimulationContext memory simCtx = LibDoefinStorage.SimulationContext({
            complementaryOrders: complementaryOrders,
            mintOrMergeOrders: mintOrMergeOrders,
            siblingMatchType: siblingMatchType,
            direction: direction,
            collateralUnit: collateralUnit,
            sharesOrBudgetAmount: sharesOrBudgetAmount,
            matchCount: 0
        });

        return _simulateWithContext(simCtx);
    }

    /// @notice Simulate a cross-currency market order and return the best match route
    /// @dev Cross-currency orders can only match complementary orders on the same position
    ///      with the same quote currency. Mint/merge matches are excluded.
    /// @param positionId The position ID to trade
    /// @param desiredMarketAmount The desired amount to trade
    /// @param direction Buy or Sell direction
    /// @param quoteCurrencyToken The quote currency token to match orders against
    /// @return route The simulated match route with prices in quote currency
    function simulateCrossCurrencyMarketOrder(
        uint256 positionId,
        uint256 desiredMarketAmount,
        LibDoefinStorage.OrderDirection direction,
        address quoteCurrencyToken
    ) internal view returns (LibDoefinStorage.MatchOrderRoute memory route) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        // Validate quote currency token
        if (quoteCurrencyToken == address(0)) {
            revert Errors.InvalidQuoteCurrencyToken();
        }

        uint256 quoteUnitPerPair = ds.adminConfigStorage.unitPerPair[quoteCurrencyToken];
        if (quoteUnitPerPair == 0) {
            revert Errors.TokenNotAllowed();
        }

        // Get complementary orders only (cross-currency can't use mint/merge)
        uint256[] storage complementaryOrders;
        bool isBuy = direction == LibDoefinStorage.OrderDirection.Buy;
        complementaryOrders = isBuy ? ds.orderbookStorage.sellOrdersByPosition[positionId] : ds.orderbookStorage.buyOrdersByPosition[positionId];

        // Filter to only compatible cross-currency orders
        uint256[] memory compatibleOrderIds = _filterCrossCurrencyCompatibleOrders(complementaryOrders, quoteCurrencyToken);

        // Use quote currency unit for price calculations
        return _simulateCrossCurrencyWithOrders(compatibleOrderIds, desiredMarketAmount, direction, quoteUnitPerPair);
    }

    function findPotentialMatchesForOrder(uint256 takerId) internal view returns (uint256[] memory makerIds) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        LibDoefinStorage.Order storage takerOrder = ds.orderbookStorage.orders[takerId];

        (uint256[] storage compOrders, uint256[] storage sibOrders, LibDoefinStorage.MatchType siblingMatchType) = retrieveTheBooksAndMatchType(
            takerOrder.positionId,
            takerOrder.direction
        );

        if (compOrders.length == 0 && sibOrders.length == 0) {
            return makerIds;
        }

        makerIds = _findCrossingOrderIds(takerOrder, compOrders, sibOrders, siblingMatchType);
    }

    function _findCrossingOrderIds(
        LibDoefinStorage.Order memory takerOrder,
        uint256[] storage complementaryOrders,
        uint256[] storage mintOrMergeOrders,
        LibDoefinStorage.MatchType siblingMatchType
    ) internal view returns (uint256[] memory makerIds) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        uint256 totalPotential = complementaryOrders.length + mintOrMergeOrders.length;
        uint256[] memory tempIds = new uint256[](totalPotential);
        uint256 remaining = takerOrder.remainingAmount;
        uint256 count = 0;
        uint256 i = 0;
        uint256 j = 0;

        // Cache taker price once before loop
        uint256 takerPriceForComparison = takerOrder.pricePerToken;
        if (takerOrder.executionType != LibDoefinStorage.ExecutionType.Market && takerOrder.orderType == LibDoefinStorage.OrderType.CrossCurrency) {
            takerPriceForComparison = _effectiveTakerPriceCrossCurrency(takerOrder, takerOrder.direction, LibDoefinStorage.MatchType.Complementary);
        }

        while (remaining > 0 && (i < complementaryOrders.length || j < mintOrMergeOrders.length)) {
            bool compAvailable = i < complementaryOrders.length;
            bool sibAvailable = j < mintOrMergeOrders.length;
            LibDoefinStorage.Order memory compOrder;
            LibDoefinStorage.Order memory sibOrder;
            if (compAvailable) compOrder = ds.orderbookStorage.orders[complementaryOrders[i]];
            if (sibAvailable) sibOrder = ds.orderbookStorage.orders[mintOrMergeOrders[j]];

            bool compOrderValid = compAvailable && compOrder.remainingAmount > 0;
            bool sibOrderValid = sibAvailable && sibOrder.remainingAmount > 0;
            (LibDoefinStorage.Match memory execution, bool pickComp, bool exhausted) = _pickBestOrder(
                compOrder,
                sibOrder,
                compOrderValid,
                sibOrderValid,
                takerOrder.direction,
                siblingMatchType,
                remaining
            );
            if (exhausted) break;

            uint256 price = execution.effectivePrice;

            // Use cached price for limit order validation
            if (takerOrder.executionType != LibDoefinStorage.ExecutionType.Market) {
                if (takerOrder.direction == LibDoefinStorage.OrderDirection.Buy) {
                    if (price > takerPriceForComparison) break;
                } else {
                    if (price < takerPriceForComparison) break;
                }
            }

            uint256 fillAmount = execution.amount;
            LibDoefinStorage.Order memory best = pickComp ? compOrder : sibOrder;

            if (takerOrder.orderType == LibDoefinStorage.OrderType.CrossCurrency) {
                if (!pickComp) {
                    j++;
                    continue;
                }
                if (!_areOrdersCompatibleForCrossCurrency(takerOrder, best)) {
                    if (pickComp) i++;
                    else j++;
                    continue;
                }
            } else if (best.orderType == LibDoefinStorage.OrderType.CrossCurrency) {
                if (pickComp) i++;
                else j++;
                continue;
            }

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
        makerIds = _finalizeUintArray(tempIds, count);
    }

    /**
     * @notice Check if two orders are compatible for cross-currency matching
     * @param takerOrder The taker order (must be cross-currency)
     * @param makerOrder The maker order to check compatibility with
     * @return compatible Whether the orders can be matched
     */
    function _areOrdersCompatibleForCrossCurrency(
        LibDoefinStorage.Order memory takerOrder,
        LibDoefinStorage.Order memory makerOrder
    ) internal pure returns (bool compatible) {
        // Use LibQuoteCurrency compatibility logic
        return LibQuoteCurrency.areOrdersCompatible(takerOrder, makerOrder);
    }

    function retrieveTheBooksAndMatchType(
        uint256 positionId,
        LibDoefinStorage.OrderDirection direction
    )
        internal
        view
        returns (uint256[] storage complementaryOrders, uint256[] storage mintOrMergeOrders, LibDoefinStorage.MatchType siblingMatchType)
    {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        // Determine sibling (complementary) position
        uint256 complementPositionId = LibPositionRegistry.getComplement(positionId);

        bool isBuy = direction == LibDoefinStorage.OrderDirection.Buy;

        // Get orderbooks
        complementaryOrders = isBuy
            ? ds.orderbookStorage.sellOrdersByPosition[positionId] // Buy YES → Sell YES (complementary)
            : ds.orderbookStorage.buyOrdersByPosition[positionId]; // Sell YES → Buy YES (complementary)

        // Get the match type
        if (isBuy) {
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
    ) internal view returns (LibDoefinStorage.Match memory execution, bool pickComp) {
        uint256 effCompPrice = effectiveTakerPrice(compOrder, direction, LibDoefinStorage.MatchType.Complementary);
        uint256 effSibPrice = effectiveTakerPrice(sibOrder, direction, siblingMatchType);

        // Respecting Price-Time priority
        if (effCompPrice == effSibPrice) {
            pickComp = compOrder.createdAt <= sibOrder.createdAt;
        } else {
            pickComp = direction == LibDoefinStorage.OrderDirection.Buy ? effCompPrice <= effSibPrice : effCompPrice >= effSibPrice;
        }

        LibDoefinStorage.Order memory best = pickComp ? compOrder : sibOrder;
        LibDoefinStorage.MatchType matchType = pickComp ? LibDoefinStorage.MatchType.Complementary : siblingMatchType;
        uint256 bestPrice = pickComp ? effCompPrice : effSibPrice;

        uint256 fillAmount = remaining < best.remainingAmount ? remaining : best.remainingAmount;

        execution = LibDoefinStorage.Match({matchedOrderId: best.orderId, matchType: matchType, amount: fillAmount, effectivePrice: bestPrice});
    }

    function _selectBestMatch(
        LibDoefinStorage.AppStorage storage ds,
        LibDoefinStorage.SimulationContext memory ctx,
        uint256 i,
        uint256 j,
        uint256 remaining
    ) internal view returns (LibDoefinStorage.Match memory execution, bool pickComp) {
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
    ) internal view returns (LibDoefinStorage.Match memory execution, bool pickComp, bool exhausted) {
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
        bool isComplementaryOrder
    ) internal view returns (LibDoefinStorage.Match memory execution, bool pickComp, bool exhausted) {
        uint256 price = effectiveTakerPrice(order, direction, matchType);
        execution = LibDoefinStorage.Match({
            matchedOrderId: order.orderId,
            matchType: matchType,
            amount: remaining < order.remainingAmount ? remaining : order.remainingAmount,
            effectivePrice: price
        });
        pickComp = isComplementaryOrder;
        exhausted = false;
    }

    struct LoopContext {
        uint256 i;
        uint256 j;
        uint256 remaining;
        uint256 matchCount;
    }

    function _simulateWithContext(
        LibDoefinStorage.SimulationContext memory ctx
    ) internal view returns (LibDoefinStorage.MatchOrderRoute memory route) {
        if (ctx.direction == LibDoefinStorage.OrderDirection.Buy) {
            return _simulateBuyWithBudget(ctx);
        } else {
            return _simulateSellWithShares(ctx);
        }
    }

    function _simulateSellWithShares(
        LibDoefinStorage.SimulationContext memory ctx
    ) internal view returns (LibDoefinStorage.MatchOrderRoute memory route) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        // Use helper for initialization
        (LibDoefinStorage.Match[] memory tempMatches, LoopContext memory lc) = _initMatchArray(
            ctx.complementaryOrders.length + ctx.mintOrMergeOrders.length
        );
        lc.remaining = ctx.sharesOrBudgetAmount;

        route.totalInputAmount = 0;
        route.totalOutputAmount = 0;

        while (lc.remaining > 0 && (lc.i < ctx.complementaryOrders.length || lc.j < ctx.mintOrMergeOrders.length)) {
            (LibDoefinStorage.Match memory execution, bool pickComp) = _selectBestMatch(ds, ctx, lc.i, lc.j, lc.remaining);

            tempMatches[lc.matchCount] = execution;
            route.totalInputAmount += execution.amount;
            route.totalOutputAmount += Math.mulDiv(execution.amount, execution.effectivePrice, ctx.collateralUnit);
            lc.remaining -= execution.amount;
            lc.matchCount++;

            if (pickComp) lc.i++;
            else lc.j++;
        }

        // Use helper for shrinking
        route.matches = _finalizeMatches(tempMatches, lc.matchCount);
        return route;
    }

    function _simulateBuyWithBudget(
        LibDoefinStorage.SimulationContext memory ctx
    ) internal view returns (LibDoefinStorage.MatchOrderRoute memory route) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        // Use helper for initialization
        (LibDoefinStorage.Match[] memory tempMatches, LoopContext memory lc) = _initMatchArray(
            ctx.complementaryOrders.length + ctx.mintOrMergeOrders.length
        );
        lc.remaining = ctx.sharesOrBudgetAmount;

        route.totalInputAmount = 0;
        route.totalOutputAmount = 0;

        while (lc.remaining > 0 && (lc.i < ctx.complementaryOrders.length || lc.j < ctx.mintOrMergeOrders.length)) {
            (LibDoefinStorage.Match memory execution, bool pickComp) = _selectBestMatch(ds, ctx, lc.i, lc.j, type(uint256).max);

            uint256 collateralCost = Math.mulDiv(execution.amount, execution.effectivePrice, ctx.collateralUnit);

            if (collateralCost <= lc.remaining) {
                tempMatches[lc.matchCount] = execution;
                route.totalInputAmount += execution.amount;
                route.totalOutputAmount += collateralCost;
                lc.remaining -= collateralCost;
                lc.matchCount++;

                if (pickComp) lc.i++;
                else lc.j++;
            } else {
                uint256 affordableAmount = Math.mulDiv(lc.remaining, ctx.collateralUnit, execution.effectivePrice);

                if (affordableAmount > 0) {
                    LibDoefinStorage.Order memory makerOrder = ds.orderbookStorage.orders[execution.matchedOrderId];

                    if (affordableAmount >= makerOrder.minFillAmount) {
                        execution.amount = affordableAmount;
                        uint256 actualCost = Math.mulDiv(affordableAmount, execution.effectivePrice, ctx.collateralUnit);

                        tempMatches[lc.matchCount] = execution;
                        route.totalInputAmount += affordableAmount;
                        route.totalOutputAmount += actualCost;
                        lc.matchCount++;
                    }
                }
                break;
            }
        }

        // Use helper for shrinking
        route.matches = _finalizeMatches(tempMatches, lc.matchCount);
        return route;
    }

    /// @notice Calculate the effective price per token that a taker will pay or receive when matching against a maker order
    /// @dev This function computes the all-in price from the taker's perspective, including fees:
    ///      - For BUY orders: returns the total cost per token (base price + taker fee)
    ///      - For SELL orders: returns the net revenue per token (base price - taker fee)
    ///
    ///      Price calculation varies by match type:
    ///      1. Complementary matches: Uses maker's price directly (same position, opposite direction)
    ///      2. Mint/Merge matches: Uses complementary price (unitPerPair - maker's price) since
    ///         the taker is trading the opposite outcome
    ///
    ///      Example scenarios:
    ///      - BUY taker + complementary SELL at 0.6 USDC with 1% taker fee:
    ///        basePrice = 0.6, effectivePrice = 0.606 (taker pays 0.606 per token)
    ///      - BUY taker minting against complementary BUY at 0.6 USDC:
    ///        basePrice = 1 - 0.6 = 0.4, effectivePrice = 0.404 with 1% fee
    ///
    /// @param makerOrder The maker order being matched against
    /// @param takerDirection The direction of the taker order (Buy or Sell)
    /// @param matchType The type of match (Complementary, Mint, or Merge)
    /// @return The effective price per token in collateral token's smallest unit, scaled by unitPerPair.
    ///         This is the actual amount the taker pays (buy) or receives (sell) per position token
    function effectiveTakerPrice(
        LibDoefinStorage.Order memory makerOrder,
        LibDoefinStorage.OrderDirection takerDirection,
        LibDoefinStorage.MatchType matchType
    ) internal view returns (uint256) {
        if (makerOrder.orderType == LibDoefinStorage.OrderType.CrossCurrency) {
            return _effectiveTakerPriceCrossCurrency(makerOrder, takerDirection, matchType);
        }

        uint256 basePrice;
        if (matchType == LibDoefinStorage.MatchType.Complementary) {
            basePrice = makerOrder.pricePerToken;
        } else {
            LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
            uint256 unit = ds.adminConfigStorage.unitPerPair[makerOrder.collateralToken];
            basePrice = unit - makerOrder.pricePerToken;
        }

        return _applyTakerFee(basePrice, makerOrder.takerFeeBps, takerDirection == LibDoefinStorage.OrderDirection.Buy);
    }

    /**
     * @notice Calculate effective taker price for cross-currency orders
     * @param makerOrder The cross-currency maker order
     * @param takerDirection The taker's order direction
     * @param matchType The match type (must be Complementary for cross-currency)
     * @return The effective price in quote currency units
     */
    function _effectiveTakerPriceCrossCurrency(
        LibDoefinStorage.Order memory makerOrder,
        LibDoefinStorage.OrderDirection takerDirection,
        LibDoefinStorage.MatchType matchType
    ) internal view returns (uint256) {
        if (matchType != LibDoefinStorage.MatchType.Complementary) {
            revert Errors.NonComplementaryCrossCurrencyMatch();
        }

        bool useOracleRate = (makerOrder.exchangeRateType == LibDoefinStorage.ExchangeRateType.Dynamic);
        (uint256 quoteCurrencyPrice, bool isStale) = LibQuoteCurrency.calculateQuoteCurrencyPrice(makerOrder, useOracleRate);

        if (isStale) {
            revert Errors.OraclePriceStale();
        }

        return _applyTakerFee(quoteCurrencyPrice, makerOrder.takerFeeBps, takerDirection == LibDoefinStorage.OrderDirection.Buy);
    }

    /// @notice Calculate the effective price from maker's perspective (includes maker fees)
    /// @dev The maker's effective price is:
    ///      - Buy maker: listed price + maker fee (total cost per token)
    ///      - Sell maker: listed price - maker fee (net revenue per token)
    ///      Note: Match type doesn't affect maker price - they only care about their listed price
    /// @param makerOrder The maker order
    /// @return The effective price per token the maker pays/receives, including maker fees
    function effectiveMakerPrice(LibDoefinStorage.Order memory makerOrder) internal pure returns (uint256) {
        uint256 makerPrice = makerOrder.pricePerToken;
        if (makerOrder.direction == LibDoefinStorage.OrderDirection.Buy) {
            // Buyer pays more: base price + maker fee
            return (makerPrice * (10_000 + makerOrder.makerFeeBps)) / 10_000;
        } else {
            // Seller receives less: base price - maker fee
            return (makerPrice * (10_000 - makerOrder.makerFeeBps)) / 10_000;
        }
    }

    function _initMatchArray(uint256 maxSize) private pure returns (LibDoefinStorage.Match[] memory, LoopContext memory) {
        return (new LibDoefinStorage.Match[](maxSize), LoopContext({i: 0, j: 0, remaining: 0, matchCount: 0}));
    }

    function _finalizeMatches(
        LibDoefinStorage.Match[] memory tempMatches,
        uint256 matchCount
    ) private pure returns (LibDoefinStorage.Match[] memory matches) {
        matches = new LibDoefinStorage.Match[](matchCount);
        for (uint256 k = 0; k < matchCount; k++) {
            matches[k] = tempMatches[k];
        }
    }

    ///
    /// @notice Apply taker fee to base price
    /// @param basePrice The base price before fees
    /// @param takerFeeBps The taker fee in basis points
    /// @param isBuy Whether this is a buy order (true) or sell (false)
    /// @return The price with taker fee applied
    function _applyTakerFee(uint256 basePrice, uint256 takerFeeBps, bool isBuy) private pure returns (uint256) {
        return isBuy ? (basePrice * (10_000 + takerFeeBps)) / 10_000 : (basePrice * (10_000 - takerFeeBps)) / 10_000;
    }

    function _finalizeUintArray(uint256[] memory temp, uint256 count) private pure returns (uint256[] memory result) {
        result = new uint256[](count);
        for (uint256 k = 0; k < count; k++) {
            result[k] = temp[k];
        }
    }

    /**
     * @notice Filter orders to find compatible cross-currency orders
     * @dev Returns only orders that:
     *      - Are cross-currency orders
     *      - Have matching quote currency
     *      - Have remaining amount > 0
     *      Note: Position and direction are already guaranteed by the orderIds source
     * @param orderIds Storage array of order IDs to filter (already complementary orders for the position)
     * @param quoteCurrencyToken The quote currency to match
     * @return compatibleIds Array of compatible order IDs
     */
    function _filterCrossCurrencyCompatibleOrders(
        uint256[] storage orderIds,
        address quoteCurrencyToken
    ) internal view returns (uint256[] memory compatibleIds) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        uint256[] memory tempIds = new uint256[](orderIds.length);
        uint256 count = 0;

        for (uint256 i = 0; i < orderIds.length; i++) {
            LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[orderIds[i]];

            // Check if order is cross-currency
            if (order.orderType != LibDoefinStorage.OrderType.CrossCurrency) {
                continue;
            }

            // Check if it has remaining amount
            if (order.remainingAmount == 0) {
                continue;
            }

            // Check if quote currencies match
            if (order.quoteCurrencyToken != quoteCurrencyToken) {
                continue;
            }

            // Position already matches (we got orders from this position's book)
            // Direction already opposite (we got complementary orders)

            tempIds[count] = orderIds[i];
            count++;
        }

        // Resize to actual count
        compatibleIds = _finalizeUintArray(tempIds, count);
    }

    /**
     * @notice Simulate cross-currency order matching with filtered compatible orders
     * @dev Implements price-time priority: at each step, selects the best-priced available order
     * @param compatibleOrderIds Array of compatible cross-currency order IDs
     * @param desiredAmount The amount the taker wants to trade
     * @param direction The taker's direction
     * @param quoteUnitPerPair Unit per pair for quote currency
     * @return route The simulated match route
     */
    function _simulateCrossCurrencyWithOrders(
        uint256[] memory compatibleOrderIds,
        uint256 desiredAmount,
        LibDoefinStorage.OrderDirection direction,
        uint256 quoteUnitPerPair
    ) internal view returns (LibDoefinStorage.MatchOrderRoute memory route) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        if (compatibleOrderIds.length == 0) {
            route.matches = new LibDoefinStorage.Match[](0);
            route.totalInputAmount = 0;
            route.totalOutputAmount = 0;
            return route;
        }

        // Cache all orders upfront
        LibDoefinStorage.Order[] memory orders = new LibDoefinStorage.Order[](compatibleOrderIds.length);
        for (uint256 i = 0; i < compatibleOrderIds.length; i++) {
            orders[i] = ds.orderbookStorage.orders[compatibleOrderIds[i]];
        }

        LibDoefinStorage.Match[] memory tempMatches = new LibDoefinStorage.Match[](compatibleOrderIds.length);
        uint256 remaining = desiredAmount;
        uint256 matchCount = 0;
        route.totalInputAmount = 0;
        route.totalOutputAmount = 0;

        bool[] memory used = new bool[](compatibleOrderIds.length);
        uint256[] memory remainingAmounts = new uint256[](compatibleOrderIds.length);
        for (uint256 i = 0; i < compatibleOrderIds.length; i++) {
            remainingAmounts[i] = orders[i].remainingAmount;
        }

        while (remaining > 0 && matchCount < compatibleOrderIds.length) {
            uint256 bestIndex = type(uint256).max;
            uint256 bestPrice = type(uint256).max;
            uint256 bestCreatedAt = type(uint256).max;

            for (uint256 i = 0; i < compatibleOrderIds.length; i++) {
                if (used[i] || remainingAmounts[i] == 0) {
                    used[i] = true;
                    continue;
                }

                uint256 effectivePrice = _effectiveTakerPriceCrossCurrency(orders[i], direction, LibDoefinStorage.MatchType.Complementary);

                bool isBetter = false;
                if (direction == LibDoefinStorage.OrderDirection.Buy) {
                    if (effectivePrice < bestPrice || (effectivePrice == bestPrice && orders[i].createdAt < bestCreatedAt)) {
                        isBetter = true;
                    }
                } else {
                    if (effectivePrice > bestPrice || (effectivePrice == bestPrice && orders[i].createdAt < bestCreatedAt)) {
                        isBetter = true;
                    }
                }

                if (isBetter) {
                    bestIndex = i;
                    bestPrice = effectivePrice;
                    bestCreatedAt = orders[i].createdAt;
                }
            }

            if (bestIndex == type(uint256).max) break;

            uint256 fillAmount = remaining < remainingAmounts[bestIndex] ? remaining : remainingAmounts[bestIndex];

            tempMatches[matchCount] = LibDoefinStorage.Match({
                matchedOrderId: orders[bestIndex].orderId,
                matchType: LibDoefinStorage.MatchType.Complementary,
                amount: fillAmount,
                effectivePrice: bestPrice
            });

            route.totalInputAmount += fillAmount;
            route.totalOutputAmount += Math.mulDiv(fillAmount, bestPrice, quoteUnitPerPair);
            remaining -= fillAmount;
            remainingAmounts[bestIndex] -= fillAmount;
            matchCount++;
            used[bestIndex] = true;
        }

        route.matches = _finalizeMatches(tempMatches, matchCount);
        return route;
    }
}
