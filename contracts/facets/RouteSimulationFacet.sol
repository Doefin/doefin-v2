// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {IRouteSimulation} from "../interfaces/IRouteSimulation.sol";
import {LibMatchEngine} from "../libraries/LibMatchEngine.sol";
import {LibPositionRegistry} from "../libraries/LibPositionRegistry.sol";
import {Errors} from "../libraries/Errors.sol";

contract RouteSimulationFacet is IRouteSimulation {
    /// @notice Simulate a market order and return the best match route without executing it
    /// @dev Unified simulation for both standard and cross-currency orders
    /// @dev SELL path: shares → collateral revenue | BUY path: budget → shares received
    /// @dev For standard orders: set crossCurrencyData.quoteCurrencyToken to address(0)
    /// @dev For cross-currency orders: provide valid quoteCurrencyToken and floorRate
    /// @param positionId The position token ID to trade
    /// @param sharesOrBudgetAmount For BUY: collateral budget to spend. For SELL: token shares to sell
    /// @param direction The order direction (Buy or Sell)
    /// @param crossCurrencyData Cross-currency configuration. Use address(0) quoteCurrencyToken for standard orders
    /// @return route The match route with totalInputAmount and totalOutputAmount
    function simulateMarketOrder(
        uint256 positionId,
        uint256 sharesOrBudgetAmount,
        LibDoefinStorage.OrderDirection direction,
        LibDoefinStorage.CrossCurrencyData memory crossCurrencyData
    ) external view override returns (LibDoefinStorage.MatchOrderRoute memory) {
        return LibMatchEngine.simulateMarketOrder(positionId, sharesOrBudgetAmount, direction, crossCurrencyData);
    }
}
