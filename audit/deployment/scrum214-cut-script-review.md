# SCRUM-214 Safe cut: pre-deployment review of the upgrade scripts

**Scope.** I read the following:
- `scripts/upgrades/upgrade-scrum214-hardening.js`
- `scripts/upgrades/rehearse-scrum214-fork.js`
- `scripts/upgrades/upgrade-scrum521-oracle-reorg-underflow.js`
- `scripts/lib/safe-multisend.js`
- `scripts/lib/bitcoin-headers.js`
- `hardhat.config.js` and `package.json`
- the 6 facets in the cut and the facets outside it
- the libraries: LibCTFCondition, LibOracleAdapter, LibERC1155, LibPositionRegistry, LibReentrancyGuard, LibConditionMetadata, LibDoefinBlockHeaderOracle, BlockHeaderUtils, LibOrderValidity, LibAccessControl, LibDiamond
- `LibAdminConfigStorage`, `LibDoefinStorage`, the storage snapshot and its test, and `DiamondInit`
- the SCRUM-521 deployment records
- protocol-kit 5.2.27 internals, as installed
- the block-indexer and match-engine transaction code, and the frontend anvil seed

The review was read-only. I ran no tests, deployed nothing and sent no transactions.

**Limits.**
- This session had no shell, so I could not run `git log -p`.
- I could not read live chain state. Every claim that depends on either is marked "not verified".

**The target moved during the review.** `rehearse-scrum214-fork.js` and `package.json` changed on disk while I was reading them. A Base Sepolia profile and an `upgrade:scrum214:rehearse:sepolia` script appeared. Neither was in the initial git status, so both are uncommitted relative to `bb86b65`. I re-read the files at the end, and the findings cite those final versions. `upgrade-scrum214-hardening.js` did not change between my first and last read.

## Bottom line

**No data loss and no layout conflict.** I found nothing in the cut that moves, overwrites or misreads existing storage, and nothing that strands or mis-routes a selector:
- 51 selectors are moved: 47 Replace and 4 Add.
- No facet outside the cut inlines library logic that changed.
- The Safe MultiSend is atomic.

**The real risks are in how the ceremony runs and how much is verified:**
1. The post-check will probably abort after the cut has executed on a live network, and then the deployment record is never written (M-1). This is the same failure as the SCRUM-521 mainnet run.
2. When resuming after a partial failure, the script accepts any address that has code (M-2).
3. The first live use of the exact-retarget rule (block 973728, about 2026-10-30) depends on legacy data that is only checked for being non-zero (M-3).

No Critical or High.

---

## Findings, ranked

### M-1: The post-check compares live state with strict equality, so it will probably throw after the cut executes, and no record is written

- **Severity:** Medium (operational; no on-chain damage)
- **Location:**
  - `upgrade-scrum214-hardening.js:191-196`: the "before" snapshot.
  - `:330-343`: strict `JSON.stringify` equality, which throws on any difference.
  - `:345-371`: the record is written only after every check passes.
  - `upgrade-scrum521-oracle-reorg-underflow.js:94-106`: `readOracleState` is three unpinned reads inside `Promise.all`.
- **Trigger:**
  - Between the snapshot and the post-check, the script:
    - deploys 7 contracts with 2 confirmations each;
    - runs explorer verification on each (`:110`; it can take tens of seconds, and failures are swallowed);
    - proposes to the Safe service and executes.
  - The block-indexer submits a header whenever Bitcoin mines one. The chance of at least one header during the window is roughly 1 − e^(−minutes/10): about 18% at 2 min, 40% at 5 min, 63% at 10 min, and close to 100% if the mainnet Safe has to wait for co-signers.
  - A new header changes `height`, `nextBlockIndex` and `tip`. At a settlement height (973734 on Sepolia) it also increments `totalQuestionsResolved`.
  - Any market maker creating a market increments `totalQuestionsCreated`.
  - A single read of `getMaxOracleStaleness()` (`:339`) that hits a lagging replica, where the selector is not yet routed, reverts after the cut.
- **Impact:**
  - The cut is on chain, but the script exits 1 with "Oracle state changed during the cut — investigate" and never writes `deployments/<net>/scrum214-hardening-*.json`.
  - This already happened on 2026-09-23. `deployments/base/scrum521-oracle-upgrade-2026-09-23T13-48-33Z.json:2` was rebuilt by hand.
  - It invites a panicked rollback or a second run (see I-4).
  - The rehearsal cannot show this, because a fork does not change on its own.
- **Fix:**
  1. Write the record, marked as post-check pending, as soon as the execution receipt is confirmed with status 1.
  2. Pin the post-check reads to the cut's block (`{ blockTag: receipt.blockNumber }`), and pin "before" to `receipt.blockNumber - 1`. Alternatively, assert that the cut receipt carries no `BlockSubmitted`, `ConditionResolution` or `QuestionCreated` logs, and only require that height and totals have not decreased.
  3. Poll `getMaxOracleStaleness` the way the routing check already polls.
  4. Add a `POST_CHECK_ONLY` mode that rebuilds the record from a given cut tx hash.

### M-2: On resume, a reused address is accepted if it has any code; a stale or swapped address is cut in and every post-check still passes

- **Severity:** Medium
- **Location:**
  - `upgrade-scrum214-hardening.js:99-104`: the reuse branch only checks `getCode != "0x"`.
  - `:272-280`: the deploy loop.
  - `:318-329`: the post-check only proves routing.
  - `:353`: the record.
- **Trigger:** A resume after a partial failure, where either:
  - `NEW_<FACET>_FACET_ADDRESS` comes from an earlier attempt built from an older commit (the tree was being edited during this review), or
  - two env names are swapped, for example `NEW_ERC1155_FACET_ADDRESS` and `NEW_CONDITIONAL_TOKENS_FACET_ADDRESS`.

  The plan is computed from the local artifact's ABI, not from the reused contract.
- **Impact:**
  - Selectors can be routed to code that does not implement them. Those calls revert, so split, merge, redeem or `matchOrders` stay down until another Safe cut.
  - Alternatively, older code is silently reinstated, which re-opens CTF-001 and ORC-001.
  - In both cases the script reports success and writes a record. The oracle, fee and question-total post-checks go through other facets, so they cannot catch this.
  - Separately, if `NEW_ORACLE_FACET_ADDRESS` is reused without `BLOCK_HEADER_UTILS_ADDRESS`, a fresh BlockHeaderUtils is deployed and recorded (`:272`, `:353`), but the reused facet is linked to a different library. The record is then wrong.
- **Fix:**
  - For each reused address, compare `getCode(addr)` with the artifact's `deployedBytecode`, after filling `deployedLinkReferences` with the library address. With `bytecodeHash: "none"` and no immutables, the comparison is exact. The SCRUM-521 mainnet record says this check was done by hand.
  - Require `BLOCK_HEADER_UTILS_ADDRESS` whenever `NEW_ORACLE_FACET_ADDRESS` is set, and check that it is the library linked into the facet.
  - Print `export NEW_…=` lines after each deployment.

### M-3: The exact-retarget check at 973728 uses a legacy value that is only checked for being non-zero, and nothing checks that the oracle is on the canonical chain before the cut

- **Severity:** Medium (low likelihood, high impact)
- **Location:**
  - `contracts/facets/DoefinV1BlockHeaderOracleFacet.sol:323-348`, especially `:334-341`: reads `blockHeightToTimestamp[height - 2016]` and requires the exact nBits, otherwise it reverts `UnexpectedDifficulty`.
  - The pre-cut code wrote that mapping through `LibOracleAdapter.sol:455-459`.
  - `rehearse-scrum214-fork.js:369-373`: the rehearsal only checks `recorded > 0`.
  - The upgrade pre-flight (`:191-201`) has no check that the oracle tip is canonical or how far it lags.
- **Trigger:**
  - The first header at a period boundary after the cut will be 973728, about 2026-10-30 (`audit/follow-ups.md:24-25`).
  - It is the first live run of the exact-retarget branch on either Diamond.
  - Its only legacy input is the timestamp that the pre-cut facet recorded for 971712.
  - If that value, or the stored tip's nBits, differs from Bitcoin's, every header from 973728 on is rejected.
- **Impact:**
  - The oracle freezes on every Diamond that has been cut — on both, if both are cut before 10-30 — until another facet cut.
  - Sepolia's 3 questions at 973734, and every later resolution, stall. This is the same class of failure as SEC-015.
  - Likelihood is low: the arithmetic matches Bitcoin Core, 10 real boundaries are tested, and the old code writes the mapping from the header it has just applied. The impact is high and the check is cheap.
- **Fix:** On both networks, before the cut:
  - Assert that `getBlockTimestamp(971712)` equals mempool.space's header timestamp for 971712, and that all 17 ring headers equal the canonical hashes. `scripts/lib/bitcoin-headers.js` already has `headerAt`.
  - Back-test the live data with `BlockHeaderUtilsHarness`: `encodeCompact(nextPeriodTarget(decode(nBits@971711), onchainTs@969696, ts@971711))` must equal the real nBits@971712.
  - Run `npm run oracle:status:<net>` before the cut, not only after it.
  - Keep a contingency oracle facet ready.
  - If timing allows, let Sepolia cross 973728 before mainnet is cut. This is the owner's call: ORC-001 is still live on mainnet.

### L-1: Gaps in how the Safe ceremony handles failures (`scripts/lib/safe-multisend.js`)

- **(a) The execution result is not checked** (`:146-153`). protocol-kit 5.2.27's `wait` is viem's `waitForTransactionReceipt` (`dist/src/contracts/utils.js:300-307`), which returns a reverted receipt without throwing. Nothing checks `status` or the `ExecutionSuccess` event, so a revert shows up 30 s later as a misleading routing error.
- **(b) A threshold above 1 can break the run** (mainnet threshold not verified). If the last co-signer executes from the Safe UI, the script still calls `executeTransaction` (`:146`). That throws because the nonce is used, after the cut has executed, so there is no post-check and no record.
  - Fix: re-read `apiKit.getTransaction(safeTxHash)`; if `isExecuted`, take its `transactionHash` and continue.
- **(c) A failed attempt leaves a signed transaction behind.**
  - The nonce comes from the Safe's on-chain nonce (protocol-kit `utils/transactions/utils.js:39`).
  - After any failure past `proposeTransaction` (`:110-116`), a fully signed 1-of-1 Safe transaction stays in the public service queue, and anyone can execute it.
  - A re-run proposes a second transaction at the same nonce. Whichever executes first wins, possibly with facets from another build.
  - Fix: in pre-flight, refuse to proceed if `getPendingTransactions` shows anything at the current nonce. After an aborted attempt, reject the pending transaction on chain.
- **(d) Safe API reachability, Safe version and threshold are only discovered after all 7 deployments,** because the helper is first called at `:296`.
  - Fix: initialise the protocol and API kits and print `VERSION()` and the threshold during pre-flight.

### L-2: The build being deployed is not pinned

- `hardhat run` deploys whatever the working tree compiles to.
- The record (`:345-364`) has no commit SHA, no clean-tree flag and no bytecode hashes.
- The tree changed during this review. The rehearsal at fork block 52848576 vouches for whatever tree it ran on, not for the one that will be deployed.
- **Fix:**
  - On non-local networks, refuse to run on a dirty tree (ignoring `audit/` and `deployments/`).
  - Record `git rev-parse HEAD`, the solc settings, and keccak256 of each runtime bytecode.
  - Have the rehearsal print the same hashes so the two runs can be compared.

### L-3: Pre-flight assumes AdminConfig slot 5 is zero without reading it; the history check is still outstanding

- **Severity:** Low
- **SWC / OWASP:** SWC-123 / SC03
- **Location:** `upgrade-scrum214-hardening.js:227-230`, which uses `: 0` without a read.
- **What breaks if the slot is not empty:**
  - If `base+5` (`0xf40d4f44…200b3905`) held data from a field that was later removed, `_enforceOracleFresh` (`ConditionManagerFacet.sol:137-144`) would enforce that leftover value as the limit immediately.
  - A historic mapping at `base+6` would be read as `ResolutionFeeSnapshot{set,bps}` by `LibCTFCondition.sol:347-353`.
- **Evidence so far:**
  - The snapshot (`test/storage/storage-layout.snapshot.json:61-74`) is append-only after `accruedFees`.
  - The ledger (`audit/findings-ledger.md:264-265`) says two fields are appended relative to mainnet.
  - SCRUM-236 was reviewed on 2026-05-24 and the mainnet Diamond was deployed on 2026-05-25.
  - All of this is consistent with no field ever being removed. **Not verified:** I could not run `git log -p`.
- **Fix:**
  - In pre-flight, abort unless `getStorageAt(diamond, base+5) == 0`.
  - Run `git log -p -- contracts/libraries/LibAdminConfigStorage.sol test/storage/storage-layout.snapshot.json` back to each network's deploy date, and confirm no AdminConfigStorage member was ever removed.

### L-4: No oracle-health check before the staleness limit is turned on, and `MAX_ORACLE_STALENESS` can leak from `.env`

- **Location:** `:167-171` and `:288-290`.
- **Trigger and impact:**
  - `setMaxOracleStaleness(10800)` is bundled into the cut without checking how old the tip is.
  - If the indexer is lagging at cut time, every `createConditionWithMetadata` reverts `OracleAdapter_OracleStale` straight away.
  - The value is read from the environment, and dotenv is loaded at `hardhat.config.js:7`. If `.env` holds the mainnet value, the Sepolia run sets it too, although the runbook runs Sepolia without it.
- **Fix:**
  - In pre-flight, require that the tip is canonical and that its age is less than half the limit.
  - Pass `MAX_ORACLE_STALENESS=` explicitly in the Sepolia npm script.

### L-5: The rehearsal can give false confidence (`rehearse-scrum214-fork.js`)

- **(a) The Safe path never runs.** The rehearsal uses `impersonateOwner: true` (`:315`). In that mode the cut and the setter are two separate transactions (`upgrade :306-312`), so MultiSend encoding, atomicity, the Safe API and Safe execution are all untested.
- **(b)** The fork does not change on its own, so M-1 cannot appear.
- **(c)** Step 7 only checks `> 0` (see M-3).
- **(d) The Sepolia profile is new and uncommitted.**
  - The version I first read was hard-wired to Base mainnet: `BASE_MAINNET_DIAMOND` and `BASE_MAINNET_RPC_ENDPOINT` only.
  - The `PROFILES` block (`:43-61`) and `package.json:23` appeared during this review.
  - Only a committed, reviewed run of that profile counts as Sepolia evidence. The Sepolia DRY_RUN proves only the selector plan.
- **(e)** The rehearsal always sets 10800, which the Sepolia runbook does not.

### Informational

- **I-1. Stale documentation on pre-cut resolution fees.**
  - These places say conditions resolved before the cut "read the live rate":
    - the script header at `:23-24`;
    - the comment at `:197-198`;
    - `AdminConfigFacet.sol:128-130`;
    - `LibAdminConfigStorage.sol:63-67`.
  - The code charges 0 (`LibCTFCondition.sol:338-353`), and the rehearsal asserts 0 (`:248-254`).
  - There is no impact today, because the live rate is 0 bps on both chains. It matters if the owner later raises the fee expecting winners resolved before the cut to pay it.
- **I-2. ERC-165 IDs are not refreshed.** With `_init = 0`, `supportedInterfaces` keeps the old IDs for IAdminConfig and IConditionManager, whose selector sets change. A fresh deployment through `DiamondInit.sol:85,89` registers the new IDs. I found no consumer that depends on them.
- **I-3. The record lacks what a rollback needs.**
  - The pre-cut selector→facet map is computed (`plans[].oldFacets`, `:135`) but not saved.
  - A rollback is storage-compatible, because the old code ignores slots 5 and 6.
  - It must also Remove the 4 added selectors and restore the 11+1 oracle split.
- **I-4. A re-run after success is not detected.** The script deploys 7 contracts again and cuts again; nothing changes state, but it costs gas. Detect "already applied" by comparing bytecode.
- **I-5. Verification and funding.**
  - Explorer verification runs during the ceremony, is slow, and swallows failures (CR-HARDHAT-VERIFY). Use `SKIP_VERIFY=true` and verify afterwards.
  - There is no deployer-balance check. ethers v5's default 1.5 gwei priority fee overpays on Base, and running out of funds mid-sequence lands on the M-2 resume path.
- **I-6. `expectedAdds` only allows; it does not require.** It also matches by name. If an expected function were missing from the ABI, nothing would flag it. Assert set equality instead.
- **I-7. Effects on the backend and frontend.**
  - The block-indexer sets `gas = estimate` with no headroom (`block-indexer/app/utils/block_header_oracle_client.py:87-88`). A header transaction estimated against the old facet but mined after the cut can run out of gas once; the next cycle re-estimates.
  - The revert selectors the indexer special-cases keep the same error names (`Errors.sol:209-213`), so they are unchanged.
  - The match-engine's in-flight transactions have 20% gas headroom (`operator_wallet.py:155`).
  - The frontend anvil seed targets tip+500 (`doefin-frontend/tests/anvil/seed-market.ts:112,154`). After the Sepolia cut that reverts `OracleAdapter_DifficultyAlreadyDecided` most of the time, and FE-ANVIL-LEGACY-CONDITION does not cover it.

---

## Checked and found sound

### Storage and existing data

- **AdminConfig layout.** Two members are appended at slots 5 and 6. No existing member moves. `ResolutionFeeSnapshot` fits in one slot. AppStorage's layout is unchanged and fills exactly its 256-slot region, so the namespaces do not overlap.
- **Existing state reads correctly after the cut:**
  - A condition resolved before the cut has no snapshot and is charged 0 (`LibCTFCondition.sol:351`).
  - An unresolved condition is charged the live rate. A voided one is charged 0.
  - The live rate is 0 on both chains, so the fee charged does not change at the cut.
  - `maxOracleStaleness` defaults to 0, which means disabled.
- **Oracle.**
  - The cut does not touch the ring buffer, the height or the pointer.
  - Median-time-past by height, and the retarget rule, read `blockHeightToTimestamp`. The old code wrote that mapping for every applied header, in the order ring write → height bump → `settleCondition`, and rewrote it on replays.
  - A zero entry only makes median-time-past more permissive, and at a boundary it selects the 4× clamp branch.
  - The mainnet rehearsal accepted 12 real headers.
- **Pending questions.**
  - No BlockCount question is pending on either chain.
  - Pending threshold questions are unaffected.
  - Questions skipped because their condition is already resolved are still counted as resolved, so created − resolved stays consistent.
- **Registry and settlement.**
  - Every registered market is a canonical root market: 29/29 on mainnet and 15/15 on Sepolia, per the ledger and follow-ups. So the CTF-003 gate (`SettlementFacet.sol:384-395`) and the full-partition guard (`:904-909`) accept every live market.
  - Open signed orders on registered positions can still be settled.
  - The internal lock check passes inside `nonReentrant`.
  - Error names are unchanged, so the indexer's guards still work.
- **No `_init` is needed.**

### Selector routing

- **Count.** 51 = 12 + 5 + 16 + 9 + 6 + 3. The 4 Adds are `voidCondition`, `setMaxOracleStaleness`, `getMaxOracleStaleness` and `getResolutionFeeBps`.
- **The SCRUM-521 split routing is cleaned up.** Today 11 oracle selectors sit on the old facet and `submitBatchBlocks` on the SCRUM-521 facet; after the cut both old facets are fully removed.
- **Facets outside the cut inline no changed logic:**
  - OracleAdapterFacet uses only `getTimestampBucket`, which is pure and unchanged, plus direct reads.
  - MarketDataFacet uses registry views, which are unchanged.
  - NonceManager, SignatureVerifier, SettlementAdmin and AccessControl import no SCRUM-214 library.
  - ERC1155ReceiverFacet imports no library.
- **Every caller of the changed write paths is in the cut.** That covers LibCTFCondition, LibERC1155, LibOracleAdapter and `_enforceEntered`. Only the oracle facet needs BlockHeaderUtils linked.
- **Guards.** The stranded-selector and unexpected-Add checks stop selectors from moving between facets and stop a cut against the wrong Diamond. LibDiamond's Replace followed by Add on the same new facet is correct.

### Ceremony

- **Atomicity.** protocol-kit 5.2.27 uses `safeTxGas = 0` for Safe ≥ 1.3.0 with gas price 0 (`utils.js:57-63`). An inner revert therefore reverts `execTransaction` (GS013), and gas estimation fails before anything is broadcast, so a partial cut cannot land. The NoChangeRequired pre-check prevents the one known self-inflicted revert.
- **Env mistakes fail before anything is deployed:**
  - the mainnet `DIAMOND_ADDRESS` on Sepolia: no code → abort (521 script `:88-90`);
  - the mainnet `SAFE_ADDRESS`: ≠ owner → abort (`:246`);
  - a `PRIVATE_KEY` that is not a Safe signer (`:250-252`);
  - an RPC for the wrong chain: chainId assertion (`:160-162`).

  The exceptions are M-2 and L-4.
- **Routing check.** The routing post-check polls, so replica lag does not trip it.
- **Re-run guard.** A re-run with the same `MAX_ORACLE_STALENESS` is caught.

### Not verified

- **Git history:** whether a field was ever removed from the AdminConfig namespace (L-3).
- **Live chain:**
  - the raw values in slots 5 and 6;
  - the mainnet Safe's version and threshold;
  - whether the Safe Transaction Service now requires an API key;
  - current oracle health;
  - the registry state after 10-20.
- **Bytecode:** that the facets outside the cut are byte-identical (no compile; I reasoned from imports only).

### Checklist mapping

- M-3 → SWC-113, OWASP SC02 / SC10.
- L-3 → SWC-123, OWASP SC03.
- The other findings are deployment tooling. No SWC-100 to SWC-136 item applies to the scripts.
- No contract-level Critical or High was found in the parts of the cut I reviewed.

---

## Disposition (2026-10-20, before the Base Sepolia cut)

The review ran read-only, without a shell. Its "not verified" items were then checked with read-only chain calls, on Base Sepolia (`0x2f03…Ae3f`) and Base mainnet (`0x71C4…Fdf9`):

- **Facets left out of the cut:** every facet routed on either Diamond was matched to its compiled artifact by selectors, and its runtime bytecode compared, ignoring the metadata and the linked-library slots. The six facets in the cut differ. Every other facet is byte-identical to `bb86b65`, so no facet outside the cut inlines changed code.
- **Storage:** the AdminConfig namespace was only ever appended to (`63c5f86` → `8175359` → `8f5b6bf` → `22c741a`).
  - The packed slot base+3 decodes to the live `getFees()` / `getMaxFeeRate()` values, which confirms the namespace location.
  - Slots base+5 and base+6 are zero on both chains, and so are base+7 to base+12.
  - The `resolutionFeeAtResolution` entry of every resolved condition is empty (mainnet 21, Sepolia 10).
- **Oracle data behind M-3:** on both chains all 17 stored headers are canonical Bitcoin blocks with their real timestamps recorded, and `blockHeightToTimestamp[971712]` equals the real header (1792154251). The retarget maths is covered on 10 real boundaries, including 969696 → 971712 (`test/data/retarget_boundaries/boundaries.json`).
- **Safe service:** both Safes are 1-of-1 v1.4.1+L2 with no queued proposals. Sepolia's owner is `0x4EB9…2894` (nonce 9) and mainnet's is `0x6f80…7670` (nonce 6). api-kit 2.5.11 needs no API key.
- **Explorer:** the Etherscan v2 key works for chainid 84532.
- **Mainnet resolution-fee history:** one `ResolutionFeeUpdated`, 500 → 0, at block 50476932. Sepolia's is the same at 45987304.

| Finding | Disposition |
|---|---|
| M-1 | Fixed in `5106c29`. The record is written as soon as the cut is mined, then updated with the post-check. State is compared at the block before the cut and now: an advance is noted, and only a regression or a fee change is a problem. Routing and the getter are polled. Both rehearsals land a header between the cut and the post-check and read the record back. |
| M-2 | Fixed in `5106c29`. Reused and freshly deployed addresses must carry exactly the compiled runtime code (the library linked, and the library's own call-protection address substituted). Reusing the oracle facet requires `BLOCK_HEADER_UTILS_ADDRESS`. Resume exports are printed. Tested on live Sepolia: the unchanged facet is accepted, and both the stale facet and a swapped address are refused. |
| M-3 | Verified on-chain (above) and now checked by the rehearsal (`eb58579`): the ring must be canonical with real timestamps before the cut, and the period-start timestamp must equal the real header. Whether to let Sepolia cross 973728 before the mainnet cut is the owner's call, weighed against ORC-001 being live on mainnet. |
| L-1 | Fixed in `f4211de`: receipt status and ExecutionSuccess are checked, the confirmed service copy is used when the threshold is above 1, an already-executed transaction is detected, the error explains how to recover, and `safePreflight()` runs before any deployment (`5106c29`). |
| L-2 | Fixed in `5106c29`: the record carries the commit SHA and any uncommitted paths. A mainnet cut refuses uncommitted changes under `contracts/` or `scripts/` (`ALLOW_DIRTY` overrides). |
| L-3 | Fixed in `5106c29` (pre-flight reads base+5 and base+6) and verified on both chains (above). |
| L-4 | Fixed in `5106c29`: the cut refuses `MAX_ORACLE_STALENESS` when it is below the tip's current age, and warns when the age is over half the limit. `.env` sets no `MAX_ORACLE_STALENESS`. |
| L-5 | Fixed in `eb58579`: a Base Sepolia profile (`npm run upgrade:scrum214:rehearse:sepolia`), the live-actor and record paths, and the oracle-data checks. The Safe path itself is not forked. It ran in production for SCRUM-521 on both networks, and the Sepolia cut exercises it before mainnet. |
| I-1 | Fixed in `5106c29` and `245760f`. |
| I-2 | Deferred (`audit/follow-ups.md` ERC165-INTERFACE-IDS). No frontend or backend code calls `supportsInterface`. |
| I-3 | Fixed in `5106c29`: the record has `previousRouting`. |
| I-4 | Fixed in `5106c29`: the cut refuses to run when every selector it adds is already routed (`FORCE_RECUT` overrides). |
| I-5 | Fixed in `5106c29`: the deployer balance is checked. Verification failures still warn and do not stop the cut (CR-HARDHAT-VERIFY). |
| I-6 | Accepted: selectors are planned from the ABI, and the unexpected-Add check fails closed. |
| I-7 | Noted in the CTF-MAINNET-CUT runbook (block-indexer gas) and FE-ANVIL-LEGACY-CONDITION (the anvil seed's near-tip target). |
