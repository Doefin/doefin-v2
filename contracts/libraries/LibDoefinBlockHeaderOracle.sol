// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {Errors} from "./Errors.sol";
import {LibDoefinStorage} from "./LibDoefinStorage.sol";

/**
 * @title LibDoefinBlockHeaderOracle
 * @dev Library functions for accessing block header oracle data
 */
library LibDoefinBlockHeaderOracle {
    /// @notice Get the current block height (latest block number)
    /// @return The current block height
    function getCurrentBlockHeight() internal view returns (uint256) {
        return LibDoefinStorage.appStorage().blockHeaderOracleStorage.currentBlockHeight;
    }

    /// @notice Get the next index in the ring buffer
    /// @return The next block index
    function getNextBlockIndex() internal view returns (uint256) {
        return LibDoefinStorage.appStorage().blockHeaderOracleStorage.nextBlockIndex;
    }

    /// @notice Get a block header at a specific index in the ring buffer
    /// @param index The index in the ring buffer
    /// @return The block header at that index
    function getBlockHeaderAt(uint256 index) internal view returns (LibDoefinStorage.BlockHeader memory) {
        return LibDoefinStorage.appStorage().blockHeaderOracleStorage.blockHeaders[index];
    }

    /// @notice Get a block header by block number
    /// @param blockNumber The Bitcoin block number
    /// @return The block header if found
    function getBlockHeaderByNumber(uint256 blockNumber) internal view returns (LibDoefinStorage.BlockHeader memory) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        uint256 currentHeight = ds.blockHeaderOracleStorage.currentBlockHeight;

        // Check if block number is within the buffer range
        if (blockNumber > currentHeight || blockNumber <= currentHeight - LibDoefinStorage.NUM_OF_BLOCK_HEADERS) {
            revert Errors.ValueOutOfRange();
        }

        // Calculate the index in the ring buffer
        uint256 offset = currentHeight - blockNumber;
        uint256 index = (ds.blockHeaderOracleStorage.nextBlockIndex + LibDoefinStorage.NUM_OF_BLOCK_HEADERS - offset - 1) %
            LibDoefinStorage.NUM_OF_BLOCK_HEADERS;

        return ds.blockHeaderOracleStorage.blockHeaders[index];
    }

    /// @notice Get the latest block header
    /// @return The latest block header
    function getLatestBlockHeader() internal view returns (LibDoefinStorage.BlockHeader memory) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        uint256 currentBlockIndex = ((ds.blockHeaderOracleStorage.nextBlockIndex + LibDoefinStorage.NUM_OF_BLOCK_HEADERS) - 1) %
            LibDoefinStorage.NUM_OF_BLOCK_HEADERS;
        return ds.blockHeaderOracleStorage.blockHeaders[currentBlockIndex];
    }

    /// @notice Get all block headers in the ring buffer
    /// @return Array of all block headers currently stored
    function getAllBlockHeaders() internal view returns (LibDoefinStorage.BlockHeader[] memory) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        LibDoefinStorage.BlockHeader[] memory headers = new LibDoefinStorage.BlockHeader[](LibDoefinStorage.NUM_OF_BLOCK_HEADERS);

        for (uint256 i = 0; i < LibDoefinStorage.NUM_OF_BLOCK_HEADERS; i++) {
            headers[i] = ds.blockHeaderOracleStorage.blockHeaders[i];
        }

        return headers;
    }
}
