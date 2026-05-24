#!/usr/bin/env bash
# Full in-container tool sweep — compile, Slither, Mythril, Echidna, Medusa.
# Runs INSIDE the container. Host-side phases (gas / coverage / size) are run
# separately on the host — see security/README.md.
set -uo pipefail
cd /src

echo "########## 1/5 compile ##########"
bash security/scripts/compile.sh
echo "########## 2/5 slither ##########"
bash security/scripts/run-slither.sh
echo "########## 3/5 mythril ##########"
bash security/scripts/run-mythril.sh
echo "########## 4/5 echidna ##########"
bash security/scripts/run-echidna.sh
echo "########## 5/5 medusa ##########"
bash security/scripts/run-medusa.sh
echo "########## tool sweep complete -> audit/output/ ##########"
