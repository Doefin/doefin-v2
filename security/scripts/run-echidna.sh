#!/usr/bin/env bash
# Property fuzzing — Echidna against the invariant harness. Runs INSIDE the
# container. Override depth with ECHIDNA_TEST_LIMIT (500000+ for deep runs).
set -uo pipefail
cd /src
OUT=audit/output/echidna
mkdir -p "$OUT"
LIMIT="${ECHIDNA_TEST_LIMIT:-50000}"

if [ ! -f contracts/audit/DoefinInvariantHarness.sol ]; then
  echo "[echidna] ERROR: contracts/audit/DoefinInvariantHarness.sol missing"
  exit 1
fi

echo "[echidna] fuzzing DoefinInvariantHarness (testLimit=$LIMIT)"
echidna contracts/audit/DoefinInvariantHarness.sol --contract DoefinInvariantHarness \
  --config security/echidna.config.yaml \
  --test-limit "$LIMIT" \
  2>&1 | tee "$OUT/echidna-run.txt" || true
echo "[echidna] done -> $OUT"
