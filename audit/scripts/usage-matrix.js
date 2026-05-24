#!/usr/bin/env node
/*
 * Layer-3 usage matrix for Doefin v3 — cross-repo grep of every registered
 * Diamond selector against the four caller surfaces:
 *
 *   - backend    (the doefin-backend repo)
 *   - frontend   (the doefin-frontend repo)
 *   - scripts    (this repo's ops/admin/upgrade scripts)
 *   - tests      (this repo's hardhat test suite)
 *
 * The output is the matrix the dead-code findings report uses to classify
 * each external function as: backend / frontend / ops-script / test-only /
 * standard-API / end-user-direct / orphan.
 *
 * Selectors are read from scripts/mergedDiamondABI.json (the materialised
 * deployed surface). Backend/frontend repos are sibling repos and must be
 * passed in (CLI flag or env), since they live outside this repo and the
 * audit Docker container.
 *
 * Usage:
 *   node audit/scripts/usage-matrix.js \
 *        --backend  /path/to/doefin-backend \
 *        --frontend /path/to/doefin-frontend
 *
 *   # Defaults to ../doefin-backend and ../doefin-frontend if the flags are
 *   # omitted and those paths exist.
 *
 * Output: audit/output/deadcode/usage-matrix.{json,md}
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO = path.resolve(__dirname, "../..");
const ABI_PATH = path.join(REPO, "mergedDiamondABI.json");
const OUT_DIR = path.join(REPO, "audit/output/deadcode");

// Selectors that are part of an external *standard*, not Doefin-specific
// surface — keep regardless of integration usage. Diamond loupe, ERC-165,
// ERC-173 ownership, ERC-1155 + receiver are all in this bucket.
const STANDARD_API = new Set([
  // Diamond loupe (EIP-2535)
  "facets", "facetFunctionSelectors", "facetAddresses", "facetAddress",
  "supportsInterface",
  // Ownership (EIP-173)
  "owner", "transferOwnership",
  // Diamond cut (admin-gated but part of EIP-2535)
  "diamondCut",
  // ERC-1155 token standard
  "balanceOf", "balanceOfBatch", "setApprovalForAll", "isApprovedForAll",
  "safeTransferFrom", "safeBatchTransferFrom",
  // ERC-1155 receiver hooks
  "onERC1155Received", "onERC1155BatchReceived",
]);

// Selectors that real end-users call directly (not via the backend match
// engine). These stay alive even if backend/frontend never reference them
// in code — wallets/EOAs call them.
const END_USER_DIRECT = new Set([
  "splitPosition", "mergePositions", "redeemPositions",
  "cancelOrder", "cancelOrders", "cancelOrdersForPosition", "incrementNonce",
]);

function parseArgs(argv) {
  const out = { backend: null, frontend: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--backend") out.backend = argv[++i];
    else if (a === "--frontend") out.frontend = argv[++i];
  }
  out.backend = out.backend || process.env.DOEFIN_BACKEND
    || path.resolve(REPO, "../doefin-backend");
  out.frontend = out.frontend || process.env.DOEFIN_FRONTEND
    || path.resolve(REPO, "../doefin-frontend");
  return out;
}

function uniqueExternalNames(abi) {
  const seen = new Set();
  for (const item of abi) {
    if (item.type !== "function") continue;
    if (item.stateMutability === undefined && item.type === "function") {
      // tolerate legacy entries
    }
    seen.add(item.name);
  }
  return [...seen].sort();
}

// Built-in skip set — heavy noise that swamps the grep on large frontend repos.
const SKIP_DIRS = [
  "node_modules", ".git", ".next", ".turbo", ".svelte-kit",
  "dist", "build", "out", "coverage", ".venv", "venv", "__pycache__",
];

function countMatchesPerName(root, names) {
  // ONE grep per surface (not one per name) — combines all names into a
  // single regex and tallies per name from the output. Cuts the matrix from
  // 320 greps to 4.
  if (!root || !fs.existsSync(root)) {
    return Object.fromEntries(names.map((n) => [n, -1]));
  }
  // grep -oE prints only the matched substring, one per line — we count
  // those. Word boundary + `(` is the callsite-shape filter.
  const pattern = `\\b(${names.join("|")})\\s*\\(`;
  const excludeDirArgs = SKIP_DIRS.flatMap((d) => [`--exclude-dir=${d}`]);
  const args = [
    "-rohE",
    "--include=*.py", "--include=*.ts", "--include=*.tsx",
    "--include=*.js", "--include=*.jsx", "--include=*.json",
    ...excludeDirArgs,
    pattern,
    root,
  ];
  const tally = Object.fromEntries(names.map((n) => [n, 0]));
  try {
    const stdout = execFileSync("grep", args, {
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 128 * 1024 * 1024,
    });
    for (const line of stdout.toString().split("\n")) {
      if (!line) continue;
      // line looks like "name(" — strip the trailing punctuation.
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
      if (m && tally[m[1]] !== undefined) tally[m[1]] += 1;
    }
  } catch (e) {
    if (e.status === 1) return tally; // no matches at all
    // signal failure rather than silent zero
    return Object.fromEntries(names.map((n) => [n, -1]));
  }
  return tally;
}

function classify(rec) {
  if (STANDARD_API.has(rec.name)) return "keep (standard)";
  if (END_USER_DIRECT.has(rec.name)) return "keep (end-user-direct)";
  if (rec.backend > 0) return "keep (backend)";
  if (rec.frontend > 0) return "keep (frontend)";
  if (rec.scripts > 0) return "keep (ops-script)";
  if (rec.tests > 0) return "test-only";
  return "ORPHAN (review)";
}

function main() {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(ABI_PATH)) {
    console.error(`[usage-matrix] missing ${ABI_PATH} — run scripts/mergeDiamondABI.js first`);
    process.exit(1);
  }
  const abi = JSON.parse(fs.readFileSync(ABI_PATH, "utf8"));
  const names = uniqueExternalNames(abi);
  console.log(`[usage-matrix] ${names.length} unique external selectors`);
  console.log(`[usage-matrix] backend  : ${args.backend}` +
    (fs.existsSync(args.backend) ? "" : "  (NOT FOUND)"));
  console.log(`[usage-matrix] frontend : ${args.frontend}` +
    (fs.existsSync(args.frontend) ? "" : "  (NOT FOUND)"));

  const backendCounts  = countMatchesPerName(args.backend,            names);
  const frontendCounts = countMatchesPerName(args.frontend,           names);
  const scriptCounts   = countMatchesPerName(path.join(REPO, "scripts"), names);
  const testCounts     = countMatchesPerName(path.join(REPO, "test"),    names);

  const records = names.map((name) => {
    const rec = {
      name,
      backend:  backendCounts[name],
      frontend: frontendCounts[name],
      scripts:  scriptCounts[name],
      tests:    testCounts[name],
    };
    rec.disposition = classify(rec);
    return rec;
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, "usage-matrix.json"),
    JSON.stringify({ generated: new Date().toISOString(), records }, null, 2),
  );

  const md = [];
  md.push("# Doefin v3 — Selector Usage Matrix (Layer 3)");
  md.push("");
  md.push(`Generated: ${new Date().toISOString()}`);
  md.push(`Backend repo: \`${args.backend}\`` +
    (fs.existsSync(args.backend) ? "" : "  **(NOT FOUND — backend column unreliable)**"));
  md.push(`Frontend repo: \`${args.frontend}\`` +
    (fs.existsSync(args.frontend) ? "" : "  **(NOT FOUND — frontend column unreliable)**"));
  md.push("");
  md.push("Counts are `grep -E '\\bname\\s*\\('` matches across `*.py *.ts *.tsx *.js *.jsx *.json`.");
  md.push("`-1` means the target path was not found. Permissive by design —");
  md.push("false positives are reviewed during triage.");
  md.push("");
  md.push("| Selector | backend | frontend | scripts | tests | Disposition |");
  md.push("|---|---:|---:|---:|---:|---|");
  for (const r of records) {
    md.push(`| \`${r.name}\` | ${r.backend} | ${r.frontend} | ${r.scripts} | ${r.tests} | ${r.disposition} |`);
  }
  const orphans = records.filter((r) => r.disposition.startsWith("ORPHAN"));
  const testOnly = records.filter((r) => r.disposition === "test-only");
  md.push("");
  md.push("## Summary");
  md.push("");
  md.push(`- ORPHAN (review): **${orphans.length}**`);
  md.push(`- test-only:      **${testOnly.length}**`);
  md.push(`- kept (any reason): **${records.length - orphans.length - testOnly.length}**`);
  if (orphans.length) {
    md.push("");
    md.push("### Orphan shortlist");
    md.push("");
    for (const r of orphans) md.push(`- \`${r.name}\``);
  }
  if (testOnly.length) {
    md.push("");
    md.push("### Test-only");
    md.push("");
    for (const r of testOnly) md.push(`- \`${r.name}\``);
  }
  fs.writeFileSync(path.join(OUT_DIR, "usage-matrix.md"), md.join("\n") + "\n");

  console.log(
    `[usage-matrix] orphan: ${orphans.length}  test-only: ${testOnly.length}  ` +
    `kept: ${records.length - orphans.length - testOnly.length}`,
  );
  console.log(`[usage-matrix] wrote ${OUT_DIR}/usage-matrix.{json,md}`);
}

main();
