// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {IBaseOracleAdapter} from "../interfaces/IBaseOracleAdapter.sol";
import {IOracleBS} from "../interfaces/IOracleBS.sol";
import {Errors} from "../libraries/Errors.sol";

/**
 * @title BlockScholesOracleAdapter
 * @author Doefin
 * @notice Oracle adapter implementing IBaseOracleAdapter for Block Scholes push-based oracle integration
 * @dev Converts Doefin asset IDs to Block Scholes Feed structures and handles precision normalization
 * @dev Supports configurable asset feeds with automatic price conversion between decimal precisions
 * @dev Implements two-step ownership transfer pattern for secure administration
 *
 * @dev ASSET ID CONVERSION FLOW:
 * @dev - Input: bytes32 assetId (e.g., keccak256("BTC-USD"))
 * @dev - Converts to: Block Scholes Feed structure with specific feedId, exchange, baseAsset parameters
 * @dev - Output: Price in adapter-configured decimals (8 for BTC, 6 for stablecoins)
 *
 * @dev DECIMAL PRECISION HANDLING:
 * @dev - Block Scholes source: 9 decimal places precision
 * @dev - Adapter output: Configurable per asset (8 decimals for BTC-USD, 6 decimals for stablecoin pairs)
 * @dev - System integration: Doefin normalizes to 1e18 for internal calculations in multi-step conversions
 *
 * @custom:standard Implements IBaseOracleAdapter interface for standardized oracle integration
 * @custom:precision Configurable decimal conversion for different asset types
 * @custom:security Two-step ownership transfer prevents accidental administrative access transfer
 * @custom:integration Designed for Block Scholes oracle infrastructure with Feed parameter mapping
 */
contract BlockScholesOracleAdapter is IBaseOracleAdapter {
    // ============================================================
    // Types & Constants
    // ============================================================

    /**
     * @dev Feed configuration structure mapping Doefin assetId to Block Scholes Feed parameters
     * @param feedId Block Scholes Feed ID (typically 3 for spot price feeds)
     * @param exchange Exchange enumeration value (0 = BLOCKSCHOLES composite exchange)
     * @param baseAsset Base asset enumeration value (1 = BTC, 2 = ETH, etc.)
     * @param decimals Output decimal precision (8 for crypto pairs, 6 for stablecoin pairs)
     * @custom:mapping Maps Doefin asset identifiers to Block Scholes feed parameters
     * @custom:configuration Essential for converting between Doefin and Block Scholes data formats
     */
    struct BlockScholesFeedConfig {
        uint8 feedId; // Block Scholes Feed ID (typically 3 for spot prices)
        uint8 exchange; // Exchange enum (0 = BLOCKSCHOLES composite)
        uint8 baseAsset; // Base asset enum (1 = BTC, 2 = ETH)
        uint8 decimals; // Output decimals (8 for crypto, 6 for stablecoins)
    }

    // Block Scholes Feed constants
    uint8 public constant FEED_ID_SPOT_PRICE = 3;
    uint8 public constant EXCHANGE_BLOCKSCHOLES = 0;
    uint8 public constant BASE_ASSET_BTC = 1;
    uint8 public constant BASE_ASSET_ETH = 2;

    // Decimal constants
    uint8 public constant BLOCKSCHOLES_DECIMALS = 9; // Block Scholes precision
    uint8 public constant BTC_DECIMALS = 8; // BTC price decimals
    uint8 public constant STABLECOIN_DECIMALS = 6; // Stablecoin price decimals

    // ============================================================
    // Storage
    // ============================================================

    /**
     * @dev Mapping from Doefin assetId to Block Scholes Feed configuration parameters
     * @notice Maps asset identifiers to their corresponding Block Scholes feed settings
     * @custom:mapping Core storage for asset-to-feed configuration relationships
     * @custom:configuration Updated via configureAssetFeed by contract owner
     */
    mapping(bytes32 => BlockScholesFeedConfig) public feedConfigs;

    /**
     * @dev Array of all supported asset IDs for enumeration and discovery
     * @notice Provides list of all assets that have been configured for this adapter
     * @custom:enumeration Enables getSupportedAssets() function implementation
     * @custom:discovery Allows external systems to discover available assets
     */
    bytes32[] public supportedAssets;

    /**
     * @dev Optimization mapping to track asset existence in supportedAssets array
     * @notice Provides O(1) lookup to check if asset is already in supportedAssets array
     * @dev IMPORTANT: If asset removal functionality is added in future, must also set supportedAssetExists[assetId] = false
     * @custom:optimization Converts O(n) duplicate checking to O(1) when configuring asset feeds
     * @custom:gas Significantly reduces gas costs for asset configuration operations
     */
    mapping(bytes32 => bool) private supportedAssetExists;

    /**
     * @dev Address of the Block Scholes oracle contract for price data queries
     * @notice Main oracle contract implementing IOracleBS interface
     * @custom:oracle Block Scholes oracle contract address for price queries
     * @custom:configuration Set during deployment and updatable by owner
     */
    address public blockScholesOracle;

    /**
     * @dev Current owner address with administrative privileges
     * @notice Address authorized to perform administrative functions
     * @custom:access Current owner with full administrative control
     * @custom:security Part of two-step ownership transfer mechanism
     */
    address public owner;

    /**
     * @dev Pending owner address for two-step ownership transfer security
     * @notice Address proposed as new owner, must accept to complete transfer
     * @custom:access Pending owner designation for secure ownership transfer
     * @custom:security Prevents accidental ownership transfer to incorrect address
     */
    address public pendingOwner;

    // ============================================================
    // Events
    // ============================================================

    /**
     * @dev Emitted when an asset feed configuration is created or updated
     * @param assetId The Doefin asset identifier that was configured
     * @param feedId Block Scholes feed ID assigned to the asset
     * @param exchange Exchange parameter for Block Scholes feed
     * @param baseAsset Base asset parameter for Block Scholes feed
     * @param decimals Output decimal precision for price conversion
     * @custom:configuration Tracks feed configuration changes for monitoring
     * @custom:audit Provides audit trail for asset configuration modifications
     */
    event FeedConfigured(bytes32 indexed assetId, uint8 feedId, uint8 exchange, uint8 baseAsset, uint8 decimals);

    /**
     * @dev Emitted when Block Scholes oracle contract address is updated
     * @param oracleAddress New Block Scholes oracle contract address
     * @custom:configuration Tracks oracle address changes for monitoring
     * @custom:audit Provides audit trail for critical infrastructure updates
     */
    event BlockScholesOracleSet(address indexed oracleAddress);

    /**
     * @dev Emitted when ownership transfer is proposed (step 1 of 2-step transfer)
     * @param currentOwner Address of the current owner proposing transfer
     * @param proposedOwner Address of the proposed new owner
     * @custom:ownership Tracks ownership transfer proposals for security
     * @custom:security Part of secure two-step ownership transfer mechanism
     */
    event OwnershipProposed(address indexed currentOwner, address indexed proposedOwner);

    /**
     * @dev Emitted when ownership transfer is completed (step 2 of 2-step transfer)
     * @param previousOwner Address of the previous owner
     * @param newOwner Address of the new owner
     * @custom:ownership Confirms completed ownership transfer
     * @custom:audit Provides permanent record of ownership changes
     */
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ============================================================
    // Modifiers
    // ============================================================

    modifier onlyOwner() {
        if (msg.sender != owner) {
            revert Errors.NotOwner();
        }
        _;
    }

    // ============================================================
    // Constructor & Setup
    // ============================================================

    /**
     * @notice Initializes the Block Scholes oracle adapter with oracle contract address
     * @dev Sets up initial configuration and establishes ownership for administrative functions
     * @dev Validates oracle address and emits events for transparency
     * @param _blockScholesOracle Address of the Block Scholes oracle contract implementing IOracleBS
     * @custom:validation Ensures oracle address is not zero to prevent invalid configuration
     * @custom:ownership Sets deployer as initial owner for administrative control
     * @custom:events Emits configuration and ownership events for transparency
     * @custom:revert Errors.InvalidAddress if oracle address is zero
     */
    constructor(address _blockScholesOracle) {
        if (_blockScholesOracle == address(0)) {
            revert Errors.InvalidAddress();
        }
        blockScholesOracle = _blockScholesOracle;
        owner = msg.sender;

        emit BlockScholesOracleSet(_blockScholesOracle);
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ============================================================
    // IBaseOracleAdapter Implementation
    // ============================================================

    /**
     * @notice Retrieves the latest price for a specific asset from Block Scholes oracle
     * @dev Implements comprehensive price fetching with validation and decimal conversion
     * @dev Converts Doefin asset ID to Block Scholes Feed structure and queries oracle
     * @dev Automatically converts from Block Scholes 9-decimal precision to configured output decimals
     * @param assetId The Doefin asset identifier (e.g., keccak256("BTC-USD"))
     * @return price Latest price in the adapter's configured output decimals for this asset
     * @return timestamp Unix timestamp when this price was last updated by Block Scholes
     * @return isValid Whether the price data is valid and usable (price > 0)
     * 
     * @dev EXECUTION FLOW:
     * @dev 1. Look up Feed configuration for the assetId in feedConfigs mapping
     * @dev 2. Build Block Scholes Feed structure using config parameters (feedId, exchange, baseAsset)
     * @dev 3. Query Block Scholes oracle using IOracleBS.getLatestFeedData() with constructed feed
     * @dev 4. Validate returned price is positive (> 0) for data integrity
     * @dev 5. Convert price from Block Scholes 9 decimals to asset-specific output decimals using _convertPrice()
     * @dev 6. Return converted price, original timestamp, and validity flag
     * 
     * @custom:standard Implements IBaseOracleAdapter interface for standardized oracle integration
     * @custom:conversion Automatic decimal conversion from Block Scholes 9 decimals to asset-specific precision
     * @custom:validation Comprehensive price validation ensuring positive values
     * @custom:revert Errors.AssetNotConfigured if asset has no feed configuration
     */
    function getLatestPrice(bytes32 assetId) external view override returns (uint256 price, uint256 timestamp, bool isValid) {
        // Look up Feed configuration
        BlockScholesFeedConfig memory config = feedConfigs[assetId];
        if (config.feedId == 0) {
            revert Errors.AssetNotConfigured(assetId);
        }

        // Build Block Scholes Feed structure
        IOracleBS.Feed memory feed = IOracleBS.Feed({
            id: config.feedId,
            parameters: IOracleBS.FeedParameters({enumerable: new uint8[](2), other: ""})
        });

        // Set enumerable parameters [Exchange, BaseAsset]
        feed.parameters.enumerable[0] = config.exchange;
        feed.parameters.enumerable[1] = config.baseAsset;

        // Query Block Scholes oracle
        IOracleBS.FeedData memory feedData = IOracleBS(blockScholesOracle).getLatestFeedData(feed);

        // Validate price - must be positive
        if (feedData.value <= 0) {
            return (0, feedData.timestamp, false);
        }

        // Convert from Block Scholes 9 decimals to output decimals
        // Safe cast: we've already verified feedData.value is positive
        price = _convertPrice(uint256(int256(feedData.value)), BLOCKSCHOLES_DECIMALS, config.decimals);
        timestamp = feedData.timestamp;
        isValid = true;
    }

    /**
     * @notice Retrieves array of all asset IDs that this adapter supports
     * @dev Returns complete list of configured assets for discovery and enumeration
     * @dev Assets are added to this array when configured via configureAssetFeed()
     * @return Array of all supported asset identifiers that have been configured
     * @custom:discovery Enables external systems to discover all available assets
     * @custom:enumeration Provides complete list of configured assets for iteration
     * @custom:view Read-only access to supported assets array
     */
    function getSupportedAssets() external view override returns (bytes32[] memory) {
        return supportedAssets;
    }

    /**
     * @notice Provides metadata information about this oracle adapter implementation
     * @dev Returns human-readable name and version for adapter identification
     * @dev Essential for adapter discovery, compatibility checking, and monitoring systems
     * @return name Human-readable name of the adapter ("BlockScholesV1")
     * @return version Semantic version string of the adapter implementation ("1.0.0")
     * @custom:metadata Static adapter identification information
     * @custom:versioning Enables version compatibility checking
     * @custom:monitoring Provides adapter identification for logging and monitoring
     */
    function getAdapterMetadata() external pure override returns (string memory name, string memory version) {
        return ("BlockScholesV1", "1.0.0");
    }

    // ============================================================
    // Admin Functions
    // ============================================================

    /**
     * @notice Configures feed mapping for an asset to enable price queries
     * @dev Maps Doefin asset ID to Block Scholes feed parameters for price retrieval
     * @dev Adds asset to supported assets array if not already present using O(1) duplicate checking
     * @dev Only contract owner can configure asset feeds for security
     * @param assetId The Doefin asset ID (e.g., keccak256("BTC-USD"))
     * @param feedId Block Scholes Feed ID (e.g., 3 for spot prices)
     * @param exchange Exchange parameter (0 for BLOCKSCHOLES composite exchange)
     * @param baseAsset Base asset enumeration (1 for BTC, 2 for ETH)
     * @param decimals Output decimal precision (1-18; typically 8 for BTC, 6 for stablecoins)
     * 
     * @dev CONFIGURATION EXAMPLE:
     * @dev configureAssetFeed(keccak256("BTC-USD"), 3, 0, 1, 8)
     * @dev - Maps BTC-USD to Block Scholes spot price feed (ID 3)
     * @dev - Uses BLOCKSCHOLES composite exchange (0)
     * @dev - Specifies BTC as base asset (1)
     * @dev - Outputs prices with 8 decimal precision
     * 
     * @custom:access Only contract owner can configure asset feeds
     * @custom:validation Validates feedId is not zero and decimals are within valid range
     * @custom:optimization Uses O(1) duplicate checking to avoid array scanning
     * @custom:emits FeedConfigured event with configuration details
     * @custom:revert Errors.InvalidFeedId if feedId is zero
     * @custom:revert Errors.InvalidDecimals if decimals are zero or greater than 18
     */
    function configureAssetFeed(bytes32 assetId, uint8 feedId, uint8 exchange, uint8 baseAsset, uint8 decimals) external onlyOwner {
        if (feedId == 0) {
            revert Errors.InvalidFeedId();
        }
        // Validate decimals: must be between 1 and 18 (inclusive)
        if (decimals == 0 || decimals > 18) {
            revert Errors.InvalidDecimals();
        }

        // Store configuration
        feedConfigs[assetId] = BlockScholesFeedConfig({feedId: feedId, exchange: exchange, baseAsset: baseAsset, decimals: decimals});

        // Add to supported assets if not already present (O(1) check)
        if (!supportedAssetExists[assetId]) {
            supportedAssets.push(assetId);
            supportedAssetExists[assetId] = true;
        }

        emit FeedConfigured(assetId, feedId, exchange, baseAsset, decimals);
    }

    /**
     * @notice Updates the Block Scholes oracle contract address for price queries
     * @dev Changes the underlying oracle contract that provides price data
     * @dev Only contract owner can update oracle address for security
     * @param newOracleAddress New Block Scholes oracle contract address implementing IOracleBS
     * @custom:access Only contract owner can update oracle address
     * @custom:validation Ensures new oracle address is not zero
     * @custom:critical Updates core infrastructure dependency
     * @custom:emits BlockScholesOracleSet event with new oracle address
     * @custom:revert Errors.InvalidAddress if new oracle address is zero
     */
    function setBlockScholesOracle(address newOracleAddress) external onlyOwner {
        if (newOracleAddress == address(0)) {
            revert Errors.InvalidAddress();
        }
        blockScholesOracle = newOracleAddress;
        emit BlockScholesOracleSet(newOracleAddress);
    }

    /**
     * @notice Proposes a new owner for two-step ownership transfer (step 1 of 2)
     * @dev Initiates secure ownership transfer process requiring acceptance by proposed owner
     * @dev Only current owner can propose new ownership for security
     * @dev Two-step process prevents accidental transfer to incorrect or inaccessible address
     * @param newOwner Address of the proposed new owner (cannot be zero address)
     * @custom:access Only current owner can propose ownership transfer
     * @custom:security Two-step transfer prevents accidental ownership loss
     * @custom:validation Ensures proposed owner address is not zero
     * @custom:emits OwnershipProposed event with current and proposed owner
     * @custom:revert Errors.InvalidAddress if new owner is zero address
     */
    function proposeOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) {
            revert Errors.InvalidAddress();
        }
        pendingOwner = newOwner;
        emit OwnershipProposed(owner, newOwner);
    }

    /**
     * @notice Accepts ownership transfer completing two-step ownership process (step 2 of 2)
     * @dev Must be called by the pending owner to finalize ownership transfer
     * @dev Completes secure ownership transfer and resets pending owner to zero
     * @dev Only the pending owner can accept ownership for security
     * @custom:access Only pending owner can accept ownership transfer
     * @custom:security Completes two-step ownership transfer securely
     * @custom:finalization Transfers ownership and clears pending owner state
     * @custom:emits OwnershipTransferred event with previous and new owner
     * @custom:revert Errors.NotPendingOwner if caller is not the pending owner
     */
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) {
            revert Errors.NotPendingOwner();
        }
        address previousOwner = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(previousOwner, owner);
    }

    // ============================================================
    // Internal Functions
    // ============================================================

    /**
     * @notice Converts price between different decimal precision levels
     * @dev Handles both scaling up and scaling down with proper decimal arithmetic
     * @dev Essential for converting Block Scholes 9-decimal prices to asset-specific precision
     * @param price The price value to convert between decimal precisions
     * @param fromDecimals Current decimal precision of the input price
     * @param toDecimals Target decimal precision for the output price
     * @return Converted price with target decimal precision
     * 
     * @dev CONVERSION EXAMPLES:
     * @dev - Convert 45000.5 BTC from 9 decimals to 8 decimals:
     * @dev   Input: price = 45000500000000 (45000.5 * 10^9)
     * @dev   Output: 4500050000000 (45000.5 * 10^8)
     * @dev - Convert 1.0 USDT from 9 decimals to 6 decimals:
     * @dev   Input: price = 1000000000 (1.0 * 10^9)
     * @dev   Output: 1000000 (1.0 * 10^6)
     * 
     * @custom:precision Handles arbitrary decimal precision conversion
     * @custom:optimization Returns immediately if no conversion needed
     * @custom:arithmetic Safe decimal scaling using powers of 10
     * @custom:internal Internal utility function for price normalization
     */
    function _convertPrice(uint256 price, uint8 fromDecimals, uint8 toDecimals) internal pure returns (uint256) {
        if (fromDecimals == toDecimals) {
            return price;
        }

        if (fromDecimals > toDecimals) {
            // Scale down: divide by 10^(fromDecimals - toDecimals)
            return price / (10 ** (fromDecimals - toDecimals));
        } else {
            // Scale up: multiply by 10^(toDecimals - fromDecimals)
            return price * (10 ** (toDecimals - fromDecimals));
        }
    }
}
