// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {LibERC1155} from "../libraries/LibERC1155.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

library LibEscrow {
    using SafeERC20 for IERC20;

    /// @notice Locks collateral or position tokens depending on order direction
    /// @dev For Buy: transfers ERC20 collateral to contract.
    ///      For Sell: transfers ERC1155 position token to contract.
    function lockEscrow(
        address from,
        uint256 amount,
        uint256 pricePerToken,
        uint256 positionId,
        address collateralToken,
        LibDoefinStorage.OrderDirection direction
    ) internal {
        if (direction == LibDoefinStorage.OrderDirection.Buy) {
            uint256 totalCost = amount * pricePerToken;
            IERC20(collateralToken).safeTransferFrom(from, address(this), totalCost);
        } else {
            LibERC1155.safeTransferFrom(address(this), from, address(this), positionId, amount, "");
        }
    }

    /// @notice Releases locked assets back to user (used for cancellations or order modifications)
    /// @dev Should only be callable after proper validation.
    function releaseEscrow(
        address to,
        uint256 amount,
        uint256 pricePerToken,
        uint256 positionId,
        address collateralToken,
        LibDoefinStorage.OrderDirection direction
    ) internal {
        if (direction == LibDoefinStorage.OrderDirection.Buy) {
            uint256 refund = amount * pricePerToken;
            IERC20(collateralToken).safeTransfer(to, refund);
        } else {
            LibERC1155.safeTransferFrom(address(this), address(this), to, positionId, amount, "");
        }
    }
}
