// SPDX-License-Identifier: AGPL-3.0
// Uses shared storage derived from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {LibPositionRegistry} from "./LibPositionRegistry.sol";
import {LibMatchEngine} from "./LibMatchEngine.sol";
import {LibOrderbook} from "./LibOrderbook.sol";
import {LibTradeSettlement} from "./LibTradeSettlement.sol";
import {LibQuoteCurrency} from "./LibQuoteCurrency.sol";
import {Errors} from "./Errors.sol";
import {Events} from "./Events.sol";

library LibSettlement {
    /**
     * @notice Execute market order using precomputed route (for MarketExecutionFacet)
     */
    function executeMatchedRoute(LibDoefinStorage.TakerOrderContext memory takerOrderCtx, LibDoefinStorage.Match[] memory matches) internal {
        _executeMatches(takerOrderCtx, matches, LibDoefinStorage.ExecutionType.Market);
    }

    /**
     * @notice Fill orders against maker orders (for ExchangeFacet via LibOrderbook)
     */
    function fillOrders(uint256 takerId, uint256[] memory makerIds) internal {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        LibDoefinStorage.Order storage takerOrderStorage = ds.orderbookStorage.orders[takerId];
        _validateOrder(takerOrderStorage);

        // Build taker context from stored order
        LibDoefinStorage.TakerOrderContext memory takerOrderCtx = LibDoefinStorage.TakerOrderContext({
            orderId: takerOrderStorage.orderId,
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
        LibDoefinStorage.Match[] memory matches = _generateMatches(takerOrderCtx, takerOrderStorage, makerIds);
        _executeMatches(takerOrderCtx, matches, takerOrderStorage.executionType);
        _updateStoredTakerOrder(takerId, takerOrderCtx);
    }

    // ========================================
    // INTERNAL EXECUTION ENGINE
    // ========================================

    /**
     * @notice Unified execution engine for both market and limit orders
     */
    function _executeMatches(
        LibDoefinStorage.TakerOrderContext memory takerOrderCtx,
        LibDoefinStorage.Match[] memory matches,
        LibDoefinStorage.ExecutionType executionType
    ) internal {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        uint256 totalValue = 0;

        for (uint256 i = 0; i < matches.length && takerOrderCtx.remainingAmount > 0; ++i) {
            LibDoefinStorage.Match memory matchExec = matches[i];
            LibDoefinStorage.Order storage makerOrder = ds.orderbookStorage.orders[matchExec.matchedOrderId];
            uint256 collateralUnit = ds.adminConfigStorage.unitPerPair[makerOrder.collateralToken];

            _validateOrder(makerOrder);

            // Validate crossing and get effective price
            (bool crossing, LibDoefinStorage.MatchType matchType, uint256 effectivePrice) = _isCrossing(takerOrderCtx, executionType, makerOrder);
            if (!crossing) revert Errors.NotCrossingPrices();

            if (takerOrderCtx.remainingAmount == 0) {
                break; // Order fully filled
            }
            // Use pre-calculated fill amount, but double-check current state
            uint256 fillableAmount = _min(matchExec.amount, _min(takerOrderCtx.remainingAmount, makerOrder.remainingAmount));

            if (fillableAmount == 0) continue;

            // Update states
            takerOrderCtx.remainingAmount -= fillableAmount;
            totalValue += (fillableAmount * effectivePrice) / collateralUnit;
            _updateOrderAfterFill(makerOrder, takerOrderCtx, fillableAmount, effectivePrice, matchType);

            // Execute settlement
            LibTradeSettlement.settlementDispatcher(_buildSettlementCtx(fillableAmount, takerOrderCtx, makerOrder, matchType, executionType));

            // Emit market order events
            if (executionType == LibDoefinStorage.ExecutionType.Market) {
                emit Events.MarketOrderMatch(
                    takerOrderCtx.taker, // taker
                    takerOrderCtx.positionId, // positionId
                    makerOrder.orderId, // makerOrderId
                    makerOrder.maker, // maker
                    takerOrderCtx.orderId, // takerOrderId (0 for market orders)
                    fillableAmount, // fillAmount
                    effectivePrice, // pricePerToken
                    matchType, // matchType
                    takerOrderCtx.direction // direction
                );
            }
        }

        // Handle market order completion
        if (executionType == LibDoefinStorage.ExecutionType.Market) {
            if (takerOrderCtx.fillOrKill && takerOrderCtx.remainingAmount > 0) {
                revert Errors.FillOrKillFailed();
            }
            emit Events.MarketOrderExecuted(
                takerOrderCtx.taker,
                takerOrderCtx.positionId,
                takerOrderCtx.direction,
                takerOrderCtx.amount,
                takerOrderCtx.amount - takerOrderCtx.remainingAmount,
                totalValue
            );
        }
    }

    /**
     * @notice Generate valid match executions with constraints
     */
    function _generateMatches(
        LibDoefinStorage.TakerOrderContext memory takerOrderCtx,
        LibDoefinStorage.Order storage takerOrderStorage,
        uint256[] memory makerIds
    ) internal view returns (LibDoefinStorage.Match[] memory matches) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        LibDoefinStorage.Match[] memory tempMatches = new LibDoefinStorage.Match[](makerIds.length);
        uint256 matchCount = 0;
        uint256 totalValue = 0;
        uint256 tempRemainingAmount = takerOrderCtx.remainingAmount;

        for (uint256 i = 0; i < makerIds.length && tempRemainingAmount > 0; i++) {
            LibDoefinStorage.Order storage makerOrder = ds.orderbookStorage.orders[makerIds[i]];
            _validateOrder(makerOrder);

            (bool crossing, LibDoefinStorage.MatchType matchType, uint256 effectivePrice) = _isCrossing(
                takerOrderCtx,
                takerOrderStorage.executionType,
                makerOrder
            );
            if (!crossing) continue;

            uint256 fillAmount = _min(tempRemainingAmount, makerOrder.remainingAmount);
            if (fillAmount == 0) continue;

            // Apply market order affordability constraints
            if (takerOrderStorage.executionType == LibDoefinStorage.ExecutionType.Market) {
                uint256 collateralUnit = ds.adminConfigStorage.unitPerPair[makerOrder.collateralToken];
                uint256 affordableAmount = _computeMaxFillableAtPrice(
                    takerOrderCtx.targetAvgPrice,
                    totalValue,
                    effectivePrice,
                    collateralUnit,
                    takerOrderCtx.amount - tempRemainingAmount,
                    takerOrderCtx.direction == LibDoefinStorage.OrderDirection.Buy
                );
                fillAmount = _min(affordableAmount, fillAmount);
            }

            // Check minimum fill amounts
            if (
                fillAmount == 0 ||
                (fillAmount < takerOrderStorage.minFillAmount && tempRemainingAmount == takerOrderCtx.amount) ||
                (fillAmount < makerOrder.minFillAmount && makerOrder.remainingAmount == makerOrder.amount)
            ) {
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

            if (takerOrderStorage.executionType == LibDoefinStorage.ExecutionType.Market) {
                uint256 collateralUnit = ds.adminConfigStorage.unitPerPair[makerOrder.collateralToken];
                totalValue += (fillAmount * effectivePrice) / collateralUnit;
            }
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
    function _updateStoredTakerOrder(uint256 takerId, LibDoefinStorage.TakerOrderContext memory takerOrderCtx) internal {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        LibDoefinStorage.Order storage takerOrder = ds.orderbookStorage.orders[takerId];

        uint256 filledAmount = takerOrder.remainingAmount - takerOrderCtx.remainingAmount;
        if (filledAmount == 0) return;

        takerOrder.remainingAmount = takerOrderCtx.remainingAmount;

        if (takerOrder.remainingAmount == 0) {
            takerOrder.active = false;
            LibOrderbook.removeOrderFromOrderbook(takerOrder);
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
        LibDoefinStorage.Order storage makerOrder,
        LibDoefinStorage.TakerOrderContext memory takerOrderCtx,
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
            takerOrderCtx.orderId,
            makerOrder.maker,
            takerOrderCtx.taker,
            takerOrderCtx.positionId,
            makerOrder.positionId,
            makerOrder.collateralToken,
            fillAmount,
            makerEffectivePrice,
            takerEffectivePrice,
            matchType,
            makerOrder.remainingAmount,
            takerOrderCtx.remainingAmount,
            makerComplete,
            takerOrderCtx.remainingAmount == 0,
            block.timestamp
        );
    }

    function _buildSettlementCtx(
        uint256 fillableAmount,
        LibDoefinStorage.TakerOrderContext memory takerOrderCtx,
        LibDoefinStorage.Order storage makerOrder,
        LibDoefinStorage.MatchType matchType,
        LibDoefinStorage.ExecutionType executionType
    ) internal pure returns (LibDoefinStorage.SettlementExecutionContext memory) {
        return
            LibDoefinStorage.SettlementExecutionContext({
                fillableAmount: fillableAmount,
                takerOrder: takerOrderCtx,
                makerOrder: makerOrder,
                matchType: matchType,
                executionType: executionType
            });
    }

    function _isCrossing(
        LibDoefinStorage.TakerOrderContext memory takerOrderCtx,
        LibDoefinStorage.ExecutionType executionType,
        LibDoefinStorage.Order storage makerOrder
    ) internal view returns (bool crossing, LibDoefinStorage.MatchType matchType, uint256 price) {
        // Cross-currency orders validation
        if (_isCrossCurrencyTrade(takerOrderCtx.orderId, makerOrder.orderId)) {
            return _validateCrossCurrencyMatch(takerOrderCtx, executionType, makerOrder);
        }

        // Standard order logic (unchanged)
        // Determine match type
        if (takerOrderCtx.direction != makerOrder.direction) {
            if (takerOrderCtx.positionId != makerOrder.positionId) {
                return (false, LibDoefinStorage.MatchType.Complementary, 0);
            }
            matchType = LibDoefinStorage.MatchType.Complementary;
        } else {
            LibPositionRegistry.validateComplement(takerOrderCtx.positionId, makerOrder.positionId);
            matchType = takerOrderCtx.direction == LibDoefinStorage.OrderDirection.Buy
                ? LibDoefinStorage.MatchType.Mint
                : LibDoefinStorage.MatchType.Merge;
        }

        price = LibMatchEngine.effectiveTakerPrice(makerOrder, takerOrderCtx.direction, matchType);

        // Check price crossing
        if (executionType == LibDoefinStorage.ExecutionType.Market) {
            crossing = true;
        } else {
            crossing = takerOrderCtx.direction == LibDoefinStorage.OrderDirection.Buy
                ? takerOrderCtx.targetAvgPrice >= price
                : takerOrderCtx.targetAvgPrice <= price;
        }
    }

    function _getOrderMaker(uint256 orderId) internal view returns (address) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
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

    // ========================================
    // CROSS-CURRENCY SETTLEMENT HELPERS
    // ========================================

    /**
     * @notice Check if either order in the trade is cross-currency
     * @param takerOrderId The taker order ID
     * @param makerOrderId The maker order ID
     * @return isCrossCurrency Whether this is a cross-currency trade
     */
    function _isCrossCurrencyTrade(uint256 takerOrderId, uint256 makerOrderId) internal view returns (bool isCrossCurrency) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        // Check taker order (if it's not a market order with ID 0)
        bool takerIsCrossCurrency = false;
        if (takerOrderId != 0) {
            LibDoefinStorage.Order storage takerOrder = ds.orderbookStorage.orders[takerOrderId];
            takerIsCrossCurrency = (takerOrder.orderType == LibDoefinStorage.OrderType.CrossCurrency);
        }

        // Check maker order
        LibDoefinStorage.Order storage makerOrder = ds.orderbookStorage.orders[makerOrderId];
        bool makerIsCrossCurrency = (makerOrder.orderType == LibDoefinStorage.OrderType.CrossCurrency);

        return takerIsCrossCurrency || makerIsCrossCurrency;
    }

    /**
     * @notice Validate cross-currency order matching and calculate quote currency pricing
     * @param takerOrderCtx The taker order context
     * @param executionType The execution type
     * @param makerOrder The maker order storage
     * @return crossing Whether orders cross
     * @return matchType The match type (only Complementary for cross-currency)
     * @return price The effective price in quote currency
     */
    function _validateCrossCurrencyMatch(
        LibDoefinStorage.TakerOrderContext memory takerOrderCtx,
        LibDoefinStorage.ExecutionType executionType,
        LibDoefinStorage.Order storage makerOrder
    ) internal view returns (bool crossing, LibDoefinStorage.MatchType matchType, uint256 price) {
        // Cross-currency orders only support complementary matching
        if (takerOrderCtx.direction == makerOrder.direction || takerOrderCtx.positionId != makerOrder.positionId) {
            return (false, LibDoefinStorage.MatchType.Complementary, 0);
        }

        matchType = LibDoefinStorage.MatchType.Complementary;

        // Get the stored order for cross-currency validation
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        bool takerIsCrossCurrency = false;
        LibDoefinStorage.Order memory takerOrderForValidation;

        if (takerOrderCtx.orderId != 0) {
            LibDoefinStorage.Order storage takerStoredOrder = ds.orderbookStorage.orders[takerOrderCtx.orderId];
            takerIsCrossCurrency = (takerStoredOrder.orderType == LibDoefinStorage.OrderType.CrossCurrency);
            takerOrderForValidation = takerStoredOrder; // Copy to memory for validation
        }

        // Validate cross-currency compatibility
        if (takerIsCrossCurrency && makerOrder.orderType == LibDoefinStorage.OrderType.CrossCurrency) {
            // Both are cross-currency - check compatibility
            if (!LibQuoteCurrency.areOrdersCompatible(takerOrderForValidation, makerOrder)) {
                return (false, matchType, 0);
            }
        } else if (!takerIsCrossCurrency && makerOrder.orderType == LibDoefinStorage.OrderType.CrossCurrency) {
            // Standard taker with cross-currency maker - not allowed
            return (false, matchType, 0);
        } else if (takerIsCrossCurrency && makerOrder.orderType != LibDoefinStorage.OrderType.CrossCurrency) {
            // Cross-currency taker with standard maker - not allowed
            return (false, matchType, 0);
        }

        // Calculate price in quote currency for cross-currency orders
        // Note: At this point, makerOrder MUST be CrossCurrency type due to validation above
        // Mixed order types were rejected at lines 408-415
        if (makerOrder.orderType == LibDoefinStorage.OrderType.CrossCurrency) {
            // Determine if we should use oracle rate or fixed rate
            bool useOracleRate = (makerOrder.crossCurrencyConfig.exchangeRateType == LibDoefinStorage.ExchangeRateType.Dynamic);

            // Calculate quote currency price
            (uint256 quoteCurrencyPrice, bool isStale) = LibQuoteCurrency.calculateQuoteCurrencyPrice(makerOrder, useOracleRate);

            // For dynamic rates, check oracle staleness
            if (useOracleRate && isStale) {
                return (false, matchType, 0); // Don't match with stale oracle
            }

            // Apply taker fee to get effective price
            if (takerOrderCtx.direction == LibDoefinStorage.OrderDirection.Buy) {
                price = (quoteCurrencyPrice * (10_000 + makerOrder.orderFeeConfig.takerFeeBps)) / 10_000;
            } else {
                price = (quoteCurrencyPrice * (10_000 - makerOrder.orderFeeConfig.takerFeeBps)) / 10_000;
            }
        } else {
            // This should be unreachable - mixed order types were rejected above
            // If we reach here, there's a logic error in the validation flow
            revert Errors.InvalidOrderType();
        }

        // Check price crossing
        if (executionType == LibDoefinStorage.ExecutionType.Market) {
            crossing = true;
        } else {
            crossing = takerOrderCtx.direction == LibDoefinStorage.OrderDirection.Buy
                ? takerOrderCtx.targetAvgPrice >= price
                : takerOrderCtx.targetAvgPrice <= price;
        }
    }
}
