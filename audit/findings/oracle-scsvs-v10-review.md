# Oracle Review: SCSVS V10 (Bitcoin block-header oracle and market creation/resolution)

**Closes:** `audit/follow-ups.md` **SCRUM-521-AUDIT-SCOPE** (the V10 pass)
**Branch / commit:** `feature/SCRUM-214-oracle-audit-scope` @ `9e641d6` (contracts identical to `dev`)
**Reviewer:** `sc-manual-reviewer` (manual reading only; no tool or test was run)
**Date:** 2026-10-19
**Lens:** `doefin-backend/security/lenses/scsvs.md` §V10 (V10.1–V10.5). The lens line numbers are out of date. Every line below was found in the current source.
**Deployment context:** live on Base mainnet (Diamond `0x71C424Ef79819c852952e517c082C4d17f89Fdf9`). Header submission is permissionless and the oracle resolves every market. Both the mainnet and Sepolia oracles follow **Bitcoin mainnet** (`scripts/oracle-status.js:38` cross-checks against `mempool.space` mainnet), so the mainnet consensus rules apply to both.

**Files in scope:** `contracts/facets/DoefinV1BlockHeaderOracleFacet.sol`, `contracts/libraries/BlockHeaderUtils.sol`, `contracts/libraries/LibDoefinBlockHeaderOracle.sol`, `contracts/interfaces/IDoefinBlockHeaderOracle.sol`, `contracts/interfaces/IOracleAdapter.sol`, `contracts/libraries/LibOracleAdapter.sol`, `contracts/facets/ConditionManagerFacet.sol`, `contracts/libraries/LibConditionMetadata.sol`, `contracts/facets/OracleAdapterFacet.sol`, and the oracle storage in `contracts/libraries/LibDoefinStorage.sol`. I also read `LibCTFCondition._reportPayouts`, the deploy/seed scripts and the oracle tests.
**Solidity:** `pragma ^0.8.20`, built with 0.8.20, viaIR, checked arithmetic. There are **no `unchecked` blocks** in scope.

> **Bottom line.** The SEC-015 arithmetic fix is correct. However, the oracle does **not enforce Bitcoin's difficulty rule**. One block of real proof-of-work, about 3.1–3.2 BTC of hashing, buys an unlimited number of free headers. That is enough to take permanent control of every market resolution (ORC-001, Critical).
>
> The same root cause rejects real Bitcoin blocks whenever difficulty goes down (ORC-002). That gave a ~16% chance of freezing the mainnet oracle over the five downward difficulty adjustments since 2026-05-25. Real block 689472 is a concrete reproducer.
>
> Two of the four question types freeze the whole oracle when they resolve: MiningDuration (ORC-003) and BlockCount (ORC-004). The cause is that resolution runs inside header acceptance, so any revert there blocks every later block.
>
> Under `security/audit-protocol.md`, ORC-001 to ORC-004 block mainnet. The code is already live, so treat them as incidents (see §6, *Immediate actions*).

---

## 1. V10 verdict table

| Check | Verdict | Evidence (file:line) | Findings |
|---|---|---|---|
| **V10.1 Submission auth** | **Finding** | `submitNextBlock` (`DoefinV1BlockHeaderOracleFacet.sol:94`) and `submitBatchBlocks` (`:126`) have no modifier, by design. The only gate is `_verifyBlockHeader` (`:248-263`), which checks three things: the prev-hash link (`:252`), a median-time lower bound (`:256`), and `hash < target(prev.nBits)` (`:260`, which calls `BlockHeaderUtils.sol:21-28`). **These checks are not enough.** The new header's `nBits` is never checked (ORC-001). A timestamp equal to the median is accepted, and there is no upper limit on timestamps (ORC-010). Allowing anyone to submit is the right design for an SPV relay. It is unsafe here only because the consensus checks are incomplete. | ORC-001, ORC-010 |
| **V10.2 PoW / difficulty** | **Finding: Critical** | The 2016-block retarget rule is documented (`:33-34`, `:52`) but **never enforced**. The PoW check takes its target from the *previous* header (`BlockHeaderUtils.sol:25`), and the header's own `nBits` is never validated. The longer-chain rule counts blocks, not cumulative work (`:131`). Result: one real block buys unlimited free headers and permanent capture of the oracle (cost below). The same check rejects real canonical blocks at downward adjustments. | ORC-001, ORC-002 |
| **V10.3 Reorg handling** | **Pass** for the SEC-015 arithmetic. **Finding** for depth limits and fork choice. | Every modulo-17 expression is safe against wrap-around: `:104`, `:149`, `:153`, `:166`, `:170`, `:208`, `:225`, plus `LibDoefinBlockHeaderOracle.sol:74,91` and `LibOracleAdapter.sol:465,475`. Each subtracts at most 16 after adding 17. `parentHeight = currentBlockHeight - i` (`:228`) is safe because height is always at least 16. A depth-16 rewind is arithmetically correct; depth 17 reverts `CannotFindForkPoint`. A successful replay overwrites every orphaned slot, because the new chain is longer than the depth. **However**, the median-time window is corrupted for depth 7 and above, and from about depth 12 it rejects the canonical chain, which freezes the oracle. Fork choice is also by length, not by work. | ORC-007, ORC-001 |
| **V10.4 Re-init protection** | **Pass** for re-initialization. **Finding** for the first initialization. | The `currentBlockHeight != 0` guard (`:73`) holds, and `currentBlockHeight` can never return to 0 (the rewind floor is the old height minus 16, and `_applyChain` always adds blocks), so re-init is impossible. But the first `initializeBlockHeaderOracle` call (`:69-91`) is permissionless and does not validate the headers. It runs as a separate EOA transaction after the Safe cut (`scripts/seed-oracle.js:55`), not as part of the bootstrap (`scripts/deploy-safe-owned.js:274-278`). | ORC-008 |
| **V10.5 Settlement on submit** | **Finding** | Difficulty questions read verified buffer data 6 blocks back, which is always inside the buffer (pass). But resolution runs **inside** header acceptance (`:108`, `:213`), so **any revert in a resolver blocks the canonical header permanently**. Reachable reverts: MiningDuration reading outside the buffer or a negative duration (ORC-003); the BlockCount timestamp lookup (ORC-004); duplicate resolution after the wrong-element `pop()` (ORC-005); too many questions at one height for the per-transaction gas cap (ORC-009). BlockCount resolves with zero confirmations. `SETTLEMENT_DELAY = 6` (`LibDoefinStorage.sol:17`) is the **only** reorg protection: it holds against honest reorgs and gives nothing against ORC-001. A market can also be created whose answer is already decided (ORC-006). | ORC-003, ORC-004, ORC-005, ORC-006, ORC-009 |

### Findings index

| ID | Severity | Title | Can ship as a facet Replace (no storage change) |
|---|---|---|---|
| ORC-001 | **Critical** | New header's `nBits` is never validated; PoW checked against the previous header's target; fork choice counts blocks. One block of work gives permanent control of all resolutions. | Interim fix: **yes**. Full retarget fix: **no** (needs 1–2 slots from `__gap`) |
| ORC-002 | **High** | PoW is checked against the old epoch's target, so honest blocks are rejected at each downward adjustment. The oracle freezes with probability equal to the size of the drop. | **yes** |
| ORC-003 | **High** | MiningDuration: `blockCount ≥ 11` reads outside the buffer, and `end.ts < start.ts` underflows. Either revert inside submission freezes the oracle permanently. | **yes** |
| ORC-004 | **High** | BlockCount: an exact-second timestamp lookup reverts about 99% of the time (oracle freeze), and the 600-second bucket gate leaves at least 37% of questions never resolved. Zero confirmations; the miner controls the timestamp. | Disabling: **yes**. Redesign: **no** |
| ORC-005 | **Medium** | `_resolveConditionsAtTimestamp` removes the last array element instead of the resolved one: a question is lost, and a later duplicate resolution freezes the oracle. | **yes** |
| ORC-006 | **Medium** | Difficulty and duration markets can be created with an already-decided answer. Oracle lag widens the window, and trading is not halted on-chain. | Creation rule: **yes**. On-chain trading cutoff: **no** |
| ORC-007 | **Low** | Deep-reorg replays use a corrupted median-time window. The canonical chain is rejected from depth ≈ 12, freezing the oracle (refines SCRUM-521-DEEP-REORG-MTP). | Explicit depth cap: **yes**. Larger window: **no** |
| ORC-008 | **Medium** | `initializeBlockHeaderOracle` is permissionless, unvalidated and runs outside the Safe bootstrap, so anyone who calls it first controls a fresh deployment's oracle. | **yes** |
| ORC-009 | **Medium** | No limit on questions per settlement height. Resolving them all can exceed Base's per-transaction gas cap (2^24 gas), so that height can never be submitted. | Cap: **yes**. Resumable queue: **no** |
| ORC-010 | **Low** | Remaining differences from Bitcoin consensus: a timestamp equal to the median passes, no future-timestamp limit, `<` instead of `<=` in the PoW check, malformed `nBits` not rejected. | **yes** |
| ORC-011 | **Info** | `submitBatchBlocks([])` reverts with a bare `Panic(0x11)` (confirmed). | **yes** |

---

## 2. Findings

### ORC-001: CRITICAL (new, proposed fix: fix): the new header's `nBits` is never validated, PoW is checked against the previous header's self-declared target, and fork choice counts blocks. One block of real work buys unlimited free headers and permanent control of every market resolution.
- **location:**
  - `contracts/libraries/BlockHeaderUtils.sol:21-28`: the target is computed from `currentBlockHeader`, which is the *previous* header (`:25`).
  - `contracts/facets/DoefinV1BlockHeaderOracleFacet.sol:248-263`: `_verifyBlockHeader` never checks `nBits`.
  - `:131-133`: `NewChainNotLonger` compares block counts.
  - `:33-34` and `:52`: retarget "rule 5" is documented but never implemented.
  - Consumers of the forged data: `contracts/libraries/LibOracleAdapter.sol:446-449` (difficulty), `:336-340` (duration), `:405-409` (timestamp map).
- **source:** manual-reviewer · **swc:** SWC-122-class (the data's authenticator, here the PoW, is not fully checked) · **scsvs:** V10.1, V10.2, V10.3, V10.5 · **owasp:** SC02 (oracle manipulation), SC04 (missing input validation) · **upgrade-safe:** the interim mitigation is yes (Replace `DoefinV1BlockHeaderOracle` and `BlockHeaderUtils`). The full retarget rule is no: it needs 1–2 slots carved from `BlockHeaderOracleStorage.__gap` (`LibDoefinStorage.sol:179`). That is compatible with the current layout, but the storage snapshot must be regenerated.
- **description:** A Bitcoin header is valid only if two things hold:
  1. its hash is at or below the target encoded in **its own** `nBits`; and
  2. its `nBits` equals the value the retarget rule requires (unchanged within a 2016-block epoch, recomputed at each epoch boundary).

  The oracle checks neither. `isValidBlockHeaderHash(prev, next)` returns `uint256(next.blockHash) < calculateDifficultyTarget(prev)`. `next.nBits` is stored unchecked and becomes the target for the **next** header. Combined with the count-based fork choice, this means an attacker needs only one header H1 whose hash meets the target of any block in the 17-slot buffer. H1 can declare `nBits = 0x2100ffff`, a target of about 2^256·(1 − 2^-16). Every later header H2…Hn then passes with essentially any nonce, and each can carry any `nBits` and any timestamp at or above the median (there is no upper limit).
- **poc / exploit scenario:**
  1. *Position.* Buy the outcome to be forced, across every open market (DifficultyThreshold, DifficultyRange, MiningDuration, BlockCount).
  2. *One block of work.* Mine H1 with `prevBlockHash = current oracle tip` and `nBits = 0x2100ffff`. It needs `hash(H1) < target(tip.nBits)`, which is one Bitcoin block's worth of work.
     - The attacker's share of the network hashrate does not matter. They mine on whatever block is currently the tip, as honest miners do. A solution stays usable while its parent remains in the buffer (16 blocks, about 160 minutes), so the expected cost is one block of work for any attacker size. During a stall such as the SEC-015 freeze, the window is unlimited.
  3. *Free headers.* Build H2…Hn offline: link each header, choose a nonce in about one try, and pick `nBits` and timestamp height by height to produce the desired answer.
     - Difficulty at each target height T comes from H_T's `nBits`.
     - Durations and block counts come from the chosen timestamps.
  4. *Submit.* Call `submitBatchBlocks([H1..Hn])` (depth 0, or a reorg from any block in the buffer) from any EOA. `_applyChain` settles every height (`:213`). Every question with a settlement height up to f + n resolves **irreversibly** on forged data: `_reportPayouts` runs and the question is popped.
     - `SETTLEMENT_DELAY = 6` costs the attacker six more free headers.
     - Questions in the future can be resolved immediately by running the fake chain ahead. For example, about 2,000 free headers reach the next retarget boundary. That is about 15 transactions at ~16.7M gas each on Base, a negligible cost.
  5. *Lock-out.* Once n ≥ 17, the fork point leaves the buffer and the honest chain reverts `CannotFindForkPoint`. Before that, it already loses `NewChainNotLonger`, because the attacker can extend for free. The attacker keeps the oracle until the Safe performs a `diamondCut`, and can resolve or freeze every future market.
  6. *Cash out.* `redeemPositions` (`ConditionalTokensFacet.sol:150`) is not gated by the pause, so redemption is immediate.
  - **Attacker cost:** about one Bitcoin block of SHA-256d work. At the current difficulty (140.58T, retarget at height 971712 in October 2026) that is about 6.0·10^23 hashes. Its opportunity cost equals one block's revenue: the 3.125 BTC subsidy plus fees, roughly **3.1–3.2 BTC** (in USD, ≈ 3.2 × the BTC price).
    - Exception: forcing a **higher**-than-real difficulty at T also requires header T+1 to meet that fake target. That costs about D_fake/D_real more blocks; one such header serves every question at height T.
    - Forcing a lower difficulty, or any duration or count outcome, is free after H1.
  - **What a correct oracle would cost:** with `nBits` enforced and fork choice by cumulative work, forging a 6-confirmation resolution means out-mining the honest network over at least 7 blocks. That requires majority hashrate, or winning a minority race (Nakamoto's formula for q = 10%, z = 6 gives about 0.02%).
  - **Regression PoC (can run on a CPU; I did not run it):**
    1. On a fresh Diamond, `initializeBlockHeaderOracle` with 17 linked headers mined at `nBits = 0x1f00ffff` (about 65k double-SHA256 each in JS).
    2. Create a DifficultyThreshold question at `T = tip + 3` with a threshold below that difficulty, so the honest answer is YES.
    3. Mine H1 against the `0x1f00ffff` target while declaring `nBits = 0x2100ffff`.
    4. Append H2…H20 using the first passing nonce each.
    5. `submitBatchBlocks` and assert the condition resolved **NO** (difficulty at T is 0).
    6. Mine an honest `0x1f00ffff` chain of 20 headers from the same fork and assert it reverts (`NewChainNotLonger`, then `CannotFindForkPoint`).
- **impact:** Every market loses its integrity. The attacker chooses all outcomes, takes the collateral counterparties posted, and keeps permanent control of resolution (or can freeze it). The cost is about 3.2 BTC once, for unlimited markets. **Critical:** there is no trust assumption, it is permissionless, and it targets a live mainnet oracle holding real collateral. It is profitable whenever extractable open interest exceeds about 3.2 BTC (open interest not determined; see §8). Pausing trading does not help, because resolution and redemption are not pause-gated.
- **recommendation:**
  - **Immediate (facet Replace, no storage change):**
    - (a) Restrict `submitNextBlock` and `submitBatchBlocks` to the settlement operator or a dedicated submitter role. The block-indexer already submits from the operator wallet. This closes the cheap permissionless route until (b)–(e) ship, at the cost of liveness depending on that key, so allow the owner Safe as a second submitter.
    - (b) Enforce `nBits` continuity: if `next.blockNumber % 2016 != 0`, require `next.nBits == prev.nBits`. At a boundary, as an interim rule, require the new target to lie within `[prevTarget/4, prevTarget*4]` and to be at or below `powLimit`.
    - (c) Check PoW against the block's **own** target: `uint256(next.blockHash) <= decodeTarget(next.nBits)`. This also fixes ORC-002. **Never ship (c) without (b):** own-target PoW with unchecked `nBits` makes the attack completely free.
    - (d) Add a future-timestamp limit and use a strict median check (ORC-010).
    - (e) Choose forks by cumulative work, not length: compare `Σ work(nBits)` over the new segment against the replaced buffer slots f+1…cur, with `work = ~target / (target + 1) + 1` (Bitcoin's `GetBlockProof`). All inputs are already in the buffer or in calldata.
  - **Full fix (needs storage):**
    - Store the epoch-start timestamp(s) in `BlockHeaderOracleStorage.__gap`. Bootstrap them in the cut's `_init` from public data; the Safe already holds full trust through `diamondCut`.
    - At `h % 2016 == 0`, require `next.nBits == GetCompact(retarget(prevTarget, prev.timestamp − epochStartTimestamp))`. Follow Bitcoin's `pow.cpp`: clamp the timespan to [1,209,600/4, 1,209,600·4], compute `newTarget = oldTarget·actual/1,209,600`, cap at `powLimit`, and reproduce `GetCompact` rounding exactly.
    - Restore the previous epoch start when a reorg crosses a boundary.
    - Once this ships, lifting gate (a) is safe again.
  ```solidity
  function _verifyBlockHeader(BlockHeader memory prev, BlockHeader memory next) internal view {
      if (next.prevBlockHash != prev.blockHash) revert Errors.BlockHeaderOracle_PrevBlockHashMismatch();
      if (next.timestamp <= medianBlockTime() || next.timestamp > block.timestamp + 2 hours)
          revert Errors.BlockHeaderOracle_InvalidTimestamp();
      if (next.blockNumber % 2016 != 0) {
          if (next.nBits != prev.nBits) revert Errors.BlockHeaderOracle_InvalidTargetNBits();
      } else {
          _checkRetarget(prev, next); // interim: 4x clamp + powLimit; full: exact Bitcoin retarget
      }
      uint256 target = BlockHeaderUtils.decodeTarget(next.nBits); // rejects sign/overflow/zero/>powLimit
      if (uint256(next.blockHash) > target) revert Errors.BlockHeaderOracle_InvalidBlockHash();
  }
  ```
  (`next.blockNumber` is already assigned before verification on both paths: `:98` and `:202`.) Add fuzz invariant INV-ORC-2 (§5).

### ORC-002: HIGH (new, proposed fix: fix): checking PoW against the previous epoch's target rejects the honest first block of every lower-difficulty epoch, freezing the oracle with probability equal to the size of the drop
- **location:** `contracts/libraries/BlockHeaderUtils.sol:21-28`; `contracts/facets/DoefinV1BlockHeaderOracleFacet.sol:260`
- **source:** manual-reviewer · **swc:** SWC-123 (requirement stricter than the real rule) · **scsvs:** V10.2 · **owasp:** SC10 (DoS), SC03 (logic error) · **upgrade-safe:** yes (part of ORC-001's interim fix)
- **description:** The first header of epoch E (height E·2016) is checked against the target of header E·2016 − 1, which belongs to the *old* epoch.
  - When difficulty **drops**, the target rises.
  - An honest block's hash is uniform on [0, newTarget].
  - It therefore fails `hash < oldTarget` with probability `1 − oldTarget/newTarget = 1 − D_new/D_old`.
  - The rejected block is the canonical one, and no other block can replace it. A batch replay hits the same check. The oracle freezes permanently, as in SEC-015.
- **poc (real Bitcoin mainnet data, from mempool.space; I did not run it):**
  - Block **689471** has `bits = 386801401 = 0x170e1ef9`, so its target has mantissa `0x0e1ef9` at exponent 0x17.
  - Block **689472** is the first block after the −27.94% adjustment of 2021-07-03. Its hash is `0x000000000000000000124347f70edac39e58d972c79086d860929baf07e455aa`, so its mantissa at the same exponent is `0x124347`.
  - `0x124347 > 0x0e1ef9`, so `isValidBlockHeaderHash(689471, 689472)` is false and `submitNextBlock` reverts `BlockHeaderOracle_InvalidBlockHash`.
  - The block is valid on Bitcoin: its own target (bits `0x171398ce`, mantissa `0x1398ce`) is above its hash.
  - Regression test: `initializeBlockHeaderOracle(headers(689455..689471), 689455)`, then `submitNextBlock(689472)`. It reverts today and must succeed after the fix.
- **exposure on mainnet:**
  - Since the Diamond went live (2026-05-25) there have been five downward adjustments: 953568 (−10.09%), 957600 (−5.00%), 959616 (−0.74%), 963648 (−1.31%), 969696 (−0.03%). The chance that at least one froze the oracle was **≈ 16.4%**. The oracle survived all five, by luck.
  - Over the last 16 adjustments (941472–971712, about 7.5 months, 8 of them downward) the chance is about 26%.
  - Block 935424 (−11.16%, 2026-02-07) passed with only about 1% headroom (computed from the published difficulties).
  - The next adjustment is at **973728, expected around 2026-10-29**.
- **impact:** Liveness of the whole protocol. No market resolves on any later block until the Safe performs a `diamondCut`, and markets whose answers become public during the freeze remain tradable (ORC-006). **High**, the same rating as SEC-015.
- **recommendation:** Ship ORC-001 (b) and (c) together: PoW against the block's own target, plus `nBits` continuity and the boundary clamp. Prepare the Replace in advance of block 973728 and every later boundary, and watch the difficulty estimate on `mempool.space`. Add the 689471→689472 test.

### ORC-003: HIGH (new, proposed fix: fix): MiningDuration resolution reverts inside block submission, freezing the oracle permanently. `blockCount ≥ 11` reads outside the 17-slot buffer, and `endBlock.timestamp < startBlock.timestamp` underflows (a miner can trigger it at no cost when `blockCount ≤ 5`).
- **location:**
  - `contracts/libraries/LibOracleAdapter.sol:334-355`: buffer reads at `:336-337`, subtraction at `:340`.
  - `:454-461`: `OracleAdapter_BlockNotInBuffer`.
  - `contracts/libraries/LibConditionMetadata.sol:194`: allows 1 to 2016 blocks.
  - `contracts/libraries/LibDoefinStorage.sol:24`: `MAX_BLOCK_COUNT = 2016`.
  - The revert propagates through `DoefinV1BlockHeaderOracleFacet.sol:108` and `:213`.
- **source:** manual-reviewer · **swc:** SWC-101 (underflow), SWC-113 (DoS from a failing call), SWC-116 (block timestamps) · **scsvs:** V10.5 · **owasp:** SC10, SC04, SC08 · **upgrade-safe:** yes (Replace `DoefinV1BlockHeaderOracle` and `ConditionManagerFacet`; both include the internal libraries)
- **description:**
  - **Out-of-buffer read.** Resolution runs at `S = start + blockCount + 6` and reads the start header through `_getBlockHeaderByNumber`. That function reverts when `start <= S − 17`, which means whenever `blockCount ≥ 11`. Validation allows up to 2016 blocks; the constant is even described as "1 difficulty adjustment period". A revert in `settleCondition` reverts `submitNextBlock` / `submitBatchBlocks` for height S, so the canonical block at S can never be accepted.
  - **Underflow.** `endBlock.timestamp - startBlock.timestamp` is checked arithmetic and panics with 0x11 when the end timestamp is earlier. Bitcoin only requires a timestamp above the median of the previous 11 blocks, which is about `t_{end−6}`.
    - For `blockCount ≤ 5`, the miner of block `end` can pick a timestamp below `t_start` at no cost; the block is still valid on Bitcoin.
    - Out-of-order timestamps also happen naturally.
  - Only `6 ≤ blockCount ≤ 10` is safe.
- **poc:**
  - `test/unit/LibOracleAdapter/LibOracleAdapter.coverage.test.js:277-292` already shows `blockCount = 11` reverting `OracleAdapter_BlockNotInBuffer`, but treats the revert as expected behaviour. In production it is an oracle freeze.
  - End to end: a market maker creates `MiningDuration(start = cur+1, blockCount = 144, buckets)`, i.e. "how long to mine one day of blocks". Feed canonical headers. The header at `cur + 1 + 144 + 6` reverts forever.
  - Underflow: use `blockCount = 1` and give the end header a timestamp of median + 1 that is below `start.timestamp`. The result is `Panic(0x11)`.
  - The only end-to-end MiningDuration test uses `blockCount = 2` (`test/integration/OracleAutoResolution.test.js:322`).
- **impact:** Any natural MiningDuration market (11 blocks or more), or any miner (5 blocks or fewer), halts the oracle for **all** markets until the Safe performs a `diamondCut`. The question cannot be removed, because `cancelCondition` does not deregister it. In practice the market-maker role holds a kill switch over the oracle. **High.**
- **recommendation:**
  1. Read `oracleAdapterStorage.blockHeightToTimestamp[start]` and `[end]` (`LibOracleAdapter.sol:405-409`) instead of the ring buffer. These are written for every accepted header and rewritten on reorg replay. As a stopgap, cap validation at `blockCount <= NUM_OF_BLOCK_HEADERS - SETTLEMENT_DELAY - 1` (= 10).
  2. Compute `duration = endTs > startTs ? endTs - startTs : 0`.
  3. Require `blockCount >= 6`, or bucket widths of at least 2 hours, to limit miner manipulation of timestamps.
  4. Defense in depth: resolvers must never revert header acceptance. On failure, emit `QuestionResolutionFailed(questionId)` and set the question aside for a manual path.

### ORC-004: HIGH (new, proposed fix: fix): BlockCount questions cannot resolve correctly. The exact-second timestamp lookup reverts about 99% of the time, freezing the oracle; otherwise the 600-second bucket gate leaves at least 37% of questions never resolved. Resolution has zero confirmations and the miner controls the timestamp.
- **location:**
  - `contracts/libraries/LibOracleAdapter.sol:89-120`: questions are registered under the bucket of `endTimestamp`; the comment at `:98` says "no settlement delay".
  - `:229-247`: only the bucket of the current header is examined.
  - `:299-330`: timestamp lookups at `:303-312`; `endBlockHeight - startBlockHeight` at `:315`.
  - `:414-441`: `_findBlockByTimestamp` tries only 21 exact-second keys, `target ± 60·k` for k ≤ 10, i.e. **±10 minutes**. The comment at `:423` says "±100 minutes".
  - `contracts/libraries/LibConditionMetadata.sol:139-175`.
- **source:** manual-reviewer · **swc:** SWC-113, SWC-116, SWC-101 · **scsvs:** V10.5 · **owasp:** SC10, SC03 · **upgrade-safe:** disabling creation is yes; a redesign is no (it needs a pending-question cursor)
- **description:**
  - **(a) Lookup.** `timestampToBlockHeight` is keyed by exact block timestamps. A Bitcoin block matches one of the 21 keys only if its offset from the target is a multiple of 60 seconds. With about 2 blocks within ±10 minutes, the chance of a hit is about 3%.
    - `startTimestamp` must be in the future when the question is created (`:154`), so it cannot be set equal to a block timestamp.
    - So once a question triggers, about 97% of start lookups revert `OracleAdapter_BlockNotFoundForTimestamp`; the end lookup fails similarly. The triggering canonical header can then never be accepted, which freezes the oracle.
  - **(b) Trigger.** A question is only looked at when the current header's timestamp falls in the same 600-second bucket as `endTimestamp` and is at or after it, i.e. in `[end, bucketStart(end) + 600)`. That window is at most 600 seconds.
    - The chance that no header lands there is at least e^−1 ≈ 37%, and higher if `end` falls mid-bucket.
    - Bitcoin timestamps also jump backwards and forwards.
    - A question that is missed is never examined again, so it never resolves. Its collateral stays locked except through `mergePositions` of complete sets.
  - **(c) Manipulation.** Resolution fires on the first header whose timestamp reaches `end`, with zero confirmations.
    - Bitcoin accepts timestamps up to 2 hours ahead, so any miner can fire resolution up to 2 hours early, choosing the exact second needed for the lookup to succeed.
    - A routine 1-block reorg can change the answer after it is final.
    - The oracle itself has no future-timestamp limit (ORC-010).
  - **(d) Underflow.** `endBlockHeight - startBlockHeight` underflows when the matched start block is higher than the matched end block. This is possible for short windows with out-of-order timestamps, and causes a freeze.
  - **(e) Stale entries.** Timestamps from orphaned blocks remain in `timestampToBlockHeight` after a reorg.
- **poc:** Create `BlockCount(start = now + 3600, end = start + 86400, [100, 144, 160])`. Feed canonical headers. At the first header with a timestamp in `[end, bucket + 600)`, resolution reverts `BlockNotFoundForTimestamp` unless some header's timestamp happens to be a multiple of 60 seconds away from `start`, within ±600 seconds. The coverage tests hide (a) because they seed the map with exact keys (`LibOracleAdapter.coverage.test.js:92, 149, 163`). No end-to-end BlockCount test goes through `submitNextBlock`.
- **impact:** Every BlockCount market either never resolves (funds locked) or, far more likely once triggered, freezes the oracle for all markets. **High.** Any miner can bias the markets that do resolve.
- **recommendation:**
  - Now: reject `QuestionType.BlockCount` in `createConditionWithMetadata` (Replace `ConditionManagerFacet`), and confirm that no BlockCount question is pending on mainnet (§8).
  - Before re-enabling, redesign:
    - Drive resolution off the 11-block median time (monotonic), not raw timestamps.
    - Record `startHeight` and `endHeight` as the first headers whose median time reaches `start` and `end`.
    - Keep a cursor so no bucket is skipped.
    - Wait `SETTLEMENT_DELAY` confirmations.
    - Never revert inside settlement.

### ORC-005: MEDIUM (new, proposed fix: fix): `_resolveConditionsAtTimestamp` removes the **last** array element, not the one it resolved
- **location:** `contracts/libraries/LibOracleAdapter.sol:238-245`
- **source:** manual-reviewer · **swc:** — (logic error) · **scsvs:** V10.5 · **owasp:** SC03 · **upgrade-safe:** yes
- **description:** The loop resolves `blockCountQuestions[i-1]` when `timestamp >= endTimestamp`, then calls `blockCountQuestions.pop()`, which removes the **last** element. If a later element was skipped because its `endTimestamp` is still in the future:
  - that skipped question is deleted without being resolved; and
  - the resolved question stays in the array. The next header in the same bucket whose timestamp reaches its `end` re-resolves it, `_reportPayouts` reverts `ConditionAlreadyResolved` (`LibCTFCondition.sol:224-226`), and the oracle freezes.
- **poc:**
  1. Push Q0 (`end = B+300`) and then Q1 (`end = B+500`) into the same bucket B.
  2. A header with timestamp B+400 resolves Q0 and pops Q1, which is lost.
  3. The next header with a timestamp in `[B+300, B+600)` reverts.

  To isolate this from ORC-004(a), seed the timestamp lookups as the coverage harness does.
- **impact:** A market silently loses its resolution (its funds stay locked), and there is a second route to freezing the oracle. **Medium:** only BlockCount is affected, and ORC-004 hides it today.
- **recommendation:** Swap the last element into the resolved slot, then pop: `uint256 last = len - 1; if (i - 1 != last) blockCountQuestions[i - 1] = blockCountQuestions[last]; blockCountQuestions.pop();`. The loop runs downward, so the moved element has already been examined. Alternatively, fold this into the ORC-004 redesign.

### ORC-006: MEDIUM (new, proposed fix: fix): difficulty and duration markets can be created with an already-decided answer; oracle lag widens the window, and trading is not halted on-chain
- **location:**
  - `contracts/libraries/LibConditionMetadata.sol:102-104`, `:120-122`, `:191-193`.
  - `contracts/facets/ConditionManagerFacet.sol:65`, which validates against the oracle's height.
  - The trading gate `SettlementFacet._validateOrder` (`SettlementFacet.sol:389-390`) blocks only cancelled or resolved conditions.
- **source:** manual-reviewer · **swc:** — · **scsvs:** V10.5 · **owasp:** SC04 · **upgrade-safe:** the creation rule and freshness check are yes; an on-chain trading cutoff is no (it needs a new per-condition field)
- **description:** Validation only requires `targetBlockHeight > currentBlockHeight`, where `currentBlockHeight` is the oracle's height. On Bitcoin mainnet `nBits` is the same for all 2016 blocks of an epoch. It is fixed once block `⌊T/2016⌋·2016 − 1` is mined, because the retarget uses the timestamps of that block and of the epoch's first block.
  - **Already decided.** If the tip is already inside T's epoch, or at its last block, the answer is known when the market is created.
  - **Oracle lag.** The check uses the oracle's height. During SEC-015 (2026-09-15 to 09-23) the oracle sat at 967143 while Bitcoin moved about 1,150 blocks ahead, and the 967680 adjustment happened during the stall. Targets and MiningDuration start heights that Bitcoin had already mined still passed validation.
  - **Trading stays open.** Resolution happens at T + 6, and the on-chain gate blocks only resolved or cancelled conditions. Markets therefore stay tradable on-chain after the outcome is public: for at least the ~1-hour `SETTLEMENT_DELAY`, and for the whole outage during a stall. Informed takers can fill resting signed orders. The only control is the off-chain operator.
- **evidence:** `scripts/admin-scripts/4b-create-condition-with-metadata.js:42-43` creates `T = 950905` with a threshold of 125T, commented "well under current 136.61T → resolves YES". Height 950905 is in epoch 471 (949,536–951,551, whose difficulty of 136.607T was set at 949,536), so the outcome was fixed when the market was created.
- **impact:** Uninformed traders and makers lose to informed counterparties. Creating markets needs the market-maker role and matching is done by the operator. **Medium.**
- **recommendation:**
  - **Safe rule.** Let `E = ⌊T/2016⌋`. The outcome is still undecided only while the Bitcoin tip h* < `E·2016 − 1`, equivalently `⌊(h*+1)/2016⌋ < E`.
  - **On-chain:** `if ((currentBlockHeight + 1 + LAG_MARGIN) / 2016 >= targetBlockHeight / 2016) revert`.
  - **Freshness:** add `block.timestamp <= latestHeader.timestamp + MAX_ORACLE_STALENESS` (for example 3 hours) so markets cannot be created while the oracle is stale.
  - **Target choice:** prefer `T = E·2016`, the first block of an epoch.
  - **MiningDuration:** require `startBlockHeight > currentBlockHeight + LAG_MARGIN`, plus the same freshness check.
  - **Trading cutoff:** off-chain, close difficulty markets at `E·2016 − 2` and duration markets at `start − 1`. Ideally also enforce a per-condition `tradingCutoffHeight` in `_validateOrder`, which needs a new EIP-7201 namespace.
  - Note that "undecided" is not the same as "unpredictable": late in an epoch the next difficulty can be forecast to within about 1%.

### ORC-007: LOW (new, proposed fix: fix): deep-reorg replays use a corrupted median-time window (confirms and refines SCRUM-521-DEEP-REORG-MTP)
- **location:** `contracts/facets/DoefinV1BlockHeaderOracleFacet.sol:160-175` (window), `:146-156` and `:197-215` (replay), `:256` (check)
- **source:** manual-reviewer · **swc:** SWC-123 · **scsvs:** V10.3, V10.5 · **owasp:** SC10 · **upgrade-safe:** an explicit depth cap is yes; a larger timestamp window is no
- **description:** After rewinding by depth d, the replay of block f+j uses an 11-entry window covering heights f+j−1 down to f+j−11. That window contains s = max(0, d − j − 5) wrapped slots still holding orphans (heights f+7…f+d) that have not yet been overwritten. Orphan timestamps are later than the real ones, so the median moves s blocks later. The cases:

  | Depth d | Median for the first replayed block | Outcome for the canonical chain |
  |---|---|---|
  | ≤ 6 | exact | accepted |
  | 7–10 | still a real entry, but newer | rejected only on unusual timestamps |
  | 11 | `t_f` | rejected whenever `t_{f+1} < t_f` |
  | ≥ 12 | an orphan's timestamp, about 60+ minutes after `t_f` | rejected `InvalidTimestamp` almost always |

  The rejection is permanent. The oracle stays on the orphaned chain, and the fork point stays in the buffer, but the replay can never pass. So the effective maximum honest reorg depth is about 10–11, not 16. The corruption only makes the check stricter for honest forks; nothing invalid gets accepted.
- **impact:** An honest Bitcoin reorg 12 or more blocks deep would freeze the oracle permanently; none has happened since 2013.
  - Related, for V10.5: `SETTLEMENT_DELAY` waits for 6 descendants. A reorg of depth 7 to about 11 *after* resolution leaves the condition resolved on orphaned data, irreversibly. The off-chain DB rollback (`orderbook-service` reorg handler) would then disagree with the chain.
  - **Low.**
- **recommendation:** Make the limit explicit: revert `ReorgTooDeep` when d > 6 and give operators a runbook for that case. Alternatively, compute the median only from verified entries by keeping a separate timestamp ring of at least 27 entries in a new EIP-7201 namespace. Extend `OracleReorgIndexUnderflow.test.js` to d = 7, 11, 12 and 16 with the expected outcomes written down.

### ORC-008: MEDIUM (new, proposed fix: fix): `initializeBlockHeaderOracle` is permissionless, unvalidated, and runs outside the Safe bootstrap, so whoever calls it first controls a fresh deployment's oracle
- **location:** `contracts/facets/DoefinV1BlockHeaderOracleFacet.sol:69-91`; `scripts/deploy-safe-owned.js:221-278` (the MultiSend does not initialize the oracle); `scripts/seed-oracle.js:4-5`, `:55`
- **source:** manual-reviewer · **swc:** — (unprotected initializer) · **scsvs:** V10.4 · **owasp:** SC01 · **upgrade-safe:** yes
- **description:**
  - The only guard is `currentBlockHeight != 0`. After the Safe runs the cut, `seed-oracle.js` initializes the oracle from an EOA in a separate, later transaction. Base has no public mempool, so this is a back-run rather than a front-run, but it is still easy for anyone watching for the cut.
  - Initialization checks nothing about the 17 headers: not their linkage, their PoW, or their `nBits`. The caller chooses the baseline target that every later PoW check builds on.
  - By design there is no re-init or reset. A hijacked initialization can only be undone by a `diamondCut` whose `_init` rewrites storage, or by redeploying.
- **impact:**
  - For a fresh deployment (the documented model), the attacker owns the oracle from the start: free headers, and honest headers never link. Operators can catch this before markets open only if they check.
  - The **mainnet Diamond is not exposed**: it is already initialized, and the buffer has since been fully replaced by honest headers.
  - **Medium.**
- **recommendation:**
  - Require `LibDiamond.enforceIsContractOwner()` and put the initialization in the Safe MultiSend so it is atomic with the cut.
  - Validate the 17 headers: `h[i].prevBlockHash == hash(h[i-1])`, PoW against each header's own target, and `nBits` continuity.
  - Take the epoch-start data needed by ORC-001's full fix as initialization parameters.

### ORC-009: MEDIUM (new, proposed fix: fix): no limit on questions per settlement height; resolving them all in the header's transaction can exceed Base's 16,777,216-gas per-transaction cap, so that height can never be submitted
- **location:** `contracts/libraries/LibOracleAdapter.sol:199-225` (everything at a height resolves in one transaction), `:33`, `:64`, `:142` (unbounded `push`); `contracts/facets/ConditionManagerFacet.sol:49-126` (no per-height limit)
- **source:** manual-reviewer · **swc:** SWC-128 · **scsvs:** V10.5 · **owasp:** SC10 · **upgrade-safe:** a cap is yes; a resumable queue is no (it needs a cursor slot)
- **description:**
  - Base enforces EIP-7825's per-transaction cap of 2^24 gas (the Azul upgrade; the previous cap was 25M).
  - Per-resolution cost is **an estimate, not measured**: about 60–120k gas for a binary threshold question (cold reads, two payout slots, the denominator, an event, a 4-slot pop), and about 150–250k for a 10-bucket range question.
  - So roughly 70 to 250 questions at a single settlement height make the canonical header impossible to submit.
  - Market makers can create questions cheaply on Base and cannot remove them.
- **impact:** A compromised or runaway market maker can freeze the oracle. As the product adds many strikes around each epoch boundary, the safety margin shrinks. **Medium.**
- **recommendation:** Cap the total number of questions per settlement height across the three arrays when they are created (for example 50, confirmed with a gas test). Better still, decouple header acceptance from resolution with a permissionless `resolvePending(height, max)` and a cursor.

### ORC-010: LOW (new, proposed fix: fix): remaining differences from Bitcoin consensus in header checks and target decoding
- **location:**
  - `DoefinV1BlockHeaderOracleFacet.sol:256`: `<` accepts a timestamp equal to the median (Bitcoin requires it to be greater).
  - No upper timestamp limit (Bitcoin: at most network-adjusted time + 2 hours).
  - `BlockHeaderUtils.sol:27`: `<` where Bitcoin uses `<=`.
  - `BlockHeaderUtils.sol:114-123`: the sign bit `0x00800000`, exponent overflow (silently truncated by `<<`), and zero or above-`powLimit` targets are not rejected.
- **source:** manual-reviewer · **swc:** SWC-116 · **scsvs:** V10.1 · **owasp:** SC04 · **upgrade-safe:** yes
- **impact:** The oracle accepts headers that Bitcoin rejects. This matters mostly for ORC-001's fix (the timestamp-manipulation attack at a retarget needs the future limit) and for timestamp-based markets. **Low.**
- **recommendation:** Fold this into ORC-001 (d). Implement `decodeTarget` to mirror Bitcoin's `SetCompact` and `DeriveTarget`: reject negative, overflowing, zero, and above-`powLimit` targets.

### ORC-011: INFORMATIONAL (new, proposed fix: fix): `submitBatchBlocks([])` reverts with a bare `Panic(0x11)`
- **location:** `contracts/facets/DoefinV1BlockHeaderOracleFacet.sol:128`
- **source:** manual-reviewer (confirms PR #26 CR-triage OOB-2) · **swc:** SWC-101 · **scsvs:** V10.3 · **owasp:** SC08 · **upgrade-safe:** yes
- **description:** Confirmed. `newBlockHeaders[newBlockHeaders.length - 1]` computes `0 - 1` in checked arithmetic and reverts `Panic(0x11)` before any index access, so the code is not `0x32`. No state changes. The block-indexer matches errors by named selector (for example `NewChainNotLonger` = `0x2cb8a30d`), and in monitoring a bare arithmetic panic looks the same as a SEC-015-class fault.
- **recommendation:** Add `if (newBlockHeaders.length == 0) revert Errors.BlockHeaderOracle_EmptyBatch();` as the first statement (a new error).

---

## 3. Answers to the five explicit checks

1. **`submitBatchBlocks([])`.** Confirmed as `Panic(0x11)` from `length - 1` (ORC-011).
2. **Markets with a decided answer.** Confirmed (ORC-006). The safe rule is `⌊(h*+1)/2016⌋ < ⌊T/2016⌋`, with h* being the real Bitcoin tip. On-chain, use the oracle height plus a lag margin and a freshness check. When the oracle stalls, its `currentBlockHeight` falls behind, so the check accepts targets and start heights Bitcoin has already mined. This was true during the 8-day SEC-015 stall.
3. **BlockCount and MiningDuration.**
   - The lookup steps in ±60 seconds over ±10 minutes; the comment says ±100 minutes.
   - It requires an exact-second match, and the 600-second bucket gate skips questions (ORC-004).
   - Miners can move timestamps up to 2 hours forward, and the oracle has no future limit at all (ORC-004(c), ORC-010).
   - Reads outside the buffer happen when `blockCount ≥ 11` (ORC-003). Pre-buffer data is never read silently; the read reverts, which freezes the oracle.
   - Both subtractions can underflow: `LibOracleAdapter.sol:315` (ORC-004(d)) and `:340` (ORC-003).
4. **Arithmetic.**
   - There are no `unchecked` blocks in scope.
   - All modulo-17 sites (listed in V10.3) are wrap-safe after SCRUM-521.
   - Remaining checked underflows: `:128` (ORC-011); `LibOracleAdapter.sol:315` and `:340`; `LibOracleAdapter.sol:459` and `LibDoefinBlockHeaderOracle.sol:68` (`currentHeight - 17`, reachable only if initialized at height 0; see Notes).
   - Difficulty is rounded down to an integer (`BASE_DIFFICULTY_TARGET / target`, less than 1 unit at around 10^14, and a tie resolves NO). An exponent of 33 or more silently drops high bits (ORC-010).
5. **Roles and admin paths.** See §4.

## 4. Roles, admin paths, and what each compromised role can do

| Role | Oracle and market power in the current code | Compromise impact |
|---|---|---|
| **Anyone** | Submit headers; call `initializeBlockHeaderOracle` before it is first called. | With one block of PoW (~3.2 BTC), forge every resolution and capture the oracle permanently (ORC-001). Control a fresh deployment's oracle by calling initialization first (ORC-008). |
| **Any Bitcoin miner** (no on-chain role) | Chooses header timestamps within Bitcoin's rules. | Freeze the oracle through a MiningDuration with 5 blocks or fewer (ORC-003). Fire or bias BlockCount up to 2 hours early (ORC-004(c)). Bias duration buckets narrower than about 2 hours. |
| **Operator / block-indexer key** | No on-chain oracle privilege; submission is permissionless. | Can withhold submissions (anyone else can submit instead) or submit stale or orphaned real blocks (anyone can). Adds nothing beyond "anyone" today. If ORC-001 (a) restricts submission, a compromised key controls liveness, and can forge only with real PoW once (b)–(e) ship. |
| **Market maker** (`enforceIsMarketMaker`, `ConditionManagerFacet.sol:56`, `:150`; granted by the owner) | Creates conditions and questions; cannot remove them. | **Has an oracle kill switch:** a MiningDuration with `blockCount ≥ 11`, any BlockCount, or about 100+ questions at one height (ORC-003/004/009). Can create markets with known answers (ORC-006) or markets that never resolve (no upper bound on `targetBlockHeight`; `createCondition(address(this), …)` registers no question). |
| **Condition creator / owner** | `cancelCondition` (`ConditionManagerFacet.sol:197-214`) only clears `active`, which stops trading through `SettlementFacet.sol:389`. | The oracle question remains registered and still resolves. The NatSpec at `:187` says it will not resolve, which is wrong; the actual behaviour is good for holders. |
| **Resolution** | Only `address(this)` through `LibOracleAdapter`. The `conditionId` binds the oracle to the Diamond, and `ConditionalTokensFacet.reportPayouts` derives the oracle from `msg.sender` (`LibCTFCondition.sol:217`). | No external caller can spoof a payout. |
| **Owner (Safe)** | There is no oracle setter, reset or pause. The only way to rewrite oracle state is a `diamondCut` whose `_init` delegatecall runs arbitrary code. | Total control, as already accepted. It is also the **only** way to recover from any freeze in this report. |

## 5. Invariant and PoC candidates (for `DoefinInvariantHarness` / regression tests)

The fuzzing harness has no oracle invariants yet (`security/echidna.config.yaml:17` also leaves the oracle facet out because of the unlinked `BlockHeaderUtils`).

- **INV-ORC-1 (holds today):** after any accepted `submitNextBlock` or `submitBatchBlocks`, `nextBlockIndex < 17`, and for every height h in (cur−17, cur], `getBlockHeaderByNumber(h).blockNumber == h` and links to h−1.
- **INV-ORC-2 (fails today, ORC-001/002):** every header in the buffer satisfies `hash <= target(own nBits)`, and `nBits == prev.nBits` unless `h % 2016 == 0`.
- **INV-ORC-3 (fails today, ORC-003/004/005/009), the liveness property:** for any set of questions that `createConditionWithMetadata` accepts, submitting the canonical next header never reverts.
- **INV-ORC-4 (fails today, ORC-005):** `totalQuestionsResolved + pending == totalQuestionsCreated`, so no question is ever dropped without being resolved.
- **INV-ORC-5 (fails today, ORC-004(b)):** every question whose settlement point the oracle has passed is resolved.
- **INV-ORC-6 (fails today, ORC-010):** no accepted header has `timestamp <= MTP` or `timestamp > block.timestamp + 7200`.
- **PoCs to build:**
  - ORC-001: the CPU-scale chain from the ORC-001 entry, including the honest-chain lock-out.
  - ORC-002: real headers 689455–689472.
  - ORC-003: `blockCount = 144` end to end through `ConditionManagerFacet` and `submitNextBlock`; and `blockCount = 1` with an end timestamp below the start.
  - ORC-004: a BlockCount question triggered by canonical-style headers.
  - ORC-005: two questions in one bucket.
  - ORC-007: replays at d = 7, 11, 12 and 16.
  - ORC-009: a gas sweep over N questions at one height.

## 6. Immediate actions (ordered)

1. **Query mainnet now** for pending BlockCount questions, and for MiningDuration questions with `blockCount ≥ 11` or `≤ 5`. Each will freeze the oracle when it reaches its settlement point.
   - Look for `BlockCountQuestionCreated` and `MiningDurationQuestionCreated` events on `0x71C4…Fdf9`.
   - Call `getDurationQuestionsAtBlock(h)` for upcoming heights.
2. **Replace `ConditionManagerFacet`:**
   - reject BlockCount;
   - allow MiningDuration only for `6 ≤ blockCount ≤ 10`, until ORC-003 (1) ships;
   - add the epoch rule and freshness check (ORC-006);
   - add a per-height cap (ORC-009).
3. **Replace `DoefinV1BlockHeaderOracle` and `BlockHeaderUtils`:**
   - ORC-001 (a)–(e), shipped as one unit;
   - the empty-batch error (ORC-011);
   - make `calculateDifficulty` internal, which removes the library link (see Notes).

   **Have this ready before the 973728 adjustment (around 2026-10-29),** because of ORC-002.
4. Implement the full retarget rule (ORC-001, storage from `__gap`), then decide whether to reopen permissionless submission.
5. **Monitor and alert.** Use `scripts/oracle-status.js` to alert when the oracle's height diverges from `mempool.space`. An ORC-001 attack shows up as the oracle **running ahead** of Bitcoin, or failing to link. Also alert on any `BlockReorged` event and on any revert of a submission.

## 7. Verified safe

- **SEC-015 fix:** every ring-index expression is wrap-safe (sites listed in V10.3). `_findForkPoint` is limited to the 17 slots, validates the caller-supplied `blockNumber`, and `parentHeight` cannot underflow. Rewind and replay are consistent: `_findForkPoint` and `submitBatchBlocks` choose the same slot for any depth.
- **Hashes are recomputed:** the block hash is computed on-chain from the 80-byte header (`BlockHeaderUtils.sol:40-60`), and the submitted `blockHash` and `blockNumber` are overwritten (`:97-98`, `:201-202`, `:83-84`). The serialization matches Bitcoin; the real-header SCRUM-521 suite recomputes mainnet hashes 967110–967160.
- **Linkage:** prev-hash linkage is enforced for every header, including every header in a batch (`:252`).
- **Reorg replay:** a successful replay overwrites every orphaned slot (the new chain is longer than the depth). The window is fully canonical afterwards; this is also asserted in `OracleReorgIndexUnderflow.test.js`.
- **Re-init:** impossible after the first initialization.
- **Difficulty reads:** always 6 blocks back, inside the buffer. The formula `0xFFFF·2^208 / target` matches Bitcoin Core's difficulty. The 11-element quicksort and median are correct.
- **Payouts:** for Diamond-oracle conditions they can only be reported by the oracle adapter. `_reportPayouts` rejects a second resolution, and resolved questions are popped (except ORC-005).
- **Reentrancy:** the settlement path makes no external calls apart from the `DELEGATECALL` into the linked `BlockHeaderUtils` (trusted code) and has no ERC-20 or ERC-1155 callbacks, so there is no reentrancy surface.
- **Bucket validation:** buckets are non-empty, strictly increasing, at most 10, and `outcomeSlotCount == buckets + 1`. So `_findBucketIndex` never reaches its final revert for a validated question, and the length of the payout vector matches the prepared condition.
- **Access control:** creating conditions requires the market-maker role on both entry points. Cancellation is limited to the creator or the owner.
- **Tooling:** the old "superseded" exclusions are gone from `.solhintignore`, `security/slither.config.json` and `.solcover.js`. Only the Echidna harness still has no oracle invariants.

## 8. Could not determine

- **Mainnet open interest / TVL.** This sets the economic threshold for ORC-001 (profitable above about 3.2 BTC extractable). I also did not look up the BTC price for a USD figure.
- **Pending questions on mainnet.** Whether any BlockCount questions, or MiningDuration questions with `blockCount ≥ 11` or `≤ 5`, are pending (action 1). If so, a freeze is already scheduled.
- **Market-maker holders on mainnet.** `doefin-backend/security/runs/2026-10-13-reassessment/auditor-package/03-actors-privileges.md` lists them as "TODO(owner)".
- **Direction of the 973728 adjustment.** I did not check the current estimate. A downward move is live ORC-002 exposure.
- **Measured gas per resolution for ORC-009.** My figures are estimates, and I took the activation of Base's 2^24 cap from Base documentation without checking on-chain.
- **Off-chain trading cutoff.** Whether the backend closes markets at the epoch decision point (ORC-006).
- **Nothing was executed.** No test, PoC or tool was run (role constraint). The PoCs above are sketches. The ORC-002 figures (bits and hashes) come from `mempool.space` and were computed by hand.

## 9. Notes (style and hygiene; not security findings)

- **Interface drift:** `IOracleAdapter` declares `reportOutcome` and `linkConditionToFeed`, which no facet implements, and `OracleAdapterFacet` does not implement the interface.
- **External library call:** `BlockHeaderUtils.calculateDifficulty` is `public`, so every difficulty resolution makes an external `DELEGATECALL` into the separately deployed, linked library. Making it `internal` removes the link requirement and lets Echidna include the facet.
- **`BlockReorged(bytes32 merkleRootHash)`:** emits the batch tip's merkle root instead of the fork height and hashes. It also fires on a permissionless re-submission of already-known blocks plus one new block, when no reorg happened. The backend does not consume it today; my grep found no Python consumer. Either keep it that way or change it to `(forkHeight, depth, newTipHash)`.
- **`cancelCondition` NatSpec** (`ConditionManagerFacet.sol:187`) says the condition "won't be resolved"; it will be.
- **`_findBlockByTimestamp` comment** (`LibOracleAdapter.sol:423`) says ±100 minutes; the code covers ±10 minutes.
- **No upper bounds** on `targetBlockHeight`, `startBlockHeight` or `endTimestamp`, so a market can be scheduled to resolve decades out.
- **Init at height 0:** `getBlockHeaderByNumber` and `_getBlockHeaderByNumber` underflow on `currentHeight - 17` when `currentHeight < 17`, which is only reachable by initializing at height 0.
- **Raw slot order:** `getAllBlockHeaders` returns headers in slot order, not chronological order.
- **Stale timestamp map:** `timestampToBlockHeight` keeps orphan entries after reorgs.
- **Legacy `createCondition`:** a market maker can use it to take a pending `createConditionWithMetadata` questionId first, making that call revert `ConditionAlreadyPrepared`.
- **Floating pragma:** `^0.8.20`, pinned to 0.8.20 by the build config.
- **ID collision:** `doefin-backend/security/intel/oracle.md` uses ORC-1…ORC-10 for different items. Mapping:
  - intel ORC-2/3/7 → **ORC-001**
  - intel ORC-5 → **ORC-010** and **ORC-004(c)**
  - intel ORC-6 → V10.5, **ORC-004(c)**, **ORC-007**
  - intel ORC-10 → **ORC-008**
  - intel ORC-1 → V10.1. On its own it is not a defect.
  - intel ORC-4/8/9 are off-chain or informational.

  The intel claim that `SETTLEMENT_DELAY` "is not a confirmation requirement" is wrong for height-based questions, which do wait for 6 descendants, and right for BlockCount, which waits for none. At triage, consider renaming this report's IDs (for example to SEC-016…) to avoid the collision.
- **Stale lens line numbers:** `submitBatchBlocks` :112 → :126; `_verifyBlockHeader` checks :233/:237/:241 → :252/:256/:260; `_findForkPoint` :203 → :222; `_applyChain` :178 → :197.

Sources (external data used for ORC-001/ORC-002): [mempool.space difficulty adjustments (1y)](https://mempool.space/api/v1/mining/difficulty-adjustments/1y), [mempool.space difficulty adjustments (all)](https://mempool.space/api/v1/mining/difficulty-adjustments/all), [block 689472](https://mempool.space/api/block/000000000000000000124347f70edac39e58d972c79086d860929baf07e455aa), [block 689471](https://mempool.space/api/block/00000000000000000009cbc816ab1d430e7a9cc24ffdb6702870112c84a9657c), [Base throughput and limits (per-tx gas cap)](https://docs.base.org/base-chain/network-information/throughput-and-limits), [OP Stack: Osaka on L2](https://docs.optimism.io/op-stack/features/osaka-on-l2).
