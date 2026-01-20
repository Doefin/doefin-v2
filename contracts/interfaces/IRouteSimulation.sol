// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";

interface IRouteSimulation {
    /// @notice Simulate a market order and return the best match route without executing it
    /// @dev Unified simulation for both standard and cross-currency orders
    /// @dev Two distinct paths:
    ///      1. SELL: Input shares to sell → Output collateral revenue
    ///      2. BUY: Input collateral budget → Output shares received
    /// @dev For standard orders: set crossCurrencyData.quoteCurrencyToken to address(0)
    /// @dev For cross-currency orders: provide valid quoteCurrencyToken and floorRate
    /// @param positionId The position token ID to trade
    /// @param sharesOrBudgetAmount For BUY: collateral budget to spend (e.g., 100 USDC)
    ///                             For SELL: token shares to sell (e.g., 50 YES tokens)
    /// @param direction The order direction (Buy or Sell)
    /// @param crossCurrencyData Cross-currency configuration. Use address(0) quoteCurrencyToken for standard orders
    /// @return route The match route containing:
    ///               - matches: Array of matched orders with amounts and prices
    ///               - For BUY: totalInputAmount = shares received, totalOutputAmount = collateral spent
    ///               - For SELL: totalInputAmount = shares sold, totalOutputAmount = collateral received
    function simulateMarketOrder(
        uint256 positionId,
        uint256 sharesOrBudgetAmount,
        LibDoefinStorage.OrderDirection direction,
        LibDoefinStorage.CrossCurrencyData memory crossCurrencyData
    ) external view returns (LibDoefinStorage.MatchOrderRoute memory);
}
