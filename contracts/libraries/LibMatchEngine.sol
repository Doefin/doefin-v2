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

    /// @notice Simulate a cross-currency market order and return the best match route
    /// @dev Cross-currency orders can only match complementary orders on the same position
    ///      with the same quote currency. Mint/merge matches are excluded.
    /// @param positionId The position ID to trade
    /// @param desiredMarketAmount The desired amount to trade
    /// @param direction Buy or Sell direction
    /// @param crossCurrencyConfig Cross-currency configuration (quote token, exchange rate, etc.)
    /// @return route The simulated match route with prices in quote currency
    function simulateCrossCurrencyMarketOrder(
        uint256 positionId,
        uint256 desiredMarketAmount,
        LibDoefinStorage.OrderDirection direction,
        LibDoefinStorage.CrossCurrencyConfig memory crossCurrencyConfig
    ) internal view returns (LibDoefinStorage.MatchOrderRoute memory route) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        // Validate cross-currency configuration
        if (crossCurrencyConfig.quoteCurrencyToken == address(0)) {
            revert Errors.InvalidQuoteCurrencyToken();
        }

        uint256 quoteUnitPerPair = ds.adminConfigStorage.unitPerPair[crossCurrencyConfig.quoteCurrencyToken];
        if (quoteUnitPerPair == 0) {
            revert Errors.TokenNotAllowed();
        }

        // Get complementary orders only (cross-currency can't use mint/merge)
        uint256[] storage complementaryOrders;
        bool isBuy = direction == LibDoefinStorage.OrderDirection.Buy;
        complementaryOrders = isBuy ? ds.orderbookStorage.sellOrdersByPosition[positionId] : ds.orderbookStorage.buyOrdersByPosition[positionId];

        // Filter to only compatible cross-currency orders
        uint256[] memory compatibleOrderIds = _filterCrossCurrencyCompatibleOrders(
            complementaryOrders,
            crossCurrencyConfig.quoteCurrencyToken,
            positionId,
            direction
        );

        // Use quote currency unit for price calculations
        return _simulateCrossCurrencyWithOrders(compatibleOrderIds, desiredMarketAmount, direction, quoteUnitPerPair, crossCurrencyConfig);
    }

    function retrieveCollateralUnit(uint256 positionId) internal view returns (uint256) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        address collateralToken = LibPositionRegistry.getCollateralToken(positionId);
        uint256 unit = ds.adminConfigStorage.unitPerPair[collateralToken];
        if (unit == 0) revert Errors.TokenNotAllowed();
        return unit;
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

            if (takerOrder.executionType != LibDoefinStorage.ExecutionType.Market) {
                // For cross-currency orders, convert taker price to quote currency for comparison
                uint256 takerPriceForComparison = takerOrder.pricePerToken;
                if (takerOrder.orderType == LibDoefinStorage.OrderType.CrossCurrency) {
                    // Convert taker's collateral-denominated price to quote currency
                    bool useOracleRate = (takerOrder.crossCurrencyConfig.exchangeRateType == LibDoefinStorage.ExchangeRateType.Dynamic);
                    (uint256 takerQuotePrice, bool isStale) = LibQuoteCurrency.calculateQuoteCurrencyPrice(takerOrder, useOracleRate);
                    if (isStale) {
                        revert Errors.OraclePriceStale();
                    }

                    // Apply taker fee to make comparison consistent with effectiveTakerPrice
                    // This ensures both sides of the price comparison include taker fees
                    if (takerOrder.direction == LibDoefinStorage.OrderDirection.Buy) {
                        takerPriceForComparison = (takerQuotePrice * (10_000 + takerOrder.orderFeeConfig.takerFeeBps)) / 10_000;
                    } else {
                        takerPriceForComparison = (takerQuotePrice * (10_000 - takerOrder.orderFeeConfig.takerFeeBps)) / 10_000;
                    }
                }

                // For limit orders, check price crossing
                if (takerOrder.direction == LibDoefinStorage.OrderDirection.Buy) {
                    if (price > takerPriceForComparison) break;
                } else {
                    if (price < takerPriceForComparison) break;
                }
            }

            uint256 fillAmount = execution.amount;
            LibDoefinStorage.Order memory best = pickComp ? compOrder : sibOrder;

            // Cross-currency orders can only match complementary orders (not mint/merge)
            if (takerOrder.orderType == LibDoefinStorage.OrderType.CrossCurrency) {
                if (!pickComp) {
                    // Skip mint/merge matches for cross-currency orders
                    j++;
                    continue;
                }
                // Check cross-currency compatibility
                if (!_areOrdersCompatibleForCrossCurrency(takerOrder, best)) {
                    if (pickComp) i++;
                    else j++;
                    continue;
                }
            } else if (best.orderType == LibDoefinStorage.OrderType.CrossCurrency) {
                // Standard order can't match cross-currency order
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
        makerIds = new uint256[](count);
        for (uint256 k = 0; k < count; k++) makerIds[k] = tempIds[k];
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
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        LibDoefinStorage.Match[] memory tempMatches = new LibDoefinStorage.Match[](ctx.complementaryOrders.length + ctx.mintOrMergeOrders.length);

        route.totalInputAmount = 0;
        route.totalOutputAmount = 0;

        LoopContext memory lc = LoopContext({i: 0, j: 0, remaining: ctx.desiredMarketAmount, matchCount: 0});

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

        // Shrink match array
        route.matches = new LibDoefinStorage.Match[](lc.matchCount);
        for (uint256 k = 0; k < lc.matchCount; k++) {
            route.matches[k] = tempMatches[k];
        }

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
        // For cross-currency orders, calculate price in quote currency
        if (makerOrder.orderType == LibDoefinStorage.OrderType.CrossCurrency) {
            return _effectiveTakerPriceCrossCurrency(makerOrder, takerDirection, matchType);
        }

        // Standard order pricing logic (unchanged)
        uint256 basePrice;

        if (matchType == LibDoefinStorage.MatchType.Complementary) {
            // Regular price
            basePrice = makerOrder.pricePerToken;
        } else {
            // Maker wants to buy one token → taker buying the opposite side
            // Price for taker = 1 - makerPrice
            LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
            uint256 unit = ds.adminConfigStorage.unitPerPair[makerOrder.collateralToken];
            basePrice = unit - makerOrder.pricePerToken;
        }
        if (takerDirection == LibDoefinStorage.OrderDirection.Buy) {
            return (basePrice * (10_000 + makerOrder.orderFeeConfig.takerFeeBps)) / 10_000;
        } else {
            return (basePrice * (10_000 - makerOrder.orderFeeConfig.takerFeeBps)) / 10_000;
        }
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
        // Cross-currency orders only support complementary matching
        if (matchType != LibDoefinStorage.MatchType.Complementary) {
            revert Errors.NonComplementaryCrossCurrencyMatch();
        }

        // Determine which exchange rate to use based on the maker order's configuration
        bool useOracleRate = (makerOrder.crossCurrencyConfig.exchangeRateType == LibDoefinStorage.ExchangeRateType.Dynamic);

        // Calculate the quote currency price (may revert if oracle is stale)
        (uint256 quoteCurrencyPrice, bool isStale) = LibQuoteCurrency.calculateQuoteCurrencyPrice(makerOrder, useOracleRate);

        // Revert if oracle is stale for dynamic rates
        if (isStale) {
            revert Errors.OraclePriceStale();
        }

        // Apply taker fee to the quote currency price
        if (takerDirection == LibDoefinStorage.OrderDirection.Buy) {
            return (quoteCurrencyPrice * (10_000 + makerOrder.orderFeeConfig.takerFeeBps)) / 10_000;
        } else {
            return (quoteCurrencyPrice * (10_000 - makerOrder.orderFeeConfig.takerFeeBps)) / 10_000;
        }
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
            return (makerPrice * (10_000 + makerOrder.orderFeeConfig.makerFeeBps)) / 10_000;
        } else {
            // Seller receives less: base price - maker fee
            return (makerPrice * (10_000 - makerOrder.orderFeeConfig.makerFeeBps)) / 10_000;
        }
    }

    /**
     * @notice Filter orders to find compatible cross-currency orders
     * @dev Returns only orders that:
     *      - Are cross-currency orders
     *      - Have matching quote currency
     *      - Are on the same position
     *      - Have opposite direction
     *      - Have remaining amount > 0
     * @param orderIds Storage array of order IDs to filter
     * @param quoteCurrencyToken The quote currency to match
     * @param positionId The position ID to match
     * @param direction The taker's direction (opposite of what we're looking for)
     * @return compatibleIds Array of compatible order IDs
     */
    function _filterCrossCurrencyCompatibleOrders(
        uint256[] storage orderIds,
        address quoteCurrencyToken,
        uint256 positionId,
        LibDoefinStorage.OrderDirection direction
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
            if (order.crossCurrencyConfig.quoteCurrencyToken != quoteCurrencyToken) {
                continue;
            }

            // Position already matches (we got orders from this position's book)
            // Direction already opposite (we got complementary orders)

            tempIds[count] = orderIds[i];
            count++;
        }

        // Resize to actual count
        compatibleIds = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            compatibleIds[i] = tempIds[i];
        }
    }

    /**
     * @notice Simulate cross-currency order matching with filtered compatible orders
     * @param compatibleOrderIds Array of compatible cross-currency order IDs
     * @param desiredAmount The amount the taker wants to trade
     * @param direction The taker's direction
     * @param quoteUnitPerPair Unit per pair for quote currency
     * @param crossCurrencyConfig The taker's cross-currency configuration
     * @return route The simulated match route
     */
    function _simulateCrossCurrencyWithOrders(
        uint256[] memory compatibleOrderIds,
        uint256 desiredAmount,
        LibDoefinStorage.OrderDirection direction,
        uint256 quoteUnitPerPair,
        LibDoefinStorage.CrossCurrencyConfig memory crossCurrencyConfig
    ) internal view returns (LibDoefinStorage.MatchOrderRoute memory route) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        if (compatibleOrderIds.length == 0) {
            // Return empty route
            route.matches = new LibDoefinStorage.Match[](0);
            route.totalInputAmount = 0;
            route.totalOutputAmount = 0;
            return route;
        }

        LibDoefinStorage.Match[] memory tempMatches = new LibDoefinStorage.Match[](compatibleOrderIds.length);
        uint256 remaining = desiredAmount;
        uint256 matchCount = 0;
        route.totalInputAmount = 0;
        route.totalOutputAmount = 0;

        // Iterate through compatible orders and simulate matches
        for (uint256 i = 0; i < compatibleOrderIds.length && remaining > 0; i++) {
            LibDoefinStorage.Order storage makerOrder = ds.orderbookStorage.orders[compatibleOrderIds[i]];

            // Calculate effective price in quote currency
            uint256 effectivePrice = _effectiveTakerPriceCrossCurrency(makerOrder, direction, LibDoefinStorage.MatchType.Complementary);

            // Determine fill amount
            uint256 fillAmount = remaining < makerOrder.remainingAmount ? remaining : makerOrder.remainingAmount;

            // Create match
            tempMatches[matchCount] = LibDoefinStorage.Match({
                matchedOrderId: makerOrder.orderId,
                matchType: LibDoefinStorage.MatchType.Complementary,
                amount: fillAmount,
                effectivePrice: effectivePrice
            });

            route.totalInputAmount += fillAmount;
            route.totalOutputAmount += Math.mulDiv(fillAmount, effectivePrice, quoteUnitPerPair);
            remaining -= fillAmount;
            matchCount++;
        }

        // Resize matches array to actual count
        route.matches = new LibDoefinStorage.Match[](matchCount);
        for (uint256 i = 0; i < matchCount; i++) {
            route.matches[i] = tempMatches[i];
        }

        return route;
    }
}
