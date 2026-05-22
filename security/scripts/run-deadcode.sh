#!/usr/bin/env bash
# Layer-1 + Layer-2 dead-code sweep for Doefin v3.
#
#  Layer 1: Slither's own dead-code/unused-state/unused-return detectors,
#           run with the *unfiltered* dead-code config so all libraries are
#           analysed (the security/slither.config.json filter_paths hides
#           half of them).
#  Layer 2: call-graph reachability from the deployed selector set —
#           catches transitive dead code that Slither's detector misses.
#
# Designed to mirror security/scripts/run-slither.sh and run either inside the
# audit Docker container or on a host with Slither + solc installed.
#
# Outputs land in audit/output/deadcode/ and are picked up by the eventual
# audit/findings/dead-code-findings.md report.
#
# Invoked by `npm run audit:deadcode`.
set -uo pipefail
cd "$(dirname "$0")/../.."

OUT=audit/output/deadcode
CFG=security/slither-deadcode.config.json
mkdir -p "$OUT"

echo "[deadcode] Layer 1 — Slither dead-code / unused-state / unused-return (unfiltered)"
slither . --config-file "$CFG" \
  --detect dead-code,unused-state,unused-return \
  --json "$OUT/slither-deadcode.json" \
  2>&1 | tee "$OUT/slither-deadcode.txt" || true

echo
echo "[deadcode] Layer 2 — call-graph reachability from the deploy.js root set"
python3 security/scripts/deadcode-reachability.py . \
  > "$OUT/reachability-run.log" 2>&1
tail -n +1 "$OUT/reachability.txt"

echo
echo "[deadcode] done — see $OUT/"
echo "  slither-deadcode.{txt,json}  : Layer 1 raw detector output"
echo "  reachability.{txt,json}      : Layer 2 closure + Category A candidates"
echo
echo "Next: run \`node audit/scripts/usage-matrix.js\` (Layer 3) and"
echo "      \`npx hardhat coverage\`           (Layer 4) for full triage."
