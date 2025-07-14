// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

interface IOrderbook {
    event OrderCreated(uint indexed orderId, uint indexed positionId, uint price, uint amount, bool isBuy, address indexed maker);
    event OrderMatched(uint indexed orderId, address indexed taker, uint price, uint amount);
    event OrderCancelled(uint indexed orderId, address indexed maker);

    function createOrder(uint positionId, uint price, uint amount, bool isBuy) external returns (uint orderId);
    function matchOrder(uint orderId) external;
    function cancelOrder(uint orderId) external;
    function getOrder(uint orderId) external view returns (uint positionId, uint price, uint amount, bool isBuy, address maker);
    function getOrdersForPosition(uint positionId) external view returns (uint[] memory);
}