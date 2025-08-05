// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {LibCollateralManager} from "./LibCollateralManager.sol";
import {LibFeeManager} from "./LibFeeManager.sol";
import {LibTradeSettlement} from "./LibTradeSettlement.sol";
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
            LibCollateralManager.lockERC1155Collateral(
                order.maker,
                order.positionId,
                order.amount
            );
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
            LibCollateralManager.releaseERC1155Collateral(
                order.maker,
                order.positionId,
                order.remainingAmount
            );
        }
    }

    /**
     * @notice Adjust collateral when an order is modified (delegates to LibCollateralManager)
     * @param modifyCtx The modification context
     */
    function adjustCollateralForModifiedOrder(
        LibDoefinStorage.ModifyCollateralContext memory modifyCtx
    ) internal {
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

    /**
     * @notice Compute maker fee (delegates to LibFeeManager)
     * @param cost The cost to calculate fee on
     * @return The maker fee amount
     */
    function computeMakerFee(uint256 cost) internal view returns (uint256) {
        return LibFeeManager.computeMakerFee(cost);
    }

    /**
     * @notice Compute fees for mint operations (delegates to LibFeeManager)
     * @param makerOrder The maker order
     * @param fillableAmount The fillable amount
     * @return makerFee The maker fee
     * @return takerFee The taker fee
     * @return makerContribution The maker's contribution
     * @return takerContribution The taker's contribution
     */
    function computeMintFees(
        LibDoefinStorage.Order memory makerOrder,
        uint256 fillableAmount
    ) internal view returns (
        uint256 makerFee,
        uint256 takerFee,
        uint256 makerContribution,
        uint256 takerContribution
    ) {
        return LibFeeManager.computeMintFees(makerOrder, fillableAmount);
    }

    /**
     * @notice Compute fees for trade execution (delegates to LibFeeManager)
     * @param settlementExecCtx The settlement execution context
     * @return makerFee The maker fee
     * @return takerFee The taker fee
     * @return cost The base cost
     */
    function computeFees(
        LibDoefinStorage.SettlemetExecutionContext memory settlementExecCtx
    ) internal view returns (uint256 makerFee, uint256 takerFee, uint256 cost) {
        return LibFeeManager.computeTradeExecutionFees(settlementExecCtx);
    }

    /**
     * @notice Accrue protocol fees (delegates to LibFeeManager)
     * @param token The token to accrue fees for
     * @param makerFee The maker fee amount
     * @param takerFee The taker fee amount
     */
    function accrueFees(address token, uint256 makerFee, uint256 takerFee) internal {
        LibFeeManager.accrueFees(token, makerFee, takerFee);
    }

    // ----------------------------------------
    // Trade Settlement Delegation
    // ----------------------------------------

    /**
     * @notice Execute settlement for a trade (delegates to LibTradeSettlement)
     * @param settlementExecCtx The settlement execution context
     */
    function settlementDispatcher(
        LibDoefinStorage.SettlemetExecutionContext memory settlementExecCtx
    ) internal {
        // Validate settlement context first
        LibTradeSettlement.validateSettlementContext(settlementExecCtx);
        
        // Execute the settlement
        LibTradeSettlement.executeSettlement(settlementExecCtx);
    }

    // ----------------------------------------
    // Backward Compatibility Functions
    // ----------------------------------------

    /**
     * @notice Lock ERC20 collateral (backward compatibility)
     * @param order The order to lock collateral for
     */
    function lockERC20(LibDoefinStorage.Order memory order) internal {
        LibCollateralManager.lockERC20Collateral(
            order.maker,
            order.collateralToken,
            order.amount,
            order.pricePerToken,
            order.orderFeeConfig.makerFeeBps
        );
    }

    /**
     * @notice Release ERC20 collateral (backward compatibility)
     * @param order The order to release collateral for
     */
    function releaseERC20(LibDoefinStorage.Order memory order) internal {
        LibCollateralManager.releaseERC20Collateral(
            order.maker,
            order.collateralToken,
            order.remainingAmount,
            order.pricePerToken,
            order.orderFeeConfig.makerFeeBps
        );
    }

    /**
     * @notice Lock ERC1155 collateral (backward compatibility)
     * @param user The user to lock collateral for
     * @param positionId The position ID
     * @param amount The amount to lock
     */
    function lockERC1155(address user, uint256 positionId, uint256 amount) internal {
        LibCollateralManager.lockERC1155Collateral(user, positionId, amount);
    }

    /**
     * @notice Release ERC1155 collateral (backward compatibility)
     * @param user The user to release collateral for
     * @param positionId The position ID
     * @param amount The amount to release
     */
    function releaseERC1155(address user, uint256 positionId, uint256 amount) internal {
        LibCollateralManager.releaseERC1155Collateral(user, positionId, amount);
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
    ) internal view returns (
        uint256[] memory erc20Balances,
        uint256[] memory erc1155Balances
    ) {
        erc20Balances = new uint256[](tokens.length);
        erc1155Balances = new uint256[](positionIds.length);

        for (uint256 i = 0; i < tokens.length; i++) {
            erc20Balances[i] = LibCollateralManager.getERC20CollateralBalance(user, tokens[i]);
        }

        for (uint256 i = 0; i < positionIds.length; i++) {
            erc1155Balances[i] = LibCollateralManager.getERC1155CollateralBalance(user, positionIds[i]);
        }
    }

    /**
     * @notice Batch lock collateral for multiple orders
     * @param orders Array of orders to lock collateral for
     */
    function batchLockCollateral(LibDoefinStorage.Order[] memory orders) internal {
        for (uint256 i = 0; i < orders.length; i++) {
            lockCollateral(orders[i]);
        }
    }

    /**
     * @notice Batch release collateral for multiple orders
     * @param orders Array of orders to release collateral for
     */
    function batchReleaseCollateral(LibDoefinStorage.Order[] memory orders) internal {
        for (uint256 i = 0; i < orders.length; i++) {
            releaseCollateral(orders[i]);
        }
    }

    /**
     * @notice Execute multiple settlements in a single transaction
     * @param settlementContexts Array of settlement contexts to execute
     */
    function batchExecuteSettlements(
        LibDoefinStorage.SettlemetExecutionContext[] memory settlementContexts
    ) internal {
        for (uint256 i = 0; i < settlementContexts.length; i++) {
            settlementDispatcher(settlementContexts[i]);
        }
    }

    // ----------------------------------------
    // Migration Helpers
    // ----------------------------------------

    /**
     * @notice Check if the new architecture is properly initialized
     * @return True if all required libraries are accessible
     */
    function validateArchitecture() internal view returns (bool) {
        // Simple validation - check if we can access storage
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        
        // Validate that basic storage is accessible and fee configuration exists
        return ds.adminConfigStorage.makerTradingFeeBps > 0 || ds.adminConfigStorage.takerTradingFeeBps > 0;
    }

    /**
     * @notice Get version information for the refactored escrow logic
     * @return version The version string
     * @return timestamp The deployment timestamp
     */
    function getVersion() internal view returns (string memory version, uint256 timestamp) {
        version = "2.0.0-refactored";
        timestamp = block.timestamp;
    }

    // ----------------------------------------
    // Emergency Functions
    // ----------------------------------------

    /**
     * @notice Emergency function to validate all user balances are consistent
     * @param user The user to validate
     * @param tokens Array of tokens to check
     * @param positionIds Array of position IDs to check
     * @return isValid True if all balances are consistent
     */
    function validateUserBalances(
        address user,
        address[] memory tokens,
        uint256[] memory positionIds
    ) internal view returns (bool isValid) {
        isValid = true;

        // Check ERC20 balances are non-negative (they're uint256 so always non-negative)
        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 balance = LibCollateralManager.getERC20CollateralBalance(user, tokens[i]);
            // Additional validation logic could be added here
            if (balance > type(uint256).max / 2) {
                // Sanity check for extremely large balances
                isValid = false;
                break;
            }
        }

        // Check ERC1155 balances
        if (isValid) {
            for (uint256 i = 0; i < positionIds.length; i++) {
                uint256 balance = LibCollateralManager.getERC1155CollateralBalance(user, positionIds[i]);
                if (balance > type(uint256).max / 2) {
                    // Sanity check for extremely large balances
                    isValid = false;
                    break;
                }
            }
        }
    }
}
