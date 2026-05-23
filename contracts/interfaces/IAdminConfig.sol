// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.20;

interface IAdminConfig {
    function addCollateralToken(address token, uint256 unitPerPair) external;

    function removeCollateralToken(address token) external;

    function setFeeReceiver(address feeReceiver) external;

    function setResolutionFeeBps(uint16 bps) external;

    function setMaxFeeRate(uint16 maxFeeRateBps) external;

    function getMaxFeeRate() external view returns (uint16);

    function isAllowedCollateral(address token) external view returns (bool);

    function getCollateralUnit(address token) external view returns (uint256);

    function getFees() external view returns (address feeReceiver, uint16 resolutionFeeBps);

    // ----------------------------------------
    // Token Symbol Management
    // ----------------------------------------

    /**
     * @notice Get token symbol for a given token address
     * @param token The token address
     * @return symbol The token symbol
     */
    function getTokenSymbol(address token) external view returns (string memory symbol);

    /**
     * @notice Update token symbol for a given token address
     * @param token The token address
     * @param symbol The new symbol
     */
    function setTokenSymbol(address token, string calldata symbol) external;
}
