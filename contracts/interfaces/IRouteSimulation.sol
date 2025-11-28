// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";

interface IRouteSimulation {
    /// @notice Simulate a market order and return the best match route without executing it
    function simulateMarketOrder(
        uint256 positionId,
        uint256 amount,
        LibDoefinStorage.OrderDirection direction
    ) external view returns (LibDoefinStorage.MatchOrderRoute memory);

    /// @notice Simulate a cross-currency market order and return the best match route without executing it
    /// @param positionId The position ID to trade
    /// @param amount The desired amount to trade
    /// @param direction Buy or Sell direction
    /// @param crossCurrencyConfig Cross-currency configuration (quote token, exchange rate, etc.)
    /// @return route The simulated match route with compatible cross-currency orders
    function simulateCrossCurrencyMarketOrder(
        uint256 positionId,
        uint256 amount,
        LibDoefinStorage.OrderDirection direction,
        LibDoefinStorage.CrossCurrencyConfig memory crossCurrencyConfig
    ) external view returns (LibDoefinStorage.MatchOrderRoute memory);
}
