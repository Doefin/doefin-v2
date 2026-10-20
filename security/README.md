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

## Fuzz harnesses

`audit:echidna` / `audit:medusa` fuzz every harness in turn (select a subset with
`ECHIDNA_HARNESSES` / `MEDUSA_HARNESSES`, space-separated):

| Harness | Target | Config (Echidna / Medusa) | Log |
|---|---|---|---|
| `DoefinInvariantHarness` | settlement / CTF Diamond | `echidna.config.yaml` / `medusa.json` | `echidna-run.txt` / `medusa-run.txt` |
| `OracleInvariantHarness` | Bitcoin block-header oracle (SCRUM-521-AUDIT-SCOPE) | `echidna.oracle.config.yaml` / `medusa.oracle.json` | `echidna-oracle-run.txt` / `medusa-oracle-run.txt` |

**Oracle harness.** Submission is permissionless but headers must carry real proof of
work, so `OracleInvariantHarness` only ever submits real Bitcoin headers — two real forks
from `test/data/` (967110–967160 + the orphan 967143 that froze mainnet, SEC-015; and
935468–935503 + the orphan 935497) encoded into `contracts/audit/OracleHeaderFixtures.sol`
by `node security/scripts/gen-oracle-fixtures.js`. The fuzzer chooses the *shape*: single
headers, slices starting anywhere, replays at every depth and ring position, orphan
branches, caller-supplied `blockNumber`/`blockHash` junk, tampered consensus fields, empty
batches, re-initialisation, and re-deployment with a different init window (moves the
orphan through all 17 ring slots). A reference model derives from the spec whether each
submission must be accepted; properties check liveness, safety, post-conditions, ring-buffer
structure and that no non-empty submission ever Panics.

- **Expected result:** every `echidna_*` property passes on the production facet. Any failure,
  including `echidna_empty_batch_no_panic` (ORC-011: `submitBatchBlocks([])` must revert
  `BlockHeaderOracle_EmptyBatch`), is a regression. The empty-batch property is tracked separately
  so it cannot mask a new panic.
- **Negative control:** `ORACLE_NEGATIVE_CONTROL=1 npm run audit:echidna` (or `audit:medusa`)
  also fuzzes `OracleInvariantHarnessPreFix` — the same harness on a verbatim copy of the
  pre-SCRUM-521 facet. It **must fail** `echidna_no_panic_nonempty` (SEC-015, `Panic(0x11)`);
  if it does not, the harness has lost its teeth.
- **Library linking:** the oracle facet links the external `BlockHeaderUtils` library. The
  oracle configs link it to `0xb10c` via crytic-compile `--compile-libraries` and predeploy it
  there (`deployContracts` / `predeployedContracts`). The harness never calls into the library,
  so only the link itself is load-bearing.
- **Validated without Docker** by `npx hardhat test test/audit/OracleInvariantHarness.test.js`
  (deterministic sequences, 17-slot and pointer×depth matrices, seeded random walks, and the
  negative control).

**Settlement / CTF harness.** `DoefinInvariantHarness` also fuzzes splits and merges of any
partition shape — canonical, reordered, grouped, partial; at the root or nested; amount 0
included — on an unseeded 3-outcome condition (SCRUM-214, `audit/findings/ctf-review.md`).
`echidna_registry_canonical` checks INV-CTF-2 (every registered market is a root market whose
partitions are the ascending singletons covering every outcome, with root position IDs that map
back to the condition) and `echidna_diamond_holds_no_positions` that settlement never leaves
outcome tokens in the Diamond. The trade actions settle only the seeded binary market, so the
insolvency a partial registration leads to (CTF-001) is covered by
`test/audit/CTF-001-003-market-registry.test.js`, not by fuzzing.

- **Expected result:** every property passes.
- **Negative control (manual):** build the harness against the contracts from before the CTF
  fixes — e.g. `git archive 3c78b6f contracts | tar -x -C <dir>`, copy
  `contracts/audit/DoefinInvariantHarness.sol` from HEAD into it, and fuzz that tree (mount it in
  a one-off `docker compose run` of the audit service). It **must fail**
  `echidna_registry_canonical`. To show the completeness clause specifically, pin `_shape` to
  index 4 (the partial `[1, 2]` on the 3-outcome condition) and `nested` to false in the scratch
  copy: the property must still fail.

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
