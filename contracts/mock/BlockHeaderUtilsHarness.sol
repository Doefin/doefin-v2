// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.20;

import {BlockHeaderUtils} from "../libraries/BlockHeaderUtils.sol";

/**
 * @title BlockHeaderUtilsHarness
 * @author Doefin
 * @notice Test-only harness exposing the internal Bitcoin difficulty maths of {BlockHeaderUtils}.
 * @dev The oracle facet applies the exact retarget formula only at a period boundary whose first
 *      block it recorded — i.e. after running across a full 2016-block period, which an
 *      integration test cannot reproduce with real headers. These pure functions are therefore
 *      checked directly against real Bitcoin retarget boundaries
 *      (test/unit/BlockHeaderUtils/BlockHeaderUtils.retarget.test.js).
 */
contract BlockHeaderUtilsHarness {
    function decodeCompactStrict(uint32 nBits) external pure returns (uint256) {
        return BlockHeaderUtils.decodeCompactStrict(nBits);
    }

    function encodeCompact(uint256 target) external pure returns (uint32) {
        return BlockHeaderUtils.encodeCompact(target);
    }

    function nextPeriodTarget(uint256 prevTarget, uint256 firstTimestamp, uint256 lastTimestamp)
        external
        pure
        returns (uint256)
    {
        return BlockHeaderUtils.nextPeriodTarget(prevTarget, firstTimestamp, lastTimestamp);
    }

    /// @notice The nBits the oracle requires for a period's first block — the composition `_verifyDifficulty` uses.
    function requiredBoundaryNBits(uint32 prevNBits, uint256 firstTimestamp, uint256 lastTimestamp)
        external
        pure
        returns (uint32)
    {
        uint256 prevTarget = BlockHeaderUtils.decodeCompactStrict(prevNBits);
        return BlockHeaderUtils.encodeCompact(BlockHeaderUtils.nextPeriodTarget(prevTarget, firstTimestamp, lastTimestamp));
    }

    function blockWork(uint256 target) external pure returns (uint256) {
        return BlockHeaderUtils.blockWork(target);
    }
}
