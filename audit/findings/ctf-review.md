# CTF Review: Conditional Tokens (split / merge / redeem / registry / resolution fee)

**Reviewer:** `sc-manual-reviewer` (manual reading only; no tool, test or PoC was run)
**Date:** 2026-10-19
**Ticket:** SCRUM-214 (fixes `bc40f48`..`6be7c06`, follow-ups from the PR #31 CodeRabbit triage `audit/coderabbit-triage/PR-31.md`; deployment `audit/follow-ups.md` CTF-MAINNET-CUT)
**Branch:** `worktree-agent-a178dfb0cb78d8154` @ `c506fe3` (contracts as on `dev`)
**Deployment context:** live on Base mainnet. Diamond `0x71C424Ef79819c852952e517c082C4d17f89Fdf9` holds the collateral behind every outcome token, and the same ERC-20 balance also holds the SCRUM-236 fee bank.
**Why this review:** the original audit excluded the CTF as "imported from Gnosis CTF" (`audit/00-scope.md:43-45`). It is not a plain import. It runs on Diamond storage, adds internal split/merge variants used by settlement, a resolution fee that accrues into the fee bank, a market registry written by `splitPosition`, and condition cancellation.

**Files read in full:** `contracts/facets/ConditionalTokensFacet.sol`, `contracts/libraries/LibCTFCondition.sol`, `LibCTHelpers.sol`, `LibERC1155.sol`, `LibPositionRegistry.sol`, `LibReentrancyGuard.sol`, `LibDoefinStorage.sol`, `LibAdminConfigStorage.sol`, `LibOracleAdapter.sol`, `contracts/facets/ERC1155Facet.sol`, `ERC1155ReceiverFacet.sol`, `ConditionManagerFacet.sol`, `AdminConfigFacet.sol`, `MarketDataFacet.sol`, `SettlementFacet.sol`, `contracts/interfaces/IConditionalTokens.sol`, plus the relevant parts of `Events.sol`, `LibConditionMetadata.sol` and `contracts/audit/DoefinInvariantHarness.sol`.
**Tests read:** `test/unit/ConditionalTokensFacet/ConditionalTokensFacet.advanced.test.js`, `test/audit/SCRUM-235-cancelled-resolved-condition.test.js`, `test/unit/LibPositionRegistry/LibPositionRegistry.coverage.test.js`, `test/integration/BatchSubmissionBugRepro.test.js`, and the harness drivers `fuzz_split`, `fuzz_merge` and `fuzz_redeem`.
**Consumers read (read-only, to confirm off-chain impact):**
- `doefin-backend/orderbook-service/app/events/event_handler.py:904-1040`
- `doefin-backend/match-engine/app/repositories/match_repository.py:629-728`
- `doefin-backend/api-service/app/services/v3/market_service.py:348-349, 475-522`
- `doefin-frontend/components/Portfolio/UnifiedPortfolioPanel.tsx:113-172`
- `scripts/admin-scripts/5-split-condition.js:179-226`

**Upstream baseline:** `gnosis/conditional-tokens-contracts` master (`ConditionalTokens.sol`, `CTHelpers.sol`, the 1.0.x elliptic-curve version).

> **Bottom line.** The Gnosis core (split/merge/redeem arithmetic, index-set rules, EC collection IDs) was carried over faithfully. The Doefin additions are where it breaks.
>
> **CTF-001 (Critical).** `splitPosition` writes the settlement "market registry" for anyone, first come first served, for any partition including partial ones, and for an amount of **0**. Settlement then treats any 2-entry registry market as a complete binary pair. On a condition with 3 or more outcomes, an attacker registers a *partial* pair for free. After that, every Merge settlement pays out full collateral for an incomplete set, which makes the Diamond insolvent. The attack needs no trust assumption: the backend reads the attacker's `PositionPairsRegistered` event and routes the merges itself.
>
> **CTF-002 (High).** The same free registry write lets anyone choose the outcome order that the backend and frontend use for YES/NO labels, which flips the labels. It also lets anyone map any not-yet-seeded root position ID to a different condition, using a crafted parent collection. That permanently blocks the market and points the SCRUM-235 validity gate at the wrong condition.

---

## 1. Check-by-check verdict

| # | Check | Verdict | Evidence (file:line) | Findings |
|---|---|---|---|---|
| 1 | **Collateral conservation** on every path | **Finding: Critical** | **Public paths conserve collateral, as upstream does:**<br>• split from collateral pulls `amount` and mints `amount` of each part (`LibCTFCondition.sol:97-117`)<br>• split from a parent or union burns the parent (`:107-115`)<br>• merge is the mirror image (`:53-71`)<br>• redeem floors `stake*num/den` (`ConditionalTokensFacet.sol:185`)<br>• settlement Mint collects `takerCollateral + makerCollateral == fillAmount` before splitting (`SettlementFacet.sol:608-634, 660-667`).<br>**Broken:** the internal variants accept **partial** partitions (`LibCTFCondition.sol:164-168, 204-208`). Settlement takes the partition from the registry and never checks that it covers every outcome (`SettlementFacet.sol:884-895`). `_settleMerge` therefore pays `fillAmount` of collateral (`:751-752`) while burning an incomplete set and minting the union position to the Diamond. Settlement also ignores the registry market's parent and collateral (`:656-667, :722-733`). | CTF-001, CTF-003 |
| 2 | **collectionId / positionId derivation** | **Pass, with enabling notes** | **Scheme and collisions:**<br>• It is the upstream 1.0 elliptic-curve scheme: alt_bn128 hash-to-curve plus point addition (`LibCTHelpers.sol:25-72`).<br>• `sqrt` is a generic `expMod` with exponent (P+1)/4. That is correct because P ≡ 3 mod 4. Upstream uses an addition chain instead.<br>• Collisions between distinct `(parent, condition, indexSet)` triples require a discrete-log relation, which is infeasible.<br>• `getPositionId` hashes fixed-length input with `encodePacked(address, bytes32)`, so it is injective.<br>**Upstream properties that the Doefin additions turn into attack tools:**<br>• (a) The parent ID is any curve point, with no proof of how it was derived.<br>• (b) Order independence: `X + H(c,s)` is the same token whichever order the conditions were applied in.<br>• (c) Bit 255 is folded into the parity flag (`:47`). An odd-y parent therefore has three encodings.<br>• (d) Parent `−H(c,s)` gives the identity point, which compresses to `bytes32(0)`.<br>(a) and (b) let anyone obtain root positions without a root split, and aim a crafted parent at any root position ID. | Enables CTF-001, CTF-002 and CTF-004; Notes |
| 3 | **Payout reporting and redemption** | **Finding: Medium** | **Holds:**<br>• The reporter is bound through `conditionId = H(msg.sender, q, n)` (`LibCTFCondition.sol:217`).<br>• A second report reverts (`:224-226, :231-233`).<br>• All-zero payouts revert (`:239-241`).<br>• The denominator sum is checked arithmetic (`:235`).<br>• Redemption rounds down (`ConditionalTokensFacet.sol:185`).<br>• The fee is at most 100% (`AdminConfigFacet.sol:129`), so `amount - feeAmount` cannot underflow (`ConditionalTokensFacet.sol:239-240`).<br>• A dust payout gives a zero fee, which is harmless.<br>**Fails:**<br>• Winners can avoid the resolution fee entirely.<br>• The fee rate is read at redemption time, so changes apply retroactively.<br>• Conditions with an external oracle accept arbitrary vectors (fractional values, numerators large enough to overflow redemption, length 1), and they accept them after cancellation. | CTF-004, CTF-006, CTF-007 |
| 4 | **Cancelled conditions** | **Pass for exits. Finding for unresolvable conditions.** | **What cancellation does:**<br>• `cancelCondition` only clears `active` (`ConditionManagerFacet.sol:212`).<br>• split, merge and redeem never read `active`.<br>• The oracle adapter still resolves the condition, because `LibOracleAdapter.sol:270/291/326/351` has no `active` check.<br>• Holders can therefore always merge complete sets and redeem after resolution. A cancelled condition **can** be resolved later, even though the NatSpec at `:187` says it cannot.<br>**What is missing:** there is no way to void or force-resolve a condition. Collateral of one-sided holders is locked indefinitely when a condition can never be resolved:<br>• legacy `createCondition(address(this), …)`, which registers no question;<br>• BlockCount questions that are skipped or dropped (ORC-004, ORC-005);<br>• a frozen oracle (SEC-015);<br>• an external oracle that disappears. | CTF-005 |
| 5 | **Reentrancy** | **Pass** | **Where the lock is held:**<br>• across public split and merge (`LibCTFCondition.sol:53-71, 96-119`);<br>• around the redeem ERC-20 transfer (`ConditionalTokensFacet.sol:233-235, 257-259`);<br>• in `nonReentrant` settlement (`SettlementFacet.sol:95, 276`). The internal variants run inside that settlement lock.<br>**Why the unlocked parts are safe:**<br>• The redeem burns make no external calls.<br>• The redeem-to-parent `_mint` hook runs after every state change.<br>• ERC-1155 hooks fire after the balance writes (`LibERC1155.sol:60-65, 103-107, 122-128`).<br>**Caveat:** the claim that `sender == address(this)` means "no external calls" is **inaccurate**. `_batchMint`/`_mint` to the Diamond make a self-call to `onERC1155(Batch)Received` (`LibERC1155.sol:166-168, 180-185`). This is harmless today. | CTF-008 (Low) |
| 6 | **Access control, parameter validation, events** | **Finding: High** | **Access control holds:**<br>• `prepareCondition` is owner-only (`ConditionalTokensFacet.sol:45`).<br>• Payouts are bound to the oracle.<br>• split, merge and redeem act only on `msg.sender`'s own balances.<br>**Missing validation:**<br>• `splitPosition` accepts `amount == 0`, any partition and any parent, and on every call it writes the registry consumed by settlement and the indexer (`LibCTFCondition.sol:94`; `LibPositionRegistry.sol:103-158`).<br>• Legacy `createCondition` lets a market maker choose any resolver (`ConditionManagerFacet.sol:144-167`).<br>**Events:** the gaps are listed in Notes. | CTF-002, CTF-006 |
| 7 | **Settlement interaction (Diamond as holder)** | **Finding: Critical** | **How settlement calls the CTF:**<br>• `_settleMint` and `_settleMerge` call the internal split/merge with `sender = address(this)` and `parent = 0` (`SettlementFacet.sol:660-667, 726-733`).<br>• They use the registry's partition (`:884-925`), but neither its parent nor its collateral.<br>**Normal case:** with a binary, root, same-collateral market, the Diamond's position balance nets to zero and INV-SOLV-4 holds.<br>**Failure cases:**<br>• With a partial registry partition, collateral backing other users goes to the attacker (CTF-001).<br>• With a nested or cross-collateral registry market, the Diamond's own ERC-1155 balance (donated, or accumulated by CTF-001) is used as settlement inventory (CTF-003).<br>• The fee bank shares the same balance, so a drain also drains `accruedFees`. | CTF-001, CTF-003 |
| 8 | **Storage** | **Pass** | **Who writes what:**<br>• CTF payout storage is written only in `LibCTFCondition` (`:34, :234, :242`).<br>• `conditions[]` is written only in `ConditionManagerFacet` (`:77, :157, :212`).<br>• Balances only through `LibERC1155`; the registry only through `LibPositionRegistry`.<br>• Outside contracts that write this storage are only mocks or the harness, which are out of scope.<br>**Gaps and layout:**<br>• Sub-struct gaps exist (`LibDoefinStorage.sol:103, 110, 142, 184`).<br>• `Condition` and `MarketMetadata` live in mappings, so they can be appended safely.<br>• `OracleAdapterStorage` has no gap (oracle scope; Notes). | — |

### Findings index

| ID | Severity | Title | Upgrade-safe fix |
|---|---|---|---|
| CTF-001 | **Critical** | Partial-partition market registration (free, permissionless). `_settleMerge` then pays full collateral for an incomplete outcome set, making the Diamond insolvent (conditions with 3+ outcomes). | yes |
| CTF-002 | **High** | The market registry is written by any `splitPosition`, including 0-amount ones, first come first served. Anyone can flip YES/NO in the backend and frontend, map root position IDs to a different condition through a crafted parent (wrong SCRUM-235 gate, permanent seed DoS), and list nested markets. | yes (plus a registry clean-up migration) |
| CTF-003 | **Medium** | Settlement Mint/Merge ignore the registry market's `parentCollectionId` and `collateralToken`. The CTF acts on different token IDs from those transferred, using the Diamond's own ERC-1155 balance as inventory. | yes |
| CTF-004 | **Medium** | The resolution fee is fully avoidable. A winner can create the losing-side tokens through a self-nested split plus fee-free redemption to a parent, then merge to collateral with no fee. | yes |
| CTF-005 | **Medium** | No way to void or force-resolve a condition. Conditions that can never resolve lock one-sided collateral until an ad-hoc `diamondCut`. | yes |
| CTF-006 | **Medium** | Legacy `createCondition` lets a market maker appoint any resolver. `reportPayouts` accepts arbitrary vectors, including ones that overflow redemption, and accepts them after cancellation. | yes |
| CTF-007 | **Low** | The resolution fee is read at redemption time and can be set to 100%, with no cap or timelock. The owner can confiscate winnings that are already resolved. | yes |
| CTF-008 | **Low** | `sender == address(this)` skips collateral movement in the **public** split/merge (a latent free mint), and the internal variants' "no external calls / caller holds the lock" assumptions are not enforced. | yes |

---

## 2. Findings

Each heading keeps the reviewer's triage at `c506fe3` ("new — fix"). The lifecycle fields under it
follow `security/audit-protocol.md` and were added with the fix commits (SCRUM-214).

### CTF-001 — CRITICAL — new — fix — Free partial-partition registration makes `_settleMerge` release full collateral for an incomplete outcome set (Diamond insolvency)

- **status:** confirmed · **decision:** fix · **reverify:** pending · **ticket:** SCRUM-214
- **poc:** `test/audit/CTF-001-003-market-registry.test.js` — the `[pre-fix: …]` cases fail on the pre-fix contracts (run recorded in the fix commit); walkthrough: the exploit scenario below; §7 PoC-CTF-001.
- **fix-commit:** `bc40f48` (fixed in code, guard tests green, full suite green; production cut (`audit/follow-ups.md` CTF-MAINNET-CUT) and Phase-6 re-verify outstanding). The settlement-side guard (`SettlementFacet._conditionAndPartition`) is defence in depth, reachable only through a legacy non-canonical registry entry (none on mainnet or Base Sepolia); its direct test and the completeness clause of `echidna_registry_canonical` came from the PR #31 triage (CR-4319907524, CR-4319907478). Fuzzing did not independently show CTF-001 until that clause existed — see the ledger's CTF fuzzing correction.
- **fix-test:** `test/audit/CTF-001-003-market-registry.test.js`
- **location:**
  - `contracts/libraries/LibCTFCondition.sol:86-94`: `_splitPosition` registers the caller's partition. Nothing requires it to be complete or non-zero in amount.
  - `contracts/libraries/LibCTFCondition.sol:247-278`: no full-partition or `amount > 0` check.
  - `contracts/libraries/LibCTFCondition.sol:193-208`: `_mergePositionsInternal` handles `freeIndexSet != 0` by minting the union position to the Diamond.
  - `contracts/libraries/LibCTFCondition.sol:164-168`: `_splitPositionInternal` mirrors it.
  - `contracts/libraries/LibPositionRegistry.sol:118-128`: first registration wins.
  - `contracts/facets/SettlementFacet.sol:447-458`: any 2-entry market counts as "binary".
  - `contracts/facets/SettlementFacet.sol:680-752`: the Merge payout.
  - `contracts/facets/SettlementFacet.sol:884-895`: the partition comes from the registry.
- **source:** manual-reviewer · **swc:** SWC-123 (an assumed invariant is not enforced) · **owasp:** SC03 (logic error), SC04 (missing input validation) · **regression-of:** CRITICAL-1 (price-sum / "Diamond cannot become under-collateralised"). The price-sum check is present, but this route bypasses it. · **upgrade-safe:** yes (logic only; Replace `ConditionalTokensFacet` and `SettlementFacet`, which inline `LibCTFCondition`)
- **description:**
  - **Settlement assumption.** Settlement assumes that a market with two registered positions is a complete binary pair. Mint therefore splits `fill` collateral into those two positions, and Merge pays out `fill` collateral for them.
  - **Nothing enforces it.**
    1. `_splitPosition` registers whatever partition the **first** splitter of `(conditionId, parent, collateral)` uses. A partial partition is legal Gnosis semantics: it splits a union position, not collateral.
    2. `amount == 0` is accepted. A zero-amount partial split burns 0 of the union position and mints 0, so registration costs only gas.
    3. Once `[1, 2]` is registered on a 3-outcome condition, `_isBinaryComplement(pos1, pos2)` is true. `_settleMerge` calls `_mergePositionsInternal(this, T, 0, c, [1,2], fill)`. That function burns pos1 and pos2, finds `freeIndexSet = 4 ≠ 0`, and **mints pos3 (outcomes {0,1}) to the Diamond** instead of releasing collateral.
    4. `_settleMerge` then pays `takerNet + makerNet = fill − fees` out of the Diamond's shared collateral balance.
    5. No complete set was burned. The Diamond swapped `fill` collateral that backs other users for a union token it can never redeem, because no path redeems the Diamond's own positions.
  - **The attacker can still obtain the tokens.** After the partial registration, the canonical root split `[1,2,4]` reverts `InvalidMatch`. But the attacker can get a complete root set of `c` without a root split, because collection IDs do not depend on order (check 2(b)). They split collateral through any other condition `d`, re-split by `c`, then merge `d` away under the root collection of `c`.
- **exploit scenario:**
  - **Setup.** USDT, `unit = 1e6`. A market maker creates a 3-outcome DifficultyRange condition `c` (buckets `[130T, 145T]`; slot 2 = "≥145T"). Per ORC-006, the answer may already be decided when the market is created, for example ≥145T.
  - **Window.** The MM's seed split is a separate, manual transaction (`5-split-condition.js:179-226`). Whatever happens, any allow-listed collateral that has not been seeded for `c` stays open indefinitely.
  1. Call `splitPosition(USDT, 0x0, c, [1,2], 0)`. The registry for `(c, 0, USDT)` becomes `[pos1, pos2] / [1,2]`, a **partial** partition.
     - The backend sees `PositionPairsRegistered` and creates and announces a 2-position market (`event_handler.py:978-1025`).
     - The match engine's complement of pos1 becomes pos2 (`match_repository.py:629-663`).
  2. Acquire a full root set of `c` (a = 100,000 USDT = 1e11). Here `d` is any binary market already seeded with `[1,2]`:
     - `splitPosition(USDT, 0, d, [1,2], a)`
     - `splitPosition(USDT, coll(d,1), c, [3,4], a)`
     - `splitPosition(USDT, coll(d,2), c, [3,4], a)`
     - `mergePositions(USDT, coll(c,3), d, [1,2], a)`, which mints **root pos3**
     - `mergePositions(USDT, coll(c,4), d, [1,2], a)`, which mints **root pos4**

     The burned IDs equal the minted ones because H(c,3)+H(d,i) = H(d,i)+H(c,3). Net cost: `a` USDT for a full set of `c`.
  3. Call `splitPosition(USDT, 0, c, [1,2], a)`. This partial split burns pos3 and mints pos1 and pos2. It matches the registry.
  4. Accounts A and B post SELL pos1 @ 0.50 and SELL pos2 @ 0.50. The honest engine routes a **Merge** (`matching_service.py:607-625`).
     - `matchOrders` burns pos1 and pos2 from the Diamond and **mints pos3 to the Diamond**.
     - It pays A and B 100,000 USDT minus the trading fee (≤ `maxFeeRateBps`; for example about 1,000 at 1%).
  5. The attacker keeps 100,000 **pos4** (slot 2) at a net cost of about the fee. Repeat steps 2–4 k times with the recycled capital.
  6. Resolution `[0,0,1]`: `redeemPositions(USDT, 0, c, [4])` pays k × 100,000 USDT (minus the resolution fee) from the Diamond.
     - Only about k × 1,000 net entered the Diamond for these claims.
     - With k = 10, about 1,000,000 USDT of other markets' collateral and the fee bank is taken.
     - The ceiling is `balanceOf(Diamond, USDT)`.
     - The Diamond keeps k × 100,000 pos3, which are worthless.
  - **Harm to honest users as well.** Users who buy "both sides" of this fake binary market lose 100% if slot 2 resolves.
- **impact:**
  - Permissionless insolvency of the shared collateral pool and the fee bank for any allow-listed token, as soon as a condition with 3 or more outcomes exists whose root market for that token has not been seeded yet.
  - An honest operator executes the attack; a compromised operator needs no backend cooperation at all.
  - `echidna_diamond_solvent` cannot catch it. The ghost `outstandingPairs` is decremented by `fill` on every Merge (`DoefinInvariantHarness.sol:817-818`) whether or not a complete set was burned.
  - **Critical.**
- **recommendation:** apply all of the following.
  1. **Never register a non-canonical market.** In `_splitPosition`, register only when `parentCollectionId == 0`, `freeIndexSet == 0` and `partition == [1, 2, 4, …, 2^(n−1)]` in ascending order. Otherwise skip registration; do not revert, so ordinary CTF use keeps working. Better still, register the canonical singleton market at condition creation (`ConditionManagerFacet`), per allowed collateral or lazily on the first canonical split. Then the market structure is never chosen by a user.
  2. **Fail closed in settlement.** In `_conditionAndPartition`, require `meta.parentCollectionId == 0`, `meta.collateralToken == taker.collateralToken`, `partition[0] & partition[1] == 0`, and `partition[0] | partition[1] == (1 << outcomeSlotCount) − 1`.
  3. **Defence in depth.** Make `_splitPositionInternal` and `_mergePositionsInternal` revert unless `freeIndexSet == 0 && parentCollectionId == 0`.
  4. **Off-chain, now.** In the match engine, treat two positions as complements only if `condition.outcome_slot_count == 2` and the stored partitions are exactly `[1,2]` in that order. Ignore `PositionPairsRegistered` events that are not canonical. Do not create conditions with 3 or more outcomes until (1)–(3) ship.
  5. **On-chain audit, now.** Scan every `PositionPairsRegistered` / `PositionSplit` event on `0x71C4…Fdf9` for `amount == 0`, non-canonical partitions, or `parentCollectionId != 0` on any market that has trading activity.
  6. **If exploitation is seen,** `pauseTrading` stops the Merge drain. Redemption is not gated by the pause.
  ```solidity
  // LibCTFCondition._splitPosition — replace the unconditional register call
  if (parentCollectionId == bytes32(0) && freeIndexSet == 0 && _isCanonical(partition, outcomeSlotCount)) {
      LibPositionRegistry.registerPositionPairs(positionIds, partition, conditionId, bytes32(0), collateralToken);
  }
  // SettlementFacet._conditionAndPartition
  if (p0 & p1 != 0 || (p0 | p1) != (uint256(1) << slots) - 1) revert Errors.InvalidMatch();
  ```

### CTF-002 — HIGH — new — fix — Anyone writes the market registry, for free and first come first served. Outcome order (YES/NO labels), condition mapping and market listing are attacker-controlled

- **status:** confirmed · **decision:** fix · **reverify:** pending · **ticket:** SCRUM-214
- **poc:** `test/audit/CTF-001-003-market-registry.test.js` — the `[pre-fix: …]` cases fail on the pre-fix contracts (run recorded in the fix commit); walkthrough: the exploit scenario below; §7 PoC-CTF-002a/b.
- **fix-commit:** `bc40f48` (fixed in code, guard tests green, full suite green; production cut (`audit/follow-ups.md` CTF-MAINNET-CUT) and Phase-6 re-verify outstanding). No registry clean-up needed: mainnet 29/29 and Base Sepolia 15/15 entries are canonical (read-only, 2026-10-19 / 2026-10-20).
- **fix-test:** `test/audit/CTF-001-003-market-registry.test.js`
- **location:**
  - `contracts/libraries/LibCTFCondition.sol:94`
  - `contracts/libraries/LibPositionRegistry.sol:103-158`: first-write-wins at `:118-128`; the cross-market lock at `:149-156`.
  - `contracts/facets/SettlementFacet.sol:386-393`: the validity gate keyed by `conditionIdByPositionId`.
  - **Off-chain consumers:** `event_handler.py:991-999` (`outcome_index` = array position); `match_repository.py:727-728` and `market_service.py:348-349` (YES = `outcome_index` 1); `market_service.py:488, 519` (payout read as `payout_numerators[outcome_index]`); `UnifiedPortfolioPanel.tsx:134-171`.
- **source:** manual-reviewer · **swc:** SWC-114 (transaction-order dependence), SWC-123 · **owasp:** SC01 (access control), SC04 · **upgrade-safe:** yes for the logic. Poisoned entries need a one-off clean-up in a `diamondCut` `_init`; the values change, the layout does not.
- **description:** The registry was added in place of an owner-only `registerPositionPair` step (SCRUM-120, `scripts/upgrades/upgrade-scrum120.js:4-20`). Any `splitPosition` writes it, including a 0-amount split, so writing it costs only gas. It is immutable once written. Three attacker-controlled outcomes follow:
  - **(a) YES/NO flip.**
    - The canonical seed is `[1,2]`: index set 1 is slot 0 = NO, index set 2 is slot 1 = YES (`LibOracleAdapter.sol:259-267`).
    - Calling `splitPosition(T, 0, c, [2,1], 0)` first registers `[pos(2), pos(1)]`.
    - The backend assigns `outcome_index` by array position. The real YES token becomes outcome 0 ("NO"), and the real NO token becomes outcome 1 ("YES").
    - The API values positions with `payout_numerators[outcome_index]`, so after resolution the UI also shows the wrong winner.
    - The MM's later `[1,2]` seed reverts `InvalidMatch` forever. The market still trades, because Mint settlement does not need a seed.
  - **(b) Cross-condition mapping through a crafted parent.**
    - Pick any prepared condition `c` and a target root position `R = pos(T, coll(c', s'))` that has not yet been registered.
    - Set `P = compress(H(c',s') − H(c,s))`. It is a valid curve point, so it passes `LibCTHelpers.sol:55-57`.
    - Then `splitPosition(T, P, c, [s, s^c], 0)` mints child `coll(P, c, s) = coll(0, c', s')`, so it registers **R** under market key `(c, P, T)` with `conditionIdByPositionId[R] = c`.
    - The root seed of `c'` then reverts forever (`LibPositionRegistry.sol:151-152`).
    - `_validateOrder` checks the **wrong condition**. If `c` is already resolved or cancelled, every order on `c'` reverts: the market is dead permanently. If `c` is active, the SCRUM-235 cancelled/resolved gate for `c'` is skipped.
    - `c'` does not even need to exist yet, because condition IDs for oracle-driven markets are predictable from `(type, metadata, salt)`.
  - **(c) Nested markets.** A split under any non-zero parent creates its own registry market. The indexer turns it into a separate tradeable market for the same `conditionId`, and the API does not filter on `parent_collection_id` by default. Those tokens pay only if the parent outcome also happens. This also feeds CTF-003.
- **exploit scenario, for (a):**
  1. An MM creates "Difficulty > 150T at T?" (binary). The attacker back-runs the `ConditionCreated` log with `splitPosition(USDT, 0x0, c, [2,1], 0)`.
     - Base has no public mempool, but the seed is a separate manual script and the attacker can outbid on priority fee for the next block.
  2. The UI shows "YES" at 0.80. Users buy 10,000 "YES" for 8,000 USDT and receive real **NO** tokens. The attacker, buying "NO" at 0.20 for 2,000, receives real **YES**. Mint settlement makes both legs.
  3. YES happens. The attacker redeems 10,000 USDT. The users' tokens pay 0 while the UI reported "WINNING". The attacker gains about 8,000 USDT per 10,000 of volume.
- **impact:**
  - User funds are lost through labels that the attacker chose, at zero on-chain cost.
  - Any new market (and any existing market on a newly allow-listed collateral) can be permanently disabled or ungated with one 0-amount transaction.
  - There is no admin recovery short of a `diamondCut`.
  - **High.** Triage may raise this to Critical. I stop at High because the loss depends on the off-chain labelling (confirmed in code) and the MM's seed revert is a visible signal.
- **recommendation:**
  - Same root fix as CTF-001 (1): only a canonical root split (or condition creation) may register.
  - Add an on-chain consistency assertion: for each `i`, `positionIds[i] == getPositionId(T, getCollectionId(0, c, partition[i]))`. This rejects (b) even if an attacker reaches the canonical branch.
  - Off-chain:
    - derive `outcome_index` from the index set (`log2(partition)`), never from array order;
    - drop registrations with `parentCollectionId != 0`, non-canonical partitions, or `len != outcome_slot_count`;
    - recompute position IDs from `(conditionId, indexSet, collateral)` and reject any mismatch.
  - Operationally, until fixed: seed in the same transaction as creation (a Safe MultiSend `createConditionWithMetadata` plus `splitPosition`), and audit the mainnet registry (CTF-001 recommendation 5).

### CTF-003 — MEDIUM — new — fix — Settlement Mint/Merge ignore the registry market's `parentCollectionId` and `collateralToken`, so the Diamond's own ERC-1155 balance becomes settlement inventory

- **status:** confirmed · **decision:** fix · **reverify:** pending · **ticket:** SCRUM-214
- **poc:** `test/audit/CTF-001-003-market-registry.test.js` — the `[pre-fix: …]` cases fail on the pre-fix contracts (run recorded in the fix commit); walkthrough: the exploit scenario below.
- **fix-commit:** `bc40f48` (fixed in code, guard tests green, full suite green; production cut (`audit/follow-ups.md` CTF-MAINNET-CUT) and Phase-6 re-verify outstanding).
- **fix-test:** `test/audit/CTF-001-003-market-registry.test.js`
- **location:**
  - `contracts/facets/SettlementFacet.sol:656-671`: the split uses `bytes32(0)` and `taker.collateralToken`, then transfers `taker/maker.positionId` out of the Diamond.
  - `contracts/facets/SettlementFacet.sol:716-733`: sellers' IDs come in, and root IDs of the order's collateral are burned.
  - `contracts/facets/SettlementFacet.sol:386-393`: no `order.collateralToken == registry collateral` check, and an unregistered position (`conditionId == 0`) skips the cancelled/resolved gate.
  - `contracts/facets/ERC1155ReceiverFacet.sol:10-28`: the Diamond accepts any token.
- **source:** manual-reviewer · **swc:** SWC-123 · **owasp:** SC03 · **upgrade-safe:** yes
- **description:**
  - **Different IDs.** The CTF call operates on `pos(order collateral, coll(0, c, partition[i]))`. The transfers move the orders' `positionId`s. These differ whenever the registry market is nested (`parent != 0`, which anyone can create; CTF-002(c)) or the order's collateral differs from the registry's.
  - **Mint** therefore succeeds only if the Diamond already holds the orders' IDs. The buyers pay `fill`, the Diamond keeps a fresh root set, and it hands out whatever it held.
  - **Merge** succeeds only if the Diamond holds the root IDs. It pays `fill` for the sellers' (nested) tokens.
  - **Where the Diamond's balance comes from:** donations, CTF-001's accumulated union positions, and earlier settlements of this kind.
- **exploit scenario:**
  1. The attacker creates a nested market `(c, coll(d,1), T)` (CTF-002(c)) and donates one nested pair (worth `P(d=1)·fill`) to the Diamond.
  2. Honest buyers on the backend-listed nested market Mint. They pay `fill` and receive the nested pair, and the Diamond keeps a root set of `c`.
  3. The attacker Merge-sells a newly made nested pair. They receive `fill` while the Diamond burns its root set.
  4. Net effect: with `P(d=1) = 0.3`, the attacker gains about `fill·(1 − 0.6)` per cycle, and buyers who were shown the nested market as a normal market overpaid by `0.7·fill`.

  A compromised operator can also settle complementary trades of unregistered positions (merged unions, redeem-to-parent outputs) with no cancelled/resolved gate. That still needs user-signed orders for those IDs.
- **impact:** value moves from users of mislisted nested markets to the attacker, and tokens held by the Diamond are misattributed. This is bounded by those markets' volume and by what the Diamond holds. **Medium.**
- **recommendation:**
  - Require `meta.parentCollectionId == 0` and `meta.collateralToken == taker.collateralToken == maker.collateralToken` in `_conditionAndPartition`.
  - In `_settleMint` and `_settleMerge`, assert that the CTF-derived position IDs equal `taker.positionId` and `maker.positionId`.
  - Gate unregistered positions in `_validateOrder` (revert `InvalidPositionId`) instead of skipping the condition checks.

### CTF-004 — MEDIUM — new — fix — The resolution fee is fully avoidable by fabricating losing tokens (self-nested split plus fee-free redemption to a parent) and merging to collateral

- **status:** confirmed · **decision:** fix · **reverify:** pending · **ticket:** SCRUM-214
- **poc:** `test/audit/CTF-004-007-resolution-fee.test.js` — the `[pre-fix: …]` cases fail on the pre-fix contracts (run recorded in the fix commit); walkthrough: §7 PoC-CTF-004.
- **fix-commit:** `22c741a` (fixed in code, guard tests green, full suite green; production cut (`audit/follow-ups.md` CTF-MAINNET-CUT) and Phase-6 re-verify outstanding).
- **fix-test:** `test/audit/CTF-004-007-resolution-fee.test.js`
- **location:**
  - `contracts/facets/ConditionalTokensFacet.sol:190-198`: a fee is charged only when `parentCollectionId == 0`.
  - `contracts/libraries/LibCTFCondition.sol:37-72`: a root merge has no fee and no resolved-condition check.
  - `contracts/libraries/LibCTFCondition.sol:74-120`: split is allowed on resolved conditions and with a parent that already contains the same condition.
- **source:** manual-reviewer · **swc:** — · **owasp:** SC03 · **upgrade-safe:** yes
- **description:** For a resolved condition `c` with payouts `[1,0]`, `H1 = H(c,1)` and `H2 = H(c,2)`, a holder of `a` winning tokens can:
  1. `splitPosition(T, coll(H1), c, [1,2], a)` turns `a` winning tokens into `pos(2H1)` and `pos(H1+H2)`. This can be done before resolution too.
  2. `redeemPositions(T, coll(H2), c, [1])` burns `pos(H2+H1)` and mints `a` root **losing** tokens `pos(H2)`, with no fee because the parent is non-zero.
  3. `redeemPositions(T, coll(H1), c, [1])` burns `pos(2H1)` and mints `a` root winning tokens.
  4. `mergePositions(T, 0, c, [1,2], a)` returns `a` collateral with **no fee**.
  - **No insolvency.** The fabricated losing tokens are worth 0 and the collateral paid out equals the winning claim.
  - **Simpler variant.** Anyone can do the same by buying real losing tokens, which trade at dust once the market resolves, and merging them with the winners.
- **impact:** every winning redemption can avoid `resolutionFeeBps`. At 200 bps, a 50,000 USDT win saves 1,000 USDT for four transactions. Step 1 also emits a nested `PositionPairsRegistered`, which adds noise to the indexer (CTF-002(c)). **Medium** (protocol revenue).
- **recommendation:**
  - Charge the resolution fee on root `mergePositions` when `payoutDenominator[conditionId] != 0`. A full partition pays `amount`, so apply the same fee as redeem.
  - Optionally reject `splitPosition` on resolved conditions. This alone is not enough, because step 1 can be done before resolution.

### CTF-005 — MEDIUM — new — fix — No void or force-resolve path. One-sided collateral of conditions that can never resolve is locked until an ad-hoc `diamondCut`

- **status:** confirmed · **decision:** fix · **reverify:** pending · **ticket:** SCRUM-214
- **poc:** `test/audit/CTF-005-006-resolution-authority.test.js` — the `[pre-fix: …]` cases fail on the pre-fix contracts (run recorded in the fix commit); walkthrough: the `[pre-fix]` cases (no void path existed).
- **fix-commit:** `8c86393` (fixed in code, guard tests green, full suite green; production cut (`audit/follow-ups.md` CTF-MAINNET-CUT) and Phase-6 re-verify outstanding). Deviation from the recommendation: no timelock or deadline (owner Safe, after `cancelCondition`). The pending question is skipped at its settlement height rather than removed at void, and is counted as resolved so INV-ORC-4 holds (`8dbeaed`, PR #31 CR-4319907533).
- **fix-test:** `test/audit/CTF-005-006-resolution-authority.test.js`
- **location:**
  - `contracts/libraries/LibCTFCondition.sol:211-245`: the only writer of payouts. Its only callers are `LibOracleAdapter` (`:270, 291, 326, 351`) and the external `reportPayouts`, which is oracle-bound.
  - `contracts/facets/ConditionManagerFacet.sol:144-167`: `createCondition(address(this), …)` registers no oracle question.
  - `contracts/facets/ConditionManagerFacet.sol:197-214`: cancel neither resolves the condition nor deregisters its question.
- **source:** manual-reviewer · **swc:** SWC-113 · **owasp:** SC10 · **upgrade-safe:** yes (a new owner or guardian function; an optional deadline needs a new EIP-7201 namespace)
- **description:**
  - **What still works:** complete-set holders can always merge.
  - **What is lost:** one-sided holders can be paid only through `_reportPayouts`. For a condition whose oracle is the Diamond, that happens only when the adapter resolves the exact question.
  - **Conditions that can never resolve:**
    - legacy `createCondition(address(this), …)`;
    - BlockCount questions missed by the 600-second gate (ORC-004(b)) or popped by mistake (ORC-005);
    - questions behind an oracle freeze (SEC-015 stopped all resolution for 8 days);
    - an external oracle that disappears.
  - **Cancellation does not help.** It is not a void: it does not set a 50/50 vector and the question stays pending.
- **impact:** user collateral can be locked indefinitely, and recovery requires an emergency upgrade written under pressure. **Medium.**
- **recommendation:** add an owner (Safe) `voidCondition(conditionId)` that reports an equal-split vector. Allow it only when `!active` or after a per-condition deadline has passed, behind a timelock, and emit an event. Pop or flag any pending oracle question.

### CTF-006 — MEDIUM — new — fix — Legacy `createCondition` lets a market maker appoint any resolver. `reportPayouts` accepts arbitrary vectors and ignores cancellation

- **status:** confirmed · **decision:** fix · **reverify:** pending · **ticket:** SCRUM-214
- **poc:** `test/audit/CTF-005-006-resolution-authority.test.js` — the `[pre-fix: …]` cases fail on the pre-fix contracts (run recorded in the fix commit); walkthrough: the `[pre-fix]` cases.
- **fix-commit:** `8c86393` (fixed in code, guard tests green, full suite green; production cut (`audit/follow-ups.md` CTF-MAINNET-CUT) and Phase-6 re-verify outstanding).
- **fix-test:** `test/audit/CTF-005-006-resolution-authority.test.js`
- **location:**
  - `contracts/facets/ConditionManagerFacet.sol:144-167`: the oracle is chosen by the caller.
  - `contracts/facets/ConditionalTokensFacet.sol:64-73`.
  - `contracts/libraries/LibCTFCondition.sol:211-245`: no `active` check; length 1 is allowed; numerator size is unbounded.
  - `contracts/facets/ConditionalTokensFacet.sol:185`: `stake * payoutNumerator` can overflow.
- **source:** manual-reviewer · **swc:** SWC-101 (the overflow DoS) · **owasp:** SC01, SC02 · **upgrade-safe:** yes
- **description:**
  - **What a compromised market maker can do:**
    - Create `createCondition(mmKey, q, 2, uri)`, seed it, and let users trade it. Nothing on-chain or in `_validateOrder` distinguishes this condition from one resolved by the Diamond.
    - Resolve it at will, including after `cancelCondition`.
    - Report `[2^200, 1]`. The denominator does not overflow, but `stake * 2^200` overflows for any stake above about 2^56, so every slot-0 redemption reverts and the slot-0 collateral is locked.
  - **Divergences from upstream.** Upstream requires at least 2 slots. Doefin allows `payouts.length == 1` here and allows `outcomeSlotCount` 0 or 1 in the owner path (`ConditionalTokensFacet.sol:44-49`; `LibCTFCondition.sol:22-35`).
- **impact:** a compromised or malicious market-maker key can steal the counterparty side of any market it creates and resolves, or lock it. **Medium** (behind a privileged role).
- **recommendation:**
  - Remove legacy `createCondition`, or force `oracle == address(this)`.
  - In `_reportPayouts`:
    - require `outcomeSlotCount >= 2`;
    - require one-hot or bounded numerators (for example each ≤ 1e18 and `den ≤ 1e18`);
    - require `conditions[conditionId].active` for oracles other than the Diamond.
  - In `prepareCondition`, require `outcomeSlotCount >= 2`.

### CTF-007 — LOW — new — fix — The resolution fee is read at redemption time and can be up to 100%, with no cap or timelock

- **status:** confirmed · **decision:** fix · **reverify:** pending · **ticket:** SCRUM-214
- **poc:** `test/audit/CTF-004-007-resolution-fee.test.js` — the `[pre-fix: …]` cases fail on the pre-fix contracts (run recorded in the fix commit); walkthrough: the `[pre-fix]` cases.
- **fix-commit:** `22c741a` (fixed in code, guard tests green, full suite green; production cut (`audit/follow-ups.md` CTF-MAINNET-CUT) and Phase-6 re-verify outstanding). Conditions resolved before the cut have no snapshot and are charged 0, so a later fee raise cannot reach their unredeemed winnings (`c1de64a`; owner decision 2026-10-20, PR #31 triage OOB-4). `AdminConfigFacet.getResolutionFeeBps(conditionId)` exposes the charged rate (`d4fff04`, CR-4319907505).
- **fix-test:** `test/audit/CTF-004-007-resolution-fee.test.js`
- **location:** `contracts/facets/AdminConfigFacet.sol:127-136` (bound at `:129` is `<= 10000`); `contracts/facets/ConditionalTokensFacet.sol:226, 239` (read at redeem time)
- **source:** manual-reviewer · **swc:** — · **owasp:** SC01 · **upgrade-safe:** yes for a cap; a per-condition snapshot needs a new namespace
- **description:** The fee in force when a user redeems applies to markets that resolved earlier. The owner (Safe) can raise it to 100% after resolution and before users redeem. The whole payout then goes to `accruedFees`, which only the owner can withdraw. Trading fees have a 10% hard cap (`AdminConfigFacet.sol:30`); resolution fees do not.
- **impact:** the owner can confiscate winnings. This sits within owner trust (the owner can also `diamondCut`), but it is a cheap, non-upgrade path. **Low.**
- **recommendation:** add a hard cap (for example `MAX_RESOLUTION_FEE_BPS = 500`). Optionally snapshot the rate into the condition at creation or resolution, and timelock changes.

### CTF-008 — LOW — new — fix — The `sender == address(this)` transfer skip in the **public** split/merge is a latent free mint; the internal variants' safety claims are not enforced

- **status:** confirmed · **decision:** fix · **reverify:** pending · **ticket:** SCRUM-214
- **poc:** `test/audit/CTF-008-self-calls-and-lock.test.js` — the `[pre-fix: …]` cases fail on the pre-fix contracts (run recorded in the fix commit); walkthrough: the `[pre-fix]` cases.
- **fix-commit:** `6be7c06` (fixed in code, guard tests green, full suite green; production cut (`audit/follow-ups.md` CTF-MAINNET-CUT) and Phase-6 re-verify outstanding).
- **fix-test:** `test/audit/CTF-008-self-calls-and-lock.test.js`
- **location:**
  - `contracts/libraries/LibCTFCondition.sol:59-61` and `:100-106`: public paths.
  - `contracts/libraries/LibCTFCondition.sol:122-209`: internal variants and their NatSpec.
  - `contracts/libraries/LibERC1155.sol:166-168, 180-185`: self-hooks.
  - `contracts/facets/SettlementFacet.sol:658-659, 724-725`: comments.
- **source:** manual-reviewer · **swc:** SWC-107 (reentrancy assumptions), SWC-123 · **owasp:** SC05 · **upgrade-safe:** yes
- **description:**
  - **(a) Latent free mint.** If the Diamond ever calls its own `splitPosition`, collateral is skipped and positions are minted for nothing. Today the only self-calls are the fixed-selector ERC-1155 receiver hooks, so this is unreachable. It becomes reachable for any future facet that makes arbitrary calls, such as a multicall or a relay.
  - **(b) Unenforced lock.** The internal variants assume the caller holds the lock but never check it. They are `internal` and any facet can call them.
  - **(c) Inaccurate claim.** "`sender == address(this)` means no external calls" is false. `_batchMint`/`_mint` to the Diamond call `onERC1155(Batch)Received` on the Diamond itself. Mint/Merge settlement (and any transfer to the Diamond) therefore depends on those selectors staying routed to `ERC1155ReceiverFacet`.
- **impact:** no exploit today. These are defence-in-depth and upgrade hazards. **Low.**
- **recommendation:**
  - In the public paths, `if (sender == address(this)) revert`.
  - In the internal variants, assert `reentrancyStorage._status == _ENTERED`.
  - In `LibERC1155`, skip the acceptance check when `to == address(this)`, and fix the comments.

---

## 3. Divergences from upstream `gnosis/conditional-tokens-contracts`

| Area | Upstream | Doefin | Effect |
|---|---|---|---|
| `getConditionId` | `encodePacked(oracle, questionId, uint outcomeSlotCount)` (84 bytes) | `uint8` (53 bytes) (`LibCTHelpers.sol:13-19`) | IDs are not compatible with Gnosis tooling. Still injective. |
| `prepareCondition` | permissionless; `1 < n <= 256` | owner-only (`ConditionalTokensFacet.sol:45`) or market maker (`ConditionManagerFacet.sol:56, 150`); `oracle != 0`; `n` up to 255; **no `n > 1` check** in the owner path | Slots 0 or 1 accepted (harmless; Notes); CTF-006 |
| `reportPayouts` | `length > 1` | `length >= 1`, max 255 (`LibCTFCondition.sol:212`) | CTF-006 |
| `splitPosition` | none | collateral allow-list (`:82-84`), **registry write** (`:94`), reentrancy lock, `sender == this` skip | CTF-001, CTF-002, CTF-008 |
| `mergePositions` | none | lock; `sender == this` skip | CTF-008 |
| `redeemPositions` | transfer payout | resolution fee on root payouts only; accrued to `accruedFees`; lock around the transfer | CTF-004, CTF-007 |
| Internal split/merge | none | `_splitPositionInternal` / `_mergePositionsInternal`: no lock, no registry write, partial partitions accepted | CTF-001, CTF-003 |
| `sqrt` | assembly addition chain | generic `expMod` loop (`LibCTHelpers.sol:74-95`) | Same result; roughly 10× the gas (Notes) |
| Index-set and partition rules | `0 < s < full`, disjoint, `len > 1` | identical (`LibCTFCondition.sol:254-272`; `ConditionalTokensFacet.sol:169`) | — |
| ERC-1155 | Gnosis ERC1155 | custom `LibERC1155`: `_burn` has no `from != 0` check; empty batch transfer reverts | No security impact |
| Getters | public `payoutDenominator`, `getOutcomeSlotCount` | neither exposed | Integrators must sum the numerators (Notes) |
| Cancellation | none | `active` flag; settlement only (`SettlementFacet.sol:388-393`) | CTF-005 |

## 4. Compromised-role enumeration (CTF surface)

- **Anyone:**
  - free partial registration leading to insolvency (CTF-001);
  - YES/NO flip, cross-condition mapping and permanent market DoS (CTF-002);
  - nested-market inventory games (CTF-003);
  - avoiding the resolution fee (CTF-004).
- **Operator (compromised):**
  - can execute CTF-001 with its own signed orders even if the backend is fixed;
  - can settle complementary trades of unregistered positions without the cancelled/resolved gate (CTF-003);
  - **cannot** touch users' split, merge or redeem, which are bound to `msg.sender`.
- **Market maker (compromised):**
  - can appoint its own resolver (CTF-006);
  - can create markets that never resolve (CTF-005);
  - can cancel its own markets, which halts settlement but not exits;
  - has the oracle kill switches described in ORC-003, ORC-004 and ORC-009.
- **Owner (Safe):**
  - can set the resolution fee to 100% retroactively (CTF-007);
  - can remove a collateral, which blocks new splits and trading of that token while merge and redeem stay open;
  - has full upgrade power through `diamondCut`.

## 5. Triage: `test/integration/BatchSubmissionBugRepro.test.js`

- **Recorded failure.** `ValueOutOfRange()` at the then-`LibConditionMetadata.sol:131` (`audit/fixes/changelog.md:30-32, 111-114`). It is the `targetBlockHeight <= currentBlockHeight` guard, now at `validateDifficultyThreshold`, `LibConditionMetadata.sol:102-104`.
- **Cause.** The guard fired because the test **hardcoded** the target height while SCRUM-222 refreshed `test/data/blocks-production.json`. This is fixture drift, not a contract defect.
- **Current state.** The test now derives the target from the fixture (`BatchSubmissionBugRepro.test.js:112-121`). `audit/business-logic/coverage.md:26-29` records the suite as passing. **I did not run it.**
- **"In CTF code" was a mislabel.** The test exercises `ConditionManagerFacet`, the oracle and `_reportPayouts` only. It never calls split, merge or redeem, so it provides **no** CTF coverage.
- **Remaining weaknesses:**
  - it looks for `ConditionPreparation`, which the MM path never emits, and silently falls back to the last log's `topic[1]` (`:211-235`);
  - its 7-block batch stays inside one epoch, so it cannot exercise ORC-002, ORC-003 or ORC-004;
  - the name "BugRepro" now describes an assertion of the fixed behaviour.
- **Verdict:** not a CTF bug; close it as fixture drift (fixed).

## 6. Test coverage gaps (CTF)

There is no test for any of the following:
- a 0-amount split;
- partial-partition registration;
- registration order (`[2,1]`);
- registration under a crafted or nested parent;
- settlement on markets with 3 or more outcomes or on nested registry markets;
- an ERC-1155 self-hook removal;
- fee avoidance through merge;
- redemption after cancellation;
- overflow of `stake * numerator`.

The harness seeds only binary `[1,2]` markets (`DoefinInvariantHarness.sol:542-547, 951-953, 983-985`). Its solvency ghost cannot detect CTF-001 (see CTF-001 impact). Under `security/audit-protocol.md`, CTF-001 is therefore a Critical invariant with **zero** coverage.

## 7. Invariant and PoC candidates

- **INV-CTF-1, per-outcome backing (fails today, CTF-001).** For each market `(c, T)` and each outcome `o`:

  `Σ_{h ≠ Diamond} Σ_{s ∋ o} balanceOf(h, pos(T, coll(0,c,s)))` ≤ the collateral attributable to `c`.

  In a single-market harness this is `balanceOf(Diamond,T) − accruedFees[T]`. Compute it from on-chain balances, not from an `outstandingPairs` ghost.
- **INV-CTF-2, registry canonicality (fails today, CTF-001/002).** For every registered market:
  - `parentCollectionId == 0`;
  - `partitions` is ascending singletons covering all `n` slots;
  - `positionIds[i] == getPositionId(T, getCollectionId(0, c, partitions[i]))`;
  - `conditionIdByPositionId[positionIds[i]] == c`.
- **INV-CTF-3, Diamond holds no positions (fails today, CTF-001/003).** After every `matchOrders` or `fillOrder`, the Diamond's ERC-1155 balance is unchanged for every ID touched.
- **INV-CTF-4, resolution fee charged (fails today, CTF-004).** For a resolved condition, collateral leaving the Diamond for winning claims (redemptions plus root merges) always comes with `fee = floor(claim·bps/1e4)` accrued.
- **PoC-CTF-001.** Use the harness as oracle via `createCondition(address(this), q, 3, …)`.
  1. `splitPosition(T,0,c,[1,2],0)`.
  2. Run the nested acquisition through a seeded binary `d`, then the partial split `[1,2]`.
  3. `matchOrders` (Merge) between two actors.
  4. Assert `balanceOf(Diamond) − accrued < Σ pos4 held by users`.
  5. `reportPayouts(q,[0,0,1])`. The attacker redeems pos4, then an honest pos4 holder's redeem reverts on the ERC-20 balance.
- **PoC-CTF-002a.** `splitPosition(T,0,c,[2,1],0)`. `getMarketMetadata(pos1).positionIds[0] == pos2`, and the MM's `[1,2]` seed reverts `InvalidMatch`.
- **PoC-CTF-002b.**
  1. Compute `H(c',1)` and `H(c,1)` off-chain by replicating `getCollectionId` (hash-to-curve plus parity).
  2. Compute `P = H(c',1) + (−H(c,1))` with the `0x06` precompile, using `(x, p − y)` for the negation, then compress.
  3. `splitPosition(T,P,c,[1,2],0)`, then assert `conditionIdByPositionId[pos(T,coll(0,c',1))] == c` and that the `c'` seed reverts.
- **PoC-CTF-004.** The four calls in CTF-004. Assert `accruedFees` is unchanged and the winner received the full `a`.

## 8. Verified safe

- **Index-set and partition validation** matches upstream exactly. That means non-zero sets, below the full set, disjoint, length > 1, and the full/partial branch logic.
- **Duplicate index sets** in `redeemPositions` are safe: the second occurrence has `stake == 0` (`:173-175`).
- **Redemption arithmetic** rounds down per index set. Its sum is ≤ stake for any payout vector, and there is no over-payment.
- **Resolution fee bounds.** `feeAmount ≤ amount`, the accrual is booked before the transfer (CEI), there is no event when the fee is zero (`ConditionalTokensFacet.sol:232-250`), and the fee needs no `feeReceiver` (CR-3291973203 holds).
- **`withdrawFees`** is owner-only, decrements by the exact amount, and runs fully under the lock (`AdminConfigFacet.sol:256-279`).
- **The reporter cannot be spoofed.** A Diamond-oracle condition can only be resolved by `LibOracleAdapter`; no external `msg.sender` can be `address(this)`.
- **No double resolution, and no all-zero resolution.**
- **Parent-ID handling.** An off-curve parent reverts (`LibCTHelpers.sol:55-57`). An `x ≥ p` parent reverts in the precompile. ECADD of equal points (doubling) is correct per EIP-196.
- **The lock is acquired consistently**, and a re-entrant redeem to the root during settlement reverts on the lock.
- **Exits stay open:** merge and redeem do not depend on the collateral allow-list, the pause, or `active`.
- **Settlement collateral arithmetic** is exact for binary root same-collateral markets: Mint collects exactly `fill` and Merge pays exactly `fill`.
- **Storage:** CTF/ERC-1155/registry writes are confined to their libraries plus `ConditionManagerFacet`, and the gaps are present.

## 9. Could not determine

- **Mainnet state (no RPC access):**
  - whether any condition with 3 or more outcomes exists on mainnet (CTF-001 goes live the moment one is created);
  - which collaterals are allow-listed on mainnet, and which `(condition, collateral)` root markets are unseeded;
  - whether any mainnet registration is already non-canonical (an `amount == 0` split, `[2,1]`, a non-zero parent, or mismatched IDs);
  - the mainnet `resolutionFeeBps` (if it is 0, CTF-004/007 have no current value at stake);
  - whether mainnet MMs have used legacy `createCondition` with an external oracle.
- **Off-chain behaviour not fully reviewed:**
  - whether the API's order-acceptance path has some other gate that would stop matching on a market with 3+ outcomes but 2 registered positions (I found none in the indexer, `get_complement_position` or the market model);
  - whether the frontend lists nested (`parent != 0`) markets. The API does not filter them by default.
- **Nothing was run.** No test or PoC was executed (role constraint), including `BatchSubmissionBugRepro`.
- **Regression checklist (`audit/00-scope.md`).** Only the CTF-relevant item was rechecked:
  - CRITICAL-1: the price-sum checks are present (`SettlementFacet.sol:602, 696`), but the property "Diamond cannot become under-collateralised" is **open** again through CTF-001.
  - NEW-2…NEW-5 and REMAINING-1…3 are settlement/signature items outside this dispatch and were not rechecked.

## 10. Notes (hygiene; not findings)

- **Events:**
  - `PayoutRedemptionFeePaid` is emitted even when `feeAmount == 0` (`ConditionalTokensFacet.sol:261`).
  - The MM creation paths emit `ConditionCreated` but not `ConditionPreparation`.
  - Settlement-created and settlement-destroyed sets emit no `PositionSplit`/`PositionsMerge`, only ERC-1155 transfer events.
- **Wrong comments and NatSpec:**
  - `cancelCondition` NatSpec says the condition "won't be resolved" (`ConditionManagerFacet.sol:187`). It will be.
  - `scripts/setup-test-market.js:154` says "[1] = YES indexSet, [2] = NO". That contradicts the oracle (slot 1 = YES = index set 2).
  - `16-mint-position-tokens.js:79`, `13-setup-test-market.js:134` and `18-mint-more-position-tokens.js:67` pass `[0, 1]`, which reverts `InvalidIndexSet`. These scripts are stale.
  - The `fuzz_redeem` comment says the fee "is normally 0", but the constructor sets 100 bps (`DoefinInvariantHarness.sol:505` vs `:1082-1086`).
- **Gas:**
  - `getCollectionId` uses a generic 254-step `expMod` per `sqrt` (around 2–3 sqrts per ID, and 4 or more IDs per Mint/Merge settlement). The upstream addition chain is far cheaper.
  - `redeemPositions` copies the full numerator array from storage to memory for every index set (`:178`).
- **Dead code:** the `modulus == 0` branch in `expMod`.
- **Collection-ID edge cases:**
  - Parent `−H(c,s)` gives the identity point, so the collection ID is `bytes32(0)` and the token `pos(T, 0)` is reachable but inert. Never give collection 0 any meaning beyond "root".
  - Parent IDs with bit 255 set are aliases of bit 254 (`LibCTHelpers.sol:47`). That gives distinct parent position IDs for the same point. It is value-neutral, but it can pre-empt nested registrations.
- **Storage:** `OracleAdapterStorage` has no `__gap` (oracle scope).
- **Pragma:** `ConditionalTokensFacet` uses floating pragma `^0.8.6`; the rest use `^0.8.20`. The build pins 0.8.20.
