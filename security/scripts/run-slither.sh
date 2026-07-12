#!/usr/bin/env bash
# Static analysis — whole-project Slither + printers + ERC conformance.
# Runs INSIDE the container.
set -uo pipefail
cd /src
OUT=audit/output/slither
mkdir -p "$OUT"
CFG="security/slither.config.json"

echo "[slither] whole-project analysis"
slither . --config-file "$CFG" \
  --json "$OUT/slither-report.json" \
  --sarif "$OUT/slither.sarif" \
  2>&1 | tee "$OUT/slither-report.txt" || true

echo "[slither] printers: human-summary, contract-summary, vars-and-auth"
slither . --config-file "$CFG" \
  --print human-summary,contract-summary,vars-and-auth \
  > "$OUT/summary.txt" 2>&1 || true

echo "[slither] printer: variable-order (storage layout / collision evidence)"
slither . --config-file "$CFG" --print variable-order \
  > "$OUT/storage-layout.txt" 2>&1 || true

echo "[slither] ERC1155 conformance check"
slither-check-erc . ERC1155Facet > "$OUT/erc-check.txt" 2>&1 || true

echo "[slither] done -> $OUT"
