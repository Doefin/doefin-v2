// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {Errors} from "./Errors.sol";

/// @title BlockHeaderUtils
/// @notice Library that implements utils for bitcoin block header hashing
library BlockHeaderUtils {
    uint256 public constant BASE_DIFFICULTY_TARGET = 0x00000000FFFF << 208;

    /**
     * @dev Return true/false if the block header hash is valid
     * @param currentBlockHeader The block header to hash
     * @param nextBlockHeader The block header to hash
     * @return true/false
     */
    function isValidBlockHeaderHash(
        LibDoefinStorage.BlockHeader memory currentBlockHeader,
        LibDoefinStorage.BlockHeader memory nextBlockHeader
    ) internal pure returns (bool) {
        uint256 target = calculateDifficultyTarget(currentBlockHeader);
        bytes32 hash = nextBlockHeader.blockHash;
        return uint256(hash) < target;
    }

    /**
     * @dev Get the hash of the block header
     * @param blockHeader The block header to hash
     * @return the hash of the block header
     * @notice The function encodes block header data and applies a double SHA-256 hash.
     * Each element of the block header must be encoded in little-endian byte order. Since the EVM
     * uses big-endian byte order, we reverse the bytes of all values prior to encoding to follow the
     * implementation of the bitcoin double-hash algorithm. Note that we reverse the byte order
     * to allow the result to be interpreted as a uint256 value in big-endian byte order.
     */
    function calculateBlockHash(LibDoefinStorage.BlockHeader memory blockHeader) internal pure returns (bytes32) {
        //1. Reverse the byte order of each block header field to match the little-endian format required by Bitcoin
        //2. Serialize the block header into an 80-byte array: (4 + 32 + 32 + 4 + 4 + 4) bytes
        bytes memory data = abi.encodePacked(
            reverseUint32(blockHeader.version),
            reverseBytes32(blockHeader.prevBlockHash),
            reverseBytes32(blockHeader.merkleRootHash),
            reverseUint32(blockHeader.timestamp),
            reverseUint32(blockHeader.nBits),
            reverseUint32(blockHeader.nonce)
        );

        require(data.length == 80, "incorrect data length");

        //3. Calculate the SHA-256 hash of the serialized data
        //4. Calculate the second SHA-256 hash of the first hash
        //5. Reverse the byte order to match Bitcoin's big-endian result format
        bytes32 blockHashBytes32 = sha256(abi.encodePacked(sha256(data)));

        return reverseBytes32(blockHashBytes32);
    }

    function reverseUint32(uint32 input) internal pure returns (uint32) {
        uint32 v = input;

        // swap bytes
        v = ((v & 0xFF00FF00) >> 8) | ((v & 0x00FF00FF) << 8);

        // swap 2-byte long pairs
        v = (v >> 16) | (v << 16);
        return v;
    }

    function reverseBytes32(bytes32 input) internal pure returns (bytes32) {
        uint256 v = uint256(input);

        // swap bytes
        v =
            ((v & 0xFF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00) >> 8) |
            ((v & 0x00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF) << 8);

        // swap 2-byte long pairs
        v =
            ((v & 0xFFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000) >> 16) |
            ((v & 0x0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF) << 16);

        // swap 4-byte long pairs
        v =
            ((v & 0xFFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000) >> 32) |
            ((v & 0x00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF) << 32);

        // swap 8-byte long pairs
        v =
            ((v & 0xFFFFFFFFFFFFFFFF0000000000000000FFFFFFFFFFFFFFFF0000000000000000) >> 64) |
            ((v & 0x0000000000000000FFFFFFFFFFFFFFFF0000000000000000FFFFFFFFFFFFFFFF) << 64);

        // swap 16-byte long pairs
        v = (v >> 128) | (v << 128);

        return bytes32(v);
    }

    /**
     * @dev Calculates the difficulty target of a block header
     * @param blockHeader The block header to hash
     * @return the difficulty target
     * @notice The difficulty target is calculated from the nBits encoding as:
     * target = coefficient * 256 ^ (exponent - 3)
     * Where the exponent is encoded as the first byte of the nBits value
     * and the coefficient is the remaining 3 bytes.
     *
     * The function extracts the first bytes (8-bits) of the nBits value by shifting the value 24 bits to the right and
     * extracts the last 3 bytes (24-bits) of the nBits by doing a bitwise AND with a 24-bit mask 0xFFFFFF.
     */
    function calculateDifficultyTarget(LibDoefinStorage.BlockHeader memory blockHeader) internal pure returns (uint256) {
        uint256 exponent = uint256(blockHeader.nBits) >> 24;
        uint256 coefficient = uint256(blockHeader.nBits & 0xffffff);

        if (exponent <= 3) {
            return coefficient >> (8 * (3 - exponent)); //coefficient * 2 ^ (8 * (3 - exponent))
        } else {
            return coefficient << (8 * (exponent - 3)); //coefficient * 2 ^ (8 * (exponent - 3))
        }
    }

    /**
     * @dev Calculates the difficulty of a block header
     * @param blockHeader The block header to hash
     * @return the difficulty
     * @notice The difficulty is calculated as the ratio of the base target to the block target.
     * The base target is a constant value defined in the contract and the block target is calculated
     * from the block header nBits value.
     */
    function calculateDifficulty(LibDoefinStorage.BlockHeader memory blockHeader) public pure returns (uint256) {
        uint256 target = calculateDifficultyTarget(blockHeader);
        if (target == 0) {
            revert Errors.BlockHeaderOracle_InvalidTargetNBits();
        }
        return BASE_DIFFICULTY_TARGET / target;
    }

    function swap(uint256[11] memory array, uint256 i, uint256 j) internal pure {
        (array[i], array[j]) = (array[j], array[i]);
    }

    function sort(uint256[11] memory array, uint256 begin, uint256 end) internal pure {
        if (begin < end) {
            uint256 j = begin;
            uint256 pivot = array[j];
            for (uint256 i = begin + 1; i < end; ++i) {
                if (array[i] < pivot) {
                    swap(array, i, ++j);
                }
            }
            swap(array, begin, j);
            sort(array, begin, j);
            sort(array, j + 1, end);
        }
    }

    function median(uint256[11] memory array) internal pure returns (uint256) {
        sort(array, 0, 11);
        return array[5];
    }
}
