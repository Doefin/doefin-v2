// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

/**
 * @title IOracleBS
 * @notice Interface for Block Scholes blockchain oracle
 * @dev Provides access to Block Scholes' push-based oracle data feeds
 */
interface IOracleBS {
    /**
     * @notice Feed structure for Block Scholes oracle
     * @dev ID determines the type of feed (e.g., 3 for crypto spot prices)
     */
    struct Feed {
        uint8 id;
        FeedParameters parameters;
    }

    /**
     * @notice Parameters for a specific feed
     * @dev Structure depends on feed ID
     */
    struct FeedParameters {
        uint8[] enumerable;  // Variable-length parameters (e.g., [Exchange, BaseAsset])
        bytes other;         // Additional parameters (unused for spot prices)
    }

    /**
     * @notice Data returned from a feed query
     * @dev Price is typically in 9 decimal precision
     */
    struct FeedData {
        int64 value;        // Price value
        uint256 timestamp;  // When this price was last updated
    }

    /**
     * @notice Get the latest data for a specific feed
     * @param feed The feed configuration
     * @return feedData The latest price data
     */
    function getLatestFeedData(Feed memory feed) external view returns (FeedData memory feedData);
}
