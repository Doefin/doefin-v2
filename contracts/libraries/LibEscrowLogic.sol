// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {LibERC1155} from "./LibERC1155.sol";

library LibEscrowLogic {
    using SafeERC20 for IERC20;

    function lockCollateral(address user, address token, uint256 amount, uint256 pricePerToken) internal {
        if (amount == 0) return;
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        uint256 cost = amount * pricePerToken;
        uint256 makerFee = computeMakerFee(cost);
        uint256 total = cost + makerFee;

        IERC20(token).safeTransferFrom(user, address(this), total);
        ds.escrowStorage.collateralBalances[user][token] += total;
    }

    function releaseCollateral(address user, address token, uint256 amount, uint256 pricePerToken) internal {
        if (amount == 0) return;

        uint256 cost = amount * pricePerToken;
        uint256 makerFee = computeMakerFee(cost);
        uint256 total = cost + makerFee;

        _consumeERC20Collateral(user, token, total);
        IERC20(token).safeTransfer(user, total);
    }

    function lockERC1155(address user, uint256 positionId, uint256 amount) internal {
        if (amount == 0) return;
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        LibERC1155.safeTransferFrom(address(this), user, address(this), positionId, amount, "");
        ds.escrowStorage.lockedERC1155Balances[user][positionId] += amount;
    }

    function releaseERC1155(address user, uint256 positionId, uint256 amount) internal {
        if (amount == 0) return;
        _consumeERC1155Collateral(user, positionId, amount);
        LibERC1155.safeTransferFrom(address(this), address(this), user, positionId, amount, "");
    }

    function _consumeERC20Collateral(address user, address token, uint256 amount) internal {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        require(ds.escrowStorage.collateralBalances[user][token] >= amount, "Escrow: insufficient ERC20");
        ds.escrowStorage.collateralBalances[user][token] -= amount;
    }

    function _consumeERC1155Collateral(address user, uint256 positionId, uint256 amount) internal {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        require(ds.escrowStorage.lockedERC1155Balances[user][positionId] >= amount, "Escrow: insufficient ERC1155");
        ds.escrowStorage.lockedERC1155Balances[user][positionId] -= amount;
    }

    function adjustCollateralForModifiedOrder(LibDoefinStorage.ModifyCollateralContext memory modifyCtx) internal {
        uint256 oldCost = modifyCtx.oldAmount * modifyCtx.oldPrice;
        uint256 newCost = modifyCtx.newAmount * modifyCtx.newPrice;

        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        if (modifyCtx.direction == LibDoefinStorage.OrderDirection.Buy) {
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
        } else {
            // Sell order — collateral is ERC1155 tokens

            if (modifyCtx.newAmount > modifyCtx.oldAmount) {
                uint256 delta = modifyCtx.newAmount - modifyCtx.oldAmount;
                lockERC1155(modifyCtx.maker, modifyCtx.positionId, delta);
            } else if (modifyCtx.newAmount < modifyCtx.oldAmount) {
                uint256 delta = modifyCtx.oldAmount - modifyCtx.newAmount;
                releaseERC1155(modifyCtx.maker, modifyCtx.positionId, delta);
            }
        }
    }

    // ----------------------------------------
    // Fee Logic
    // ----------------------------------------

    function getMarketFees() internal view returns (LibDoefinStorage.OrderFeeConfig memory orderFeeConfig) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        orderFeeConfig = LibDoefinStorage.OrderFeeConfig({
            makerFeeBps: ds.adminConfigStorage.makerTradingFeeBps,
            takerFeeBps: ds.adminConfigStorage.takerTradingFeeBps
        });
    }

    function computeMakerFee(uint256 cost) internal view returns (uint256) {
        uint256 bps = LibDoefinStorage.diamondStorage().adminConfigStorage.makerTradingFeeBps;
        return (cost * bps) / 10_000;
    }

    function computeFees(LibDoefinStorage.SettleContext memory ctx) internal pure returns (uint256 makerFee, uint256 takerFee, uint256 cost) {
        cost = ctx.amount * ctx.pricePerToken;
        makerFee = (cost * ctx.orderFeeConfig.makerFeeBps) / 10_000;
        takerFee = (cost * ctx.orderFeeConfig.takerFeeBps) / 10_000;
    }

    function accrueFees(address token, uint256 makerFee, uint256 takerFee) internal {
        if (makerFee + takerFee == 0) return;
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        ds.escrowStorage.protocolFees[token] += makerFee + takerFee;
    }

    function claimProtocolFees(address token, address recipient) internal {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        uint256 amount = ds.escrowStorage.protocolFees[token];
        require(amount > 0, "Escrow: no fees to claim");

        ds.escrowStorage.protocolFees[token] = 0;
        IERC20(token).safeTransfer(recipient, amount);
    }

    // ----------------------------------------
    // Trade Settlement
    // ----------------------------------------

    function settleTrade(LibDoefinStorage.SettleContext memory ctx) internal {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        address feeReceiver = ds.adminConfigStorage.feeReceiver;
        require(feeReceiver != address(0), "Escrow: fee receiver not set");

        (uint256 makerFee, uint256 takerFee, uint256 cost) = computeFees(ctx);

        accrueFees(ctx.collateralToken, makerFee, takerFee);

        if (ctx.direction == LibDoefinStorage.OrderDirection.Buy) {
            uint256 totalReleasedForMaker = cost + makerFee;
            _consumeERC20Collateral(ctx.maker, ctx.collateralToken, totalReleasedForMaker);
            IERC20(ctx.collateralToken).safeTransfer(ctx.taker, cost - takerFee);

            LibERC1155.safeTransferFrom(address(this), ctx.taker, ctx.maker, ctx.positionId, ctx.amount, "");
        } else {
            IERC20(ctx.collateralToken).safeTransferFrom(ctx.taker, address(this), cost + takerFee);
            IERC20(ctx.collateralToken).safeTransfer(ctx.maker, cost - makerFee);

            _consumeERC1155Collateral(ctx.maker, ctx.positionId, ctx.amount);
            LibERC1155.safeTransferFrom(address(this), address(this), ctx.taker, ctx.positionId, ctx.amount, "");
        }
    }

    // ----------------------------------------
    // Optional View Helpers (if exposed later)
    // ----------------------------------------

    function getCollateralBalance(address user, address token) internal view returns (uint256) {
        return LibDoefinStorage.diamondStorage().escrowStorage.collateralBalances[user][token];
    }

    function getLockedERC1155(address user, uint256 positionId) internal view returns (uint256) {
        return LibDoefinStorage.diamondStorage().escrowStorage.lockedERC1155Balances[user][positionId];
    }

    function getProtocolFees(address token) internal view returns (uint256) {
        return LibDoefinStorage.diamondStorage().escrowStorage.protocolFees[token];
    }
}
