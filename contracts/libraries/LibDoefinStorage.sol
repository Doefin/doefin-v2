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
        address feeReceiver;
        uint16 resolutionFeeBps;
        // SCRUM-224: admin-settable ceiling on the operator-supplied settlement fee.
        // The operator supplies the fee amount per settlement leg; SettlementFacet
        // enforces `fee <= (cashValue * maxFeeRateBps) / 10000`. Fail-closed: a value
        // of 0 means no non-zero fee is permitted (NOT "unlimited").
        uint16 maxFeeRateBps;
        uint256[12] __gap;
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

    struct AppStorage {
        ConditionalTokensStorage conditionalTokens;
        AccessControlStorage accessControl;
        ERC1155Storage erc1155Storage;
        AdminConfigStorage adminConfigStorage;
        PositionRegistryStorage positionRegistry;
        ReentrancyStorage reentrancyStorage;
        BlockHeaderOracleStorage blockHeaderOracleStorage;
        OracleAdapterStorage oracleAdapterStorage;
        uint256[51] __gap;
    }

    function appStorage() internal pure returns (AppStorage storage ds) {
        bytes32 position = STORAGE_POSITION;
        assembly {
            ds.slot := position
        }
    }

    /// @notice Initialize critical storage values (call once during deployment)
    function initialize(address feeReceiver, uint16 resolutionFeeBps) internal {
        if (isInitialized()) revert Errors.AlreadyInitialized();

        AppStorage storage ds = appStorage();

        ds.reentrancyStorage._status = 1;

        // Set admin config during initialization
        ds.adminConfigStorage.feeReceiver = feeReceiver;
        ds.adminConfigStorage.resolutionFeeBps = resolutionFeeBps;

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
