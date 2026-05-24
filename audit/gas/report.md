# Domain 2 — Gas Optimization Report

**Pinned commit:** `015097c1c7f8b6a5d70be21972eb345bf1082c06`
**Baseline:** `npm run audit:gas` (`L2: base` mode), `npm run audit:size`. Raw report at `audit/output/gas/gas-report.txt`.

## Baseline measurements

| Function | L2 exec avg | L2 exec min/max | L1 data avg | Calls |
|---|--:|--:|--:|--:|
| `matchOrders` | 232,753 | 150,873 / 454,925 | 12,867 | 37 |
| `fillOrder` | 126,769 | — | 6,600 | 1 |

**Sizes:** all in-scope facets well under EIP-170. `SettlementFacet` largest at 13.302 KiB deployed (10.7 KiB headroom). No size go/no-go blocker. (`DoefinInvariantHarness` initcode 73.5 KiB — audit-only, out of scope.)

## Findings (`domain: gas`, severity capped at MEDIUM)

### GAS-001: Four dead `DoefinOrder` fields inflate Base-L2 calldata on every settlement
- **severity:** medium | **decision:** fix | **upgrade-safe:** no (ABI/EIP-712 change)
- **location:** `contracts/libraries/LibDoefinOrder.sol:18-34, 41-59, 78-99, 149-170`
- **description:** `DoefinOrder` has 15 fields; `minFillAmount` (check removed in SCRUM-121/122), `orderType`, `quoteCurrency`, `exchangeRate` (cross-currency, excluded per SC-006) are never read by any in-scope settlement logic — repo-wide grep confirms zero reads. 128 dead calldata bytes per order.
- **impact:** Base L2 charges L1 data fee per calldata byte; `matchOrders` L1-data is dominated by order structs. ~27% of order-struct bytes are dead.
- **recommendation:** Remove the four fields from the struct, typehash, and both hash functions. Breaking EIP-712/ABI change — must be coordinated byte-for-byte with the backend (`encoder.py`, `models.py`, `settlement_abi.py`). Mainnet is a fresh deploy with no in-flight orders — now-or-never, zero migration cost.
- **est. saving:** ~2.8–3.4k L1 gas-equiv per `matchOrders` pair + ~0.25–0.6k L2.
- **triage:** if Security/Business-Logic wants `minFillAmount` restored, this defers — `conflicts-with` at triage.

### GAS-002: `_determineMatchType` / `_getIndexSet` re-resolve the same registry slots in Mint/Merge
- **severity:** medium | **decision:** fix | **upgrade-safe:** yes
- **location:** `SettlementFacet.sol:370-381, 504-506, 551-553, 659-671`
- **description:** ~9-12 redundant warm SLOADs per Mint/Merge — `marketKeyByPositionId`/`marketsByKey`/`conditionIdByPositionId` re-read across `_isBinaryComplement` and two `_getIndexSet` calls.
- **recommendation:** Resolve market metadata once per maker iteration into a `MatchContext` struct returned by `_determineMatchType`; `_getIndexSet` stays the source of truth — collapses repeated reads only, weakens no validation.
- **est. saving:** ~0.6–1.2k L2 per Mint or Merge.

### GAS-003: Settlement-path fee transfers not coalesced (down-scoped)
- **severity:** medium | **decision:** fix | **upgrade-safe:** yes
- **location:** `SettlementFacet.sol:440-453, 485-521, 544-587`
- **description:** `_settleMerge` already coalesces fees into one transfer; `_settleComplementary`/`_settleMint` do not. On close reading most batching is blocked by distinct debtors (two separate SCWs) — actionable residue is narrow: coalesce only same-(token,debtor,recipient) transfers.
- **recommendation:** Coalesce same-(token,debtor,recipient) transfers only; keep all `SafeERC20` wrappers. Triage may down-scope or merge with GAS-002.
- **conflicts-with:** any Security finding relying on per-leg transfer events.

### GAS-004: `_computeFee` re-resolves `AppStorage` / `unitPerPair` per call (2× per maker)
- **severity:** low | **decision:** fix | **upgrade-safe:** yes
- **location:** `SettlementFacet.sol:123-124, 633-647, 420-422, 471-473, 539-541, 598-600`
- **description:** Same `unitPerPair` slot SLOAD'd 3× per maker (twice in `_computeFee`, once in `_settleX`).
- **recommendation:** Read `unit` + `feeReceiver` once at the top of the maker loop, pass into `_computeFee` (becomes `pure`) and `_settleX`. Keep `_computeFee`'s `feeRateBps <= MAX_FEE_RATE_BPS` and `price <= unit` checks.
- **est. saving:** ~0.3–0.5k per maker.

### GAS-005: `optimizer runs=1` is a size compromise the in-scope facets do not need
- **severity:** medium | **decision:** fix | **upgrade-safe:** n/a (build config)
- **location:** `hardhat.config.js:23`
- **description:** `runs=1` minimizes bytecode at runtime-gas cost. `SettlementFacet` has 10.7 KiB of EIP-170 headroom — size is not the binding constraint, so `runs=1` is the wrong tradeoff for a contract whose hot paths run on every trade.
- **recommendation:** `sc-developer` sweeps `runs ∈ {200, 1000, 100000}`; for each run `npm run audit:size` (reject any value pushing a facet over limit) then `npm run audit:gas`; pick the highest surviving `runs` that beats baseline. Do not raise blindly.
- **est. saving:** ~1–10% L2 exec on `matchOrders`/`fillOrder` — must be measured.

### GAS-006: `matchOrders` double-walks `makerFillAmounts`
- **severity:** low | **decision:** fix | **upgrade-safe:** yes
- **location:** `SettlementFacet.sol:93-99, 112-134`
- **description:** A pre-sum loop over `makerFillAmounts` then the main maker loop — the first loop is pure overhead.
- **recommendation:** Accumulate `totalMakerFill` inside the main loop, assert equality after. Per-maker and taker `_checkFillAmount` independently bound every fill, so deferring the sum assert is safe.
- **conflicts-with:** any finding wanting the sum check as a fail-fast pre-mutation guard.

### GAS-007: `unchecked` opportunities in provably-non-overflowing hot-path arithmetic
- **severity:** low | **decision:** fix | **upgrade-safe:** yes
- **location:** `SettlementFacet.sol:95, 112, 665` (loop `++i`), `:329, 480, 571, 644` (guarded subtractions)
- **description:** Loop counters and four specifically-guarded subtractions (`orderAmount-filled`, `fillAmount-makerCollateral/makerPayout`, `unit-price`) pay needless 0.8 overflow checks.
- **recommendation:** `unchecked` only the loop increments + the four guarded subtractions. KEEP the `revert` guards (the `unchecked` is sound because of them). Do NOT `unchecked` the fee/collateral multiplications — those can genuinely overflow.

## Not raised (considered safe / optimal)
- `LibSettlementStorage` / `AppStorage` packing already optimal; `__reserved_scrum89_*` placeholders must not be removed (slot-offset hazard).
- `SettlementFacet` already uses `hashOrderCalldata` (no calldata→memory copy).
- `nonReentrant` → transient storage (EIP-1153) would save ~2k/call but is a security-sensitive change — flagged to `sc-manual-reviewer`/triage, not raised here.

## Summary

Highest value: **GAS-001** (Base-L2 calldata — permanent per-trade saving, coordinate with backend before the fresh deploy) and **GAS-005** (one-line lever over every hot-path call). No optimization recommends removing a safety check. No in-scope facet exceeds EIP-170. GAS-001/GAS-005 deltas are estimates — re-run `audit:gas`/`audit:size` after applying.
