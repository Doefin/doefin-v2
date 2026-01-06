// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibOrderbook} from "../libraries/LibOrderbook.sol";
import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {IOrderCreation} from "../interfaces/IOrderCreation.sol";

contract OrderCreationFacet is IOrderCreation {
    using LibDoefinStorage for LibDoefinStorage.AppStorage;

    function createOrder(
        uint256 positionId,
        address collateralToken,
        uint256 amount,
        uint256 pricePerToken,
        uint256 minFillAmount,
        uint32 expiry,
        bool fillOrKill,
        LibDoefinStorage.OrderDirection direction,
        LibDoefinStorage.ExecutionType executionType,
        LibDoefinStorage.CrossCurrencyData memory crossCurrencyData
    ) external override {
        LibOrderbook.createOrder(
            positionId,
            collateralToken,
            amount,
            pricePerToken,
            minFillAmount,
            expiry,
            fillOrKill,
            direction,
            executionType,
            crossCurrencyData
        );
    }
}
