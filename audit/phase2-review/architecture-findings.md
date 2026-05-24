# Doefin v3 — Phase-2 In-Depth Review: Architecture Pass

- **Domain:** architecture
- **Reviewer lens:** Smart-Contract Architecture Reviewer (Solidity / EIP-2535 specialist)
- **Repo:** `/Users/reza/workspace/predexyo/doefin-v2` — branch `v3/dev`
- **Mode:** read-only, pre-external-audit. No `contracts/`, tests, or scripts modified.
- **Scope reviewed:** `contracts/facets/` (15 facets), `contracts/libraries/` (18), `contracts/interfaces/`
  (16), `contracts/Diamond.sol`, `contracts/upgradeInitializers/DiamondInit.sol`. `contracts/mock/`
  and `contracts/audit/` excluded.
- **The lens:** "is this the right shape?" — facet/library/storage boundaries, Diamond assembly.
  Distinct from the complexity analyst (duplication, function length) and the gas optimizer.

## Summary

| Severity | Count |
|----------|-------|
| High     | 2     |
| Medium   | 5     |
| Low      | 4     |
| Info     | 4     |
| **Total**| **15**|

The Diamond is assembled correctly and the v3 settlement core is, on the whole, well-decomposed:
`LibDoefinOrder` / `LibSignature` / `LibOrderValidity` are correctly-placed shared libraries, the
three settlement facets share a single domain-separator routine, and `LibSettlementStorage` is a
clean per-concern namespace. The structural debt is concentrated in two places: (1) the v3
settlement layer was bolted onto a v2-era `AppStorage` monolith and a v2-era `LibAccessControl`
without reconciling the two role models, leaving authorization scattered across three different
mechanisms; and (2) `SettlementFacet` mixes owner-only governance (operator management + pause
switch) into the same facet as the `matchOrders` hot path.

`upgrade-safe` tag: mainnet v3 is a **fresh deploy**, so every `upgrade-safe: no` item below is
free if actioned before deployment. After deployment they become costly (`diamondCut` +
storage-migration). The recommendation throughout is: act on the `no` items now.

---

## Findings ledger

### ARCH-01 — `SettlementFacet` mixes owner-only governance with the settlement hot path
- **Severity:** High
- **Domain:** architecture
- **Location:** `contracts/facets/SettlementFacet.sol:273-323` (`setOperator`, `pauseTrading`,
  `unpauseTrading`, plus the `getOperator` / `isTradingPaused` views)
- **Structural issue:** `SettlementFacet` is a 42 KB-source / ~870-line facet whose stated
  responsibility is "execute matched order pairs." It additionally carries three owner-only
  governance functions — `setOperator`, `pauseTrading`, `unpauseTrading` — that have nothing to
  do with executing a settlement. They are mutating, owner-gated, and rarely called; `matchOrders`
  / `fillOrder` are operator-gated and called every block. Two distinct trust tiers, two distinct
  call frequencies, one facet.
- **Why it matters:**
  - *Audit surface* — an auditor reasoning about the operator-trust boundary must read past the
    governance functions; an auditor reasoning about owner powers must hunt them inside the
    largest facet in the repo instead of finding them in the admin facet.
  - *Mental-model clarity* — the project already has `AdminConfigFacet` (owner-only config) and
    `AccessControlFacet` (role management). A reader's reasonable expectation is that "set the
    operator" and "pause trading" live in one of those, or in a dedicated facet. They do not.
  - *Selector-set hygiene* — the governance selectors and the hot-path selectors share a facet
    address, so any future re-deploy of the settlement logic needlessly re-deploys the governance
    code and vice versa.
- **Both sides, weighed:** Co-location has one genuine merit — `operator` and `tradingPaused`
  live in `LibSettlementStorage`, so the writers are physically near the storage they own, and a
  reader sees the pause flag's writer and its only consumer (`notPaused`) in one file. That is a
  real but weak benefit: `LibSettlementStorage` is a library, any facet can address it, and the
  `notPaused`/`onlyOperator` modifiers stay in `SettlementFacet` regardless of where the setters
  live. The cost (two trust tiers in the crown-jewel facet) outweighs it.
- **Recommendation:** Extract the operator-management + pause switch into their own concern. Two
  viable shapes:
  1. **Dedicated `SettlementAdminFacet`** (preferred) — `setOperator`, `pauseTrading`,
     `unpauseTrading`, `getOperator`, `isTradingPaused`. Keeps all settlement-namespace governance
     together, leaves `SettlementFacet` purely operator-facing. `ISettlement` splits into
     `ISettlement` (hot path) + `ISettlementAdmin` (governance) — a cleaner interface boundary
     too (see ARCH-09).
  2. **Fold into `AdminConfigFacet`** — that facet is already the owner-only config home. Costs:
     `AdminConfigFacet` would need to import `LibSettlementStorage`, mildly widening its concern
     from "AppStorage admin config" to "all admin config."
     Shape 1 is cleaner because pause is a settlement-domain switch, not protocol-wide config.
  A standalone `PausableFacet` is *not* recommended here — pause is single-flag and
  settlement-specific; a generic pausable facet would be over-abstraction for one boolean.
- **upgrade-safe:** no (moves selectors between facet addresses; pre-deploy this is free)
- **Effort:** S — new facet file + interface split + deploy-script facet entry; no storage or
  logic change, the function bodies move verbatim.

### ARCH-02 — Three parallel, unreconciled access-control mechanisms
- **Severity:** High
- **Domain:** architecture
- **Location:** `LibDiamond.enforceIsContractOwner` (used by `AdminConfigFacet`, `OwnershipFacet`,
  `DiamondCutFacet`, `SettlementFacet`); `LibAccessControl.isOwner` / `enforceIsMarketMaker`
  (used by `ConditionalTokensFacet`, `ConditionManagerFacet`); ad-hoc `msg.sender ==`
  comparisons (`SettlementFacet.onlyOperator`, `NonceManagerFacet` maker checks,
  `SignatureVerifierFacet.registerOrderSigner`).
- **Structural issue:** "Owner" is enforced two different ways for the same underlying owner.
  `AdminConfigFacet` calls `LibDiamond.enforceIsContractOwner()` directly; `ConditionManagerFacet`
  calls `LibAccessControl.isOwner(msg.sender)` — which itself wraps `LibDiamond.contractOwner()`.
  Same owner, two code paths, two revert errors (`NotContractOwner` from both, but reached via
  different libraries). `LibAccessControl.setMarketMaker` *also* re-implements an owner check
  (`if (!isOwner(msg.sender)) revert NotContractOwner`) — so the `AccessControlFacet.addMarketMaker`
  function has *no* visible gate in the facet; the gate is buried one library call deep. An
  auditor scanning `AccessControlFacet.sol` sees no `enforceIs*` and could wrongly conclude
  `addMarketMaker` is unguarded.
- **Why it matters:**
  - *Audit surface / mental-model* — "is every privileged function gated, and gated the same
    way?" cannot be answered by scanning facets. The reviewer must trace each facet into a
    library to discover which of two owner-check idioms (and one hidden-in-library idiom) applies.
  - *Maintainability* — adding a new owner-only function, a contributor will copy whichever
    neighbouring facet they happen to read. The inconsistency is self-propagating.
  - *Correctness latent risk* — `LibAccessControl` is the v2-era role library. `LibDiamond` is
    the EIP-2535 standard. They agree *today* because `LibAccessControl.isOwner` delegates to
    `LibDiamond.contractOwner()`. Nothing structural enforces that they keep agreeing.
- **Recommendation:** Pick one authorization spine and route every privileged function through it.
  - Standardize owner checks on `LibDiamond.enforceIsContractOwner()` everywhere (it is the
    EIP-2535 canonical source; `OwnershipFacet`/`DiamondCutFacet` already use it).
  - Make the gate **visible in the facet body**: `AccessControlFacet.addMarketMaker` /
    `removeMarketMaker` should call `LibDiamond.enforceIsContractOwner()` explicitly, and
    `LibAccessControl.setMarketMaker` should drop its own embedded owner check (a storage
    setter should not also be an authorization gate — that conflation is the root cause of the
    invisible-gate problem).
  - `operator` and `marketMaker` are legitimately distinct roles and should stay distinct, but
    their *check sites* should be uniform: an `enforceIsOperator()` helper alongside
    `enforceIsMarketMaker()`, both in one access library, rather than `SettlementFacet` inlining
    `msg.sender != ss.operator`.
- **upgrade-safe:** yes (no storage-layout or selector change — internal call-graph only)
- **Effort:** M — touches ~6 facets + 2 libraries; purely mechanical, no behaviour change, but
  needs a test pass to confirm revert-reason parity.

### ARCH-03 — Storage model is a deliberate-but-undocumented hybrid; the `AppStorage` half is the weak half
- **Severity:** Medium
- **Domain:** architecture
- **Location:** `LibDoefinStorage.sol` (monolithic `AppStorage` at `keccak256("doefin.storage")`)
  vs `LibSettlementStorage.sol` (per-concern namespace at `keccak256("doefin.settlement.storage")`).
- **Structural issue:** The Diamond uses two storage models at once. `AppStorage` is a single
  struct embedding eight sub-structs (`ConditionalTokensStorage`, `AccessControlStorage`,
  `ERC1155Storage`, `AdminConfigStorage`, `PositionRegistryStorage`, `ReentrancyStorage`,
  `BlockHeaderOracleStorage`, `OracleAdapterStorage`) plus a trailing `uint256[51] __gap`. The
  v3 settlement layer instead got its own isolated namespace, `LibSettlementStorage`. The split
  is real and arguably correct — but it is *implicit*: nothing documents why settlement is
  isolated while everything else is lumped, and the inconsistency is itself a finding because a
  future contributor has no rule to follow ("do I add my new struct to `AppStorage` or give it
  a namespace?").
- **Why it matters:**
  - *Upgrade-safety / field-shift fragility* — the monolithic `AppStorage` puts eight sub-structs
    at sequential offsets. Each sub-struct has its own `__gap`, which contains shifts *within* a
    sub-struct, but the *order of the eight members of `AppStorage` itself* is load-bearing: insert
    a struct, or grow one past its `__gap`, and every downstream sub-struct's base slot moves. The
    settlement namespace has none of this coupling — it stands alone.
  - *Module isolation* — `OracleAdapterStorage` and `BlockHeaderOracleStorage` (both audit-flagged
    as superseded / out-of-scope, see ARCH-04) sit *inside* `AppStorage`. A reviewer auditing the
    in-scope `AdminConfigStorage` must still load the whole struct definition including the
    out-of-scope oracle sub-structs. Per-concern namespacing would let each module's storage be
    read, audited, and reasoned about independently.
- **Recommendation:** For the fresh v3 mainnet deploy, document the rule explicitly in
  `LibDoefinStorage`'s NatSpec ("settlement, and any new module, gets its own namespaced slot;
  `AppStorage` is frozen v2-era legacy retained only for CTF/oracle/ERC1155"). Longer-term, and
  ideally before this deploy since it is free now, peel `AdminConfigStorage` and `AccessControlStorage`
  — the two in-scope, actively-maintained sub-structs — out of `AppStorage` into their own
  namespaces, matching the settlement pattern. Leave the CTF/oracle sub-structs in `AppStorage`
  if peeling them is out of audit scope. Do not attempt this as a post-deploy upgrade.
- **upgrade-safe:** no (any change to `AppStorage` member ordering changes layout)
- **Effort:** M (document-only: S; peel two sub-structs into namespaces: M)

### ARCH-04 — "Follow EIP-7201" instruction is not actually followed — plain `keccak256` slots, no annotation
- **Severity:** Medium
- **Domain:** architecture
- **Location:** `LibDoefinStorage.sol:7` (`keccak256("doefin.storage")`),
  `LibSettlementStorage.sol:12` (`keccak256("doefin.settlement.storage")`),
  `LibDiamond.sol` (`DIAMOND_STORAGE_POSITION`). `.claude/CLAUDE.md` instructs "Follow EIP-7201
  namespaced storage pattern for any new storage structs."
- **Structural issue:** EIP-7201 specifies a concrete slot-derivation formula —
  `keccak256(abi.encode(uint256(keccak256("id")) - 1)) & ~bytes32(uint256(0xff))` — and a
  `@custom:storage-location erc7201:<id>` struct annotation that lets tooling (the OZ upgrades
  plugin, storage-layout diff tools) recognize and verify the namespace. Doefin uses neither.
  It uses a plain `keccak256("string")` for the slot and has no `@custom:storage-location`
  annotation on any storage struct. `LibSettlementStorage`'s own NatSpec even says it "follows
  the same keccak256 slot + assembly pattern as LibDoefinStorage" — i.e. it explicitly is *not*
  7201, contradicting the `CLAUDE.md` instruction.
- **Why it matters:**
  - *Tooling* — the `& ~0xff` mask in 7201 reserves 256 contiguous slots after the namespace
    root, so a struct can grow without a hand-rolled `__gap` and tooling can verify no collision.
    Plain `keccak256` gives a single root with no reserved tail, which is exactly why every
    Doefin storage struct needs a manually-sized `__gap` (and why ARCH-05 below is a live risk).
  - *Mental-model / instruction drift* — a contributor reading `CLAUDE.md` will believe the
    codebase is 7201-conformant and may add a genuinely 7201-formula struct, producing a *third*
    storage convention.
  - *Collision math* — `keccak256("doefin.storage")` and `keccak256("doefin.settlement.storage")`
    will not collide with each other or with the Diamond slot in practice (different preimages),
    so this is not an exploitable bug — it is a conformance and tooling-fitness gap.
- **Recommendation:** Decide and make it true. Either (a) adopt the real EIP-7201 formula +
  `@custom:storage-location` annotations for `LibSettlementStorage` and any future struct, and
  update `CLAUDE.md` to describe the legacy `AppStorage` as a grandfathered exception; or (b)
  accept the plain-`keccak256` + `__gap` pattern as the house style and *correct* `CLAUDE.md` to
  say so, dropping the "EIP-7201" claim. Option (a) is the better long-term posture given the
  Diamond will be upgraded post-deploy and 7201 is the pattern OZ tooling validates. Either way,
  the doc and the code must stop disagreeing.
- **upgrade-safe:** no if the slot constants change (they would, under option a — every namespace
  moves to a new slot). Free pre-deploy; impossible post-deploy without a full migration.
- **Effort:** S (option b, doc-only) / M (option a, re-derive slots + annotate + re-test).

### ARCH-05 — `AppStorage.__gap` sizing is hand-maintained and unverifiable
- **Severity:** Medium
- **Domain:** architecture
- **Location:** `LibDoefinStorage.sol:99,107,121,134,152,189,195,206` — every storage sub-struct
  carries a manually-chosen `__gap` (`[20]`, `[50]`, `[10]`, `[12]`, `[10]`, `[10]`, `[10]`,
  `[51]`).
- **Structural issue:** With the plain-`keccak256` slot scheme (ARCH-04), upgrade-safety of the
  embedded sub-structs rests entirely on these `__gap` arrays being correctly sized and correctly
  decremented whenever a field is added. `AdminConfigStorage` is the cautionary example: SCRUM-224
  added `uint16 maxFeeRateBps`. The `__gap` is `[12]`. Was it `[13]` before and decremented to
  `[12]`? Or was it always `[12]` and a slot silently consumed? `maxFeeRateBps` is `uint16` and
  packs into the same slot as `resolutionFeeBps` (also `uint16`) and possibly `feeReceiver`'s
  slot neighbours — so it may have cost *zero* new slots, meaning the `__gap` should *not* have
  been decremented. There is no test, no comment, and no tooling that proves the current `[12]`
  is right. The whole scheme is "trust the last contributor did the arithmetic."
- **Why it matters:** This is the single largest latent upgrade-safety hazard in the storage
  layer. A mis-sized `__gap` is invisible until the *next* upgrade adds a field, at which point
  the new field overwrites live data in the following sub-struct. For a fresh deploy it is
  inert; for the first post-deploy `diamondCut` it is a potential fund-loss bug.
- **Recommendation:**
  1. Pre-deploy, add a storage-layout snapshot test (Hardhat can dump `storageLayout` via the
     compiler `outputSelection`) and assert the byte offsets of every `AppStorage` field. This
     converts "trust the arithmetic" into a CI gate.
  2. Annotate each `__gap` with a comment stating the *total slot budget* the sub-struct is
     allotted and the *slots currently consumed*, so the next contributor can verify by addition.
  3. Strategic fix is ARCH-04 option (a): EIP-7201's `& ~0xff` mask removes the need for
     hand-sized `__gap`s entirely.
- **upgrade-safe:** yes (adding a test / comments changes nothing on-chain)
- **Effort:** S (layout snapshot test) — high value-to-effort ratio.

### ARCH-06 — `LibAccessControl` is a half-migrated v2-era artifact straddling two storage homes
- **Severity:** Medium
- **Domain:** architecture
- **Location:** `LibAccessControl.sol` (entire file); `AccessControlStorage` inside
  `LibDoefinStorage.AppStorage`.
- **Structural issue:** `LibAccessControl` is a 38-line library doing four unrelated things:
  owner check (`isOwner`, delegates to `LibDiamond`), market-maker role
  (`isMarketMaker`/`enforceIsMarketMaker`/`setMarketMaker`, reads `AppStorage`), and a
  collateral-allowlist read (`isCollateralTokenAllowed`, reads `AdminConfigStorage`). It is a
  grab-bag: ownership belongs to `LibDiamond`, market-maker belongs to an access namespace, and
  the collateral allowlist belongs to admin-config (and is *also* read directly as
  `cfg.isAllowed[...]` in `SettlementFacet._validateOrder` — so `LibAccessControl.isCollateralTokenAllowed`
  is a redundant second accessor for the same mapping, used by neither in-scope hot path). The
  market-maker concept itself only serves the out-of-scope CTF condition-creation facets.
- **Why it matters:**
  - *Conceptual coherence* — a library named "AccessControl" that also contains a token-allowlist
    getter and re-exports `LibDiamond.contractOwner()` has no single responsibility. A reader
    cannot predict what is or is not in it.
  - *Library-vs-facet placement* — `isCollateralTokenAllowed` is shared logic stranded in the
    wrong library; the canonical home is `LibDoefinStorage`/`AdminConfigStorage` accessors.
- **Recommendation:** Pre-deploy, slim `LibAccessControl` to *only* the market-maker role
  (`isMarketMaker`, `enforceIsMarketMaker`, `setMarketMaker` — and per ARCH-02, drop the embedded
  owner check from `setMarketMaker`). Delete `isOwner` (callers use `LibDiamond` directly) and
  delete `isCollateralTokenAllowed` (the one in-scope mapping read is already done inline; if a
  shared getter is wanted it belongs next to `AdminConfigStorage`). Consider renaming the library
  to `LibMarketMakerRole` to match its remaining single responsibility.
- **upgrade-safe:** yes (removing unused internal library functions changes no storage or
  external selectors; `AccessControlStorage` layout is untouched)
- **Effort:** S

### ARCH-07 — `registerOrderSigner` lives in `SignatureVerifierFacet`, a facet otherwise pure-view
- **Severity:** Low
- **Domain:** architecture
- **Location:** `SignatureVerifierFacet.sol:74-78` (`registerOrderSigner`).
- **Structural issue:** `SignatureVerifierFacet` is otherwise entirely `view` — it computes
  hashes and verifies signatures. `registerOrderSigner` is the one *state-mutating* function in
  it: it writes `ss.registeredOrderSigners[msg.sender][signer]`. Functionally it is a delegation
  /signer-management operation — conceptually adjacent to `NonceManagerFacet`'s order-lifecycle
  management (nonce, cancel, salt) — not to signature *verification*. The facet's own NatSpec
  bills it as "EIP-712 order signature verification."
- **Why it matters:** Minor mental-model mismatch. An auditor classifying facets as
  "view/stateless" vs "state-mutating" finds one mutating function hiding in the verifier. The
  signer-registration storage (`registeredOrderSigners`) is *read* by both `SettlementFacet` and
  `SignatureVerifierFacet` during EIP-1271 verification, so co-locating the *writer* with one
  reader is defensible — this is a genuine judgment call, not a clear error.
- **Recommendation:** Acceptable to leave as-is given the writer-near-one-reader argument, but if
  ARCH-01's facet reshuffle happens, prefer moving `registerOrderSigner` /`isRegisteredSigner`
  into `NonceManagerFacet` (rename it `OrderLifecycleFacet`) so that all maker-controlled order
  metadata — nonce, cancellation, salt, delegated signers — lives in one facet, and
  `SignatureVerifierFacet` becomes cleanly pure-view. Low priority; flagged for coherence.
- **upgrade-safe:** no if moved (selector changes facet address); free pre-deploy
- **Effort:** S

### ARCH-08 — `OracleAdapterFacet` naming no longer collides, but the residual "oracle" layer is conceptually unowned
- **Severity:** Low
- **Domain:** architecture
- **Location:** `OracleAdapterFacet.sol`, `LibOracleAdapter.sol`, `DoefinV1BlockHeaderOracleFacet.sol`,
  `LibDoefinBlockHeaderOracle.sol`. Note: the `CLAUDE.md`/scope-doc references to
  `OracleManagerFacet` and `BlockScholesOracleAdapter` — **neither file exists in the repo.**
- **Structural issue:** Two distinct points.
  (a) *Naming* — with cross-currency settlement removed (SCRUM-223/224/226), there is no longer a
  price oracle, so "oracle" no longer collides with two meanings; the surviving "oracle" layer
  unambiguously means Bitcoin-condition resolution. So the *naming-collision* concern the task
  raised is **resolved** — no rename needed. `OracleAdapterFacet` is honestly named (it is a
  view-only adapter over Bitcoin difficulty/block-count/duration questions).
  (b) *Stale references* — `CLAUDE.md` (architecture section) and `audit/00-scope.md` both name
  `OracleManagerFacet` and `BlockScholesOracleAdapter` as in-scope facets. They do not exist.
  The deploy script (`scripts/deploy.js:135-151`) deploys `OracleAdapterFacet` but not those.
  This is documentation drift, not a code defect, but it means the audit scope doc lists
  phantom contracts.
- **Why it matters:** An external auditor working from `00-scope.md` will look for
  `OracleManagerFacet` / `BlockScholesOracleAdapter`, not find them, and waste time — or worse,
  assume they were removed for a reason and not audit the `OracleAdapterFacet` that actually
  shipped. Conceptual-coherence-wise, the Bitcoin oracle layer is fine; the *documentation* of it
  is not.
- **Recommendation:** Correct `audit/00-scope.md` and `.claude/CLAUDE.md` to name the
  contracts that actually exist (`OracleAdapterFacet` only; no `OracleManagerFacet`, no
  `BlockScholesOracleAdapter`). No contract change. Separately confirm whether `OracleManagerFacet`
  was *intended* to exist — if oracle-question *creation* (currently in the out-of-scope
  `ConditionManagerFacet` via `LibOracleAdapter`) was meant to be split into a manager facet, that
  is an open design decision; if not, delete the phantom names from the docs.
- **upgrade-safe:** yes (documentation only)
- **Effort:** S

### ARCH-09 — `ISettlement` bundles the operator hot path and owner governance into one interface
- **Severity:** Low
- **Domain:** architecture
- **Location:** `contracts/interfaces/ISettlement.sol`.
- **Structural issue:** `ISettlement` declares `matchOrders` + `fillOrder` (operator-only,
  hot-path) alongside `setOperator` + `pauseTrading` + `unpauseTrading` (owner-only, governance)
  and the views. It is the interface-level mirror of ARCH-01: one interface, two trust tiers.
- **Why it matters:** An off-chain integrator (the match-engine) needs only the operator surface;
  importing `ISettlement` also pulls in governance selectors it must never call. The interface
  does not communicate the operator/owner boundary that the implementation enforces.
- **Recommendation:** When ARCH-01 is actioned, split into `ISettlement` (matchOrders, fillOrder,
  views) and `ISettlementAdmin` (setOperator, pauseTrading, unpauseTrading). If ARCH-01 is *not*
  actioned, the interface split is still worthwhile on its own — interfaces are free to reshape
  pre-deploy and the `DiamondInit` ERC-165 registration would register both IDs.
- **upgrade-safe:** yes (interface-only; selectors unchanged, only their grouping)
- **Effort:** S

### ARCH-10 — `_getIndexSet` / `_getDomainSeparator` are `internal` but unused outside their facet
- **Severity:** Low
- **Domain:** architecture
- **Location:** `SettlementFacet.sol:334` (`_getDomainSeparator` — `internal`),
  `SettlementFacet.sol:848` (`_getIndexSet` — `internal`, wraps the `private` `_getIndexSetIn`).
- **Structural issue:** Both are marked `internal` but each Diamond facet is a standalone
  contract — `internal` here means "callable by inheriting contracts," and nothing inherits
  `SettlementFacet`. They are effectively `private`. `_getIndexSet` is a thin wrapper over
  `_getIndexSetIn` (`private`) that resolves `AppStorage` itself; the hot path uses `_getIndexSetIn`
  directly, so `_getIndexSet` has no caller at all within the facet.
- **Why it matters:** Minor. `internal` visibility on a facet helper signals "shared across the
  inheritance tree" when no tree exists — a small mental-model false signal. `_getIndexSet` with
  zero callers is dead code (the complexity analyst's domain too, but flagged here because it is a
  symptom of the wrapper-proliferation around the position-registry lookup).
- **Recommendation:** Mark facet-local helpers `private` unless genuinely shared; delete the
  caller-less `_getIndexSet` wrapper and keep only `_getIndexSetIn`. Cross-check with the
  complexity analyst to avoid double-reporting.
- **upgrade-safe:** yes (visibility of non-external functions does not affect the selector set)
- **Effort:** S

### ARCH-11 — Diamond assembly, `DiamondInit` one-shot, and standard facets are correct
- **Severity:** Info (positive finding)
- **Domain:** architecture
- **Location:** `Diamond.sol`, `DiamondInit.sol`, `DiamondCutFacet.sol`, `DiamondLoupeFacet.sol`,
  `OwnershipFacet.sol`, `LibDiamond.sol`.
- **Assessment:** The EIP-2535 plumbing is sound and follows the Nick Mudge reference faithfully.
  Specifically verified:
  - The `fallback()` selector router reverts `FunctionDoesNotExist` on an unknown selector — no
    silent success path.
  - `DiamondInit.init` is gated by `LibDoefinStorage.isInitialized()` /`setInitialized()` — a
    genuine one-shot guard at a dedicated slot (`keccak256("doefin.storage.initialized")`);
    re-running `init` reverts `AlreadyInitialized`. `setContractOwner` is idempotent so the
    re-entry of owner-setting is harmless even before the guard.
  - `DiamondCutFacet.diamondCut` is owner-gated via `LibDiamond.enforceIsContractOwner()`.
  - The reentrancy guard is initialized to `1` (`_NOT_ENTERED`) inside `LibDoefinStorage.initialize`,
    so the first `nonReentrant` call does not pay the 0→1 SSTORE penalty and the guard cannot be
    bypassed by an uninitialized-zero state (`LibReentrancyGuard` also defensively handles
    `_status == 0`).
  - Selector clash is handled by `LibDiamond.addFunction` (reverts on a selector already mapped).
- **Recommendation:** No change. One follow-up *for the audit team, not the code*: ARCH-08's
  phantom-facet doc drift means the deploy script's `FacetNames` list (`scripts/deploy.js:135`)
  is the authoritative facet manifest — confirm the audit's selector-clash review runs against
  that list (14 facets including `DoefinV1BlockHeaderOracle`), not the scope doc's list.
- **upgrade-safe:** n/a
- **Effort:** n/a

### ARCH-12 — Settlement libraries are correctly factored — `LibDoefinOrder`, `LibSignature`, `LibOrderValidity`
- **Severity:** Info (positive finding)
- **Domain:** architecture
- **Location:** `LibDoefinOrder.sol`, `LibSignature.sol`, `LibOrderValidity.sol`.
- **Assessment:** The v3 settlement library layer is well-shaped and is a model the rest of the
  codebase should follow:
  - `LibDoefinOrder` owns the EIP-712 struct, type hashes, and `diamondDomainSeparator` —
    `SettlementFacet`, `SignatureVerifierFacet`, and `NonceManagerFacet` all route through it, so
    the domain separator and order hash cannot drift between facets (this is the SEC-004 fix and
    it is structurally, not just locally, correct).
  - `LibSignature` is the single source of truth for ECDSA recovery + low-`s` malleability +
    EIP-1271 dispatch — promoted out of two duplicate facet copies (SEC-005). Correct placement:
    `internal` functions, no storage, pure crypto.
  - `LibOrderValidity.check` is the shared validity predicate; `NonceManagerFacet.isOrderValid`
    is the bool wrapper for the off-chain orderbook and `SettlementFacet._validateOrder` inlines
    the same rules with specific revert reasons. The split (one predicate, two presentations) is
    a deliberate and correct design — the bool form for off-chain, the revert form for the hot
    path — and the CPX-003 comment documents it.
- **Recommendation:** No change. Noting it explicitly so the reshuffles proposed above
  (ARCH-01/02/06) preserve this layering and do not regress it.
- **upgrade-safe:** n/a
- **Effort:** n/a

### ARCH-13 — `LibReentrancyGuard.nonReentrant` modifier is dead and misleading
- **Severity:** Info
- **Domain:** architecture
- **Location:** `LibReentrancyGuard.sol:81-85` (the `nonReentrant` modifier inside the library).
- **Structural issue:** Solidity libraries cannot export modifiers for use by importing contracts.
  `LibReentrancyGuard` defines a `nonReentrant` modifier anyway; the file's own NatSpec admits
  it "cannot be imported or used directly by contracts." `SettlementFacet` correctly defines its
  *own* `nonReentrant` modifier wrapping the library's `_nonReentrantBefore/After`. The library
  modifier is unreachable code that exists only to demonstrate the pattern.
- **Why it matters:** A contributor adding reentrancy protection to a new facet may try to
  `using LibReentrancyGuard for *` and apply the modifier, which will not compile — or worse,
  copy the modifier and *think* it is protecting them while calling the wrong thing. Dead code
  in a security-critical library is a small but real footgun.
- **Recommendation:** Delete the library-level `nonReentrant` modifier; keep the
  `_nonReentrantBefore` /`_nonReentrantAfter` /`_isEntered` internal functions and the NatSpec
  note instructing facets to declare their own modifier (as `SettlementFacet` already does).
- **upgrade-safe:** yes (removing an uncompilable-to-use library modifier changes nothing)
- **Effort:** S

### ARCH-14 — `ProtocolFeesWithdrawn` event already removed — `Events.sol` is clean
- **Severity:** Info (positive finding / regression re-confirmation)
- **Domain:** architecture
- **Location:** `Events.sol:186` (comment marking the removal).
- **Assessment:** The scope doc's regression checklist item REMAINING-2 ("Orphaned
  `ProtocolFeesWithdrawn` event in `Events.sol`") is **resolved** — the event is gone, replaced
  by a `(SEC-012)` comment recording the removal. Likewise the v2-era `setTradingFeesBps` fee
  params (REMAINING-3) are absent from `AdminConfigFacet`; the fee surface is now exactly
  `setMaxFeeRate` / `setResolutionFeeBps` / `setFeeReceiver`, and `Errors.sol` carries only the
  current `MaxFeeRateExceedsCeiling` / `FeeExceedsMaxRate` / `FeeExceedsProceeds` — no orphaned
  `TradingFees*` errors. The fee-model cleanup is structurally complete.
- **Recommendation:** None.
- **upgrade-safe:** n/a
- **Effort:** n/a

### ARCH-15 — `MarketDataFacet` is a coherent read-only facet but reaches across two storage namespaces
- **Severity:** Info
- **Domain:** architecture
- **Location:** `MarketDataFacet.sol` (entire file).
- **Structural issue:** `MarketDataFacet` is a clean single-responsibility facet (all-`view`,
  position/market queries). One mild observation: several of its functions read `AppStorage`
  directly *and* delegate to `LibPositionRegistry`, and `getCollateralUnit` /`getPositionInfo`
  reach into `AdminConfigStorage.unitPerPair`/`isAllowed`. So a "market data" read crosses the
  position-registry and admin-config concerns. This is acceptable — read-only aggregation across
  domains is a legitimate facet role, and a query facet that *only* read one namespace would be
  less useful — but it does mean `MarketDataFacet` has an implicit dependency on the layout of
  two sub-structs, which matters for ARCH-03/05's field-shift concern.
- **Recommendation:** No structural change. Flagged only so that if ARCH-03 peels
  `AdminConfigStorage` into its own namespace, `MarketDataFacet`'s reads are updated in the same
  pass. The facet itself is correctly shaped.
- **upgrade-safe:** n/a
- **Effort:** n/a

---

## Top 5 highest-impact items

1. **ARCH-01 (High)** — `SettlementFacet` carries owner-only `setOperator`/`pauseTrading`/
   `unpauseTrading` next to the `matchOrders` hot path. Extract to a `SettlementAdminFacet`.
   `upgrade-safe: no` — **free now, costly after the fresh deploy.** Effort S.
2. **ARCH-02 (High)** — Three unreconciled access-control mechanisms (`LibDiamond` owner check,
   `LibAccessControl` owner check, ad-hoc `msg.sender ==`); `AccessControlFacet.addMarketMaker`
   has its only gate hidden inside a library setter. Standardize on `LibDiamond.enforceIsContractOwner`
   and make every gate visible in the facet body. `upgrade-safe: yes`. Effort M.
3. **ARCH-05 (Medium)** — `AppStorage.__gap` sizing is hand-maintained with no test and no proof
   it is correct (`AdminConfigStorage` `[12]` post-SCRUM-224 is unverifiable by inspection). Add
   a compiler `storageLayout` snapshot test as a pre-deploy CI gate — highest value-to-effort.
   `upgrade-safe: yes`. Effort S.
4. **ARCH-04 (Medium)** — `CLAUDE.md` mandates EIP-7201 but the code uses plain `keccak256`
   slots with no `@custom:storage-location` annotation and no `& ~0xff` mask. Doc and code
   disagree. Decide one way and make it true; option (a) — adopt the real 7201 formula — also
   eliminates ARCH-05's hand-sized `__gap`s. `upgrade-safe: no` if slots change — free pre-deploy.
5. **ARCH-03 / ARCH-06 (Medium)** — The storage model is an undocumented `AppStorage`-monolith +
   `LibSettlementStorage`-namespace hybrid, and `LibAccessControl` is a half-migrated v2 grab-bag
   straddling `LibDiamond`, `AccessControlStorage`, and `AdminConfigStorage`. Document the
   "new modules get a namespace" rule, peel the two in-scope sub-structs out of `AppStorage`, and
   slim `LibAccessControl` to the market-maker role only. Mostly free pre-deploy.

**Genuinely sound, no action needed:** the EIP-2535 Diamond assembly, the `DiamondInit` one-shot
guard, the standard facets, the selector router (ARCH-11); the v3 settlement library layer
`LibDoefinOrder`/`LibSignature`/`LibOrderValidity` (ARCH-12); the `Events.sol`/`Errors.sol`
fee-cleanup (ARCH-14); `LibSettlementStorage` as a per-concern namespace; and `MarketDataFacet`
as a single-responsibility read facet (ARCH-15).
