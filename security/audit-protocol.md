# Doefin v3 Mainnet Audit — Coordination Protocol

The shared specification for the multi-agent mainnet-readiness audit. Every
audit agent reads this file. It defines the phases, the findings ledger, the
severity rubric, and the go/no-go gate.

## Agents

| Agent | Role |
|---|---|
| `audit-orchestrator` | Lead — scopes, dispatches, merges, renders the verdict |
| `sc-tooling-runner` | Runs Slither/Mythril/Echidna/Medusa in Docker |
| `sc-manual-reviewer` | Manual security audit (Domain 1) |
| `sc-business-logic` | Economic invariants + test coverage (Domain 3) |
| `sc-gas-optimizer` | Gas optimization (Domain 2) |
| `sc-complexity-analyst` | Complexity / maintainability (Domain 4) |
| `audit-triage` | False-positive gate, dedup, severity |
| `sc-developer` | Implements fixes (the ONLY agent that edits production code) |

## The hard rule

Every agent EXCEPT `sc-developer` may only create or modify files under
`audit/`. No audit agent may modify `contracts/`, `scripts/`, `test/`,
`package.json`, `hardhat.config.js`, or any other production file. A code
change is delivered as a *finding with a recommendation*, never as an edit.
`sc-developer` is the sole exception and only during Phase 5 (fixes) and the
Phase 3 harness.

## Phases

| Phase | Agent(s) | Consumes | Produces |
|---|---|---|---|
| 0 Scope | orchestrator | exclusion guidance, CLAUDE.md, SC-008 reviews, git | `audit/00-scope.md`, `audit/manifest.md` |
| 1 Tooling baseline | tooling-runner | `00-scope.md` | `audit/output/{slither,mythril,size}/`, `audit/output/SUMMARY.md` |
| 2 Domain passes | manual-reviewer, business-logic, gas-optimizer, complexity-analyst (concurrent) | `00-scope.md`, `output/SUMMARY.md` | `audit/findings/*.md`, `audit/business-logic/{invariants,coverage}.md`, `audit/gas/report.md` |
| 3 Fuzzing | sc-developer (harness), tooling-runner (run) | `business-logic/invariants.md` | `contracts/audit/DoefinInvariantHarness.sol`, `audit/output/{echidna,medusa}/` |
| 4 Triage | audit-triage | all `findings/*`, all `output/*` | `audit/findings-ledger.md`, `audit/triage-notes.md` |
| 5 Fix | sc-developer | `findings-ledger.md` (confirmed) | code fixes + tests, `audit/fixes/changelog.md` |
| 6 Re-verify | tooling-runner + fresh manual-reviewer | `fixes/changelog.md` | `audit/reverify/verdict.md` |
| 7 Report | orchestrator | everything | `audit/REPORT.md` |

Each phase runs with fresh agent context. The orchestrator updates
`audit/manifest.md` at every phase boundary.

## Directory layout

```
audit/
  manifest.md            shared tracking doc — current phase, agent status
  00-scope.md            frozen scope, pinned commit SHA, regression checklist
  findings-ledger.md     canonical triaged ledger
  triage-notes.md        written justification for every false-positive call
  REPORT.md              final report + go/no-go verdict
  output/                raw tool dumps (gitignored)
    slither/ mythril/ echidna/ medusa/ gas/ coverage/ size/  SUMMARY.md
  findings/              raw per-domain findings, pre-triage
  business-logic/        invariants.md, coverage.md
  fixes/                 changelog.md
  reverify/              verdict.md
```

## Findings ledger — one block per finding

```
### <ID>: <title>
id:             SEC-001 | BIZ-001 | GAS-001 | CPX-001
domain:         security | business-logic | gas | complexity
severity:       critical | high | medium | low | informational
status:         new | confirmed | false-positive | duplicate | needs-info | wont-fix
decision:       fix | defer | accept-risk | n/a
reverify:       pending | fixed-clean | fixed-with-new-issue | not-fixed
location:       contracts/facets/SettlementFacet.sol:NNN-MMM
source:         manual-reviewer | slither(<detector>) | mythril | echidna(<prop>) | business-logic | gas | complexity
duplicate-of:   <ID or ->
conflicts-with: <ID or ->
regression-of:  <SC-008 finding id or ->
swc:            <SWC-NNN or ->
title:          one line
description:    what is wrong, mechanically
impact:         who is harmed and how much
poc:            reproduction steps, or the failing invariant
recommendation: the fix, with a code sketch where useful
upgrade-safe:   yes | no | n/a   (does the fix change storage layout / selectors)
fix-commit:     <SHA or ->
fix-test:       <test file::case or ->
```

## Severity rubric

- **CRITICAL** — direct loss of funds or Diamond insolvency, reachable without
  a trust assumption. Mainnet-blocking.
- **HIGH** — loss of funds / protocol integrity behind a precondition
  (compromised operator, specific token, edge input). Mainnet-blocking.
- **MEDIUM** — bounded incorrect behavior, griefing, capped value leak, or a
  security-relevant operational constraint. Conditional.
- **LOW** — best-practice deviation, defense-in-depth gap, no direct exploit.
- **INFORMATIONAL** — style, dead code, documentation, maintainability.

Caps: `gas` and `complexity` findings cap at MEDIUM. Only `security` and
`business-logic` may raise CRITICAL/HIGH.

## False-positive gate (triage)

A raw finding is marked `false-positive` only with a written reason in
`triage-notes.md` that falls into: (a) the path is unreachable given access
control or the `LibReentrancyGuard` lock; (b) the code is in an excluded file
(`audit-exclusion-guidance.md`); (c) the detector misreads an intentional,
verified-safe Diamond pattern; (d) it is a documented, intentional design
choice. Anything else stays `confirmed` or `needs-info` — the gate is
conservative; uncertain findings are never silently dropped.

## Mainnet go / no-go gate

**NO-GO** if any: confirmed CRITICAL/HIGH not `fixed-clean`; a regression-checklist
item open at CRITICAL/HIGH; an economic invariant still failing under fuzzing;
a storage-collision or selector-collision finding; an in-scope facet over
24 KiB; a CRITICAL/HIGH invariant with zero test coverage.

**CONDITIONAL-GO** — only MEDIUM/LOW remain, each fixed or carrying a written
accepted-risk note plus an operational mitigation.

**GO** — zero confirmed CRITICAL/HIGH; all regression items resolved; all
economic invariants pass under fuzzing; coverage complete on crown-jewel facets.
