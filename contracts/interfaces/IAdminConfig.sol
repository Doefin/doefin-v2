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

    function getFees()
        external
        view
        returns (
            address feeReceiver,
            uint256 resolutionFeeBps,
            uint256 makerTradingFeeBps,
            uint256 takerTradingFeeBps
        );

    /**
     * @notice Withdraw accumulated protocol fees for a specific token
     * @param token The token to withdraw fees for
     * @param amount The amount to withdraw (0 = withdraw all)
     */
    function withdrawProtocolFees(address token, uint256 amount) external;

    /**
     * @notice Withdraw accumulated protocol fees to a specific recipient
     * @param token The token to withdraw fees for
     * @param amount The amount to withdraw (0 = withdraw all)
     * @param recipient The address to send fees to
     */
    function withdrawProtocolFeesTo(
        address token,
        uint256 amount,
        address recipient
    ) external;

    /**
     * @notice Withdraw all accumulated fees for a specific token
     * @param token The token to withdraw all fees for
     */
    function withdrawAllProtocolFees(address token) external;

    /**
     * @notice Withdraw all accumulated fees for a specific token to a specific recipient
     * @param token The token to withdraw all fees for
     * @param recipient The address to send fees to
     */
    function withdrawAllProtocolFeesTo(address token, address recipient) external;

    /**
     * @notice Batch withdraw fees for multiple tokens
     * @param tokens Array of token addresses
     * @param amounts Array of amounts to withdraw (0 = withdraw all for that token)
     */
    function batchWithdrawProtocolFees(address[] calldata tokens, uint256[] calldata amounts) external;

    /**
     * @notice Batch withdraw fees for multiple tokens to a specific recipient
     * @param tokens Array of token addresses
     * @param amounts Array of amounts to withdraw (0 = withdraw all for that token)
     * @param recipient The address to send fees to
     */
    function batchWithdrawProtocolFeesTo(
        address[] calldata tokens,
        uint256[] calldata amounts,
        address recipient
    ) external;

    // ----------------------------------------
    // NEW: Fee Query Functions
    // ----------------------------------------

    /**
     * @notice Get accumulated protocol fees for a token
     * @param token The token address
     * @return The accumulated fee amount
     */
    function getProtocolFeesBalance(address token) external view returns (uint256);

    /**
     * @notice Get accumulated fees for multiple tokens
     * @param tokens Array of token addresses
     * @return fees Array of accumulated fee amounts
     */
    function getProtocolFeesBalances(address[] calldata tokens) external view returns (uint256[] memory fees);

    /**
     * @notice Check if there are any fees available for withdrawal
     * @param token The token address
     * @return True if fees are available
     */
    function hasFeesAvailable(address token) external view returns (bool);

    /**
     * @notice Get comprehensive fee statistics for a token
     * @param token The token address
     * @return available The currently available fees
     * @return receiver The configured fee receiver
     */
    function getFeeStatistics(address token) external view returns (uint256 available, address receiver);

    /**
     * @notice Get total value of accumulated fees across all tokens
     * @param tokens Array of token addresses to sum
     * @return totalValue The total value (implementation dependent on price feeds)
     */
    function getTotalAccumulatedFeesValue(address[] calldata tokens) external view returns (uint256 totalValue);
}
