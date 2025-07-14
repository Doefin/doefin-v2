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

    /// @notice Struct representing a single limit or market order
    /// @dev Each order maps to a specific ERC1155 position token and can be either a buy or a sell
    struct Order {
        /// @notice Unique order identifier (incremental)
        uint256 orderId;
        /// @notice Creator of the order
        address maker;
        /// @notice ERC1155 token ID of the position being traded (e.g., YES/NO token)
        uint256 positionId;
        /// @notice Total size of the order
        uint256 amount;
        /// @notice Amount of the order that has already been filled
        uint256 filledAmount;
        /// @notice Minimum amount that must be filled in a single fill (0 for no minimum)
        uint256 minFillAmount;
        /// @notice Price per token (in collateral units, e.g., 1.25 USDC per YES)
        uint256 pricePerToken;
        /// @notice Timestamp after which the order becomes invalid (0 = no expiry)
        uint256 expiry;
        /// @notice Timestamp of the order creation time
        uint256 createdAt;
        /// @notice Index set indicating outcome slot(s): 1 = YES, 2 = NO, etc.
        uint256 indexSet;
        /// @notice Address of the ERC20 collateral token used for settlement (e.g., USDC)
        address collateralToken;
        /// @notice Whether the order is currently active (true = open, false = cancelled/filled/expired)
        bool active;
        /// @notice Condition ID that this order’s position belongs to
        bytes32 conditionId;
        /// @notice Buy or Sell side of the order
        OrderDirection direction;
        /// @dev Reserved gap for future upgrades
        uint256[20] __gap;
    }

    /// @notice Global storage layout for the Orderbook facet/module
    struct OrderbookStorageStruct {
        /// @notice Mapping from order ID to Order struct
        mapping(uint256 => Order) orders;
        /// @notice Mapping of position ID to array of active buy order IDs
        mapping(uint256 => uint256[]) buyOrdersByPosition;
        /// @notice Mapping of position ID to array of active sell order IDs
        mapping(uint256 => uint256[]) sellOrdersByPosition;
        /// @notice Mapping from maker address to list of their order IDs
        mapping(address => uint256[]) ordersByMaker;
        /// @dev Reserved gap for future storage extensions
        uint256[20] __gap;
    }

    struct DiamondStorage {
        ConditionalTokensStorage conditionalTokens;
        ConditionManagerStorage conditionManager;
        AccessControlStorage accessControl;
        ERC1155Storage erc1155Storage;
        AdminConfigStorage adminConfigStorage;
        uint256[50] __gap;
    }

    function diamondStorage() internal pure returns (DiamondStorage storage ds) {
        bytes32 position = STORAGE_POSITION;
        assembly {
            ds.slot := position
        }
    }
}
