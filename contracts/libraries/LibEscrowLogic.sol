// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {LibERC1155} from "./LibERC1155.sol";
import {LibPositionRegistry} from "./LibPositionRegistry.sol";
import {LibCTFCondition} from "./LibCTFCondition.sol";

library LibEscrowLogic {
    using SafeERC20 for IERC20;

    function lockCollateral(LibDoefinStorage.Order memory order) internal {
        if (order.amount == 0) return;

        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        uint256 cost = order.amount * order.pricePerToken;
        uint256 makerFee = computeMakerFee(cost);
        uint256 total = cost + makerFee;

        IERC20(order.collateralToken).safeTransferFrom(order.maker, address(this), total);
        ds.escrowStorage.collateralBalances[order.maker][order.collateralToken] += total;
    }

    function releaseCollateral(LibDoefinStorage.Order memory order) internal {
        if (order.remainingAmount == 0) return;

        uint256 cost = order.remainingAmount * order.pricePerToken;
        uint256 makerFee = (order.orderFeeConfig.makerFeeBps * cost) / 10_000;
        uint256 total = cost + makerFee;

        _consumeERC20Collateral(order.maker, order.collateralToken, total);
        IERC20(order.collateralToken).safeTransfer(order.maker, total);
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

    function computeFees(
        LibDoefinStorage.SettlemetExecutionContext memory settlementExecCtx
    ) internal pure returns (uint256 makerFee, uint256 takerFee, uint256 cost) {
        LibDoefinStorage.Order memory makerOrder = settlementExecCtx.makerOrder;
        cost = makerOrder.pricePerToken * settlementExecCtx.fillableAmount;
        makerFee = (cost * makerOrder.orderFeeConfig.makerFeeBps) / 10_000;
        takerFee = (cost * makerOrder.orderFeeConfig.takerFeeBps) / 10_000;
    }

    function accrueFees(address token, uint256 makerFee, uint256 takerFee) internal {
        if (makerFee + takerFee == 0) return;
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        ds.escrowStorage.protocolFees[token] += makerFee + takerFee;
    }

    // ----------------------------------------
    // Trade Settlement
    // ----------------------------------------

    function settlementDispatcher(LibDoefinStorage.SettlemetExecutionContext memory settlementExecCtx) internal {
        if (settlementExecCtx.matchType == LibDoefinStorage.MatchType.Complementary) {
            _handleComplementaryMatch(settlementExecCtx);
        } else if (settlementExecCtx.matchType == LibDoefinStorage.MatchType.Mint) {
            _handleMintMatch(settlementExecCtx);
        } else {
            _handleMergeMatch(settlementExecCtx);
        }
    }

    function _handleMintMatch(LibDoefinStorage.SettlemetExecutionContext memory settlementExecCtx) internal {
        (uint256 makerFee, uint256 takerFee, uint256 cost) = computeFees(settlementExecCtx);

        address collateralToken = settlementExecCtx.makerOrder.collateralToken;

        accrueFees(collateralToken, makerFee, takerFee);

        if (settlementExecCtx.takerOrder.direction == LibDoefinStorage.OrderDirection.Buy) {
            // Get Taker ERC20 collateral
            IERC20(collateralToken).safeTransferFrom(settlementExecCtx.takerOrder.taker, address(this), cost + takerFee);

            // Consume Maker ERC20 collateral
            uint256 totalReleasedForMaker = cost + makerFee;
            _consumeERC20Collateral(settlementExecCtx.makerOrder.maker, collateralToken, totalReleasedForMaker);

            LibDoefinStorage.PositionMetadata memory positionMeta = LibPositionRegistry.getPositionMetadata(settlementExecCtx.makerOrder.positionId);
            bytes32 conditionId = LibPositionRegistry.retrieveConditionId(
                settlementExecCtx.makerOrder.positionId,
                settlementExecCtx.takerOrder.positionId
            );
            // Call Split method of the CTF and give them their desired token.
            LibCTFCondition._splitPosition(
                positionMeta.collateralToken,
                positionMeta.parentCollectionId,
                conditionId,
                settlementExecCtx.fillableAmount,
                positionMeta.partitions
            );

            LibERC1155.safeTransferFrom(
                address(this),
                address(this),
                settlementExecCtx.makerOrder.maker,
                settlementExecCtx.makerOrder.positionId,
                settlementExecCtx.fillableAmount,
                ""
            );

            LibERC1155.safeTransferFrom(
                address(this),
                address(this),
                settlementExecCtx.takerOrder.taker,
                settlementExecCtx.takerOrder.positionId,
                settlementExecCtx.fillableAmount,
                ""
            );
        }
    }

    function _handleMergeMatch(LibDoefinStorage.SettlemetExecutionContext memory settlementExecCtx) internal {
        (uint256 makerFee, uint256 takerFee, uint256 cost) = computeFees(settlementExecCtx);

        address collateralToken = settlementExecCtx.makerOrder.collateralToken;

        accrueFees(collateralToken, makerFee, takerFee);

        // Consume Maker ERC1155 tokens
        _consumeERC1155Collateral(settlementExecCtx.makerOrder.maker, settlementExecCtx.makerOrder.positionId, settlementExecCtx.fillableAmount);

        // Recieve Taker ERC1155 tokens to us
        LibERC1155.safeTransferFrom(
            address(this),
            settlementExecCtx.takerOrder.taker,
            address(this),
            settlementExecCtx.takerOrder.positionId,
            settlementExecCtx.fillableAmount,
            ""
        );

        // Merge two positions and recieve collateral locked.
        LibDoefinStorage.PositionMetadata memory positionMeta = LibPositionRegistry.getPositionMetadata(settlementExecCtx.makerOrder.positionId);
        bytes32 conditionId = LibPositionRegistry.retrieveConditionId(
            settlementExecCtx.makerOrder.positionId,
            settlementExecCtx.takerOrder.positionId
        );

        LibCTFCondition._mergePositions(
            positionMeta.collateralToken,
            positionMeta.parentCollectionId,
            conditionId,
            positionMeta.partitions,
            settlementExecCtx.fillableAmount
        );

        // Distribute ERC20 to maker and taker
        uint256 makerAmount = cost - makerFee;
        uint256 takerAmount = cost - takerFee;

        IERC20(collateralToken).safeTransfer(settlementExecCtx.makerOrder.maker, makerAmount);
        IERC20(collateralToken).safeTransfer(settlementExecCtx.takerOrder.taker, takerAmount);
    }

    function _handleComplementaryMatch(LibDoefinStorage.SettlemetExecutionContext memory settlementExecCtx) internal {
        (uint256 makerFee, uint256 takerFee, uint256 cost) = computeFees(settlementExecCtx);

        address collateralToken = settlementExecCtx.makerOrder.collateralToken;

        accrueFees(collateralToken, makerFee, takerFee);

        if (settlementExecCtx.takerOrder.direction == LibDoefinStorage.OrderDirection.Buy) {
            uint256 totalReleasedForMaker = cost + makerFee;
            _consumeERC20Collateral(settlementExecCtx.makerOrder.maker, collateralToken, totalReleasedForMaker);
            IERC20(collateralToken).safeTransfer(settlementExecCtx.takerOrder.taker, cost - takerFee);

            LibERC1155.safeTransferFrom(
                address(this),
                settlementExecCtx.takerOrder.taker,
                settlementExecCtx.makerOrder.maker,
                settlementExecCtx.makerOrder.positionId,
                settlementExecCtx.fillableAmount,
                ""
            );
        } else {
            IERC20(collateralToken).safeTransferFrom(settlementExecCtx.takerOrder.taker, address(this), cost + takerFee);
            IERC20(collateralToken).safeTransfer(settlementExecCtx.makerOrder.maker, cost - makerFee);

            _consumeERC1155Collateral(settlementExecCtx.makerOrder.maker, settlementExecCtx.makerOrder.positionId, settlementExecCtx.fillableAmount);
            LibERC1155.safeTransferFrom(
                address(this),
                address(this),
                settlementExecCtx.takerOrder.taker,
                settlementExecCtx.makerOrder.positionId,
                settlementExecCtx.fillableAmount,
                ""
            );
        }
    }
}
