# Oracle reorg-replay underflow — production incident data (2026-09-15)

> **Status (SCRUM-521):** fixed in `DoefinV1BlockHeaderOracleFacet.submitBatchBlocks` on this branch.
> Regression suite: `test/integration/OracleReorgIndexUnderflow.test.js` (loads this fixture through
> `scripts/lib/oracle-fixture.js`). Deployment: `scripts/upgrades/upgrade-scrum521-oracle-reorg-underflow.js`
> (single-selector Replace), rehearsed on a mainnet fork by `scripts/upgrades/rehearse-scrum521-fork.js`;
> the held production batch is replayed by `scripts/oracle-replay-batch.js`. Audit ledger: **SEC-015**.

Real Bitcoin block headers that reproduce the state the **Base-mainnet** block header oracle has been
stuck in since **2026-09-15 15:45 UTC**, plus a scenario matrix that places the orphaned block in
**every one of the 17 ring-buffer slots** so the defect (and its fix) can be tested exhaustively.

Related: backend task doc `doefin-backend/docs/smart-contract-task-oracle-reorg-index-underflow.md`
(defect analysis + proposed fix), and `test/data/reorg_test/` (the earlier, single-position reorg
fixture at block 935,497, which never reaches the wrap-around).

## What happened in production

The oracle (`DoefinV1BlockHeaderOracleFacet`, Diamond `0x71C424Ef79819c852952e517c082C4d17f89Fdf9`,
chain 8453) keeps the last 17 headers in a ring buffer with an insertion pointer `nextBlockIndex`.

| UTC (2026-09-15) | Event |
|---|---|
| 15:35:52 | A miner finds Bitcoin block **967143** (`…8e0c9e34…314c`). |
| 15:36:11 | A second miner finds a **competing 967143** (`…895ebcc5…bea37f`). Bitcoin briefly holds both. |
| 15:36:43 | `block-indexer` polls inside that window, gets the *first* 967143, and submits `[967142, 967143]` (tx `0x888d3b61…0ef`, L2 block 51348629). `nextBlockIndex` goes **15 → 0**: the block lands in **slot 16**. |
| ~15:40 | The network settles on the second 967143. The one the oracle holds is now an **orphan**. |
| 15:45:03 | `block-indexer` prepares the depth-1 replay `[967143 canonical, 967144, 967145, 967146]` via `submitBatchBlocks`. Its guard sees `nextBlockIndex = 0 <= depth = 1`, knows the call will panic, holds the batch and logs `CRITICAL … unreplayable_on_chain`. |
| since | Same attempt every 8 min, same result. Tip pinned at the orphan; `getCurrentBlockHeight() = 967143`, `getNextBlockIndex() = 0`. Nothing can be written, so the pointer can never move off 0. |

Staging (Base Sepolia) ran the same code and was at the same slot (16) that day; it simply polled
one minute later, after the race was decided, never stored the orphan, and never needed a replay.

## The defect

`submitBatchBlocks` rewinds to the fork point with checked, unsigned, left-to-right arithmetic:

```solidity
// prev-header lookup
(nextBlockIndex + forkHeight - currentBlockHeight - 1) % NUM_OF_BLOCK_HEADERS
// pointer rewind
(nextBlockIndex + forkHeight - currentBlockHeight) % NUM_OF_BLOCK_HEADERS
```

With `depth = currentBlockHeight - forkHeight` these are `(nextBlockIndex - depth) - 1` and
`nextBlockIndex - depth`, so any replay with **`nextBlockIndex <= depth` reverts with
`Panic(0x11)`**. For the common depth-1 orphan that is `nextBlockIndex ∈ {0, 1}`, i.e. the orphan
sitting in **slot 16 or slot 0** — 2 of 17 positions. No input can route around it: every real
Bitcoin block whose parent is in the buffer yields `depth >= 1`, the linear path needs a child of
the orphan (none exists, and PoW is verified), and there is no reset. Only a facet replacement via
`diamondCut` clears it.

## Files

| File | Contents |
|---|---|
| `blocks-mainchain-967110-967160.json` | 51 canonical headers, 967110–967160, fetched from `mempool.space`. Every hash re-derived by double-SHA256 from the 80-byte header, chain-linked, PoW-checked against the parent's `nBits`, and timestamp-checked against the 11-block median — so the contract's `_verifyBlockHeader` accepts each one. **967143 in this file is the canonical block that replaced the orphan.** |
| `block-967143-orphan.json` | The orphaned 967143, read back from the mainnet contract (`getLatestBlockHeader`) and hash-verified. Not available from public block explorers (mempool.space returns 404 for it). Same `prevBlockHash` as the canonical 967143. |
| `scenarios.json` | 17 scenarios, one per ring slot the orphan can occupy, each with the init window, the main-chain blocks to submit, the replay batch, and the expected outcome before and after the fix. |

All headers use the same field names as the other fixtures
(`blockNumber, blockHash, prevBlockHash, merkleRootHash, version, timestamp, nBits, nonce`) and pass
straight into `initializeBlockHeaderOracle` / `submitNextBlock` / `submitBatchBlocks`.

## Reproducing the state at any slot

`initializeBlockHeaderOracle` always leaves `nextBlockIndex = 0` after writing 17 headers, so the
orphan's slot is set purely by how many blocks are written after init. To put the orphan in slot
`s` (0…16):

1. Initialise with the 17 canonical headers `967126-s … 967142-s` (`initialBlockHeight = 967126-s`).
2. `submitNextBlock` the canonical headers `967143-s … 967142` (that is `s` blocks; none for `s = 0`).
3. `submitNextBlock` the **orphan** 967143. Now `currentBlockHeight = 967143`,
   `nextBlockIndex = (s+1) mod 17`, `getBlockHeaderAt(s)` is the orphan.
4. `submitBatchBlocks([967143 canonical, 967144, 967145, 967146])` — the exact batch production has
   been retrying. `_findForkPoint` resolves `forkHeight = 967142`, `depth = 1`.

`s = 16` is the production incident. Mainnet was at pointer 15 when tx `0x888d3b61…` wrote
`[967142, orphan]` into slots 15 and 16 and wrapped the pointer to 0; here step 2 writes 967142 into
slot 15 (pointer 16) and step 3 writes the orphan into slot 16 (pointer 0) — the same end state.

```js
const main   = require("./blocks-mainchain-967110-967160.json").blocks;
const orphan = require("./block-967143-orphan.json").blocks[0];
const { scenarios } = require("./scenarios.json");
const byH = Object.fromEntries(main.map(b => [b.blockNumber, b]));
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => byH[a + i]);

for (const sc of scenarios) {
  const diamond = await deployDiamond();
  const oracle = await ethers.getContractAt("IDoefinBlockHeaderOracle", diamond);
  await oracle.initializeBlockHeaderOracle(range(sc.init.from, sc.init.to), sc.init.initialBlockHeight);
  for (const b of sc.extendMainChain.count ? range(sc.extendMainChain.from, sc.extendMainChain.to) : [])
    await oracle.submitNextBlock(b);
  await oracle.submitNextBlock(orphan);
  // state: currentBlockHeight 967143, nextBlockIndex (s+1)%17, slot s holds the orphan
  const replay = sc.replayBatch.blocks.map(h => byH[h]);
  await oracle.submitBatchBlocks(replay); // see matrix below
}
```

## Expected results

Verified on the **unfixed** facet (`5891be3`, 2026-09-22): every row below matched. With the SCRUM-521 fix
applied, all 17 slots succeed (the regression suite asserts the "After fix" column, plus depths 2, 3 and 6
at every slot, the negative cases, and the catch-up across the wrap).

| Orphan slot `s` | `nextBlockIndex` at replay | Before fix | After fix |
|---|---|---|---|
| **0** | 1 | **`Panic(0x11)`** | success |
| 1 … 15 | 2 … 16 | success | success |
| **16** *(production)* | 0 | **`Panic(0x11)`** | success |

On success (every slot after the fix; slots 1–15 already today), assert:

- `getCurrentBlockHeight() == 967146`
- `getNextBlockIndex() == (s + 4) mod 17` (rewind to `s`, then 4 headers applied)
- `getBlockHeaderByNumber(967143).blockHash == 0x…895ebcc5…bea37f` (canonical), and
  `getBlockHeaderAt(s)` now holds it — the orphan is gone from the buffer
- `BlockReorged` emitted once

Each scenario in `scenarios.json` carries these numbers in `expectedBeforeFix` / `expectedAfterFix`.

General rule for deeper reorgs (no real data for those — only depth-1 orphans occur in practice and
fabricated headers fail PoW): depth `d` panics whenever `nextBlockIndex <= d`, i.e. `(d + 1) / 17`
of positions. The fix in the task doc (`+ NUM_OF_BLOCK_HEADERS` before subtracting, as
`_findForkPoint` already does) makes every `d < 17` replayable; `d >= 17` must still revert
`CannotFindForkPoint`.

## How this fixture is exercised

`test/integration/OracleReorgIndexUnderflow.test.js` (runs in CI with the full suite):

1. **Fixture sanity** — 967110..967160 is contiguous and linked; the orphan is a sibling of the canonical 967143.
2. **17 slots × depth 1** — the recipe above, then the exact held batch `[967143 canonical, 967144, 967145, 967146]`;
   asserts the "After fix" column (height 967146, `nextBlockIndex = (s+4) mod 17`, canonical 967143 in slot `s`,
   orphan gone, whole 17-slot window linked, `BlockReorged` once).
3. **17 slots × depths 2, 3, 6** — replacement chains anchored deeper (`967144-d .. 967146`, all real headers);
   same post-state. Depth 6 is the deepest whose median-time window is made only of verified predecessors
   (`17 - 6 = 11`); deeper replays hit a separate, pre-existing buffer limitation (`audit/follow-ups.md`
   SCRUM-521-DEEP-REORG-MTP).
4. **Negatives (production state, slot 16)** — equal-length replacement → `NewChainNotLonger`; fork below the
   buffer (anchored at 967127) and a mis-numbered first header → `CannotFindForkPoint`; broken linkage after the
   fork point → `PrevBlockHashMismatch` (rewind no longer panics). State untouched after each revert.
5. **Recovery + catch-up** — replay from the production state, then `submitNextBlock` 967147..967160 and confirm
   the pointer walks 3 → 16 → 0; a depth-0 batch after the replay still takes the plain-extension path.

On the pre-fix facet the suite fails 19 cases, all `Panic(0x11)`: every depth-`d` replay in a slot where
`nextBlockIndex <= d` (16 cases) plus the three cases that depend on a successful replay.
