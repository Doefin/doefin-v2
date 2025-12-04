// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {IRouteSimulation} from "../interfaces/IRouteSimulation.sol";
import {LibMatchEngine} from "../libraries/LibMatchEngine.sol";

contract RouteSimulationFacet is IRouteSimulation {
    /// @notice Simulate a market order and return the best match route without executing it
    /// @dev SELL path: shares → collateral revenue | BUY path: budget → shares received
    function simulateMarketOrder(
        uint256 positionId,
        uint256 sharesOrBudgetAmount,
        LibDoefinStorage.OrderDirection direction
    ) external view override returns (LibDoefinStorage.MatchOrderRoute memory) {
        return LibMatchEngine.simulateMarketOrder(positionId, sharesOrBudgetAmount, direction);
    }

    /// @notice Simulate a cross-currency market order and return the best match route without executing it
    /// @dev This function simulates matching against compatible cross-currency orders only
    ///      Cross-currency orders can only match complementary orders (no mint/merge)
    ///      Orders must have matching quote currencies and be on the same position
    /// @param positionId The position ID to trade
    /// @param amount The desired amount to trade
    /// @param direction Buy or Sell direction
    /// @param quoteCurrencyToken The quote currency token to match orders against
    /// @return The simulated match route with prices in quote currency
    function simulateCrossCurrencyMarketOrder(
        uint256 positionId,
        uint256 amount,
        LibDoefinStorage.OrderDirection direction,
        address quoteCurrencyToken
    ) external view override returns (LibDoefinStorage.MatchOrderRoute memory) {
        return LibMatchEngine.simulateCrossCurrencyMarketOrder(positionId, amount, direction, quoteCurrencyToken);
    }
}
