// SPDX-License-Identifier: AGPL-3.0
// Uses shared storage derived from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {LibCollateralManager} from "./LibCollateralManager.sol";
import {LibFeeManager} from "./LibFeeManager.sol";
import {LibCrossCurrencySettlement} from "./LibCrossCurrencySettlement.sol";
import {LibMatchEngine} from "../libraries/LibMatchEngine.sol";
import {LibSettlement} from "../libraries/LibSettlement.sol";
import {LibQuoteCurrency} from "./LibQuoteCurrency.sol";
import {Errors} from "./Errors.sol";
import {Events} from "./Events.sol";

/// @title LibOrderbook - Handles creation, modification, and cancellation of orders
library LibOrderbook {
    using LibDoefinStorage for LibDoefinStorage.AppStorage;

    /**
     * @notice Creates a new order and handles collateral locking and order matching
     * @dev Main entry point for order creation - handles all order types and validation
     * @dev Determines order type based on crossCurrencyData configuration:
     *      - Standard: quoteCurrencyToken == address(0)
     *      - Fixed: quoteCurrencyToken != address(0) && floorRate == 0
     *      - Dynamic: quoteCurrencyToken != address(0) && floorRate > 0
     * @dev For limit orders, locks collateral immediately and adds to sorted orderbook
     * @dev For market orders, attempts immediate matching after creation
     * @param positionId ERC1155 token ID representing the outcome position
     * @param collateralToken ERC20 token address used for trading (e.g., USDC, WETH)
     * @param amount Total quantity of outcome tokens to trade
     * @param pricePerToken Price per token in appropriate denomination based on order type
     * @param minFillAmount Minimum fill size to prevent dust trades (0 = no minimum)
     * @param expiry Unix timestamp for order expiration (0 = no expiry)
     * @param fillOrKill If true, order must fill completely or be cancelled
     * @param direction Buy (provide collateral, get tokens) or Sell (provide tokens, get collateral)
     * @param executionType Market (immediate execution) or Limit (passive orderbook)
     * @param crossCurrencyData Configuration for cross-currency orders
     * @return orderId Unique identifier assigned to the created order
     * @custom:emits OrderCreated with complete order details including fees and type
     * @custom:reverts InvalidAmounts if amount < minFillAmount or amount == 0
     * @custom:reverts OrderCreatedWithPastExpiry if expiry is in the past
     * @custom:reverts TokenNotAllowed if collateral/quote token not whitelisted
     * @custom:reverts InvalidPrice if price is 0 or >= token unit
     * @custom:reverts OraclePriceStale for dynamic orders with stale oracle data
     * @custom:reverts SameCollateralAndQuoteCurrency if tokens match
     * @custom:gas Limit orders lock collateral; Market orders also attempt matching
     */
    function createOrder(
        uint256 positionId,
        address collateralToken,
        uint256 amount,
        uint256 pricePerToken,
        uint256 minFillAmount,
        uint32 expiry,
        bool fillOrKill,
        LibDoefinStorage.OrderDirection direction,
        LibDoefinStorage.ExecutionType executionType,
        LibDoefinStorage.CrossCurrencyData memory crossCurrencyData
    ) internal returns (uint256 orderId) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        LibDoefinStorage.OrderType orderType = _getOrderType(crossCurrencyData);

        if (orderType != LibDoefinStorage.OrderType.Standard) {
            uint256 quoteTokenUnitsPerPair = ds.adminConfigStorage.unitPerPair[crossCurrencyData.quoteCurrencyToken];
            if (quoteTokenUnitsPerPair == 0) revert Errors.InvalidQuoteCurrencyToken();
            if (crossCurrencyData.quoteCurrencyToken == collateralToken) revert Errors.SameCollateralAndQuoteCurrency();
        }

        if (amount < minFillAmount || amount == 0) revert Errors.InvalidAmounts();
        if (expiry != 0 && expiry <= block.timestamp) revert Errors.OrderCreatedWithPastExpiry();

        if (orderType != LibDoefinStorage.OrderType.Fixed) {
            uint256 unitsPerPair = ds.adminConfigStorage.unitPerPair[collateralToken];
            if (unitsPerPair == 0) revert Errors.TokenNotAllowed();
            if (pricePerToken >= unitsPerPair || pricePerToken == 0) revert Errors.InvalidPrice();
            if (orderType == LibDoefinStorage.OrderType.Dynamic) {
                if (LibQuoteCurrency.isOracleStale(crossCurrencyData.quoteCurrencyToken, collateralToken)) {
                    revert Errors.OraclePriceStale();
                }
                if (crossCurrencyData.floorRate == 0) {
                    revert Errors.InvalidFloorExchangeRate();
                }
            }
        } else {
            uint256 quoteUnitsPerPair = ds.adminConfigStorage.unitPerPair[crossCurrencyData.quoteCurrencyToken];
            if (quoteUnitsPerPair == 0) revert Errors.InvalidPrice();
        }
        orderId = ds.orderbookStorage.nextOrderId++;

        LibDoefinStorage.OrderFeeConfig memory orderFeeConfig = LibFeeManager.getMarketFees();

        LibDoefinStorage.Order memory order = LibDoefinStorage.Order({
            orderId: orderId,
            positionId: positionId,
            amount: amount,
            remainingAmount: amount,
            minFillAmount: minFillAmount,
            pricePerToken: pricePerToken,
            expiry: expiry,
            createdAt: uint32(block.timestamp),
            maker: msg.sender,
            direction: direction,
            executionType: executionType,
            active: true,
            fillOrKill: fillOrKill,
            collateralToken: collateralToken,
            makerFeeBps: orderFeeConfig.makerFeeBps,
            takerFeeBps: orderFeeConfig.takerFeeBps
        });

        bool isLimit = executionType == LibDoefinStorage.ExecutionType.Limit;
        if (isLimit) {
            address tokenAddress = collateralToken;
            uint256 floorPrice = pricePerToken;
            if (order.direction == LibDoefinStorage.OrderDirection.Buy) {
                if (orderType != LibDoefinStorage.OrderType.Standard) {
                    tokenAddress = crossCurrencyData.quoteCurrencyToken;
                    if (orderType == LibDoefinStorage.OrderType.Dynamic) {
                        floorPrice = LibCrossCurrencySettlement.calculateFloorPriceInQuoteForDynamicOrder(
                            order,
                            ds.adminConfigStorage.unitPerPair[order.collateralToken],
                            crossCurrencyData.floorRate
                        );
                    }
                }
                LibCollateralManager.lockERC20Collateral(order.maker, tokenAddress, order.amount, floorPrice, order.makerFeeBps);
            } else {
                LibCollateralManager.lockERC1155Collateral(order.maker, order.positionId, order.amount);
            }
        }

        ds.orderbookStorage.orders[orderId] = order;
        if (orderType != LibDoefinStorage.OrderType.Standard) {
            ds.orderbookStorage.crossCurrencyData[orderId] = crossCurrencyData;
        }

        if (isLimit) _insertSorted(order);

        emit Events.OrderCreated(
            orderId,
            msg.sender,
            positionId,
            collateralToken,
            amount,
            pricePerToken,
            minFillAmount,
            expiry,
            direction,
            executionType,
            fillOrKill,
            order.makerFeeBps,
            order.takerFeeBps,
            orderType,
            crossCurrencyData.quoteCurrencyToken,
            crossCurrencyData.floorRate
        );

        uint256[] memory makerIds = LibMatchEngine.findPotentialMatchesForOrder(orderId, crossCurrencyData, orderType);
        if (makerIds.length > 0) {
            LibSettlement.fillOrders(orderId, makerIds);
        }
    }

    function _getOrderType(LibDoefinStorage.CrossCurrencyData memory crossCurrencyData) internal pure returns (LibDoefinStorage.OrderType) {
        if (crossCurrencyData.quoteCurrencyToken == address(0)) {
            return LibDoefinStorage.OrderType.Standard;
        } else if (crossCurrencyData.floorRate == 0) {
            return LibDoefinStorage.OrderType.Fixed;
        } else {
            return LibDoefinStorage.OrderType.Dynamic;
        }
    }

    /**
     * @notice Cancels an active order and releases locked collateral
     * @dev Validates caller authorization and releases appropriate collateral type
     * @dev For buy orders: releases ERC20 collateral (collateral token or quote token)
     * @dev For sell orders: releases ERC1155 position tokens
     * @dev Handles collateral calculation for cross-currency orders with floor pricing
     * @dev Removes order from sorted orderbook and cleans up cross-currency data
     * @param orderId Unique identifier of the order to cancel
     * @param sender Address requesting cancellation (must be order maker)
     * @custom:emits OrderCancelled with order ID, sender, and remaining amount
     * @custom:reverts NotAuthorizedToCancel if sender is not the order maker
     * @custom:reverts OrderNotActive if order is already cancelled or filled
     * @custom:security Only order creator can cancel their own orders
     * @custom:gas Releases collateral locks and updates storage mappings
     */
    function cancelOrder(uint256 orderId, address sender) internal {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[orderId];
        if (order.maker != sender) revert Errors.NotAuthorizedToCancel();

        uint256 remainingAmount = order.remainingAmount;

        // Get order type to determine collateral release
        LibDoefinStorage.CrossCurrencyData memory ccData = getCrossCurrencyData(orderId);
        LibDoefinStorage.OrderType orderType = _getOrderType(ccData);

        address tokenAddress = order.collateralToken;
        uint256 floorPrice = order.pricePerToken;
        if (order.direction == LibDoefinStorage.OrderDirection.Buy) {
            if (orderType != LibDoefinStorage.OrderType.Standard) {
                tokenAddress = ccData.quoteCurrencyToken;
                if (orderType == LibDoefinStorage.OrderType.Dynamic) {
                    floorPrice = LibCrossCurrencySettlement.calculateFloorPriceInQuoteForDynamicOrder(
                        order,
                        ds.adminConfigStorage.unitPerPair[order.collateralToken],
                        ccData.floorRate
                    );
                }
            }
            LibCollateralManager.releaseERC20Collateral(order.maker, tokenAddress, order.remainingAmount, floorPrice, order.makerFeeBps);
        } else {
            LibCollateralManager.releaseERC1155Collateral(order.maker, order.positionId, order.remainingAmount);
        }
        removeOrderFromOrderbook(order);

        if (orderType != LibDoefinStorage.OrderType.Standard) {
            delete ds.orderbookStorage.crossCurrencyData[orderId];
        }

        delete ds.orderbookStorage.orders[orderId];

        emit Events.OrderCancelled(orderId, sender, remainingAmount);
    }

    /**
     * @notice Modifies parameters of an existing unfilled order
     * @dev Can only modify orders that haven't been partially filled
     * @dev Validates authorization and adjusts collateral based on parameter changes
     * @dev If price changes, removes and re-inserts order to maintain sorted orderbook
     * @dev Collateral adjustment handles both increases and decreases in requirements
     * @param maker Address of the order creator (authorization check)
     * @param orderId Unique identifier of the order to modify
     * @param newAmount New total order size in outcome tokens
     * @param newPricePerToken New price per token
     * @param newMinFillAmount New minimum fill amount (0 for no minimum)
     * @param newExpiry New expiry timestamp (0 for no expiry)
     * @custom:emits OrderModified with old and new parameter values
     * @custom:reverts NotAuthorizedToCancel if maker doesn't own the order
     * @custom:reverts OrderNotActive if order is cancelled or expired
     * @custom:reverts OrderExpired if current timestamp >= expiry
     * @custom:reverts PartiallyFilledOrdersNotModifiable if order has been partially filled
     * @custom:security Strict authorization - only order maker can modify
     * @custom:gas Price changes trigger orderbook re-sorting operations
     */
    function modifyOrder(
        address maker,
        uint256 orderId,
        uint256 newAmount,
        uint256 newPricePerToken,
        uint256 newMinFillAmount,
        uint32 newExpiry
    ) internal {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[orderId];

        if (order.maker != maker) revert Errors.NotAuthorizedToCancel();
        if (!order.active) revert Errors.OrderNotActive();
        if (order.expiry != 0 && block.timestamp >= order.expiry) revert Errors.OrderExpired();
        if (order.remainingAmount != order.amount) revert Errors.PartiallyFilledOrdersNotModifiable();

        LibDoefinStorage.ModifyCollateralContext memory modifyCtx = LibDoefinStorage.ModifyCollateralContext({
            positionId: order.positionId,
            oldAmount: order.amount,
            newAmount: newAmount,
            oldPrice: order.pricePerToken,
            newPrice: newPricePerToken,
            maker: maker,
            makerFeeBps: order.makerFeeBps,
            collateralToken: order.collateralToken,
            direction: order.direction
        });
        LibCollateralManager.adjustCollateralForModifiedOrder(modifyCtx);

        uint256 oldMinFill = order.minFillAmount;
        uint256 oldExpiry = order.expiry;

        order.amount = newAmount;
        order.remainingAmount = newAmount;
        order.pricePerToken = newPricePerToken;
        order.minFillAmount = newMinFillAmount;
        order.expiry = newExpiry;

        if (newPricePerToken != modifyCtx.oldPrice) {
            removeOrderFromOrderbook(order);
            _insertSorted(order);
        }

        emit Events.OrderModified(
            orderId,
            maker,
            modifyCtx.oldAmount,
            newAmount,
            modifyCtx.oldPrice,
            newPricePerToken,
            oldMinFill,
            newMinFillAmount,
            oldExpiry,
            newExpiry
        );
    }

    /**
     * @notice Get cross-currency data for an order
     * @param orderId The order ID
     * @return ccData The cross-currency data (empty if standard order)
     * @dev Returns zero-initialized struct for standard orders
     */
    function getCrossCurrencyData(uint256 orderId) internal view returns (LibDoefinStorage.CrossCurrencyData memory ccData) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        return ds.orderbookStorage.crossCurrencyData[orderId];
    }

    /**
     * @notice Check if an order is cross-currency
     * @param orderId The order ID
     * @return isCrossCurrency True if order has cross-currency data
     */
    function isCrossCurrencyOrder(uint256 orderId) internal view returns (bool) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        return ds.orderbookStorage.crossCurrencyData[orderId].quoteCurrencyToken != address(0);
    }

    /**
     * @notice Get order type by checking cross-currency data
     * @param orderId The order ID
     * @return orderType Standard, Fixed, or Dynamic
     */
    function getOrderType(uint256 orderId) internal view returns (LibDoefinStorage.OrderType) {
        LibDoefinStorage.CrossCurrencyData memory ccData = getCrossCurrencyData(orderId);
        return _getOrderType(ccData);
    }

    function _getBookIdForPositionAndCurrency(LibDoefinStorage.Order memory order) internal view returns (bytes32) {
        address pricingCurrency;
        LibDoefinStorage.OrderType orderType = getOrderType(order.orderId);
        LibDoefinStorage.CrossCurrencyData memory ccData = getCrossCurrencyData(order.orderId);
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

    function _insertSorted(LibDoefinStorage.Order memory order) internal {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        bytes32 bookId = _getBookIdForPositionAndCurrency(order);
        uint256[] storage book = order.direction == LibDoefinStorage.OrderDirection.Buy
            ? ds.orderbookStorage.buyOrdersByPositionAndCurrency[bookId]
            : ds.orderbookStorage.sellOrdersByPositionAndCurrency[bookId];

        uint256 price = order.pricePerToken;

        // Binary search for insertion index - O(log n)
        uint256 left = 0;
        uint256 right = book.length;

        while (left < right) {
            uint256 mid = (left + right) / 2;
            LibDoefinStorage.Order storage existingOrder = ds.orderbookStorage.orders[book[mid]];
            uint256 existingPrice = existingOrder.pricePerToken;

            // Ascending for Sell (lowest price first)
            // Descending for Buy (highest price first)
            bool shouldInsertBefore;
            if (price == existingPrice) {
                // Price-time priority: earlier orders come first
                shouldInsertBefore = order.createdAt < existingOrder.createdAt;
            } else {
                shouldInsertBefore =
                    (order.direction == LibDoefinStorage.OrderDirection.Sell && price < existingPrice) ||
                    (order.direction == LibDoefinStorage.OrderDirection.Buy && price > existingPrice);
            }

            if (shouldInsertBefore) {
                right = mid;
            } else {
                left = mid + 1;
            }
        }

        // Insert at position left
        book.push(order.orderId); // expand length
        for (uint256 j = book.length - 1; j > left; j--) {
            book[j] = book[j - 1];
        }
        book[left] = order.orderId;
    }

    /// @dev Remove an orderId from orderbook array
    function removeOrderFromOrderbook(LibDoefinStorage.Order memory order) internal {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        bytes32 bookId = _getBookIdForPositionAndCurrency(order);
        uint256[] storage book = order.direction == LibDoefinStorage.OrderDirection.Buy
            ? ds.orderbookStorage.buyOrdersByPositionAndCurrency[bookId]
            : ds.orderbookStorage.sellOrdersByPositionAndCurrency[bookId];

        uint256 len = book.length;

        for (uint256 i = 0; i < len; i++) {
            if (book[i] == order.orderId) {
                for (uint256 j = i; j < len - 1; j++) {
                    book[j] = book[j + 1];
                }
                book.pop();
                break;
            }
        }
    }
}
