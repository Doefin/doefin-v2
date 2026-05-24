# Doefin v3 Mainnet Audit — Scope

> **Refreshed 2026-05-22 (post Phase-2 remediation).** The facet/library lists, branch
> pointer, and regression checklist below reflect the current `v3/dev` state after
> SCRUM-223/224/226 (CC removal + operator-supplied fee model + 10-field order) and the
> Phase-2 remediation SCRUM-229/230/231. The earlier revision named two contracts that
> have never existed in the repo (`OracleManagerFacet`, `BlockScholesOracleAdapter`) —
> removed (ARCH-08).

## Audit subject

- **Repository:** `/Users/reza/workspace/predexyo/doefin-v2`
- **Branch:** `v3/dev` (post Phase-2 remediation). The audit-handoff commit is frozen at
  the GATE step; until then auditors should pull the latest `v3/dev`.
- **Target:** fresh deployment of the v3 EIP-2535 Diamond to Base mainnet.

## In scope

The v3 settlement core and the admin/access/oracle-adapter facets, plus their libraries.

**Facets:** `SettlementFacet`, `SettlementAdminFacet`, `SignatureVerifierFacet`,
`NonceManagerFacet` (the crown jewels — settlement + its owner governance),
`AccessControlFacet`, `AdminConfigFacet`, `MarketDataFacet`, `ERC1155Facet`,
`ERC1155ReceiverFacet`, `OracleAdapterFacet`.

**Libraries:** `LibDoefinOrder`, `LibSignature`, `LibOrderValidity`, `LibDoefinStorage`,
`LibSettlementStorage`, `LibAdminConfigStorage`, `LibAccessControlStorage`, `LibConstants`,
`LibERC1155`, `LibAccessControl`, `LibReentrancyGuard`, `LibOracleAdapter`,
`LibPositionRegistry`, `Errors`, `Events`.

## Out of scope (per `audit-exclusion-guidance.md`)

Findings located in these files are marked OUT OF SCOPE, not rated. A finding *reachable
from in-scope code through* an excluded file is IN scope.

- **CTF (Gnosis import):** `ConditionalTokensFacet`, `ConditionManagerFacet`,
  `LibConditionMetadata`, `LibCTHelpers`, `LibCTFCondition`, `IConditionalTokens`,
  `IConditionManager`.
- **Block-header v1 (superseded):** `DoefinV1BlockHeaderOracle` (deployed as
  `DoefinV1BlockHeaderOracleFacet`), `BlockHeaderUtils`, `LibDoefinBlockHeaderOracle`,
  `IDoefinBlockHeaderOracle`.
- **Diamond reference (template):** `Diamond.sol`, `LibDiamond`, `DiamondInit`,
  `DiamondCutFacet`, `DiamondLoupeFacet`, `OwnershipFacet`, `IDiamondCut`, `IDiamondLoupe`,
  `IERC173`.
- **Mocks:** all of `contracts/mock/` (incl. `StorageLayoutProbe`). **Audit-only:**
  `contracts/audit/DoefinInvariantHarness.sol`.

## Trust model

The **operator** (`msg.sender` of `matchOrders`/`fillOrder`) is trusted for liveness and
for submitting correctly-matched order pairs. Every agent MUST explicitly enumerate what a
**compromised operator** can do — prior reviews' MEDIUM-2 and NEW-5 were both
compromised-operator findings. Treat compromised-operator impact as a HIGH-context concern.

The **owner** can `diamondCut` (upgrade facets), set the operator (`SettlementAdminFacet`),
and pause trading. Deploy mode for mainnet is a **fresh deploy** (not a `diamondCut`
upgrade) — so storage-collision findings are in scope, but upgrade-storage-layout-drift
findings are informational unless a future upgrade is planned. Note: v3 storage is EIP-7201
namespaced (SCRUM-229) — each namespace's slot is verified by the
`test/storage/storage-layout-snapshot.test.js` CI gate.

## Regression checklist — re-confirm against current code

Prior reviews (`docs/v2.1/security-review-sc-008.md` + follow-up) are historical anchors.
The v3 fee redesign and the Phase-2 remediation have since moved the code substantially —
re-confirm each item as `resolved` / `open` / `regressed`:

| ID | Behavior to re-confirm | Expected post-Phase-2 status |
|----|------------------------|------------------------------|
| CRITICAL-1 | Price-sum invariant enforced in `_settleMint` / `_settleMerge` (Diamond cannot become under-collateralized). | open for re-confirm |
| NEW-2 / NEW-3 | Domain separator — no stale-cache hazard; consistent across the three v3 facets. | resolved — SEC-004 removed the cache; all facets recompute via `LibDoefinOrder.diamondDomainSeparator`. |
| NEW-4 | `_settleMerge` dust-collateral accumulation is bounded / acceptable. | open for re-confirm |
| NEW-5 | `_executeOperatorFill` rejects or safely handles a zero `collateralAmount`. | open for re-confirm (`ZeroAmount` guard) |
| REMAINING-1 | Duplicate `_verifySignature` in `SettlementFacet` / `SignatureVerifierFacet`. | resolved — CPX-001 consolidated it into `LibSignature.verifyOrderSignature`. |
| REMAINING-2 | Orphaned `ProtocolFeesWithdrawn` event in `Events.sol`. | resolved — event removed. |
| REMAINING-3 | `setTradingFeesBps` / v2.0 fee params on `AdminConfigFacet`. | resolved — v2.0 fee config removed; fee model is operator-supplied + `maxFeeRateBps`. |

## Fee & order model (current — for reviewer orientation)

- The signed `DoefinOrder` is **10 fields** (`salt, maker, signer, positionId,
  collateralToken, side, amount, pricePerToken, expiration, nonce`); EIP-712 domain
  version `"3"`. No `feeRateBps` / `minFillAmount` / cross-currency fields.
- Trading fees are **operator-supplied**, not signed: the operator passes per-leg fee
  amounts into `matchOrders`/`fillOrder`. `SettlementFacet._validateFee` enforces
  `fee <= cashValue * maxFeeRateBps / 10000` AND `fee <= proceeds` — fail-closed
  (`maxFeeRateBps == 0` forbids any non-zero fee). `maxFeeRateBps` is admin-set, bounded
  by `MAX_FEE_RATE_BPS_CAP = 1000`.
- Three settlement paths only — Complementary / Mint / Merge; the match type is determined
  per maker, so one `matchOrders` call may mix them.

## Domain briefs (non-overlapping)

- **Security (`sc-manual-reviewer`)** — owns vulnerabilities: reentrancy, signature/replay,
  storage isolation, access control, token handling, the operator boundary. Does NOT
  report gas cost or pure style. Maps findings to SWC / OWASP SC Top 10.
- **Business logic (`sc-business-logic`)** — owns protocol correctness: settlement
  economics, price-sum solvency, fee math, fill accounting, match-type determination, and
  test coverage of those invariants. Produces the Echidna-ready invariant spec. Does NOT
  report generic security bugs.
- **Gas (`sc-gas-optimizer`)** — owns cost only: hot-path gas, storage packing, Base-L2
  calldata. Does NOT report missing checks (that is Security's domain). Findings cap at
  MEDIUM.
- **Complexity (`sc-complexity-analyst`)** — owns maintainability: duplication, dead code,
  function complexity, abstraction. Does NOT report exploitable bugs. Findings cap at
  MEDIUM.
- **Architecture (`sc-architecture-reviewer`)** — owns structural shape: facet
  decomposition, EIP-2535 / storage-namespace correctness, access-control layering,
  interface design.
- **Test rigor (`sc-test-engineer`)** — authors business-logic-driven test cases and
  proves the suite's rigor by mutation testing.
