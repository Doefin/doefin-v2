# Manual review — dead-code clusters A-2 and A-3..6

source: manual-reviewer
scope: Doefin v3 Diamond, branch `SCRUM-213-MultiSigSetupForContractAdmin`
date: 2026-05-23

---

## Cluster A-2 — `LibCTFCondition.enforceConditionIsActive(bytes32)`

**Location:** `/Users/reza/workspace/predexyo/doefin-v2/contracts/libraries/LibCTFCondition.sol:294-299`

**Verdict: DELETE IS UNSAFE — there IS a missing safety invariant.**

The function is dead because nobody calls it, but the lifecycle state it guards (`Condition.active`) is real, mutable, and writable by `ConditionManagerFacet.cancelCondition`. Settlement currently makes no use of that flag. Deleting the helper without first wiring it in erases the breadcrumb to a missing check.

### Load-bearing evidence

1. **The flag exists and is writeable.**
   - `LibDoefinStorage.sol:113-118` declares `struct Condition { ...; bool active; ...; }`.
   - `ConditionManagerFacet.sol:82` (in `createConditionWithMetadata`) and `:162` (in `createCondition`) initialise it to `true`.
   - `ConditionManagerFacet.sol:197-214` exposes `cancelCondition(bytes32)` which sets `cond.active = false` (callable by the condition creator or the Diamond owner).

2. **No settlement path consults `active` or `payoutDenominator`.**
   - `SettlementFacet._validateOrder` (`SettlementFacet.sol:341-371`) checks: cancelled-order hash, stale nonce, low salt, expiration, side range, collateral allow-list, `unit != 0`, `price <= unit`. **It never resolves a conditionId from the order's `positionId`, never reads `conditions[cid].active`, and never reads `payoutDenominator[cid]`.**
   - `_determineMatchType` (`:400-416`) only inspects `positionId` / `side` and the position registry; no condition lifecycle is consulted.
   - `_executeOperatorFill` (`fillOrder` path, `:722-766`) likewise inspects no condition state.
   - `grep payoutDenominator contracts/` (run during this review) shows the symbol is read only in `ConditionalTokensFacet.redeemPositions` and written only in `LibCTFCondition._reportPayouts`. Trading is therefore not gated on resolution.

3. **The conditionId is trivially reachable from a positionId.**
   `LibDoefinStorage.sol:140` and `LibPositionRegistry.sol:76,155` show `positionRegistry.conditionIdByPositionId[positionId] -> bytes32 conditionId`. `_settleMint` / `_settleMerge` already use this lookup at `SettlementFacet.sol:814`. So adding a check costs one extra SLOAD in the worst case (already warm for Mint/Merge — they read the same slot in `_conditionAndPartition`).

4. **The contradictory comment is itself a smell.**
   `ConditionManagerFacet.sol:187` ("Existing positions remain tradeable but condition won't be resolved") explicitly states that cancellation does NOT block trading. That's a deliberate design statement, but it's also the wrong default for a prediction market:
   - A cancelled condition will never be resolved -> the position tokens are economically dead, but the orderbook can still settle signed orders against them at any non-zero price.
   - The cancellation event is silent to off-chain signers — anyone who signed an open buy order before cancellation is exposed to settlement at the operator's discretion long after the underlying market has been killed.
   - A compromised operator can deliberately route fills against cancelled markets to extract collateral from unsuspecting users.

### Exploit sketch (compromised-operator class)

1. Market creator (or owner) calls `cancelCondition(cid)` after a buyer has signed an open order for `positionId = P` at price `0.9 * unit`.
2. The buyer assumes their order is "dead" because off-chain UI hides cancelled markets.
3. Compromised operator submits `matchOrders` pairing the buyer's still-valid signature against a controlled seller's order at the same price.
4. The buyer is debited `0.9 * unit * fill` for position tokens of a market that will never resolve. The seller (controlled by attacker) walks away with the collateral. Position tokens for the cancelled condition can never be redeemed for anything — they are economically zero.

A similar exploit works after `_reportPayouts` resolves a condition: the loser of the now-resolved market gets their pre-resolution signed order settled at a price strictly worse than the now-known truth value (`P_winner = 1.0`, `P_loser = 0.0`).

### Suggested fix

Wire `enforceConditionIsActive` into `SettlementFacet._validateOrder`, derived from `positionId`:

```solidity
// In _validateOrder, after the existing checks:
LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
bytes32 cid = ds.positionRegistry.conditionIdByPositionId[uint256(order.positionId)];
if (cid == bytes32(0)) revert Errors.InvalidPositionId();
LibCTFCondition.enforceConditionIsActive(cid);
// Strongly recommended: also reject orders for an already-resolved condition.
if (ds.conditionalTokens.payoutDenominator[cid] != 0) revert Errors.ConditionAlreadyResolved();
```

Considerations:
- `_validateOrder` is called once per maker + once per taker; the cost is one SLOAD for the registry lookup and one for the `.active` field. On the Mint/Merge paths, the registry slot is re-used later in `_conditionAndPartition` — no double-charge.
- Add `cond.active = false` to also block `fillOrder` (currently unused in production per `SettlementFacet.sol:255` but reachable).
- Decide policy explicitly: should already-resolved markets be settle-able to drain residual outstanding orders, or hard-blocked? My recommendation is hard-block. The Polymarket V2 CTF Exchange takes the same posture (it routes through CTF redemption rather than orderbook fills once resolved).

### SWC mapping

SWC-123 (Requirement Violation — missing precondition). Also touches the OWASP SCSVSv2 G3.1 (state-transition validation on critical assets) and Top-10 #4 (Insecure Direct Function Calls / Missing Access Control), since cancellation is the access-controlled lifecycle event that downstream call sites are failing to honour.

### Severity

HIGH (compromised-operator class — same risk profile as MEDIUM-2 / NEW-5 in the prior SC-008 reviews). Funds at risk: any user with an open signed order against a cancelled or resolved condition.

### Recommendation summary

Do **not** delete `enforceConditionIsActive`. Either:
- (preferred) wire it into `_validateOrder` together with a `payoutDenominator == 0` check, OR
- track a separate Settlement-managed "tradeable" flag with explicit lifecycle events,

and emit an `OrderRejectedConditionInactive` event when the new revert fires so the off-chain orderbook can prune stale orders.

---

## Cluster A-3..6 — `LibConditionMetadata.{encodeDifficultyThreshold, encodeDifficultyRange, encodeBlockCount, encodeMiningDuration}`

**Location:** `/Users/reza/workspace/predexyo/doefin-v2/contracts/libraries/LibConditionMetadata.sol:36-67`

**Verdict per cluster: DELETE CLEANLY.** The encoders are dead by design — encoding happens off-chain.

### Load-bearing evidence

1. **`createConditionWithMetadata` accepts ALREADY-ENCODED bytes.**
   `ConditionManagerFacet.sol:49-55` — `bytes calldata metadata`. The facet then `decode*`s it (e.g., line 88: `decodeDifficultyThreshold(metadata)`) and routes to the appropriate validator. There is no on-chain `encode*` call site because the caller hands in the encoded payload.

2. **Off-chain encoder exists in the JS test/admin tooling.**
   `/Users/reza/workspace/predexyo/doefin-v2/test/utils/oracleAdapterUtils.js:19-22`:

   ```js
   function encodeDifficultyThreshold(threshold, targetBlockHeight) {
     const abiCoder = ethers.utils.defaultAbiCoder;
     return abiCoder.encode(["uint256", "uint256"], [threshold, targetBlockHeight]);
   }
   ```

   The admin script `scripts/admin-scripts/4b-create-condition-with-metadata.js:7-11` imports `encodeDifficultyThreshold`, `encodeDifficultyRange`, `encodeBlockCount`, `encodeMiningDuration` from that file and uses them to build the `metadata` bytes BEFORE calling `diamond.createConditionWithMetadata(...)` (line 122). This is the production code path.

3. **No on-chain setter or wrapper consumes the typed parameters.**
   `grep encodeDifficultyThreshold|encodeBlockCount|encodeMining|encodeDifficultyRange contracts/` returns only the four library definitions themselves — zero callers anywhere in `contracts/`. There is no facet that takes typed parameters and would need an on-chain encoder.

4. **The event surface confirms off-chain encoding.**
   `Events.sol:73-80` (`ConditionCreated`) emits `metadataURI` (an off-chain string pointer) and the indexed `conditionId` / `oracle` / `questionId`. It does NOT emit the typed parameters. The typed parameters surface via a separate `*QuestionCreated` family of events emitted from `LibOracleAdapter` (which the backend's `block-indexer` and `orderbook-service` parse — see `doefin-backend/orderbook-service/app/events/event_handler.py:354-372`). On-chain encoders would be a defence-in-depth layer the contract has never used.

5. **No Python encoder in `doefin-backend` calls or mirrors `encodeDifficulty*`.**
   `grep encode_difficulty|encodeDifficulty|encode_block_count doefin-backend/` returns zero hits. The backend never constructs the metadata — it indexes the typed parameters out of the `*QuestionCreated` events, which `LibOracleAdapter` emits with the already-decoded typed fields. So even the backend pipeline doesn't need an on-chain encoder.

### Why "defence-in-depth" is NOT a reason to keep them

The decoders (`decode*`) are the trust boundary: `createConditionWithMetadata` MUST trust that the off-chain encoder produced bytes the decoder accepts. If the off-chain encoder is wrong, `abi.decode` will revert or produce garbage, but the validators (`validate*`) gate the garbage on numerical bounds. The on-chain `encode*` helpers would only matter if a Solidity caller wanted to construct the bytes, and there is no such caller. Keeping them as "documentation" of the layout is weaker than keeping the natspec on the decoders.

### Severity / recommendation

INFORMATIONAL. Safe to delete all four. ~60 lines reclaimed, no functional impact, no off-chain integration impact.

If the team wants to preserve the layout as an on-chain readable spec, replace the four functions with a single natspec block on the decoders documenting the `abi.encode` schema. Cheaper and clearer.

### SWC mapping

SWC-131 (Unused Variables / Dead Code). Top-10 N/A.

---

## Verified Safe (during this review)

- `LibConditionMetadata.decode*` and `validate*` are reached from `ConditionManagerFacet.createConditionWithMetadata` — kept correctly.
- `LibPositionRegistry.conditionIdByPositionId` is populated on `splitPosition` and is the correct primary key to derive a conditionId from a positionId — the proposed A-2 fix is wirable today without a new index.
- `cancelCondition` is correctly access-gated (creator OR owner) and is idempotent (reverts `ConditionAlreadyInactive` on a second call). The vulnerability is downstream, not in `cancelCondition` itself.
- `_validateOrder` already short-circuits on cancelled order hash, stale nonce, expiration, and price/unit invariants — the proposed condition-state check composes cleanly with that block.

---

## Invariant & PoC candidates

These belong in the fuzzing harness if they aren't already covered:

1. **`matchOrders` MUST revert when the condition is inactive.**
   Sketch:
   - Create condition, prepare splitPosition seeding (so the position is registered).
   - Sign a buy + sell order pair, valid.
   - Call `cancelCondition`.
   - Call `matchOrders` with the still-valid signatures and fillAmount > 0.
   - Expected: revert. Today: succeeds.

2. **`matchOrders` MUST revert when the condition is resolved (`payoutDenominator != 0`).**
   Same shape; resolve via `_reportPayouts` instead of `cancelCondition`.

3. **`fillOrder` MUST revert under both of the above states.**
   Even though `fillOrder` is currently unused in the backend, it is reachable by the operator role.

4. **Round-trip property for `LibConditionMetadata`:** `decode(jsEncode(x)) == x`. This is the contract the off-chain encoder must satisfy and would be a fast property-based test against the JS encoder in `test/utils/oracleAdapterUtils.js`.

---

## Cross-references

- Files inspected (absolute paths):
  - `/Users/reza/workspace/predexyo/doefin-v2/contracts/libraries/LibCTFCondition.sol`
  - `/Users/reza/workspace/predexyo/doefin-v2/contracts/libraries/LibConditionMetadata.sol`
  - `/Users/reza/workspace/predexyo/doefin-v2/contracts/libraries/LibDoefinStorage.sol`
  - `/Users/reza/workspace/predexyo/doefin-v2/contracts/libraries/LibPositionRegistry.sol`
  - `/Users/reza/workspace/predexyo/doefin-v2/contracts/libraries/Events.sol`
  - `/Users/reza/workspace/predexyo/doefin-v2/contracts/facets/SettlementFacet.sol`
  - `/Users/reza/workspace/predexyo/doefin-v2/contracts/facets/ConditionManagerFacet.sol`
  - `/Users/reza/workspace/predexyo/doefin-v2/scripts/admin-scripts/4b-create-condition-with-metadata.js`
  - `/Users/reza/workspace/predexyo/doefin-v2/test/utils/oracleAdapterUtils.js`
