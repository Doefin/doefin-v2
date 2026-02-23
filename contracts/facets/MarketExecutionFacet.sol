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
    /// @notice Match a limit order against multiple maker orders
    /// @param takerId Order ID of the taker order
    /// @param makerIds Array of maker order IDs to match against
    function fillOrders(uint256 takerId, uint256[] calldata makerIds) external override {
        LibSettlement.fillOrders(takerId, makerIds);
    }
}
