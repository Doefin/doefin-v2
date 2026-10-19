#!/usr/bin/env bash
# Property fuzzing — Medusa against the same invariant harnesses (cross-checks
# Echidna). Runs INSIDE the container.
#
#   MEDUSA_HARNESSES         space-separated subset to run (default: all below)
#     DoefinInvariantHarness   settlement / CTF Diamond      security/medusa.json
#     OracleInvariantHarness   block-header oracle (SCRUM-521-AUDIT-SCOPE)
#                                                          security/medusa.oracle.json
#   ORACLE_NEGATIVE_CONTROL=1  also fuzz OracleInvariantHarnessPreFix (pre-SCRUM-521
#                              facet); it MUST FAIL echidna_no_panic_nonempty (SEC-015).
#
# medusa.oracle.json links the BlockHeaderUtils library placeholder with crytic-compile
# `--compile-libraries (BlockHeaderUtils,0xb10c)` and predeploys the library there
# (`predeployedContracts`). The harness never calls into the library, so only the link
# is load-bearing. Its transactionGasLimit is 16M (not 12.5M): the harness constructor
# deploys the fixtures, the facet and two initialised oracles (~13.8M gas).
set -uo pipefail
cd /src
OUT=audit/output/medusa
mkdir -p "$OUT"
HARNESSES="${MEDUSA_HARNESSES:-DoefinInvariantHarness OracleInvariantHarness}"
if [ "${ORACLE_NEGATIVE_CONTROL:-0}" = "1" ]; then
  HARNESSES="$HARNESSES OracleInvariantHarnessPreFix"
fi

run_harness() {
  local name="$1" config log
  case "$name" in
    DoefinInvariantHarness)
      config=security/medusa.json
      log="$OUT/medusa-run.txt" ;;
    OracleInvariantHarness)
      config=security/medusa.oracle.json
      log="$OUT/medusa-oracle-run.txt" ;;
    OracleInvariantHarnessPreFix)
      # Same config, retargeted: file, contract name and corpus directory all embed the name.
      config="$OUT/medusa.oracle-prefix.json"
      sed 's/OracleInvariantHarness/OracleInvariantHarnessPreFix/g' security/medusa.oracle.json > "$config"
      log="$OUT/medusa-oracle-prefix-run.txt" ;;
    *)
      echo "[medusa] ERROR: unknown harness '$name'"
      return 1 ;;
  esac

  if [ ! -f "contracts/audit/$name.sol" ]; then
    echo "[medusa] ERROR: contracts/audit/$name.sol missing"
    return 1
  fi

  echo "[medusa] fuzzing $name"
  medusa fuzz --config "$config" \
    2>&1 | tee "$log" || true
}

status=0
for harness in $HARNESSES; do
  run_harness "$harness" || status=1
done
echo "[medusa] done -> $OUT"
exit "$status"
