#!/bin/bash
set -euo pipefail

REPORT_DIR="security/reports"
SLITHER_REPORT="$REPORT_DIR/slither-report.json"
MYTHRIL_REPORT="$REPORT_DIR/mythril-report.json"

mkdir -p "$REPORT_DIR"
rm -f "$SLITHER_REPORT" "$MYTHRIL_REPORT"

scan_failed=0

run_step() {
    local name="$1"
    shift

    echo "Running ${name}..."
    if ! "$@"; then
        echo "[WARN] ${name} failed; continuing remaining steps."
        scan_failed=1
    fi
}

run_mythril_source() {
    local mythril_solv="${MYTHRIL_SOLV:-0.8.20}"

    mapfile -t myth_sources < <(find contracts -type f -name '*.sol' | sort)
    if [[ "${#myth_sources[@]}" -eq 0 ]]; then
        echo "[WARN] Mythril source analysis found no Solidity files."
        return 1
    fi

    myth analyze "${myth_sources[@]}" --solv "$mythril_solv" -o json > "$MYTHRIL_REPORT"
    if grep -q '"success": false' "$MYTHRIL_REPORT"; then
        return 1
    fi

    return 0
}

run_mythril_bytecode_fallback() {
    local work_dir="/tmp/mythril-bytecode"
    local targets_file="$work_dir/targets.json"
    local results_dir="$work_dir/results"

    rm -rf "$work_dir"
    mkdir -p "$results_dir"

    node <<'EOF' > "$targets_file"
const fs = require("fs");
const path = require("path");

const artifactsRoot = "artifacts/contracts";

function walk(dir) {
    if (!fs.existsSync(dir)) return [];

    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...walk(fullPath));
        } else if (entry.isFile() && entry.name.endsWith(".json") && !entry.name.endsWith(".dbg.json")) {
            out.push(fullPath);
        }
    }

    return out;
}

const targets = [];
for (const artifactPath of walk(artifactsRoot)) {
    try {
        const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
        const sourceName = artifact.sourceName || "";
        const include =
            sourceName === "contracts/Diamond.sol" ||
            sourceName.startsWith("contracts/facets/") ||
            sourceName.startsWith("contracts/upgradeInitializers/");

        if (!include) continue;

        let bytecode = artifact.deployedBytecode || "";
        if (typeof bytecode !== "string") continue;
        if (bytecode.startsWith("0x")) bytecode = bytecode.slice(2);
        if (bytecode.length === 0 || /^0+$/.test(bytecode)) continue;

        targets.push({
            label: `${sourceName}:${artifact.contractName || path.basename(artifactPath, ".json")}`,
            bytecode,
        });
    } catch {
        // Ignore malformed artifacts.
    }
}

process.stdout.write(JSON.stringify(targets));
EOF

    local target_count
    target_count=$(node -e "const fs=require('fs'); const t=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); process.stdout.write(String(t.length));" "$targets_file")

    if [[ "$target_count" -eq 0 ]]; then
        echo "[WARN] Mythril fallback found no deployable Diamond/facet bytecode artifacts."
        return 1
    fi

    local i
    for ((i = 0; i < target_count; i++)); do
        local bytecode_file="$work_dir/target-${i}.bin"
        local result_file="$results_dir/target-${i}.json"

        node -e "const fs=require('fs'); const t=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); fs.writeFileSync(process.argv[2], t[Number(process.argv[3])].bytecode);" "$targets_file" "$bytecode_file" "$i"
        if ! myth analyze -f "$bytecode_file" --bin-runtime -o json > "$result_file"; then
            echo '{"success": false, "issues": [], "error": "myth analyze process failed"}' > "$result_file"
        fi
    done

    node <<'EOF'
const fs = require("fs");
const path = require("path");

const targetsFile = process.env.TARGETS_FILE;
const resultsDir = process.env.RESULTS_DIR;
const reportPath = process.env.REPORT_PATH;

const targets = JSON.parse(fs.readFileSync(targetsFile, "utf8"));
const perTarget = [];
const issues = [];

for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const resultPath = path.join(resultsDir, `target-${i}.json`);

    let result = { success: false, issues: [], error: "missing result" };
    if (fs.existsSync(resultPath)) {
        try {
            result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
        } catch (error) {
            result = { success: false, issues: [], error: String(error) };
        }
    }

    const targetSummary = {
        target: target.label,
        success: result.success === true,
        issueCount: Array.isArray(result.issues) ? result.issues.length : 0,
    };

    if (result.error) {
        targetSummary.error = String(result.error);
    }

    perTarget.push(targetSummary);

    if (Array.isArray(result.issues)) {
        for (const issue of result.issues) {
            issues.push({ target: target.label, ...issue });
        }
    }
}

const successCount = perTarget.filter((item) => item.success).length;
const report = {
    success: successCount > 0,
    mode: "bytecode-fallback",
    attemptedTargets: perTarget.length,
    analyzedTargets: successCount,
    perTarget,
    issues,
};

fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

if (successCount === 0) {
    process.exit(1);
}
EOF
}

echo "Installing project dependencies..."
npm ci --legacy-peer-deps

echo "Compiling contracts..."
npx hardhat compile

run_step "Slither" slither contracts --fail-none --json "$SLITHER_REPORT"

echo "Running Mythril..."
if ! run_mythril_source; then
    echo "[WARN] Mythril source analysis failed; retrying with Diamond/facet runtime bytecode."
    if ! TARGETS_FILE="/tmp/mythril-bytecode/targets.json" RESULTS_DIR="/tmp/mythril-bytecode/results" REPORT_PATH="$MYTHRIL_REPORT" run_mythril_bytecode_fallback; then
        echo "[WARN] Mythril failed; continuing remaining steps."
        scan_failed=1
    fi
fi

if [[ "${RUN_HARDHAT_TESTS:-true}" == "true" ]]; then
    run_step "Hardhat tests" npx hardhat test test/unit test/integration
else
    echo "Skipping Hardhat tests (set RUN_HARDHAT_TESTS=true to enable)."
fi

echo "Running Echidna..."
if [[ "${RUN_ECHIDNA:-true}" == "true" ]]; then
    ECHIDNA_TARGET_FILE="${ECHIDNA_TARGET_FILE:-contracts/Diamond.sol}"
    ECHIDNA_TARGET_CONTRACT="${ECHIDNA_TARGET_CONTRACT:-Diamond}"

    if [[ ! -f "$ECHIDNA_TARGET_FILE" ]]; then
        echo "[WARN] Echidna target file not found: $ECHIDNA_TARGET_FILE"
        scan_failed=1
    elif ! echidna-test "$ECHIDNA_TARGET_FILE" --contract "$ECHIDNA_TARGET_CONTRACT" --config security/echidna.yaml; then
        echo "[WARN] Echidna failed for ${ECHIDNA_TARGET_FILE}:${ECHIDNA_TARGET_CONTRACT}; continuing."
        scan_failed=1
    fi
else
    echo "Skipping Echidna (set RUN_ECHIDNA=true to enable)."
fi

echo "Scan finished"
echo "Reports: $SLITHER_REPORT, $MYTHRIL_REPORT"

if [[ "$scan_failed" -ne 0 ]]; then
    echo "One or more scan steps failed."
    exit 1
fi