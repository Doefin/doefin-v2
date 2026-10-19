#!/usr/bin/env bash
# Property fuzzing — Echidna against the invariant harnesses. Runs INSIDE the
# container. Override depth with ECHIDNA_TEST_LIMIT (500000+ for deep runs).
#
#   ECHIDNA_HARNESSES        space-separated subset to run (default: all below)
#     DoefinInvariantHarness   settlement / CTF Diamond      security/echidna.config.yaml
#     OracleInvariantHarness   block-header oracle (SCRUM-521-AUDIT-SCOPE)
#                                                          security/echidna.oracle.config.yaml
#   ORACLE_NEGATIVE_CONTROL=1  also fuzz OracleInvariantHarnessPreFix — the oracle
#                              harness on the pre-SCRUM-521 facet. It MUST FAIL
#                              echidna_no_panic_nonempty (SEC-015): proof the harness bites.
#
# Expected oracle result: all properties pass except echidna_empty_batch_no_panic
# (known open issue: submitBatchBlocks([]) reverts Panic(0x11)).
set -uo pipefail
cd /src
OUT=audit/output/echidna
mkdir -p "$OUT"
LIMIT="${ECHIDNA_TEST_LIMIT:-50000}"
HARNESSES="${ECHIDNA_HARNESSES:-DoefinInvariantHarness OracleInvariantHarness}"
if [ "${ORACLE_NEGATIVE_CONTROL:-0}" = "1" ]; then
  HARNESSES="$HARNESSES OracleInvariantHarnessPreFix"
fi

run_harness() {
  local name="$1" config log
  local extra=()
  case "$name" in
    DoefinInvariantHarness)
      config=security/echidna.config.yaml
      log="$OUT/echidna-run.txt" ;;
    OracleInvariantHarness)
      config=security/echidna.oracle.config.yaml
      log="$OUT/echidna-oracle-run.txt" ;;
    OracleInvariantHarnessPreFix)
      config=security/echidna.oracle.config.yaml
      log="$OUT/echidna-oracle-prefix-run.txt"
      extra=(--corpus-dir "$OUT/corpus-oracle-prefix") ;;
    *)
      echo "[echidna] ERROR: unknown harness '$name'"
      return 1 ;;
  esac

  local src="contracts/audit/$name.sol"
  if [ ! -f "$src" ]; then
    echo "[echidna] ERROR: $src missing"
    return 1
  fi

  echo "[echidna] fuzzing $name (testLimit=$LIMIT)"
  echidna "$src" --contract "$name" \
    --config "$config" \
    --test-limit "$LIMIT" \
    ${extra[@]+"${extra[@]}"} \
    2>&1 | tee "$log" || true
}

status=0
for harness in $HARNESSES; do
  run_harness "$harness" || status=1
done
echo "[echidna] done -> $OUT"
exit "$status"
