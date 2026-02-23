// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {LibERC1155} from "./LibERC1155.sol";
import {Errors} from "./Errors.sol";
import {Events} from "./Events.sol";

/**
 * @title LibCollateralManager
 * @author Doefin
 * @notice Manages collateral operations for both ERC20 tokens and ERC1155 position tokens
 * @dev Handles locking, releasing, and consuming collateral during order lifecycle
 * @dev Supports fee calculations and escrow balance tracking for safe order execution
 */
library LibCollateralManager {
    using SafeERC20 for IERC20;

    // ----------------------------------------
    // ERC20 Collateral Management
    // ----------------------------------------

    /**
     * @notice Locks ERC20 collateral for a buy order, including maker fees
     * @dev Validates allowance, transfers tokens, and updates escrow balances
     * @dev Calculates total required amount including maker fees and transfers atomically
     * @param user Address of the user providing collateral
     * @param collateralToken ERC20 token address to be locked (e.g., USDC, WETH)
     * @param amount Number of position tokens to buy (used in cost calculation)
     * @param pricePerToken Price per position token in collateral token units
     * @param makerFeeBps Maker fee in basis points (100 = 1%)
     * @custom:emits ERC20CollateralLocked with user, token, amount, and new balance
     * @custom:reverts TokenNotAllowed if collateralToken not whitelisted
     * @custom:reverts InsufficientERC20Allowance if user hasn't approved enough tokens
     * @custom:security Validates allowance before attempting transfer to prevent revert
     * @custom:gas Cost includes ERC20 transfer and storage updates
     */
    function lockERC20Collateral(address user, address collateralToken, uint256 amount, uint256 pricePerToken, uint256 makerFeeBps) internal {
        if (amount == 0) return;

        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        uint256 unitPerPair = ds.adminConfigStorage.unitPerPair[collateralToken];
        if (unitPerPair == 0) revert Errors.TokenNotAllowed();

        (, , uint256 totalRequired) = _calculateTotalWithFee(amount, pricePerToken, unitPerPair, makerFeeBps);

        if (IERC20(collateralToken).allowance(user, address(this)) < totalRequired) {
            revert Errors.InsufficientERC20Allowance(user, collateralToken, totalRequired, IERC20(collateralToken).allowance(user, address(this)));
        }

        IERC20(collateralToken).safeTransferFrom(user, address(this), totalRequired);
        ds.escrowStorage.collateralBalances[user][collateralToken] += totalRequired;

        emit Events.ERC20CollateralLocked(user, collateralToken, totalRequired, ds.escrowStorage.collateralBalances[user][collateralToken]);
    }

    function refundSurplus(
        uint256 takerPaidPerToken,
        uint256 tradeEffectivePrice,
        uint256 filledAmount,
        address taker,
        address collateralToken
    ) internal {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        uint256 residue = takerPaidPerToken - tradeEffectivePrice;
        uint256 unitPerPair = ds.adminConfigStorage.unitPerPair[collateralToken];

        if (residue > 0) {
            uint256 refundAmount = (residue * filledAmount) / unitPerPair;
            _consumeERC20Collateral(taker, collateralToken, refundAmount);
            IERC20(collateralToken).safeTransfer(taker, refundAmount);
            emit Events.RefundSurplus(taker, collateralToken, refundAmount, takerPaidPerToken, tradeEffectivePrice);
        }
    }

    /**
     * @notice Releases previously locked ERC20 collateral for a buy order cancellation
     * @dev Calculates total amount to release including fees and transfers back to user
     * @dev Updates escrow balance tracking and emits event for off-chain monitoring
     * @param user Address of the user whose collateral is being released
     * @param collateralToken ERC20 token address to be released
     * @param amount Number of position tokens (used to calculate collateral to release)
     * @param pricePerToken Price per position token used in original locking
     * @param makerFeeBps Maker fee in basis points used in original calculation
     * @custom:emits ERC20CollateralReleased with user, token, amount, and remaining balance
     * @custom:reverts TokenNotAllowed if collateralToken not whitelisted
     * @custom:note Does nothing if amount is 0 (gas optimization)
     * @custom:security Uses _consumeERC20Collateral to validate sufficient locked balance
     * @custom:gas Cost includes ERC20 transfer and storage updates
     */
    function releaseERC20Collateral(address user, address collateralToken, uint256 amount, uint256 pricePerToken, uint256 makerFeeBps) internal {
        if (amount == 0) return;

        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        uint256 unitPerPair = ds.adminConfigStorage.unitPerPair[collateralToken];
        if (unitPerPair == 0) revert Errors.TokenNotAllowed();

        (, , uint256 totalToRelease) = _calculateTotalWithFee(amount, pricePerToken, unitPerPair, makerFeeBps);

        _consumeERC20Collateral(user, collateralToken, totalToRelease);
        IERC20(collateralToken).safeTransfer(user, totalToRelease);

        emit Events.ERC20CollateralReleased(user, collateralToken, totalToRelease, ds.escrowStorage.collateralBalances[user][collateralToken]);
    }

    /**
     * @notice Consume ERC20 collateral during trade settlement
     * @param user The user whose collateral to consume
     * @param collateralToken The ERC20 token address
     * @param amount The amount to consume
     */
    function consumeERC20Collateral(address user, address collateralToken, uint256 amount) internal {
        _consumeERC20Collateral(user, collateralToken, amount);
    }

    // ----------------------------------------
    // ERC1155 Collateral Management
    // ----------------------------------------

    /**
     * @notice Locks ERC1155 position tokens for a sell order
     * @dev Transfers position tokens from user to contract and updates internal tracking
     * @dev Uses LibERC1155.safeTransferFrom for secure token transfer with validation
     * @param user Address of the user providing position tokens
     * @param positionId ERC1155 token ID representing the outcome position
     * @param amount Number of position tokens to lock for the sell order
     * @custom:emits ERC1155CollateralLocked with user, positionId, amount, and new balance
     * @custom:note Does nothing if amount is 0 (gas optimization)
     * @custom:security Uses safe transfer to prevent token loss and validate ownership
     * @custom:gas Cost includes ERC1155 transfer and internal balance updates
     */
    function lockERC1155Collateral(address user, uint256 positionId, uint256 amount) internal {
        if (amount == 0) return;

        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        // Transfer tokens from user to contract
        LibERC1155.safeTransferFrom(address(this), user, address(this), positionId, amount, "");

        // Update internal balance tracking
        ds.escrowStorage.lockedERC1155Balances[user][positionId] += amount;

        uint256 newBalance = ds.escrowStorage.lockedERC1155Balances[user][positionId];
        emit Events.ERC1155CollateralLocked(user, positionId, amount, newBalance);
    }

    /**
     * @notice Releases previously locked ERC1155 position tokens for sell order cancellation
     * @dev Updates internal balance tracking and transfers tokens back to user
     * @dev Uses safe transfer to ensure tokens reach user's wallet safely
     * @param user Address of the user whose position tokens are being released
     * @param positionId ERC1155 token ID representing the outcome position
     * @param amount Number of position tokens to release
     * @custom:emits ERC1155CollateralReleased with user, positionId, amount, and remaining balance
     * @custom:note Does nothing if amount is 0 (gas optimization)
     * @custom:security Validates sufficient locked balance before release via _consumeERC1155Collateral
     * @custom:gas Cost includes ERC1155 transfer and internal balance updates
     */
    function releaseERC1155Collateral(address user, uint256 positionId, uint256 amount) internal {
        if (amount == 0) return;

        // Consume from internal balance
        _consumeERC1155Collateral(user, positionId, amount);

        // Transfer tokens back to user
        LibERC1155.safeTransferFrom(address(this), address(this), user, positionId, amount, "");

        uint256 newBalance = LibDoefinStorage.appStorage().escrowStorage.lockedERC1155Balances[user][positionId];
        emit Events.ERC1155CollateralReleased(user, positionId, amount, newBalance);
    }

    /**
     * @notice Consume ERC1155 collateral during trade settlement
     * @param user The user whose collateral to consume
     * @param positionId The position token ID
     * @param amount The amount to consume
     */
    function consumeERC1155Collateral(address user, uint256 positionId, uint256 amount) internal {
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
        if (modifyCtx.direction == LibDoefinStorage.OrderDirection.Buy) {
            LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
            uint256 unitPerPair = ds.adminConfigStorage.unitPerPair[modifyCtx.collateralToken];

            uint256 oldCost = (modifyCtx.oldAmount * modifyCtx.oldPrice) / unitPerPair;
            uint256 newCost = (modifyCtx.newAmount * modifyCtx.newPrice) / unitPerPair;

            // Early return if cost unchanged
            if (oldCost == newCost) return;

            _adjustERC20CollateralForModification(modifyCtx, oldCost, newCost);
        } else {
            // Early return if amount unchanged (already handled inside the function)
            if (modifyCtx.oldAmount == modifyCtx.newAmount) return;

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
        return LibDoefinStorage.appStorage().escrowStorage.collateralBalances[user][token];
    }

    /**
     * @notice Get user's ERC1155 collateral balance
     * @param user The user address
     * @param positionId The position token ID
     * @return The collateral balance
     */
    function getERC1155CollateralBalance(address user, uint256 positionId) internal view returns (uint256) {
        return LibDoefinStorage.appStorage().escrowStorage.lockedERC1155Balances[user][positionId];
    }

    function getEscrowStatus(
        address user,
        address[] memory tokens,
        uint256[] memory positionIds
    ) internal view returns (uint256[] memory erc20Balances, uint256[] memory erc1155Balances) {
        erc20Balances = new uint256[](tokens.length);
        erc1155Balances = new uint256[](positionIds.length);

        for (uint256 i = 0; i < tokens.length; i++) {
            erc20Balances[i] = getERC20CollateralBalance(user, tokens[i]);
        }

        for (uint256 i = 0; i < positionIds.length; i++) {
            erc1155Balances[i] = getERC1155CollateralBalance(user, positionIds[i]);
        }
    }

    // ----------------------------------------
    // Internal Helper Functions
    // ----------------------------------------

    /**
     * @notice Calculate cost, fee, and total with fee
     * @param amount Amount in position units
     * @param pricePerToken Price per token
     * @param unitPerPair Unit per pair for the token
     * @param makerFeeBps Maker fee in basis points
     * @return cost The base cost
     * @return fee The maker fee amount
     * @return total The total (cost + fee)
     */
    function _calculateTotalWithFee(
        uint256 amount,
        uint256 pricePerToken,
        uint256 unitPerPair,
        uint256 makerFeeBps
    ) private pure returns (uint256 cost, uint256 fee, uint256 total) {
        cost = (amount * pricePerToken) / unitPerPair;
        fee = (cost * makerFeeBps) / 10_000;
        total = cost + fee;
    }

    /**
     * @notice Internal function to consume ERC20 collateral
     * @param user The user whose collateral to consume
     * @param token The ERC20 token address
     * @param amount The amount to consume
     */
    function _consumeERC20Collateral(address user, address token, uint256 amount) internal {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        if (ds.escrowStorage.collateralBalances[user][token] < amount) {
            revert Errors.InsufficientERC20EscrowBalance(user, token, amount, ds.escrowStorage.collateralBalances[user][token]);
        }

        ds.escrowStorage.collateralBalances[user][token] -= amount;
    }

    /**
     * @notice Internal function to consume ERC1155 collateral
     * @param user The user whose collateral to consume
     * @param positionId The position token ID
     * @param amount The amount to consume
     */
    function _consumeERC1155Collateral(address user, uint256 positionId, uint256 amount) internal {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        if (ds.escrowStorage.lockedERC1155Balances[user][positionId] < amount) {
            revert Errors.InsufficientERC1155Balance(user, positionId, amount, ds.escrowStorage.lockedERC1155Balances[user][positionId]);
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
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        uint256 oldFee = (oldCost * modifyCtx.makerFeeBps) / 10_000;
        uint256 newFee = (newCost * modifyCtx.makerFeeBps) / 10_000;
        uint256 totalOld = oldCost + oldFee;
        uint256 totalNew = newCost + newFee;

        if (totalNew > totalOld) {
            uint256 additional = totalNew - totalOld;
            IERC20(modifyCtx.collateralToken).safeTransferFrom(modifyCtx.maker, address(this), additional);
            ds.escrowStorage.collateralBalances[modifyCtx.maker][modifyCtx.collateralToken] += additional;
        } else if (totalNew < totalOld) {
            uint256 refund = totalOld - totalNew;
            _consumeERC20Collateral(modifyCtx.maker, modifyCtx.collateralToken, refund);
            IERC20(modifyCtx.collateralToken).safeTransfer(modifyCtx.maker, refund);
        }
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
