# Doefin v3 — Security Toolchain

Dockerized security tooling for the Doefin v3 Diamond contracts. All static
analysis, symbolic execution, and fuzzing run inside one container based on the
Trail of Bits `eth-security-toolbox`, invoked from the host via `docker exec`.

## Contents

| Tool | Purpose | Where it runs |
|---|---|---|
| Slither | Static analysis, storage layout, printers | container |
| Mythril | Symbolic execution (per facet) | container |
| Echidna | Property fuzzing of the invariant harness | container |
| Medusa | Property fuzzing (cross-checks Echidna) | container |
| solhint | Solidity linter | host or container |
| hardhat-gas-reporter | Per-function gas, Base-L2 aware | host |
| solidity-coverage | Test coverage | host |
| hardhat-contract-sizer | EIP-170 24 KiB size check | host |

## Prerequisites

- Docker (the build pulls a ~1.1 GB base image, pinned by digest).
- `npm ci` has been run on the host (the `audit:gas` / `audit:coverage` /
  `audit:size` / `audit:lint` scripts run on the host).

## Quick start

```bash
npm run audit:build     # build the doefin-audit:local image (~5-12 min first time)
npm run audit:up        # start the long-lived container
npm run audit:smoke     # Phase 0 — prove every tool runs and the project compiles
```

If the smoke test passes, the toolchain is ready.

## npm scripts

**Container lifecycle:** `audit:build`, `audit:up`, `audit:down`, `audit:shell`

**In-container analysis** (container must be up):
`audit:smoke`, `audit:compile`, `audit:slither`, `audit:mythril`,
`audit:echidna`, `audit:medusa`, `audit:complexity`, `audit:all`

**Host-side** (no container needed):
`audit:lint`, `audit:gas`, `audit:coverage`, `audit:size`

## Audit runbook

| Phase | Command | Output |
|---|---|---|
| 0 — Smoke | `audit:build` → `audit:up` → `audit:smoke` | toolchain verified |
| 1 — Static | `audit:slither`, `audit:complexity`, `audit:lint`, `audit:size` | `audit/output/slither/`, console |
| 1 — Symbolic | `audit:mythril` | `audit/output/mythril/` |
| 3/6 — Fuzz | `audit:echidna`, `audit:medusa` | `audit/output/echidna/`, `audit/output/medusa/` |
| Gas | `audit:gas` | `audit/output/gas/gas-report.txt` |
| Coverage | `audit:coverage` | `coverage/`, copy to `audit/output/coverage/` |

`audit:all` runs the full in-container sweep (compile → slither → mythril →
echidna → medusa). Echidna/Medusa are long — for the deep run, set
`ECHIDNA_TEST_LIMIT` to 500000+ and run overnight.

All tool output lands under `audit/output/` (a Docker named volume; gitignored).
Scope exclusions (`audit-exclusion-guidance.md`) are encoded in
`slither.config.json`, `.solhintignore`, and `.solcover.js`.

## Re-pinning the base image

`security/Dockerfile` pins `eth-security-toolbox` by digest for reproducibility.
To refresh:

```bash
docker pull ghcr.io/trailofbits/eth-security-toolbox:nightly
docker inspect --format='{{index .RepoDigests 0}}' \
  ghcr.io/trailofbits/eth-security-toolbox:nightly
# paste the new sha256 digest into security/Dockerfile, then: npm run audit:build
```

## Troubleshooting

- **`npm ci` fails during build** — a native module lacks a Linux prebuilt;
  the Dockerfile already installs `python3-dev make g++`. Re-run `audit:build`.
- **Echidna can't compile the harness** — confirm `npm run audit:compile`
  succeeds first; the harness must compile under `viaIR`.
- **Container missing** — `npm run audit:up` (re-creates it; idempotent).
- **Medusa config schema drift** — regenerate a default with `medusa init` and
  merge the project settings from `medusa.json`.
