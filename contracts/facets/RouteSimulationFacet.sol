// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {IRouteSimulation} from "../interfaces/IRouteSimulation.sol";
import {LibMatchEngine} from "../libraries/LibMatchEngine.sol";
import {LibPositionRegistry} from "../libraries/LibPositionRegistry.sol";
import {Errors} from "../libraries/Errors.sol";

/**
 * @title RouteSimulationFacet
 * @author Doefin
 * @notice Diamond facet providing market order simulation capabilities without execution
 * @dev Implements IRouteSimulation interface for trade route analysis and market impact assessment
 * @dev Part of the Diamond pattern implementation enabling modular simulation functionality
 * @dev Delegates to LibMatchEngine for comprehensive market order simulation logic
 * @custom:facet Market order simulation and route analysis
 * @custom:diamond Part of the EIP-2535 Diamond Standard implementation
 * @custom:simulation View-only simulation without state changes or actual execution
 * @custom:delegation Uses LibMatchEngine for all simulation logic and calculations
 */
contract RouteSimulationFacet is IRouteSimulation {
    /**
     * @notice Simulates a market order execution and returns optimal match route without execution
     * @dev Unified simulation supporting both standard and cross-currency trading scenarios
     * @dev SELL simulation: calculates collateral revenue from selling position token shares
     * @dev BUY simulation: calculates position token shares received from collateral budget
     * @dev For standard orders: set crossCurrencyData.quoteCurrencyToken to address(0) to disable cross-currency
     * @dev For cross-currency orders: provide valid quoteCurrencyToken and floorRate configuration
     * @param positionId The position token ID to simulate trading for
     * @param sharesOrBudgetAmount For BUY orders: collateral budget to spend. For SELL orders: position token shares to sell
     * @param direction The order direction (Buy or Sell) for simulation
     * @param crossCurrencyData Cross-currency trading configuration. Use address(0) quoteCurrencyToken for standard orders
     * @return route Complete match route with totalInputAmount and totalOutputAmount calculations
     * @custom:simulation View-only operation with no state changes or actual trade execution
     * @custom:route Provides comprehensive route analysis including input/output amounts
     * @custom:cross-currency Supports both standard and cross-currency trading simulation
     * @custom:delegation Delegates to LibMatchEngine.simulateMarketOrder for implementation
     * @custom:gas Read-only operation optimized for efficient route calculation
     */
    function simulateMarketOrder(
        uint256 positionId,
        uint256 sharesOrBudgetAmount,
        LibDoefinStorage.OrderDirection direction,
        LibDoefinStorage.CrossCurrencyData memory crossCurrencyData
    ) external view override returns (LibDoefinStorage.MatchOrderRoute memory) {
        return LibMatchEngine.simulateMarketOrder(positionId, sharesOrBudgetAmount, direction, crossCurrencyData);
    }
}
