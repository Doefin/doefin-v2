// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {LibERC1155} from "./LibERC1155.sol";
import {LibPositionRegistry} from "./LibPositionRegistry.sol";
import {LibCTFCondition} from "./LibCTFCondition.sol";
import {Errors} from "./Errors.sol";
import {Events} from "./Events.sol";

library LibEscrowLogic {
    using SafeERC20 for IERC20;

    function lockCollateral(LibDoefinStorage.Order memory order) internal {
        if (order.direction == LibDoefinStorage.OrderDirection.Buy) {
            lockERC20(order);
        } else {
            lockERC1155(order.maker, order.positionId, order.amount);
        }
    }

    function releaseCollateral(LibDoefinStorage.Order memory order) internal {
        if (order.direction == LibDoefinStorage.OrderDirection.Buy) {
            releaseERC20(order);
        } else {
            releaseERC1155(order.maker, order.positionId, order.amount);
        }
    }

    function lockERC20(LibDoefinStorage.Order memory order) internal {
        if (order.amount == 0) return;

        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        address collateralToken = order.collateralToken;
        uint256 unitPerPair = ds.adminConfigStorage.unitPerPair[collateralToken];
        if (unitPerPair == 0) revert Errors.TokenNotAllowed();

        // Normalize price per token relative to unitPerPair
        // pricePerToken is assumed to be in unitPerPair precision
        // So we scale amount * price / unitPerPair to get cost in token's smallest units
        uint256 cost = (order.amount * order.pricePerToken) / unitPerPair;

        // Compute maker fee in token units (based on cost)
        uint256 makerFee = computeMakerFee(cost);
        uint256 total = cost + makerFee;

        // Transfer total tokens from maker to contract
        IERC20(collateralToken).safeTransferFrom(order.maker, address(this), total);

        // Update internal collateral balance
        ds.escrowStorage.collateralBalances[order.maker][collateralToken] += total;

        uint256 totalBalance = ds.escrowStorage.collateralBalances[order.maker][collateralToken];

        emit Events.ERC20CollateralLocked(order.maker, collateralToken, order.amount, totalBalance);
    }

    function releaseERC20(LibDoefinStorage.Order memory order) internal {
        if (order.remainingAmount == 0) return;

        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        address collateralToken = order.collateralToken;
        uint256 unitPerPair = ds.adminConfigStorage.unitPerPair[collateralToken];
        if (unitPerPair == 0) revert Errors.TokenNotAllowed();

        // Normalize cost
        uint256 cost = (order.remainingAmount * order.pricePerToken) / unitPerPair;

        uint256 makerFee = computeMakerFee(cost);
        uint256 total = cost + makerFee;

        _consumeERC20Collateral(order.maker, order.collateralToken, total);
        IERC20(order.collateralToken).safeTransfer(order.maker, total);

        uint256 totalBalance = ds.escrowStorage.collateralBalances[order.maker][collateralToken];
        emit Events.ERC20CollateralReleased(order.maker, collateralToken, total, totalBalance);
    }

    function lockERC1155(address user, uint256 positionId, uint256 amount) internal {
        if (amount == 0) return;
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        LibERC1155.safeTransferFrom(address(this), user, address(this), positionId, amount, "");
        ds.escrowStorage.lockedERC1155Balances[user][positionId] += amount;

        uint256 totalBalance = ds.escrowStorage.lockedERC1155Balances[user][positionId];

        emit Events.ERC1155CollateralLocked(user, positionId, amount, totalBalance);
    }

    function releaseERC1155(address user, uint256 positionId, uint256 amount) internal {
        if (amount == 0) return;
        _consumeERC1155Collateral(user, positionId, amount);
        LibERC1155.safeTransferFrom(address(this), address(this), user, positionId, amount, "");

        uint256 totalBalance = LibDoefinStorage.diamondStorage().escrowStorage.lockedERC1155Balances[user][positionId];
        emit Events.ERC1155CollateralReleased(user, positionId, amount, totalBalance);
    }

    function _consumeERC20Collateral(address user, address token, uint256 amount) internal {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        if(ds.escrowStorage.collateralBalances[user][token] < amount) 
            revert Errors.InsufficientERC20Balance();
        ds.escrowStorage.collateralBalances[user][token] -= amount;
    }

    function _consumeERC1155Collateral(address user, uint256 positionId, uint256 amount) internal {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        if(ds.escrowStorage.lockedERC1155Balances[user][positionId] < amount) 
            revert Errors.InsufficientERC1155Balance();
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

    function computeMintFees(
        LibDoefinStorage.Order memory makerOrder,
        uint256 fillableAmount
    ) internal view returns (uint256 makerFee, uint256 takerFee, uint256 makerContribution, uint256 takerContribution) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        address collateralToken = makerOrder.collateralToken;
        uint256 unitPerPair = ds.adminConfigStorage.unitPerPair[collateralToken];
        makerContribution = (fillableAmount * makerOrder.pricePerToken) / unitPerPair;
        takerContribution = fillableAmount - makerContribution;

        makerFee = (makerContribution * makerOrder.orderFeeConfig.makerFeeBps) / 10_000;
        takerFee = (takerContribution * makerOrder.orderFeeConfig.takerFeeBps) / 10_000;
    }

    function computeFees(
        LibDoefinStorage.SettlemetExecutionContext memory settlementExecCtx
    ) internal view returns (uint256 makerFee, uint256 takerFee, uint256 cost) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        LibDoefinStorage.Order memory makerOrder = settlementExecCtx.makerOrder;

        address token = makerOrder.collateralToken;
        uint256 unitPerPair = ds.adminConfigStorage.unitPerPair[token];
        if (unitPerPair == 0) revert Errors.TokenNotAllowed();

        // Apply normalization as done in lockERC20
        cost = (settlementExecCtx.fillableAmount * makerOrder.pricePerToken) / unitPerPair;

        makerFee = (cost * makerOrder.orderFeeConfig.makerFeeBps) / 10_000;
        takerFee = (cost * makerOrder.orderFeeConfig.takerFeeBps) / 10_000;
    }

    function accrueFees(address token, uint256 makerFee, uint256 takerFee) internal {
        if (makerFee + takerFee == 0) return;
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        uint256 totalFees = makerFee + takerFee;
        ds.escrowStorage.protocolFees[token] += totalFees;

        emit Events.ProtocolFeesAccrued(
            token,
            totalFees,
            ds.escrowStorage.protocolFees[token]
        );
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
        (uint256 makerFee, uint256 takerFee, uint256 makerContribution, uint256 takerContribution) = computeMintFees(
            settlementExecCtx.makerOrder,
            settlementExecCtx.fillableAmount
        );

        address collateralToken = settlementExecCtx.makerOrder.collateralToken;

        accrueFees(collateralToken, makerFee, takerFee);

        if (settlementExecCtx.takerOrder.direction == LibDoefinStorage.OrderDirection.Buy) {
            uint256 takerToPay = takerContribution + takerFee;
            uint256 allowance = IERC20(collateralToken).allowance(settlementExecCtx.takerOrder.taker, address(this));
            if (allowance < takerToPay) 
                revert Errors.InsufficientERC20Allowance();

            // Get Taker ERC20 collateral
            IERC20(collateralToken).safeTransferFrom(settlementExecCtx.takerOrder.taker, address(this), takerToPay);

            // Consume Maker ERC20 collateral
            _consumeERC20Collateral(settlementExecCtx.makerOrder.maker, collateralToken, makerContribution + makerFee);

            LibDoefinStorage.MarketMetadata memory marketMetadata = LibPositionRegistry.getMarketMetadata(settlementExecCtx.makerOrder.positionId);
            bytes32 conditionId = LibPositionRegistry.retrieveConditionId(
                settlementExecCtx.makerOrder.positionId,
                settlementExecCtx.takerOrder.positionId
            );
            // Call Split method of the CTF and give them their desired token.
            LibCTFCondition._splitPosition(
                address(this),
                marketMetadata.collateralToken,
                marketMetadata.parentCollectionId,
                conditionId,
                settlementExecCtx.fillableAmount,
                marketMetadata.partitions
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
        (uint256 makerFee, uint256 takerFee, uint256 makerContribution, uint256 takerContribution) = computeMintFees(
            settlementExecCtx.makerOrder,
            settlementExecCtx.fillableAmount
        );

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
        LibDoefinStorage.MarketMetadata memory marketMetadata = LibPositionRegistry.getMarketMetadata(settlementExecCtx.makerOrder.positionId);
        bytes32 conditionId = LibPositionRegistry.retrieveConditionId(
            settlementExecCtx.makerOrder.positionId,
            settlementExecCtx.takerOrder.positionId
        );

        LibCTFCondition._mergePositions(
            address(this),
            marketMetadata.collateralToken,
            marketMetadata.parentCollectionId,
            conditionId,
            marketMetadata.partitions,
            settlementExecCtx.fillableAmount
        );

        // Distribute ERC20 to maker and taker
        uint256 makerAmount = makerContribution - makerFee;
        uint256 takerAmount = takerContribution - takerFee;

        IERC20(collateralToken).safeTransfer(settlementExecCtx.makerOrder.maker, makerAmount);
        IERC20(collateralToken).safeTransfer(settlementExecCtx.takerOrder.taker, takerAmount);
    }

    function _handleComplementaryMatch(LibDoefinStorage.SettlemetExecutionContext memory settlementExecCtx) internal {
        (uint256 makerFee, uint256 takerFee, uint256 cost) = computeFees(settlementExecCtx);

        address collateralToken = settlementExecCtx.makerOrder.collateralToken;

        accrueFees(collateralToken, makerFee, takerFee);

        if (settlementExecCtx.takerOrder.direction == LibDoefinStorage.OrderDirection.Sell) {
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
