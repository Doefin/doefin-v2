# CodeRabbit triage ledgers

One ledger per PR, produced by the `cr-triage` agent (`.claude/agents/cr-triage.md`),
invoked via the `/cr-triage <PR#>` slash command.

## Why this exists

CodeRabbit Pro reviews are valuable but noisy. It mixes:

- Real defects (rare)
- Generic Solidity / TS / Python best-practice suggestions that may not fit our patterns
- Hallucinations / wrong reads of the code
- Documentation polish, NatSpec nits
- Cross-repo coordination flags (sometimes accurate, sometimes wrong)
- Re-flags of findings already resolved by the audit

The ledgers here are the project's **own** verdict on every CR comment — re-rated
from first principles against `audit/business-logic/invariants.md`, the existing
audit findings, and `.claude/CLAUDE.md`. CR's severity labels are recorded but
not honored.

## Schema

Each `PR-<N>.md` follows the schema in `.claude/agents/cr-triage.md`:

- Summary table (verdict counts + recurring patterns)
- Per-comment row: category, agent severity (Critical/High/Medium/Low/Info), verdict (ACCEPT-FIX/REJECT-TEACH/DEFER-TICKET/DISCUSS), evidence, action artefact (diff / reply text / follow-up row / trade-off)

## Workflow

1. `/cr-triage <PR#>` — dispatches the `cr-triage` agent
2. Agent writes `PR-<N>.md` (read-only — no code changes, no CR replies)
3. User reviews the ledger
4. For the agreed `ACCEPT-FIX` subset: apply via `sc-developer` or directly, commit per logical unit
5. For the agreed `REJECT-TEACH` subset: post the drafted replies on CR threads; if recurring, paste the matching block from `PR-<N>.teach.yml` into `.coderabbit.yml`

## Output paths

- `PR-<N>.md` — the ledger (always written)
- `PR-<N>.teach.yml` — optional YAML fragment for `.coderabbit.yml` (only when ≥2 occurrences of the same false-positive pattern)
