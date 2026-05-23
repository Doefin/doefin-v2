# CodeRabbit — Doefin v3 setup guide

This is the operator's manual for the CodeRabbit Pro integration on this repo.
Companion to [`.coderabbit.yml`](../.coderabbit.yml) (in-repo review behaviour)
and `.github/workflows/` (the CI checks CodeRabbit reads from).

If you're here because a PR got a shallow review, jump to
[Troubleshooting](#troubleshooting).

---

## Table of contents

1. [How the pieces fit](#how-the-pieces-fit)
2. [Where to put what — the YAML-first playbook](#where-to-put-what--the-yaml-first-playbook)
3. [Knowledge base — two options](#knowledge-base--two-options)
4. [CI integration — what we feed CodeRabbit and why](#ci-integration)
5. [Slither: how it gets to CodeRabbit](#slither-how-it-gets-to-coderabbit)
6. [`@coderabbitai` PR command cheat sheet](#pr-command-cheat-sheet)
7. [Working with the per-path instructions](#working-with-the-per-path-instructions)
8. [Maintenance](#maintenance)
9. [Troubleshooting](#troubleshooting)

---

## How the pieces fit

CodeRabbit on this repo has **three layered inputs**, but they are NOT
peer-equal — the in-repo `.coderabbit.yml` wins:

```
┌──────────────────────────────────────────────────────────────────────┐
│  CodeRabbit review on a PR                                           │
│                                                                      │
│   reads (PRIMARY)  ← in-repo .coderabbit.yml — v2 schema, versioned  │
│                      with the code. Source of truth for review       │
│                      behaviour, per-path instructions, tone, tools.  │
│                                                                      │
│   reads (FALLBACK) ← dashboard "YAML editor" / "Precise" / "All      │
│                      settings" — the SAME v2 schema, but only        │
│                      consulted for repos with no `.coderabbit.yml`.  │
│                      For us this is dead weight; leave it as-is.     │
│                                                                      │
│   reads (CONTEXT)  ← dashboard Knowledge Base + Learnings — the      │
│                      handful of things YAML can't express, OR a      │
│                      convenience for indexing repo docs faster than  │
│                      re-reading them per PR. Optional for us; see    │
│                      "Knowledge base — two options" below.           │
│                                                                      │
│   reads (CI)       ← PR check-run statuses + SARIF annotations +     │
│                      other bots' PR comments (ci.yml, slither.yml,   │
│                      deadcode-reachability.yml). Independent         │
│                      ground-truth signals CodeRabbit folds in.       │
└──────────────────────────────────────────────────────────────────────┘
```

**Precedence rule (load-bearing):** when `.coderabbit.yml` exists at the
repo root, CodeRabbit ignores the dashboard YAML. You do not need to keep
them in sync. Edit YAML in git.

CI gives CodeRabbit independent ground truth (compile errors, lint
failures, test pass/fail, Slither findings, dead-code growth). **Adding a
CI check is the highest-leverage single move to make CodeRabbit smarter
about a domain.**

---

## Where to put what — the YAML-first playbook

The TL;DR: **YAML for as much as possible.** Use the dashboard only for the
four or five things that genuinely can't be in YAML.

| Setting category | Where | Why |
|---|---|---|
| Review profile (`chill`/`assertive`), tone, auto-review on/off, base branches, drafts | **YAML** — `.coderabbit.yml` `reviews.*` | Versioned, diff-able, reviewable in PRs. |
| Per-path review instructions (the heart of useful Solidity review) | **YAML** — `reviews.path_instructions` | Citing INV-* / SEC-* / BIZ-* IDs in YAML makes the rule travel with the code. |
| Path filters (what gets reviewed vs ignored) | **YAML** — `reviews.path_filters` | Same. |
| Tool toggles (solhint, semgrep, gitleaks, ast-grep, markdownlint, yamllint, shellcheck, languagetool) | **YAML** — `reviews.tools.*` | Same. |
| Tone / persona instructions | **YAML** — `tone_instructions` | Same. |
| `@coderabbitai generate docstrings` / `generate unit tests` toggles | **YAML** — `reviews.finishing_touches.*` | Same. |
| Chat auto-reply, Jira/Linear chat usage flags | **YAML** — `chat.*` | Same. |
| Knowledge base — repo files used as standing context | **YAML preferred** via `path_instructions` referencing repo files (`audit/business-logic/invariants.md`, etc.), OR **dashboard** upload if you want semantic retrieval across PRs that don't touch those files | The in-repo approach keeps everything in git. The dashboard upload is faster for whole-repo recall. See [Knowledge base — two options](#knowledge-base--two-options). |
| Standing rules / "Learnings" | **YAML preferred** — `tone_instructions` + `path_instructions` cover ~all of it. Dashboard "Learnings" is for cumulative preferences captured from PR feedback over time. | Same — version control wins. |
| GitHub App install, repo access, bot permissions | **Dashboard only** | GitHub App–level config; can't go in YAML. |
| Linear / Jira / Slack / MS Teams integration auth (OAuth tokens) | **Dashboard only** | OAuth / secrets — can't go in git. |
| API keys for external tool integrations | **Dashboard only** | Secrets. |
| Plan / billing | **Dashboard only** | N/A for YAML. |

**One-line rule of thumb:** if it isn't a secret and doesn't require OAuth,
put it in `.coderabbit.yml` and let git track it.

---

## Knowledge base — two options

CodeRabbit needs project-specific context (the 22 invariants, the operator
trust model, the EIP-7201 namespacing rule, etc.) to produce reviews that
cite IDs instead of generic best-practice advice. Two ways to give it that
context:

### Option A — In-repo references via `path_instructions` (preferred for us)

We already do this. `.coderabbit.yml`'s `path_instructions` quote invariant
IDs (`INV-MISC-3`, `BL-N2`, `SCRUM-235`, etc.) and reference the docs that
define them (`audit/business-logic/invariants.md`, etc.). When CodeRabbit
reviews a file matching the glob, it sees the instruction and can read the
referenced docs from the same PR's repo checkout.

**Pros:** zero dashboard config; versioned with the code; survives team
rotation; the source of truth is the same file the engineers read.

**Cons:** CodeRabbit re-reads the doc per review (small token cost); recall
is scoped to PRs that touch a matching path.

This is what's live. No action needed.

### Option B — Dashboard upload (for cross-PR semantic recall)

If you want CodeRabbit to *always* have certain docs in working memory —
even on PRs that don't touch the relevant code paths — upload them to the
dashboard's Knowledge Base:

> CodeRabbit dashboard → this repo → look for a sidebar item named
> **Knowledge Base** / **Documents** / **Context Files** (label varies
> across UI versions).

Upload-worthy short list:

- `audit/business-logic/invariants.md` — the 22-invariant spec (single
  highest-value doc).
- `audit-exclusion-guidance.md` — what's out of scope.
- `audit/business-logic/coverage.md` — invariant ↔ test map.
- `audit/findings-ledger.md` — finding-ID dictionary.

Everything else stays in-repo (Option A); CodeRabbit pulls on demand.

### Optional: pre-seed standing rules in dashboard "Learnings"

If your dashboard has a **Learnings** / **Memory** / **Custom Rules**
section, paste these rules. They then apply on every PR regardless of which
file changes (belt-and-braces — the same rules are also embedded in
`.coderabbit.yml`'s `tone_instructions` / `path_instructions`):

```
- The operator is trusted to MATCH orders but NOT for solvency. Any change
  to settlement that removes or weakens a per-leg guard (signature,
  validity, fee max-rate, fee <= proceeds, zero-collateral leg, condition
  active+unresolved) is HIGH severity. Reference INV-MISC-3 from
  audit/business-logic/invariants.md.

- EIP-712 cross-runtime parity: any change to LibDoefinOrder typehash,
  field list, or domain version MUST be matched in doefin-backend
  (shared/scw/encoder.py + match-engine/app/utils/settlement_abi.py) and
  doefin-frontend (contracts/doefin/v3/generated/). Flag the required
  cross-repo coordination.

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

### Code Generation defaults

If your dashboard has a **Code Generation** section (used by
`@coderabbitai generate unit tests` / `generate docstrings`), set:

- Test framework: **Hardhat + Mocha + Chai**
- Test fixture: reuse `test/utils/auditFixture.js` (`setupAuditFixture`)
- Custom error assertion: `revertedWith("ErrorName(args...)")` or the
  `expectRevertWithSelector` helper for view calls
- Comment style: every test file begins with a rationale block citing the
  invariant / finding it pins (template in `test/audit/SCRUM-235-*`)

Optional — these are also in our YAML `path_instructions` for the
`test/**` globs.

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

### v2 schema header — keep it on the first line

`.coderabbit.yml` starts with:

```yaml
# yaml-language-server: $schema=https://coderabbit.ai/integrations/schema.v2.json
```

This is a magic comment that tells VS Code, JetBrains, vim's
yaml-language-server, etc. to validate the file against CodeRabbit's v2
schema — autocomplete on field names, type errors on bad values, hover
docs on hover. If you ever see CodeRabbit complain about an unknown field,
the schema header is the fastest way to diagnose locally before pushing.

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

### "The dashboard YAML editor and my `.coderabbit.yml` disagree — which wins?"

The in-repo `.coderabbit.yml` wins, every time, when it's present. The
dashboard YAML editor edits a fallback config that's only used by repos
*without* an in-repo file. You don't need to keep them in sync; you don't
need to copy your in-repo YAML into the dashboard. Treat the dashboard YAML
panel as cosmetic for this repo and edit YAML in git.

Diagnostic: if a change you made to `.coderabbit.yml` doesn't show up in
the next PR review, check (a) it's actually on the PR's head commit, (b)
its base branch is in `reviews.auto_review.base_branches`, (c) the schema
header didn't make a validation error somewhere (the schema-validation
panel in your editor will flag it instantly).

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
