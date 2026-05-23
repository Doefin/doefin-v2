# CodeRabbit — Doefin v3 setup guide

This is the operator's manual for the CodeRabbit Pro integration on this repo.
Companion to [`.coderabbit.yml`](../.coderabbit.yml) (in-repo review behaviour)
and `.github/workflows/` (the CI checks CodeRabbit reads from).

If you're here because a PR got a shallow review, jump to
[Troubleshooting](#troubleshooting).

---

## Table of contents

1. [How the pieces fit](#how-the-pieces-fit)
2. [Knowledge-base setup (dashboard)](#knowledge-base-setup-dashboard)
3. [CI integration — what we feed CodeRabbit and why](#ci-integration)
4. [Slither: how it gets to CodeRabbit](#slither-how-it-gets-to-coderabbit)
5. [`@coderabbitai` PR command cheat sheet](#pr-command-cheat-sheet)
6. [Working with the per-path instructions](#working-with-the-per-path-instructions)
7. [Maintenance](#maintenance)
8. [Troubleshooting](#troubleshooting)

---

## How the pieces fit

CodeRabbit on this repo is **three layered inputs**:

```
┌───────────────────────────────────────────────────────────────────┐
│  CodeRabbit review on a PR                                        │
│                                                                   │
│   reads ←  in-repo .coderabbit.yml   (per-path instructions,     │
│                                       tone, auto-review config)   │
│                                                                   │
│   reads ←  CodeRabbit web dashboard  (knowledge base, learnings)  │
│                                                                   │
│   reads ←  PR check-run statuses     (CI workflows: ci.yml,       │
│            + SARIF annotations         slither.yml, deadcode-      │
│            + bot comments              reachability.yml)          │
└───────────────────────────────────────────────────────────────────┘
```

The YAML and the dashboard tell CodeRabbit **what to look for**. The CI
workflows give CodeRabbit **independent ground-truth signals** (compile
errors, lint failures, test pass/fail, Slither findings, dead-code growth).
The combination is what makes the review go deep — none of the three on its
own is enough.

---

## Knowledge-base setup (dashboard)

The web UI lives at <https://app.coderabbit.ai/> → select this repo →
**Knowledge Base**. The KB is Pro-tier and persistent — once seeded, every
PR review on the repo benefits.

### What to upload

These are the files that turn generic Solidity review into Doefin-aware
review. Upload as documents (not links — the dashboard reads them at
review time):

**Tier 1 — must upload (load-bearing context):**

- [`audit-exclusion-guidance.md`](../audit-exclusion-guidance.md) — tells
  CodeRabbit which contracts are upstream / out of scope.
- [`audit/00-scope.md`](../audit/00-scope.md) — the in-scope inventory.
- [`audit/business-logic/invariants.md`](../audit/business-logic/invariants.md)
   — the 22-invariant spec. This is the most valuable single document —
   it's how CodeRabbit can say "this change violates INV-SOLV-2."
- [`audit/business-logic/coverage.md`](../audit/business-logic/coverage.md)
   — invariant ↔ test map.
- [`audit/REPORT.md`](../audit/REPORT.md) — the main audit report.
- [`audit/findings-ledger.md`](../audit/findings-ledger.md) — consolidated
  finding IDs (BIZ-/SEC-/CPX-/GAS-) so CodeRabbit can cite them by name.

**Tier 2 — strongly recommended:**

- [`audit/test-engineering/mutation-report.md`](../audit/test-engineering/mutation-report.md)
   — establishes the mutation-testing convention; CodeRabbit will then call
   out "this test would survive mutation X" patterns.
- [`audit/phase2-review/REVIEW.md`](../audit/phase2-review/REVIEW.md) +
  the `phase2-review/*-findings.md` files — recent complexity / gas /
  architecture work, useful context for any refactor PR.
- [`audit/findings/manual-review-dead-code-A2-A3to6.md`](../audit/findings/manual-review-dead-code-A2-A3to6.md)
   — SCRUM-235 missing-invariant precedent.
- [`audit/findings/business-logic-findings.md`](../audit/findings/business-logic-findings.md)
   — BIZ-001..006 historical context.
- [`audit/findings/dead-code-findings.md`](../audit/findings/dead-code-findings.md)
   — the dead-code analysis methodology, so CodeRabbit recognises stale code.
- [`audit/fixes/changelog.md`](../audit/fixes/changelog.md) — the
  remediation log keyed to commits.
- [`.claude/CLAUDE.md`](../.claude/CLAUDE.md) — the project handbook
  (architecture, conventions, branch strategy, current task). This is the
  same context the in-IDE AI sees; making it visible to CodeRabbit aligns
  the two.

**Tier 3 — useful but optional:**

- [`audit/triage-notes.md`](../audit/triage-notes.md)
- [`audit/manifest.md`](../audit/manifest.md)
- `audit/gas/report.md`

### Seed `Learnings`

In the dashboard under **Learnings**, add the following short rules
verbatim. These become the standing "what to always flag" prompts CodeRabbit
runs against every PR:

```
- The operator is trusted to MATCH orders but NOT for solvency. Any change
  to settlement that removes or weakens a per-leg guard (signature,
  validity, fee max-rate, fee <= proceeds, zero-collateral leg, condition
  active+unresolved) is HIGH severity. Reference INV-MISC-3 from
  audit/business-logic/invariants.md.

- EIP-712 cross-runtime parity: any change to LibDoefinOrder typehash,
  field list, or domain version MUST be matched in doefin-backend
  (shared/scw/encoder.py + match-engine/app/utils/settlement_abi.py) and
  doefin-frontend (contracts/doefin/v3/generated/). Flag and call out the
  required cross-repo coordination.

- EIP-7201 storage namespacing: new modules MUST get their own namespace
  library (LibXxxStorage). Never embed new sub-structs in
  LibDoefinStorage's legacy AppStorage. Existing namespaced struct fields
  must only be APPENDED, never inserted/reordered/typed-changed.

- Custom errors only — no revert strings anywhere in contracts/. Shared
  errors live in libraries/Errors.sol; shared constants in
  libraries/LibConstants.sol.

- Solidity test convention: assertions on parameterised custom errors use
  `revertedWith("Err(arg1,arg2)")`; for view-call reverts under waffle 3.4
  the `expectRevertWithSelector` helper is required. Flag soft
  `.to.be.reverted` assertions on known custom errors.

- audit-exclusion-guidance.md is authoritative for what's out of audit
  scope. Don't deep-review files listed there (CTF, Diamond reference
  template, mocks, the Echidna harness). Do flag drift between that file
  and the actual filesystem.
```

### Code Generation preferences

If you use `@coderabbitai generate unit tests` or `generate docstrings`,
set these defaults in the dashboard's **Code Generation** section:

- Test framework: **Hardhat + Mocha + Chai**
- Test fixture: reuse `test/utils/auditFixture.js` (`setupAuditFixture`)
- Custom error assertion: `revertedWith("ErrorName(args...)")` or the
  `expectRevertWithSelector` helper for view calls
- Comment style: every test file begins with a rationale block citing the
  invariant / finding it pins (see `test/audit/SCRUM-235-*` for the template)

---

## CI integration

### What we ship

| Workflow | Purpose | Gates merge? |
|---|---|---|
| `.github/workflows/ci.yml` | compile + solhint + full Hardhat test + size-contracts (also runs the EIP-7201 storage-layout snapshot gate) | **Yes** |
| `.github/workflows/slither.yml` | Slither security static analysis with SARIF upload + PR review comments | No (advisory) |
| `.github/workflows/deadcode-reachability.yml` | SCRUM-234 Layer-2 call-graph closure; reports dead-set deltas as a job summary | No (advisory) |

### How CodeRabbit reads them

Three input channels — all automatic on Pro tier, no extra config needed:

1. **PR check-run statuses.** CodeRabbit sees ✅/❌ for every workflow.
   It explicitly mentions failed checks in its review summary. A red `ci`
   check shows up as "the test suite is failing — see [workflow run]" in
   the PR summary, not as silent context.
2. **SARIF annotations on diff lines.** `slither.yml` uploads a SARIF
   report to the GitHub Security tab; the annotations also land on the
   specific lines of the diff. CodeRabbit reads those annotations and
   weights them in its inline comments — "Slither flagged this as a
   reentrancy risk; here's the context."
3. **PR comments from other bots.** Anything that posts to the PR
   (including markdown reports from `crytic/slither-action`, `dependabot`,
   etc.) is read by CodeRabbit and rolled into its summary. So a Slither
   markdown report becomes part of CodeRabbit's "here's what to look at."

The upshot: **adding a CI check is the single highest-leverage way to make
CodeRabbit smarter** about a domain. Want it to flag failing tests? Run
tests in CI. Want it to flag a specific lint rule? Add the linter to CI.
Want it to surface security findings? Run Slither in CI.

### CI checks worth adding later (not in this initial setup)

- **`forge fmt --check`** — once we adopt Foundry-style formatting (we
  don't today).
- **Coverage gate** — `npx hardhat coverage` is slow (~20 min); run it on
  push to `v3/dev` + `main` only, upload to codecov, surface % delta as
  a PR comment. Skipped initially because of the runtime cost.
- **EIP-712 cross-runtime parity** — compute the typehash here and assert
  it matches `doefin-backend/shared/scw/encoder.py`. Needs cross-repo
  checkout. High value, moderate effort.
- **Gas snapshot diff** — produce a `gas-snapshot.txt` per branch, diff
  against the base, post the delta as a PR comment. CodeRabbit reads it.

---

## Slither: how it gets to CodeRabbit

CodeRabbit doesn't run Slither natively today (as of this repo's
configuration; check
<https://docs.coderabbit.ai/tools/> for the current list — if Slither
becomes a first-class tool, enable it via `reviews.tools.slither.enabled`
in `.coderabbit.yml` and drop the CI workflow).

The workflow we ship (`.github/workflows/slither.yml`) is the bridge:

```
PR opened → slither.yml runs `crytic/slither-action`
         → outputs SARIF file
         → SARIF uploaded to GitHub Security tab (inline annotations)
         → PR review summary posted as a comment
         → CodeRabbit reads BOTH and folds them into its review
```

### Tuning Slither for Doefin

The action invocation in `slither.yml` already:

- excludes `contracts/mock`, `contracts/audit`, `node_modules`,
  `@openzeppelin` (consistent with `audit-exclusion-guidance.md`)
- excludes informational + low findings (high noise:signal otherwise)
- uses `security/slither.config.json` for project-wide settings

If you find Slither too noisy / too quiet, adjust there — not in the
workflow file.

### When to look at Slither output directly

- **GitHub Security tab** (left sidebar of the repo) — accumulated findings
  across branches, with severity ranking.
- **PR comments** — newest run posted at the bottom of every PR that
  touched `contracts/`.
- **CodeRabbit summary** — the high-signal Slither finds quoted in
  context next to the affected diff lines.

---

## PR command cheat sheet

In any PR comment, mention `@coderabbitai`:

| Command | When to use it |
|---|---|
| `@coderabbitai review` | Re-trigger an incremental review (cheap, uses cached state). |
| `@coderabbitai full review` | Force a full re-review, bypassing the cache. Use after big config / KB changes. |
| `@coderabbitai summary` | Regenerate the PR-summary block. |
| `@coderabbitai resolve` | Mark all CodeRabbit comments as resolved at once. |
| `@coderabbitai pause` / `resume` | Stop / restart auto-reviews on this PR. |
| `@coderabbitai ignore` | Skip this entire PR (one-off; permanent flag is `.coderabbitignore`). |
| `@coderabbitai generate docstrings` | Pro — generate NatSpec / JSDoc for the diff. |
| `@coderabbitai generate unit tests` | Pro — propose unit tests for the diff. |
| `@coderabbitai help` | Show the live command list (always current). |

### Doefin-specific power moves

```
@coderabbitai analyze the security implications of the changes to
SettlementFacet._validateOrder against the 22 invariants in
audit/business-logic/invariants.md
```

```
@coderabbitai is this change consistent with the operator trust model
defined in INV-MISC-3? List which guards are reinforced and which are weakened.
```

```
@coderabbitai cross-reference this typehash change against
doefin-backend/shared/scw/encoder.py — does the backend require an
encoder.py update?
```

```
@coderabbitai for the new external function on lines 120-145, generate a
test/audit/<FINDING-ID>-*.test.js file in the project style
(test/audit/SEC-003-*.test.js for the template) that proves the attack is
blocked AND a CONTROL test that the legitimate case settles.
```

```
@coderabbitai propose a mutation-test pass for the new guards added in
this PR — which mutations should the new tests kill?
```

---

## Working with the per-path instructions

The `path_instructions` in `.coderabbit.yml` are the highest-leverage
in-repo control. They tell CodeRabbit not just **what to look for** but
**which invariants to cite**.

### When to add / update a path instruction

- New facet → add a `contracts/facets/NewFacet.sol` entry with its
  security model.
- New library namespace (EIP-7201) → add a `contracts/libraries/LibNew*.sol`
  entry citing the namespace ID + storage migration constraints.
- New test convention → add a path entry to `test/**` so the convention
  is enforced PR-over-PR.

### Pattern

Each entry is `path:` (gitignore-style glob) + `instructions:` (free-form
prose). The instructions are sent to the LLM with every review of a file
matching the glob, so:

- Be specific. "Review for reentrancy" is weak. "Reentrancy: this facet
  is `nonReentrant` via LibReentrancyGuard. Any new external call inside
  matchOrders/fillOrder creates a new reentrancy surface — flag it and
  require a test driving a malicious receiver/token/operator" is strong.
- Cite IDs (INV-X, SEC-Y, SCRUM-Z). The KB has the full context; the
  path instruction tells CodeRabbit which IDs to cite.
- Cross-reference. Link facet ↔ library ↔ test ↔ audit doc.

---

## Maintenance

| Change | What to update |
|---|---|
| New facet added to `scripts/deploy.js` | `.coderabbit.yml` `path_instructions`, `audit/00-scope.md`, `audit-exclusion-guidance.md` (if out of scope) |
| New finding ID introduced | Add to KB (Learnings or new doc), add to `audit/findings-ledger.md` |
| New CI workflow added | This file (the table in [CI integration](#ci-integration)) |
| New per-path lint rule / pattern | Add to the relevant `path_instructions` entry; do NOT rely on humans to remember |
| Slither config tuned | `security/slither.config.json` — `slither.yml` uses it automatically |
| KB doc renamed / moved | Re-upload in the dashboard (uploads aren't path-tracked) |

Quarterly: skim CodeRabbit's published changelog
(<https://docs.coderabbit.ai/changelog>) for new tool integrations
(Slither native? new Solidity rules?) and update `.coderabbit.yml`.

---

## Troubleshooting

### "CodeRabbit only reviewed the markdown / docs in my PR"

In order of likelihood:

1. **PR too large.** CodeRabbit hits a token / file budget on huge PRs
   and falls back to the cheapest content. Split. The 55-commit PR that
   prompted this setup is the classic example.
2. **Path filters excluded the files.** Check the `path_filters` section
   in `.coderabbit.yml` — make sure the path you expected reviewed isn't
   in the exclusion list.
3. **No `path_instructions` for the file's path.** CodeRabbit will still
   review without instructions, but it leans heavily on the cheapest
   heuristics. Add a per-path entry — see above.

### "The review is shallow — no security-specific commentary"

- Check the **Knowledge Base** is populated. Without `invariants.md` and
  the finding ledger, CodeRabbit has no IDs to cite.
- Check that `profile: assertive` is in `.coderabbit.yml` (not `chill`).
- Use `@coderabbitai full review` to bypass cached incremental review.
- Trigger a focused query: `@coderabbitai analyze the security
  implications of the changes to <facet>`.

### "Slither annotations aren't showing on the diff"

- Confirm `slither.yml` ran (Actions tab) and produced a SARIF artifact.
- Confirm the workflow has `permissions.security-events: write`.
- Confirm `crytic/slither-action`'s `sarif:` output param matches the
  upload step's `sarif_file:` value.
- Slither annotations are only attached if the line in the SARIF matches
  a line in the PR's diff. If Slither flags code unchanged by the PR,
  the annotation goes to the Security tab, not the diff.

### "The dead-code workflow is breaking on PRs that don't touch contracts"

- The `paths:` filter on `deadcode-reachability.yml` already gates it to
  `contracts/`, `scripts/deploy.js`, and the script itself. If you're
  seeing it run anyway, the PR probably modified one of those — that's
  intentional.

### "CodeRabbit auto-replied but missed an obvious bug"

Tell it: `@coderabbitai you missed X — please reanalyze with that in
mind`. The follow-up review uses the original PR context plus your hint
and is usually much sharper. Add a `path_instruction` to prevent
recurrence on the next PR.
