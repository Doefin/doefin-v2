#!/usr/bin/env python3
"""
Layer-2 dead-code detector for Doefin v3 — call-graph reachability analysis.

Builds the full internal call graph with the Slither API, seeds it with the
*live-root set* (the external/public functions of the deployed facets, the
Diamond proxy, and DiamondInit), computes the transitive closure, and reports
every function NOT reachable from a root.

Why this exists — it catches what the two cheap methods cannot:
  * reference-counting ("grep the name, >=1 hit -> alive") misses *transitive*
    dead code: a function whose only caller is itself dead.
  * Slither's `dead-code` detector treats every external/public function as a
    live root, so it never flags an orphaned facet entry point, nor a library
    function kept alive only through one.

Here the root set is the deployed selector set, so both fall out.

Output: audit/output/deadcode/reachability.{json,txt}

Usage:  python3 security/scripts/deadcode-reachability.py [project_dir]
"""
import json
import os
import re
import sys
from collections import defaultdict

from slither import Slither
from slither.core.declarations import Function
from slither.slithir.operations import (
    HighLevelCall,
    InternalCall,
    InternalDynamicCall,
    LibraryCall,
)

PROJECT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else ".")
OUT_DIR = os.path.join(PROJECT, "audit", "output", "deadcode")

# Source subtrees that are test scaffolding — never live roots, never reported.
EXCLUDE_PREFIXES = ("contracts/mock/", "contracts/audit/")
# Deployed alongside the facets but not in the deploy.js FacetNames array.
EXTRA_ROOT_CONTRACTS = {"Diamond", "DiamondInit", "DiamondCutFacet"}
# Sentinels for the built-in soundness self-check (must come out *reachable*).
SOUNDNESS_LIVE = ("registerPositionPairs", "validatePositionId")


def src_path(obj):
    """Best-effort source file of a Slither declaration, as a posix-ish path."""
    try:
        fn = obj.source_mapping.filename
        return (fn.relative or fn.used or fn.absolute).replace("\\", "/")
    except Exception:  # noqa: BLE001
        return "?"


def first_line(obj):
    try:
        return obj.source_mapping.lines[0]
    except Exception:  # noqa: BLE001
        return 0


def in_scope(path):
    """A project contract we want in the graph (not deps, not scaffolding)."""
    if "node_modules" in path or not path.startswith("contracts/"):
        return False
    return not any(path.startswith(p) for p in EXCLUDE_PREFIXES)


def parse_facet_names(project):
    """Extract the FacetNames array from scripts/deploy.js — the deploy roots."""
    deploy = os.path.join(project, "scripts", "deploy.js")
    names = set()
    if os.path.isfile(deploy):
        src = open(deploy, encoding="utf-8").read()
        m = re.search(r"FacetNames\s*=\s*\[(.*?)\]", src, re.S)
        if m:
            names.update(re.findall(r'["\']([A-Za-z0-9_]+)["\']', m.group(1)))
    return names


def callees(func):
    """Resolved internal/library/self callees of a function or modifier."""
    out, dynamic = set(), 0
    # Applied modifiers run as part of the function — treat as edges.
    for mod in getattr(func, "modifiers", []) or []:
        if isinstance(mod, Function):
            out.add(mod.canonical_name)
    for node in func.nodes:
        for ir in node.irs:
            if isinstance(ir, InternalDynamicCall):
                dynamic += 1
                continue
            if isinstance(ir, (InternalCall, LibraryCall, HighLevelCall)):
                callee = getattr(ir, "function", None)
                if isinstance(callee, Function):
                    out.add(callee.canonical_name)
    return out, dynamic


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    facet_names = parse_facet_names(PROJECT)
    print(f"[reachability] project: {PROJECT}")
    print(f"[reachability] deploy.js FacetNames ({len(facet_names)}): "
          f"{', '.join(sorted(facet_names)) or '<none parsed>'}")

    slither = Slither(PROJECT)

    universe = {}          # canonical_name -> record
    graph = defaultdict(set)
    roots = set()
    dynamic_total = 0
    facet_files = set()

    for contract in slither.contracts:
        path = src_path(contract)
        if not in_scope(path):
            continue
        if path.startswith("contracts/facets/"):
            facet_files.add(contract.name)
        is_root_contract = (
            contract.name in facet_names or contract.name in EXTRA_ROOT_CONTRACTS
        )
        for func in list(contract.functions_declared) + list(contract.modifiers_declared):
            key = func.canonical_name
            kind = "modifier" if func in contract.modifiers_declared else "function"
            universe[key] = {
                "name": func.full_name,
                "canonical": key,
                "contract": contract.name,
                "file": src_path(func),
                "line": first_line(func),
                "visibility": func.visibility,
                "kind": kind,
                "implemented": func.is_implemented,
                "constructor": func.is_constructor,
                "entrypoint": func.is_fallback or func.is_receive,
            }
            edges, dyn = callees(func)
            graph[key] |= edges
            dynamic_total += dyn
            exposed = (
                func.visibility in ("public", "external")
                or func.is_constructor
                or func.is_fallback
                or func.is_receive
            )
            if is_root_contract and exposed and kind == "function":
                roots.add(key)

    # Transitive closure from the live-root set.
    reached, stack = set(roots), list(roots)
    while stack:
        cur = stack.pop()
        for nxt in graph.get(cur, ()):
            if nxt not in reached:
                reached.add(nxt)
                stack.append(nxt)

    # A facet contract present in source but missing from deploy.js is itself
    # a dead-code signal — every selector it exposes would be undeployed.
    undeployed_facets = sorted(facet_files - facet_names - EXTRA_ROOT_CONTRACTS)

    unreached = []
    for key, rec in universe.items():
        if key in reached or key in roots:
            continue
        if not rec["implemented"] or rec["constructor"] or rec["entrypoint"]:
            continue
        unreached.append(rec)
    unreached.sort(key=lambda r: (r["file"], r["line"]))

    by_file = defaultdict(list)
    for rec in unreached:
        by_file[rec["file"]].append(rec)

    soundness = {
        name: any(name in k and k in reached for k in universe)
        for name in SOUNDNESS_LIVE
    }

    result = {
        "project": PROJECT,
        "totals": {
            "functions_in_universe": len(universe),
            "live_roots": len(roots),
            "reachable": len(reached),
            "unreachable_dead": len(unreached),
            "unresolved_dynamic_calls": dynamic_total,
        },
        "undeployed_facets": undeployed_facets,
        "soundness_check": soundness,
        "roots": sorted(roots),
        "dead_functions": unreached,
    }
    with open(os.path.join(OUT_DIR, "reachability.json"), "w", encoding="utf-8") as fh:
        json.dump(result, fh, indent=2)

    lines = []
    lines.append("Doefin v3 — call-graph reachability (Layer 2 dead-code)")
    lines.append("=" * 60)
    lines.append(f"functions in universe : {len(universe)}")
    lines.append(f"live roots            : {len(roots)}")
    lines.append(f"reachable             : {len(reached)}")
    lines.append(f"UNREACHABLE (dead)    : {len(unreached)}")
    lines.append(f"unresolved dyn. calls : {dynamic_total}"
                 + ("  <-- closure may under-report, review" if dynamic_total else ""))
    lines.append("")
    lines.append("soundness check (these must be reachable):")
    for name, ok in soundness.items():
        lines.append(f"  [{'PASS' if ok else 'FAIL'}] {name}")
    if undeployed_facets:
        lines.append("")
        lines.append("facet contracts NOT in deploy.js FacetNames:")
        for name in undeployed_facets:
            lines.append(f"  - {name}")
    lines.append("")
    lines.append("unreachable functions (Category A candidates):")
    if not unreached:
        lines.append("  <none>")
    for path in sorted(by_file):
        lines.append(f"\n  {path}")
        for rec in by_file[path]:
            lines.append(f"    L{rec['line']:<5} {rec['kind']:9} "
                         f"{rec['visibility']:9} {rec['contract']}.{rec['name']}")
    txt = "\n".join(lines) + "\n"
    with open(os.path.join(OUT_DIR, "reachability.txt"), "w", encoding="utf-8") as fh:
        fh.write(txt)

    print(txt)
    print(f"[reachability] wrote {OUT_DIR}/reachability.{{json,txt}}")
    if not all(soundness.values()):
        print("[reachability] WARNING: soundness check failed — the call graph "
              "is missing edges; treat the dead list as unreliable.", file=sys.stderr)


if __name__ == "__main__":
    main()
