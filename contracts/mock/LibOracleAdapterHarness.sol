// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibOracleAdapter} from "../libraries/LibOracleAdapter.sol";
import {LibCTFCondition} from "../libraries/LibCTFCondition.sol";
import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";

/**
 * @title LibOracleAdapterHarness
 * @author Doefin
 * @notice Test-only harness for the question-RESOLUTION logic of
 *         `LibOracleAdapter` (Bitcoin difficulty / block-count / mining-duration
 *         condition resolution).
 *
 * @dev WHY THIS HARNESS EXISTS
 *      In production `LibOracleAdapter` is reached only two ways:
 *        - `ConditionManagerFacet` calls the `create*Question` functions; and
 *        - `DoefinV1BlockHeaderOracleFacet` calls `settleCondition()` after it
 *          has accepted a *PoW-validated, hash-chained* Bitcoin block header.
 *      Resolution therefore normally requires a full Bitcoin block-header
 *      simulation — real chained headers whose timestamps you cannot choose.
 *      That makes the resolution branches (`_resolveBlockCountQuestion`,
 *      `_findBlockByTimestamp`, the bucket-index edges, the ring-buffer bounds)
 *      effectively untestable through the facets for an arbitrary scenario.
 *
 * @dev WHAT IT DOES
 *      The harness wraps the library's `internal` entrypoints AND exposes
 *      direct seeders for the two pieces of state the resolvers read:
 *        1. the block-header ring buffer (`blockHeaderOracleStorage`); and
 *        2. the timestamp -> block-height map (`oracleAdapterStorage`).
 *      This unit-tests the resolution LOGIC in isolation from block-header
 *      VALIDATION — proof-of-work and hash-chaining are `BlockHeaderUtils` /
 *      `DoefinV1BlockHeaderOracleFacet` concerns, covered by their own suites.
 *      The harness runs on its own EIP-7201 `AppStorage` namespace, so it
 *      never touches a live Diamond's state.
 *
 * @dev INTENDED WORKFLOW (per test)
 *        a. `setOracleState(currentBlockHeight, nextBlockIndex)` — fix the head.
 *        b. `seedBlockHeader(index, header)` — place the header(s) the resolver
 *           will read. The ring-buffer index of a given block number `b` is
 *           `(nextBlockIndex + NUM_OF_BLOCK_HEADERS - (currentHeight - b) - 1)
 *           % NUM_OF_BLOCK_HEADERS`; the latest header is at offset 0.
 *        c. `setTimestampToBlockHeight(ts, height)` — optionally pre-map a
 *           timestamp so `_resolveBlockCountQuestion` finds it directly
 *           (omit it to drive the `_findBlockByTimestamp` +/-10-minute search).
 *        d. `prepareCondition(questionId, outcomeSlotCount)` — so the eventual
 *           `_reportPayouts` has a prepared CTF condition to write into.
 *        e. `create*Question(...)` — register the question.
 *        f. `settleCondition()` — run the resolver.
 *        g. assert via `payoutNumerators` / `payoutDenominator` /
 *           `totalQuestionsResolved`.
 *
 *      Mirrors the existing `DoefinOrderHarness` library-test pattern. Must be
 *      deployed with the `BlockHeaderUtils` library linked (it is a deployed,
 *      non-inlined library that `_getBlockDifficulty` calls through).
 */
contract LibOracleAdapterHarness {
    // ── storage seeders ──────────────────────────────────────────────────

    /// @notice Set the ring-buffer head: the current block height and the
    ///         index the next submitted header would occupy.
    function setOracleState(uint256 currentBlockHeight, uint256 nextBlockIndex) external {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        ds.blockHeaderOracleStorage.currentBlockHeight = currentBlockHeight;
        ds.blockHeaderOracleStorage.nextBlockIndex = nextBlockIndex;
    }

    /// @notice Place a block header directly into ring-buffer slot `index`,
    ///         bypassing PoW / hash-chain validation.
    function seedBlockHeader(uint256 index, LibDoefinStorage.BlockHeader calldata header) external {
        LibDoefinStorage.appStorage().blockHeaderOracleStorage.blockHeaders[index] = header;
    }

    /// @notice Pre-map a timestamp to a block height. Lets a test either give
    ///         `_resolveBlockCountQuestion` an exact hit, or (by omission)
    ///         force the `_findBlockByTimestamp` neighbourhood search.
    function setTimestampToBlockHeight(uint256 timestamp, uint256 blockHeight) external {
        LibDoefinStorage.appStorage().oracleAdapterStorage.timestampToBlockHeight[timestamp] = blockHeight;
    }

    // ── condition preparation ────────────────────────────────────────────

    /// @notice Prepare a CTF condition owned by this harness, so the resolver's
    ///         `_reportPayouts(address(this), ...)` call has somewhere to write.
    function prepareCondition(bytes32 questionId, uint8 outcomeSlotCount) external returns (bytes32) {
        return LibCTFCondition.prepareCondition(address(this), questionId, outcomeSlotCount);
    }

    // ── question creation ────────────────────────────────────────────────

    /// @notice Register a BlockCount question (wraps the `internal` library fn).
    function createBlockCountQuestion(
        bytes32 questionId,
        bytes32 conditionId,
        uint256 startTimestamp,
        uint256 endTimestamp,
        uint256[] calldata countBuckets
    ) external {
        LibOracleAdapter.createBlockCountQuestion(questionId, conditionId, startTimestamp, endTimestamp, countBuckets);
    }

    /// @notice Register a DifficultyThreshold question.
    function createDifficultyThresholdQuestion(
        bytes32 questionId,
        bytes32 conditionId,
        uint256 threshold,
        uint256 targetBlockHeight
    ) external {
        LibOracleAdapter.createDifficultyThresholdQuestion(questionId, conditionId, threshold, targetBlockHeight);
    }

    /// @notice Register a MiningDuration question.
    function createMiningDurationQuestion(
        bytes32 questionId,
        bytes32 conditionId,
        uint256 startBlockHeight,
        uint256 blockCount,
        uint256[] calldata durationBuckets
    ) external {
        LibOracleAdapter.createMiningDurationQuestion(
            questionId, conditionId, startBlockHeight, blockCount, durationBuckets
        );
    }

    // ── resolution entrypoint ────────────────────────────────────────────

    /// @notice Run the resolver — the same call `DoefinV1BlockHeaderOracleFacet`
    ///         makes after a block submission. Resolves every question whose
    ///         trigger block / timestamp has been reached.
    function settleCondition() external {
        LibOracleAdapter.settleCondition();
    }

    // ── read accessors ───────────────────────────────────────────────────

    /// @notice Cumulative count of questions resolved by `settleCondition`.
    function totalQuestionsResolved() external view returns (uint256) {
        return LibDoefinStorage.appStorage().oracleAdapterStorage.totalQuestionsResolved;
    }

    /// @notice Cumulative count of questions registered by `create*Question`.
    function totalQuestionsCreated() external view returns (uint256) {
        return LibDoefinStorage.appStorage().oracleAdapterStorage.totalQuestionsCreated;
    }

    /// @notice CTF payout denominator for `cId` — non-zero once resolved.
    function payoutDenominator(bytes32 cId) external view returns (uint256) {
        return LibDoefinStorage.appStorage().conditionalTokens.payoutDenominator[cId];
    }

    /// @notice CTF per-outcome payout numerators for `cId`.
    function payoutNumerators(bytes32 cId) external view returns (uint256[] memory) {
        return LibDoefinStorage.appStorage().conditionalTokens.payoutNumerators[cId];
    }

    /// @notice The block height mapped to `timestamp` (0 if unmapped).
    function timestampToBlockHeight(uint256 timestamp) external view returns (uint256) {
        return LibDoefinStorage.appStorage().oracleAdapterStorage.timestampToBlockHeight[timestamp];
    }
}
