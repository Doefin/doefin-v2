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
3. [Knowledge base — what the dashboard form really is](#knowledge-base--what-the-dashboard-form-really-is)
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
| Tool toggles (semgrep, gitleaks, ast-grep, markdownlint, yamllint, shellcheck, languagetool — the v2 catalog has 60+) | **YAML** — `reviews.tools.*` | Same. (Solidity-specific tools — solhint, Slither — aren't in the v2 catalog; they run in CI workflows instead and CodeRabbit reads the check-run status + SARIF / comments.) |
| Tone / persona instructions | **YAML** — `tone_instructions` | Same. |
| `@coderabbitai generate docstrings` / `generate unit tests` toggles | **YAML** — `reviews.finishing_touches.*` | Same. |
| Chat auto-reply, Jira/Linear chat usage flags | **YAML** — `chat.*` | Same. |
| Knowledge base — in-repo guideline docs scanned every review | **YAML** — `knowledge_base.code_guidelines.{enabled, filePatterns}` | The dashboard's KB page has no file upload — its "File patterns" field IS this YAML array. Same data, different form. |
| Knowledge base — cross-repo dependencies (catch ABI / typehash drift in doefin-backend / doefin-frontend) | **YAML** — `knowledge_base.linked_repositories[]` | The dashboard's "Linked repositories" field IS this YAML array. |
| Knowledge base — Learnings / Issues / Pull-request scope (local / global / auto) | **YAML** — `knowledge_base.{learnings,issues,pull_requests}.scope` | The dashboard's scope dropdowns ARE these YAML enum fields. |
| Knowledge base — Web search toggle | **YAML** — `knowledge_base.web_search.enabled` (default true) | Same. |
| Knowledge base — Jira / Linear / MCP usage flags (NOT the OAuth) | **YAML** — `knowledge_base.{jira,linear,mcp}.usage` | The OAuth wiring stays in the dashboard; the per-repo usage flag is YAML. |
| Code generation — docstring language + per-path docstring style | **YAML** — `code_generation.docstrings.{language, path_instructions[]}` | The dashboard's "Code generation → Docstring" page IS these YAML fields. |
| Code generation — per-path unit-test style | **YAML** — `code_generation.unit_tests.path_instructions[]` | Same — dashboard form == YAML field. |
| Standing review rules / `tone_instructions` (capped at 250 chars by the v2 schema) | **YAML** — `tone_instructions` + the per-path `reviews.path_instructions` carry the long-form ones | Version-controlled, diff-able. |
| GitHub App install, repo access, bot permissions | **Dashboard only** | GitHub App–level config; can't go in YAML. |
| Linear / Jira / Slack / MS Teams integration auth (OAuth tokens) | **Dashboard only** | OAuth / secrets — can't go in git. |
| API keys for external tool integrations | **Dashboard only** | Secrets. |
| Plan / billing | **Dashboard only** | N/A for YAML. |

**One-line rule of thumb:** if it isn't a secret and doesn't require OAuth,
put it in `.coderabbit.yml` and let git track it.

---

## Knowledge base — what the dashboard form really is

Looking at the dashboard's Knowledge base page, you'll see fields like
**Linked repositories**, **Web search**, **Code guidelines (Enabled + File
patterns)**, **Learnings scope**, **Issues scope**, **Jira**, **Linear**.
There is **no file upload** anywhere — older versions had one, the current
UI does not. Every field on the page is a direct surface over the same
`knowledge_base.*` YAML schema we already use.

The implication for our YAML-first approach: **everything on the dashboard
Knowledge base page can be set in `.coderabbit.yml`**, and ours does. The
load-bearing piece is `code_guidelines.filePatterns` — pointing CodeRabbit
at in-repo guideline docs (the 22-invariant spec, the exclusion guidance,
etc.). CodeRabbit scans those files on every review and applies their
content as project-specific standards.

What we ship in `.coderabbit.yml` `knowledge_base`:

| Field | Setting |
|---|---|
| `code_guidelines.filePatterns` | `audit-exclusion-guidance.md`, `audit/business-logic/invariants.md`, `audit/business-logic/coverage.md`, `audit/findings-ledger.md`, `audit/REPORT.md`, the dead-code manual-review, the mutation report, `.claude/CLAUDE.md`, `.github/CODERABBIT.md` |
| `linked_repositories[]` | `Doefin/doefin-backend` + `Doefin/doefin-frontend` with cross-repo coordination instructions (catches EIP-712 typehash / ABI drift) |
| `web_search.enabled` | `true` (default; explicit for clarity) |
| `learnings.scope`, `issues.scope`, `pull_requests.scope` | `auto` |
| `jira.usage`, `linear.usage` | `auto` (the OAuth wiring stays in the dashboard — set up once when needed, then forget) |
| `mcp.usage` | (not set — default `auto`) |

This is the entire KB surface. No upload step exists; reviewing the
dashboard form is a sanity check, not an action item.

### Standing review rules — `tone_instructions` (capped at 250 chars)

The v2 schema caps `tone_instructions` at 250 characters, so the long-form
review model can't live there. We use it for the persona+voice statement
only ("senior-security review of Doefin v3 ... cite the INV-/SEC-/BIZ-/
SCRUM- invariant at risk from invariants.md, not generic best-practice
advice"). The actual invariant content + per-area review rules live in
`reviews.path_instructions` (no length cap), and the longer-form context
is in the `code_guidelines.filePatterns` files listed above.

If the dashboard has a **Learnings** / **Memory** / **Custom Rules**
text-box anywhere (separate from the scope dropdown), it's a belt-and-
braces amplification — paste the standing rules block below. The same
content is already embedded in our YAML `path_instructions` for the
relevant globs, so the dashboard paste is optional:

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

### Code Generation — per-path instructions, YAML only

Same pattern as the KB page: the dashboard's **Code generation** page has
no "set the default test framework" controls. What it actually exposes
is `code_generation.docstrings.path_instructions[]` and
`code_generation.unit_tests.path_instructions[]` — per-path style guides
that take effect when someone runs `@coderabbitai generate docstrings`
or `generate unit tests` on a PR.

Both are set in our YAML:

- **`code_generation.docstrings`** — language `en-US`; per-path NatSpec
  requirements for facets (every external/public fn needs `@notice`,
  `@dev`, `@param`, `@return`, `@custom:security <ID>`, `@custom:audit`,
  `@custom:reverts <ErrorName>`), libraries (note caller-validated-inputs
  assumption + EIP-7201 storage-location comment for `Lib*Storage`),
  mocks (explicit test-only NatSpec).
- **`code_generation.unit_tests`** — per-path test conventions for
  `test/audit/**` (finding-ID filename + attack-blocked + CONTROL test +
  rationale-block header + `setupAuditFixture` reuse + parameterised
  custom-error assertions), `test/unit/**` (Hardhat+Mocha+Chai, exercise
  the negative case, no soft `.to.be.reverted`), `test/integration/**`
  (real facet flow, no mocking production paths).

To use them: comment `@coderabbitai generate docstrings` or `generate
unit tests` on any PR. CodeRabbit generates against the diff using the
per-path style guides above.

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
