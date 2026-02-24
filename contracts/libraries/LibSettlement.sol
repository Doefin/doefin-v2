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

/**
 * @title LibSettlement
 * @author Doefin
 * @notice Library handling order execution and settlement logic for the prediction market
 * @dev Coordinates order matching, validation, and trade execution between takers and makers
 * @dev Supports both standard and cross-currency order settlement
 */
library LibSettlement {
    /**
     * @notice Executes order fills against multiple maker orders for a single taker
     * @dev Main entry point for order execution from MarketExecutionFacet
     * @dev Validates taker order, iterates through makers, and settles valid matches
     * @dev Handles partial fills, fee calculations, and state updates
     * @param takerId Unique identifier of the taker order being executed
     * @param makerIds Array of maker order IDs to attempt matching against
     * @custom:reverts OrderNotActive if taker order is inactive
     * @custom:reverts OrderExpired if taker order has expired
     * @custom:emits TradeFilled for each successful match with complete trade details
     * @custom:gas Iterates through maker orders; gas cost scales with array size
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
     * @notice Core order execution engine handling both market and limit order logic
     * @dev Iterates through maker orders, validates crossings, and executes settlements
     * @dev Applies market order affordability constraints and minimum fill requirements
     * @dev Handles fee calculations and state updates for matched orders
     * @dev Supports complementary, mint, merge, and cross-currency match types
     * @param takerOrder In-memory copy of taker order for execution
     * @param makerIds Array of potential maker order IDs to match against
     * @custom:note Market orders are subject to affordability constraints based on initial price
     * @custom:note Minimum fill amounts are checked for both taker and maker orders
     * @custom:gas Execution cost increases with number of makers and complexity of matches
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
                    takerOrder: takerOrder,
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
     * @notice Updates the stored taker order state after execution completion
     * @dev Calculates filled amount and updates remaining quantity
     * @dev Deactivates and removes fully filled orders from orderbook
     * @dev No-op if no fill occurred (filled amount == 0)
     * @param takerId Order identifier for the taker order
     * @param takerOrder Updated in-memory order state after execution
     * @custom:note Only updates storage if actual fills occurred
     * @custom:gas Minimal cost for partial fills; additional cost for orderbook removal
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

    /**
     * @notice Validates that an order is active and not expired
     * @dev Core validation used before executing order operations
     * @param order Storage reference to order being validated
     * @custom:reverts OrderNotActive if order.active == false
     * @custom:reverts OrderExpired if current timestamp >= expiry (when expiry > 0)
     * @custom:view Read-only validation with no state changes
     */
    function _validateOrder(LibDoefinStorage.Order storage order) internal view {
        if (!order.active) revert Errors.OrderNotActive();
        if (order.expiry != 0 && block.timestamp >= order.expiry) revert Errors.OrderExpired();
    }

    /**
     * @notice Updates maker order state after a successful fill and emits trade event
     * @dev Decreases remaining amount, deactivates if fully filled, removes from orderbook
     * @dev Calculates effective prices for both maker and taker sides
     * @dev Emits comprehensive TradeFilled event with all trade details
     * @param makerOrder Storage reference to maker order being filled
     * @param takerOrder In-memory taker order participating in trade
     * @param fillAmount Quantity of tokens being traded in this fill
     * @param takerEffectivePrice Price paid by taker (includes taker fees)
     * @param matchType Type of match (Complementary, Mint, Merge, CrossCurrency)
     * @custom:emits TradeFilled with complete trade details for off-chain indexing
     * @custom:note Maker effective price excludes taker fees for accurate maker pricing
     * @custom:gas Additional cost for orderbook removal when maker order fully filled
     */
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

    function _isCrossing(
        LibDoefinStorage.Order memory takerOrder,
        LibDoefinStorage.Order storage makerOrder
    ) internal view returns (bool crossing, LibDoefinStorage.MatchType matchType, uint256 price) {
        // Get order types to check if cross-currency
        (LibDoefinStorage.OrderType takerOrderType, ) = LibQuoteCurrency.getOrderTypeAndCCData(takerOrder.orderId);
        (LibDoefinStorage.OrderType makerOrderType, ) = LibQuoteCurrency.getOrderTypeAndCCData(makerOrder.orderId);

        // Use unified logic for both standard and cross-currency orders
        if (takerOrder.direction != makerOrder.direction) {
            if (takerOrder.positionId != makerOrder.positionId) {
                return (false, LibDoefinStorage.MatchType.Complementary, 0);
            }

            // Cross-currency orders can only do complementary matches
            if (takerOrderType != LibDoefinStorage.OrderType.Standard || makerOrderType != LibDoefinStorage.OrderType.Standard) {
                // Validate cross-currency compatibility
                if (takerOrderType != LibDoefinStorage.OrderType.Standard && makerOrderType != LibDoefinStorage.OrderType.Standard) {
                    if (!LibQuoteCurrency.areOrdersCompatible(takerOrder, makerOrder)) {
                        return (false, LibDoefinStorage.MatchType.Complementary, 0);
                    }
                }
                matchType = LibDoefinStorage.MatchType.CrossCurrency;
            } else {
                matchType = LibDoefinStorage.MatchType.Complementary;
            }
        } else {
            // Same direction: only standard orders can mint/merge
            if (takerOrderType != LibDoefinStorage.OrderType.Standard || makerOrderType != LibDoefinStorage.OrderType.Standard) {
                return (false, LibDoefinStorage.MatchType.Complementary, 0);
            }

            LibPositionRegistry.validateComplement(takerOrder.positionId, makerOrder.positionId);
            matchType = takerOrder.direction == LibDoefinStorage.OrderDirection.Buy
                ? LibDoefinStorage.MatchType.Mint
                : LibDoefinStorage.MatchType.Merge;
        }

        price = LibMatchEngine.effectiveTakerPrice(makerOrder, takerOrder.direction, matchType);

        if (takerOrder.executionType == LibDoefinStorage.ExecutionType.Market) {
            crossing = true;
        } else {
            // For cross-currency limit orders, compare in same currency domain
            uint256 takerPrice = takerOrder.pricePerToken;
            if (takerOrderType != LibDoefinStorage.OrderType.Standard) {
                // Convert taker price to quote currency for comparison
                if (takerOrderType == LibDoefinStorage.OrderType.Fixed) {
                    // Fixed: already in quote currency
                    takerPrice = takerOrder.pricePerToken;
                } else {
                    // Dynamic: convert from collateral to quote currency
                    bool stale;
                    (takerPrice, stale) = LibQuoteCurrency.calculateQuoteCurrencyPrice(takerOrder, true);
                    if (stale) return (false, matchType, 0);
                }
            }

            // Use a comparison price without taker fee for crossing checks to avoid false negatives
            // (execution price still includes taker fees for settlement calculations)
            uint256 comparisonPrice = price;

            if (takerOrderType != LibDoefinStorage.OrderType.Standard || makerOrderType != LibDoefinStorage.OrderType.Standard) {
                // Cross-currency: compare against maker price in quote currency without taker fee applied
                if (makerOrderType == LibDoefinStorage.OrderType.Fixed) {
                    comparisonPrice = makerOrder.pricePerToken;
                } else {
                    bool isStale;
                    (comparisonPrice, isStale) = LibQuoteCurrency.calculateQuoteCurrencyPrice(makerOrder, true);
                    if (isStale) return (false, matchType, 0);
                }
            }

            crossing = takerOrder.direction == LibDoefinStorage.OrderDirection.Buy ? takerPrice >= comparisonPrice : takerPrice <= comparisonPrice;
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
