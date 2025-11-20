// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibOrderbook} from "../libraries/LibOrderbook.sol";
import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {IOrderCreation} from "../interfaces/IOrderCreation.sol";

/**
 * @title OrderCreationFacet
 * @author Doefin
 * @notice Facet for creating new orders in the exchange
 * @dev This facet is part of the Diamond pattern implementation and handles order creation only
 *      Split from ExchangeFacet to reduce contract size below 24KB limit
 */
contract OrderCreationFacet is IOrderCreation {
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
}
