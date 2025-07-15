// SPDX-License-Identifier: AGPL-3.0
// Uses shared storage derived from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";

/// @title IOrderbookFacet - Interface for on-chain orderbook operations in a prediction/betting market
/// @notice Supports creation, simulation, and execution of limit and market orders for ERC1155 positions
/// @dev Works with Conditional Tokens Framework (CTF)-style position IDs and indexSets
interface IOrderbookFacet {
    /// ---------------------------
    /// Events
    /// ---------------------------

    /// @notice Emitted when a new order is created
    /// @param orderId The unique identifier of the newly created order
    /// @param maker The address of the user who created the order
    /// @param positionId The ERC1155 token ID representing the position
    /// @param amount The number of tokens offered or requested in the order
    /// @param pricePerToken The price per token (in units of collateral)
    /// @param createdAt Timestamp of the order creation time
    /// @param direction The order direction: Buy or Sell
    /// @param conditionId The ID of the condition associated with this order
    event OrderCreated(
        uint256 indexed orderId,
        address indexed maker,
        uint256 positionId,
        uint256 amount,
        uint256 pricePerToken,
        uint256 createdAt,
        LibDoefinStorage.OrderDirection direction,
        bytes32 conditionId
    );

    /// @notice Emitted when a limit order is partially or fully filled by a market order
    /// @param orderId The ID of the limit order that was matched
    /// @param taker The address that submitted the market order (taker)
    /// @param amountFilled The quantity of tokens filled from the limit order
    /// @param totalCollateralPaid The total collateral the taker paid for the filled amount
    /// @param remainingAmount The unfilled amount remaining in the limit order after the trade
    event MarketOrderFilled(
        uint256 indexed orderId,
        address indexed taker,
        uint256 amountFilled,
        uint256 totalCollateralPaid,
        uint256 remainingAmount
    );

    /// @notice Emitted when an order is canceled
    /// @param orderId The ID of the canceled order
    event OrderCanceled(uint256 indexed orderId);

    /// @notice Emitted when an expired order is being chosen to be matched,
    /// @param orderId The ID of the canceled order
    event OrderExpired(uint256 indexed orderId);

    /// @notice Emitted when an existing order is modified
    /// @param orderId The ID of the updated order
    /// @param newAmount The new total amount for the order
    /// @param newPricePerToken The new price per token
    /// @param newMinFillAmount The updated minimum fill constraint
    /// @param newExpiry The new expiry timestamp
    event OrderUpdated(uint256 indexed orderId, uint256 newAmount, uint256 newPricePerToken, uint256 newMinFillAmount, uint256 newExpiry);

    /// @notice Emitted when a market order fails due to FillOrKill=true and insufficient liquidity
    /// @param taker The address that attempted to place the market order
    /// @param positionId ERC1155 token ID being traded
    /// @param direction Whether the order is Buy or Sell
    /// @param requestedAmount The amount that was attempted to be bought/sold
    /// @param matchedOrderIds Array of matched limit order IDs
    /// @param matchedAmounts Corresponding fill amounts for each matched order
    /// @param totalCost Total collateral to be spent (Buy) or received (Sell) must match simulation to prevent slippage

    event OrderRejectedFillOrKill(
        address indexed taker,
        uint256 positionId,
        LibDoefinStorage.OrderDirection direction,
        uint256 requestedAmount,
        uint256[] matchedOrderIds,
        uint256[] matchedAmounts,
        uint256 totalCost
    );

    event EscrowLocked(
        address indexed from,
        address indexed asset,
        uint256 positionId,
        uint256 amount,
        uint256 pricePerToken,
        LibDoefinStorage.OrderDirection direction
    );

    event EscrowReleased(
        address indexed to,
        address indexed asset,
        uint256 positionId,
        uint256 amount,
        uint256 pricePerToken,
        LibDoefinStorage.OrderDirection direction
    );

    /// @notice Emitted when expired or inactive orders are removed from storage
    /// @param orderIds Array of removed order IDs.
    event OrdersBatchCleaned(uint256[] orderIds);

    /// ----------------------------
    /// Admin Functions
    /// ----------------------------

    /// @notice Admin-only function to batch clean up expired, filled, or inactive orders.
    /// @dev The list of order IDs is computed off-chain; this function verifies and removes them on-chain.
    /// @param orderIds Array of order IDs proposed for deletion.
    function batchCleanupOrders(uint256[] calldata orderIds) external;

    /// ------------------------------
    /// Write Functions (Core Trading)
    /// ------------------------------

    /// @notice Create a new limit order on the orderbook
    /// @param positionParams includes all required data to compute positionId
    /// @param amount Total amount of tokens to trade
    /// @param pricePerToken Price per token in collateral units
    /// @param minFillAmount Minimum acceptable fill in a single match
    /// @param expiry Timestamp when the order becomes invalid (0 = no expiry)
    /// @param direction Whether the order is Buy or Sell
    /// @return orderId The ID of the newly created order
    function createLimitOrder(
        LibDoefinStorage.Position calldata positionParams,
        uint256 amount,
        uint256 pricePerToken,
        uint256 minFillAmount,
        uint256 expiry,
        LibDoefinStorage.OrderDirection direction
    ) external returns (uint256 orderId);

    /// @notice Executes a market order against specific matched orders
    /// @dev Reverts if FillOrKill is true and full amount cannot be matched
    /// @param positionParams includes all required data to compute positionId
    /// @param amount Total desired fill amount
    /// @param fillOrKill Whether the order must be completely filled or revert
    /// @param direction Buy or Sell
    /// @param matchOrderRoute Includes matchedOrderIds and matchedAmounts Arrayes of matched limit order IDs
    /// @param totalCost Total collateral to be spent (Buy) or received (Sell), must match simulation to prevent slippage

    function fillMarketOrderWithRoute(
        LibDoefinStorage.Position calldata positionParams,
        uint256 amount,
        bool fillOrKill,
        LibDoefinStorage.OrderDirection direction,
        LibDoefinStorage.MatchOrderRoute calldata matchOrderRoute,
        uint256 totalCost
    ) external;

    /// @notice Cancels an open order by ID
    /// @param orderId The ID of the order to cancel
    function cancelOrder(uint256 orderId) external;

    /// @notice Updates a limit order with new parameters
    /// @param orderId Order to update
    /// @param newAmount New amount for the order
    /// @param newPrice New price per token
    /// @param newMinFillAmount New minimum fill constraint
    /// @param newExpiry New expiry timestamp
    function modifyLimitOrder(uint256 orderId, uint256 newAmount, uint256 newPrice, uint256 newMinFillAmount, uint256 newExpiry) external;

    /// --------------------
    /// View/Simulation
    /// --------------------

    /// @notice Retrieves the details of a specific order
    /// @param orderId The ID of the order to fetch
    /// @return Order struct with full order details
    function getOrder(uint256 orderId) external view returns (LibDoefinStorage.Order memory);

    /// @notice Retrieves the orderbook for a specific positionId and direction
    /// @param positionId The Position ID of the orderbook
    /// @return Ordirectionder Direction for the orderbook
    /// @dev For test/debug only
    function getOrderbook(uint256 positionId, LibDoefinStorage.OrderDirection direction) external view returns (uint256[] memory);

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
    ) external view returns (uint256[] memory matchedOrderIds, uint256[] memory matchedAmounts, uint256 totalCost, uint256 averagePrice);

    /// @notice Returns the best available price for a given position and direction
    /// @param positionId Position to check
    /// @param direction Buy or Sell
    /// @return price Best available price in collateral units
    /// @return amount available for the best price
    function getBestPrice(uint256 positionId, LibDoefinStorage.OrderDirection direction) external view returns (uint256 price, uint256 amount);

    /// @notice Returns the next order ID to be assigned
    /// @return The current next order ID (incremented per new order)
    function getNextOrderId() external view returns (uint256);
}
