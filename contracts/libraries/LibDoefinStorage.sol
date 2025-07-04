// SPDX-License-Identifier: MIT
pragma solidity ^0.8.6;

library LibDoefinStorage {
    bytes32 constant STORAGE_POSITION = keccak256("doefin.storage");

    enum OrderSide { BUY, SELL }
    enum OrderStatus { OPEN, FILLED, PARTIAL, CANCELLED, EXPIRED, TRIGGERED }

    struct Order {
        bytes32 id;
        address maker;
        uint256 positionId;
        OrderSide side;
        uint256 amount;
        uint256 price;
        uint256 filled;
        uint256 collateralAmount;
        uint8 collateralPercentage;
        uint256 minFillAmount;
        uint256 triggerPrice;
        uint256 expiry;
        uint256 salt;
        bool active;
        uint256[50] __gap; // reserved for future variables
    }

    struct OrderMatch {
        bytes32 buyOrderId;
        bytes32 sellOrderId;
        uint256 matchAmount;
        uint256 executionPrice;
        uint256 timestamp;
        uint256[20] __gap;
    }

    struct PositionListing {
        uint256 positionId;
        address seller;
        uint256 amount;
        uint256 price;
        uint256 minPurchaseAmount;
        uint256 expiry;
        bool active;
        uint256[20] __gap;
    }

    struct ERC1155Storage {
        mapping(uint256 => mapping(address => uint256)) erc1155Balances;
        mapping(address => mapping(address => bool)) erc1155OperatorApprovals;
        uint256[20] __gap;
    }

    struct CollateralVaultStorage {
        mapping(address => mapping(address => uint256)) lockedBalance; // user => token => amount
        uint256[20] __gap;
    }

    struct OrderbookStorage {
        mapping(bytes32 => Order) orders; // orderId => Order
        mapping(uint256 => bytes32[]) ordersByPosition; // positionId => orderIds
        mapping(address => bytes32[]) ordersByMaker; // maker => orderIds
        mapping(bytes32 => OrderMatch[]) orderMatches; // orderId => matches
        uint256[20] __gap;
    }

    struct PositionTradingStorage {
        uint256 listingCounter;
        mapping(uint256 => PositionListing) listings; // listingId => listing
        mapping(uint256 => uint256[]) listingsByPosition; // positionId => listingIds
        mapping(address => uint256[]) listingsBySeller; // seller => listingIds
        mapping(bytes32 => uint256[]) listingsByCondition; // conditionId => listingIds
        mapping(uint256 => uint256[]) positionPriceTimestamps; // positionId => timestamps
        mapping(uint256 => uint256[]) positionPriceValues; // positionId => price points
        uint256[20] __gap;
    }

    struct Position {
        address collateralToken;
        bytes32 collectionId;
        bytes32 conditionId;
        uint256 indexSet;
        address owner;
        uint256 amount;
        uint256[10] __gap;
    }

    struct ConditionalTokensStorage {
        mapping(bytes32 => uint256[]) payoutNumerators;        // conditionId => numerators
        mapping(bytes32 => uint256) payoutDenominator;         // conditionId => denominator
        uint256[10] __gap;
    }

    struct Condition {
        address oracle;
        bytes32 questionId;
        uint256 outcomeSlotCount;
        string metadataURI;
        bool active;
        uint256[10] __gap;
    }

    struct ConditionManagerStorage {
        mapping(bytes32 => Condition) conditions; // conditionId => Condition
        uint256[10] __gap;
    }

    struct OracleAdapterStorage {
        mapping(bytes32 => bytes32) conditionToFeed; // conditionId => externalFeedId
        uint256[10] __gap;
    }

    struct AccessControlStorage {
        address owner;
        mapping(address => bool) marketMakers;
        mapping(address => bool) admins;
        uint256[10] __gap
    }

    struct DiamondStorage {
        CollateralVaultStorage vault;
        OrderbookStorage orderbook;
        PositionTradingStorage positionTrading;
        ConditionalTokensStorage conditionalTokens;
        ConditionManagerStorage conditionManager;
        OracleAdapterStorage oracleAdapter;
        AccessControlStorage accessControl;
        ERC1155Storage erc1155Storage;
        uint256[50] __gap;
    }

    function diamondStorage() internal pure returns (DiamondStorage storage ds) {
        bytes32 position = STORAGE_POSITION;
        assembly {
            ds.slot := position
        }
    }
}
