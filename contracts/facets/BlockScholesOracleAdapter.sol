// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {IBaseOracleAdapter} from "../interfaces/IBaseOracleAdapter.sol";
import {IOracleBS} from "../interfaces/IOracleBS.sol";
import "../libraries/Errors.sol";

/**
 * @title BlockScholesOracleAdapter
 * @notice Oracle adapter for Block Scholes push-based oracle
 * @dev Converts Doefin asset IDs to Block Scholes Feed structures and handles price normalization
 *
 * ASSET ID CONVERSION:
 * - Receives: bytes32 assetId (e.g., keccak256("BTC-USD"))
 * - Converts to: Block Scholes Feed structure with specific parameters
 * - Returns: Price in adapter-specific decimals (8 for BTC, 6 for stablecoins)
 *
 * DECIMAL CONVERSION:
 * - Block Scholes returns: 9 decimal precision
 * - Converts to: 8 decimals for BTC-USD, 6 decimals for stablecoin pairs
 * - System normalizes to: 1e18 for multi-step conversions
 */
contract BlockScholesOracleAdapter is IBaseOracleAdapter {
    // ============================================================
    // Types & Constants
    // ============================================================

    /// @dev Feed configuration for mapping assetId to Block Scholes Feed parameters
    struct BlockScholesFeedConfig {
        uint8 feedId;      // Block Scholes Feed ID (typically 3 for spot prices)
        uint8 exchange;    // Exchange enum (0 = BLOCKSCHOLES composite)
        uint8 baseAsset;   // Base asset enum (1 = BTC, 2 = ETH)
        uint8 decimals;    // Output decimals (8 for crypto, 6 for stablecoins)
    }

    // Block Scholes Feed constants
    uint8 public constant FEED_ID_SPOT_PRICE = 3;
    uint8 public constant EXCHANGE_BLOCKSCHOLES = 0;
    uint8 public constant BASE_ASSET_BTC = 1;
    uint8 public constant BASE_ASSET_ETH = 2;

    // Decimal constants
    uint8 public constant BLOCKSCHOLES_DECIMALS = 9;     // Block Scholes precision
    uint8 public constant BTC_DECIMALS = 8;              // BTC price decimals
    uint8 public constant STABLECOIN_DECIMALS = 6;       // Stablecoin price decimals

    // ============================================================
    // Storage
    // ============================================================

    /// @dev Mapping from Doefin assetId to Block Scholes Feed configuration
    mapping(bytes32 => BlockScholesFeedConfig) public feedConfigs;

    /// @dev Supported asset IDs (for getSupportedAssets())
    bytes32[] public supportedAssets;

    /// @dev Block Scholes oracle contract address
    address public blockScholesOracle;

    /// @dev Owner for admin functions
    address public owner;

    // ============================================================
    // Events
    // ============================================================

    event FeedConfigured(
        bytes32 indexed assetId,
        uint8 feedId,
        uint8 exchange,
        uint8 baseAsset,
        uint8 decimals
    );

    event BlockScholesOracleSet(address indexed oracleAddress);
    event OwnershipTransferred(address indexed newOwner);

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
     * @notice Initialize the Block Scholes oracle adapter
     * @param _blockScholesOracle Address of Block Scholes oracle contract
     */
    constructor(address _blockScholesOracle) {
        if (_blockScholesOracle == address(0)) {
            revert Errors.InvalidAddress();
        }
        blockScholesOracle = _blockScholesOracle;
        owner = msg.sender;

        emit BlockScholesOracleSet(_blockScholesOracle);
    }

    // ============================================================
    // IBaseOracleAdapter Implementation
    // ============================================================

    /**
     * @notice Get the latest price for a specific asset
     * @param assetId The asset identifier (e.g., keccak256("BTC-USD"))
     * @return price The latest price in the adapter's output decimals
     * @return timestamp The timestamp when this price was last updated
     * @return isValid Whether the price data is valid
     *
     * @dev Flow:
     * 1. Look up Feed configuration for the assetId
     * 2. Build Block Scholes Feed structure from config
     * 3. Query Block Scholes oracle for latest price
     * 4. Convert from 9 decimals to output decimals
     * 5. Return price, timestamp, and validity flag
     */
    function getLatestPrice(bytes32 assetId)
        external
        view
        override
        returns (uint256 price, uint256 timestamp, bool isValid)
    {
        // Look up Feed configuration
        BlockScholesFeedConfig memory config = feedConfigs[assetId];
        if (config.feedId == 0) {
            revert("AssetNotConfigured");
        }

        // Build Block Scholes Feed structure
        IOracleBS.Feed memory feed = IOracleBS.Feed({
            id: config.feedId,
            parameters: IOracleBS.FeedParameters({
                enumerable: new uint8[](2),
                other: ""
            })
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
     * @notice Get all asset IDs that this adapter supports
     * @return Array of supported asset identifiers
     */
    function getSupportedAssets() external view override returns (bytes32[] memory) {
        return supportedAssets;
    }

    /**
     * @notice Get metadata about this oracle adapter
     * @return name Human-readable name of the adapter
     * @return version Version string of the adapter
     */
    function getAdapterMetadata()
        external
        pure
        override
        returns (string memory name, string memory version)
    {
        return ("BlockScholesV1", "1.0.0");
    }

    // ============================================================
    // Admin Functions
    // ============================================================

    /**
     * @notice Configure a feed mapping for an asset
     * @param assetId The Doefin asset ID (e.g., keccak256("BTC-USD"))
     * @param feedId Block Scholes Feed ID (e.g., 3 for spot prices)
     * @param exchange Exchange parameter (0 for BLOCKSCHOLES composite)
     * @param baseAsset Base asset enum (1 for BTC, 2 for ETH)
     * @param decimals Expected output decimals (8 for BTC, 6 for stablecoins)
     *
     * @dev This is called during adapter setup to map your asset IDs to Block Scholes feeds.
     * Example: configureAssetFeed(keccak256("BTC-USD"), 3, 0, 1, 8)
     */
    function configureAssetFeed(
        bytes32 assetId,
        uint8 feedId,
        uint8 exchange,
        uint8 baseAsset,
        uint8 decimals
    ) external onlyOwner {
        if (feedId == 0) {
            revert("InvalidFeedId");
        }
        if (decimals == 0 || decimals > 18) {
            revert("InvalidDecimals");
        }

        // Store configuration
        feedConfigs[assetId] = BlockScholesFeedConfig({
            feedId: feedId,
            exchange: exchange,
            baseAsset: baseAsset,
            decimals: decimals
        });

        // Add to supported assets if not already present
        bool found = false;
        for (uint256 i = 0; i < supportedAssets.length; i++) {
            if (supportedAssets[i] == assetId) {
                found = true;
                break;
            }
        }
        if (!found) {
            supportedAssets.push(assetId);
        }

        emit FeedConfigured(assetId, feedId, exchange, baseAsset, decimals);
    }

    /**
     * @notice Update the Block Scholes oracle contract address
     * @param newOracleAddress New Block Scholes oracle address
     */
    function setBlockScholesOracle(address newOracleAddress) external onlyOwner {
        if (newOracleAddress == address(0)) {
            revert Errors.InvalidAddress();
        }
        blockScholesOracle = newOracleAddress;
        emit BlockScholesOracleSet(newOracleAddress);
    }

    /**
     * @notice Transfer ownership to a new owner
     * @param newOwner Address of the new owner
     */
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) {
            revert Errors.InvalidAddress();
        }
        owner = newOwner;
        emit OwnershipTransferred(newOwner);
    }

    // ============================================================
    // Internal Functions
    // ============================================================

    /**
     * @notice Convert price from one decimal precision to another
     * @param price The price value to convert
     * @param fromDecimals Current decimal precision
     * @param toDecimals Target decimal precision
     * @return Converted price
     *
     * @dev Examples:
     * - Convert 45000.5 BTC from 9 decimals to 8:
     *   price = 45000500000000 (9 decimals)
     *   result = 4500050000000 (8 decimals)
     *
     * - Convert 1.0 USDT from 9 decimals to 6:
     *   price = 1000000000 (9 decimals)
     *   result = 1000000 (6 decimals)
     */
    function _convertPrice(
        uint256 price,
        uint8 fromDecimals,
        uint8 toDecimals
    ) internal pure returns (uint256) {
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
