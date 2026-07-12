# Domain 1 — Manual Security Review Findings

**Audit:** Doefin v3 Mainnet-Readiness Audit
**Domain:** 1 (Security — `sc-manual-reviewer`)
**Pinned commit:** `015097c1c7f8b6a5d70be21972eb345bf1082c06`
**Method:** Deep manual reading + Slither cross-reference (27 raw results) + OWASP SCSVSv2 / SC Top 10 (2025) checklist.
**Scope:** `SettlementFacet`, `SignatureVerifierFacet`, `NonceManagerFacet` (crown jewels) + `AccessControlFacet`,
`AdminConfigFacet`, `MarketDataFacet`, `ERC1155Facet`, `ERC1155ReceiverFacet`, `OracleAdapterFacet`,
`OracleManagerFacet`, `BlockScholesOracleAdapter`, and the in-scope libraries.

## Summary of counts

| Severity | Count | IDs |
|---|---|---|
| Critical | 0 | — |
| High | 2 | SEC-001, SEC-002 |
| Medium | 5 | SEC-003, SEC-004, SEC-005, SEC-006, SEC-007 |
| Low | 4 | SEC-008, SEC-009, SEC-010, SEC-011 |
| Informational | 3 | SEC-012, SEC-013, SEC-014 |

All HIGH findings are **compromised-operator-context** or **silent-misconfiguration** — none are reachable
by an unprivileged caller without a trust assumption, hence not CRITICAL. They are still mainnet-blocking
per the rubric (HIGH = loss of funds / integrity behind a precondition).

---

## Findings

### SEC-001: `_settleComplementary` never verifies `taker.collateralToken == maker.collateralToken`

id:             SEC-001
domain:         security
severity:       high
status:         confirmed
decision:       fix
reverify:       pending
location:       contracts/facets/SettlementFacet.sol:413-454
source:         manual-reviewer
duplicate-of:   -
conflicts-with: -
regression-of:  -
swc:            SWC-110 (assertion / missing input validation)
title:          Complementary path settles entirely in the taker's collateral token; the maker's signed `collateralToken` is ignored
description:    `_settleMint` (line 469) and `_settleMerge` (line 537) both begin with `if (taker.collateralToken != maker.collateralToken) revert Errors.InvalidMatch();`. `_settleComplementary` has **no such check**. It reads `unit` and performs every ERC-20 transfer with `IERC20(taker.collateralToken)` (lines 437, 440, 444, 449). The maker's order is EIP-712-signed over its own `collateralToken` field (it is part of `DOEFIN_ORDER_TYPEHASH`), but that field is never read in the complementary path. If a maker signs a SELL priced in token A and the operator pairs it with a taker BUY whose `collateralToken` is token B, the seller receives `(maker.pricePerToken * fillAmount) / unitB` units of **token B** — a token they never agreed to accept, priced against token B's `unitPerPair`, not token A's.
impact:         A compromised or buggy operator can settle a maker's order in a collateral token the maker never authorised. Because the maker SCW must hold an allowance for token B (for a SELL the seller does not pay collateral, only `sellerFee` — so impact for a SELL maker is the unwanted `sellerFee` debit in token B plus receiving the wrong token; for a BUY maker the buyer's full `collateralAmount` is pulled in token B). Combined with a mismatched `unit` between the two tokens (e.g. token A `unit=1e6`, token B `unit=1e18`) the executed price is wrong by 12 orders of magnitude — the buyer can be made to pay `1e12x` too much or the seller paid `1e12x` too little. The position-token (ERC-1155) leg still transfers `fillAmount` of `taker.positionId`, so token accounting is internally consistent; the loss is entirely on the ERC-20 leg. The maker's signature does not protect them because their `collateralToken` field is simply not consulted. This is a HIGH compromised-operator finding analogous to prior MEDIUM-2 but with a larger blast radius (wrong token + wrong unit).
poc:            (1) Register binary market on token A (`unitPerPair[A]=1e6`). Maker signs SELL of positionId P, price 0.6e6, collateralToken=A. (2) Taker signs BUY of P, price 0.6e6, collateralToken=B where `unitPerPair[B]=1e18`. (3) Operator calls `matchOrders`. `_determineMatchType` returns COMPLEMENTARY (same positionId, opposite side — collateralToken not consulted). `_settleComplementary` computes `collateralAmount = 0.6e6 * fillAmount / 1e18 ≈ 0` and transfers ~0 token B from buyer to seller, then transfers `fillAmount` of P from seller to buyer. The seller hands over position tokens for nothing. Invariant `complementary-token-consistency` (see Invariant section) fails.
recommendation: Add the same guard the other two paths already have, as the first statement of `_settleComplementary`:
```solidity
if (taker.collateralToken != maker.collateralToken) revert Errors.InvalidMatch();
```
Place it before the `unit` read. Add a regression test pairing two orders with differing `collateralToken`.
upgrade-safe:   yes (no storage / selector change)
fix-commit:     -
fix-test:       -

---

### SEC-002: Settlement does not validate that `order.collateralToken` is an allowed collateral in the Complementary path; a removed/zero-unit token yields silent mispricing rather than a clean revert

id:             SEC-002
domain:         security
severity:       high
status:         confirmed
decision:       fix
reverify:       pending
location:       contracts/facets/SettlementFacet.sol:413-454, 593-619
source:         manual-reviewer
duplicate-of:   -
conflicts-with: -
regression-of:  -
swc:            SWC-110
title:          Complementary and operator-fill paths price against `unitPerPair[token]` without confirming the token is whitelisted; an unwhitelisted token has `unit == 0`
description:    `_settleComplementary` (line 421) and `_executeOperatorFill` (line 599) read `uint256 unit = ds.adminConfigStorage.unitPerPair[token]` and divide by it. They never call `LibAccessControl.isCollateralTokenAllowed(token)`. The Mint/Merge paths are indirectly protected because `LibCTFCondition._splitPositionInternal` / `_mergePositionsInternal` call `_validateAndBuildPartitionPositions` and (for split) `isCollateralTokenAllowed` — but `_mergePositionsInternal` does **not** re-check `isCollateralTokenAllowed`, and neither merge-internal nor the complementary path checks the *unit*. Two distinct failure modes: (a) Token never whitelisted, or whitelisted then `removeCollateralToken` called (which `delete`s `unitPerPair`, line 78 of `AdminConfigFacet`): `unit == 0`, so `collateralAmount = price * fill / 0` → division-by-zero panic. That is a *safe* revert. (b) The dangerous case: `_computeFee` reads the same `unit` and on `unit == 0` `price > unit` is true for any non-zero price → it reverts with `InvalidPrice()`. So fee-bearing orders revert. But a **zero-fee order** (`feeRateBps == 0`, `_computeFee` returns 0 *before* the unit read at line 639) combined with a token whose `unitPerPair` was set to a *non-standard small value* still settles at a wrong price. The core defect is the absence of an explicit `isCollateralTokenAllowed` gate at the top of every settlement entry path, so correctness depends entirely on `unitPerPair` being both set and sane.
impact:         A compromised operator can settle complementary or operator-fill trades for a token that is not (or no longer) an approved collateral, at a price scaled by whatever stale/zero `unitPerPair` value remains. With `unitPerPair` deleted the trade reverts (DoS only). With `unitPerPair` mis-set (admin error) the trade executes at a wrong price and value leaks. The protocol's whitelist is silently not enforced on the hot path. This compounds SEC-001.
poc:            Admin adds token T with `unitPerPair[T]=1` by mistake (intended `1e6`). Operator settles a zero-fee complementary order, price `0.5e6`. `collateralAmount = 0.5e6 * fill / 1 = 0.5e6 * fill` — the buyer pays `1e6x` the intended collateral. No revert, because `feeRateBps==0` bypasses the `_computeFee` unit guard.
recommendation: Add an explicit allow-list + non-zero-unit gate to `_validateOrder` (it already takes the order) or to each settlement path. Preferred — central, applies to every path:
```solidity
// in _validateOrder, after the existing checks:
LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
if (!ds.adminConfigStorage.isAllowed[order.collateralToken]) revert Errors.TokenNotAllowed();
if (ds.adminConfigStorage.unitPerPair[order.collateralToken] == 0) revert Errors.InvalidUnitPerPair();
```
This makes the whitelist a hard precondition for settlement and removes the dependency on division-by-zero as an accidental safety net.
upgrade-safe:   yes
fix-commit:     -
fix-test:       -

---

### SEC-003: `_executeOperatorFill` allows a zero `collateralAmount` fill (prior NEW-5 — still OPEN)

id:             SEC-003
domain:         security
severity:       medium
status:         confirmed
decision:       fix
reverify:       not-fixed
location:       contracts/facets/SettlementFacet.sol:593-619
source:         manual-reviewer
duplicate-of:   -
conflicts-with: -
regression-of:  NEW-5
title:          Operator direct-fill computes `collateralAmount` by integer division and does not reject a truncated-to-zero result
description:    `_executeOperatorFill` computes `collateralAmount = (price * fillAmount) / unit` (line 601). When `price * fillAmount < unit` the result truncates to 0. For a BUY order it then runs `safeTransferFrom(order.maker, msg.sender, collateralAmount - fee)`. With `collateralAmount == 0` and `fee == 0` (the only consistent fee for a zero-value trade) the maker pays nothing and the operator still delivers `fillAmount` of position tokens to the maker (line 610). For a SELL it is the mirror: the maker delivers `fillAmount` position tokens and receives 0 collateral. The prior follow-up (NEW-5) recommended `if (collateralAmount == 0) revert Errors.ZeroAmount();`. That guard was **never added** — `_executeOperatorFill` at the pinned commit still has no zero-amount check. Note also `collateralAmount - fee` underflows (reverts) if `fee > collateralAmount`; for a small dust fill where `collateralAmount` rounds low but `fee` rounds to a non-zero `uint128`, `fillOrder` reverts opaquely instead of with a domain error — a secondary defect.
impact:         A compromised operator can mint/extract position tokens for free via `fillOrder` against a maker whose order parameters allow a sub-unit fill, or grief a maker into surrendering position tokens for zero proceeds. Operator is trusted, so MEDIUM not HIGH; but `fillOrder` is a single-signature path with no second party to object, so the operator's discretion is the only control. Also a correctness/robustness gap: `collateralAmount - fee` underflow gives an opaque panic.
poc:            `unitPerPair = 1e6`. Maker signs a SELL, `pricePerToken = 1`, `feeRateBps = 0`. Operator calls `fillOrder(order, sig, 0, fillAmount = 999999)`. `collateralAmount = 1*999999/1e6 = 0`. Maker's 999999 position tokens move to the operator; maker receives 0 collateral.
recommendation: Add at the top of `_executeOperatorFill` (after computing `collateralAmount`):
```solidity
if (collateralAmount == 0) revert Errors.ZeroAmount();
if (collateralAmount < fee) revert Errors.InvalidPrice(); // or a dedicated FeeExceedsProceeds error
```
Apply the same `collateralAmount == 0` reasoning to `_settleComplementary` (line 437) — a zero `collateralAmount` there lets a buyer take position tokens for free.
upgrade-safe:   yes
fix-commit:     -
fix-test:       -

---

### SEC-004: Domain-separator computation is inconsistent across facets — `SettlementFacet` reads a cache the other two facets ignore (prior NEW-3 — still OPEN)

id:             SEC-004
domain:         security
severity:       medium
status:         confirmed
decision:       fix
reverify:       not-fixed
location:       contracts/facets/SettlementFacet.sol:236-247; SignatureVerifierFacet.sol:102-109; NonceManagerFacet.sol:166-173
source:         manual-reviewer
duplicate-of:   -
conflicts-with: -
regression-of:  NEW-3, NEW-2
title:          `SettlementFacet._getDomainSeparator` returns `ss.domainSeparator` (cache) while `SignatureVerifierFacet` and `NonceManagerFacet` always recompute; the cache has no `chainId` invalidation
description:    `SettlementFacet._getDomainSeparator` (line 236): `if (ss.domainSeparator != bytes32(0)) return ss.domainSeparator;`. `SignatureVerifierFacet._getDomainSeparator` (line 102) and `NonceManagerFacet._getDomainSeparator` (line 166) unconditionally call `LibDoefinOrder.domainSeparator("Doefin Exchange","2.1",block.chainid,address(this))`. Two consequences. (a) **Stale-cache divergence (NEW-3):** after a chain fork, or if `cacheDomainSeparator()` were ever called on a different chainId, `SettlementFacet` uses the cached separator while `NonceManagerFacet.cancelOrder` and `SignatureVerifierFacet.verifyOrderSignature` use the live one. The hash a user cancels via `NonceManagerFacet` (`ss.cancelledOrders[hash]=true`) would differ from the hash `SettlementFacet` computes and looks up — the cancellation silently does not block settlement. (b) **No chainId guard (NEW-2):** the cache stores only `bytes32 domainSeparator` (`LibSettlementStorage` line 49); there is no `cachedChainId`. On a fork, signatures from the original chain remain valid. For a *fresh mainnet deploy* `cacheDomainSeparator()` would be called once on Base mainnet, so chainId is correct at cache time; the residual risk is a future Base hard-fork that changes `block.chainid`. Both NEW-2 and NEW-3 were explicitly flagged "Required / Recommended before mainnet" in the SC-008 follow-up and neither was implemented.
impact:         Cancellation-ineffective-after-fork (a) is the security-relevant case: a user believes an order is dead, but `SettlementFacet` can still settle it because it hashes with a different domain separator. Bounded to a chain-fork scenario, hence MEDIUM. (b) is a defense-in-depth gap. The simplest robust fix removes the inconsistency entirely.
poc:            Cannot be reproduced on a single chain without forcing `cacheDomainSeparator()` on a wrong chainId. Conceptual: cache separator for chainId X; fork to chainId Y; `NonceManagerFacet.cancelOrder` writes `cancelledOrders[hash_Y]`; `SettlementFacet._validateOrder` checks `cancelledOrders[hash_X]` → not cancelled → order settles.
recommendation: Make all three facets behave identically. Two acceptable fixes: **(i)** Have `SignatureVerifierFacet` and `NonceManagerFacet` read the same `ss.domainSeparator` cache via a shared helper, AND add a `cachedChainId` field to `SettlementStorage` (consume one `__gap` slot, 49→48) with `_getDomainSeparator` returning the cache only when `ss.cachedChainId == block.chainid`. **(ii)** Simpler: delete the cache entirely — recompute in all three (the SC-008 LOW-1 caching saved only ~300 gas; on Base L2 that is negligible and the consistency win dominates). Recommend (ii) unless gas profiling says otherwise. Either way, all three facets MUST use one code path; extract `LibDoefinOrder`-level shared logic. See SEC-005.
upgrade-safe:   no (option (i) changes `SettlementStorage` layout — `__gap` 49→48; for a fresh deploy this is fine, but document it; option (ii) is layout-neutral)
fix-commit:     -
fix-test:       -

---

### SEC-005: Duplicate `_verifySignature` / `_recoverSigner` implementations across three facets, with a divergence in EIP-1271 handling (prior REMAINING-1 / LOW-3 — still OPEN)

id:             SEC-005
domain:         security
severity:       medium
status:         confirmed
decision:       fix
reverify:       not-fixed
location:       contracts/facets/SettlementFacet.sol:252-297; SignatureVerifierFacet.sol:129-196; OracleManagerFacet.sol:544-560
source:         manual-reviewer
duplicate-of:   -
conflicts-with: -
regression-of:  REMAINING-1
title:          Three independent ECDSA recovery code paths; `OracleManagerFacet._recoverSigner` lacks the malleability check the other two carry, and the two settlement copies differ in EIP-1271 dispatch
description:    There are three hand-rolled signature verifiers. (1) `SettlementFacet._verifySignature` (line 252): inline-assembly `r/s/v` extraction, `v < 27` normalisation, low-`s` malleability check, then for EIP-1271 a **low-level `staticcall`** of `isValidSignature(bytes32,bytes)` with manual `result.length < 32` / `abi.decode` handling (line 287-292). (2) `SignatureVerifierFacet._verifySignature` (line 129) + `_recoverSigner` (line 169): same assembly + `v` normalisation + low-`s` check, but EIP-1271 goes through the **typed `IERC1271(order.maker).isValidSignature`** interface (line 151). (3) `OracleManagerFacet._recoverSigner` (line 544): assembly `r/s/v` extraction, **no `v` normalisation, no low-`s` malleability rejection**, raw `ecrecover`. The settlement pair is *functionally* equivalent today and both carry the HIGH-3 malleability fix, but (a) the EIP-1271 dispatch mechanism differs — a future fix to one (e.g. handling a contract wallet that reverts vs returns wrong magic) can be forgotten in the other, and the `SettlementFacet` low-level-call variant silently treats a too-short return as failure where the interface variant would revert on a non-conforming return; (b) `OracleManagerFacet` is missing malleability rejection. `manualUpdatePrice` is protected by per-nonce replay storage (`usedNonces`, line 374), so a malleable variant cannot be replayed *after* the nonce is consumed — but a malleable signature is still accepted as valid for a fresh nonce, which is a deviation from the protocol's own standard set in the settlement facets and from OZ ECDSA.
impact:         No directly exploitable theft today (settlement uses `orderHash` as the replay key, oracle uses `usedNonces`). The risk is *maintenance / consistency*: divergent verifiers are a latent source of a future signature bug, and the oracle path's missing malleability guard is an inconsistency a re-audit must keep flagging. MEDIUM as a defense-in-depth + maintainability-with-security-implications issue.
poc:            n/a (no exploit at the pinned commit).
recommendation: Extract one shared `LibSignature` with `recoverSigner(bytes32 digest, bytes calldata sig) -> address` (assembly extraction + `v` normalisation + low-`s` rejection) and `verifyEIP1271(address wallet, bytes32 hash, bytes calldata sig) -> bool`. Have `SettlementFacet`, `SignatureVerifierFacet`, and `OracleManagerFacet` all call it. Pick one EIP-1271 dispatch (the typed `IERC1271` interface is cleaner; if a defensive low-level call is wanted, use `OZ Address.functionStaticCall` semantics consistently). This closes REMAINING-1 and the oracle malleability gap in one change.
upgrade-safe:   yes (library extraction, no storage/selector change; behaviour identical)
fix-commit:     -
fix-test:       -

---

### SEC-006: `feeRateBps` cap is a *post-signature* check — a maker who signs a high `feeRateBps` is bound by it; combined with operator-as-fee-recipient this is unfair-fee extraction

id:             SEC-006
domain:         security
severity:       medium
status:         confirmed
decision:       fix
reverify:       pending
location:       contracts/facets/SettlementFacet.sol:633-647 (`_computeFee`); 112-127, 165 (call sites)
source:         manual-reviewer
duplicate-of:   -
conflicts-with: -
regression-of:  -
title:          Per-order `feeRateBps` up to `MAX_FEE_RATE_BPS` (500 = 5%) is fully honoured; the fee recipient in `matchOrders` is the operator, so a compromised/colluding operator extracts up to 5% of `min(price,1-price)*fill`
description:    The fee model is "Polymarket-style": `feeRateBps` is signed by the maker and `_computeFee` (line 633) caps it at `MAX_FEE_RATE_BPS = 500`. That cap correctly bounds the *maximum*. The residual issues: (a) **`matchOrders` sends fees to a token-implied recipient that is `feeReceiver` (CTF admin config), but `fillOrder`'s `_executeOperatorFill` sends fees to `feeReceiver` too** — both fee legs go to `ds.adminConfigStorage.feeReceiver` (lines 444, 449, 490, 493, 607, 615). So the operator is *not* the direct fee recipient — the CLAUDE.md statement "Operator is the fee recipient" is **stale / contradicted by the code**. Re-confirmed: every fee transfer in `SettlementFacet` targets `feeReceiver`, not `msg.sender`. (b) The real residual risk: `feeReceiver` is owner-controlled (`AdminConfigFacet.setFeeReceiver`), and the operator chooses *which* signed orders to match and at *what* `fillAmount`. A compromised operator that also influences `feeReceiver` (or simply matches orders that carry the maximum 5% `feeRateBps`) extracts up to 5% of notional on every fill, repeatedly, with the maker's own signature as cover. There is no per-maker fee ceiling lower than the global 5%, and no on-chain notion of "the maker intended a 0.2% fee" — whatever was signed is enforced. (c) `_computeFee` is called *per maker* inside the loop with `takerOrder.feeRateBps` for the taker's share (line 124) — correct, no double-charge — verified.
impact:         Bounded value leak: at most 5% of `min(price,1-price)*fillAmount` per order, to `feeReceiver`. Not unbounded, not theft of principal. MEDIUM (capped value leak / operational constraint per the rubric). The finding is mainly to (1) correct the stale CLAUDE.md claim that the operator is the fee recipient, and (2) flag that 5% is a high cap for a prediction market and the operator's order-selection discretion turns it into a guaranteed rake.
poc:            Maker's wallet UI is compromised and presents a transaction that signs `feeRateBps = 500`. Operator matches it. `feeReceiver` collects 5% of `min(price,1-price)*fill`. Maker has no on-chain recourse — the signature is valid.
recommendation: (1) Update CLAUDE.md and any spec doc — fees go to `feeReceiver`, not the operator. (2) Consider lowering `MAX_FEE_RATE_BPS` to a value matching the product's real fee (e.g. 100 = 1%) so a UI-manipulation attack is bounded an order of magnitude tighter. (3) Optionally emit the `feeRateBps` used in `OrderSettled` (it currently emits the absolute `fee`, not the rate) so off-chain monitoring can flag anomalous rates. No storage/selector change needed for (2)/(3).
upgrade-safe:   yes
fix-commit:     -
fix-test:       -

---

### SEC-007: `_settleMerge` accepts `taker.price + maker.price < unit`, permanently locking dust collateral in the Diamond (prior NEW-4 — still OPEN, marginally widened)

id:             SEC-007
domain:         security
severity:       medium
status:         confirmed
decision:       defer
reverify:       not-fixed
location:       contracts/facets/SettlementFacet.sol:566-588
source:         manual-reviewer
duplicate-of:   BIZ-? (overlaps business-logic price-sum solvency — flag for triage dedup)
conflicts-with: -
regression-of:  NEW-4
title:          Merge crossing check is `>` not `==`; when prices sum below `unit` the un-distributed collateral stays trapped in the Diamond
description:    `_settleMerge` burns both position tokens via `_mergePositionsInternal`, which returns exactly `fillAmount` of collateral to the Diamond (`safeTransfer` is skipped because `sender == address(this)`, so the collateral simply remains on the Diamond's balance). It then computes `makerPayout = maker.price * fill / unit`, `takerPayout = fill - makerPayout` (lines 570-571) and pays each party `payout - fee`. The crossing guard (line 567) is `if (taker.price + maker.price > unit) revert InvalidMatch();` — a strict `>`. So `taker.price + maker.price < unit` is *allowed*. In that case `makerPayout + takerPayout == fillAmount` always (taker gets the remainder), so the two parties together still receive `fillAmount - totalFees` and `totalFees` goes to `feeReceiver` — meaning the *full* `fillAmount` is distributed and there is **no dust from the payout split itself**. Re-reading carefully: the dust NEW-4 described arises only from the *fee* path — `takerPayout > takerFee` and `makerPayout > makerFee` are guarded with `>` (lines 576, 579), so if `takerPayout == takerFee` exactly, that payout leg is skipped but `totalFees` (line 584) still includes `takerFee`, so `feeReceiver` is paid it — no loss. The genuine residual: the *Mint* side, `_settleMint`, requires `taker.price + maker.price >= unit` (line 476, `<` reverts) and collects `takerCollateral + makerCollateral` where `takerCollateral = fill - makerCollateral` — again exactly `fillAmount`. So mint collects exactly `fillAmount` and mints `fillAmount` of each token; merge burns `fillAmount` of each and returns exactly `fillAmount`. The price-sum solvency invariant therefore **holds for the token-vs-collateral conservation** because the remainder construction (`takerX = fill - makerX`) forces it. What `>`-vs-`==` actually permits is an **economically unfair** merge: with `taker.price + maker.price < unit`, the taker is paid `unit - maker.price` worth (the remainder) which is *more* than a fair price, at the maker's expense relative to a `==` market — but total collateral is conserved. So NEW-4's "dust locked" framing is **largely refuted at this commit** (the remainder construction fixed it); the residual is the asymmetric-fairness window, which is a compromised-operator fairness issue, not insolvency.
impact:         No Diamond insolvency and no permanently-locked dust from the split/merge math itself (remainder construction conserves collateral — see Verified Safe). Residual: a compromised operator can settle a merge where the price sum is below `unit`, redistributing value from maker to taker (or vice-versa via which side is "maker"). Bounded by the signed prices. MEDIUM as a fairness/operator-trust issue; *not* the solvency CRITICAL it was historically derived from. Flagged `defer` because the economic-fairness dimension is Domain 3's (business-logic) call — triage should dedup against the price-sum invariant there.
poc:            Merge with `taker.price = 0.2*unit`, `maker.price = 0.2*unit` (sum 0.4`unit`). `makerPayout = 0.2*fill`, `takerPayout = 0.8*fill`. Collateral conserved (`1.0*fill` distributed) but the taker receives 4x the maker — unfair if both are genuine sellers of complementary outcomes.
recommendation: Tighten both crossing checks to require the prices to *sum to exactly unit* for Mint and Merge, OR document explicitly that the operator is trusted to only submit `priceSum == unit` pairs and the `>=`/`<=` slack is intentional aggressor-price-improvement. Given SCRUM-121 deliberately introduced "effective price = unit − P_m", the slack is *intentional design* for price improvement — in which case downgrade to LOW/informational and document. Recommend: confirm with the team whether sub-unit merge sums are intended; if not, change line 567 to `!=` and line 476 to `!=`.
upgrade-safe:   yes
fix-commit:     -
fix-test:       -

---

### SEC-008: `OracleManagerFacet.updatePrice` is permissionless and can be griefed into pausing trading for an asset

id:             SEC-008
domain:         security
severity:       low
status:         confirmed
decision:       accept-risk
reverify:       pending
location:       contracts/facets/OracleManagerFacet.sol:241-307
source:         manual-reviewer
duplicate-of:   -
conflicts-with: -
regression-of:  -
swc:            SWC-105 (unprotected critical function — partial)
title:          Anyone may call `updatePrice`; if all adapters momentarily fail it sets `assetConfig.tradingPaused = true` for that asset
description:    `updatePrice` has no `enforceIsContractOwner` / operator gate (unlike every other state-changing function in the facet). On a path where all priority adapters return invalid/stale data or revert, the function sets `assetConfig.tradingPaused = true` (line 302) and reverts. A griefer can repeatedly call `updatePrice` for an asset during any window where the underlying Block Scholes oracle is briefly unavailable, keeping `tradingPaused` set; it is cleared only by a *successful* `updatePrice` / `manualUpdatePrice` / `emergencyUpdatePrice`. Per the audit scope, the v3 settlement path (`SettlementFacet`) does **not** consult `oracleStorage` — settlement has its own `ss.tradingPaused`. So oracle `tradingPaused` only affects oracle consumers, of which the in-scope cross-currency settlement was explicitly removed (SC-006). Impact is therefore confined to oracle-data freshness, not settlement.
impact:         Low. Permissionless price refresh is a deliberate keeper pattern (anyone can push a fresh price). The only griefing lever is forcing `tradingPaused` during a real oracle outage — but during a real outage the price *should* be paused. No fund loss; no settlement-path effect (v3 settlement uses a separate pause flag).
poc:            During a Block Scholes outage, call `updatePrice(assetId)` — it sets `tradingPaused`. Re-call after a successful adapter response is needed to clear it. No economic gain to the caller.
recommendation: Acceptable as-is for a keeper-style design. If tighter control is wanted, restrict the *trading-pause side effect* to owner/operator while leaving the price-refresh open, or require N consecutive failures before pausing. Document that `updatePrice` is intentionally permissionless.
upgrade-safe:   yes
fix-commit:     -
fix-test:       -

---

### SEC-009: `incrementNonce` / `cancelOrdersForPosition` cannot be invoked on behalf of an SCW by its registered EOA signer — only `msg.sender == maker` can cancel

id:             SEC-009
domain:         security
severity:       low
status:         confirmed
decision:       accept-risk
reverify:       pending
location:       contracts/facets/NonceManagerFacet.sol:30-34, 57-69, 115-125
source:         manual-reviewer
duplicate-of:   -
conflicts-with: -
regression-of:  -
title:          On-chain cancellation keys off `msg.sender`; an SCW (Safe) maker can only cancel by having the *Safe itself* send the transaction
description:    `incrementNonce` (line 32) writes `ss.makerToNonce[msg.sender]`; `cancelOrder` requires `msg.sender == order.maker` (line 58); `cancelOrdersForPosition` writes `ss.makerPositionToMinSalt[msg.sender][...]`. In the v3 model `order.maker` is the **SCW (Safe)** and `order.signer` is the controlling **EOA** (`LibDoefinOrder` comments, lines 22-23). `SignatureVerifierFacet.registerOrderSigner` lets the SCW delegate signing to an EOA, but cancellation has *no* delegated-canceller equivalent: the EOA signer cannot cancel the SCW's orders on-chain. The SCW must itself originate the cancel transaction (a Safe multisig execution). This is not a vulnerability — `msg.sender`-keyed cancellation is correct and unspoofable — but it is an availability asymmetry: signing is delegable, cancelling is not. If the off-chain orderbook is the primary cancellation channel (soft-cancel via `CancelIntent`, per `encoder.py` SCRUM-73) and on-chain cancel is the emergency backstop, the backstop requires a full Safe transaction.
impact:         Low. No fund loss, no replay. Operational: emergency on-chain cancellation by an SCW maker is heavier than expected. The off-chain `CancelIntent` flow (signed by the EOA) covers the common case.
poc:            n/a — behavioural observation.
recommendation: If product wants delegated on-chain cancellation, add `cancelOrderFor(order)` / `incrementNonceFor(maker)` that accept a call from a `registeredOrderSigners[maker][msg.sender]` signer. Otherwise document that on-chain cancellation is SCW-originated only. No change required for security.
upgrade-safe:   yes (new selectors only, if implemented)
fix-commit:     -
fix-test:       -

---

### SEC-010: `getFilledAmount` and `LibSettlementStorage.orderHashToFilledAmount` are `uint256` while `order.amount` and `fillAmount` are `uint128` — a benign type mismatch with a latent assumption

id:             SEC-010
domain:         security
severity:       low
status:         confirmed
decision:       accept-risk
reverify:       pending
location:       contracts/facets/SettlementFacet.sol:218, 322-333; LibSettlementStorage.sol:32
source:         manual-reviewer
duplicate-of:   -
conflicts-with: -
regression-of:  -
title:          Filled-amount accumulator is `uint256`; `_checkFillAmount` casts `orderAmount` (uint128) into `uint256` arithmetic — correct, but accumulation is never bounded to `uint128`
description:    `orderHashToFilledAmount` is `mapping(bytes32 => uint256)`. `matchOrders`/`fillOrder` do `ss.orderHashToFilledAmount[h] += fillAmount` where `fillAmount` is `uint128`. `_checkFillAmount` (line 322) computes `remaining = uint256(orderAmount) - filled` and reverts if `fillAmount > remaining`. Because `_checkFillAmount` runs *before* every accumulation and caps the cumulative fill at `orderAmount` (a `uint128`), `orderHashToFilledAmount[h]` can never exceed `type(uint128).max` — the `uint256` storage type is simply wider than needed. There is no overflow (Solidity 0.8 checked math would catch it anyway). The only latent risk: if a future change ever removed the `_checkFillAmount` precondition, the `uint256` accumulator would silently accept fills past `uint128` range and the `uint256(orderAmount) - filled` subtraction could underflow-revert inconsistently. Today: safe.
impact:         None at this commit. Informational-leaning LOW: a type-width inconsistency that documents an invariant ("`_checkFillAmount` must always precede accumulation") only implicitly.
poc:            n/a.
recommendation: Either narrow `orderHashToFilledAmount` to `mapping(bytes32 => uint128)` (storage-layout change — fine for a fresh deploy, and it makes the invariant type-enforced) or add a comment at the mapping declaration and at each `+=` site stating that `_checkFillAmount` guarantees the sum stays within `uint128`. Low priority.
upgrade-safe:   no (narrowing the mapping type changes the slot's interpretation; acceptable on a fresh deploy)
fix-commit:     -
fix-test:       -

---

### SEC-011: `setOperator` and `cacheDomainSeparator` have no event and no zero-address / re-entry-of-config guard

id:             SEC-011
domain:         security
severity:       low
status:         confirmed
decision:       fix
reverify:       pending
location:       contracts/facets/SettlementFacet.sol:183-187, 243-247
source:         manual-reviewer
duplicate-of:   -
conflicts-with: -
regression-of:  -
title:          Operator changes are silent (no event) and `setOperator(address(0))` is accepted
description:    `setOperator` (line 183) writes `ss.operator = _operator` with `enforceIsContractOwner` but emits **no event** and does not reject `address(0)`. Setting the operator to `address(0)` bricks `matchOrders`/`fillOrder` (the `onlyOperator` modifier compares `msg.sender != ss.operator`; nobody is `address(0)`), which is a recoverable owner error but a silent one. The absence of an `OperatorUpdated` event means off-chain monitoring cannot detect an operator-key rotation or a malicious owner swapping the operator. `cacheDomainSeparator` likewise emits nothing. Compare `AdminConfigFacet.setFeeReceiver`, which both rejects zero and emits `FeeReceiverUpdated`.
impact:         Low. No direct fund loss. Operational transparency + foot-gun: a critical role change is invisible on-chain, and a zero-address operator silently disables settlement until the owner notices.
poc:            n/a.
recommendation: Add `if (_operator == address(0)) revert Errors.ZeroAddress();` and emit a new `Events.OperatorUpdated(oldOperator, newOperator)`. Emit an event from `cacheDomainSeparator` too (e.g. `DomainSeparatorCached(separator, block.chainid)`). Adding events does not change storage layout; adding a new event to `Events.sol` is selector-neutral.
upgrade-safe:   yes
fix-commit:     -
fix-test:       -

---

### SEC-012: Orphaned `ProtocolFeesWithdrawn` event in `Events.sol` (prior REMAINING-2 — still OPEN)

id:             SEC-012
domain:         security
severity:       informational
status:         confirmed
decision:       fix
reverify:       not-fixed
location:       contracts/libraries/Events.sol:205
source:         manual-reviewer
duplicate-of:   -
conflicts-with: CPX-? (likely overlaps a complexity dead-code finding — triage dedup)
regression-of:  REMAINING-2
title:          `event ProtocolFeesWithdrawn(...)` is defined but never emitted after `LibFeeManager` was deleted
description:    Confirmed by grep: `ProtocolFeesWithdrawn` appears only at `Events.sol:205`; no `emit` site exists in `contracts/`. It is dead ABI surface left over from the MEDIUM-1 fee-infrastructure removal. No security impact — purely ABI clutter that can confuse integrators into thinking a fee-withdrawal flow exists.
impact:         None. Informational / ABI hygiene.
poc:            `grep -rn "ProtocolFeesWithdrawn" contracts/` → single hit, the definition.
recommendation: Delete the event from `Events.sol`. Removing an unused event does not affect storage or function selectors.
upgrade-safe:   yes
fix-commit:     -
fix-test:       -

---

### SEC-013: `setTradingFeesBps` and the v2.0 `makerTradingFeeBps` / `takerTradingFeeBps` params remain on `AdminConfigFacet` (prior REMAINING-3 — still OPEN)

id:             SEC-013
domain:         security
severity:       informational
status:         confirmed
decision:       defer
reverify:       not-fixed
location:       contracts/facets/AdminConfigFacet.sol:138-148, 160-168
source:         manual-reviewer
duplicate-of:   CPX-? (complexity dead-code — triage dedup)
conflicts-with: -
regression-of:  REMAINING-3
title:          `setTradingFeesBps` writes v2.0 fee params unused by v3 settlement; `getFees` still returns them
description:    `setTradingFeesBps` (line 138) sets `makerTradingFeeBps` / `takerTradingFeeBps` in `AdminConfigStorage`. v3 `SettlementFacet` uses only per-order `feeRateBps` — it never reads these fields (verified: no read of `makerTradingFeeBps`/`takerTradingFeeBps` in `SettlementFacet`). `getFees` (line 160) still returns them. They are inert v2.0 residue. No security impact; an administrator could be misled into thinking these tune settlement fees (they do not). `DiamondInit` already zero-inits them.
impact:         None. Informational — misleading admin surface.
poc:            `grep -rn "makerTradingFeeBps\|takerTradingFeeBps" contracts/facets/SettlementFacet.sol` → no hits (settlement does not consult them).
recommendation: Remove `setTradingFeesBps` and drop the two fields from the `getFees` return tuple (and `IAdminConfig`), OR add an explicit deprecation NatSpec block. Removing a function changes the facet's selector set — for a *fresh deploy* that is fine; if any upgrade is later planned, the `DiamondCut` must drop the selector. Deferred — cosmetic, coordinate with Domain 4.
upgrade-safe:   no (function removal drops a selector — safe on fresh deploy, must be handled in any future cut)
fix-commit:     -
fix-test:       -

---

### SEC-014: `ERC1155Facet.setApprovalForAll` emits `ApprovalForAll` twice

id:             SEC-014
domain:         security
severity:       informational
status:         confirmed
decision:       fix
reverify:       pending
location:       contracts/facets/ERC1155Facet.sol:21-24; contracts/libraries/LibERC1155.sol:30-37
source:         manual-reviewer
duplicate-of:   GAS-? / CPX-? (triage dedup)
conflicts-with: -
regression-of:  -
title:          Double `ApprovalForAll` emission — once in `LibERC1155.setApprovalForAll`, once in the facet wrapper
description:    `ERC1155Facet.setApprovalForAll` (line 22) calls `LibERC1155.setApprovalForAll(...)`, which itself emits `Events.ApprovalForAll` (LibERC1155 line 36); the facet then emits `Events.ApprovalForAll` **again** (line 23). Each on-chain approval produces two identical `ApprovalForAll` logs. Not a vulnerability, but it (a) wastes ~750 gas per call and (b) can confuse ERC-1155 indexers / subgraphs that count approval events or treat the second as a state change. Note `setApprovalForAll` here does not gate `from != operator` self-approval, but that is standard ERC-1155 and harmless.
impact:         None security-wise. ABI/event-log correctness; minor gas. Flagged because event-log integrity matters for the off-chain orderbook's indexing.
poc:            Call `setApprovalForAll(op, true)`; observe two `ApprovalForAll` entries in the receipt.
recommendation: Remove the `emit` from the facet (line 23) and keep the single emission in `LibERC1155`, *or* remove it from the library and keep the facet's. Keep exactly one. Gas/complexity domains may also raise this; defer dedup to triage.
upgrade-safe:   yes
fix-commit:     -
fix-test:       -

---

## Regression checklist verdict (`audit/00-scope.md`)

Re-confirmed against the pinned commit `015097c`. The code has moved since the SC-008 reviews
(`minFillAmount` enforcement removed in SCRUM-121/122; CRITICAL-1's strict equality replaced by a
remainder construction; SCRUM-89 registry-backed complement lookup), so each item was re-derived
from current source, not assumed from the historical report.

| ID | Behavior | Verdict | Evidence |
|----|----------|---------|----------|
| **CRITICAL-1** | Price-sum invariant enforced in `_settleMint` / `_settleMerge` (no under-collateralization). | **resolved** | `_settleMint:476` reverts on `P_t + P_m < unit`; `_settleMerge:567` reverts on `P_t + P_m > unit`. More importantly the **remainder construction** — `takerCollateral = fillAmount - makerCollateral` (480) and `takerPayout = fillAmount - makerPayout` (571) — makes `collected == minted == fillAmount` and `burned == returned == fillAmount` an *identity*, not a checked condition. Token-vs-collateral conservation holds structurally. No insolvency path found. The original strict-equality NEW-1 rounding bug is gone (remainder math cannot mis-reject). |
| **NEW-2** | Cached domain separator validates `block.chainid`. | **open** | `LibSettlementStorage` (line 49) stores only `bytes32 domainSeparator` — no `cachedChainId`. `SettlementFacet._getDomainSeparator:238` returns the cache unconditionally. On a chain fork the cache is stale. See **SEC-004**. (Low residual risk for a fresh single-chain mainnet deploy, but the item is literally not implemented.) |
| **NEW-3** | Domain-separator computation consistent across the three facets. | **open** | `SettlementFacet` reads the cache; `SignatureVerifierFacet:102` and `NonceManagerFacet:166` always recompute. Inconsistent. See **SEC-004**. |
| **NEW-4** | `_settleMerge` dust-collateral accumulation bounded / acceptable. | **resolved** (re-derived) | The remainder construction (`takerPayout = fillAmount - makerPayout`) distributes the *entire* `fillAmount`; the fee legs use `>` guards but `totalFees` is always sent to `feeReceiver`, so no collateral is stranded. The historical "1 unit locked per merge" no longer occurs at this commit. The residual is an economic-fairness window (sub-`unit` price sums allowed), reclassified under **SEC-007** as MEDIUM fairness, not dust-locking. |
| **NEW-5** | `_executeOperatorFill` rejects / safely handles a zero `collateralAmount`. | **open** | `_executeOperatorFill:593-619` still has no `collateralAmount == 0` guard; the recommended check was never added. A sub-`unit` fill truncates to 0 and settles. See **SEC-003**. Also `collateralAmount - fee` can underflow-panic. |
| **REMAINING-1** | Duplicate `_verifySignature` in `SettlementFacet` & `SignatureVerifierFacet`, both with the malleability fix. | **open** | Both copies still exist and both carry the low-`s` check — so the *malleability fix* is present in both (good). But the duplication persists, the two differ in EIP-1271 dispatch, and a *third* recovery path (`OracleManagerFacet._recoverSigner`) lacks the malleability check entirely. See **SEC-005**. |
| **REMAINING-2** | Orphaned `ProtocolFeesWithdrawn` event in `Events.sol`. | **open** | Confirmed present at `Events.sol:205`, zero `emit` sites. See **SEC-012**. |
| **REMAINING-3** | `setTradingFeesBps` / v2.0 fee params on `AdminConfigFacet`. | **open** | `setTradingFeesBps` (line 138) and `makerTradingFeeBps`/`takerTradingFeeBps` still present, still in `getFees`. v3 settlement does not read them. See **SEC-013**. |

**Net:** 2 resolved (CRITICAL-1, NEW-4), 6 open (NEW-2, NEW-3, NEW-5, REMAINING-1/2/3), 0 regressed.
None of the open items is open *at CRITICAL/HIGH* — NEW-5 is MEDIUM (SEC-003), NEW-2/NEW-3 MEDIUM (SEC-004),
REMAINING-1 MEDIUM (SEC-005), REMAINING-2/3 informational. Per the go/no-go gate, no regression item is a
CRITICAL/HIGH blocker — but the two *new* HIGH findings (SEC-001, SEC-002) **are** mainnet-blocking.

---

## Compromised-operator impact — explicit enumeration

The operator is `msg.sender` of `matchOrders` / `fillOrder`. Trusted for liveness and correct matching.
A compromised operator key can do the following, ranked by severity. Every signature is still required
to be valid — the operator cannot forge orders — so the operator's power is in *selection* and *pairing*.

| # | Capability | Mechanism | Bound | Finding |
|---|-----------|-----------|-------|---------|
| 1 | Settle a maker's order in the **wrong collateral token** | `_settleComplementary` ignores `maker.collateralToken` | Up to total wrong-token transfer + 1e12x mispricing if units differ | **SEC-001** (HIGH) |
| 2 | Settle in an **unwhitelisted / mis-`unit`'d token** | No `isCollateralTokenAllowed` gate on the hot path | Wrong-price for zero-fee orders; DoS otherwise | **SEC-002** (HIGH) |
| 3 | Extract **free position tokens** via `fillOrder` | `_executeOperatorFill` zero-`collateralAmount` truncation | `fillAmount` of tokens for a sub-`unit` maker order | **SEC-003** (MEDIUM) |
| 4 | Pick the **worst legal execution price** for a complementary pair | Maker price is the execution price; only `buyerPrice >= sellerPrice` is checked (line 434) | The buyer can be charged the maker's price even if the taker signed a much better one (slack between taker price and maker price) | partially SEC-006; price slack noted |
| 5 | Settle an **economically unfair Mint/Merge** | `>=`/`<=` slack on the price-sum (`_settleMint:476`, `_settleMerge:567`) | Value shifts between maker and taker; collateral conserved (no insolvency) | **SEC-007** (MEDIUM) |
| 6 | Rake up to **5% fee** on every fill | Honour the signed `feeRateBps` capped at `MAX_FEE_RATE_BPS=500`; fees go to `feeReceiver` | 5% of `min(price,1-price)*fill`; bounded, goes to `feeReceiver` not operator directly | **SEC-006** (MEDIUM) |
| 7 | **Choose which orders never settle** (censorship) | Operator is the sole settlement entry point | Liveness only — users can on-chain-cancel; no fund loss | inherent to design; noted |
| 8 | **Partial-fill griefing** — fill orders in tiny increments | `_checkFillAmount` allows any `fillAmount <= remaining` (`minFillAmount` no longer enforced — SCRUM-122) | Each fill pays its own fee; many dust fills inflate cumulative fee vs one fill | noted; `minFillAmount` removal is intentional (SCRUM-122) |

The operator **cannot**: forge a signature; settle a cancelled order (modulo the SEC-004 fork edge);
overfill an order; re-enter settlement (`nonReentrant`); touch funds outside the matched parties'
allowances; or change `feeReceiver` / the `operator` itself (owner-only). Mitigations: SEC-001 and
SEC-002 fixes close the highest-impact levers; an operator key in a multisig/HSM and an off-chain
order-validation layer that rejects mismatched-`collateralToken` pairs reduce residual risk on 4-8.

---

## OWASP Smart Contract Top 10 (2025) — coverage map

| Category | Status | Notes |
|----------|--------|-------|
| SC01 Access Control | **Findings** | `onlyOperator` / `enforceIsContractOwner` correctly applied on every state-changing settlement/admin function. `OracleManagerFacet.updatePrice` intentionally permissionless (SEC-008). `setOperator` lacks event/zero-check (SEC-011). |
| SC02 Price Oracle Manipulation | Pass (in scope) | v3 settlement does not consult an oracle (cross-currency removed, SC-006). `BlockScholesOracleAdapter` validates `value > 0`; staleness checked in `OracleManagerFacet`. No flash-loan surface in the settlement path. |
| SC03 Logic Errors | **Findings** | SEC-001 (missing collateral-token equality), SEC-007 (price-sum slack). Price-sum solvency itself verified safe via the remainder construction. |
| SC04 Lack of Input Validation | **Findings** | SEC-001, SEC-002, SEC-003 — missing token / zero-amount checks. `matchOrders` validates array-length parity and `totalMakerFill == takerFillAmount`. |
| SC05 Reentrancy | Pass | `nonReentrant` (shared `LibReentrancyGuard`, Diamond storage) wraps `matchOrders`/`fillOrder`. `_splitPositionInternal`/`_mergePositionsInternal` deliberately skip the guard and make **no external calls** (`sender == address(this)` skips `safeTransfer*`); `LibERC1155` acceptance checks on self-mint call the Diamond's own `ERC1155ReceiverFacet` (pure, returns selector). No cross-facet re-entry path found. See Verified Safe. |
| SC06 Unchecked External Calls | Pass | All ERC-20 calls via OZ `SafeERC20`. EIP-1271 `staticcall` return is length- and magic-checked (`SettlementFacet:290`). `IERC20Metadata.symbol()` wrapped in `try/catch` (`AdminConfigFacet:46`). |
| SC07 Flash Loan Attacks | Pass (in scope) | No price-dependent or balance-dependent logic in settlement; positions are CTF ERC-1155, value is fixed at `unitPerPair`. |
| SC08 Integer Over/Underflow | Pass | Solidity 0.8.20 checked math. `_computeFee` casts widen to `uint256` before multiply. One robustness gap: `collateralAmount - fee` can underflow-panic (folded into SEC-003). `LibOracleAdapter.getTimestampBucket` divide-before-multiply is intentional bucketing (Verified Safe). |
| SC09 Insecure Randomness | n/a | No randomness used. |
| SC10 Denial of Service | **Findings** | SEC-008 (permissionless `updatePrice` can hold `tradingPaused`). `matchOrders` loops over `makerOrders` — gas-bounded by the operator's own calldata, no unbounded external loop in settlement. |

Additional SCSVSv2 checks: signature replay (SC keyed on `orderHash`; cross-chain bound by domain
separator — SEC-004 fork caveat); storage isolation (3 distinct namespaces — Verified Safe);
`__gap` / `__reserved` correctness (Verified Safe); EIP-712 backend parity (Verified Safe).

---

## Invariant & PoC candidates (feed to the fuzzing harness)

Properties Domain 1 could not exhaustively prove by reading and that the Echidna/Medusa harness should
assert. Each is phrased as a property that must always hold.

1. **`complementary-token-consistency`** — for any settled complementary pair,
   `taker.collateralToken == maker.collateralToken`. *Currently violable* — SEC-001. The harness should
   attempt a complementary settlement with differing collateral tokens and assert it reverts.
2. **`collateral-conservation-mint`** — after `_settleMint`, the Diamond's collateral balance increases
   by exactly `sum(fillAmount)` and it holds exactly `fillAmount` of each minted positionId. Expected to
   hold (remainder construction); confirm under fuzzed `priceA + priceB ∈ [unit, 2·unit]` and odd
   `fillAmount`.
3. **`collateral-conservation-merge`** — after `_settleMerge`, `takerPayout + makerPayout + totalFees == fillAmount`
   exactly, for all signed prices with `priceA + priceB <= unit`. Confirm no wei is stranded or created.
4. **`no-overfill`** — `sum of all fills for an orderHash <= order.amount`, always. `_checkFillAmount`
   should make this hold; fuzz concurrent multi-maker fills of the same taker.
5. **`fee-upper-bound`** — `_computeFee(...) <= (MAX_FEE_RATE_BPS · min(price, unit-price) · amount) / (unit · 10000)`,
   and `_computeFee` never exceeds `min(price,1-price)·amount`. Fuzz `feeRateBps ∈ [0, 65535]`,
   `price ∈ [0, 2·unit]`.
6. **`operator-fill-nonzero`** — `_executeOperatorFill` either transfers a strictly positive
   `collateralAmount` or reverts. *Currently violable* — SEC-003.
7. **`cancel-then-settle`** — once `cancelOrder` / `incrementNonce` / `cancelOrdersForPosition` has
   invalidated an order, `matchOrders`/`fillOrder` on that order reverts. Fuzz the race: cancel and
   settle in the same block, both orderings. (The SEC-004 fork edge is out of single-chain fuzz scope.)
8. **`nonce-monotonic`** — `makerToNonce[m]` is strictly non-decreasing and `incrementNonce` raises it
   by exactly 1.
9. **`reentrancy-locked`** — no nested entry of `matchOrders`/`fillOrder` is possible; a malicious
   ERC-1155 receiver cannot re-enter. Harness: a receiver contract that calls back into `matchOrders`
   during `onERC1155Received` — assert revert `ReentrantCall`.
10. **`signature-binds-all-fields`** — mutating any single `DoefinOrder` field after signing makes
    `_verifySignature` revert. Fuzz one-field mutations across all 15 fields.
11. **`price-sum-solvency-global`** — the Diamond's collateral balance is always `>=` the collateral
    redeemable by all outstanding position tokens for every condition. The global solvency invariant;
    the crown-jewel property. Defer the economic formulation to Domain 3's `invariants.md`.

---

## Verified Safe

Items checked in depth that **passed** — no finding raised.

- **Storage namespace isolation.** Three distinct slots: `keccak256("diamond.standard.diamond.storage")`
  (LibDiamond), `keccak256("doefin.storage")` (`LibDoefinStorage.STORAGE_POSITION`), and
  `keccak256("doefin.settlement.storage")` (`LibSettlementStorage.STORAGE_POSITION`). The Slither
  per-contract storage-layout printer confirms every facet declares **zero** contract-level state
  variables (all storage is via the assembly-pinned structs) — so there is no facet storage that could
  collide with a struct slot. No collision.
- **`LibSettlementStorage` `__reserved` + `__gap` layout.** The three `__reserved_scrum89_*` `bytes32`
  placeholders (slots after `registeredOrderSigners`) keep `domainSeparator` and `__gap[49]` at fixed
  offsets. Mapping roots are always zero so the reserved slots are inert. Layout is internally
  consistent for a fresh deploy.
- **EIP-712 type hash & struct hash vs the backend.** `LibDoefinOrder.DOEFIN_ORDER_TYPEHASH` (15 fields,
  in order: salt, maker, signer, positionId, collateralToken, side, amount, pricePerToken, minFillAmount,
  orderType, quoteCurrency, exchangeRate, feeRateBps, expiration, nonce) is **byte-for-byte identical** to
  `doefin-backend/shared/scw/encoder.py` `DOEFIN_ORDER_TYPE_STRING` and the eth-abi type list in
  `compute_struct_hash`. `DOMAIN_SEPARATOR_TYPEHASH` matches `EIP712_DOMAIN_TYPE_STRING`. Domain name
  `"Doefin Exchange"` / version `"2.1"` match `models.py` `EIP712_DOMAIN_NAME`/`_VERSION`. `minFillAmount`
  is still in the struct hash on both sides — correct, even though it is no longer *enforced* on-chain
  (SCRUM-122); the off-chain encoder must keep it so the signature still verifies. No drift.
- **ECDSA malleability fix in the settlement facets.** Both `SettlementFacet._verifySignature:271` and
  `SignatureVerifierFacet._recoverSigner:191` reject `s > 0x7FFF...20A0` (secp256k1 `(n-1)/2`). `v` is
  normalised `< 27 → +27`. `ecrecover` returning `address(0)` is explicitly rejected and `recoveredSigner`
  is checked against `order.signer`. (The oracle facet's copy is the exception — SEC-005.)
- **Replay protection.** Settlement keys on `orderHash` (`orderHashToFilledAmount`, `cancelledOrders`),
  not on the signature bytes — so a malleated signature cannot double-spend. Cross-chain replay is
  prevented by `chainId` + `verifyingContract` in the domain separator (single-chain; fork caveat is
  SEC-004). Oracle `manualUpdatePrice` keys on `usedNonces[nonce]`.
- **Reentrancy guard.** `LibReentrancyGuard` uses Diamond storage (`reentrancyStorage._status`), shared
  across facets, initialised to `1` in `LibDoefinStorage.initialize` and auto-heals from `0`.
  `matchOrders`/`fillOrder` are wrapped. `_splitPositionInternal`/`_mergePositionsInternal` skip the
  guard *correctly* — when `sender == address(this)` the `safeTransfer*` ERC-20 calls are skipped, and
  the only "external" calls left (`LibERC1155` acceptance checks) target the Diamond's own pure
  `ERC1155ReceiverFacet`. No reentrancy path into settlement found.
- **Self-trade prevention.** `matchOrders:114` reverts `SelfTrade` when `makerOrders[i].maker == takerOrder.maker`.
- **Fill-amount consistency.** `matchOrders:93-99` sums `makerFillAmounts` and requires the total to
  equal `takerFillAmount`; per-maker and per-taker zero-fill amounts are rejected (`ZeroAmount`).
- **Mint/Merge collateral-token equality.** `_settleMint:469` and `_settleMerge:537` *do* check
  `taker.collateralToken == maker.collateralToken` (the check that `_settleComplementary` is missing —
  SEC-001).
- **Price-sum / collateral conservation (Mint & Merge).** The remainder construction
  `takerCollateral = fillAmount - makerCollateral` / `takerPayout = fillAmount - makerPayout` makes
  "collateral collected == position tokens minted" and "tokens burned == collateral returned" a
  structural identity. No under-collateralization path — CRITICAL-1 is genuinely resolved.
- **`_computeFee` underflow guard.** `if (price > unit) revert InvalidPrice()` (line 643) before
  `unit - price`; `feeRateBps > MAX_FEE_RATE_BPS` rejected (line 640); `feeRateBps == 0` early-returns 0.
- **`_determineMatchType` registry backing.** `_isBinaryComplement` reads the CTF `positionRegistry`,
  rejects unregistered positions, cross-market pairs, and non-binary markets by returning `false`
  (fall-through to a single `InvalidMatch`). No low-level registry error leaks.
- **`NonceManagerFacet` cancellation authority.** `cancelOrder`/`cancelOrders` require
  `msg.sender == order.maker`; `incrementNonce`/`cancelOrdersForPosition` key on `msg.sender` —
  unspoofable. `cancelOrdersForPosition` enforces strictly-increasing `minValidSalt`.
- **`LibOracleAdapter.getTimestampBucket` divide-before-multiply** (Slither `divide-before-multiply`) —
  `(t / BUCKET) * BUCKET` is the intended floor-to-bucket; not a precision bug.
- **`arbitrary-send-erc20` (Slither, 9 hits in `SettlementFacet`).** Each `safeTransferFrom(from, ...)`
  uses a `from` that is a signed-order party (`order.maker`, derived `buyerAddr`/`sellerAddr`); the
  EIP-712 signature *is* the authorization for spending that party's allowance. This is the intended
  Polymarket settlement pattern, not an arbitrary-send bug — **with the exception that the *token*
  spent is not validated against the maker's signed token in the complementary path** (SEC-001). The
  `from`-is-arbitrary detector is otherwise a true-negative here.
- **`uninitialized-local` (Slither — `totalTakerFee`, `totalMakerFill`).** Both are accumulators
  default-initialised to `0` by the EVM and summed in a loop; correct, Solidity 0.8 checked-add guards
  overflow. True-negative.
