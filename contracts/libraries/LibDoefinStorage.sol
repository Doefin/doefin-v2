// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

library LibDoefinStorage {
    bytes32 constant STORAGE_POSITION = keccak256("doefin.storage");

    struct ERC1155Storage {
        mapping(uint256 => mapping(address => uint256)) erc1155Balances;
        mapping(address => mapping(address => bool)) erc1155OperatorApprovals;
        uint256[20] __gap;
    }

    struct ConditionalTokensStorage {
        mapping(bytes32 => uint256[]) payoutNumerators; // conditionId => numerators
        mapping(bytes32 => uint256) payoutDenominator; // conditionId => denominator
        uint256[10] __gap;
    }

    struct Condition {
        address oracle;
        bytes32 questionId;
        uint8 outcomeSlotCount;
        string metadataURI;
        bool active;
        address creator;
        uint256[10] __gap;
    }

    struct ConditionManagerStorage {
        mapping(bytes32 => Condition) conditions; // conditionId => Condition
        uint256[10] __gap;
    }

    struct AccessControlStorage {
        mapping(address => bool) marketMakers;
        uint256[10] __gap;
    }

    struct AdminConfigStorage {
        mapping(address => bool) isAllowed;
        mapping(address => uint256) unitPerPair; // token => unit amount (e.g., 1e6 USDC)
        address feeReceiver;
        uint256 resolutionFeeBps;
        uint256 makerTradingFeeBps;
        uint256 takerTradingFeeBps;
        uint256[10] __gap;
    }

    /// @notice Enum representing whether an order is a Buy or a Sell
    enum OrderDirection {
        Buy,
        Sell
    }

    struct SimulatedOrder {
        uint256 orderId;
        uint256 pricePerToken;
        uint256 available;
        uint256 takerFeeBps;
    }

    struct FillContext {
        uint256 amount;
        uint256 totalFilled;
        uint256 maxAveragePrice;
        uint256 totalCost;
    }

    struct OrderFeeConfig {
        uint256 makerFeeBps;
        uint256 takerFeeBps;
    }

    struct SettleContext {
        address taker;
        address maker;
        address collateralToken;
        uint256 positionId;
        uint256 amount;
        uint256 pricePerToken;
        uint256 adjustedCost;
        OrderDirection direction;
        OrderFeeConfig orderFeeConfig;
    }

    struct SettlemetExecutionContext {
        uint256 fillableAmount;
        TakerOrderContext takerOrder;
        Order makerOrder;
        MatchType matchType;
    }

    struct ModifyCollateralContext {
        address maker;
        address collateralToken;
        uint256 positionId;
        uint256 makerFeeBps;
        uint256 oldAmount;
        uint256 newAmount;
        uint256 oldPrice;
        uint256 newPrice;
        OrderDirection direction;
    }

    struct SimulationContext {
        uint256[] complementaryOrders;
        uint256[] mintOrMergeOrders;
        LibDoefinStorage.MatchType siblingMatchType;
        LibDoefinStorage.OrderDirection direction;
        uint256 collateralUnit;
        uint256 desiredMarketAmount;
        uint256 matchCount;
    }

    struct MatchExecution {
        uint256 matchedOrderId;
        uint256 amount;
        uint256 effectivePrice;
        MatchType matchType;
    }

    struct MatchOrderRoute {
        MatchExecution[] matches;
        uint256 totalInputAmount;
        uint256 totalOutputAmount;
    }

    struct TakerOrderContext {
        address taker;
        uint256 positionId;
        uint256 amount;
        uint256 remainingAmount;
        uint256 targetAvgPrice;
        bool fillOrKill;
        OrderDirection direction;
    }

    enum MatchType {
        Complementary,
        Mint, // Via split (matching against sibling Buy)
        Merge // Via merge (matching against sibling Sell)
    }

    struct MatchedFill {
        uint256 matchedOrderId; // ID of the matched limit order (always real)
        address matchedMaker; // Maker of the matched limit order
        uint256 fillAmount; // Amount filled in this match
        uint256 pricePerToken; // Price used for this fill
        MatchType matchType; // Complementary, Mint, Merge
    }

    /// @notice Struct representing a single limit or market order
    /// @dev Each order maps to a specific ERC1155 position token and can be either a buy or a sell
    struct Order {
        /// @notice Unique order identifier (incremental)
        uint256 orderId;
        /// @notice Creator of the order
        address maker;
        /// @notice Position Id of the token
        uint256 positionId;
        /// @notice Address of the requested ERC20 token
        address collateralToken;
        /// @notice Total size of the order
        uint256 amount;
        /// @notice Amount of the order that has already been filled
        uint256 remainingAmount;
        /// @notice Minimum amount that must be filled in a single fill (0 for no minimum)
        uint256 minFillAmount;
        /// @notice Price per token (in collateral units, e.g., 1.25 USDC per YES)
        uint256 pricePerToken;
        /// @notice Timestamp after which the order becomes invalid (0 = no expiry)
        uint256 expiry;
        /// @notice Timestamp of the order creation time
        uint256 createdAt;
        /// @notice Whether the order is currently active (true = open, false = cancelled/filled/expired)
        bool active;
        /// @notice Buy or Sell side of the order
        OrderDirection direction;
        /// @notice Maker and Taker Fees
        OrderFeeConfig orderFeeConfig;
        /// @dev Reserved gap for future upgrades
        uint256[20] __gap;
    }

    /// @notice Global storage layout for the Orderbook facet/module
    struct OrderbookStorageStruct {
        uint256 nextOrderId;
        /// @notice Mapping from order ID to Order struct
        mapping(uint256 => Order) orders;
        /// @notice Mapping of position ID to array of active buy order IDs
        mapping(uint256 => uint256[]) buyOrdersByPosition;
        /// @notice Mapping of position ID to array of active sell order IDs
        mapping(uint256 => uint256[]) sellOrdersByPosition;
        /// @notice Mapping from maker address to list of their order IDs
        uint256[20] __gap;
    }

    struct EscrowStorage {
        mapping(address => mapping(address => uint256)) collateralBalances; // user => ERC20 token => amount
        mapping(address => mapping(uint256 => uint256)) lockedERC1155Balances; // user => positionId => amount
        mapping(address => uint256) protocolFees; // ERC20 token => total accumulated
    }

    struct MarketMetadata {
        address collateralToken;
        bytes32 parentCollectionId;
        uint256[] positionIds;
        uint256[] partitions;
    }

    struct PositionRegistryStorage {
        mapping(uint256 => bytes32) conditionIdByPositionId;
        mapping(bytes32 => MarketMetadata) marketsByCondition;
        uint256[10] __gap;
    }

    struct DiamondStorage {
        ConditionalTokensStorage conditionalTokens;
        ConditionManagerStorage conditionManager;
        AccessControlStorage accessControl;
        ERC1155Storage erc1155Storage;
        AdminConfigStorage adminConfigStorage;
        OrderbookStorageStruct orderbookStorage;
        EscrowStorage escrowStorage;
        PositionRegistryStorage positionRegistry;
        uint256[50] __gap;
    }

    function diamondStorage() internal pure returns (DiamondStorage storage ds) {
        bytes32 position = STORAGE_POSITION;
        assembly {
            ds.slot := position
        }
    }
}
