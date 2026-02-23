// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {LibQuoteCurrency} from "./LibQuoteCurrency.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Errors} from "./Errors.sol";

/**
 * @title LibCrossCurrencySettlement
 * @notice Simplified library for cross-currency utilities
 * @dev Most cross-currency logic is now handled by the unified approach in LibMatchEngine and LibSettlement
 */
library LibCrossCurrencySettlement {
    /**
     * @notice Check if trade involves cross-currency orders
     * @dev This function is maintained for backward compatibility but the unified approach
     *      in LibTradeSettlement._isCrossCurrencySettlement() is preferred
     */
    function isCrossCurrencyTrade(uint256 takerOrderId, uint256 makerOrderId) internal view returns (bool) {
        bool takerIsCrossCurrency = false;
        if (takerOrderId != 0) {
            (LibDoefinStorage.OrderType takerOrderType, ) = LibQuoteCurrency.getOrderTypeAndCCData(takerOrderId);
            takerIsCrossCurrency = (takerOrderType != LibDoefinStorage.OrderType.Standard);
        }

        (LibDoefinStorage.OrderType makerOrderType, ) = LibQuoteCurrency.getOrderTypeAndCCData(makerOrderId);
        bool makerIsCrossCurrency = (makerOrderType != LibDoefinStorage.OrderType.Standard);
        return takerIsCrossCurrency || makerIsCrossCurrency;
    }

    /**
     * @notice Calculate floor price in quote currency for Dynamic orders
     * @dev Utility function for Dynamic order floor rate validation
     */
    function calculateFloorPriceInQuoteForDynamicOrder(
        LibDoefinStorage.Order memory order,
        uint256 collateralUnit,
        uint256 floorRate
    ) internal pure returns (uint256) {
        return Math.mulDiv(order.pricePerToken, floorRate, 1e18 * collateralUnit);
    }
}
