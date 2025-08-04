// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibOrderbook} from "../libraries/LibOrderbook.sol";
import {LibEscrowLogic} from "../libraries/LibEscrowLogic.sol";
import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {IExchange} from "../interfaces/IExchange.sol";

contract ExchangeFacet is IExchange {
    using LibDoefinStorage for LibDoefinStorage.DiamondStorage;

    /// @notice Create a new limit order
    function createLimitOrder(
        uint256 positionId,
        address collateralToken,
        uint256 amount,
        uint256 pricePerToken,
        uint256 minFillAmount,
        uint256 expiry,
        LibDoefinStorage.OrderDirection direction
    ) external {
        LibOrderbook.createOrder(positionId, collateralToken, amount, pricePerToken, minFillAmount, expiry, direction);
    }

    /// @notice Cancel an existing order by ID
    function cancelOrder(uint256 orderId) external {
        LibOrderbook.cancelOrder(orderId, msg.sender);
    }

    /// @notice Modify an existing limit order
    function modifyLimitOrder(uint256 orderId, uint256 newAmount, uint256 newPricePerToken, uint256 newMinFillAmount, uint256 newExpiry) external {
        LibOrderbook.modifyOrder(msg.sender, orderId, newAmount, newPricePerToken, newMinFillAmount, newExpiry);
    }

    function getNextOrderId() external view returns (uint256) {
        return LibDoefinStorage.diamondStorage().orderbookStorage.nextOrderId;
    }

    function getOrder(uint256 orderId) external view returns (LibDoefinStorage.Order memory) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        return ds.orderbookStorage.orders[orderId];
    }

    function getOrderbook(uint256 positionId, LibDoefinStorage.OrderDirection direction) external view returns (uint256[] memory) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        if (direction == LibDoefinStorage.OrderDirection.Buy) {
            return ds.orderbookStorage.buyOrdersByPosition[positionId];
        } else {
            return ds.orderbookStorage.sellOrdersByPosition[positionId];
        }
    }
}
