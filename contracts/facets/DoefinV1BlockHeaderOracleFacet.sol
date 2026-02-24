// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {Errors} from "../libraries/Errors.sol";
import {Events} from "../libraries/Events.sol";
import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {BlockHeaderUtils} from "../libraries/BlockHeaderUtils.sol";
import {LibOracleAdapter} from "../libraries/LibOracleAdapter.sol";
import {IDoefinBlockHeaderOracle} from "../interfaces/IDoefinBlockHeaderOracle.sol";

/**
 * @title DoefinV1BlockHeaderOracle
 * @dev The block header oracle is responsible for verifying new bitcoin block header
 * The contract is initialized with a buffer of 17 confirmed blocks on the bitcoin blockchain. Having a buffer of 17
 * blocks ensures that the contract has sufficient historical data to handle reorgs and validate a new chain
 * correctly.
 *
 * As new blocks are mined and confirmed, they are submitted to this contract for validation.
 *
 * Validating a block header is a critical part of maintaining the integrity and security of the bitcoin
 * block header oracle.
 * The contract uses the bitcoin consensus rules for validating a block header. The rules are specified as:
 * 1. Check Block Header Structure
 * 2. Verify the Previous Block Hash: Check that the hashPrevBlock field matches the hash of the previous block.
 *    This ensures the blockchain is properly linked and ordered.
 * 3. Validate the Timestamp: Check that the block’s timestamp is greater than the median of the previous 11 blocks.
 * 4. Validate the Proof of work: Calculate the hash of the block header using the double SHA-256 hashing algorithm
 *    and ensure it is less than the target specified by nBits.
 * 5. Verify the Difficulty Target (nBits): Ensure that the difficulty target (nBits) of the block matches the expected
 *    value. Difficulty is adjusted every 2016 blocks to maintain the 10-minute block interval.
 *
 * After validating the new block header, the contract dispatches the new difficulty to the Options Manager for
 * settlement
 */
/**
 * @title DoefinV1BlockHeaderOracleFacet
 * @author Doefin
 * @notice Diamond facet implementing Bitcoin block header validation and oracle functionality
 * @dev Validates Bitcoin block headers using consensus rules and maintains 17-block history buffer
 * @dev Provides trustless Bitcoin network data for prediction market settlement
 * @dev Uses ring buffer storage pattern for gas-efficient block header management
 *
 * @notice Block header validation process:
 * 1. Check Block Header Structure: Validate field formats and ranges
 * 2. Verify Previous Block Hash: Ensure proper blockchain linkage
 * 3. Validate Timestamp: Must be greater than median of previous 11 blocks
 * 4. Validate Proof of Work: Double SHA-256 hash must be below target
 * 5. Verify Difficulty Target: nBits must match expected difficulty adjustment
 *
 * @dev After validation, triggers condition settlement for prediction markets
 */
contract DoefinV1BlockHeaderOracle is IDoefinBlockHeaderOracle {
    /**
     * @notice Initializes the block header oracle with historical Bitcoin block data
     * @dev Must be called during diamond deployment before oracle can accept new blocks
     * @dev Populates 17-block ring buffer to provide sufficient historical context
     * @dev Prevents re-initialization once currentBlockHeight is set
     * @param initialBlockHistory Array of exactly 17 consecutive Bitcoin block headers
     * @param initialBlockHeight The block number of the first header in the array
     * @custom:reverts AlreadyInitialized if oracle has already been initialized
     * @custom:reverts BlockHeaderOracle_InvalidInitialHistoryLength if not exactly 17 headers
     * @custom:security One-time initialization prevents data corruption from duplicate calls
     * @custom:gas High initial cost due to 17 block header storage writes
     */
    function initializeBlockHeaderOracle(LibDoefinStorage.BlockHeader[] calldata initialBlockHistory, uint256 initialBlockHeight) external {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        // Prevent re-initialization
        if (ds.blockHeaderOracleStorage.currentBlockHeight != 0) {
            revert Errors.AlreadyInitialized();
        }

        if (initialBlockHistory.length != LibDoefinStorage.NUM_OF_BLOCK_HEADERS) {
            revert Errors.BlockHeaderOracle_InvalidInitialHistoryLength();
        }

        for (uint256 i = 0; i < initialBlockHistory.length; ++i) {
            LibDoefinStorage.BlockHeader memory blockHeader = initialBlockHistory[i];
            blockHeader.blockHash = BlockHeaderUtils.calculateBlockHash(blockHeader);
            blockHeader.blockNumber = initialBlockHeight + i;

            ds.blockHeaderOracleStorage.blockHeaders[i] = blockHeader;
        }

        ds.blockHeaderOracleStorage.nextBlockIndex = 0;
        ds.blockHeaderOracleStorage.currentBlockHeight = initialBlockHeight + LibDoefinStorage.NUM_OF_BLOCK_HEADERS - 1;
    }

    /// @inheritdoc IDoefinBlockHeaderOracle
    function submitNextBlock(LibDoefinStorage.BlockHeader calldata _newBlockHeader) external {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        LibDoefinStorage.BlockHeader memory newBlockHeader = _newBlockHeader;
        newBlockHeader.blockHash = BlockHeaderUtils.calculateBlockHash(newBlockHeader);
        newBlockHeader.blockNumber = ++ds.blockHeaderOracleStorage.currentBlockHeight;

        LibDoefinStorage.BlockHeader memory currentBlockHeader = getLatestBlockHeader();
        _verifyBlockHeader(currentBlockHeader, newBlockHeader);

        ds.blockHeaderOracleStorage.blockHeaders[ds.blockHeaderOracleStorage.nextBlockIndex] = newBlockHeader;
        ds.blockHeaderOracleStorage.nextBlockIndex = (ds.blockHeaderOracleStorage.nextBlockIndex + 1) % LibDoefinStorage.NUM_OF_BLOCK_HEADERS;

        emit Events.BlockSubmitted(newBlockHeader.blockHash, newBlockHeader.timestamp);

        _settleCondition();
    }

    /// @inheritdoc IDoefinBlockHeaderOracle
    function submitBatchBlocks(LibDoefinStorage.BlockHeader[] calldata newBlockHeaders) external {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        LibDoefinStorage.BlockHeader memory latestBlockHeaderInBatch = newBlockHeaders[newBlockHeaders.length - 1];
        uint256 forkHeight = _findForkPoint(newBlockHeaders[0]);

        if (forkHeight + newBlockHeaders.length <= ds.blockHeaderOracleStorage.currentBlockHeight) {
            revert Errors.BlockHeaderOracle_NewChainNotLonger();
        }

        if (forkHeight < ds.blockHeaderOracleStorage.currentBlockHeight) {
            emit Events.BlockReorged(latestBlockHeaderInBatch.merkleRootHash);
        }

        LibDoefinStorage.BlockHeader memory prevBlockHeader = forkHeight == ds.blockHeaderOracleStorage.currentBlockHeight
            ? getLatestBlockHeader()
            : ds.blockHeaderOracleStorage.blockHeaders[
                (ds.blockHeaderOracleStorage.nextBlockIndex + forkHeight - ds.blockHeaderOracleStorage.currentBlockHeight - 1) %
                    LibDoefinStorage.NUM_OF_BLOCK_HEADERS
            ];

        ds.blockHeaderOracleStorage.nextBlockIndex =
            (ds.blockHeaderOracleStorage.nextBlockIndex + forkHeight - ds.blockHeaderOracleStorage.currentBlockHeight) %
            LibDoefinStorage.NUM_OF_BLOCK_HEADERS;
        ds.blockHeaderOracleStorage.currentBlockHeight = forkHeight;

        _applyChain(prevBlockHeader, newBlockHeaders);
    }

    /// @inheritdoc IDoefinBlockHeaderOracle
    function medianBlockTime() public view returns (uint256) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        uint256[11] memory timestamps;
        uint256 startIndex = (ds.blockHeaderOracleStorage.nextBlockIndex + LibDoefinStorage.NUM_OF_BLOCK_HEADERS - 1) %
            LibDoefinStorage.NUM_OF_BLOCK_HEADERS;

        for (uint256 i = 0; i < 11; ++i) {
            uint256 j = (startIndex + LibDoefinStorage.NUM_OF_BLOCK_HEADERS - i) % LibDoefinStorage.NUM_OF_BLOCK_HEADERS;
            timestamps[i] = ds.blockHeaderOracleStorage.blockHeaders[j].timestamp;
        }

        return BlockHeaderUtils.median(timestamps);
    }

    /// @inheritdoc IDoefinBlockHeaderOracle
    function getLatestBlockHeader() public view returns (LibDoefinStorage.BlockHeader memory) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        uint256 currentBlockIndex = ((ds.blockHeaderOracleStorage.nextBlockIndex + LibDoefinStorage.NUM_OF_BLOCK_HEADERS) - 1) %
            LibDoefinStorage.NUM_OF_BLOCK_HEADERS;
        return ds.blockHeaderOracleStorage.blockHeaders[currentBlockIndex];
    }

    /**
     * @dev Settle orders in the order book for every new bloc number
     */
    function _settleCondition() internal {
        LibOracleAdapter.settleCondition();
    }

    /**
     * @dev Apply a series of new block headers to the chain
     * @param newBlockHeaders The block headers to apply
     */
    function _applyChain(LibDoefinStorage.BlockHeader memory prevBlockHeader, LibDoefinStorage.BlockHeader[] memory newBlockHeaders) internal {
        for (uint256 i = 0; i < newBlockHeaders.length; i++) {
            LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
            LibDoefinStorage.BlockHeader memory newBlockHeader = newBlockHeaders[i];
            newBlockHeader.blockHash = BlockHeaderUtils.calculateBlockHash(newBlockHeader);
            newBlockHeader.blockNumber = ++ds.blockHeaderOracleStorage.currentBlockHeight;

            _verifyBlockHeader(prevBlockHeader, newBlockHeader);
            prevBlockHeader = newBlockHeader;

            ds.blockHeaderOracleStorage.blockHeaders[ds.blockHeaderOracleStorage.nextBlockIndex] = newBlockHeader;
            ds.blockHeaderOracleStorage.nextBlockIndex = (ds.blockHeaderOracleStorage.nextBlockIndex + 1) % LibDoefinStorage.NUM_OF_BLOCK_HEADERS;

            emit Events.BlockSubmitted(newBlockHeader.blockHash, newBlockHeader.timestamp);

            // Settlement call after each block is applied
            _settleCondition();
        }
    }

    /**
     * @dev Find the fork point where the new chain diverges from the current chain
     * @param newBlockHeader The first header of the new chain
     * @return The height of the fork point
     */
    function _findForkPoint(LibDoefinStorage.BlockHeader calldata newBlockHeader) internal view returns (uint256) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        for (uint256 i = 0; i < LibDoefinStorage.NUM_OF_BLOCK_HEADERS; i++) {
            uint256 index = (ds.blockHeaderOracleStorage.nextBlockIndex + LibDoefinStorage.NUM_OF_BLOCK_HEADERS - i - 1) %
                LibDoefinStorage.NUM_OF_BLOCK_HEADERS;
            if (ds.blockHeaderOracleStorage.blockHeaders[index].blockHash == newBlockHeader.prevBlockHash) {
                uint256 parentHeight = ds.blockHeaderOracleStorage.currentBlockHeight - i;
                uint256 expectedNewBlockHeight = parentHeight + 1;

                // Validate that the user-supplied block number matches expected height
                if (newBlockHeader.blockNumber != expectedNewBlockHeight) {
                    revert Errors.BlockHeaderOracle_CannotFindForkPoint();
                }

                return parentHeight;
            }
        }

        // If no parent found in our buffer, reject the submission
        // This prevents manipulation via arbitrary block numbers
        revert Errors.BlockHeaderOracle_CannotFindForkPoint();
    }

    /// @notice Verifies a single block header against consensus rules
    /// @param prevBlockHeader The previous block header
    /// @param newBlockHeader The new block header to verify
    function _verifyBlockHeader(
        LibDoefinStorage.BlockHeader memory prevBlockHeader,
        LibDoefinStorage.BlockHeader memory newBlockHeader
    ) internal view {
        if (newBlockHeader.prevBlockHash != prevBlockHeader.blockHash) {
            revert Errors.BlockHeaderOracle_PrevBlockHashMismatch();
        }

        if (newBlockHeader.timestamp < medianBlockTime()) {
            revert Errors.BlockHeaderOracle_InvalidTimestamp();
        }

        if (!BlockHeaderUtils.isValidBlockHeaderHash(prevBlockHeader, newBlockHeader)) {
            revert Errors.BlockHeaderOracle_InvalidBlockHash();
        }
    }

    // ========================================
    // GETTER METHODS
    // ========================================

    /// @notice Get the current block height (latest block number)
    /// @return The current block height
    function getCurrentBlockHeight() external view returns (uint256) {
        return LibDoefinStorage.appStorage().blockHeaderOracleStorage.currentBlockHeight;
    }

    /// @notice Get the next index in the ring buffer
    /// @return The next block index
    function getNextBlockIndex() external view returns (uint256) {
        return LibDoefinStorage.appStorage().blockHeaderOracleStorage.nextBlockIndex;
    }

    /// @notice Get a block header at a specific index in the ring buffer
    /// @param index The index in the ring buffer
    /// @return The block header at that index
    function getBlockHeaderAt(uint256 index) external view returns (LibDoefinStorage.BlockHeader memory) {
        if (index >= LibDoefinStorage.NUM_OF_BLOCK_HEADERS) {
            revert Errors.ValueOutOfRange();
        }
        return LibDoefinStorage.appStorage().blockHeaderOracleStorage.blockHeaders[index];
    }

    /// @notice Get a block header by block number
    /// @param blockNumber The Bitcoin block number
    /// @return The block header if found
    function getBlockHeaderByNumber(uint256 blockNumber) external view returns (LibDoefinStorage.BlockHeader memory) {
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

    /// @notice Get all block headers in the ring buffer
    /// @return Array of all block headers currently stored
    function getAllBlockHeaders() external view returns (LibDoefinStorage.BlockHeader[] memory) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        LibDoefinStorage.BlockHeader[] memory headers = new LibDoefinStorage.BlockHeader[](LibDoefinStorage.NUM_OF_BLOCK_HEADERS);

        for (uint256 i = 0; i < LibDoefinStorage.NUM_OF_BLOCK_HEADERS; i++) {
            headers[i] = ds.blockHeaderOracleStorage.blockHeaders[i];
        }

        return headers;
    }

    /// @notice Get the buffer size (number of blocks stored)
    /// @return The maximum number of blocks in the buffer
    function getBufferSize() external pure returns (uint256) {
        return LibDoefinStorage.NUM_OF_BLOCK_HEADERS;
    }

    /// @notice Get the median timestamps buffer size
    /// @return The number of blocks used for median calculation
    function getMedianBufferSize() external pure returns (uint256) {
        return LibDoefinStorage.NUM_OF_TIMESTAMPS;
    }
}
