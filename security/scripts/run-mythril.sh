#!/usr/bin/env bash
# Symbolic execution — Mythril, per in-scope facet. Runs INSIDE the container.
# Mythril is slow; each facet gets a bounded execution timeout.
set -uo pipefail
cd /src
OUT=audit/output/mythril
mkdir -p "$OUT"
TIMEOUT="${MYTHRIL_TIMEOUT:-900}"

# <file>:<contract> — the contract is named explicitly because a file name need not match
# its contract (DoefinV1BlockHeaderOracleFacet.sol declares DoefinV1BlockHeaderOracle).
TARGETS="SettlementFacet:SettlementFacet
SignatureVerifierFacet:SignatureVerifierFacet
NonceManagerFacet:NonceManagerFacet
DoefinV1BlockHeaderOracleFacet:DoefinV1BlockHeaderOracle
ConditionManagerFacet:ConditionManagerFacet"
for t in $TARGETS; do
  f="${t%%:*}"
  c="${t##*:}"
  echo "[mythril] analyzing $f:$c (execution-timeout ${TIMEOUT}s)"
  myth analyze "contracts/facets/$f.sol:$c" \
    --solc-json security/mythril-remappings.json \
    --solv 0.8.20 \
    -o markdown \
    --execution-timeout "$TIMEOUT" \
    --max-depth 64 \
    > "$OUT/$f.md" 2>&1 || true
done
echo "[mythril] done -> $OUT"
