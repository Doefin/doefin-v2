// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {LibSettlement} from "../libraries/LibSettlement.sol";
import {IMarketExecution} from "../interfaces/IMarketExecution.sol";

/**
 * @title MarketExecutionFacet
 * @notice Refactored market execution facet using the new library architecture
 */
contract MarketExecutionFacet is IMarketExecution {

    /// @dev Caller must provide a route returned from simulateMarketOrder, and enforce slippage
    /// @notice Fill a market order by simulating match route and executing fill
    function fillMarketOrderWithRoute(
        uint256 positionId,
        uint256 amount,
        uint256 targetAvgPrice,
        bool fillOrKill,
        LibDoefinStorage.OrderDirection direction,
        LibDoefinStorage.MatchExecution[] calldata matches
    ) external {
        LibDoefinStorage.TakerOrderContext memory takerOrder = LibDoefinStorage.TakerOrderContext({
            taker: msg.sender,
            positionId: positionId,
            amount: amount,
            remainingAmount: amount,
            targetAvgPrice: targetAvgPrice,
            fillOrKill: fillOrKill,
            direction: direction
        });
        LibSettlement.executeMatchedRoute(takerOrder, matches);
    }

    /// @notice Match a limit order against multiple maker orders
    /// @param takerId Order ID of the taker order
    /// @param makerIds Array of maker order IDs to match against
    function fillLimitOrders(uint256 takerId, uint256[] calldata makerIds) external override {
        LibSettlement.fillLimitOrders(takerId, makerIds);
    }
}