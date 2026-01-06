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

    /// @notice Simulate a cross-currency market order
    /// @param positionId The position token ID to trade
    /// @param sharesOrBudgetAmount For BUY: collateral budget to spend. For SELL: token shares to sell
    /// @param direction The order direction (Buy or Sell)
    /// @param quoteCurrencyToken The quote currency token address
    /// @return route The match route with totalInputAmount and totalOutputAmount
    function simulateCrossCurrencyMarketOrder(
        uint256 positionId,
        uint256 sharesOrBudgetAmount,
        LibDoefinStorage.OrderDirection direction,
        address quoteCurrencyToken
    ) internal view returns (LibDoefinStorage.MatchOrderRoute memory route) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        if (quoteCurrencyToken == address(0)) revert Errors.InvalidQuoteCurrencyToken();

        // Validate quote currency is allowed
        if (ds.adminConfigStorage.unitPerPair[quoteCurrencyToken] == 0) revert Errors.TokenNotAllowed();

        // If the position is not registered yet, return an empty route instead of reverting
        bytes32 marketKey = ds.positionRegistry.marketKeyByPositionId[positionId];
        if (marketKey == bytes32(0)) {
            route.matches = new LibDoefinStorage.Match[](0);
            return route;
        }

        address collateralToken = ds.positionRegistry.marketsByKey[marketKey].collateralToken;
        if (collateralToken == address(0)) revert Errors.InvalidPositionId();

        // Create cross-currency data for simulation
        LibDoefinStorage.CrossCurrencyData memory crossCurrencyData = LibDoefinStorage.CrossCurrencyData({
            quoteCurrencyToken: quoteCurrencyToken,
            floorRate: 0 // No floor rate constraint for simulation
        });
        uint256 collateralUnit = ds.adminConfigStorage.unitPerPair[collateralToken];
        if (collateralUnit == 0) revert Errors.TokenNotAllowed();

        // Retrieve cross-currency books using unified approach
        (uint256[] storage complementaryOrders, uint256[] storage quoteOrders, LibDoefinStorage.MatchType siblingMatchType) = retrieveTheBooksAndMatchType(
            positionId,
            collateralToken,
            direction,
            crossCurrencyData,
            LibDoefinStorage.OrderType.Dynamic // Simulate as Dynamic order for oracle-based pricing
        );

        // Create simulation context
        LibDoefinStorage.SimulationContext memory simCtx = LibDoefinStorage.SimulationContext({
            complementaryOrders: complementaryOrders,
            mintOrMergeOrders: quoteOrders,
            siblingMatchType: siblingMatchType,
            direction: direction,
            collateralUnit: collateralUnit,
            sharesOrBudgetAmount: sharesOrBudgetAmount,
            matchCount: 0
        });

        return _simulateWithContext(simCtx);
    }

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
        address collateralToken = LibPositionRegistry.getCollateralToken(positionId);
        (complementaryOrders, mintOrMergeOrders, siblingMatchType) = retrieveTheBooksAndMatchType(
            positionId,
            collateralToken,
            direction,
            LibDoefinStorage.CrossCurrencyData(address(0), 0),
            LibDoefinStorage.OrderType.Standard
        );

        // Inline retrieveCollateralUnit

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

    function findPotentialMatchesForOrder(
        uint256 takerId,
        LibDoefinStorage.CrossCurrencyData memory crossCurrencyData,
        LibDoefinStorage.OrderType takerOrderType
    ) internal view returns (uint256[] memory makerIds) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        LibDoefinStorage.Order storage takerOrder = ds.orderbookStorage.orders[takerId];

        // Check oracle staleness for cross-currency orders at matching time
        if (takerOrderType != LibDoefinStorage.OrderType.Standard) {
            if (takerOrderType == LibDoefinStorage.OrderType.Dynamic) {
                if (LibQuoteCurrency.isOracleStale(crossCurrencyData.quoteCurrencyToken, takerOrder.collateralToken)) {
                    revert Errors.OraclePriceStale();
                }
            }
        }

        (
            uint256[] storage compOrders,
            uint256[] storage siblingOrQuoteBook,
            LibDoefinStorage.MatchType siblingMatchType
        ) = retrieveTheBooksAndMatchType(takerOrder.positionId, takerOrder.collateralToken, takerOrder.direction, crossCurrencyData, takerOrderType);

        if (compOrders.length == 0 && siblingOrQuoteBook.length == 0) {
            return makerIds;
        }

        makerIds = _findCrossingOrderIds(takerOrder, compOrders, siblingOrQuoteBook, siblingMatchType, takerOrderType);
    }

    /// @notice Find crossing orders for a taker order from two books
    /// @param takerOrder The taker order
    /// @param complementaryBook Complementary order IDs storage array
    /// @param siblingOrQuoteBook Sibling (mint/merge) or quote currency order IDs storage array based on match type
    /// @param matchType The match type for sibling orders
    /// @param takerOrderType The type of the taker order
    /// @return makerIds Array of crossing maker order IDs
    function _findCrossingOrderIds(
        LibDoefinStorage.Order memory takerOrder,
        uint256[] storage complementaryBook,
        uint256[] storage siblingOrQuoteBook,
        LibDoefinStorage.MatchType matchType,
        LibDoefinStorage.OrderType takerOrderType
    ) internal view returns (uint256[] memory makerIds) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        uint256 totalPotential = complementaryBook.length + siblingOrQuoteBook.length;
        uint256[] memory tempIds = new uint256[](totalPotential);
        uint256 remaining = takerOrder.remainingAmount;
        uint256 count = 0;
        uint256 i = 0;
        uint256 j = 0;

        // Cache taker price once (converted to quote currency if CC)
        uint256 takerPriceForComparison = _getTakerComparisonPrice(takerOrder, takerOrderType);

        while (remaining > 0 && (i < complementaryBook.length || j < siblingOrQuoteBook.length)) {
            bool compAvailable = i < complementaryBook.length;
            bool sibAvailable = j < siblingOrQuoteBook.length;

            LibDoefinStorage.Order memory complementaryOrder;
            LibDoefinStorage.Order memory siblingOrQuoteOrder;

            if (compAvailable) complementaryOrder = ds.orderbookStorage.orders[complementaryBook[i]];
            if (sibAvailable) siblingOrQuoteOrder = ds.orderbookStorage.orders[siblingOrQuoteBook[j]];

            bool compOrderValid = compAvailable && complementaryOrder.remainingAmount > 0;
            bool sibOrderValid = sibAvailable && siblingOrQuoteOrder.remainingAmount > 0;

            (LibDoefinStorage.Match memory execution, bool pickComp, bool exhausted) = _pickBestOrder(
                complementaryOrder,
                siblingOrQuoteOrder,
                compOrderValid,
                sibOrderValid,
                takerOrder.direction,
                matchType,
                takerOrderType,
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
            LibDoefinStorage.Order memory best = pickComp ? complementaryOrder : siblingOrQuoteOrder;
            (LibDoefinStorage.OrderType bestOrderType, ) = LibQuoteCurrency.getOrderTypeAndCCData(best.orderId);

            if (takerOrderType != LibDoefinStorage.OrderType.Standard) {
                // Cross-currency taker: only match with cross-currency makers
                if (bestOrderType == LibDoefinStorage.OrderType.Standard) {
                    if (pickComp) i++;
                    else j++;
                    continue;
                }

                // Check cross-currency compatibility (quote currency match)
                if (!_areOrdersCompatibleForCrossCurrency(takerOrder, best)) {
                    if (pickComp) i++;
                    else j++;
                    continue;
                }

                // Check floor rate validation for Dynamic orders
                if (bestOrderType == LibDoefinStorage.OrderType.Dynamic) {
                    LibDoefinStorage.CrossCurrencyData memory bestCCData = getCrossCurrencyData(best.orderId);
                    // Get current exchange rate and check against floor rate
                    (uint256 currentRate, bool isStale) = LibQuoteCurrency.getOracleExchangeRate(bestCCData.quoteCurrencyToken, best.collateralToken);
                    if (isStale) {
                        if (pickComp) i++;
                        else j++;
                        continue;
                    }

                    // Check floor rate constraint
                    if (best.direction == LibDoefinStorage.OrderDirection.Buy) {
                        // Buy order: current rate must be >= floor rate (floor is minimum acceptable)
                        if (currentRate < bestCCData.floorRate) {
                            if (pickComp) i++;
                            else j++;
                            continue;
                        }
                    } else {
                        // Sell order: current rate must be <= floor rate (floor is maximum acceptable)
                        if (currentRate > bestCCData.floorRate) {
                            if (pickComp) i++;
                            else j++;
                            continue;
                        }
                    }
                }
            } else {
                // Standard taker: only match with standard makers
                if (bestOrderType != LibDoefinStorage.OrderType.Standard) {
                    if (pickComp) i++;
                    else j++;
                    continue;
                }
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
    ) internal view returns (bool compatible) {
        // Use LibQuoteCurrency compatibility logic
        return LibQuoteCurrency.areOrdersCompatible(takerOrder, makerOrder);
    }

    /**
     * @notice Get cross-currency data for an order
     * @param orderId The order ID
     * @return ccData The cross-currency data (empty if standard order)
     */
    function getCrossCurrencyData(uint256 orderId) internal view returns (LibDoefinStorage.CrossCurrencyData memory ccData) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        return ds.orderbookStorage.crossCurrencyData[orderId];
    }

    function retrieveTheBooksAndMatchType(
        uint256 positionId,
        address collateralToken,
        LibDoefinStorage.OrderDirection direction,
        LibDoefinStorage.CrossCurrencyData memory crossCurrencyData,
        LibDoefinStorage.OrderType takerOrderType
    )
        internal
        view
        returns (uint256[] storage complementaryOrders, uint256[] storage mintOrMergeOrders, LibDoefinStorage.MatchType siblingMatchType)
    {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        bool isBuy = direction == LibDoefinStorage.OrderDirection.Buy;
        bytes32 positionBookId = keccak256(abi.encodePacked(positionId, collateralToken));

        if (takerOrderType == LibDoefinStorage.OrderType.Standard) {
            // Standard orders: Get complementary book with standard orders only
            complementaryOrders = isBuy
                ? ds.orderbookStorage.sellOrdersByPositionAndCurrency[positionBookId] // Buy YES → Sell YES (complementary)
                : ds.orderbookStorage.buyOrdersByPositionAndCurrency[positionBookId]; // Sell YES → Buy YES (complementary)

            // Get sibling position book for mint/merge
            uint256 complementPositionId = LibPositionRegistry.getComplement(positionId);
            bytes32 complementaryBookId = keccak256(abi.encodePacked(complementPositionId, collateralToken));

            if (isBuy) {
                mintOrMergeOrders = ds.orderbookStorage.buyOrdersByPositionAndCurrency[complementaryBookId]; // Buy NO → Mint YES
                siblingMatchType = LibDoefinStorage.MatchType.Mint;
            } else {
                mintOrMergeOrders = ds.orderbookStorage.sellOrdersByPositionAndCurrency[complementaryBookId]; // Sell NO → Merge YES
                siblingMatchType = LibDoefinStorage.MatchType.Merge;
            }
        } else {
            // Cross-currency orders: Get complementary book with cross-currency orders only
            complementaryOrders = isBuy
                ? ds.orderbookStorage.sellOrdersByPositionAndCurrency[positionBookId] // Buy YES → Sell YES (complementary)
                : ds.orderbookStorage.buyOrdersByPositionAndCurrency[positionBookId]; // Sell YES → Buy YES (complementary)

            // Get quote currency book (same position, quote currency)
            bytes32 quoteBookId = keccak256(abi.encodePacked(positionId, crossCurrencyData.quoteCurrencyToken));
            siblingMatchType = LibDoefinStorage.MatchType.CrossCurrency;
            mintOrMergeOrders = isBuy
                ? ds.orderbookStorage.sellOrdersByPositionAndCurrency[quoteBookId] // Buy YES → Sell YES (quote currency book)
                : ds.orderbookStorage.buyOrdersByPositionAndCurrency[quoteBookId]; // Sell YES → Buy YES (quote currency book)
        }
    }

    /**
     * @notice Get taker's price for comparison (in quote currency if cross-currency)
     * @dev For cross-currency orders:
     *      - Fixed: pricePerToken already in quote currency → use directly
     *      - Dynamic: pricePerToken in collateral currency → convert to quote currency
     *      For standard orders: use price as-is (in collateral)
     */
    function _getTakerComparisonPrice(LibDoefinStorage.Order memory takerOrder, LibDoefinStorage.OrderType takerType) private view returns (uint256) {
        if (takerType == LibDoefinStorage.OrderType.Standard) {
            // Standard: use price as-is (in collateral)
            return takerOrder.pricePerToken;
        }

        // Cross-currency orders: convert to quote currency
        if (takerType == LibDoefinStorage.OrderType.Fixed) {
            // Fixed: pricePerToken already in quote currency
            return takerOrder.pricePerToken;
        } else {
            // Dynamic: convert from collateral to quote currency using oracle
            (uint256 quotePrice, bool stale) = LibQuoteCurrency.calculateQuoteCurrencyPrice(takerOrder, true);

            if (stale) revert Errors.OraclePriceStale();

            return quotePrice;
        }
    }

    function _getBookIdForPositionAndCurrency(LibDoefinStorage.Order memory order) internal view returns (bytes32) {
        address pricingCurrency;
        (LibDoefinStorage.OrderType orderType, LibDoefinStorage.CrossCurrencyData memory ccData) = LibQuoteCurrency.getOrderTypeAndCCData(
            order.orderId
        );
        if (orderType != LibDoefinStorage.OrderType.Fixed) {
            // Standard or Dynamic: priced in collateral
            pricingCurrency = order.collateralToken;
        } else {
            // Fixed CC: priced in quote currency
            pricingCurrency = ccData.quoteCurrencyToken;
        }

        // STEP 2: Generate book key
        bytes32 bookId = keccak256(abi.encodePacked(order.positionId, pricingCurrency));

        return bookId;
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

        LibDoefinStorage.Order memory bestOrder = pickComp ? compOrder : sibOrder;
        LibDoefinStorage.MatchType bestOrderMatchType = pickComp ? LibDoefinStorage.MatchType.Complementary : siblingMatchType;
        uint256 bestPrice = pickComp ? effCompPrice : effSibPrice;

        uint256 fillAmount = remaining < bestOrder.remainingAmount ? remaining : bestOrder.remainingAmount;
        execution = LibDoefinStorage.Match({
            matchedOrderId: bestOrder.orderId,
            matchType: bestOrderMatchType,
            amount: fillAmount,
            effectivePrice: bestPrice
        });
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
            LibDoefinStorage.OrderType.Standard,
            remaining
        );
        if (!compAvailable && !sibAvailable) revert Errors.NoMatchableOrders();
    }

    struct MatchDecision {
        LibDoefinStorage.MatchType matchType;
        bool pickComp;
        bool exhausted;
    }

    function _lookupDecision(
        LibDoefinStorage.OrderType takerOrderType,
        uint8 availability,
        LibDoefinStorage.MatchType siblingMatchType
    ) internal pure returns (MatchDecision memory d) {
        if (availability == 0) {
            return MatchDecision(LibDoefinStorage.MatchType.None, false, true);
        }

        if (availability == 3) {
            return MatchDecision(LibDoefinStorage.MatchType.None, false, false); // defer to best-match
        }

        bool sibOnly = availability == 1;

        if (takerOrderType == LibDoefinStorage.OrderType.Standard) {
            return sibOnly ? MatchDecision(siblingMatchType, false, false) : MatchDecision(LibDoefinStorage.MatchType.Complementary, true, false);
        }

        // Cross-currency orders: all matches are CrossCurrency type
        if (sibOnly) {
            return MatchDecision(LibDoefinStorage.MatchType.CrossCurrency, false, false);
        }

        return MatchDecision(LibDoefinStorage.MatchType.CrossCurrency, true, false);
    }

    function _pickBestOrder(
        LibDoefinStorage.Order memory compOrder,
        LibDoefinStorage.Order memory sibOrder,
        bool compAvailable,
        bool sibAvailable,
        LibDoefinStorage.OrderDirection direction,
        LibDoefinStorage.MatchType siblingMatchType,
        LibDoefinStorage.OrderType takerOrderType,
        uint256 remaining
    ) internal view returns (LibDoefinStorage.Match memory execution, bool pickComp, bool exhausted) {
        uint8 availability = (compAvailable ? 2 : 0) | (sibAvailable ? 1 : 0);

        MatchDecision memory d = _lookupDecision(takerOrderType, availability, siblingMatchType);

        if (d.exhausted) {
            return (execution, false, true);
        }

        // Single-sided execution
        if (availability != 3) {
            return _singleExecution(d.pickComp ? compOrder : sibOrder, d.matchType, direction, remaining, d.pickComp);
        }

        // Both available → best match
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
        uint256 price = effectiveTakerPrice(
            order,
            direction,
            matchType == LibDoefinStorage.MatchType.None ? LibDoefinStorage.MatchType.Complementary : matchType
        );
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
    ///      - For Cross-Currency orders: returns price in quote currency units
    ///
    ///      Price calculation varies by match type:
    ///      1. Complementary matches: Uses maker's price directly (same position, opposite direction)
    ///      2. Mint/Merge matches: Uses complementary price (unitPerPair - maker's price) since
    ///         the taker is trading the opposite outcome
    ///      3. Cross-Currency: Always uses quote currency pricing to avoid recomputation in settlement
    ///
    /// @param makerOrder The maker order being matched against
    /// @param takerDirection The direction of the taker order (Buy or Sell)
    /// @param matchType The type of match (Complementary, Mint, Merge, or CrossCurrency)
    /// @return The effective price per token. For cross-currency: in quote currency units. For standard: in collateral token units
    function effectiveTakerPrice(
        LibDoefinStorage.Order memory makerOrder,
        LibDoefinStorage.OrderDirection takerDirection,
        LibDoefinStorage.MatchType matchType
    ) internal view returns (uint256) {
        (LibDoefinStorage.OrderType makerOrderType, ) = LibQuoteCurrency.getOrderTypeAndCCData(makerOrder.orderId);

        // Handle cross-currency orders
        if (makerOrderType != LibDoefinStorage.OrderType.Standard) {
            if (matchType != LibDoefinStorage.MatchType.Complementary && matchType != LibDoefinStorage.MatchType.CrossCurrency) {
                revert Errors.NonComplementaryCrossCurrencyMatch();
            }

            uint256 quoteCurrencyPrice;
            if (makerOrderType == LibDoefinStorage.OrderType.Fixed) {
                // Fixed: pricePerToken already in quote currency
                quoteCurrencyPrice = makerOrder.pricePerToken;
            } else {
                // Dynamic: convert from collateral to quote currency using oracle
                bool isStale;
                (quoteCurrencyPrice, isStale) = LibQuoteCurrency.calculateQuoteCurrencyPrice(makerOrder, true);

                if (isStale) {
                    revert Errors.OraclePriceStale();
                }
            }

            return _applyTakerFee(quoteCurrencyPrice, makerOrder.takerFeeBps, takerDirection == LibDoefinStorage.OrderDirection.Buy);
        }

        // Handle standard orders
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
}
