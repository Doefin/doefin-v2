// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";

interface IMarketExecution {
    /// @notice Fill a market order using a precomputed match route
    /// @dev Caller must provide a route returned from simulateMarketOrder, and enforce slippage
    function fillMarketOrderWithRoute(
        uint256 positionId,
        uint256 amount,
        uint256 targetAvgPrice,
        bool fillOrKill,
        LibDoefinStorage.OrderDirection direction,
        LibDoefinStorage.Match[] calldata matches
    ) external;

    function fillOrders(uint256 takerId, uint256[] calldata makerIds) external;
}
