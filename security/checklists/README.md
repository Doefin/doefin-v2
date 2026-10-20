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
Diamond-reference boilerplate and mocks. The block-header oracle was
**re-scoped IN** by SCRUM-521 (2026-09-23) after its former exclusion hid SEC-015; work the SCSVS V10 lens on it.
The conditional tokens (CTF) were **re-scoped IN** by SCRUM-214 (2026-10-19) after the review found
CTF-001 (Critical) .. CTF-008 in the Doefin additions (`audit/findings/ctf-review.md`).
Findings located in the excluded files — the Diamond-reference boilerplate, `contracts/mock/` and
the audit harness (`contracts/audit/DoefinInvariantHarness.sol`), as listed there — are marked OUT OF
SCOPE, not rated. The oracle and CTF files are in scope.
