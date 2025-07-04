// SPDX-License-Identifier: MIT
pragma solidity ^0.8.6;

interface IAccessControl {
    function addMarketMaker(address account) external;

    function removeMarketMaker(address account) external;

    function isMarketMaker(address account) external view returns (bool);
}