#!/usr/bin/env bash
# Property fuzzing — Medusa against the same invariant harness (cross-checks
# Echidna). Runs INSIDE the container.
set -uo pipefail
cd /src
OUT=audit/output/medusa
mkdir -p "$OUT"

if [ ! -f contracts/audit/DoefinInvariantHarness.sol ]; then
  echo "[medusa] ERROR: contracts/audit/DoefinInvariantHarness.sol missing"
  exit 1
fi

echo "[medusa] fuzzing DoefinInvariantHarness"
medusa fuzz --config security/medusa.json \
  2>&1 | tee "$OUT/medusa-run.txt" || true
echo "[medusa] done -> $OUT"
