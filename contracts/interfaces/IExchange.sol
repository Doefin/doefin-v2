// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";

/**
 * @title IExchange
 * @author Doefin
 * @notice Interface for the Exchange facet that handles order creation, cancellation, and modification
 * @dev This interface is part of the Diamond pattern implementation for the Doefin protocol
 */
interface IExchange {
    /**
     * @notice Create a new order in the exchange
     * @dev Creates either a market or limit order for buying/selling conditional tokens
     * @param positionId The ERC1155 position token ID to trade
     * @param collateralToken The address of the ERC20 token used as collateral (e.g., USDC, DAI)
     * @param amount The total amount of tokens to buy/sell (in position token units)
     * @param pricePerToken The price per position token in collateral units (e.g., 0.65 USDC per YES token)
     * @param minFillAmount The minimum amount that must be filled in a single transaction (0 for no minimum)
     * @param expiry The timestamp after which the order becomes invalid (0 for no expiry)
     * @param fillOrKill Whether the order should be cancelled if it cannot be completely filled immediately
     * @param direction Whether this is a Buy or Sell order
     * @param executionType Whether this is a Market or Limit order
     * @param crossCurrencyData Configuration for cross-currency orders (quote token, exchange rate, etc.)
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
        LibDoefinStorage.CrossCurrencyData memory crossCurrencyData
    ) external;

    /**
     * @notice Cancel an existing order by its unique identifier
     * @dev Only the order creator can cancel their own orders
     * @param orderId The unique identifier of the order to cancel
     * @custom:emits OrderCancelled event with order ID
     * @custom:requirements Order must exist, be active, and caller must be the order creator
     */
    function cancelOrder(uint256 orderId) external;

    /**
     * @notice Modify parameters of an existing limit order
     * @dev Only limit orders can be modified, and only by their creator
     * @param orderId The unique identifier of the order to modify
     * @param newAmount The new total amount for the order (in position token units)
     * @param newPricePerToken The new price per position token (in collateral units)
     * @param newMinFillAmount The new minimum fill amount (0 for no minimum)
     * @param newExpiry The new expiry timestamp (0 for no expiry)
     * @custom:emits OrderModified event with old and new order parameters
     * @custom:requirements Order must exist, be active, be a limit order, and caller must be the order creator
     */
    function modifyLimitOrder(uint256 orderId, uint256 newAmount, uint256 newPricePerToken, uint256 newMinFillAmount, uint256 newExpiry) external;
}
