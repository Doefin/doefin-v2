#!/usr/bin/env bash
# Phase 0 smoke test — proves the toolchain works before the real audit run.
# Runs INSIDE the container. Tool runs use `|| true`: we only need them to
# execute; finding issues is fine. A failed compile is fatal.
set -uo pipefail
cd /src
fail=0

echo "=================================================================="
echo " Doefin v3 audit toolchain — smoke test"
echo "=================================================================="
echo
echo "--- tool versions ---"
slither --version       || { echo "FAIL: slither";   fail=1; }
myth version            || { echo "FAIL: mythril";   fail=1; }
echidna --version       || { echo "FAIL: echidna";   fail=1; }
medusa --version        || { echo "FAIL: medusa";    fail=1; }
solc-select versions    || { echo "FAIL: solc-select"; fail=1; }
node --version          || { echo "FAIL: node";      fail=1; }
npx hardhat --version   || { echo "FAIL: hardhat";   fail=1; }
echo

echo "--- compile (crytic-compile path: hardhat + solc 0.8.20 + viaIR) ---"
if ! npx hardhat compile; then
  echo "FATAL: project does not compile in-container — fix before proceeding."
  exit 1
fi
echo

echo "--- slither smoke (whole project) ---"
slither . --config-file security/slither.config.json 2>&1 | tail -3 || true
echo

echo "--- mythril smoke (60s budget) ---"
myth analyze contracts/facets/NonceManagerFacet.sol \
  --solc-json security/mythril-remappings.json \
  --solv 0.8.20 --execution-timeout 60 2>&1 | tail -4 || true
echo

echo "--- echidna smoke (harness must deploy the full Diamond) ---"
if [ -f contracts/audit/DoefinInvariantHarness.sol ]; then
  echidna contracts/audit/DoefinInvariantHarness.sol --contract DoefinInvariantHarness \
    --config security/echidna.config.yaml --test-limit 500 2>&1 | tail -8 || true
else
  echo "SKIP: contracts/audit/DoefinInvariantHarness.sol not yet created"
fi
echo

echo "=================================================================="
if [ "$fail" -eq 0 ]; then
  echo " SMOKE TEST PASSED — all tools available, project compiles."
else
  echo " SMOKE TEST FAILED — see FAIL lines above."
  exit 1
fi
echo "=================================================================="
