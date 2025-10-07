// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

library LibDoefinStorage {
    bytes32 constant STORAGE_POSITION = keccak256("doefin.storage");

    // Add initialization flag
    bytes32 constant INITIALIZED_POSITION = keccak256("doefin.storage.initialized");

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
        uint16 resolutionFeeBps;
        uint16 makerTradingFeeBps;
        uint16 takerTradingFeeBps;
        uint256[10] __gap;
    }

    /// @notice Enum representing whether an order is a Buy or a Sell
    enum OrderDirection {
        Buy,
        Sell
    }

    enum ExecutionType {
        Market,
        Limit
    }

    struct OrderFeeConfig {
        uint16 makerFeeBps;
        uint16 takerFeeBps;
    }

    struct SettlementExecutionContext {
        uint256 fillableAmount;
        TakerOrderContext takerOrder;
        Order makerOrder;
        MatchType matchType;
        ExecutionType executionType;
    }

    struct ModifyCollateralContext {
        address maker;
        address collateralToken;
        uint256 positionId;
        uint16 makerFeeBps;
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

    struct Match {
        uint256 matchedOrderId;
        uint256 amount;
        uint256 effectivePrice;
        MatchType matchType;
    }

    struct MatchOrderRoute {
        Match[] matches;
        uint256 totalInputAmount;
        uint256 totalOutputAmount;
    }

    struct TakerOrderContext {
        uint256 orderId;
        address taker;
        uint256 positionId;
        uint256 amount;
        uint256 remainingAmount;
        uint256 targetAvgPrice;
        uint16 takerPaidFeeBps;
        bool fillOrKill;
        OrderDirection direction;
    }

    enum MatchType {
        Complementary,
        Mint, // Via split (matching against sibling Buy)
        Merge // Via merge (matching against sibling Sell)
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
        /// @notice Amount remaining to be filled
        uint256 remainingAmount;
        /// @notice Minimum amount that must be filled in a single fill (0 for no minimum)
        uint256 minFillAmount;
        /// @notice Price per token (in collateral units, e.g., 1.25 USDC per YES)
        uint256 pricePerToken;
        /// @notice Timestamp after which the order becomes invalid (0 = no expiry)
        uint256 expiry;
        /// @notice Timestamp of the order creation time
        uint256 createdAt;
        /// @notice Maker and Taker Fees
        OrderFeeConfig orderFeeConfig;
        // These 4 fields will be packed into a single slot (Slot 13):
        /// @notice Buy or Sell side of the order
        OrderDirection direction;
        /// @notice Type of order execution
        ExecutionType executionType;
        /// @notice Whether the order is currently active
        bool active;
        /// @notice Whether the order must be filled completely
        bool fillOrKill;
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
        /// @notice Added Extra Gaps for safe upgrades
        uint256[20] __gap;
    }

    struct EscrowStorage {
        mapping(address => mapping(address => uint256)) collateralBalances; // user => ERC20 token => amount
        mapping(address => mapping(uint256 => uint256)) lockedERC1155Balances; // user => positionId => amount
        mapping(address => uint256) protocolFees; // ERC20 token => total accumulated
        uint256[10] __gap;
    }

    struct MarketMetadata {
        address collateralToken;
        bytes32 parentCollectionId;
        uint256[] positionIds;
        uint256[] partitions;
    }

    struct PositionRegistryStorage {
        // Unique market metadata by composite key
        mapping(bytes32 => MarketMetadata) marketsByKey; // marketKey => metadata
        // Track all market keys for a given conditionId
        mapping(bytes32 => bytes32[]) marketKeysByCondition; // conditionId => marketKey[]
        // Reverse lookups
        mapping(uint256 => bytes32) conditionIdByPositionId; // positionId => conditionId
        mapping(uint256 => bytes32) marketKeyByPositionId; // positionId => marketKey
        uint256[10] __gap;
    }

    struct ReentrancyStorage {
        uint256 _status;
        uint256[10] __gap;
    }

    struct AppStorage {
        ConditionalTokensStorage conditionalTokens;
        ConditionManagerStorage conditionManager;
        AccessControlStorage accessControl;
        ERC1155Storage erc1155Storage;
        AdminConfigStorage adminConfigStorage;
        OrderbookStorageStruct orderbookStorage;
        EscrowStorage escrowStorage;
        PositionRegistryStorage positionRegistry;
        ReentrancyStorage reentrancyStorage;
        uint256[50] __gap;
    }

    function appStorage() internal pure returns (AppStorage storage ds) {
        bytes32 position = STORAGE_POSITION;
        assembly {
            ds.slot := position
        }
    }

    /// @notice Initialize critical storage values (call once during deployment)
    function initialize(address feeReceiver, uint16 resolutionFeeBps, uint16 makerFeeBps, uint16 takerFeeBps) internal {
        require(!isInitialized(), "Already initialized");

        AppStorage storage ds = appStorage();

        ds.orderbookStorage.nextOrderId = 1;
        ds.reentrancyStorage._status = 1;

        // Set admin config during initialization
        ds.adminConfigStorage.feeReceiver = feeReceiver;
        ds.adminConfigStorage.resolutionFeeBps = resolutionFeeBps;
        ds.adminConfigStorage.makerTradingFeeBps = makerFeeBps;
        ds.adminConfigStorage.takerTradingFeeBps = takerFeeBps;

        setInitialized();
    }

    /// @notice Check if storage has been initialized
    function isInitialized() internal view returns (bool initialized) {
        bytes32 position = INITIALIZED_POSITION;
        assembly {
            initialized := sload(position)
        }
    }

    /// @notice Mark storage as initialized
    function setInitialized() internal {
        bytes32 position = INITIALIZED_POSITION;
        assembly {
            sstore(position, 1)
        }
    }
}
