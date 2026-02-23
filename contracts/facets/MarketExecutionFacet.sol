// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {LibSettlement} from "../libraries/LibSettlement.sol";
import {IMarketExecution} from "../interfaces/IMarketExecution.sol";

/**
 * @title MarketExecutionFacet
 * @author Doefin
 * @notice Diamond facet for market order execution and trade settlement operations
 * @dev Implements IMarketExecution interface for order matching and settlement functionality
 * @dev Part of the Diamond pattern implementation providing modular trading execution
 * @dev Delegates to LibSettlement for actual order matching and settlement logic
 * @custom:facet Market execution and trade settlement operations
 * @custom:diamond Part of the EIP-2535 Diamond Standard implementation
 * @custom:settlement Uses LibSettlement for all order matching and execution logic
 * @custom:trading Core trading functionality for limit order execution
 */
contract MarketExecutionFacet is IMarketExecution {
    /**
     * @notice Executes a limit order against multiple maker orders for efficient trade settlement
     * @dev Matches taker order against multiple maker orders in a single transaction
     * @dev Delegates to LibSettlement.fillOrders for comprehensive order matching logic
     * @dev Supports partial fills, cross-currency trading, and fee calculations
     * @param takerId The unique order ID of the taker order to execute
     * @param makerIds Array of maker order IDs to match against the taker order
     * @custom:execution Core order matching and settlement functionality
     * @custom:batch Supports matching against multiple maker orders efficiently
     * @custom:delegation Delegates to LibSettlement for all execution logic
     * @custom:settlement Handles collateral transfers, fee calculations, and position updates
     * @custom:emits Various settlement events via LibSettlement (OrderFilled, etc.)
     */
    /// @notice Match a limit order against multiple maker orders
    /// @param takerId Order ID of the taker order
    /// @param makerIds Array of maker order IDs to match against
    function fillOrders(uint256 takerId, uint256[] calldata makerIds) external override {
        LibSettlement.fillOrders(takerId, makerIds);
    }
}
