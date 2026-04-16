// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

interface IAdminConfig {
    function addCollateralToken(address token, uint256 unitPerPair) external;

    function removeCollateralToken(address token) external;

    function setFeeReceiver(address feeReceiver) external;

    function setResolutionFeeBps(uint16 bps) external;

    function setTradingFeesBps(uint16 makerBps, uint16 takerBps) external;

    function isAllowedCollateral(address token) external view returns (bool);

    function getCollateralUnit(address token) external view returns (uint256);

    function getFees() external view returns (address feeReceiver, uint16 resolutionFeeBps, uint16 makerTradingFeeBps, uint16 takerTradingFeeBps);

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

    /**
     * @notice Get oracle asset ID for cross-currency conversion
     * @param fromToken The source token address
     * @param toToken The target token address
     * @return assetIds Array of oracle asset IDs needed for conversion
     */
    function getCrossCurrencyConversionPath(address fromToken, address toToken) external view returns (bytes32[] memory assetIds);

    // ----------------------------------------
    // Conversion Path Management
    // ----------------------------------------

    /**
     * @notice Set a custom conversion path between two tokens
     * @param fromToken The source token address
     * @param toToken The target token address
     * @param assetIds Array of oracle asset IDs representing the conversion path
     * @dev Only callable by contract owner. Allows adding support for new currency pairs without code changes.
     */
    function setConversionPath(address fromToken, address toToken, bytes32[] calldata assetIds) external;

    /**
     * @notice Remove a custom conversion path between two tokens
     * @param fromToken The source token address
     * @param toToken The target token address
     * @dev Reverts to hardcoded fallback logic if available
     */
    function removeConversionPath(address fromToken, address toToken) external;

    /**
     * @notice Get the configured conversion path for a token pair
     * @param fromToken The source token address
     * @param toToken The target token address
     * @return assetIds The configured asset IDs, or empty array if not configured
     */
    function getConfiguredConversionPath(address fromToken, address toToken) external view returns (bytes32[] memory assetIds);
}
