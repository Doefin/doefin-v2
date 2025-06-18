// SPDX-License-Identifier: MIT
pragma solidity ^0.8.6;

interface ICollateralVault {
    event CollateralLocked(address indexed user, address indexed token, uint amount);
    event CollateralReleased(address indexed user, address indexed token, uint amount);

    function lockCollateral(address user, address token, uint amount) external;
    function releaseCollateral(address user, address token, uint amount) external;
    function getLockedBalance(address user, address token) external view returns (uint);
}