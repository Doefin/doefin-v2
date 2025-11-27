// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {LibCollateralManager} from "./LibCollateralManager.sol";
import {LibFeeManager} from "./LibFeeManager.sol";
import {Errors} from "./Errors.sol";

/**
 * @title LibEscrowLogic
 * @notice Refactored escrow logic that coordinates between specialized libraries
 * @dev This is the new version that replaces LibEscrowLogic with proper separation of concerns
 */
library LibEscrowLogic {
    // ----------------------------------------
    // Order Collateral Management
    // ----------------------------------------

    /**
     * @notice Lock collateral for an order (delegates to LibCollateralManager)
     * @param order The order to lock collateral for
     */
    function lockCollateral(LibDoefinStorage.Order memory order) internal {
        if (order.direction == LibDoefinStorage.OrderDirection.Buy) {
            LibCollateralManager.lockERC20Collateral(
                order.maker,
                order.collateralToken,
                order.amount,
                order.pricePerToken,
                order.orderFeeConfig.makerFeeBps
            );
        } else {
            LibCollateralManager.lockERC1155Collateral(order.maker, order.positionId, order.amount);
        }
    }

    /**
     * @notice Release collateral for an order (delegates to LibCollateralManager)
     * @param order The order to release collateral for
     */
    function releaseCollateral(LibDoefinStorage.Order memory order) internal {
        if (order.direction == LibDoefinStorage.OrderDirection.Buy) {
            LibCollateralManager.releaseERC20Collateral(
                order.maker,
                order.collateralToken,
                order.remainingAmount,
                order.pricePerToken,
                order.orderFeeConfig.makerFeeBps
            );
        } else {
            LibCollateralManager.releaseERC1155Collateral(order.maker, order.positionId, order.remainingAmount);
        }
    }

    /**
     * @notice Adjust collateral when an order is modified (delegates to LibCollateralManager)
     * @param modifyCtx The modification context
     */
    function adjustCollateralForModifiedOrder(LibDoefinStorage.ModifyCollateralContext memory modifyCtx) internal {
        LibCollateralManager.adjustCollateralForModifiedOrder(modifyCtx);
    }

    // ----------------------------------------
    // Fee Management Delegation
    // ----------------------------------------

    /**
     * @notice Get current market fees (delegates to LibFeeManager)
     * @return orderFeeConfig The current fee configuration
     */
    function getMarketFees() internal view returns (LibDoefinStorage.OrderFeeConfig memory orderFeeConfig) {
        return LibFeeManager.getMarketFees();
    }

    // ----------------------------------------
    // Enhanced Functionality
    // ----------------------------------------

    /**
     * @notice Get comprehensive escrow status for a user
     * @param user The user address
     * @param tokens Array of ERC20 tokens to check
     * @param positionIds Array of position IDs to check
     * @return erc20Balances Array of ERC20 collateral balances
     * @return erc1155Balances Array of ERC1155 collateral balances
     */
    function getEscrowStatus(
        address user,
        address[] memory tokens,
        uint256[] memory positionIds
    ) internal view returns (uint256[] memory erc20Balances, uint256[] memory erc1155Balances) {
        erc20Balances = new uint256[](tokens.length);
        erc1155Balances = new uint256[](positionIds.length);

        for (uint256 i = 0; i < tokens.length; i++) {
            erc20Balances[i] = LibCollateralManager.getERC20CollateralBalance(user, tokens[i]);
        }

        for (uint256 i = 0; i < positionIds.length; i++) {
            erc1155Balances[i] = LibCollateralManager.getERC1155CollateralBalance(user, positionIds[i]);
        }
    }
}
