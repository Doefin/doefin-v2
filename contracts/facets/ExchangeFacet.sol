// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibOrderbook} from "../libraries/LibOrderbook.sol";
import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {LibEscrowLogic} from "../libraries/LibEscrowLogic.sol";
import {IExchange} from "../interfaces/IExchange.sol";

/**
 * @title ExchangeFacet
 * @author Doefin
 * @notice Exchange facet implementation for order management in the Doefin protocol
 * @dev This facet is part of the Diamond pattern implementation and handles order creation, cancellation, and modification
 *      It delegates core logic to library functions for better code organization and gas efficiency
 */
contract ExchangeFacet is IExchange {
    using LibDoefinStorage for LibDoefinStorage.AppStorage;

    /**
     * @notice Create a new order in the exchange
     * @dev Creates either a market or limit order for buying/selling conditional tokens
     *      Delegates to LibOrderbook.createOrder for actual implementation
     * @param positionId The ERC1155 position token ID to trade
     * @param collateralToken The address of the ERC20 token used as collateral (e.g., USDC, DAI)
     * @param amount The total amount of tokens to buy/sell (in position token units)
     * @param pricePerToken The price per position token in collateral units (e.g., 0.65 USDC per YES token)
     * @param minFillAmount The minimum amount that must be filled in a single transaction (0 for no minimum)
     * @param expiry The timestamp after which the order becomes invalid (0 for no expiry)
     * @param fillOrKill Whether the order should be cancelled if it cannot be completely filled immediately
     * @param direction Whether this is a Buy or Sell order
     * @param executionType Whether this is a Market or Limit order
     * @param orderType Whether this is a Standard or CrossCurrency order
     * @param crossCurrencyConfig Configuration for cross-currency orders (quote token, exchange rate, etc.)
     * @custom:emits OrderCreated event with order details
     * @custom:requirements Caller must have sufficient collateral balance and allowance
     */
    function createOrder(
        uint256 positionId,
        address collateralToken,
        uint256 amount,
        uint256 pricePerToken,
        uint256 minFillAmount,
        uint256 expiry,
        bool fillOrKill,
        LibDoefinStorage.OrderDirection direction,
        LibDoefinStorage.ExecutionType executionType,
        LibDoefinStorage.OrderType orderType,
        LibDoefinStorage.CrossCurrencyConfig memory crossCurrencyConfig
    ) external {
        LibOrderbook.createOrder(
            positionId,
            collateralToken,
            amount,
            pricePerToken,
            minFillAmount,
            expiry,
            fillOrKill,
            direction,
            executionType,
            orderType,
            crossCurrencyConfig
        );
    }

    /**
     * @notice Cancel an existing order by its unique identifier
     * @dev Only the order creator can cancel their own orders
     *      Delegates to LibOrderbook.cancelOrder for actual implementation
     * @param orderId The unique identifier of the order to cancel
     * @custom:emits OrderCancelled event with order ID
     * @custom:requirements Order must exist, be active, and caller must be the order creator
     */
    function cancelOrder(uint256 orderId) external {
        LibOrderbook.cancelOrder(orderId, msg.sender);
    }

    /**
     * @notice Modify parameters of an existing limit order
     * @dev Only limit orders can be modified, and only by their creator
     *      Delegates to LibOrderbook.modifyOrder for actual implementation
     * @param orderId The unique identifier of the order to modify
     * @param newAmount The new total amount for the order (in position token units)
     * @param newPricePerToken The new price per position token (in collateral units)
     * @param newMinFillAmount The new minimum fill amount (0 for no minimum)
     * @param newExpiry The new expiry timestamp (0 for no expiry)
     * @custom:emits OrderModified event with old and new order parameters
     * @custom:requirements Order must exist, be active, be a limit order, and caller must be the order creator
     */
    function modifyLimitOrder(uint256 orderId, uint256 newAmount, uint256 newPricePerToken, uint256 newMinFillAmount, uint256 newExpiry) external {
        LibOrderbook.modifyOrder(msg.sender, orderId, newAmount, newPricePerToken, newMinFillAmount, newExpiry);
    }

    /**
     * @notice Get the next order ID that will be assigned
     * @dev Returns the incremental counter for order IDs
     * @return The next order ID that will be used for new orders
     */
    function getNextOrderId() external view returns (uint256) {
        return LibDoefinStorage.appStorage().orderbookStorage.nextOrderId;
    }

    /**
     * @notice Retrieve details of a specific order
     * @dev Returns the complete Order struct for the given order ID
     * @param orderId The unique identifier of the order to retrieve
     * @return The Order struct containing all order details including amounts, prices, and configuration
     */
    function getOrder(uint256 orderId) external view returns (LibDoefinStorage.Order memory) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        return ds.orderbookStorage.orders[orderId];
    }

    /**
     * @notice Get all order IDs in the orderbook for a specific position and direction
     * @dev Returns an array of order IDs that can be used to fetch individual order details
     * @param positionId The ERC1155 position token ID to query
     * @param direction The order direction (Buy or Sell) to filter by
     * @return Array of order IDs in the orderbook for the specified position and direction
     */
    function getOrderbook(uint256 positionId, LibDoefinStorage.OrderDirection direction) external view returns (uint256[] memory) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        if (direction == LibDoefinStorage.OrderDirection.Buy) {
            return ds.orderbookStorage.buyOrdersByPosition[positionId];
        } else {
            return ds.orderbookStorage.sellOrdersByPosition[positionId];
        }
    }

    /**
     * @notice Batch retrieve multiple orders by their IDs
     * @dev More gas efficient than calling getOrder multiple times
     * @param orderIds Array of order IDs to retrieve
     * @return orders Array of Order structs corresponding to the provided order IDs
     */
    function getOrders(uint256[] calldata orderIds) external view returns (LibDoefinStorage.Order[] memory orders) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        orders = new LibDoefinStorage.Order[](orderIds.length);

        for (uint256 i = 0; i < orderIds.length; i++) {
            orders[i] = ds.orderbookStorage.orders[orderIds[i]];
        }
    }

    /**
     * @notice Get escrow status for a user across multiple tokens and positions
     * @dev Returns both ERC20 collateral balances and ERC1155 position token balances
     *      Useful for checking available balances before creating orders
     * @param user The address of the user to check escrow status for
     * @param tokens Array of ERC20 token addresses to check balances for
     * @param positionIds Array of ERC1155 position token IDs to check balances for
     * @return erc20Balances Array of ERC20 token balances in the escrow
     * @return erc1155Balances Array of ERC1155 position token balances in the escrow
     */
    function getUserEscrowStatus(
        address user,
        address[] calldata tokens,
        uint256[] calldata positionIds
    ) external view returns (uint256[] memory erc20Balances, uint256[] memory erc1155Balances) {
        return LibEscrowLogic.getEscrowStatus(user, tokens, positionIds);
    }
}
