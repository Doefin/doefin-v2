# Doefin v3 — Business-Logic Findings (Domain 3, pre-triage)

Raw per-domain findings from the `sc-business-logic` pass. Pinned commit
`015097c1c7f8b6a5d70be21972eb345bf1082c06`. Schema per `security/audit-protocol.md`.
All entries carry `source: business-logic`. Severities here are the domain reviewer's
proposal; `audit-triage` makes the final call.

## Summary

| ID | Title | Severity | Status |
|----|-------|----------|--------|
| BIZ-001 | `_settleMerge` silent payout-skip can over-remit fees and break Diamond solvency | medium | confirmed |
| BIZ-002 | `_settleMerge` runs the CTF merge before the crossing-check (effects-before-checks) | low | confirmed |
| BIZ-003 | `_executeOperatorFill` permits zero `collateralAmount` (free position tokens) | low | confirmed |
| BIZ-004 | `pricePerToken <= unit` is not enforced in the complementary / operator-fill paths | low | confirmed |
| BIZ-005 | On-chain `_computeFee` only asserted at `price = 0.5`; asymmetric branch & per-maker summation untested | low | confirmed |
| BIZ-006 | `side` is not constrained to `{0,1}`; `side >= 2` reaches the complementary path | low | confirmed |
| BIZ-007 | `.claude/CLAUDE.md` states the operator is the fee recipient; the code sends fees to `feeReceiver` | informational | confirmed |
| BIZ-008 | `minFillAmount` is a signed-but-ignored order field; struct comment is stale | informational | confirmed |

No CRITICAL/HIGH business-logic findings. The two crown-jewel solvency invariants
(INV-SOLV-1 mint, INV-SOLV-2 merge) **hold on this commit** — but INV-SOLV-2 holds only
because `MAX_FEE_RATE_BPS = 500` keeps `fee < payout`; BIZ-001 makes that dependency
implicit and unguarded. See the go/no-go note at the end.

---

### BIZ-001: `_settleMerge` silent payout-skip can over-remit fees and break Diamond solvency
id:             BIZ-001
domain:         business-logic
severity:       medium
status:         confirmed
decision:       fix
reverify:       pending
location:       contracts/facets/SettlementFacet.sol:575-587
source:         business-logic
duplicate-of:   -
conflicts-with: -
regression-of:  -
swc:            -
title:          Merge pays the full fee even when a party's payout is below its fee, draining the Diamond
description:    `_settleMerge` distributes the `f` collateral recovered by the CTF merge as
                `takerPayout = f - makerPayout` and `makerPayout = floorDiv(P_m*f,unit)`.
                The two payouts are sent under guards `if (takerPayout > takerFee)` (line
                576) and `if (makerPayout > makerFee)` (line 579), but the fee leg is sent
                unconditionally: `totalFees = takerFee + makerFee` is `safeTransfer`-ed to
                `feeReceiver` (lines 584-587). When a party's fee is >= its payout, that
                party's payout transfer is silently skipped while its fee is still
                remitted. Conservation then fails: total paid out becomes
                `f + (fee - payout) > f`, and the surplus is drawn from collateral backing
                *other* markets. The intended invariant is
                `(takerPayout-takerFee) + (makerPayout-makerFee) + totalFees == f`
                (INV-SOLV-2), which only holds when both subtractions are non-negative.
impact:         Diamond under-collateralization / cross-market fund leak to `feeReceiver`.
                NOT reachable on the current commit: the merge crossing check
                (`P_t + P_m <= unit`, line 567) forces `effPrice(P_t) <= P_t <= unit-P_m`,
                so with `feeBps <= MAX_FEE_RATE_BPS (500)` the fee is at most ~5% of the
                payout — strictly less than the payout for both parties. The bug is
                therefore latent: it is gated entirely by the 5% cap and the crossing
                check. Any future change that raises `MAX_FEE_RATE_BPS`, adds a fee
                surcharge, or loosens the crossing rule re-arms it with no compiler or
                test signal. The silent-skip also means a genuine under-payment would
                surface as a successful tx, not a revert.
poc:            Conceptual (cap must be lifted to realize it): set `MAX_FEE_RATE_BPS` high
                enough that `takerFee > takerPayout`. With `unit=1e6`, `f=1e6`,
                `P_m=999_000` → `makerPayout=999_000`, `takerPayout=1_000`. A taker
                `feeBps` giving `takerFee > 1_000` (needs feeBps well above 500 on the
                effPrice basis) skips the taker payout but still sends `takerFee` in
                `totalFees`. Diamond pays `makerPayout - makerFee + takerFee + makerFee
                = makerPayout + takerFee > f`. The fuzz property `echidna_merge_conserves`
                with the cap check stubbed out demonstrates it directly.
recommendation: Make the conservation invariant explicit rather than emergent. Replace the
                guarded transfers with checked subtraction so an inverted payout reverts
                instead of silently leaking:
                ```solidity
                // reverts on underflow if fee > payout — fail loud, never silently skip
                uint256 takerNet = takerPayout - takerFee;
                uint256 makerNet = makerPayout - makerFee;
                if (takerNet > 0) IERC20(taker.collateralToken).safeTransfer(taker.maker, takerNet);
                if (makerNet > 0) IERC20(maker.collateralToken).safeTransfer(maker.maker, makerNet);
                uint256 totalFees = uint256(takerFee) + uint256(makerFee);
                if (totalFees > 0) IERC20(taker.collateralToken).safeTransfer(feeReceiver, totalFees);
                ```
                Or assert `takerPayout >= takerFee && makerPayout >= makerFee` at the top
                of the payout block. Either keeps INV-SOLV-2 true by construction
                independent of `MAX_FEE_RATE_BPS`. Pair with the Gap-1 merge-with-fee test.
upgrade-safe:   yes
fix-commit:     -
fix-test:       -

---

### BIZ-002: `_settleMerge` runs the CTF merge before the crossing-check (effects-before-checks)
id:             BIZ-002
domain:         business-logic
severity:       low
status:         confirmed
decision:       fix
reverify:       pending
location:       contracts/facets/SettlementFacet.sol:543-567
source:         business-logic
duplicate-of:   -
conflicts-with: -
regression-of:  -
swc:            -
title:          Merge crossing-check is validated after position tokens are already burned
description:    In `_settleMerge` the order of operations is: (1) pull both sellers'
                position tokens into the Diamond (lines 544-545), (2) call
                `_mergePositionsInternal` — burns the tokens, credits collateral, runs the
                ERC-1155 acceptance callback (line 557), (3) *then* validate the crossing
                condition `P_t + P_m <= unit` (line 567) and revert `InvalidMatch` if it
                fails. `_settleMint` places the analogous crossing check (line 476) BEFORE
                its `_splitPositionInternal` call (line 510) — the correct, consistent
                order. Merge is checks-after-effects.
impact:         No fund loss — a revert at line 567 unwinds every state change atomically
                (the whole `matchOrders` tx reverts). The impact is (a) gas wasted
                executing the merge and its callback on a transaction that is doomed to
                revert, and (b) an inconsistency between the two paths that makes the code
                harder to reason about and easier to break in future edits. It is also a
                latent hazard: if a future refactor ever made part of `_settleMerge`
                non-atomic (e.g. a try/catch, or splitting the function), the
                already-applied burn would not be unwound.
poc:            Submit a merge where `P_t + P_m > unit`. Trace shows `_batchBurn` and the
                merge mint/transfer execute, then `InvalidMatch` reverts at line 567.
recommendation: Move the crossing check to the top of `_settleMerge`, immediately after
                the `collateralToken` equality check (line 537) and before the ERC-1155
                pulls — mirroring `_settleMint` line 476:
                ```solidity
                if (uint256(taker.pricePerToken) + uint256(maker.pricePerToken) > unit)
                    revert Errors.InvalidMatch();
                ```
                Delete the duplicate check at line 567.
upgrade-safe:   yes
fix-commit:     -
fix-test:       -

---

### BIZ-003: `_executeOperatorFill` permits zero `collateralAmount` (free position tokens)
id:             BIZ-003
domain:         business-logic
severity:       low
status:         confirmed
decision:       fix
reverify:       pending
location:       contracts/facets/SettlementFacet.sol:593-619
source:         business-logic
duplicate-of:   -
conflicts-with: -
regression-of:  NEW-5
swc:            -
title:          Operator fill computes collateralAmount via floor division that can truncate to zero
description:    `_executeOperatorFill` computes
                `collateralAmount = floorDiv(order.pricePerToken * fillAmount, unit)`
                (line 601). `matchOrders`/`fillOrder` only guard `fillAmount != 0` (token
                units), never the resulting collateral. When
                `pricePerToken * fillAmount < unit` the collateral truncates to 0. For a
                BUY order (`side == 0`) the operator then receives
                `collateralAmount - fee` from the maker and sends `fillAmount` position
                tokens (lines 605-610): if `fee == 0` the maker pays 0 and gets tokens for
                free; if `fee > 0` the `collateralAmount - fee` subtraction underflow-
                reverts. For a SELL order the operator pays 0 collateral and takes the
                maker's tokens. This is the prior review's NEW-5, still open on this
                commit — no `collateralAmount == 0` guard was added.
impact:         Low. The operator is the trusted counterparty in `fillOrder` and chooses
                whether to submit such a transaction. A buggy or compromised operator bot
                could be fed a dust order and either revert (fee>0) or hand out free
                tokens (fee==0). Bounded to dust-sized fills.
poc:            `fillOrder` with a sell order, `unit=1e6`, `pricePerToken=1`,
                `fillAmount=999999`, `feeRateBps=0` → `collateralAmount = floorDiv(999999,
                1e6) = 0`; operator receives the maker's 999999 tokens for 0 collateral.
recommendation: Add an explicit guard in `_executeOperatorFill` after computing
                `collateralAmount`:
                ```solidity
                if (collateralAmount == 0) revert Errors.ZeroAmount();
                ```
                Add the Gap-9 tests (sell-side fill, dust-fill truncation).
upgrade-safe:   yes
fix-commit:     -
fix-test:       -

---

### BIZ-004: `pricePerToken <= unit` is not enforced in the complementary / operator-fill paths
id:             BIZ-004
domain:         business-logic
severity:       low
status:         confirmed
decision:       fix
reverify:       pending
location:       contracts/facets/SettlementFacet.sol:437,601,633-647
source:         business-logic
duplicate-of:   -
conflicts-with: -
regression-of:  -
swc:            -
title:          A signed price above unit is only rejected in the fee path, and only when feeRateBps != 0
description:    The only `pricePerToken <= unit` check is in `_computeFee`
                (`if (price > unit) revert InvalidPrice`, line 643), and `_computeFee`
                early-returns at line 639 when `feeRateBps == 0` — so a zero-fee order
                with `pricePerToken > unit` is never checked there. `_settleComplementary`
                computes `collateralAmount = floorDiv(maker.pricePerToken * f, unit)`
                (line 437) and `_executeOperatorFill` does the same (line 601) with no
                `price <= unit` guard. For mint and merge the crossing checks
                (`P_t + P_m >= unit` / `<= unit`) bound prices indirectly, but a
                complementary settlement at `pricePerToken > unit` simply transfers
                more collateral than the token notional (`> f`), and a zero-fee
                operator-fill does likewise.
impact:         Low. `pricePerToken` is part of the signed order — the maker would have to
                sign a price above `unit`, which a correct frontend never produces, and
                the operator is trusted to match well-formed orders. No insolvency (the
                excess is paid by the buyer to the seller, value-conserving between
                counterparties). Impact is an unintended over-payment for a malformed
                signed order, not a protocol leak.
poc:            Complementary settlement, `unit=1e6`, both orders `pricePerToken=2e6`,
                `feeRateBps=0`, `f=1e6` → buyer pays `collateralAmount = floorDiv(2e6*1e6,
                1e6) = 2e6` for `1e6` tokens. No revert.
recommendation: Add a single price-domain check applied to every order, e.g. inside
                `_validateOrder` (where `unit` for `order.collateralToken` is available):
                ```solidity
                uint256 unit = LibDoefinStorage.appStorage()
                    .adminConfigStorage.unitPerPair[order.collateralToken];
                if (uint256(order.pricePerToken) > unit) revert Errors.InvalidPrice();
                ```
                This makes `0 <= pricePerToken <= unit` a global precondition, so the fee
                path, complementary path and operator-fill path all inherit it. Add the
                Gap-5 test.
upgrade-safe:   yes
fix-commit:     -
fix-test:       -

---

### BIZ-005: On-chain `_computeFee` only asserted at `price = 0.5`; asymmetric branch & per-maker summation untested
id:             BIZ-005
domain:         business-logic
severity:       low
status:         confirmed
decision:       fix
reverify:       pending
location:       test/unit/SettlementFacet/SettlementFacet.test.js:529-569,685-718
source:         business-logic
duplicate-of:   -
conflicts-with: -
regression-of:  -
swc:            -
title:          Fee-formula tests exercise the JS helper, not the contract, except at price 0.5
description:    The "Fee calculation (symmetric formula)" describe block
                (`SettlementFacet.test.js:529-569`) asserts only the **JavaScript** helper
                `computeExpectedFee` against a manual JS computation — it never calls a
                contract function. The contract's `_computeFee` is exercised on-chain only
                inside the complementary settlement test (L298-334) and only at
                `price == UNIT/2`, where `min(P, unit-P) == P` so the asymmetric
                `effPrice = min(P, unit-P)` branch is degenerate. The behavior of
                `_computeFee` for `P != unit/2` (e.g. `P = 0.1`, where `effPrice = P`, vs
                `P = 0.9`, where `effPrice = unit-P`) is never confirmed against the
                deployed contract. Separately, INV-FEE-4 (taker fee summed per-maker in
                the `matchOrders` loop) is unverified: "Multi-maker settlement"
                (L685-718) asserts only `getFilledAmount`, and the 1:many mint test uses
                `feeRateBps = 0`.
impact:         No vulnerability — this is a test-coverage finding. The fee math itself is
                correct on inspection (INV-FEE-1). But the asymmetric branch and the
                loop-summation are economically load-bearing (they decide what users pay)
                and currently rest on inspection alone. A regression in either would not
                be caught.
poc:            n/a — coverage gap. `SettlementFacet.sol` branch coverage is 73.61%; the
                fee-asymmetry and per-maker branches are among the uncovered ~26%.
recommendation: Add (sc-developer) settlement tests that assert the **contract-charged**
                fee via balance deltas: (a) a complementary or fillOrder settlement at
                `pricePerToken = 0.1*unit` and at `0.9*unit`, asserting `fee ==
                floorDiv(feeBps * 100000 * f, unit*1e4)` for both; (b) a multi-maker
                `matchOrders` with `feeRateBps > 0` asserting the `feeReceiver` delta
                equals the sum of per-leg taker and maker fees and is `<=` the single-shot
                fee on the total. See coverage.md Gap-2 and Gap-3.
upgrade-safe:   n/a
fix-commit:     -
fix-test:       -

---

### BIZ-006: `side` is not constrained to `{0,1}`; `side >= 2` reaches the complementary path
id:             BIZ-006
domain:         business-logic
severity:       low
status:         confirmed
decision:       fix
reverify:       pending
location:       contracts/facets/SettlementFacet.sol:346-362,413-434
source:         business-logic
duplicate-of:   -
conflicts-with: -
regression-of:  -
swc:            -
title:          Match-type determination accepts an out-of-domain order side
description:    `DoefinOrder.side` is a `uint8` documented as `0 = BUY, 1 = SELL`. Nothing
                in `_validateOrder`, `_verifySignature`, or `_determineMatchType`
                constrains it to `{0,1}`. In `_determineMatchType`, a same-position pair
                with `taker.side = 0` and `maker.side = 2` satisfies
                `taker.side != maker.side` (line 351) and is routed to COMPLEMENTARY.
                `_settleComplementary` then derives roles from `takerIsBuyer = (taker.side
                == 0)` (line 425): the `side = 2` maker is silently treated as the seller.
                The MINT/MERGE branches require exact `0`/`0` or `1`/`1` (lines 357-358),
                so `side >= 2` cannot reach them — the gap is confined to the
                complementary path, but it means an order with undefined buy/sell
                semantics can still be settled.
impact:         Low. `side` is part of the signed order, so the signer chose the bad
                value; the operator is trusted to submit well-formed pairs; mint/merge are
                immune. The realistic harm is a malformed (UI-bug or hand-crafted) order
                being settled with a side semantics neither party validated. No direct
                insolvency. Cross-listed because it is a `_determineMatchType` correctness
                gap, not only an input-validation nit.
poc:            `matchOrders` with `taker` (`side=0`) and `maker` (`side=2`) on the same
                `positionId`; `_determineMatchType` returns `MATCH_COMPLEMENTARY` and
                `_settleComplementary` settles with the `side=2` order as the seller.
recommendation: Reject `side > 1` early — in `_validateOrder`:
                ```solidity
                if (order.side > 1) revert Errors.InvalidMatch();
                ```
                (or a dedicated `InvalidSide` error). Add the Gap-7 test. Coordinate with
                the security reviewer — this also belongs to the input-validation surface.
upgrade-safe:   yes
fix-commit:     -
fix-test:       -

---

### BIZ-007: `.claude/CLAUDE.md` states the operator is the fee recipient; the code sends fees to `feeReceiver`
id:             BIZ-007
domain:         business-logic
severity:       informational
status:         confirmed
decision:       fix
reverify:       pending
location:       contracts/facets/SettlementFacet.sol:444,449,490,493,584-587,607,616
source:         business-logic
duplicate-of:   -
conflicts-with: -
regression-of:  -
swc:            -
title:          Documentation says the matchOrders operator collects fees; the contract pays feeReceiver
description:    `.claude/CLAUDE.md` ("Fee Model (Polymarket pattern)") states: "Operator
                (`msg.sender` of `matchOrders()`) is the fee recipient." The deployed code
                does not do this. Every fee transfer in `SettlementFacet` — complementary
                (lines 444/449), mint (490/493), merge (584-587), operator-fill (607/616)
                — sends to `AppStorage.adminConfigStorage.feeReceiver`, an
                owner-configured address (`AdminConfigFacet.setFeeReceiver`). The operator
                is never a fee sink. `INV-FEE-5` confirms `feeReceiver` is the sole sink.
impact:         No code defect — the contract behavior is the correct/intended one
                (a single owner-controlled fee receiver). The risk is purely
                documentation drift: an integrator or auditor trusting CLAUDE.md would
                mis-model the fee flow and could mis-account operator economics.
poc:            n/a — documentation vs code mismatch, verified by reading every
                `feeReceiver` reference in `SettlementFacet.sol`.
recommendation: Correct `.claude/CLAUDE.md` to state that fees are sent to the
                owner-configured `feeReceiver` (set via `AdminConfigFacet.setFeeReceiver`),
                not to the `matchOrders` operator. (Documentation-only; no contract
                change.)
upgrade-safe:   n/a
fix-commit:     -
fix-test:       -

---

### BIZ-008: `minFillAmount` is a signed-but-ignored order field; struct comment is stale
id:             BIZ-008
domain:         business-logic
severity:       informational
status:         confirmed
decision:       defer
reverify:       pending
location:       contracts/libraries/LibDoefinOrder.sol:18-34; .claude/CLAUDE.md
source:         business-logic
duplicate-of:   -
conflicts-with: -
regression-of:  -
swc:            -
title:          minFillAmount is part of the EIP-712 hash but has zero on-chain effect
description:    `DoefinOrder.minFillAmount` is a field of the struct and is included in
                `DOEFIN_ORDER_TYPEHASH` / `hash()` / `hashCalldata()`, so it is covered by
                the EIP-712 signature. `SettlementFacet` performs no `fillAmount >=
                minFillAmount` check anywhere — the SCRUM-121/122 / budget-model proposal
                (SC-Task E) deliberately removed the enforcement and deleted
                `Errors.FillBelowMinimum`, keeping the field only so previously-signed
                orders stay hash-stable. This is an intentional design choice and is NOT a
                regression of the prior HIGH-2 (HIGH-2 was "fixed" then deliberately
                reverted by SC-Task E). The backend `encoder.py` keeps the field too, so
                EIP-712 parity is intact. The stale part is documentation: the order-struct
                comment in `.claude/CLAUDE.md` lists `minFillAmount` without noting it is
                inert, and there is no NatSpec on the struct field saying it is ignored
                on-chain.
impact:         No vulnerability and no value at risk — the field is simply dead weight in
                the signed payload. The only risk is confusion: a reader of the struct or
                CLAUDE.md may assume `minFillAmount` is enforced and design an order
                expecting dust-fill protection that does not exist.
poc:            n/a. `SettlementFacet.test.js:725-837` ("minFillAmount enforcement")
                explicitly asserts that below-minimum fills now succeed.
recommendation: Add a one-line NatSpec note on `LibDoefinOrder.DoefinOrder.minFillAmount`
                ("signed for hash stability; not enforced on-chain as of SCRUM-121/122")
                and the same note in `.claude/CLAUDE.md`. Documentation-only; safe to
                defer. Optionally schedule full removal of the field in a future EIP-712
                version bump (would invalidate outstanding signatures — out of scope here).
upgrade-safe:   n/a
fix-commit:     -
fix-test:       -

---

## Differential check result (LibDoefinOrder ↔ backend encoder.py)

PASS. `LibDoefinOrder` (`DOEFIN_ORDER_TYPEHASH`, `hash`, `hashCalldata`,
`DOMAIN_SEPARATOR_TYPEHASH`, `domainSeparator`) is byte-for-byte consistent with
`/Users/reza/workspace/predexyo/doefin-backend/shared/scw/encoder.py`
(`DOEFIN_ORDER_TYPE_STRING`, `compute_struct_hash`, `EIP712_DOMAIN_TYPE_STRING`,
`compute_domain_separator`, `compute_order_hash`):

- Order typehash: 15 fields, identical order and types in both — `uint256 salt`,
  `address maker`, `address signer`, `bytes32 positionId`, `address collateralToken`,
  `uint8 side`, `uint128 amount`, `uint128 pricePerToken`, `uint128 minFillAmount`,
  `uint8 orderType`, `address quoteCurrency`, `uint128 exchangeRate`, `uint16 feeRateBps`,
  `uint64 expiration`, `uint256 nonce`.
- Domain typehash: identical — `EIP712Domain(string name,string version,uint256 chainId,
  address verifyingContract)`.
- Final digest framing: both compute `keccak256(0x1901 || domainSeparator || structHash)`.
- Domain values: name `"Doefin Exchange"`, version `"2.1"` — match `SettlementFacet`,
  `SignatureVerifierFacet`, `NonceManagerFacet`.

No finding. (Listed so triage has the result on record.)

---

## Go / no-go relevant notes for the orchestrator

- **No CRITICAL/HIGH business-logic finding.** The mint and merge solvency invariants
  (INV-SOLV-1, INV-SOLV-2) hold on this commit.
- **BIZ-001 (MEDIUM) + Gap-1** together are the item to watch: INV-SOLV-2 currently holds
  *only because* `MAX_FEE_RATE_BPS = 500` keeps `fee < payout`, and the merge path is
  **never tested with a non-zero fee**. The invariant is not zero-coverage, but the
  solvency-critical fee interaction is. Recommendation: treat "fix BIZ-001 + add the
  merge-with-fee test (Gap-1)" as a required CONDITIONAL-GO item — it removes an
  unguarded dependency on a constant rather than fixing a live exploit.
- All other findings are LOW/INFORMATIONAL — CONDITIONAL-GO with a fix or a written
  accepted-risk note.
- The one failing test (`BatchSubmissionBugRepro.test.js`) is in the **out-of-scope**
  CTF/oracle group (`ConditionManagerFacet` / `LibConditionMetadata`); it is not a
  business-logic finding but should be routed to the oracle-suite owner.
