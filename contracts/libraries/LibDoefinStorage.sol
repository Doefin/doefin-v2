// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {Errors} from "./Errors.sol";

library LibDoefinStorage {
    bytes32 constant STORAGE_POSITION = keccak256("doefin.storage");

    // Add initialization flag
    bytes32 constant INITIALIZED_POSITION = keccak256("doefin.storage.initialized");

    // Block Header Oracle constants
    uint256 constant SETTLEMENT_DELAY = 6;
    uint256 constant NUM_OF_TIMESTAMPS = 11;
    uint256 constant NUM_OF_BLOCK_HEADERS = 17;

    // Oracle Adapter constants
    uint256 constant TIMESTAMP_BUCKET = 600; // 10 minutes in seconds
    uint256 constant MAX_BUCKETS = 10; // Maximum number of range buckets per question
    uint256 constant MAX_BLOCK_COUNT = 2016; // Max blocks to measure (1 difficulty adjustment period)
    uint256 constant MAX_DURATION = 30 days; // Max duration in seconds

    /// @notice Enum for different question types
    enum QuestionType {
        DifficultyThreshold, // Binary: "Difficulty > X at block Y?"
        DifficultyRange, // Multi-choice: "Difficulty in which range at block Y?"
        BlockCount, // Multi-choice: "Blocks mined between timestamps X and Y?"
        MiningDuration // Multi-choice: "Time to mine X blocks from block Y?"
    }

    /// @notice Binary difficulty threshold question
    /// @dev "Bitcoin Difficulty Above X at block Y?"
    struct DifficultyThresholdQuestion {
        bytes32 questionId; // Deterministic hash of question params
        bytes32 conditionId; // CTF condition ID
        uint256 threshold; // Difficulty threshold value
        uint256 targetBlockHeight; // Block height to check
        // Outcomes: [0] = No (≤ threshold), [1] = Yes (> threshold)
    }

    /// @notice Multi-choice difficulty range question
    /// @dev "Bitcoin difficulty in which range at block Y?"
    struct DifficultyRangeQuestion {
        bytes32 questionId;
        bytes32 conditionId;
        uint256 targetBlockHeight; // Block height to check
        uint256[] buckets; // Range boundaries (sorted ascending)
        // Example: buckets=[85T, 90T, 95T] creates 4 outcomes:
        // [0] = <85T, [1] = 85-90T, [2] = 90-95T, [3] = ≥95T
    }

    /// @notice Block count question
    /// @dev "Number of blocks mined between timestamps X and Y?"
    struct BlockCountQuestion {
        bytes32 questionId;
        bytes32 conditionId;
        uint256 startTimestamp; // Start of time window
        uint256 endTimestamp; // End of time window
        uint256[] countBuckets; // Block count range boundaries
        // Example: countBuckets=[100, 150, 200] creates 4 outcomes:
        // [0] = <100 blocks, [1] = 100-150, [2] = 150-200, [3] = ≥200
    }

    /// @notice Mining duration question
    /// @dev "Time to mine X blocks from block Y?"
    struct MiningDurationQuestion {
        bytes32 questionId;
        bytes32 conditionId;
        uint256 startBlockHeight; // Starting block
        uint256 blockCount; // Number of blocks to mine
        uint256[] durationBuckets; // Duration boundaries in seconds
        // Example: durationBuckets=[3600, 7200, 10800] creates 4 outcomes:
        // [0] = <1hr, [1] = 1-2hr, [2] = 2-3hr, [3] = ≥3hr
    }

    /// @notice Storage for Oracle Adapter state
    struct OracleAdapterStorage {
        // Block-number based conditions (for O(1) lookup when block arrives)
        // Key: blockHeight (already includes SETTLEMENT_DELAY offset)
        mapping(uint256 => DifficultyThresholdQuestion[]) blockToThresholdQuestions;
        mapping(uint256 => DifficultyRangeQuestion[]) blockToRangeQuestions;
        mapping(uint256 => MiningDurationQuestion[]) blockToDurationQuestions;
        // Timestamp-based conditions (using bucketing for O(1) lookup)
        // Key: timestamp bucket (rounded to TIMESTAMP_BUCKET)
        mapping(uint256 => BlockCountQuestion[]) timestampToBlockCountQuestions;
        // Auxiliary mappings for timestamp <-> block height conversions
        // These could potentially be shared with BlockHeaderOracleStorage
        // but keeping separate for clarity and to avoid coupling
        mapping(uint256 => uint256) timestampToBlockHeight;
        mapping(uint256 => uint256) blockHeightToTimestamp;
        // Tracking for resolved questions (optional, for queries/stats)
        uint256 totalQuestionsCreated;
        uint256 totalQuestionsResolved;
    }

    struct ERC1155Storage {
        mapping(uint256 => mapping(address => uint256)) erc1155Balances;
        mapping(address => mapping(address => bool)) erc1155OperatorApprovals;
        uint256[20] __gap;
    }

    struct ConditionalTokensStorage {
        mapping(bytes32 => uint256[]) payoutNumerators; // conditionId => numerators
        mapping(bytes32 => uint256) payoutDenominator; // conditionId => denominator
        mapping(bytes32 => Condition) conditions; // conditionId => Condition
        uint256[50] __gap;
    }

    struct Condition {
        bytes32 questionId;
        string metadataURI;
        address oracle;
        uint8 outcomeSlotCount;
        bool active;
        address creator;
    }

    struct AccessControlStorage {
        mapping(address => bool) marketMakers;
        uint256[10] __gap;
    }

    struct AdminConfigStorage {
        mapping(address => bool) isAllowed;
        mapping(address => uint256) unitPerPair; // token => unit amount (e.g., 1e6 USDC)
        mapping(address => string) tokenSymbols; // token => symbol (e.g., "BTC", "USDC", "USDT")
        mapping(bytes32 => bytes32[]) conversionPaths; // keccak256(abi.encodePacked(fromToken, toToken)) => oracle asset IDs
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

    enum OrderType {
        Standard, // Regular buy/sell in collateral token
        CrossCurrency // Orders that use quote currency for pricing/settlement
    }

    struct OrderFeeConfig {
        uint16 makerFeeBps;
        uint16 takerFeeBps;
    }

    enum ExchangeRateType {
        Fixed, // Fixed exchange rate (allowed for both buy and sell orders)
        Dynamic // Dynamic rate (only allowed for sell orders)
    }

    struct CrossCurrencyConfig {
        /// @notice Quote currency token address (e.g., ETH, BTC, WETH)
        address quoteCurrencyToken;
        /// @notice Exchange rate type (fixed or dynamic)
        ExchangeRateType exchangeRateType;
        /// @notice Exchange rate (quote currency per collateral token)
        /// @dev For Fixed: the fixed exchange rate to use
        /// @dev For Dynamic: the target/reference exchange rate for dynamic pricing
        uint256 exchangeRate;
    }

    struct SettlementExecutionContext {
        uint256 fillableAmount;
        Order takerOrder;
        Order makerOrder;
        MatchType matchType;
        ExecutionType executionType;
    }

    struct ModifyCollateralContext {
        uint256 positionId;
        uint256 oldAmount;
        uint256 newAmount;
        uint256 oldPrice;
        uint256 newPrice;
        address maker;
        uint16 makerFeeBps;
        address collateralToken;
        OrderDirection direction;
    }

    struct SimulationContext {
        uint256[] complementaryOrders;
        uint256[] mintOrMergeOrders;
        LibDoefinStorage.MatchType siblingMatchType;
        LibDoefinStorage.OrderDirection direction;
        uint256 collateralUnit;
        uint256 sharesOrBudgetAmount;
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

    enum MatchType {
        Complementary,
        Mint, // Via split (matching against sibling Buy)
        Merge // Via merge (matching against sibling Sell)
    }

    /// @notice Struct representing a single limit or market order
    /// @dev Each order maps to a specific ERC1155 position token and can be either a buy or a sell
    /// @dev Optimized packing: 15 slots (was 19), saves 128 bytes per order
    struct Order {
        /// @notice Unique order identifier (incremental)
        uint256 orderId;
        /// @notice Position Id of the token
        uint256 positionId;
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
        /// @notice Exchange rate (quote currency per collateral token)
        uint256 exchangeRate;
        /// @notice Creator of the order (20 bytes) + direction (1 byte) + executionType (1 byte) + orderType (1 byte) + exchangeRateType (1 byte) + active (1 byte) + fillOrKill (1 byte) = 26 bytes packed
        address maker;
        OrderDirection direction;
        ExecutionType executionType;
        OrderType orderType;
        ExchangeRateType exchangeRateType;
        bool active;
        bool fillOrKill;
        /// @notice Address of the requested ERC20 token (20 bytes) + makerFeeBps (2 bytes) + takerFeeBps (2 bytes) = 24 bytes packed
        address collateralToken;
        uint16 makerFeeBps;
        uint16 takerFeeBps;
        /// @notice Quote currency token address (only used for CrossCurrency orders)
        address quoteCurrencyToken;
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
        uint256[10] __gap;
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

    /**
     * @dev Struct to store essential details of a block header
     * @param version The block version number. Indicates which set of block validation rules to follow. Miners
     * increment this number and also use it in combination with the nonce when searching for a valid block hash.
     * @param prevBlockHash A 256-bit hash of the previous block’s header. Ensures that blocks are ordered
     * chronologically and establishes the link between blocks in the blockchain.
     * @param merkleRootHash A 256-bit hash derived from the transactions in the block. Provides a single hash that
     * summarizes all transactions in the block, enabling efficient and secure verification of the block’s contents.
     * @param timestamp The approximate creation time of the block, represented as Unix time (seconds since
     * 1970-01-01T00:00 UTC). Provides a temporal ordering of blocks and helps in the difficulty adjustment process.
     * @param nBits Encoded current target threshold for the proof-of-work algorithm. Represents the difficulty target
     * that a block’s hash must meet. It is periodically adjusted to maintain the block creation rate.
     * @param nonce A 32-bit arbitrary number that miners adjust to find a hash below the target threshold. Used by
     * miners in the proof-of-work algorithm. Miners increment the nonce to generate different hashes and find a valid
     * one that meets the difficulty target.
     */
    struct BlockHeader {
        bytes32 prevBlockHash;
        bytes32 merkleRootHash;
        bytes32 blockHash;
        uint256 blockNumber;
        uint32 version;
        uint32 timestamp;
        uint32 nBits;
        uint32 nonce;
    }

    struct BlockHeaderOracleStorage {
        // @notice Store the block number separately since the block number is not part of the block header information.
        uint256 currentBlockHeight;
        /// @notice Track the index of the next block in the ring buffer
        uint256 nextBlockIndex;
        /// @notice Ring buffer to store the block headers
        BlockHeader[NUM_OF_BLOCK_HEADERS] blockHeaders;
        uint256[10] __gap;
    }

    struct ReentrancyStorage {
        uint256 _status;
        uint256[10] __gap;
    }

    struct AdapterConfig {
        uint256 maxStaleness;
        uint256 failureCount;
        address adapterAddress;
        bool enabled;
    }

    struct AssetConfig {
        bytes32[] adapterPriority; // Ordered array of adapter IDs
        uint256 maxStaleness;
        uint256 lastUpdateTimestamp;
        uint8 decimals; // Number of decimals for the oracle price (0-18, 0 defaults to 18)
        bool tradingPaused;
    }

    struct PriceData {
        uint256 price;
        uint256 timestamp;
        bytes32 lastSuccessfulAdapterId;
        bool isValid;
    }

    struct OracleStorage {
        mapping(bytes32 => AdapterConfig) adapters;
        mapping(bytes32 => AssetConfig) assetConfigs;
        mapping(bytes32 => PriceData) priceData;
        mapping(bytes32 => bool) usedNonces;
        address authorizedSigner;
        uint256 maxManualUpdateAge; // Maximum age in seconds for manual price updates (default: 300)
        uint256[9] __gap; // Reduced gap by 1 to accommodate new field
    }

    struct AppStorage {
        ConditionalTokensStorage conditionalTokens;
        AccessControlStorage accessControl;
        ERC1155Storage erc1155Storage;
        AdminConfigStorage adminConfigStorage;
        OrderbookStorageStruct orderbookStorage;
        EscrowStorage escrowStorage;
        PositionRegistryStorage positionRegistry;
        ReentrancyStorage reentrancyStorage;
        OracleStorage oracleStorage;
        BlockHeaderOracleStorage blockHeaderOracleStorage;
        OracleAdapterStorage oracleAdapterStorage;
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
        if (isInitialized()) revert Errors.AlreadyInitialized();

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
