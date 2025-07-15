// SPDX-License-Identifier: AGPL-3.0
// Uses shared storage derived from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {IOrderbookFacet} from "../interfaces/IOrderbook.sol";
import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {LibCTHelpers} from "../libraries/LibCTHelpers.sol";
import {LibERC1155} from "../libraries/LibERC1155.sol";
import {LibEscrow} from "../libraries/LibEscrow.sol";
import {LibERC1155} from "../libraries/LibERC1155.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract OrderbookFacet is IOrderbookFacet {
    using SafeERC20 for IERC20;

    function createLimitOrder(
        LibDoefinStorage.Position calldata positionParams,
        uint256 amount,
        uint256 pricePerToken,
        uint256 minFillAmount,
        uint256 expiry,
        LibDoefinStorage.OrderDirection direction
    ) external override returns (uint256 orderId) {
        enforceValidPositionId(positionParams);
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        // Generate new order ID
        orderId = ds.orderbookStorage.orders[0].orderId + 1;
        ds.orderbookStorage.orders[0].orderId = orderId;

        uint256 positionId = positionParams.positionId;
        bytes32 conditionId = positionParams.conditionId;
        address collateralToken = positionParams.collateralToken;

        // Lock escrow from msg.sender to contract
        _lockEscrowWithEvent(msg.sender, amount, pricePerToken, positionId, collateralToken, direction);

        if (direction == LibDoefinStorage.OrderDirection.Sell) {
            // Split positioin to own the Token and then sell it.
        }

        LibDoefinStorage.Order memory order = LibDoefinStorage.Order({
            orderId: orderId,
            maker: msg.sender,
            positionParams: positionParams,
            amount: amount,
            filledAmount: 0,
            minFillAmount: minFillAmount,
            pricePerToken: pricePerToken,
            expiry: expiry,
            createdAt: block.timestamp,
            active: true,
            direction: direction,
            __gap: [uint256(0), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        });

        // Store the order
        ds.orderbookStorage.orders[orderId] = order;
        if (direction == LibDoefinStorage.OrderDirection.Buy) {
            insertSorted(ds.orderbookStorage.buyOrdersByPosition[positionId], orderId, direction);
        } else {
            insertSorted(ds.orderbookStorage.sellOrdersByPosition[positionId], orderId, direction);
        }

        emit OrderCreated(orderId, msg.sender, positionId, amount, pricePerToken, block.timestamp, direction, conditionId);
    }

    /// @notice Cancels an open order by ID
    /// @param orderId The ID of the order to cancel
    function cancelOrder(uint256 orderId) external override {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[orderId];

        require(order.active, "Orderbook: Order is inactive or already canceled");
        require(order.maker == msg.sender, "Orderbook: Only maker can cancel");

        // Mark order inactive
        order.active = false;

        // Release only the remaining unfilled portion
        uint256 remainingAmount = order.amount - order.filledAmount;

        if (remainingAmount > 0) {
            _releaseEscrowWithEvent(
                order.maker,
                remainingAmount,
                order.pricePerToken,
                order.positionParams.positionId,
                order.positionParams.collateralToken,
                order.direction
            );
        }

        emit OrderCanceled(orderId);
    }

    function fillMarketOrderWithRoute(
        LibDoefinStorage.Position calldata positionParams,
        uint256 amount,
        bool fillOrKill,
        LibDoefinStorage.OrderDirection direction,
        LibDoefinStorage.MatchOrderRoute calldata matchOrderRoute,
        uint256 totalCost
    ) external override {
        enforceValidPositionId(positionParams);
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        uint256 totalFilled;
        uint256 len = matchOrderRoute.matchedOrderIds.length;

        address collateralToken = positionParams.collateralToken;
        uint256 positionId = positionParams.positionId;

        require(len == matchOrderRoute.matchedAmounts.length, "Orderbook: Length mismatch");

        for (uint256 i = 0; i < len; i++) {
            uint256 orderId = matchOrderRoute.matchedOrderIds[i];
            uint256 fillAmount = matchOrderRoute.matchedAmounts[i];

            LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[orderId];

            require(order.active, "Orderbook: Order inactive");
            require(order.expiry == 0 || block.timestamp <= order.expiry, "Orderbook: Order expired");
            require(order.amount - order.filledAmount >= fillAmount, "Orderbook: Overfill");

            address maker = order.maker;

            if (direction == LibDoefinStorage.OrderDirection.Buy) {
                // Taker pays collateral, receives ERC1155
                uint256 cost = fillAmount * order.pricePerToken;

                // Transfer collateral from taker to maker
                IERC20(collateralToken).safeTransferFrom(msg.sender, maker, cost);

                // Transfer ERC1155 from escrow (locked by maker) to taker
                LibERC1155.safeTransferFrom(address(this), address(this), msg.sender, positionId, fillAmount, "");
            } else {
                // Taker sells ERC1155 to maker, receives collateral
                uint256 payout = fillAmount * order.pricePerToken;

                // Transfer ERC1155 from taker to maker
                LibERC1155.safeTransferFrom(address(this), msg.sender, maker, positionId, fillAmount, "");

                // Release collateral from escrow to taker
                IERC20(collateralToken).safeTransfer(msg.sender, payout);
            }

            // Update order
            order.filledAmount += fillAmount;
            totalFilled += fillAmount;

            if (order.filledAmount == order.amount) {
                order.active = false;
            }

            removeOrderIdFromArray(
                direction == LibDoefinStorage.OrderDirection.Buy
                    ? ds.orderbookStorage.sellOrdersByPosition[positionId]
                    : ds.orderbookStorage.buyOrdersByPosition[positionId],
                orderId
            );

            delete ds.orderbookStorage.orders[orderId];

            emit MarketOrderFilled(orderId, msg.sender, fillAmount, fillAmount * order.pricePerToken, order.amount - order.filledAmount);
        }

        if (fillOrKill) {
            require(totalFilled == amount, "Orderbook: FillOrKill failed");
        }
    }

    function modifyLimitOrder(uint256 orderId, uint256 newAmount, uint256 newPrice, uint256 newMinFillAmount, uint256 newExpiry) external override {}

    function batchCleanupOrders(uint256[] calldata orderIds) external override {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        for (uint256 i = 0; i < orderIds.length; i++) {
            uint256 orderId = orderIds[i];
            LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[orderId];

            if (!order.active || order.amount == order.filledAmount || (order.expiry != 0 && order.expiry < block.timestamp)) {
                order.active = false;

                uint256[] storage book = order.direction == LibDoefinStorage.OrderDirection.Buy
                    ? ds.orderbookStorage.buyOrdersByPosition[order.positionParams.positionId]
                    : ds.orderbookStorage.sellOrdersByPosition[order.positionParams.positionId];

                // Remove orderId from the order book array
                for (uint256 j = 0; j < book.length; j++) {
                    if (book[j] == orderId) {
                        book[j] = book[book.length - 1];
                        book.pop();
                        break;
                    }
                }
            }
        }
    }

    function enforceValidPositionId(LibDoefinStorage.Position calldata pos) internal view {
        bytes32 collectionId = LibCTHelpers.getCollectionId(pos.parentCollectionId, pos.conditionId, pos.indexSet);
        uint256 expectedPositionId = LibCTHelpers.getPositionId(pos.collateralToken, collectionId);
        require(expectedPositionId == pos.positionId, "Orderbook: Invalid positionId");
    }

    /// @notice Simulates a market order to preview matched orders and pricing
    /// @param positionParams includes all required data to compute positionId
    /// @param amount Amount to fill
    /// @param direction Buy or Sell
    /// @return matchedOrderIds IDs of matched limit orders
    /// @return matchedAmounts Corresponding fill amounts
    /// @return totalCost Total collateral required (if buying) or received (if selling)
    /// @return averagePrice Weighted average fill price
    function simulateMarketOrder(
        LibDoefinStorage.Position calldata positionParams,
        uint256 amount,
        LibDoefinStorage.OrderDirection direction
    ) external view returns (uint256[] memory matchedOrderIds, uint256[] memory matchedAmounts, uint256 totalCost, uint256 averagePrice) {
        enforceValidPositionId(positionParams);
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        uint256[] storage book = direction == LibDoefinStorage.OrderDirection.Buy
            ? ds.orderbookStorage.sellOrdersByPosition[positionParams.positionId]
            : ds.orderbookStorage.buyOrdersByPosition[positionParams.positionId];

        uint256[] memory tempIds = new uint256[](book.length);
        uint256[] memory tempAmounts = new uint256[](book.length);

        uint256 matched = 0;
        totalCost = 0;

        for (uint256 i = 0; i < book.length && matched < amount; i++) {
            LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[book[i]];

            if (!order.active) continue;
            if (order.expiry != 0 && order.expiry < block.timestamp) continue;

            uint256 available = order.amount - order.filledAmount;
            if (available == 0) continue;

            uint256 toMatch = (matched + available > amount) ? amount - matched : available;

            matched += toMatch;
            totalCost += toMatch * order.pricePerToken;

            tempIds[i] = order.orderId;
            tempAmounts[i] = toMatch;
        }

        if (matched < amount) {
            revert("simulateMarketOrder: Couldn't satisify the ammount");
        }

        // Compact matched arrays
        uint256 count = 0;
        for (uint256 i = 0; i < tempIds.length; i++) {
            if (tempAmounts[i] > 0) count++;
        }

        matchedOrderIds = new uint256[](count);
        matchedAmounts = new uint256[](count);

        uint256 j = 0;
        for (uint256 i = 0; i < tempIds.length; i++) {
            if (tempAmounts[i] > 0) {
                matchedOrderIds[j] = tempIds[i];
                matchedAmounts[j] = tempAmounts[i];
                j++;
            }
        }

        averagePrice = matched > 0 ? totalCost / matched : 0;
    }

    /// @notice Retrieves the details of a specific order
    /// @param orderId The ID of the order to fetch
    /// @return Order struct with full order details
    function getOrder(uint256 orderId) external view override returns (LibDoefinStorage.Order memory) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        return ds.orderbookStorage.orders[orderId];
    }

    /// @notice Retrieves the orderbook for a specific positionId and direction
    /// @param positionId The Position ID of the orderbook
    /// @return Ordirectionder Direction for the orderbook
    /// @dev For test/debug only
    function getOrderbook(uint256 positionId, LibDoefinStorage.OrderDirection direction) external view override returns (uint256[] memory) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        if (direction == LibDoefinStorage.OrderDirection.Buy) {
            return ds.orderbookStorage.buyOrdersByPosition[positionId];
        } else {
            return ds.orderbookStorage.sellOrdersByPosition[positionId];
        }
    }

    /// @notice Returns the best available price for a given position and direction
    /// @param positionId Position to check
    /// @param direction Buy or Sell
    /// @return price Best available price in collateral units
    /// @return amount available for the best price
    function getBestPrice(
        uint256 positionId,
        LibDoefinStorage.OrderDirection direction
    ) external view override returns (uint256 price, uint256 amount) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        uint256[] storage book = direction == LibDoefinStorage.OrderDirection.Buy
            ? ds.orderbookStorage.sellOrdersByPosition[positionId]
            : ds.orderbookStorage.buyOrdersByPosition[positionId];

        for (uint256 i = 0; i < book.length; i++) {
            LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[book[i]];
            if (!order.active) continue;
            if (order.expiry != 0 && order.expiry < block.timestamp) continue;

            uint256 remaining = order.amount - order.filledAmount;
            if (remaining > 0) {
                return (order.pricePerToken, remaining);
            }
        }

        return (0, 0); // No available orders
    }

    /// @notice Returns the next order ID to be assigned
    /// @return The current next order ID (incremented per new order)
    function getNextOrderId() external view override returns (uint256) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        return ds.orderbookStorage.orders[0].orderId + 1;
    }

    function _releaseEscrowWithEvent(
        address to,
        uint256 amount,
        uint256 pricePerToken,
        uint256 positionId,
        address collateralToken,
        LibDoefinStorage.OrderDirection direction
    ) internal {
        LibEscrow.releaseEscrow(to, amount, pricePerToken, positionId, collateralToken, direction);
        emit EscrowReleased(to, collateralToken, positionId, amount, pricePerToken, direction);
    }

    function _lockEscrowWithEvent(
        address from,
        uint256 amount,
        uint256 pricePerToken,
        uint256 positionId,
        address collateralToken,
        LibDoefinStorage.OrderDirection direction
    ) internal {
        LibEscrow.lockEscrow(from, amount, pricePerToken, positionId, collateralToken, direction);
        emit EscrowLocked(from, collateralToken, positionId, amount, pricePerToken, direction);
    }

    function removeOrderIdFromArray(uint256[] storage arr, uint256 orderId) internal {
        for (uint256 i = 0; i < arr.length; i++) {
            if (arr[i] == orderId) {
                arr[i] = arr[arr.length - 1]; // Replace with last
                arr.pop();
                break;
            }
        }
    }

    function insertSorted(uint256[] storage orderArray, uint256 orderId, LibDoefinStorage.OrderDirection direction) internal {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        LibDoefinStorage.Order storage newOrder = ds.orderbookStorage.orders[orderId];
        uint256 price = newOrder.pricePerToken;

        uint256 i = 0;

        // Ascending for Sell (lowest price first)
        // Descending for Buy (highest price first)
        while (i < orderArray.length) {
            LibDoefinStorage.Order storage existing = ds.orderbookStorage.orders[orderArray[i]];
            if (
                (direction == LibDoefinStorage.OrderDirection.Sell && price < existing.pricePerToken) ||
                (direction == LibDoefinStorage.OrderDirection.Buy && price > existing.pricePerToken)
            ) {
                break;
            }
            i++;
        }

        // Insert at position i
        orderArray.push(orderId); // expand length
        for (uint256 j = orderArray.length - 1; j > i; j--) {
            orderArray[j] = orderArray[j - 1];
        }
        orderArray[i] = orderId;
    }
}
