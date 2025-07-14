// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts


pragma solidity ^0.8.6;

interface IAdminConfig {
    event CollateralTokenAdded(address token, uint256 unitPerPair);
    event CollateralTokenRemoved(address token);
    event FeeReceiverUpdated(address newReceiver);
    event ResolutionFeeUpdated(uint256 newBps);
    event TradingFeesUpdated(uint256 makerBps, uint256 takerBps);

    function addCollateralToken(address token, uint256 unitPerPair) external;
    function removeCollateralToken(address token) external;
    function isAllowedCollateral(address token) external view returns (bool);
    function getCollateralUnit(address token) external view returns (uint256);
    function setFeeReceiver(address feeReceiver) external;
    function setResolutionFeeBps(uint256 bps) external;
    function setTradingFeesBps(uint256 makerBps, uint256 takerBps) external;
}
