# Domain 4 — Complexity & Maintainability Findings

Audit subject: Doefin v3 Diamond, pinned commit `015097c1c7f8b6a5d70be21972eb345bf1082c06`.
Reviewer: `sc-complexity-analyst`. Phase 2, concurrent domain pass.

Scope per `audit/00-scope.md`: the v3 settlement core (`SettlementFacet`,
`SignatureVerifierFacet`, `NonceManagerFacet`), the admin/access/oracle-adapter
facets, and their libraries. Deploy mode is a **fresh deploy** — so a refactor
that changes storage layout or the selector set is *not* mainnet-blocking, but
it is still tagged `upgrade-safe: no` because it would break a future
`diamondCut` upgrade and `sc-developer` needs that signal.

Findings cap at MEDIUM (protocol rule). This domain reports maintainability, not
exploitable bugs — security-relevant observations are cross-referenced to the
owning domain rather than rated here.

Severity tally: 0 critical · 0 high · 1 medium · 6 low · informational in the appendix.

---

### CPX-001: Triplicated signature-recovery / verification logic across three facets

```
id:             CPX-001
domain:         complexity
severity:       medium
status:         new
decision:       fix
reverify:       pending
location:       contracts/facets/SettlementFacet.sol:252-297
source:         complexity
duplicate-of:   -
conflicts-with: -
regression-of:  REMAINING-1
swc:            -
title:          ECDSA recovery + s-malleability check is copy-pasted into three facets with subtle divergences
```

description:
ECDSA signature recovery — the 65-byte length check, the `r/s/v` assembly
unpack, the `v < 27` normalization, the EIP-2 low-`s` malleability bound, and
the `ecrecover` call — is implemented independently three times:

1. `SettlementFacet._verifySignature` (`SettlementFacet.sol:252-297`) — inline,
   `calldataload`, malleability check present, EIP-1271 done via a raw
   `staticcall` to `isValidSignature(bytes32,bytes)`.
2. `SignatureVerifierFacet._recoverSigner` + `_verifySignature`
   (`SignatureVerifierFacet.sol:129-196`) — `calldataload`, malleability check
   present, EIP-1271 done via the typed `IERC1271` interface.
3. `OracleManagerFacet._recoverSigner` (`OracleManagerFacet.sol:544-560`) —
   `bytes memory` / `mload` instead of calldata, **no `v` normalization and no
   malleability check at all**.

This is the prior reviews' LOW-3 / REMAINING-1, and it is still open. The
follow-up review confirmed both settlement copies carry the s-value fix, but the
verification was pairwise and missed the third copy in `OracleManagerFacet`.
Slither's `assembly` detector independently flags all three blocks
(`audit/output/slither/slither-report.txt:56-68`).

Two settlement copies are not byte-identical: `SettlementFacet` validates an
EIP-1271 signature with a hand-rolled `staticcall` + `abi.decode` of the magic
value, while `SignatureVerifierFacet` calls `IERC1271(...).isValidSignature`.
They are intended to be semantically equivalent; nothing guarantees they stay
that way.

The `0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0`
half-curve-order constant is a magic literal repeated verbatim in both
settlement facets.

impact:
This is the canonical "fix-one-miss-the-other" maintenance hazard, and it has
*already* happened: the malleability hardening landed in the two settlement
facets but not in `OracleManagerFacet`. Every future change to the signature
scheme (e.g. EIP-1271 v2 magic value, EIP-7702, a curve-parameter tweak) must be
applied in N places or the facets silently diverge. Divergence in a
signature-verification path is a security-grade risk; complexity here is a
direct attack-surface multiplier. The missing malleability check in
`OracleManagerFacet._recoverSigner` itself is a security defect — flagged here
only for cross-reference; `sc-manual-reviewer` owns its rating. `OracleManager`
is in scope per `00-scope.md`; Slither lists it as an `Ecrecover` contract.

recommendation:
Extract a single internal `LibSignature` library and route all three facets
through it. Sketch:

```solidity
library LibSignature {
    // EIP-2 half-curve-order upper bound for canonical (low-s) signatures.
    uint256 internal constant HALF_CURVE_ORDER =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;
    bytes4 internal constant EIP1271_MAGIC = 0x1626ba7e;

    /// @dev Calldata recovery. Reverts InvalidSignatureLength on bad length;
    ///      returns address(0) for a malleable or otherwise invalid signature.
    function recoverCalldata(bytes32 digest, bytes calldata sig)
        internal pure returns (address)
    { /* length check, assembly unpack, v-normalize, low-s check, ecrecover */ }

    /// @dev EIP-712 order verification: EOA (type 0) or EIP-1271 (type 1).
    function verifyOrder(
        LibDoefinOrder.DoefinOrder calldata order,
        bytes32 orderHash, bytes calldata sig, uint8 sigType
    ) internal view { /* shared EOA + EIP-1271 branch */ }
}
```

Both settlement facets delegate `_verifySignature` to `LibSignature.verifyOrder`;
`OracleManagerFacet._recoverSigner` delegates to a `recoverMemory` variant (or
the call site is changed to pass `calldata`). This also resolves the
`staticcall`-vs-`IERC1271` inconsistency by forcing one EIP-1271 implementation,
and removes the duplicated magic constant. Library functions are `internal`, so
they inline into each facet — no new selector, no delegatecall, no storage. The
existing `SignatureVerifierFacet` external surface
(`verifyOrderSignature`, `getOrderHash`, `getDomainSeparator`,
`registerOrderSigner`, `isRegisteredSigner`) is unchanged.

upgrade-safe:   yes
fix-commit:     -
fix-test:       -

---

### CPX-002: `_getDomainSeparator` is inconsistent across the three settlement facets

```
id:             CPX-002
domain:         complexity
severity:       low
status:         new
decision:       fix
reverify:       pending
location:       contracts/facets/SignatureVerifierFacet.sol:102-109
source:         complexity
duplicate-of:   -
conflicts-with: -
regression-of:  NEW-3
swc:            -
title:          SettlementFacet uses a cached domain separator; SignatureVerifierFacet and NonceManagerFacet recompute it — three near-identical copies, one divergent
```

description:
The EIP-712 domain separator is derived in three facets with three copies of the
same `LibDoefinOrder.domainSeparator("Doefin Exchange", "2.1", block.chainid,
address(this))` call:

- `SettlementFacet._getDomainSeparator` (`SettlementFacet.sol:236-240`) — returns
  the **cached** `ss.domainSeparator` when non-zero, else computes it.
- `SignatureVerifierFacet._getDomainSeparator` (`SignatureVerifierFacet.sol:102-109`)
  — always recomputes; never consults the cache.
- `NonceManagerFacet._getDomainSeparator` (`NonceManagerFacet.sol:166-173`) —
  always recomputes; never consults the cache.

The `"Doefin Exchange"` / `"2.1"` string pair is a magic literal repeated in all
three. This is the prior review's NEW-3 ("align domain-separator caching across
all facets"), still open.

impact:
Functionally the three currently agree only because `SettlementFacet`'s cache,
once set via `cacheDomainSeparator()`, is computed from the *same* inputs. The
maintainability hazard is real on two axes:
- The string constants must be edited in three files in lockstep; a typo in one
  silently produces a verifier facet that rejects every signature the
  settlement facet accepts (or vice versa).
- `SettlementFacet`'s cache and the other two facets' recompute will *diverge*
  after a chain fork if the cache is not invalidated — this is the substance of
  prior NEW-2 (cached separator must validate `block.chainid`). Domain 1
  (`sc-manual-reviewer`) owns the fork-safety rating; this finding owns the
  structural duplication that makes the inconsistency possible.

recommendation:
Centralize in `LibSignature` (or a small `LibDomainSeparator`): one
`computeDomainSeparator()` holding the name/version constants, and — if caching
is kept — one `domainSeparator(SettlementStorage storage)` helper that applies a
single, shared cache-validity rule (e.g. cache keyed by or checked against
`block.chainid`). All three facets call the same helper. This collapses three
code paths to one and removes the magic strings. If the team instead decides the
cache is not worth its complexity, deleting `ss.domainSeparator` +
`cacheDomainSeparator()` and always recomputing is also acceptable and even
simpler — but that removes the `cacheDomainSeparator()` selector, so that
variant is `upgrade-safe: no`. The recommended centralization (keep the cache,
share the helper) keeps every selector and is `upgrade-safe: yes`.

upgrade-safe:   yes
fix-commit:     -
fix-test:       -

---

### CPX-003: `_getOrderHash` and the order-validity check are duplicated between NonceManagerFacet and the settlement core

```
id:             CPX-003
domain:         complexity
severity:       low
status:         new
decision:       fix
reverify:       pending
location:       contracts/facets/NonceManagerFacet.sol:137-160
source:         complexity
duplicate-of:   -
conflicts-with: -
regression-of:  -
swc:            -
title:          Order-validity predicate (cancelled / nonce / salt / expiry) exists twice; `_getOrderHash` exists three times
```

description:
Two pieces of logic are copy-pasted:

1. `_getOrderHash(DoefinOrder)` — `LibDoefinOrder.hashOrderCalldata(order,
   _getDomainSeparator())` — appears in `SignatureVerifierFacet` (`:116-118`)
   and `NonceManagerFacet` (`:158-160`); `SettlementFacet` inlines the same
   two-call expression at `:105`, `:116`, `:159`.
2. The order-validity predicate — "not cancelled, `nonce >= makerToNonce`,
   `salt >= makerPositionToMinSalt`, not expired" — is implemented twice with
   the same four conditions in the same order:
   - `NonceManagerFacet.isOrderValid` (`:137-147`), returning `bool`.
   - `SettlementFacet._validateOrder` (`:302-317`), reverting with typed errors.

These two are intentionally *not* identical — one is a view returning a flag,
one reverts — but they encode the same business rule and must change together.
The `00-scope.md` regression note records that `SettlementFacet` calls
`isOrderValid()` before fills; the actual settlement code does **not** call
`NonceManagerFacet.isOrderValid` — it re-implements the rule inline in
`_validateOrder`. That is itself a documentation/code mismatch worth flagging.

impact:
If the validity rule changes (e.g. an order-status enum, a new expiry window, a
grace period), an engineer must find and edit both copies. Because one is a
revert-path and one is a flag-path, a partial edit produces a contract where
`isOrderValid()` (used by the off-chain orderbook to decide what to surface)
disagrees with `_validateOrder` (used at settlement) — orders the backend
believes fillable would revert on-chain, or worse. Low severity because both
copies are currently in sync, but the divergence cost is high.

recommendation:
Extract one internal predicate, e.g. in a `LibSettlementValidity` library:

```solidity
function orderState(SettlementStorage storage ss, DoefinOrder calldata o, bytes32 h)
    internal view returns (bool cancelled, bool staleNonce, bool staleSalt, bool expired);
```

`isOrderValid` returns `!(any flag)`; `_validateOrder` checks each flag and
reverts with its specific typed error. The single source of truth lives in the
library. Likewise hoist `_getOrderHash` into the shared library so all three
facets and the inlined `SettlementFacet` call sites use one implementation.
Internal library functions inline — no selector or storage change.

upgrade-safe:   yes
fix-commit:     -
fix-test:       -

---

### CPX-004: `setTradingFeesBps` / `getFees` and the v2.0 fee fields are live-but-dead — they configure storage the v3 fee model never reads

```
id:             CPX-004
domain:         complexity
severity:       low
status:         new
decision:       fix
reverify:       pending
location:       contracts/facets/AdminConfigFacet.sol:138-148
source:         complexity
duplicate-of:   -
conflicts-with: -
regression-of:  REMAINING-3
swc:            -
title:          v2.0 trading-fee setter is a wired-up no-op — settable, returned by getFees, but never consulted by settlement
```

description:
`AdminConfigFacet.setTradingFeesBps(uint16,uint16)` writes
`adminConfigStorage.makerTradingFeeBps` / `takerTradingFeeBps`, and
`AdminConfigFacet.getFees()` returns them. Both selectors are present in
`mergedDiamondABI.json` (`setTradingFeesBps` at line 3406, `getFees` at 1575),
so they are *live* on the Diamond — not unreachable dead code.

But the v3 fee model is per-order: `SettlementFacet._computeFee`
(`SettlementFacet.sol:633-647`) derives the fee purely from the order's signed
`feeRateBps`, bounded by the `MAX_FEE_RATE_BPS` constant. A repo-wide search
confirms `makerTradingFeeBps` / `takerTradingFeeBps` are read **nowhere** in the
settlement path — only written by `setTradingFeesBps` and the
`LibDoefinStorage.initialize` path, and echoed back by `getFees()`.
`DiamondInit.sol:64-71` already documents these as "DEPRECATED (v2.0), not used
in v2.1" and seeds them to 0. This is the prior review's REMAINING-3, still open.

impact:
Worse than inert dead code: it is a *functional-looking knob that does nothing*.
An operator or admin who calls `setTradingFeesBps(100, 200)` expecting to change
protocol economics will see the transaction succeed, see the value reflected by
`getFees()`, and reasonably conclude trading fees are now 1%/2% — when actual
fees are still whatever each order's `feeRateBps` says. This is an operational
foot-gun on a mainnet admin surface, and it bloats the ABI consumed by the
backend and any integrator.

recommendation:
Remove `setTradingFeesBps` and the `makerTradingFeeBps` / `takerTradingFeeBps`
fields from the v3 model. Concretely: delete `setTradingFeesBps` from
`AdminConfigFacet` and `IAdminConfig`; narrow `getFees()` to
`(feeReceiver, resolutionFeeBps)`; drop `makerTradingFeeBps` / `takerTradingFeeBps`
from `AdminConfigStorage` (and the corresponding params from
`LibDoefinStorage.initialize` and the `DiamondInit` call). `resolutionFeeBps` and
`feeReceiver` are still live (CTF redemption) and must be kept.

This is **`upgrade-safe: no`**: removing `setTradingFeesBps` deletes a selector,
and changing the `getFees()` return tuple changes its selector's *signature*
shape for ABI consumers. For the mainnet **fresh deploy** that is acceptable and
desirable. If a `diamondCut` upgrade of an already-deployed Diamond is ever
planned instead, the two storage fields cannot simply be deleted (they would
shift `__gap` and every later field) — they would have to become
`__reserved_*` placeholders, exactly as `LibSettlementStorage` already does for
its SCRUM-89 slots. A minimal, fully `upgrade-safe: yes` alternative is to keep
storage untouched and only delete the `setTradingFeesBps` *selector* plus add a
NatSpec deprecation note, accepting the dead storage fields.

upgrade-safe:   no
fix-commit:     -
fix-test:       -

---

### CPX-005: Cross-currency conversion-path machinery on AdminConfigFacet is dead in v3

```
id:             CPX-005
domain:         complexity
severity:       low
status:         new
decision:       defer
reverify:       pending
location:       contracts/facets/AdminConfigFacet.sol:200-297
source:         complexity
duplicate-of:   -
conflicts-with: -
regression-of:  -
swc:            -
title:          conversionPaths storage + four conversion-path functions support a cross-currency settlement path that v3 deliberately removed
```

description:
`AdminConfigFacet` carries a full cross-currency conversion-path subsystem:
`getCrossCurrencyConversionPath`, `setConversionPath`, `removeConversionPath`,
`getConfiguredConversionPath` (`AdminConfigFacet.sol:200-297`), backed by
`AdminConfigStorage.conversionPaths` (`LibDoefinStorage.sol:127`) and the
`ConversionPathSet` / `ConversionPathRemoved` events.

The `SettlementFacet` header (`SettlementFacet.sol:22`) states "Cross-currency
settlement is intentionally excluded (SC-006)". A repo-wide search confirms no
in-scope settlement code reads `conversionPaths`, `quoteCurrency`, or
`exchangeRate`; the only readers/writers are `AdminConfigFacet` itself, the
struct definitions in `LibDoefinOrder` / `LibDoefinStorage`, and the audit
harness. The `DoefinOrder` struct still carries `quoteCurrency` and
`exchangeRate` fields (`LibDoefinOrder.sol:29-30`) and a v2.0 `orderType` enum,
none of which any v3 facet branches on — `_determineMatchType` keys only on
`positionId` and `side`.

impact:
A non-trivial admin surface (four external functions, one storage mapping, two
events) exists on a mainnet facet to configure a feature that cannot be reached.
It enlarges the ABI, the audit surface, and the conceptual model an integrator
must hold. No direct risk — these are owner-only configuration writes with no
settlement consumer — hence Low, and `decision: defer` rather than a
mainnet blocker.

recommendation:
Decide explicitly whether cross-currency is "removed" or "deferred":
- If **removed**, delete the four conversion-path functions, the
  `conversionPaths` mapping, and the two events; this is a post-launch cleanup.
- If **deferred** (planned for a later version), leave the code but add a
  contract-level NatSpec note that the conversion-path API is dormant and not
  wired into v3 settlement, so auditors and integrators are not misled.
Either way, do not leave it silently half-present. The `DoefinOrder`
`quoteCurrency` / `exchangeRate` / `orderType` fields are part of the
EIP-712-signed struct and the byte-for-byte backend contract — they **cannot**
be removed without a coordinated `LibDoefinOrder` + backend `encoder.py` change,
so leave the struct alone and only document it.

This is **`upgrade-safe: no`** if the functions are deleted (selector-set
change) — acceptable for the fresh deploy, post-launch otherwise. The
documentation-only variant is `upgrade-safe: yes`.

upgrade-safe:   no
fix-commit:     -
fix-test:       -

---

### CPX-006: `matchOrders` is a long, multi-responsibility function — extract the per-maker loop body

```
id:             CPX-006
domain:         complexity
severity:       low
status:         new
decision:       fix
reverify:       pending
location:       contracts/facets/SettlementFacet.sol:76-139
source:         complexity
duplicate-of:   -
conflicts-with: -
regression-of:  -
swc:            -
title:          matchOrders mixes input validation, fee accumulation, settlement dispatch, fill-state mutation, and event emission in one 64-line body
```

description:
`matchOrders` (`SettlementFacet.sol:76-139`) does, in one function:
length-consistency validation; a fill-sum reconciliation loop in a bare block;
domain-separator fetch; taker verify/validate/fill-check; then a per-maker loop
that, per iteration, runs zero-amount and self-trade guards, signature
verification, order validation, fill-amount check, match-type determination,
two fee computations, settlement execution, a storage write to
`orderHashToFilledAmount`, and two `emit`s. It then writes taker fill state and
emits again.

Cyclomatic complexity is moderate (roughly 9–10 decision points: 3 `||` length
checks, the sum loop, the maker loop, and 3 in-loop guards) and nesting reaches
three levels (function -> maker loop -> guards). It is not the worst function in
the codebase, but it is the **crown-jewel** entry point — the one function where
clarity matters most for review, and it is the densest in the v3 core.
`_executeSettlement` is a clean 3-branch dispatcher and is *not* a concern; the
three `_settleX` paths are each single-responsibility and readable. The
complexity is concentrated in `matchOrders` itself.

impact:
A reviewer (human or the next audit) must hold the whole taker/maker fee-and-fill
accounting in working memory at once. The "Fix 3" / "Fix 4" inline comments are
archaeological residue of prior security patches — evidence this function has
been the site of correctness bugs (per-maker taker-fee computation, fill-sum
consistency). Dense crown-jewel code raises the probability the *next* change
introduces a subtle accounting error. Maintainability only — no current bug.

recommendation:
Extract the per-maker loop body into a single internal helper so the loop reads
as one call, and lift the fill-sum reconciliation into a named helper:

```solidity
function _sumFills(uint128[] calldata a) private pure returns (uint128 total) {
    for (uint256 i; i < a.length; ++i) total += a[i];
}

function _settleAgainstMaker(
    SettlementStorage storage ss,
    DoefinOrder calldata taker, bytes32 takerHash,
    DoefinOrder calldata maker, bytes calldata makerSig,
    uint8 makerSigType, uint128 fill, bytes32 domainSep
) private returns (uint128 takerFeeForThisMaker) {
    // zero/self-trade guards, verify, validate, fill-check,
    // match-type, fee math, _executeSettlement, fill-state write, emits
}
```

`matchOrders` then reduces to: validate lengths, `_sumFills` reconcile, verify
taker, loop calling `_settleAgainstMaker`, finalize taker state. No behavior
change — pure structural extraction into `private` helpers (no selector, no
storage). Consider deleting or rewording the "Fix N" comments into proper
NatSpec describing *what* the invariant is, not which patch introduced it.

upgrade-safe:   yes
fix-commit:     -
fix-test:       -

---

### CPX-007: `_getIndexSet` does a linear scan with a misleading comment; partition reconstruction is duplicated between `_settleMint` and `_settleMerge`

```
id:             CPX-007
domain:         complexity
severity:       low
status:         new
decision:       fix
reverify:       pending
location:       contracts/facets/SettlementFacet.sol:456-588
source:         complexity
duplicate-of:   -
conflicts-with: -
regression-of:  -
swc:            -
title:          identical conditionId+partition reconstruction block copy-pasted into _settleMint and _settleMerge; _getIndexSet comment claims O(1) registry lookup but loops
```

description:
Two issues, both maintainability:

1. `_settleMint` (`:500-506`) and `_settleMerge` (`:550-553`) contain a
   verbatim-identical block: read `conditionId` from
   `positionRegistry.conditionIdByPositionId`, allocate a 2-element `partition`
   array, fill it with `_getIndexSet(taker.positionId)` /
   `_getIndexSet(maker.positionId)`. The only thing that differs between the two
   settlement paths after this block is the `_splitPositionInternal` vs
   `_mergePositionsInternal` call and the payout direction.

2. `_getIndexSet` (`:659-671`) carries a NatSpec line — "positionId ... cannot be
   reversed, so we look it up in the registry" — and a sibling comment in
   `_settleMint` (`:497-499`) calls the registry "O(1)", but the implementation
   is an O(n) linear scan over `meta.positionIds` to find the matching slot. For
   the binary markets v3 targets `n == 2`, so it is cheap, but the comment and
   the code disagree, which misleads the next reader about both cost and intent.

impact:
The duplicated block must be edited in two places if the partition encoding or
the registry layout changes (e.g. non-binary markets, a different conditionId
source). The "O(1)" comment will mislead anyone reasoning about gas or about
extending to multi-outcome markets, where the linear scan stops being free.
Pure maintainability — no behavior bug; `_determineMatchType` already guarantees
both positions belong to the same binary market before either `_settleX` runs.

recommendation:
Extract one helper that returns both the conditionId and the partition:

```solidity
function _conditionAndPartition(bytes32 takerPos, bytes32 makerPos)
    private view returns (bytes32 conditionId, uint256[] memory partition)
{
    conditionId = LibDoefinStorage.appStorage()
        .positionRegistry.conditionIdByPositionId[uint256(takerPos)];
    partition = new uint256[](2);
    partition[0] = _getIndexSet(takerPos);
    partition[1] = _getIndexSet(makerPos);
}
```

Both `_settleMint` and `_settleMerge` call it. Separately, correct the
`_getIndexSet` NatSpec and the `_settleMint` comment to say "linear scan over the
market's position slots (length 2 for binary markets)" instead of "O(1)".
`private` helper + comment edits — no selector or storage change.

upgrade-safe:   yes
fix-commit:     -
fix-test:       -

---

## Appendix — cosmetic / informational nits

These are style and documentation observations. None is mainnet-blocking; group
them into a single post-launch cleanup commit. All are `upgrade-safe: yes`
(comments and constants only — no storage or selector impact) unless noted.

- **A1 — Dead `ProtocolFeesWithdrawn` event (REMAINING-2, still open).**
  `Events.sol:205` defines `ProtocolFeesWithdrawn`; a repo-wide search finds
  zero `emit` sites — the follow-up review's MEDIUM-1 fix deleted
  `LibFeeManager.sol` and left this event orphaned. It bloats the ABI. Delete
  the event declaration. (Events are not selectors; removing it is a no-op for
  the proxy and is `upgrade-safe: yes`. Folded into the appendix rather than a
  numbered finding only because it is a one-line deletion — but it *is* a
  confirmed open regression item and should be done for mainnet.)

- **A2 — Residual v2.0 type zoo in `LibDoefinStorage`.** `LibDoefinStorage.sol`
  still declares ~12 deprecated v2.0 types — `OrderDirection`, `ExecutionType`,
  `OrderType`, `OrderFeeConfig`, `CrossCurrencyData`, `SettlementExecutionContext`,
  `ModifyCollateralContext`, `SimulationContext`, `Match`, `MatchOrderRoute`,
  `MatchType`, the 56-field `Order` struct, plus the `OrderbookStorageStruct` and
  `EscrowStorage` structs (`LibDoefinStorage.sol:135-319`). No production facet
  references any of them (verified by repo-wide grep — only `LibDoefinStorage`
  internal and `DiamondInit` touch them, and `DiamondInit` only via the
  `initialize` parameter list). The *enums and standalone structs*
  (`OrderDirection`, `Order`, `Match`, etc.) are pure type declarations — they
  occupy no storage and could be deleted with **zero** layout impact
  (`upgrade-safe: yes` for those). The two structs actually embedded in
  `AppStorage` — `orderbookStorage` and `escrowStorage` (`AppStorage` fields,
  `:418-419`) — **cannot** be removed without shifting every later field and the
  `__gap`; for a fresh deploy that is fine, but it is `upgrade-safe: no`. The
  pragmatic call for mainnet: delete the unused enums/standalone structs to cut
  ~180 lines of noise, keep the two `AppStorage`-embedded structs (they are
  correctly commented "preserved for storage layout safety"). This is cleanup,
  not a blocker; the code is already clearly marked `DEPRECATED (v2.0)`.

- **A3 — `DoefinOrder` carries v2.0-only fields.** `minFillAmount`,
  `quoteCurrency`, `exchangeRate`, and `orderType` (`LibDoefinOrder.sol:27-32`)
  are part of the EIP-712 struct hash but are read by no v3 settlement logic
  (`_determineMatchType` branches only on `positionId`/`side`; fee math uses
  `feeRateBps`). The `00-scope.md` regression note records `minFillAmount` was
  "removed in SCRUM-121/122" — that referred to removing the *enforcement
  logic*, but the *field* is still in the signed struct. These cannot be removed
  unilaterally: the struct is the byte-for-byte contract with the backend
  (`shared/scw/encoder.py`, `shared/scw/models.py`). Recommendation: add a
  NatSpec line on each such field marking it "reserved / not consumed by v3
  settlement", so the next reader does not assume `minFillAmount` is enforced.
  Documentation only — `upgrade-safe: yes`.

- **A4 — Magic numbers without named constants.** The half-curve-order literal
  `0x7FFF...B20A0` (in both settlement facets — see CPX-001); the EIP-1271 magic
  `0x1626ba7e` (a named constant `EIP1271_MAGIC_VALUE` in
  `SignatureVerifierFacet:21` but a bare literal in `SettlementFacet:290`); the
  `10000` bps divisor in `_computeFee` (`SettlementFacet:646`); `signatureType`
  values `0`/`1` and `side` values `0`/`1` used as bare literals throughout.
  Promote to named `internal constant`s (or document the 0/1 encodings once).
  Resolving CPX-001 absorbs the first two.

- **A5 — Archaeological "Fix N" comments.** `SettlementFacet.matchOrders` has
  `// Fix 4: ...` (`:92`) and `// Fix 3: ...` (`:110`). These name a past patch
  iteration, not the invariant. Reword to describe *what* must hold
  (e.g. "maker fills must sum exactly to the taker fill" / "taker fee is charged
  per maker leg, not once on the aggregate") so the rationale survives without
  the changelog context.

- **A6 — `AdminConfigFacet` contract-level NatSpec is stale.** The header
  (`AdminConfigFacet.sol:11-18`) advertises "protocol fee withdrawal" and
  "comprehensive fee management" — the fee-withdrawal code was deleted in the
  follow-up review's MEDIUM-1 fix, and "comprehensive fee management" is now just
  `resolutionFeeBps` plus the dead `setTradingFeesBps` (CPX-004). Update the
  header to describe the v3 surface accurately.

- **A7 — `^0.8.6` floating pragma vs pinned 0.8.20 build.** Every in-scope
  source file declares `pragma solidity ^0.8.6;` while the project builds on a
  pinned 0.8.20 (`hardhat.config.js`, per `CLAUDE.md` conventions). A floating
  caret pragma on a contract intended for a deterministic mainnet deploy is a
  best-practice deviation: it permits compilation under any 0.8.x and weakens
  reproducibility of the deployed bytecode. Recommend pinning sources to the
  exact build version (`pragma solidity 0.8.20;`). Touches every file but is a
  one-token edit per file; `upgrade-safe: yes` (pragma does not affect storage
  or selectors). Flagged here as the cross-cutting consistency item from the
  domain brief — Domain 1 (`sc-manual-reviewer`) may also rate it as a
  defense-in-depth item; no double-count intended.

- **A8 — Inconsistent loop-index style.** `SettlementFacet` / `NonceManagerFacet`
  use `for (uint256 i; i < n; ++i)` (no init, pre-increment); `AdminConfigFacet`
  and `MarketDataFacet` use `for (uint256 i = 0; i < n; i++)` (explicit zero,
  post-increment). Cosmetic; pick one. Gas implications are Domain 2's call, not
  rated here.

---

## Notes for triage

- CPX-001 / CPX-002 / CPX-003 share a remedy: a single `LibSignature`
  (+ optional `LibSettlementValidity`) library. `audit-triage` should treat them
  as one consolidation work-item with three motivating findings, not three
  independent fixes. They are **not** duplicates of each other — each names a
  distinct duplicated unit (recovery, domain separator, validity predicate).
- CPX-001 is rated MEDIUM (not LOW like prior REMAINING-1) because this review
  found a *third* copy in `OracleManagerFacet` with a missing malleability
  check — the duplication has already produced a real divergence in a
  signature-verification path. The missing check itself is a security finding;
  `sc-manual-reviewer` owns its severity. If that domain rates it HIGH, CPX-001
  remains the maintainability companion at MEDIUM (complexity caps at MEDIUM
  regardless).
- CPX-004 and CPX-005 are the only `upgrade-safe: no` findings, and only when
  the *delete* variant is chosen. For the mainnet **fresh deploy** that is the
  correct, non-blocking choice. Each finding also states a fully `upgrade-safe:
  yes` minimal alternative for the contingency that a `diamondCut` upgrade is
  used instead.
- Regression checklist status confirmed against the pinned commit:
  REMAINING-1 **open** (and worse — see CPX-001), REMAINING-2 **open** (A1),
  REMAINING-3 **open** (CPX-004), NEW-3 **open** (CPX-002). NEW-2 (cached-
  separator chainId validation) is security-domain; CPX-002 covers the
  structural duplication that underlies it.
- No in-scope facet is over 24 KiB per `audit/output/size/` (Domain 2 / size
  pass owns the authoritative number); `SettlementFacet` at ~672 LOC is the
  largest v3 facet but its size is not a complexity finding on its own — the
  concentrated density in `matchOrders` (CPX-006) is.
