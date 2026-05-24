# Audit Checklists

The manual reviewer and triage agents use these standards as the structured
checklist backbone. They are referenced (not mirrored) here; agents have
`WebSearch`/`WebFetch` to pull the current revisions.

## OWASP Smart Contract Security Verification Standard (SCSVSv2)

A free checklist standardising smart-contract security verification, organised
into three chapters: **General** (design, upgrades, policies), **Components**
(per-contract patterns and their typical issues), and **Integrations** (threats
from contracts the project integrates with).

- https://scs.owasp.org/SCSVS/
- https://github.com/securing/SCSVS

## OWASP Smart Contract Top 10 (2025)

The ten highest-impact smart-contract vulnerability classes. Every confirmed
finding should be mapped to a Top-10 category or an SWC ID where one applies.

- https://owasp.org/www-project-smart-contract-top-10/

## EIP-2535 Diamond-specific checks

Not covered by the generic standards — verify explicitly:

- No storage-slot collisions **between facets** (each namespace is a distinct
  `keccak256` slot; `__gap` / `__reserved` arrays intact).
- No function-selector collisions across facets.
- A single compromised/incorrect facet cannot write the Diamond's admin slots.
- Upgrade safety: a `diamondCut` cannot reorder or shrink existing storage.

## Project-specific scope

`audit-exclusion-guidance.md` (repo root) defines what is **out of scope**:
Gnosis-imported CTF, block-header v1, Diamond-reference boilerplate, and mocks.
Findings located in those files are marked OUT OF SCOPE, not rated.
