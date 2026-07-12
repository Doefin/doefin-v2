#!/usr/bin/env bash
# Symbolic execution — Mythril, per in-scope facet. Runs INSIDE the container.
# Mythril is slow; each facet gets a bounded execution timeout.
set -uo pipefail
cd /src
OUT=audit/output/mythril
mkdir -p "$OUT"
TIMEOUT="${MYTHRIL_TIMEOUT:-900}"

FACETS="SettlementFacet SignatureVerifierFacet NonceManagerFacet"
for f in $FACETS; do
  echo "[mythril] analyzing $f (execution-timeout ${TIMEOUT}s)"
  myth analyze "contracts/facets/$f.sol" \
    --solc-json security/mythril-remappings.json \
    --solv 0.8.20 \
    -o markdown \
    --execution-timeout "$TIMEOUT" \
    --max-depth 64 \
    > "$OUT/$f.md" 2>&1 || true
done
echo "[mythril] done -> $OUT"
