// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {Errors} from "./Errors.sol";
import {LibDoefinStorage} from "./LibDoefinStorage.sol";

/**
 * @title LibDoefinBlockHeaderOracle
 * @author Doefin
 * @notice Library providing read-only access functions for Bitcoin block header oracle data
 * @dev Offers convenient access patterns for the 17-block ring buffer storage system
 * @dev Used by other system components to query historical Bitcoin block information
 */
library LibDoefinBlockHeaderOracle {
    /**
     * @notice Retrieves the current Bitcoin block height tracked by the oracle
     * @dev Returns the block number of the most recently validated and stored block
     * @return The current block height (block number)
     * @custom:note Block height is 0 before oracle initialization
     */
    function getCurrentBlockHeight() internal view returns (uint256) {
        return LibDoefinStorage.appStorage().blockHeaderOracleStorage.currentBlockHeight;
    }

    /**
     * @notice Gets the next insertion index in the ring buffer
     * @dev Ring buffer cycles through indices 0-16 to maintain 17-block history
     * @return The index where the next block header will be stored
     * @custom:note Index wraps around using modulo arithmetic for circular buffer
     */
    function getNextBlockIndex() internal view returns (uint256) {
        return LibDoefinStorage.appStorage().blockHeaderOracleStorage.nextBlockIndex;
    }

    /**
     * @notice Retrieves a block header at a specific ring buffer index
     * @dev Direct access to ring buffer storage - index must be validated
     * @param index The ring buffer index (0-16) to retrieve
     * @return The block header stored at the specified index
     * @custom:reverts ValueOutOfRange if index >= 17 (NUM_OF_BLOCK_HEADERS)
     * @custom:note Index does not correspond to block height - use getBlockHeaderByNumber for that
     */
    function getBlockHeaderAt(uint256 index) internal view returns (LibDoefinStorage.BlockHeader memory) {
        if (index >= LibDoefinStorage.NUM_OF_BLOCK_HEADERS) {
            revert Errors.ValueOutOfRange();
        }
        return LibDoefinStorage.appStorage().blockHeaderOracleStorage.blockHeaders[index];
    }

    /**
     * @notice Retrieves a block header by its Bitcoin network block number
     * @dev Calculates ring buffer position based on block number relative to current height
     * @dev Can only access blocks within the 17-block sliding window
     * @param blockNumber The Bitcoin block number to retrieve
     * @return The block header for the specified block number
     * @custom:reverts ValueOutOfRange if block number outside available range
     * @custom:note Available range: (currentHeight - 17) < blockNumber <= currentHeight
     * @custom:gas O(1) lookup using ring buffer arithmetic
     */
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

    /// @notice Get the latest block header.
    /// @dev SCRUM-234 (dead-code A-10 + option B) — matches the
    ///      `DoefinV1BlockHeaderOracleFacet.getLatestBlockHeader` behaviour exactly,
    ///      including the silent return of the zero-valued ring-buffer slot when the
    ///      oracle has not been initialised. The previous `currentBlockHeight == 0 ->
    ///      revert ValueOutOfRange` guard was removed so the facet can route through
    ///      this function without changing observable behaviour (some integration tests
    ///      rely on the silent return). Callers that need an "is oracle initialised"
    ///      gate should check `getCurrentBlockHeight() != 0` themselves.
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
