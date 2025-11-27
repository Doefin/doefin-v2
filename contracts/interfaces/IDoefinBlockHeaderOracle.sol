// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";

/**
 * @title IDoefinBlockHeaderOracle
 * @dev Interface for the block header oracle
 */
interface IDoefinBlockHeaderOracle {

    // Initialization
    /**
     * @notice Initialize the block header oracle with initial block history
     * @dev Should be called during diamond initialization
     * @param initialBlockHistory Array of initial block headers (must have exactly 17 elements)
     * @param initialBlockHeight The height of the first block in the history
     */
    function initializeBlockHeaderOracle(
        LibDoefinStorage.BlockHeader[] calldata initialBlockHistory,
        uint256 initialBlockHeight
    ) external;

    // Interface methods
    /**
     * @notice Allows anyone to submit a confirmed block header
     * @dev Add block header to ring buffer, and the block timestamp to the sorted list
     * @param newBlockHeader The newest block header to the added to the head of the ring buffer
     */
    function submitNextBlock(LibDoefinStorage.BlockHeader calldata newBlockHeader) external;

    /**
     * @notice Allows anyone to submit a block header to update the canonical chain
     * @param newBlockHeaders The list of new block headers to be added to the canonical chain
     */
    function submitBatchBlocks(LibDoefinStorage.BlockHeader[] calldata newBlockHeaders) external;

    /**
     * @notice Get the median timestamp from the sorted timestamp list
     * @return the median block timestamp
     */
    function medianBlockTime() external view returns (uint256);

    /**
     * @notice Get the latest block header
     * @return the latest block header
     */
    function getLatestBlockHeader() external view returns (LibDoefinStorage.BlockHeader memory);

    // Getter methods
    /**
     * @notice Get the current block height (latest block number)
     * @return The current block height
     */
    function getCurrentBlockHeight() external view returns (uint256);

    /**
     * @notice Get the next index in the ring buffer
     * @return The next block index
     */
    function getNextBlockIndex() external view returns (uint256);

    /**
     * @notice Get a block header at a specific index in the ring buffer
     * @param index The index in the ring buffer
     * @return The block header at that index
     */
    function getBlockHeaderAt(uint256 index) external view returns (LibDoefinStorage.BlockHeader memory);

    /**
     * @notice Get a block header by block number
     * @param blockNumber The Bitcoin block number
     * @return The block header if found
     */
    function getBlockHeaderByNumber(uint256 blockNumber) external view returns (LibDoefinStorage.BlockHeader memory);

    /**
     * @notice Get all block headers in the ring buffer
     * @return Array of all block headers currently stored
     */
    function getAllBlockHeaders() external view returns (LibDoefinStorage.BlockHeader[] memory);

    /**
     * @notice Get the buffer size (number of blocks stored)
     * @return The maximum number of blocks in the buffer
     */
    function getBufferSize() external view returns (uint256);

    /**
     * @notice Get the median timestamps buffer size
     * @return The number of blocks used for median calculation
     */
    function getMedianBufferSize() external view returns (uint256);
}