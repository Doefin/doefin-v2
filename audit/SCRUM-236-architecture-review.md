# SCRUM-236 — architecture review of design doc

_Reviewer: architecture (general-purpose) · 2026-05-24 · design doc commit: `87eedd3`_

Scope: Stage-1 read-only design review of `docs/SCRUM-236-fee-bank-design.md`.
Frame of reference: `.claude/CLAUDE.md` (Fee Model, EIP-7201 Storage),
`audit/business-logic/invariants.md` (INV-SOLV-1..4, INV-FEE-1..5), the five
fee-debit sites in `SettlementFacet.sol` / `ConditionalTokensFacet.sol`,
`AdminConfigFacet.sol`, `LibAdminConfigStorage.sol`, and
`DoefinInvariantHarness.sol`.

## Verdict at a glance

| Section | Verdict | Headline |
|---|---|---|
| §1 Problem statement | ACCEPT | Cleanly states the four symptoms; the per-leg gas claim is conservative. |
| §2 Proposed model | ACCEPT | The pull-payment shape and the table of what does / does not change is sound. |
| §3 Storage additions | REVISE | Placement in `LibAdminConfigStorage` is defensible but the **no-`__gap`** claim needs a one-line caveat. |
| §4 ABI deltas | REVISE | `FeeAccrued` shape OK; the `FeeCharged` removal is the right call but the doc should explicitly enumerate indexer-side migration. Add an `Events.FeeReceiverEmpty()` semantic or rely on `InvalidFeeReceiver` — pick one and pin it. |
| §5 Invariant updates | REVISE | INV-SOLV-4 rewrite is correct **in spirit** but its rounding tolerance + fee-on-transfer slack is under-specified; INV-FEE-NEW formulation OK but the harness wording needs a per-token quantifier. |
| §6 Security checklist | REVISE | Item 8 ("no new self-transfer concern") understates a *new* concern: `address(this)` is now BOTH a receiver of fees AND a holder of position-backing collateral, and the **collateral-conservation harness** has to be re-baselined. Items 1 / 2 / 7 are right; add one item on collateral-allow-list semantics (fee-on-transfer / rebasing). |
| §7 Test plan | REVISE | Add two unit cases the doc omits (operator-fill `fee == 0` no-emit; `withdrawFees(token)` for a non-allowlisted token) and a Diamond solvency property that exercises the order of operations on the `withdrawFees` external call. |
| §8 Open questions | ANSWERED (see below) | All four resolved; Q3 in particular is the right default. |
| §9 Workstream sequencing | REVISE | Insert `sc-business-logic` BEFORE architecture sign-off OR clarify they run in parallel; missing a `sc-test-engineer` step before manual review. |
| §10 Out-of-scope | ACCEPT | Per-token cap rightly out; multi-token withdraw helper rightly deferred. Add one item: indexer-side `FeeCharged` removal coordination. |
| §11 (cross-cutting) | — | See "Cross-cutting concerns" below. |

Bucket count: 2× ACCEPT, 7× REVISE, 0× REJECT, 1× ANSWERED (§8 has no
verdict slot — it asks the architect to confirm).

---

## Section-by-section

### §1 — Problem statement

**ACCEPT.** The four symptoms accurately describe the present-day model. The
"~20–40k gas per fee leg" estimate is fair (it covers the `safeTransferFrom`
external call + ERC20 storage write); on a `_settleMerge` leg the saving is a
single `safeTransfer` plus the `FeeCharged` SLOAD/SSTORE, so the headline holds
across all four debit sites.

One nit: the symptom-1 phrasing "`setMaxFeeRate(0)` with `feeReceiver == 0` is
the only safe combination today" is slightly overstated — the `if (fee > 0)`
guards in `_settleComplementary` / `_settleMint` / `_executeOperatorFill` mean
a `maxFeeRateBps == 0` deploy with `feeReceiver == 0` also settles fine, since
`_validateFee` rejects any non-zero fee before the transfer is attempted. Only
the redemption path (`_handlePayoutTransfer`) has the unconditional
`feeReceiver == address(0)` revert. Worth tightening — it doesn't change the
conclusion, but the design doc is a future audit reference and the precision
matters.

### §2 — Proposed model

**ACCEPT.** The before/after diagram is clear; the `type(uint256).max` drain
idiom is correctly listed *before* the bounds check. The "what does NOT change"
table is the right disarmament list — auditors will read this section first to
decide whether the EIP-712 surface, the operator ABI, and `_validateFee` are
within the change blast radius.

One pure-prose recommendation: add a single sentence calling out the
**topology change**: today fees are a *push* (Diamond debits payer → credits
feeReceiver in one external call); after this change fees are an *accrual + a
later pull*. The pull-payment label captures it but a sentence on "the Diamond
becomes a *fee escrow* for the protocol owner" is worth having for audit
narrative.

### §3 — Storage additions

**REVISE.**

**(a) Placement.** Adding `accruedFees` to `LibAdminConfigStorage.AdminConfigStorage`
is defensible — fee policy lives here (`feeReceiver`, `resolutionFeeBps`,
`maxFeeRateBps`) and the new field is the *escrowed counterpart* of that
policy. But there's a real argument for a dedicated namespace
`doefin.fee-bank.storage` (`LibFeeBankStorage`):

- Single-responsibility per EIP-7201 namespace is the convention the project
  established in SCRUM-229 (the SettlementAdminFacet extraction split admin
  governance from settlement state for exactly this reason).
- `accruedFees` is a *runtime* accumulator, not configuration. Mixing
  high-frequency accumulators with low-frequency config increases the chance
  of a future careless refactor (e.g. adding a `mapping(token => Stats)`)
  expanding the struct in a way that hurts auditability.
- A separate namespace is symmetric with `LibSettlementStorage` — both are
  runtime, both have one author.

**Recommended change:** create `LibFeeBankStorage` (`doefin.fee-bank.storage`)
holding `mapping(address => uint256) accruedFees;` and (forward-looking) a
`uint256 totalWithdrawn;` per-token cumulative counter for INV-FEE-NEW. The
admin-config setters stay in `LibAdminConfigStorage`; the runtime accumulator
sits beside it. Cost: one library file, one extra `internal` getter, zero
runtime overhead.

If the author keeps it in `LibAdminConfigStorage` — fine, but the design doc
should justify the placement explicitly rather than letting it sit by
proximity.

**(b) The no-`__gap` claim.** Line 80: "No `__gap` change — EIP-7201 namespaces
are 256-slot-aligned by design." This is **correct as written** — the EIP-7201
formula `keccak256(...) - 1) & ~bytes32(uint256(0xff))` masks the low byte and
reserves 256 contiguous slots. `LibAdminConfigStorage` already explicitly
states this in its NatSpec (line 12-13 of the library). But the design doc
should reword to: "EIP-7201 namespaces reserve a 256-slot aligned region per
the formula in `LibAdminConfigStorage`; the struct can grow without a `__gap`
*until it reaches 256 slots*." The current text reads as if `__gap` is never
needed for any 7201 struct, which is only true within the 256-slot envelope.
For the current addition (one slot) this is purely a documentation precision
fix — not a behaviour change.

**(c) Storage layout snapshot.** The doc does not mention the CI gate at
`test/storage/storage-layout-snapshot.test.js` (`.claude/CLAUDE.md` Storage
section). Adding `accruedFees` to `AdminConfigStorage` is an intentional
layout change and the implementer will need to regenerate the snapshot
(`UPDATE_STORAGE_SNAPSHOT=true`). Worth a one-line note in §3 so the
implementer doesn't trip on the CI gate.

### §4 — ABI deltas

**REVISE.**

**(a) `FeeCharged` removal.** Correct in spirit — the new event is strictly
more informative — but the backend has indexers that may listen to
`FeeCharged` today (`shared/scw/encoder.py` and friends). The doc says §11
"new event added to the indexer's interest list optionally" — this is
*understated*. The indexer's interest list **must** drop `FeeCharged` and add
`FeeAccrued` + `FeesWithdrawn`, otherwise the backend silently stops seeing
fee flow. List this explicitly in §10 (out-of-scope but tracked) and §11
(rollout).

**(b) `FeeAccrued(token, amount, kind)` shape.** Indexing `token` only is the
right call — `amount` does not need indexing (queries are by token), `kind` is
a small enum so indexer-side filtering is cheap even without an index. Default
is fine.

**(c) `getAccruedFees(token)` placement.** Correct on `AdminConfigFacet` —
`MarketDataFacet` is market-scoped (positions, conditions, complements);
fee-bank state is a configuration / treasury surface. If the namespace is
split per §3(a) recommendation, the view could equivalently live on a new
`FeeBankFacet`, but bolting it onto `AdminConfigFacet` is acceptable given
how thin the surface is (one view + one mutator).

**(d) Missing errors.** `withdrawFees` reverts `InvalidFeeReceiver` if
`acs.feeReceiver == address(0)`. This error already exists. Good. But the doc
does not specify what happens if `token == address(0)` is passed —
recommend an explicit `if (token == address(0)) revert InvalidTokenAddress()`
guard (using the existing `Errors.InvalidTokenAddress`) so the function
doesn't silently call `IERC20(address(0)).safeTransfer` and revert with a
confusing low-level error. Add to §4.

**(e) Missing event field — `kind` enum on `FeesWithdrawn`?** Today
`FeesWithdrawn` is `(token, feeReceiver, amount)` — it deliberately does NOT
distinguish trading vs resolution. Correct: by the time fees are withdrawn
they're fungible, and the `FeeAccrued` event already records the split. No
change needed; just call out the design intent in the NatSpec when authored.

### §5 — Invariant updates

**REVISE.**

**(a) INV-SOLV-4 rewrite.** The new statement
`balanceOf(Diamond, token) + ROUNDING_TOLERANCE >= outstandingPairs[token] + accruedFees[token]`
is structurally correct but two things need pinning down:

1. The current harness writes `backing = (outstandingPairs / UNIT) * UNIT`
   (`DoefinInvariantHarness.sol:962`) — the floor-to-`UNIT` is exactly the
   CR-3291973200 bug the design subsumes. The doc should explicitly call out
   that the floor must be **removed** (use `outstandingPairs` directly), not
   merely that the right-hand side gains a new term. As written a reviewer
   could keep the floor and still satisfy the equation while masking
   solvency violations of size `< UNIT`. This is the *whole point* of the
   subsumption — make it loud.
2. The `ROUNDING_TOLERANCE` of `1_000` wei in the harness was sized for
   fee-of-effective-price-multiplication slack. After the redesign,
   `accruedFees[token]` is **exact** (a direct accumulator increment, no
   division), so the right-hand side is exact and the tolerance still only
   needs to cover the position-backing rounding slack. Don't shrink the
   tolerance, but do document that the tolerance is now attributable
   *entirely* to position-backing rounding, not fee rounding — auditors will
   ask.

**(b) Fee-on-transfer / non-standard ERC20s.** The current model is silent on
this because fees never sat in the Diamond — a fee-on-transfer collateral
would shortchange `feeReceiver` directly, not the Diamond's invariant. After
SCRUM-236, a fee-on-transfer collateral makes `balanceOf(Diamond, token)`
grow by **less** than the fee amount accrued to `accruedFees[token]`, and
INV-SOLV-4 (revised) can be violated *without any bug in the SC* — purely
from the ERC20's transfer-tax behaviour. The doc does not address this.

**Recommended change:** add an explicit precondition to §5:
"Collateral tokens added via `AdminConfigFacet.addCollateralToken` are assumed
to be **standard ERC20** — no fee-on-transfer, no rebasing, no callback hooks.
INV-SOLV-4 (revised) holds only under this precondition. Enforcement is by
governance (the owner-only allow-list), not by code. (Same posture as
Polymarket V2.)" This is a documentation hardening, not a code change, but
it is load-bearing — without it the revised invariant is unsound in the
presence of a misconfigured allow-list, and that's exactly the kind of finding
an external auditor will flag.

**(c) INV-FEE-NEW formulation.**
`sumFeeAccrued == accruedFees + sumFeesWithdrawn` is **the right shape** —
it's the conservation law for the new sink. Two refinements:

1. It needs a per-token quantifier: `∀ token: sumFeeAccrued[token] == accruedFees[token] + sumFeesWithdrawn[token]`.
   The current wording reads as a scalar, which would only work for a
   single-token harness (which the current harness is). The production
   contract supports multiple collaterals.
2. The harness has to maintain `sumFeeAccrued[token]` and
   `sumFeesWithdrawn[token]` as harness-side counters. These are
   *test-only* state — adding two `mapping(address => uint256)` to
   `DoefinInvariantHarness.sol` is the right place. Call this out in §7.

**(d) INV-SOLV-1 / INV-SOLV-3 fee-flow clause rewording.** The doc correctly
identifies that these two invariants' "fees never enter the Diamond's
balance" sentences are factually overturned and need rewording, and delegates
the wording to `sc-business-logic`. Good — that's the right delegation. Spell
out one constraint: the rewording must preserve the **collateral-flow
assertions** (mint adds exactly `f`, complementary is net-zero on Diamond
ERC20). Only the fee sentences move; the collateral-flow encodings remain.
The `sc-business-logic` brief should make that explicit.

### §6 — Security review checklist

**REVISE.**

**(1) Co-mingling.** The phrasing is correct and load-bearing. One addition:
the check `amount <= accruedFees[token]` is necessary AND sufficient
*provided* the contract has no other path that decreases
`balanceOf(Diamond, token)` without symmetrically decreasing
`outstandingPairs` or `accruedFees`. Today the only paths that decrease
`balanceOf(Diamond, token)` are `_mergePositionsInternal`,
`_handlePayoutTransfer`, the new `withdrawFees`, and `redeemPositions`. The
checklist should require the reviewer to enumerate these *exhaustively* —
"all balance-decreasing paths preserve `balance >= outstandingPairs +
accruedFees`" is the invariant we want, and item 1 only covers `withdrawFees`.
A future facet (say, a treasury rebalancer) could violate it. Make this a
**meta-check** for the reviewer: list every `safeTransfer` / `safeTransferFrom`
where the Diamond is `from`, and confirm each preserves the invariant.

**(2) Reentrancy.** Correct. `LibReentrancyGuard._nonReentrantBefore/After`
is the project pattern (used in `_handlePayoutTransfer` lines ~225, ~235).
Worth adding: the guard must wrap **the entire withdraw function body**, not
just the external call — the storage decrement and event emit must be inside
the guarded region too, so a malicious ERC20 hook cannot re-enter via a
loupe call mid-state.

**(3) Access control.** Correct. `LibDiamond.enforceIsContractOwner` is the
right gate. No `marketMaker` path. No `operator` path.

**(4) Integer arithmetic.** Correct. Solidity 0.8.20 default checked
arithmetic + the explicit `<=` check makes underflow impossible.

**(5) Event ordering.** OK but worth being more prescriptive: emit
`FeesWithdrawn` **after** the storage decrement and **after** the external
call, while still inside the reentrancy guard. This ordering ensures off-chain
indexers never see a `FeesWithdrawn` for a call that subsequently reverted.

**(6) Stuck `feeReceiver`.** Correct.

**(7) `type(uint256).max` drain idiom.** Correct ordering as written
(resolve → check bounds → check feeReceiver → effect → external call).
Two refinements:

1. Add an explicit guard for `accruedFees[token] == 0` when `amount ==
   type(uint256).max` is passed. The current spec catches this via the
   subsequent `amount > 0` check (since `amount` resolves to 0), so it's
   correctly handled — but the doc names the error as `NoFeesAccrued` for
   this case. Pick one — either `ZeroAmount` is reused (simpler) or
   `NoFeesAccrued` is the explicit case. The §4 ABI deltas list both errors.
   If both stay, the spec needs to say *when* each fires: `NoFeesAccrued` =
   drain-when-empty, `ZeroAmount` = explicit `0` passed by caller.
2. The drain idiom should be implemented with a single local variable, not by
   mutating the parameter. Solidity calldata parameters are read-only but
   memory parameters aren't — writing `amount = accruedFees[token]` is fine
   if `amount` is the function parameter (Solidity will accept this), but the
   convention I'd recommend is `uint256 withdrawAmount = (amount ==
   type(uint256).max) ? acs.accruedFees[token] : amount;` for readability.

**(8) Diamond self-transferFrom.** This is the item that needs **the most
revision**. The doc says "structurally identical; no new self-transfer
concern." That is true for the *individual call* — Diamond pulling collateral
from itself via `safeTransferFrom` is already a pattern in
`_settleMint`. **But** the system-level statement that needs updating is in
`DoefinInvariantHarness.echidna_collateral_conserved` (line 944): the harness
currently sums `balanceOf(diamond) + balanceOf(harness) + balanceOf(FEE_RECEIVER) +
Σ actors` and asserts that equals `totalCollateralMinted`. After SCRUM-236:

- `balanceOf(diamond)` will include un-withdrawn fees that **today** flow
  to `FEE_RECEIVER`. The closed-system sum still equals `totalCollateralMinted`
  (collateral never leaves the closed system), so the invariant holds, BUT
- The companion `echidna_fee_receiver_only_grows` invariant (line 997)
  **breaks**. Under the new model, `FEE_RECEIVER`'s balance grows only when
  the owner calls `withdrawFees` — not on every settlement leg. The harness
  has no `fuzz_withdraw` driver today, so `FEE_RECEIVER`'s balance would
  *never* grow under fuzzing, and the monotonic-up assertion would still
  hold vacuously, but the invariant's *meaning* changes silently. The fix is
  to (a) add a `fuzz_withdraw` driver in the harness AND (b) ratchet against
  `accruedFees[token] + balanceOf(FEE_RECEIVER)` rather than
  `balanceOf(FEE_RECEIVER)` alone.

These are harness changes, not contract changes, but they belong in §6
(security review depends on the harness being faithful to the new model) and
§7 (test plan). The design doc currently omits this.

**(9) Storage isolation.** Correct. If the namespace is split per §3(a),
this becomes a `LibFeeBankStorage.feeBankStorage().accruedFees[...]` call
from both SettlementFacet and ConditionalTokensFacet; if not, the existing
`LibAdminConfigStorage.adminConfigStorage().accruedFees[...]` works.

**(10) Front-running.** Correct, but add a small sentence on the asymmetry
the redesign introduces: under the *current* model, an admin who delays
calling `setFeeReceiver` after a misconfiguration loses fees on every trade
in the interim. Under the *new* model, the admin has an arbitrarily-large
window to fix `feeReceiver` because the fees are escrowed. This is a strict
improvement on the admin-error vector and worth banking in the doc as a
qualitative benefit.

**(NEW item 11) Collateral allow-list semantics.** Per §5(b), the design
should explicitly require standard-ERC20 collateral. Add this to the manual-
reviewer's checklist: verify that the allow-list (and the
`addCollateralToken` flow) is documented as "owner-attested standard ERC20"
and that there is a code comment in `addCollateralToken` referencing this
invariant. This is documentation-only; no code change.

### §7 — Test plan

**REVISE.** The unit coverage is complete for `withdrawFees` happy/sad paths.
Three additions:

1. **Per-fee-debit-site unit tests with `fee == 0`.** The doc lists "each
   settlement leg increments `accruedFees[token] by the per-leg fee" — add
   the symmetric case: when `fee == 0` (operator legitimately passes 0),
   `accruedFees[token]` is unchanged and `FeeAccrued` is **not** emitted.
   This is the regression check for the original CR-3291973203 logic.
2. **`withdrawFees` for a non-allowlisted (or removed-allowlisted) token.**
   What happens if `addCollateralToken(USDC)` → some trades → `removeCollateralToken(USDC)`
   → `withdrawFees(USDC)`? Should still succeed (fees were lawfully accrued
   before delisting and remain owner-claimable). Add an explicit unit test
   asserting the withdraw works post-delist; this is a likely auditor
   question.
3. **Reentrancy regression.** Deploy a malicious `feeReceiver` contract that
   re-enters `withdrawFees` (or `matchOrders`) in its `receive` /
   `transfer` hook, and assert the call reverts cleanly with the
   `Reentrant` error. This pins the §6 item 2 claim.

**Invariant suite:**
- `echidna_diamond_solvent` rewrite: confirm the `(outstandingPairs / UNIT) * UNIT`
  floor is **removed** — see §5(a)(1).
- `echidna_fee_accounting_symmetry` needs the per-token quantifier per
  §5(c)(1).
- New `fuzz_withdrawFees` driver in the harness per §6(8).
- New `echidna_fee_receiver_plus_accrued_only_grows` (or rename the existing
  one) per §6(8).

**Characterization tests:** the doc correctly flags these will fail and is
expected. Add a note that `Events.FeeCharged` assertions need to be migrated
to `FeeAccrued` plus a future `FeesWithdrawn`, not just deleted.

### §8 — Open questions

**Q1 — `FeeAccrued.kind` as `uint8` enum vs `bytes32` topic.**
**Confirm `uint8`.** Two values today (TRADING, RESOLUTION); a third (e.g.
"redistribution") would still fit in `uint8`. `bytes32` topic is overkill and
costs an extra log topic slot. Define the enum in a small library or in
`LibConstants` (e.g. `LibConstants.FEE_KIND_TRADING = 0`,
`LibConstants.FEE_KIND_RESOLUTION = 1`) so the values are not magic numbers
sprinkled in the settlement code.

**Q2 — `withdrawFees` emit per-event or batched.**
**Confirm per-event.** Batching is an optimisation looking for a problem; the
single owner call already lands one `FeesWithdrawn` per token, and the per-
token granularity is the natural query unit for off-chain treasury accounting.

**Q3 — `withdrawFees(token=address(0), amount)` mean "all tokens".**
**Confirm: single-token only.** The codebase has **no enumerable allow-list**
(I verified — no `EnumerableSet`, no `allowedTokens[]`). A multi-token drain
would need to enumerate the allow-list, which means adding an
`EnumerableSet.AddressSet` to `AdminConfigStorage` (a real change in storage
layout) just to enable an admin convenience. Not worth it; the admin calls
`withdrawFees(USDC)` once per collateral. If this comes back as a product
request, the right move is to add a separate
`withdrawFeesBatch(address[] calldata tokens, uint256[] calldata amounts)`
helper later — not to overload `address(0)`.

**Q4 — `getAccruedFees(token)` on `AdminConfigFacet` vs `MarketDataFacet`.**
**Confirm `AdminConfigFacet`.** `MarketDataFacet` is market-scoped (positions
/ conditions / complements). Treasury state belongs with config. If the
namespace is split per §3(a), a dedicated `FeeBankFacet` is the cleanest
home, but bolting it onto `AdminConfigFacet` is acceptable.

### §9 — Workstream sequencing

**REVISE.**

The current ordering is:
`sc-architecture-reviewer` → `sc-business-logic` → `sc-developer` → `sc-manual-reviewer` → `sc-gas-optimizer` (optional).

Two issues:

1. **`sc-business-logic` should run in parallel with `sc-architecture-reviewer`
   (or before).** The architecture review depends on the invariant rewrite
   being feasible — if `sc-business-logic` discovers, say, that INV-FEE-NEW
   conflicts with INV-FEE-3's exclusivity claim, the architecture design has
   to change. Better to run them in parallel and reconcile before
   `sc-developer` starts, otherwise there's a re-do risk.
2. **`sc-test-engineer` is implicit in `sc-developer`'s scope.** The project
   convention is that the developer writes tests alongside the change. Fine
   as-is, but make this explicit in the workstream — call it
   `sc-developer (impl + unit tests)` so the manual reviewer knows what
   they're reading.

**Recommended sequence:**
1. `sc-architecture-reviewer` + `sc-business-logic` (parallel).
2. Reconciliation pass — author updates the design doc with verdicts.
3. `sc-developer` (impl + unit tests + harness update).
4. `sc-test-engineer` (echidna run on the updated harness, characterization
   migration).
5. `sc-manual-reviewer` (final read-through against the security checklist).
6. `sc-gas-optimizer` (optional).

### §10 — Out-of-scope

**ACCEPT** with one addition: explicitly list **backend indexer migration**
as out-of-scope-for-SC-but-tracked. The backend's `FeeCharged` event listener
(if any) needs to be updated to consume `FeeAccrued` and `FeesWithdrawn`.
Rolling out the SC change without that indexer update silently drops fee
visibility in the backend's analytics — a known operational hazard that the
SC ticket should hand off cleanly.

Per-token withdraw cap: agree, not needed. Multi-token batch: agree, defer.

### §11 — Rollout

The "atomic SC change" framing is correct given v3 is pre-launch. Two
additions:

- Storage layout snapshot regeneration (`UPDATE_STORAGE_SNAPSHOT=true`) is
  needed in the same commit as the storage change — call this out.
- The backend ABI regen claim (`encoder.py` unaffected) is correct
  *technically* (no EIP-712 struct change), but the backend's settlement ABI
  in `match-engine/app/utils/settlement_abi.py` needs the new event signatures
  added if the indexer consumes them. Mention this in the rollout section.

---

## Cross-cutting concerns

**(C1) Naming consistency.** The design uses `accruedFees`, `FeeAccrued`,
`FeesWithdrawn`, `getAccruedFees`, `InsufficientAccruedFees`, `NoFeesAccrued`.
Mostly consistent. Minor:

- `InsufficientAccruedFees` vs `NoFeesAccrued` — distinct cases (insufficient
  vs zero) but the §6 item 7 footnote suggests one might subsume the other.
  Pick one cleanly:
  - Option A: keep both; `NoFeesAccrued` = drain-when-zero, `InsufficientAccruedFees` = explicit-`amount` > accrued.
  - Option B: collapse to one — `InsufficientAccruedFees(uint256 requested, uint256 available)` parameterised.
  Option B is more informative for off-chain debugging and matches the
  `FillAmountMismatch(sumOfMakerFills, takerFillAmount)` parameterisation
  pattern used elsewhere in the codebase (per `invariants.md` INV-FILL-3).

**(C2) Audit-trail / treasury observability.** The `FeeAccrued` /
`FeesWithdrawn` event pair is sufficient for off-chain reconstruction of
total fee inflow / outflow. Consider adding (forward-looking, not for
SCRUM-236): a `getCumulativeFeesAccrued(token)` and
`getCumulativeFeesWithdrawn(token)` view pair backed by per-token uint256
storage counters. Cost: 2 SSTORE per `FeeAccrued`, 1 SSTORE per
`withdrawFees`. Benefit: off-chain analytics derive total fee revenue by a
single SLOAD instead of indexer scan. Defer for now; mention as future work.

**(C3) Pause integration.** The doc does not mention whether `withdrawFees`
should be gated by `SettlementAdminFacet.pauseTrading` / `isTradingPaused`.
Recommendation: **no** — fee withdrawal is an admin-treasury operation
distinct from trading, and pausing should not prevent the owner from
sweeping fees (which might in fact be the *reason* the pause was triggered).
But the doc should answer this explicitly to forestall the question.

**(C4) Upgrade story for `v3/dev`-deployed instances.** The branch context
says this lands on `v3/dev` before audit freeze, on a fresh v3 deploy. So
there is no migration story — the EIP-7201 storage addition is greenfield.
Good. But the design doc should explicitly state "this is a greenfield
storage addition; no migration script is needed" so a future reviewer
checking against a deployed Diamond does not look for one.

**(C5) Pull-payment + multi-owner.** If at any point the protocol moves to a
multisig owner (e.g. a Gnosis Safe — and the parent branch is
`SCRUM-213-MultiSigSetupForContractAdmin`), the `enforceIsContractOwner`
gate already handles this correctly (the Safe address is the owner). No
design change needed, but worth noting in §6: "the withdraw gate is the
Diamond owner, which under SCRUM-213 will be a Safe — no further changes
required." The two tickets compose cleanly.

---

## Open questions for the user

Only one architecture question I cannot resolve from the doc + the corpus:

**Q-A. Storage namespace placement (§3(a)).** Recommend choosing one:
- **Option 1:** keep `accruedFees` in `LibAdminConfigStorage`
  (`doefin.admin-config.storage`). Cheapest change; couples runtime
  accumulator to config; consistent with how `setMaxFeeRate` / `setFeeReceiver`
  live in the same namespace today.
- **Option 2:** new `LibFeeBankStorage` (`doefin.fee-bank.storage`) per
  ARCH-03 precedent. One new file; clean separation of runtime
  accumulator from config; symmetric with `LibSettlementStorage`.

I lean Option 2 (slight) but Option 1 is defensible and lower implementation
cost. Architect's call. The rest of the §6 / §7 changes are independent of
this decision.

---

## Recommendation

**`PROCEED-WITH-REVISIONS-LISTED`.**

The design is fundamentally sound. The pull-payment pattern is the right
shape, the security framing (especially the user-pushed-back co-mingling
re-framing) is honest about what the redesign actually changes, and the
invariant subsumption (INV-SOLV-4 → CR-3291973200, `setMaxFeeRate`
no-change-guard → CR-3291973202, `_handlePayoutTransfer` zero-fee →
CR-3291973203) is clean.

The seven REVISE items are concrete, mostly documentation hardening, and
none require a topology change. The most consequential are:

1. **§5(b) + §6 (NEW item 11):** make the standard-ERC20 / no-fee-on-transfer
   precondition on the collateral allow-list **explicit** in the invariant
   spec. INV-SOLV-4 (revised) is unsound otherwise.
2. **§5(a)(1) + §7:** the `(outstandingPairs / UNIT) * UNIT` floor in the
   echidna harness **must be removed** as part of this ticket (it's what
   CR-3291973200 was about, and the design subsumes that finding). Make this
   loud — it's easy to miss in a side-by-side line edit.
3. **§6 item 8:** the **harness invariants** (`echidna_collateral_conserved`,
   `echidna_fee_receiver_only_grows`) need rewriting to match the new
   model, and a new `fuzz_withdrawFees` driver is required. This is a
   harness change, not a contract change, but it is in scope for SCRUM-236
   and the doc currently omits it.

Resolve those three, accept the §8 question answers (uint8 enum, per-event,
single-token, AdminConfigFacet), pick a verdict on Q-A (namespace
placement), and the design is ready for the `sc-business-logic` /
`sc-developer` baton pass.
