# Follow-up tickets

> Items deferred from PR-level reviews — kept out of the originating PR's scope but tracked so they don't get lost. Each row is a single concern, sized to one ticket.
>
> **Sourcing convention:** CR-* IDs come from CodeRabbit comment IDs on the originating PR (cross-reference [audit/coderabbit-triage/PR-23.md](coderabbit-triage/PR-23.md) for the per-comment evidence). SCRUM-* IDs come from manual reviews on audit-prep tickets.

## Open

| ID | Title | Source | Severity | Owner | Notes |
|---|---|---|---|---|---|
| **CR-CI-HARDEN** | GitHub Actions hardening sweep | 6 CR comments on PR #23 (CR-3291829786 / 787 / 791 / 795 / 802 + REVIEW-4349609250) | Low | sc-developer | Adopt the [.coderabbit.yml CR-CI-HARDEN policy](../.coderabbit.yml) across every workflow: workflow-level `permissions: { contents: read }` by default, SHA-pin every `actions/*` and third-party action, `persist-credentials: false` on every `actions/checkout`. One PR; one workflow per commit. Audit by re-running the original CR comments and confirming closure. |
| **CR-DOCS-MD040** | Markdown fence-language tags sweep | 17 CR comments across PR #23 (CR-3291760041, CR-3291768584, CR-3291768588, CR-3291829785, CR-3291973176, CR-3291973178, CR-3291973186, + 10 outside-diff repeats in the review rollups) | Low | docs | Add language tags to every untagged fenced block under `audit/**/*.md` and `docs/**/*.md`. Single PR. Run `markdownlint-cli` locally to verify (`npx markdownlint-cli2 'audit/**/*.md' 'docs/**/*.md' --config '{ "MD040": true }'`). |
| **CR-DOCS-ABSPATH** | Replace `/Users/...` paths in audit/ with repo-relative | 4 CR comments (CR-3291768582, CR-3291768587, CR-3291973166, CR-3291973191) | Low | docs | Janitor sweep. Grep for `/Users/`, `/home/`, `/private/tmp/` in `audit/**` and `.claude/**`; replace with repo-relative paths (e.g. `contracts/...`) or fenced-as-pseudocode where the path is illustrative. |
| **CR-DOCS-CLEANUP** | Misc audit/docs cleanup | 7 CR comments (CR-3291760046, CR-3291768582, CR-3291768585, CR-3291768587, CR-3291973166, CR-3291973171, CR-3291973196, CR-3291973199 + REV-B/REV-C/REV-G) | Low | docs | Bundle: (a) fix the broken link in `docs/flows/CONDITION_LIFECYCLE.md:812` (`../contracts/...` → `../../contracts/...`); (b) reconcile 585 vs 586 passing count in `audit/test-engineering/mutation-report.md:442`; (c) `~~strikethrough~~ + footnote` the removed `OracleManagerFacet` / `BlockScholesOracleAdapter` in `audit/REPORT.md:32` scope list; (d) `README.md` clone URL + `.env.example` + RPC name fixes (REV-A/B/C — already shipped if landed); (e) `IMarketData` ABI delta note. Per-file commits. |
| **CR-USAGE-MATRIX** | `audit/scripts/usage-matrix.js` correctness fixes | 4 CR comments (CR-3291973197, CR-3291973198, REV-M) | Low | sc-developer | (a) Dedupe overloaded functions on the full signature `name + "(" + inputs.map(i=>i.type).join(",") + ")"`, not just `name`; (b) classify `-1` inputs (missing repo roots) as UNKNOWN before walking STANDARD_API / END_USER_DIRECT; (c) escape regex special chars in `usage-matrix.js`; (d) handle grep error returns. Single PR; add a fixture-based unit test. |
| **CR-SOLHINT-HARDEN** | Solhint config hardening | CR-3291829780 (REVIEW level) | Low | sc-developer | Enable additional solhint rules (`avoid-low-level-calls`, `no-inline-assembly` exceptions documented, `func-visibility`, `max-line-length` — current config in `.solhint.json`). Verify no regressions in current code; if a rule needs broad suppression, document why in the config. |
| **CR-ABI-REGEN** | Backend ABI regeneration after `IMarketData` cleanup | REV-G | Low | backend | After SCRUM-234 removed `getAllPositionIdsByCondition` and `getPositionIdsByMarket` from `IMarketData`, regenerate the backend artifacts (`match-engine/app/utils/settlement_abi.py`, `shared/scw/encoder.py` if affected) to remove the dead selectors. Tied to the doefin-backend repo; cross-repo coordination. |
| **CR-MANIFEST-SHA** | Backfill merge SHA in `audit/manifest.md` "5 — Fix" row | CR-3291973193 (DISCUSS) | Low | docs | Currently reads "working tree, uncommitted." Post-merge of PR #23, update to the merge commit SHA so the manifest pins reproducibly. Trivial 1-line edit after the merge lands. |
| **CR-HARDHAT-VERIFY** | `hardhat.config.js` verify-failure ops risk | CR-3291760047 (DEFER — Medium) | Medium | sc-developer | The current `etherscan.apiKey` / `customChains` setup in `hardhat.config.js` silently swallows verify-failures in CI/CD. Add a `verify-fail-loud` postcondition (or document the manual-verify fallback) so a deploy with a broken verify doesn't slip through. One ticket; touches `hardhat.config.js` + the deploy scripts; verification on Base Sepolia. |
| **SCRUM-236-FIND-2** | Malicious-owner reentrancy regression test | SCRUM-236 manual review (audit/SCRUM-236-manual-review.md FIND-2) | Low | sc-test-engineer | The existing `AdminConfigFacet.WithdrawFees` reentrancy regression catches reentry from a malicious ERC20 callback — but the inner attack vector is access-controlled by `enforceIsContractOwner` so the inner `LibReentrancyGuard` never fires. Build a `MaliciousOwnerModule` mock (a Safe-style module that IS the contract owner and re-enters `withdrawFees` from its own `transfer` hook) and assert the inner `LibReentrancyGuard` fires `ReentrantCall()`. ~50–100 LOC test code; new mock; no production-code change. Closes the FIND-2 gap. Coordinate with SCRUM-213 (Safe owner) to wire the test against a realistic owner shape. |

## Closed / Superseded

| ID | Title | Resolution |
|---|---|---|
| CR-3291973203 | `_handlePayoutTransfer` zero-fee bypass DoS | SUPERSEDED by SCRUM-236 (pull-payment fee bank — eliminates the DoS by design). See [audit/coderabbit-triage/PR-23.md](coderabbit-triage/PR-23.md) and [PR #24](https://github.com/Doefin/doefin-v2/pull/24). |
| CR-3291973202 | `setMaxFeeRate` lost `NoChangeRequired` no-op guard | SUPERSEDED — folded into SCRUM-236 (touches `AdminConfigFacet`). Fixed in [PR #24](https://github.com/Doefin/doefin-v2/pull/24). |
| CR-3291973200 | `echidna_diamond_solvent` flooring masks sub-`UNIT` violations | SUPERSEDED — INV-SOLV-4 rewrite in SCRUM-236 removes the floor (`(outstandingPairs / UNIT) * UNIT` → `outstandingPairs`). Fixed in [PR #24](https://github.com/Doefin/doefin-v2/pull/24). |
| CR-3291973204 | `MarketDataFacet.getPositionInfo` broken-encapsulation | RESOLVED on `v3/dev` (commit `8ee8832`) — routed through `LibPositionRegistry.getConditionId`. |
| CR-3291973184 | A-2 dead-code recommendation read as fail-open | RESOLVED on `v3/dev` (commit `20016ee`) — recommendation strengthened to fail-closed + SCRUM-235 resolution noted. The underlying check is already wired into `_validateOrder` per SCRUM-235. |
| SCRUM-236-FIND-1 | `fuzz_redeem` exercised `INV-FEE-NEW` resolution branch only with `feeAmount == 0` | RESOLVED in SCRUM-236 (commit `2404854`) — harness `_configureProtocol` now seeds `resolutionFeeBps = 100`. |
| SCRUM-236-FIND-3 | Missing `slither-disable-next-line arbitrary-send-erc20` on `_executeOperatorFill` sell-side | NOT-A-DEFECT — verified by running `slither . --detect arbitrary-send-erc20`: 0 results because the call uses `msg.sender` as `from`, which is not arbitrary. Existing inline comment at `SettlementFacet.sol:829-831` already explains this. Documented in commit `2404854`. |

## Cross-references

- CR triage ledger: [audit/coderabbit-triage/PR-23.md](coderabbit-triage/PR-23.md)
- CR teach.yml (folded into `.coderabbit.yml`): [audit/coderabbit-triage/PR-23.teach.yml](coderabbit-triage/PR-23.teach.yml)
- SCRUM-236 architecture review: [audit/SCRUM-236-architecture-review.md](SCRUM-236-architecture-review.md)
- SCRUM-236 business-logic review: [audit/SCRUM-236-business-logic-review.md](SCRUM-236-business-logic-review.md)
- SCRUM-236 manual review: [audit/SCRUM-236-manual-review.md](SCRUM-236-manual-review.md)
- SCRUM-236 design doc: [docs/SCRUM-236-fee-bank-design.md](../docs/SCRUM-236-fee-bank-design.md)
