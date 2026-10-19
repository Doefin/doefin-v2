// SPDX-License-Identifier: AGPL-3.0
pragma solidity 0.8.20;

/* ============================================================================
 *                      OracleInvariantHarnessBase
 * ----------------------------------------------------------------------------
 * TEST-ONLY property-fuzzing harness for the Bitcoin block-header oracle
 * (DoefinV1BlockHeaderOracleFacet + BlockHeaderUtils + LibDoefinBlockHeaderOracle).
 * SCRUM-521-AUDIT-SCOPE / SEC-015. Echidna + Medusa compatible: no-argument
 * constructor, `fuzz_*` actions, `echidna_*` boolean properties.
 *
 * WHY REAL HEADERS ONLY
 *   Submission is permissionless but every header must pass Bitcoin consensus
 *   checks including real proof of work, so random fuzz input can never be
 *   accepted. The harness therefore embeds real headers (OracleHeaderFixtures):
 *     world 0 — canonical 967110..967160 + the orphaned 967143 that froze the
 *               Base-mainnet oracle on 2026-09-15 (SEC-015);
 *     world 1 — canonical 935468..935503 + the orphaned 935497 of the earlier
 *               reorg fixture (test/data/reorg_test/).
 *   The fuzzer chooses only the SHAPE of each submission: which header, which
 *   slice, how deep a replay, overlapping/stale ranges, orphan branches, caller-
 *   supplied metadata (`blockNumber` / `blockHash`), single-field tampering,
 *   empty batches, re-initialisation, and re-deployment with a different init
 *   window (which moves the orphan through all 17 ring slots).
 *
 * MODEL
 *   Each world keeps a reference model of the chain the oracle must hold — the
 *   canonical index of the tip and whether the tip is the orphan (the orphans
 *   have no children, so they can only ever sit at the tip). Before every
 *   submission the harness derives from the SPEC whether it must be accepted:
 *     - single header: accepted iff it is a child of the stored tip;
 *     - batch: accepted iff the first header's parent is one of the 17 stored
 *       headers, its caller-supplied `blockNumber` is parent height + 1, and the
 *       new chain is strictly longer;
 *     - anything with a tampered consensus field: rejected (PoW / linkage).
 *   Replays deeper than 6 must be accepted by the production facet: since ORC-007
 *   it reads the median-time window by height, not from the last 11 ring slots.
 *   The pre-SCRUM-521 negative control keeps the old tolerance ("accept, or
 *   reject InvalidTimestamp" — its window reads stale slots for d >= 7).
 *   The harness then compares the oracle's reaction and resulting state with the
 *   model (liveness, safety, post-conditions) and checks structural invariants
 *   of the ring buffer after every call.
 *
 * PANICS
 *   Every revert is classified. A Panic (0x4e487b71) from any non-empty
 *   submission fails `echidna_no_panic_nonempty` — 0x11 / 0x12 / 0x32 are the
 *   arithmetic / division / index class SEC-015 belonged to. `submitBatchBlocks([])`
 *   is tracked under its own property, `echidna_empty_batch_no_panic`: the
 *   production facet reverts BlockHeaderOracle_EmptyBatch (ORC-011); the
 *   pre-SCRUM-521 control still panics 0x11 on `newBlockHeaders[length - 1]`.
 *
 * LIBRARY LINKING
 *   The oracle facet calls the external library function
 *   BlockHeaderUtils.calculateDifficulty (via LibOracleAdapter), so its bytecode
 *   carries a BlockHeaderUtils link placeholder and so does this harness. The
 *   fuzz configs link it with crytic-compile `--compile-libraries` and predeploy
 *   the library (security/echidna.oracle.config.yaml, security/medusa.oracle.json);
 *   Hardhat links it with `getContractFactory(..., { libraries })`. The harness
 *   registers no oracle-adapter questions, so that call is never reached.
 *
 * NEGATIVE CONTROL
 *   OracleInvariantHarnessPreFix runs the same harness against a verbatim copy
 *   of the pre-SCRUM-521 facet; test/audit/OracleInvariantHarness.test.js shows
 *   that the panic and liveness properties fail there.
 * ==========================================================================*/

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IDoefinBlockHeaderOracle} from "../interfaces/IDoefinBlockHeaderOracle.sol";
import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {Errors} from "../libraries/Errors.sol";
import {OracleHeaderFixtures} from "./OracleHeaderFixtures.sol";

/**
 * @title OracleInvariantHarnessBase
 * @author Doefin (audit)
 * @notice Echidna / Medusa property-fuzzing harness core for the block-header oracle.
 * @dev Test-only. Concrete harnesses supply the oracle facet via {_newOracleFacet}.
 */
abstract contract OracleInvariantHarnessBase {
    // ========================================
    // ERRORS
    // ========================================

    /// @notice Constructor could not assemble or initialise world `world`.
    error HarnessSetupFailed(uint256 world);

    // ========================================
    // CONSTANTS (spec values, deliberately not read from the code under test)
    // ========================================

    /// @notice Ring-buffer size: the oracle stores the last 17 headers.
    uint256 internal constant RING = 17;
    /// @notice Bitcoin median-time-past window (11 headers).
    uint256 internal constant MTP_WINDOW = 11;
    /// @notice Deepest replay whose median-time window is all verified predecessors (17 - 11).
    uint256 internal constant MTP_SAFE_DEPTH = RING - MTP_WINDOW;
    /// @notice Longest batch the fuzzer builds (> RING, to reach "fork below the buffer").
    uint256 internal constant MAX_BATCH = RING + 3;
    /// @notice Number of real-header worlds (see OracleHeaderFixtures).
    uint256 public constant WORLD_COUNT = 2;
    /// @notice Selector of the compiler's `Panic(uint256)`.
    bytes4 internal constant PANIC_SELECTOR = 0x4e487b71;
    /// @dev HEVM cheatcode address (Echidna / Medusa). A call to it is a no-op under Hardhat,
    ///      whose clock is already real time.
    address internal constant HEVM = 0x7109709ECfa91a80626fF3989D68f67F5b1DD12D;
    /// @dev 2033-05-18 — after every fixture header, so the oracle's 2-hour future-timestamp
    ///      rule (ORC-010) never rejects a real header because the fuzzer's clock starts in 2018.
    uint256 internal constant HARNESS_CLOCK = 2_000_000_000;
    /// @notice Number of consensus fields `fuzz_submitTampered` can corrupt.
    uint256 internal constant TAMPERABLE_FIELDS = 6;

    // Action ids, recorded with each violation for diagnosis.
    uint8 internal constant A_RESET = 1;
    uint8 internal constant A_NEXT = 2;
    uint8 internal constant A_ANY = 3;
    uint8 internal constant A_ORPHAN = 4;
    uint8 internal constant A_BATCH = 5;
    uint8 internal constant A_REORG = 6;
    uint8 internal constant A_ORPHAN_BATCH = 7;
    uint8 internal constant A_SKEWED = 8;
    uint8 internal constant A_TAMPERED = 9;
    uint8 internal constant A_EMPTY = 10;
    uint8 internal constant A_REINIT = 11;

    // ========================================
    // TYPES
    // ========================================

    /// @notice What the spec says the oracle must do with a submission.
    enum Expect {
        Reject,
        Accept,
        AcceptOrMtpReject // spec-valid replay deeper than MTP_SAFE_DEPTH (SCRUM-521-DEEP-REORG-MTP)
    }

    /// @notice Expected outcome of one submission, derived from the model before the call.
    struct Plan {
        Expect expect;
        uint256 newTipIndex;
        bool newTipIsOrphan;
        uint256 depth;
    }

    /// @notice One oracle instance plus its reference model.
    struct World {
        IDoefinBlockHeaderOracle oracle; // EIP-1167 clone of the oracle facet
        uint256 firstHeight; // fixture: height of canonical index 0
        uint256 count; // fixture: number of canonical headers
        uint256 orphanIndex; // fixture: canonical index the orphan is a sibling of
        uint256 initTipHeight; // height of the 17th header of the current init window
        uint256 tipIndex; // MODEL: canonical index of the tip height
        bool tipIsOrphan; // MODEL: the tip is the orphan (only possible at orphanIndex)
        uint256 maxHeightSeen; // highest currentBlockHeight observed for this instance
        bool successorSeen; // the canonical child of the orphan height has been stored
        uint256 epoch; // number of (re)deployments of this world
    }

    /// @notice Oracle state read through the public views (property input).
    struct Snap {
        bool ok;
        uint256 height;
        uint256 next;
        LibDoefinStorage.BlockHeader[] slots;
        LibDoefinStorage.BlockHeader latest;
    }

    /// @notice Harness counters (diagnostics + Hardhat assertions).
    struct Stats {
        uint256 acceptedSubmissions;
        uint256 acceptedReorgs;
        uint256 mtpRejections;
        uint256 panicCount;
        uint256 lastPanicCode;
        uint8 lastPanicAction;
        bool emptyBatchPanicked;
        uint256 emptyBatchPanicCode;
        uint256 unexpectedErrorCount;
        bytes4 lastUnexpectedSelector;
        uint256 emptyRevertCount;
        uint256 livenessViolations;
        uint8 lastLivenessAction;
        bytes4 lastLivenessSelector;
        uint256 safetyViolations;
        uint8 lastSafetyAction;
        uint256 postconditionViolations;
        uint8 lastPostconditionAction;
        bool reinitSucceeded;
    }

    // ========================================
    // STATE
    // ========================================

    /// @notice Real-header fixture store.
    OracleHeaderFixtures public fixtures;
    /// @notice Shared oracle facet (production or pre-fix copy); every world is a clone of it.
    address public oracleFacet;

    World[WORLD_COUNT] internal worlds;
    Stats internal stats;

    // ========================================
    // CONSTRUCTOR
    // ========================================

    /// @notice Deploys the fixtures, the oracle facet and one initialised oracle per world.
    /// @dev No arguments — Echidna / Medusa instantiate the harness directly. Each world
    ///      starts initialised with its first 17 canonical headers, which puts the world-0
    ///      orphan in ring slot 16 once its parent is reached: the production incident.
    constructor() {
        OracleHeaderFixtures fx = new OracleHeaderFixtures();
        fixtures = fx;
        oracleFacet = _newOracleFacet();

        for (uint256 w = 0; w < WORLD_COUNT; ++w) {
            (uint256 firstHeight, uint256 count, uint256 orphanIndex) = fx.info(w);
            if (count < RING + 1 || orphanIndex < RING || orphanIndex + 1 >= count) revert HarnessSetupFailed(w);
            World storage W = worlds[w];
            W.firstHeight = firstHeight;
            W.count = count;
            W.orphanIndex = orphanIndex;
            if (!_initWorld(w, 0, false)) revert HarnessSetupFailed(w);
        }

        IDoefinBlockHeaderOracle probe = worlds[0].oracle;
        if (probe.getBufferSize() != RING || probe.getMedianBufferSize() != MTP_WINDOW) {
            revert HarnessSetupFailed(type(uint256).max);
        }
    }

    /// @notice Deploys the oracle facet under test.
    function _newOracleFacet() internal virtual returns (address);

    // ========================================
    // FUZZ ACTIONS
    // ========================================

    /// @notice Re-deploy world `ws` and initialise it with canonical window `offset`
    ///         (or, with `orphanTip`, the 17-header orphan branch ending at the orphan).
    /// @dev The orphan's ring slot is `(orphanIndex - offset - 17) mod 17`, so the
    ///      fuzzer can place it in any of the 17 slots (world 0: offsets 0..16).
    function fuzz_reset(uint8 ws, uint8 offset, bool orphanTip) external {
        uint256 w = uint256(ws) % WORLD_COUNT;
        World storage W = worlds[w];
        if (orphanTip) {
            _initWorld(w, W.orphanIndex - (RING - 1), true);
        } else {
            _initWorld(w, uint256(offset) % (W.count - RING + 1), false);
        }
    }

    /// @notice `submitNextBlock` the canonical header after the model tip.
    function fuzz_submitNext(uint8 ws) external {
        uint256 w = uint256(ws) % WORLD_COUNT;
        uint256 i = worlds[w].tipIndex + 1;
        if (i >= worlds[w].count) return; // fixture exhausted
        _submitOne(w, i, 0, A_NEXT);
    }

    /// @notice `submitNextBlock` ANY real header of world `ws` (index `count` is the orphan),
    ///         optionally with junk caller-supplied `blockNumber` / `blockHash` metadata.
    function fuzz_submitAny(uint8 ws, uint8 idx, uint256 junk) external {
        uint256 w = uint256(ws) % WORLD_COUNT;
        _submitOne(w, uint256(idx) % (worlds[w].count + 1), junk, A_ANY);
    }

    /// @notice `submitNextBlock` the orphan (accepted only while its parent is the tip).
    function fuzz_submitOrphan(uint8 ws) external {
        uint256 w = uint256(ws) % WORLD_COUNT;
        _submitOne(w, worlds[w].count, 0, A_ORPHAN);
    }

    /// @notice `submitBatchBlocks` a contiguous canonical slice starting anywhere — extension,
    ///         overlap with stored headers, reorg replay, gap, or fork below the buffer.
    function fuzz_submitBatch(uint8 ws, uint8 start, uint8 len) external {
        uint256 w = uint256(ws) % WORLD_COUNT;
        (uint256 s, uint256 l) = _sliceBounds(w, start, len);
        _submitCanonicalBatch(w, s, l, 0, 0, A_BATCH);
    }

    /// @notice Replay the canonical chain from `depth` (0..17) below the model tip with a
    ///         batch 1..3 headers longer than the depth — the SEC-015 rewind path at every
    ///         pointer position (depth 17 = parent already evicted).
    function fuzz_reorgFromTip(uint8 ws, uint8 depth, uint8 extra) external {
        uint256 w = uint256(ws) % WORLD_COUNT;
        World storage W = worlds[w];
        uint256 d = uint256(depth) % (RING + 1);
        uint256 s = W.tipIndex + 1 - d; // tipIndex >= RING - 1 >= d - 1
        if (s >= W.count) return;
        uint256 l = d + 1 + (uint256(extra) % 3);
        if (l > W.count - s) l = W.count - s;
        _submitCanonicalBatch(w, s, l, 0, 0, A_REORG);
    }

    /// @notice `submitBatchBlocks` the orphan branch `canonical[p - pre .. p - 1] ++ [orphan]`.
    function fuzz_submitOrphanBatch(uint8 ws, uint8 pre) external {
        uint256 w = uint256(ws) % WORLD_COUNT;
        World storage W = worlds[w];
        uint256 q = uint256(pre) % (RING + 1);
        if (q > W.orphanIndex) q = W.orphanIndex;
        uint256 s = W.orphanIndex - q;
        LibDoefinStorage.BlockHeader[] memory batch = fixtures.orphanBranch(w, s);
        Plan memory plan = _planBatch(W, s, batch.length, true, batch[0].blockNumber);
        _exec(w, abi.encodeCall(IDoefinBlockHeaderOracle.submitBatchBlocks, (batch)), plan, A_ORPHAN_BATCH);
    }

    /// @notice Canonical slice with a skewed first `blockNumber` and/or junk `blockNumber` /
    ///         `blockHash` metadata on every header (caller-controlled, non-consensus fields).
    function fuzz_submitBatchSkewed(uint8 ws, uint8 start, uint8 len, uint256 skew, uint256 junk) external {
        uint256 w = uint256(ws) % WORLD_COUNT;
        (uint256 s, uint256 l) = _sliceBounds(w, start, len);
        _submitCanonicalBatch(w, s, l, skew, junk, A_SKEWED);
    }

    /// @notice Take a replay the oracle MUST accept (depth 0..6 from the tip), corrupt one
    ///         consensus field of one header, and submit it — it must be rejected.
    function fuzz_submitTampered(uint8 ws, uint8 depth, uint8 pos, uint8 field, uint256 delta, bool viaNext) external {
        uint256 w = uint256(ws) % WORLD_COUNT;
        World storage W = worlds[w];
        uint256 d = uint256(depth) % (MTP_SAFE_DEPTH + 1);
        uint256 s = W.tipIndex + 1 - d;
        uint256 l = d + 1;
        if (s >= W.count || l > W.count - s) return;
        if (_planBatch(W, s, l, false, W.firstHeight + s).expect != Expect.Accept) return;

        LibDoefinStorage.BlockHeader[] memory batch = fixtures.slice(w, s, l);
        _tamper(batch[uint256(pos) % l], uint256(field) % TAMPERABLE_FIELDS, delta);
        Plan memory plan; // Expect.Reject
        if (viaNext && l == 1) {
            _exec(w, abi.encodeCall(IDoefinBlockHeaderOracle.submitNextBlock, (batch[0])), plan, A_TAMPERED);
        } else {
            _exec(w, abi.encodeCall(IDoefinBlockHeaderOracle.submitBatchBlocks, (batch)), plan, A_TAMPERED);
        }
    }

    /// @notice `submitBatchBlocks([])`: a named error on the production facet (ORC-011), Panic(0x11) on the pre-fix control.
    function fuzz_submitEmptyBatch(uint8 ws) external {
        uint256 w = uint256(ws) % WORLD_COUNT;
        IDoefinBlockHeaderOracle oracle = worlds[w].oracle;
        (bool ok0, uint256 h0, uint256 n0, bytes32 t0) = _readState(oracle);
        LibDoefinStorage.BlockHeader[] memory empty = new LibDoefinStorage.BlockHeader[](0);
        (bool ok, bytes memory ret) = address(oracle).call(abi.encodeCall(IDoefinBlockHeaderOracle.submitBatchBlocks, (empty)));
        if (ok) {
            // An empty batch carries no chain: if it is ever accepted it must be a no-op.
            (bool ok1, uint256 h1, uint256 n1, bytes32 t1) = _readState(oracle);
            if (!ok0 || !ok1 || h1 != h0 || n1 != n0 || t1 != t0) {
                ++stats.safetyViolations;
                stats.lastSafetyAction = A_EMPTY;
            }
        } else {
            _recordRevert(ret, true, A_EMPTY);
        }
        _observe(w);
    }

    /// @notice Call `initializeBlockHeaderOracle` again on the live oracle — must revert.
    function fuzz_reinitialize(uint8 ws, uint8 offset) external {
        uint256 w = uint256(ws) % WORLD_COUNT;
        World storage W = worlds[w];
        uint256 k = uint256(offset) % (W.count - RING + 1);
        LibDoefinStorage.BlockHeader[] memory window = fixtures.slice(w, k, RING);
        (bool ok, bytes memory ret) = address(W.oracle).call(
            abi.encodeCall(IDoefinBlockHeaderOracle.initializeBlockHeaderOracle, (window, W.firstHeight + k))
        );
        if (ok) {
            stats.reinitSucceeded = true;
        } else {
            _recordRevert(ret, false, A_REINIT);
        }
        _observe(w);
    }

    // ========================================
    // PROPERTIES (Echidna / Medusa: view, no args, return bool)
    // ========================================

    /// @notice `nextBlockIndex < 17` for every world.
    function echidna_next_index_in_range() public view returns (bool) {
        for (uint256 w = 0; w < WORLD_COUNT; ++w) {
            try worlds[w].oracle.getNextBlockIndex() returns (uint256 next) {
                if (next >= RING) return false;
            } catch {
                return false;
            }
        }
        return true;
    }

    /// @notice Every accepted header advances pointer and height by one and every rewind
    ///         moves both back by the depth, so `nextBlockIndex == (height - initTip) mod 17`.
    function echidna_pointer_tracks_height() public view returns (bool) {
        for (uint256 w = 0; w < WORLD_COUNT; ++w) {
            Snap memory s = _snap(worlds[w].oracle);
            if (!s.ok || s.height < worlds[w].initTipHeight) return false;
            if (s.next != (s.height - worlds[w].initTipHeight) % RING) return false;
        }
        return true;
    }

    /// @notice The 17 stored headers, oldest (slot `nextBlockIndex`) to newest, form one
    ///         chain: each `prevBlockHash` equals its predecessor's stored `blockHash` (the
    ///         comparison `_verifyBlockHeader` makes), heights are consecutive and the newest
    ///         is `currentBlockHeight`.
    function echidna_buffer_is_linked_chain() public view returns (bool) {
        for (uint256 w = 0; w < WORLD_COUNT; ++w) {
            Snap memory s = _snap(worlds[w].oracle);
            if (!s.ok || s.next >= RING) return false;
            for (uint256 i = 1; i < RING; ++i) {
                LibDoefinStorage.BlockHeader memory older = s.slots[(s.next + i - 1) % RING];
                LibDoefinStorage.BlockHeader memory newer = s.slots[(s.next + i) % RING];
                if (newer.prevBlockHash != older.blockHash) return false;
                if (newer.blockNumber <= older.blockNumber || newer.blockNumber - older.blockNumber != 1) return false;
            }
            if (s.slots[(s.next + RING - 1) % RING].blockNumber != s.height) return false;
        }
        return true;
    }

    /// @notice The stored tip is a real fixture header — the canonical header at
    ///         `currentBlockHeight`, or the orphan at its height — and carries that height.
    function echidna_tip_is_fixture_header() public view returns (bool) {
        for (uint256 w = 0; w < WORLD_COUNT; ++w) {
            World storage W = worlds[w];
            Snap memory s = _snap(W.oracle);
            if (!s.ok || s.height < W.firstHeight || s.height >= W.firstHeight + W.count) return false;
            if (s.latest.blockNumber != s.height) return false;
            uint256 i = s.height - W.firstHeight;
            bytes32[] memory hs = fixtures.hashes(w);
            bool isCanonical = s.latest.blockHash == hs[i];
            bool isOrphan = i == W.orphanIndex && s.latest.blockHash == hs[W.count];
            if (!isCanonical && !isOrphan) return false;
        }
        return true;
    }

    /// @notice Differential check: the oracle holds exactly the model chain — height, and the
    ///         header (hash + number) of every height in the 17-block window.
    function echidna_window_matches_model() public view returns (bool) {
        for (uint256 w = 0; w < WORLD_COUNT; ++w) {
            World storage W = worlds[w];
            Snap memory s = _snap(W.oracle);
            if (!s.ok || s.next >= RING || s.height != W.firstHeight + W.tipIndex) return false;
            bytes32[] memory hs = fixtures.hashes(w);
            uint256 oldest = W.tipIndex - (RING - 1);
            for (uint256 i = 0; i < RING; ++i) {
                uint256 idx = oldest + i;
                bytes32 want = (idx == W.tipIndex && W.tipIsOrphan) ? hs[W.count] : hs[idx];
                LibDoefinStorage.BlockHeader memory got = s.slots[(s.next + i) % RING];
                if (got.blockHash != want || got.blockNumber != W.firstHeight + idx) return false;
            }
        }
        return true;
    }

    /// @notice `currentBlockHeight` never decreases on an oracle instance.
    function echidna_height_never_decreases() public view returns (bool) {
        for (uint256 w = 0; w < WORLD_COUNT; ++w) {
            try worlds[w].oracle.getCurrentBlockHeight() returns (uint256 h) {
                if (h < worlds[w].maxHeightSeen) return false;
            } catch {
                return false;
            }
        }
        return true;
    }

    /// @notice Once the canonical child of the orphan height has been stored, the orphan is
    ///         never the tip again and never anywhere in the buffer.
    function echidna_orphan_never_returns() public view returns (bool) {
        for (uint256 w = 0; w < WORLD_COUNT; ++w) {
            World storage W = worlds[w];
            if (!W.successorSeen) continue;
            Snap memory s = _snap(W.oracle);
            if (!s.ok) return false;
            bytes32 orphanHash = fixtures.hashOf(w, W.count);
            if (s.latest.blockHash == orphanHash) return false;
            for (uint256 i = 0; i < RING; ++i) {
                if (s.slots[i].blockHash == orphanHash) return false;
            }
        }
        return true;
    }

    /// @notice Every view answers without reverting for every height in
    ///         [currentBlockHeight - 16, currentBlockHeight], and out-of-window lookups revert
    ///         with `ValueOutOfRange` (never a Panic).
    function echidna_views_never_panic() public view returns (bool) {
        for (uint256 w = 0; w < WORLD_COUNT; ++w) {
            if (!_viewsHealthy(worlds[w].oracle)) return false;
        }
        return true;
    }

    /// @notice No Panic from any non-empty submission or initialisation (SEC-015 class).
    function echidna_no_panic_nonempty() public view returns (bool) {
        return stats.panicCount == 0;
    }

    /// @notice KNOWN OPEN ISSUE — EXPECTED TO FAIL until `submitBatchBlocks` rejects an
    ///         empty batch with a named error (SCRUM-521-AUDIT-SCOPE, PR #26 CR-triage OOB-2).
    function echidna_empty_batch_no_panic() public view returns (bool) {
        return !stats.emptyBatchPanicked;
    }

    /// @notice Every non-Panic revert carries one of the oracle's declared errors.
    function echidna_only_declared_errors() public view returns (bool) {
        return stats.unexpectedErrorCount == 0;
    }

    /// @notice Liveness: every submission the spec says must be accepted is accepted (a replay
    ///         deeper than 6 may instead revert InvalidTimestamp, SCRUM-521-DEEP-REORG-MTP).
    function echidna_valid_chains_accepted() public view returns (bool) {
        return stats.livenessViolations == 0;
    }

    /// @notice Safety: nothing the spec rejects is accepted — non-linking, not-longer,
    ///         mis-numbered or tampered submissions, and an empty batch never changes state.
    function echidna_invalid_chains_rejected() public view returns (bool) {
        return stats.safetyViolations == 0;
    }

    /// @notice After every accepted submission the height, tip and pointer are the spec's.
    function echidna_accepted_postconditions() public view returns (bool) {
        return stats.postconditionViolations == 0;
    }

    /// @notice `initializeBlockHeaderOracle` can never succeed twice on one oracle.
    function echidna_init_is_one_shot() public view returns (bool) {
        return !stats.reinitSucceeded;
    }

    // ========================================
    // INSPECTION (Hardhat tests / triage)
    // ========================================

    /// @notice Bitmask of failing properties; bit i is property i of {propertySelectors}.
    /// @dev External self-calls (STATICCALL) so the optimizer does not inline every property
    ///      a second time; a reverting property counts as failing, as in Echidna / Medusa.
    function failedProperties() external view returns (uint256 mask) {
        bytes4[15] memory props = propertySelectors();
        for (uint256 i = 0; i < props.length; ++i) {
            (bool ok, bytes memory ret) = address(this).staticcall(abi.encodeWithSelector(props[i]));
            if (!ok || ret.length != 32 || abi.decode(ret, (uint256)) != 1) mask |= 1 << i;
        }
    }

    /// @notice The 15 `echidna_*` properties, in {failedProperties} bit order.
    function propertySelectors() public pure returns (bytes4[15] memory) {
        return [
            this.echidna_next_index_in_range.selector,
            this.echidna_pointer_tracks_height.selector,
            this.echidna_buffer_is_linked_chain.selector,
            this.echidna_tip_is_fixture_header.selector,
            this.echidna_window_matches_model.selector,
            this.echidna_height_never_decreases.selector,
            this.echidna_orphan_never_returns.selector,
            this.echidna_views_never_panic.selector,
            this.echidna_no_panic_nonempty.selector,
            this.echidna_empty_batch_no_panic.selector,
            this.echidna_only_declared_errors.selector,
            this.echidna_valid_chains_accepted.selector,
            this.echidna_invalid_chains_rejected.selector,
            this.echidna_accepted_postconditions.selector,
            this.echidna_init_is_one_shot.selector
        ];
    }

    /// @notice Harness counters.
    function getStats() external view returns (Stats memory) {
        return stats;
    }

    /// @notice Oracle instance and reference model of world `w`.
    function getWorld(uint256 w) external view returns (World memory) {
        return worlds[w % WORLD_COUNT];
    }

    // ========================================
    // INTERNAL — SETUP
    // ========================================

    /// @dev Fresh oracle instance: an EIP-1167 clone that DELEGATECALLs the oracle facet,
    ///      i.e. the facet code running against the instance's own storage — the same
    ///      execution context a Diamond gives it (LibDoefinStorage is a fixed namespaced
    ///      slot), without embedding Diamond + DiamondCutFacet bytecode in the harness.
    function _newOracle() internal returns (IDoefinBlockHeaderOracle) {
        address clone = Clones.clone(oracleFacet);
        // ORC-008: initialisation is owner-only. The production harness facet exposes
        // `harnessClaimOwnership`; on the pre-fix facet the call fails and is ignored.
        // slither-disable-next-line unchecked-lowlevel
        (bool claimed, ) = clone.call(abi.encodeWithSignature("harnessClaimOwnership()"));
        claimed;
        return IDoefinBlockHeaderOracle(clone);
    }

    /// @dev Move the fuzzer's clock past every fixture header (see HARNESS_CLOCK).
    function _warpClock() internal {
        if (block.timestamp >= HARNESS_CLOCK) return;
        // slither-disable-next-line unchecked-lowlevel
        (bool warped, ) = HEVM.call(abi.encodeWithSignature("warp(uint256)", HARNESS_CLOCK));
        warped;
    }

    /// @dev True when the facet under test computes the median-time window by height
    ///      (ORC-007 fixed): a spec-valid replay of any depth must then be accepted.
    function _mtpWindowFixed() internal pure virtual returns (bool) {
        return false;
    }

    /// @dev Deploy + initialise world `w` with the 17 headers starting at canonical index
    ///      `start` (orphanTip: the orphan branch ending at the orphan). Resets the model.
    function _initWorld(uint256 w, uint256 start, bool orphanTip) internal returns (bool) {
        World storage W = worlds[w];
        LibDoefinStorage.BlockHeader[] memory window = orphanTip ? fixtures.orphanBranch(w, start) : fixtures.slice(w, start, RING);
        IDoefinBlockHeaderOracle fresh = _newOracle();
        (bool ok, bytes memory ret) = address(fresh).call(
            abi.encodeCall(IDoefinBlockHeaderOracle.initializeBlockHeaderOracle, (window, W.firstHeight + start))
        );
        if (!ok) {
            _recordRevert(ret, false, A_RESET);
            ++stats.livenessViolations;
            stats.lastLivenessAction = A_RESET;
            return false;
        }

        uint256 tipIndex = start + RING - 1;
        W.oracle = fresh;
        W.initTipHeight = W.firstHeight + tipIndex;
        W.tipIndex = tipIndex;
        W.tipIsOrphan = orphanTip;
        W.maxHeightSeen = W.initTipHeight;
        W.successorSeen = false;
        ++W.epoch;

        (bool readOk, uint256 h, uint256 next, bytes32 tipHash) = _readState(fresh);
        if (!readOk || h != W.initTipHeight || next != 0 || tipHash != _modelTipHash(w)) {
            ++stats.postconditionViolations;
            stats.lastPostconditionAction = A_RESET;
        }
        _observe(w);
        return true;
    }

    // ========================================
    // INTERNAL — SUBMISSION
    // ========================================

    /// @dev `submitNextBlock` fixture header `idx` (`count` = orphan). Spec: accepted iff it
    ///      is a child of the stored tip; caller-supplied `blockNumber` / `blockHash` are
    ///      metadata the oracle must recompute, so junk there changes nothing.
    function _submitOne(uint256 w, uint256 idx, uint256 junk, uint8 action) internal {
        World storage W = worlds[w];
        LibDoefinStorage.BlockHeader memory h = fixtures.header(w, idx);
        if (junk != 0) {
            h.blockNumber = junk;
            h.blockHash = bytes32(junk);
        }
        bool isOrphan = idx == W.count;
        uint256 heightIndex = isOrphan ? W.orphanIndex : idx;

        Plan memory plan;
        plan.newTipIndex = W.tipIndex + 1;
        plan.newTipIsOrphan = isOrphan;
        if (!W.tipIsOrphan && heightIndex == W.tipIndex + 1) plan.expect = Expect.Accept;
        _exec(w, abi.encodeCall(IDoefinBlockHeaderOracle.submitNextBlock, (h)), plan, action);
    }

    /// @dev `submitBatchBlocks` canonical `[s, s + l)`, optionally mangling metadata.
    function _submitCanonicalBatch(uint256 w, uint256 s, uint256 l, uint256 skew, uint256 junk, uint8 action) internal {
        LibDoefinStorage.BlockHeader[] memory batch = fixtures.slice(w, s, l);
        unchecked {
            if (skew != 0) batch[0].blockNumber += skew;
            if (junk != 0) {
                for (uint256 i = 0; i < l; ++i) {
                    batch[i].blockHash = bytes32(junk ^ i);
                    if (i > 0) batch[i].blockNumber = junk + i;
                }
            }
        }
        Plan memory plan = _planBatch(worlds[w], s, l, false, batch[0].blockNumber);
        _exec(w, abi.encodeCall(IDoefinBlockHeaderOracle.submitBatchBlocks, (batch)), plan, action);
    }

    /// @dev Spec for a linked batch of `len` real headers whose first header is canonical
    ///      index `s` (or, for the orphan branch of length 1, the orphan at index `s`).
    function _planBatch(
        World storage W,
        uint256 s,
        uint256 len,
        bool endsWithOrphan,
        uint256 firstNumber
    ) internal view returns (Plan memory plan) {
        plan.newTipIsOrphan = endsWithOrphan;
        if (len == 0 || s == 0) return plan; // canonical[0]'s parent precedes the fixture
        uint256 parent = s - 1;
        uint256 tip = W.tipIndex;
        if (parent > tip || tip - parent >= RING) return plan; // parent not in the 17-header window
        if (parent == tip && W.tipIsOrphan) return plan; // the window holds the orphan, not its sibling
        if (firstNumber != W.firstHeight + s) return plan; // _findForkPoint height check
        uint256 newTip = parent + len;
        if (newTip <= tip) return plan; // not strictly longer
        plan.newTipIndex = newTip;
        plan.depth = tip - parent;
        plan.expect = plan.depth <= MTP_SAFE_DEPTH ? Expect.Accept : Expect.AcceptOrMtpReject;
    }

    /// @dev Execute a submission, compare with the plan, then observe.
    function _exec(uint256 w, bytes memory data, Plan memory plan, uint8 action) internal {
        _warpClock();
        (bool ok, bytes memory ret) = address(worlds[w].oracle).call(data);
        if (ok) {
            _onAccepted(w, plan, action);
        } else {
            _onRejected(ret, plan.expect, action);
        }
        _observe(w);
    }

    function _onAccepted(uint256 w, Plan memory plan, uint8 action) internal {
        World storage W = worlds[w];
        if (plan.expect == Expect.Reject) {
            ++stats.safetyViolations;
            stats.lastSafetyAction = action;
            return;
        }
        ++stats.acceptedSubmissions;
        if (plan.depth > 0) ++stats.acceptedReorgs;
        W.tipIndex = plan.newTipIndex;
        W.tipIsOrphan = plan.newTipIsOrphan;

        (bool ok, uint256 h, uint256 next, bytes32 tipHash) = _readState(W.oracle);
        if (
            !ok ||
            h != W.firstHeight + plan.newTipIndex ||
            h < W.initTipHeight ||
            next != (h - W.initTipHeight) % RING ||
            tipHash != _modelTipHash(w)
        ) {
            ++stats.postconditionViolations;
            stats.lastPostconditionAction = action;
        }
    }

    function _onRejected(bytes memory ret, Expect expect, uint8 action) internal {
        bytes4 sel = _recordRevert(ret, false, action);
        bool mtpOnly = !_mtpWindowFixed() &&
            expect == Expect.AcceptOrMtpReject &&
            sel == Errors.BlockHeaderOracle_InvalidTimestamp.selector;
        if (expect == Expect.Accept || (expect == Expect.AcceptOrMtpReject && !mtpOnly)) {
            ++stats.livenessViolations;
            stats.lastLivenessAction = action;
            stats.lastLivenessSelector = sel;
        } else if (mtpOnly) {
            ++stats.mtpRejections;
        }
    }

    /// @dev Classify revert data. Returns its selector (0 when there is none).
    function _recordRevert(bytes memory ret, bool emptyBatch, uint8 action) internal returns (bytes4 sel) {
        if (ret.length < 4) {
            ++stats.emptyRevertCount;
            return bytes4(0);
        }
        sel = bytes4(ret);
        if (sel == PANIC_SELECTOR) {
            uint256 code = type(uint256).max;
            if (ret.length >= 36) {
                assembly ("memory-safe") {
                    code := mload(add(ret, 36))
                }
            }
            if (emptyBatch) {
                stats.emptyBatchPanicked = true;
                stats.emptyBatchPanicCode = code;
            } else {
                ++stats.panicCount;
                stats.lastPanicCode = code;
                stats.lastPanicAction = action;
            }
        } else if (!_isDeclaredOracleError(sel)) {
            ++stats.unexpectedErrorCount;
            stats.lastUnexpectedSelector = sel;
        }
    }

    function _isDeclaredOracleError(bytes4 sel) internal pure returns (bool) {
        return
            sel == Errors.BlockHeaderOracle_NewChainNotLonger.selector ||
            sel == Errors.BlockHeaderOracle_CannotFindForkPoint.selector ||
            sel == Errors.BlockHeaderOracle_PrevBlockHashMismatch.selector ||
            sel == Errors.BlockHeaderOracle_InvalidTimestamp.selector ||
            sel == Errors.BlockHeaderOracle_InvalidBlockHash.selector ||
            sel == Errors.BlockHeaderOracle_InvalidInitialHistoryLength.selector ||
            sel == Errors.BlockHeaderOracle_InvalidTargetNBits.selector ||
            sel == Errors.BlockHeaderOracle_UnexpectedDifficulty.selector ||
            sel == Errors.BlockHeaderOracle_TimestampTooNew.selector ||
            sel == Errors.BlockHeaderOracle_EmptyBatch.selector ||
            sel == Errors.AlreadyInitialized.selector ||
            sel == Errors.ValueOutOfRange.selector;
    }

    /// @dev Corrupt one consensus field (the ones hashed into the block hash).
    function _tamper(LibDoefinStorage.BlockHeader memory h, uint256 field, uint256 delta) internal pure {
        uint256 x = delta == 0 ? 1 : delta;
        uint32 y = uint32(x) == 0 ? 1 : uint32(x);
        if (field == 0) h.version ^= y;
        else if (field == 1) h.prevBlockHash ^= bytes32(x);
        else if (field == 2) h.merkleRootHash ^= bytes32(x);
        else if (field == 3) h.timestamp ^= y;
        else if (field == 4) h.nBits ^= y;
        else h.nonce ^= y;
    }

    function _sliceBounds(uint256 w, uint8 start, uint8 len) internal view returns (uint256 s, uint256 l) {
        uint256 count = worlds[w].count;
        s = uint256(start) % count;
        uint256 maxLen = count - s;
        if (maxLen > MAX_BATCH) maxLen = MAX_BATCH;
        l = 1 + (uint256(len) % maxLen);
    }

    // ========================================
    // INTERNAL — OBSERVATION
    // ========================================

    /// @dev Track the max height and whether the orphan height's canonical child was stored.
    function _observe(uint256 w) internal {
        World storage W = worlds[w];
        (bool ok, uint256 h, , ) = _readState(W.oracle);
        if (!ok) return;
        if (h > W.maxHeightSeen) W.maxHeightSeen = h;
        if (W.successorSeen) return;
        uint256 succHeight = W.firstHeight + W.orphanIndex + 1;
        if (h >= succHeight + RING) {
            W.successorSeen = true; // the child height has already scrolled out of the window
        } else if (h >= succHeight) {
            try W.oracle.getBlockHeaderByNumber(succHeight) returns (LibDoefinStorage.BlockHeader memory hdr) {
                if (hdr.blockHash == fixtures.hashOf(w, W.orphanIndex + 1)) W.successorSeen = true;
            } catch {}
        }
    }

    /// @dev Model hash of the tip.
    function _modelTipHash(uint256 w) internal view returns (bytes32) {
        World storage W = worlds[w];
        return fixtures.hashOf(w, W.tipIsOrphan ? W.count : W.tipIndex);
    }

    /// @dev Height, pointer and tip hash, never reverting (a revert here would roll back the
    ///      submission being judged and hide the evidence from the fuzzer).
    function _readState(IDoefinBlockHeaderOracle o) internal view returns (bool ok, uint256 h, uint256 next, bytes32 tipHash) {
        try o.getCurrentBlockHeight() returns (uint256 x) {
            h = x;
        } catch {
            return (false, 0, 0, 0);
        }
        try o.getNextBlockIndex() returns (uint256 x) {
            next = x;
        } catch {
            return (false, 0, 0, 0);
        }
        try o.getLatestBlockHeader() returns (LibDoefinStorage.BlockHeader memory l) {
            tipHash = l.blockHash;
        } catch {
            return (false, 0, 0, 0);
        }
        ok = true;
    }

    function _snap(IDoefinBlockHeaderOracle o) internal view returns (Snap memory s) {
        try o.getCurrentBlockHeight() returns (uint256 x) {
            s.height = x;
        } catch {
            return s;
        }
        try o.getNextBlockIndex() returns (uint256 x) {
            s.next = x;
        } catch {
            return s;
        }
        try o.getAllBlockHeaders() returns (LibDoefinStorage.BlockHeader[] memory a) {
            s.slots = a;
        } catch {
            return s;
        }
        try o.getLatestBlockHeader() returns (LibDoefinStorage.BlockHeader memory l) {
            s.latest = l;
        } catch {
            return s;
        }
        s.ok = s.slots.length == RING;
    }

    function _viewsHealthy(IDoefinBlockHeaderOracle o) internal view returns (bool) {
        uint256 h;
        bytes32 tipHash;
        try o.getCurrentBlockHeight() returns (uint256 x) {
            h = x;
        } catch {
            return false;
        }
        try o.getLatestBlockHeader() returns (LibDoefinStorage.BlockHeader memory l) {
            tipHash = l.blockHash;
        } catch {
            return false;
        }
        if (h < RING || h == type(uint256).max) return false; // real Bitcoin heights only
        for (uint256 b = h - (RING - 1); b <= h; ++b) {
            try o.getBlockHeaderByNumber(b) returns (LibDoefinStorage.BlockHeader memory hdr) {
                if (hdr.blockNumber != b) return false;
                if (b == h && hdr.blockHash != tipHash) return false;
            } catch {
                return false;
            }
        }
        bytes4 outOfRange = Errors.ValueOutOfRange.selector;
        if (!_revertsWith(address(o), abi.encodeCall(IDoefinBlockHeaderOracle.getBlockHeaderByNumber, (h + 1)), outOfRange)) return false;
        if (!_revertsWith(address(o), abi.encodeCall(IDoefinBlockHeaderOracle.getBlockHeaderByNumber, (h - RING)), outOfRange)) return false;
        if (!_revertsWith(address(o), abi.encodeCall(IDoefinBlockHeaderOracle.getBlockHeaderAt, (RING)), outOfRange)) return false;
        try o.medianBlockTime() returns (uint256) {} catch {
            return false;
        }
        return true;
    }

    function _revertsWith(address target, bytes memory data, bytes4 expected) internal view returns (bool) {
        (bool ok, bytes memory ret) = target.staticcall(data);
        return !ok && ret.length >= 4 && bytes4(ret) == expected;
    }
}
