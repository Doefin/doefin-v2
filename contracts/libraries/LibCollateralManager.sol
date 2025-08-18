// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {LibERC1155} from "./LibERC1155.sol";
import {LibReentrancyGuard} from "./LibReentrancyGuard.sol";
import {Errors} from "./Errors.sol";
import {Events} from "./Events.sol";

/**
 * @title LibCollateralManager
 * @notice Handles all collateral management operations for ERC20 and ERC1155 tokens
 * @dev Separated from LibEscrowLogic to follow single responsibility principle
 */
library LibCollateralManager {
    using SafeERC20 for IERC20;

    // ----------------------------------------
    // ERC20 Collateral Management
    // ----------------------------------------

    /**
     * @notice Lock ERC20 collateral for a buy order
     * @param user The user whose collateral to lock
     * @param collateralToken The ERC20 token address
     * @param amount The amount of tokens to lock (in position units)
     * @param pricePerToken The price per token
     * @param makerFeeBps The maker fee in basis points
     */
    function lockERC20Collateral(
        address user,
        address collateralToken,
        uint256 amount,
        uint256 pricePerToken,
        uint256 makerFeeBps
    ) internal {
        if (amount == 0) return;

        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        uint256 unitPerPair = ds.adminConfigStorage.unitPerPair[collateralToken];
        if (unitPerPair == 0) revert Errors.TokenNotAllowed();

        // Calculate cost in token's smallest units
        uint256 cost = (amount * pricePerToken) / unitPerPair;

        // Calculate maker fee
        uint256 makerFee = (cost * makerFeeBps) / 10_000;
        uint256 totalRequired = cost + makerFee;

        LibReentrancyGuard._nonReentrantBefore();
        if (IERC20(collateralToken).allowance(user, address(this)) < totalRequired) {
            revert Errors.InsufficientAllowance();
        }
        // Transfer tokens from user to contract
        IERC20(collateralToken).safeTransferFrom(user, address(this), totalRequired);

        LibReentrancyGuard._nonReentrantAfter();

        // Update internal balance tracking
        ds.escrowStorage.collateralBalances[user][collateralToken] += totalRequired;

        uint256 newBalance = ds.escrowStorage.collateralBalances[user][collateralToken];
        emit Events.ERC20CollateralLocked(user, collateralToken, totalRequired, newBalance);
    }

    function refundSurplus(uint256 takerPaidPerToken, uint256 tradeEffectivePrice, uint256 filledAmount, address taker, address collateralToken) internal {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        uint256 residue = takerPaidPerToken - tradeEffectivePrice;
        uint256 unitPerPair = ds.adminConfigStorage.unitPerPair[collateralToken];
        if (residue > 0){
            uint256 refundAmount = (residue * filledAmount) / unitPerPair;
            _consumeERC20Collateral(taker, collateralToken, refundAmount);
            LibReentrancyGuard._nonReentrantBefore();
            IERC20(collateralToken).safeTransfer(taker, refundAmount);
            LibReentrancyGuard._nonReentrantAfter();
            emit Events.RefundSurplus(taker, collateralToken, refundAmount, takerPaidPerToken, tradeEffectivePrice);
        }
    }

    /**
     * @notice Release ERC20 collateral for a buy order
     * @param user The user whose collateral to release
     * @param collateralToken The ERC20 token address
     * @param amount The amount of tokens to release (in position units)
     * @param pricePerToken The price per token
     * @param makerFeeBps The maker fee in basis points
     */
    function releaseERC20Collateral(
        address user,
        address collateralToken,
        uint256 amount,
        uint256 pricePerToken,
        uint256 makerFeeBps
    ) internal {
        if (amount == 0) return;

        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        uint256 unitPerPair = ds.adminConfigStorage.unitPerPair[collateralToken];
        if (unitPerPair == 0) revert Errors.TokenNotAllowed();

        // Calculate cost and fee
        uint256 cost = (amount * pricePerToken) / unitPerPair;
        uint256 makerFee = (cost * makerFeeBps) / 10_000;
        uint256 totalToRelease = cost + makerFee;

        // Consume from internal balance
        _consumeERC20Collateral(user, collateralToken, totalToRelease);

        LibReentrancyGuard._nonReentrantBefore();

        // Transfer tokens back to user
        IERC20(collateralToken).safeTransfer(user, totalToRelease);

        LibReentrancyGuard._nonReentrantAfter();


        uint256 newBalance = ds.escrowStorage.collateralBalances[user][collateralToken];
        emit Events.ERC20CollateralReleased(user, collateralToken, totalToRelease, newBalance);
    }

    /**
     * @notice Consume ERC20 collateral during trade settlement
     * @param user The user whose collateral to consume
     * @param collateralToken The ERC20 token address
     * @param amount The amount to consume
     */
    function consumeERC20Collateral(
        address user,
        address collateralToken,
        uint256 amount
    ) internal {
        _consumeERC20Collateral(user, collateralToken, amount);
    }

    // ----------------------------------------
    // ERC1155 Collateral Management
    // ----------------------------------------

    /**
     * @notice Lock ERC1155 position tokens for a sell order
     * @param user The user whose tokens to lock
     * @param positionId The position token ID
     * @param amount The amount of tokens to lock
     */
    function lockERC1155Collateral(
        address user,
        uint256 positionId,
        uint256 amount
    ) internal {
        if (amount == 0) return;

        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        // Transfer tokens from user to contract
        LibERC1155.safeTransferFrom(address(this), user, address(this), positionId, amount, "");

        // Update internal balance tracking
        ds.escrowStorage.lockedERC1155Balances[user][positionId] += amount;

        uint256 newBalance = ds.escrowStorage.lockedERC1155Balances[user][positionId];
        emit Events.ERC1155CollateralLocked(user, positionId, amount, newBalance);
    }

    /**
     * @notice Release ERC1155 position tokens for a sell order
     * @param user The user whose tokens to release
     * @param positionId The position token ID
     * @param amount The amount of tokens to release
     */
    function releaseERC1155Collateral(
        address user,
        uint256 positionId,
        uint256 amount
    ) internal {
        if (amount == 0) return;

        // Consume from internal balance
        _consumeERC1155Collateral(user, positionId, amount);

        // Transfer tokens back to user
        LibERC1155.safeTransferFrom(address(this), address(this), user, positionId, amount, "");

        uint256 newBalance = LibDoefinStorage.diamondStorage().escrowStorage.lockedERC1155Balances[user][positionId];
        emit Events.ERC1155CollateralReleased(user, positionId, amount, newBalance);
    }

    /**
     * @notice Consume ERC1155 collateral during trade settlement
     * @param user The user whose collateral to consume
     * @param positionId The position token ID
     * @param amount The amount to consume
     */
    function consumeERC1155Collateral(
        address user,
        uint256 positionId,
        uint256 amount
    ) internal {
        _consumeERC1155Collateral(user, positionId, amount);
    }

    // ----------------------------------------
    // Order Modification Support
    // ----------------------------------------

    /**
     * @notice Adjust collateral when an order is modified
     * @param modifyCtx The modification context containing old and new order parameters
     */
    function adjustCollateralForModifiedOrder(LibDoefinStorage.ModifyCollateralContext memory modifyCtx) internal {
        uint256 oldCost = modifyCtx.oldAmount * modifyCtx.oldPrice;
        uint256 newCost = modifyCtx.newAmount * modifyCtx.newPrice;

        if (modifyCtx.direction == LibDoefinStorage.OrderDirection.Buy) {
            _adjustERC20CollateralForModification(modifyCtx, oldCost, newCost);
        } else {
            _adjustERC1155CollateralForModification(modifyCtx);
        }
    }

    // ----------------------------------------
    // Balance Queries
    // ----------------------------------------

    /**
     * @notice Get user's ERC20 collateral balance
     * @param user The user address
     * @param token The ERC20 token address
     * @return The collateral balance
     */
    function getERC20CollateralBalance(address user, address token) internal view returns (uint256) {
        return LibDoefinStorage.diamondStorage().escrowStorage.collateralBalances[user][token];
    }

    /**
     * @notice Get user's ERC1155 collateral balance
     * @param user The user address
     * @param positionId The position token ID
     * @return The collateral balance
     */
    function getERC1155CollateralBalance(address user, uint256 positionId) internal view returns (uint256) {
        return LibDoefinStorage.diamondStorage().escrowStorage.lockedERC1155Balances[user][positionId];
    }

    // ----------------------------------------
    // Internal Helper Functions
    // ----------------------------------------

    /**
     * @notice Internal function to consume ERC20 collateral
     * @param user The user whose collateral to consume
     * @param token The ERC20 token address
     * @param amount The amount to consume
     */
    function _consumeERC20Collateral(
        address user,
        address token,
        uint256 amount
    ) internal {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        if (ds.escrowStorage.collateralBalances[user][token] < amount) {
            revert Errors.CustomInsufficientERC20Balance(user, token, amount, ds.escrowStorage.collateralBalances[user][token]);
        }

        ds.escrowStorage.collateralBalances[user][token] -= amount;
    }

    /**
     * @notice Internal function to consume ERC1155 collateral
     * @param user The user whose collateral to consume
     * @param positionId The position token ID
     * @param amount The amount to consume
     */
    function _consumeERC1155Collateral(
        address user,
        uint256 positionId,
        uint256 amount
    ) internal {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        if (ds.escrowStorage.lockedERC1155Balances[user][positionId] < amount) {
            revert Errors.InsufficientERC1155Balance();
        }

        ds.escrowStorage.lockedERC1155Balances[user][positionId] -= amount;
    }

    /**
     * @notice Adjust ERC20 collateral for order modification
     * @param modifyCtx The modification context
     * @param oldCost The old order cost
     * @param newCost The new order cost
     */
    function _adjustERC20CollateralForModification(
        LibDoefinStorage.ModifyCollateralContext memory modifyCtx,
        uint256 oldCost,
        uint256 newCost
    ) internal {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        uint256 oldFee = (oldCost * modifyCtx.makerFeeBps) / 10_000;
        uint256 newFee = (newCost * modifyCtx.makerFeeBps) / 10_000;

        uint256 totalOld = oldCost + oldFee;
        uint256 totalNew = newCost + newFee;

        if (totalNew > totalOld) {
            // Need to lock additional collateral
            uint256 additional = totalNew - totalOld;
            LibReentrancyGuard._nonReentrantBefore();
            IERC20(modifyCtx.collateralToken).safeTransferFrom(modifyCtx.maker, address(this), additional);
            LibReentrancyGuard._nonReentrantAfter();
            ds.escrowStorage.collateralBalances[modifyCtx.maker][modifyCtx.collateralToken] += additional;
        } else if (totalNew < totalOld) {
            // Can release some collateral
            uint256 refund = totalOld - totalNew;
            _consumeERC20Collateral(modifyCtx.maker, modifyCtx.collateralToken, refund);
            LibReentrancyGuard._nonReentrantBefore();
            IERC20(modifyCtx.collateralToken).safeTransfer(modifyCtx.maker, refund);
            LibReentrancyGuard._nonReentrantAfter();
        }
        // If totalNew == totalOld, no adjustment needed
    }

    /**
     * @notice Adjust ERC1155 collateral for order modification
     * @param modifyCtx The modification context
     */
    function _adjustERC1155CollateralForModification(LibDoefinStorage.ModifyCollateralContext memory modifyCtx) internal {
        if (modifyCtx.newAmount > modifyCtx.oldAmount) {
            // Need to lock additional tokens
            uint256 delta = modifyCtx.newAmount - modifyCtx.oldAmount;
            lockERC1155Collateral(modifyCtx.maker, modifyCtx.positionId, delta);
        } else if (modifyCtx.newAmount < modifyCtx.oldAmount) {
            // Can release some tokens
            uint256 delta = modifyCtx.oldAmount - modifyCtx.newAmount;
            releaseERC1155Collateral(modifyCtx.maker, modifyCtx.positionId, delta);
        }
    }
}
