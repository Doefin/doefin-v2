// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {IOracleBS} from "../interfaces/IOracleBS.sol";

/**
 * @title MockBlockScholesOracle
 * @notice Mock Block Scholes oracle for testing BlockScholesOracleAdapter
 * @dev Allows setting prices and simulating various oracle scenarios for testing
 */
contract MockBlockScholesOracle is IOracleBS {
    // Storage for prices (simple approach - stores single price across all feeds)
    int64 public mockPrice;
    uint256 public mockTimestamp;

    address public owner;

    event PriceSet(int64 price, uint256 timestamp);

    modifier onlyOwner() {
        require(msg.sender == owner, "MockBlockScholesOracle: not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
        mockPrice = 45000500000000; // Default: 45000.5 BTC at 9 decimals
        mockTimestamp = block.timestamp;
    }

    /**
     * @notice Get latest feed data
     * @param feed The feed configuration (ignored in mock)
     * @return feedData The mock price and timestamp
     */
    function getLatestFeedData(Feed memory feed)
        external
        view
        override
        returns (FeedData memory feedData)
    {
        feedData.value = mockPrice;
        feedData.timestamp = mockTimestamp;
    }

    /**
     * @notice Set mock price for testing
     * @param price The price to return (at 9 decimal precision)
     * @param timestamp The timestamp to return
     */
    function setPrice(int64 price, uint256 timestamp) external onlyOwner {
        mockPrice = price;
        mockTimestamp = timestamp;
        emit PriceSet(price, timestamp);
    }

    /**
     * @notice Set mock price with current block timestamp
     * @param price The price to return (at 9 decimal precision)
     */
    function setCurrentPrice(int64 price) external onlyOwner {
        mockPrice = price;
        mockTimestamp = block.timestamp;
        emit PriceSet(price, block.timestamp);
    }
}
