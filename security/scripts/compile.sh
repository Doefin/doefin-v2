#!/usr/bin/env bash
# Compile the project inside the container (run once before slither/echidna).
set -euo pipefail
cd /src
npx hardhat compile
echo "[compile] artifacts/build-info ready for crytic-compile"
