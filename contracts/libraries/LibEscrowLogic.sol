// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {LibCollateralManager} from "./LibCollateralManager.sol";
import {LibFeeManager} from "./LibFeeManager.sol";
import {LibQuoteCurrency} from "./LibQuoteCurrency.sol";
import {Errors} from "./Errors.sol";

/**
 * @title LibEscrowLogic
 * @notice Refactored escrow logic that coordinates between specialized libraries
 * @dev This is the new version that replaces LibEscrowLogic with proper separation of concerns
 */
library LibEscrowLogic {
    function _calculateCrossCurrencyQuote(LibDoefinStorage.Order memory order, uint256 amount) private view returns (uint256) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        uint256 collateralUnitPerPair = ds.adminConfigStorage.unitPerPair[order.collateralToken];
        if (collateralUnitPerPair == 0) revert Errors.InvalidUnitPerPair();

        uint256 exchangeRate;
        if (order.exchangeRateType == LibDoefinStorage.ExchangeRateType.Dynamic) {
            (exchangeRate, ) = LibQuoteCurrency.getOracleExchangeRate(order.quoteCurrencyToken, order.collateralToken);
        } else {
            exchangeRate = order.exchangeRate;
        }

        if (exchangeRate == 0) revert Errors.InvalidExchangeRate();
        uint256 quoteAmount = (((amount * order.pricePerToken) / collateralUnitPerPair) * exchangeRate) / 1e18;
        return quoteAmount + (quoteAmount * order.makerFeeBps) / 10000;
    }

    function lockCollateral(LibDoefinStorage.Order memory order) internal {
        if (order.direction == LibDoefinStorage.OrderDirection.Buy) {
            if (order.orderType == LibDoefinStorage.OrderType.CrossCurrency) {
                uint256 totalQuoteRequired = _calculateCrossCurrencyQuote(order, order.amount);
                LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
                uint256 quoteUnitPerPair = ds.adminConfigStorage.unitPerPair[order.quoteCurrencyToken];
                LibCollateralManager.lockERC20Collateral(order.maker, order.quoteCurrencyToken, totalQuoteRequired, quoteUnitPerPair, 0);
            } else {
                LibCollateralManager.lockERC20Collateral(order.maker, order.collateralToken, order.amount, order.pricePerToken, order.makerFeeBps);
            }
        } else {
            LibCollateralManager.lockERC1155Collateral(order.maker, order.positionId, order.amount);
        }
    }

    function releaseCollateral(LibDoefinStorage.Order memory order) internal {
        if (order.direction == LibDoefinStorage.OrderDirection.Buy) {
            if (order.orderType == LibDoefinStorage.OrderType.CrossCurrency) {
                uint256 totalQuoteToRelease = _calculateCrossCurrencyQuote(order, order.remainingAmount);
                LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
                uint256 quoteUnitPerPair = ds.adminConfigStorage.unitPerPair[order.quoteCurrencyToken];
                LibCollateralManager.releaseERC20Collateral(order.maker, order.quoteCurrencyToken, totalQuoteToRelease, quoteUnitPerPair, 0);
            } else {
                LibCollateralManager.releaseERC20Collateral(
                    order.maker,
                    order.collateralToken,
                    order.remainingAmount,
                    order.pricePerToken,
                    order.makerFeeBps
                );
            }
        } else {
            LibCollateralManager.releaseERC1155Collateral(order.maker, order.positionId, order.remainingAmount);
        }
    }

    function adjustCollateralForModifiedOrder(LibDoefinStorage.ModifyCollateralContext memory modifyCtx) internal {
        LibCollateralManager.adjustCollateralForModifiedOrder(modifyCtx);
    }

    function getMarketFees() internal view returns (LibDoefinStorage.OrderFeeConfig memory orderFeeConfig) {
        return LibFeeManager.getMarketFees();
    }

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
