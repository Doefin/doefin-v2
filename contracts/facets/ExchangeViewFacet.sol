// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {LibCollateralManager} from "../libraries/LibCollateralManager.sol";
import {LibPositionRegistry} from "../libraries/LibPositionRegistry.sol";
import {IExchangeView} from "../interfaces/IExchangeView.sol";

/**
 * @title ExchangeViewFacet
 * @author Doefin
 * @notice Diamond facet providing view-only functions for exchange operations and data queries
 * @dev Size-optimized facet containing read-only functions split from main exchange functionality
 * @dev Part of the Diamond pattern implementation for modular smart contract architecture
 * @dev All functions are view/pure and do not modify state, making them gas-efficient for queries
 * @custom:facet View-only exchange operations separated for contract size optimization
 * @custom:diamond Part of the EIP-2535 Diamond Standard implementation
 * @custom:gas Optimized for read operations with minimal gas consumption
 */
contract ExchangeViewFacet is IExchangeView {
    using LibDoefinStorage for LibDoefinStorage.AppStorage;

    /**
     * @notice Retrieves the next order ID that will be assigned to new orders
     * @dev Returns the incremental counter maintained in orderbook storage
     * @dev Used for order ID prediction and orderbook state monitoring
     * @return The next order ID that will be used for new order creation
     * @custom:view Read-only access to orderbook storage counter
     * @custom:orderbook Essential for understanding order ID sequencing
     * @custom:gas Constant time O(1) storage read operation
     */
    function getNextOrderId() external view returns (uint256) {
        return LibDoefinStorage.appStorage().orderbookStorage.nextOrderId;
    }

    /**
     * @notice Retrieves complete details of a specific order by its unique identifier
     * @dev Returns the full Order struct containing all order parameters and state
     * @dev Includes order amounts, prices, direction, creator, timestamps, and fill status
     * @param orderId The unique identifier of the order to retrieve
     * @return The complete Order struct containing all order details including amounts, prices, timestamps, and configuration
     * @custom:view Read-only access to order storage mapping
     * @custom:orderbook Core function for order inspection and validation
     * @custom:gas Constant time O(1) mapping lookup operation
     * @custom:struct Returns LibDoefinStorage.Order with complete order data
     */
    function getOrder(uint256 orderId) external view returns (LibDoefinStorage.Order memory) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        return ds.orderbookStorage.orders[orderId];
    }

    /**
     * @notice Retrieves all order IDs in the orderbook for a specific position and trading direction
     * @dev Returns array of order IDs that can be used with getOrder() for detailed information
     * @dev Uses position-collateral pair to identify the correct orderbook segment
     * @dev Separate orderbooks maintained for buy and sell orders for efficient matching
     * @param positionId The ERC1155 position token ID to query orderbook for
     * @param direction The order direction (Buy or Sell) to filter orderbook results
     * @return Array of order IDs in the orderbook for the specified position and direction
     * @custom:view Read-only access to orderbook storage arrays
     * @custom:orderbook Essential for market depth analysis and order discovery
     * @custom:gas Linear cost based on number of orders in the specific orderbook
     * @custom:market Uses position-collateral pairing for orderbook segmentation
     */
    function getOrderbook(uint256 positionId, LibDoefinStorage.OrderDirection direction) external view returns (uint256[] memory) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        address collateralToken = LibPositionRegistry.getCollateralToken(positionId);
        bytes32 bookId = keccak256(abi.encodePacked(positionId, collateralToken));
        if (direction == LibDoefinStorage.OrderDirection.Buy) {
            return ds.orderbookStorage.buyOrdersByPositionAndCurrency[bookId];
        } else {
            return ds.orderbookStorage.sellOrdersByPositionAndCurrency[bookId];
        }
    }

    /**
     * @notice Batch retrieves multiple orders by their IDs for efficient data access
     * @dev Significantly more gas efficient than calling getOrder() multiple times individually
     * @dev Returns orders in the same sequence as the provided orderIds array
     * @param orderIds Array of order IDs to retrieve in batch
     * @return orders Array of Order structs corresponding to the provided order IDs
     * @custom:view Read-only batch access to order storage
     * @custom:optimization Gas-efficient alternative to multiple individual getOrder calls
     * @custom:batch Linear cost based on number of orders requested
     * @custom:sequence Output array maintains same order as input orderIds array
     */
    function getOrders(uint256[] calldata orderIds) external view returns (LibDoefinStorage.Order[] memory orders) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        orders = new LibDoefinStorage.Order[](orderIds.length);

        for (uint256 i = 0; i < orderIds.length; i++) {
            orders[i] = ds.orderbookStorage.orders[orderIds[i]];
        }
    }

    /**
     * @notice Retrieves comprehensive escrow status for a user across multiple tokens and positions
     * @dev Returns both ERC20 collateral balances and ERC1155 position token balances from escrow
     * @dev Essential for checking available balances before creating orders or executing trades
     * @dev Delegates to LibCollateralManager for actual balance queries and validation
     * @param user The address of the user to check escrow status for
     * @param tokens Array of ERC20 token addresses to check collateral balances for
     * @param positionIds Array of ERC1155 position token IDs to check position balances for
     * @return erc20Balances Array of ERC20 token balances held in the protocol escrow
     * @return erc1155Balances Array of ERC1155 position token balances held in the protocol escrow
     * @custom:view Read-only access to escrow balance storage
     * @custom:batch Efficient multi-token and multi-position balance checking
     * @custom:escrow Essential for order creation validation and user balance verification
     * @custom:delegation Delegates to LibCollateralManager.getEscrowStatus for implementation
     */
    function getUserEscrowStatus(
        address user,
        address[] calldata tokens,
        uint256[] calldata positionIds
    ) external view returns (uint256[] memory erc20Balances, uint256[] memory erc1155Balances) {
        return LibCollateralManager.getEscrowStatus(user, tokens, positionIds);
    }
}
