// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.20;

interface IAccessControl {
    function addMarketMaker(address account) external;

    function removeMarketMaker(address account) external;

    function isMarketMaker(address account) external view returns (bool);
}
