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
}
