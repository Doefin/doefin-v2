// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibOrderbook} from "../libraries/LibOrderbook.sol";
import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {IOrderCreation} from "../interfaces/IOrderCreation.sol";

/**
 * @title OrderCreationFacet
 * @author Doefin
 * @notice Diamond facet for creating orders in the prediction market exchange
 * @dev This facet delegates order creation to LibOrderbook for actual implementation
 * @dev Part of the Diamond Standard (EIP-2535) modular contract architecture
 */
contract OrderCreationFacet is IOrderCreation {
    using LibDoefinStorage for LibDoefinStorage.AppStorage;

    /**
     * @notice Creates a new limit or market order for trading conditional tokens
     * @dev Delegates to LibOrderbook.createOrder for full implementation
     * @dev Supports both standard and cross-currency orders based on crossCurrencyData
     * @dev For standard orders: set crossCurrencyData.quoteCurrencyToken to address(0)
     * @dev Order execution depends on executionType:
     *      - Market: attempts immediate matching against existing orders
     *      - Limit: added to orderbook and waits for matches
     * @param positionId The ERC1155 token ID representing the outcome position to trade
     * @param collateralToken The ERC20 token address used as collateral (e.g., USDC, WETH)
     * @param amount Total amount of outcome tokens to buy/sell
     * @param pricePerToken Price per outcome token in collateral token units
     * @param minFillAmount Minimum amount that must be filled in a single transaction (0 for no minimum)
     * @param expiry Unix timestamp after which order expires (0 for no expiry)
     * @param fillOrKill If true, order must be completely filled immediately or cancelled
     * @param direction Whether this is a Buy (acquire tokens) or Sell (sell tokens) order
     * @param executionType Whether this is a Market (immediate) or Limit (queued) order
     * @param crossCurrencyData Configuration for cross-currency orders (quoteCurrencyToken, floorRate)
     * @custom:emits OrderCreated with full order details
     * @custom:security Validates order parameters and locks appropriate collateral before creation
     * @custom:gas Market orders consume additional gas for immediate matching attempts
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
    ) external override {
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
            crossCurrencyData
        );
    }
}
