/* global ethers */
/* eslint prefer-const: "off" */
/**
 * SCRUM-560 — roll the SCRUM-559 market-order cut back: a plain Replace of the facet's three selectors
 * to the facet in an upgrade record's previousRouting. No _init. The storage stays as it is, so fills
 * and accrued fees are kept.
 *
 * ORDER MATTERS. BEFORE RUNNING THIS:
 *   1. Switch MARKET_ORDERS_ENABLED off on the API and the match engine (MarketOrdersEnabled in
 *      cloudformation-templates environments/ApiServiceEcsConfig-<account>.json and
 *      MatchEngineServiceConfig-<account>.json). The API then refuses new market orders.
 *   2. Wait out expiry plus a margin: MARKET_ORDER_TTL_SECONDS (default 60 s) plus 5 minutes, counted
 *      from when the last API task with the switch on stopped.
 *   3. Close every marked order the previous facet could still settle. This query must return no
 *      rows. It covers every open status, not only Working (6), and expiry 0, which never expires:
 *      until the API's marker check is deployed, today's API accepts a marked salt on a limit order at
 *      any expiry. Cancel each row it returns through the API, so the match engine never offers it.
 *
 *        SELECT i.order_hash, i.maker, s.status, i.expiration
 *          FROM order_intents i JOIN order_states s ON s.order_hash = i.order_hash
 *         WHERE s.status IN (0, 1, 6)                                          -- Open, PartiallyFilled, Working
 *           AND mod(div(i.salt::numeric, 4294967296), 4294967296) = 4018539566  -- marker 0xef860c2e
 *           AND (i.expiration = 0 OR i.expiration > extract(epoch FROM now()));
 *
 *   4. Only then run this script.
 *
 * Why: the previous facet has no market-order check. A marked order it can still settle pays fees on
 * top of its signed all-in price (signed 400000, charged 401600) instead of reverting. Reversing this
 * order overcharges market orders still in flight. Past its expiry, a marked order reverts
 * OrderCancelled on either facet, which is what the wait relies on; a marked order at expiry 0 never
 * gets there, which is why step 3 closes it instead. The rehearsal proves all three.
 *
 * Pre-flight, with nothing sent until all of it passes: the switch-off confirmed, no Base mainnet,
 * the record is for this network and Diamond, previousRouting is exactly the cut's three selectors on
 * one facet that has code, and those selectors still route to the record's facet (anything else means
 * already rolled back, or a newer cut that this record must not undo).
 *
 * Route as in upgrade-scrum559-market-orders.js. On a real run it writes
 * deployments/<network>/scrum559-rollback-<timestamp>.json as soon as the cut is mined.
 *
 * Env:
 *   ROLLBACK_RECORD                  path of the upgrade record to roll back
 *   MARKET_ORDERS_OFF_CONFIRMED=true you have done steps 1 and 2 above
 *   BASE_SEPOLIA_RPC_ENDPOINT, SAFE_ADDRESS, PRIVATE_KEY, DRY_RUN=true
 *
 * Usage:
 *   ROLLBACK_RECORD=deployments/baseSepolia/scrum559-market-orders-<timestamp>.json \
 *   MARKET_ORDERS_OFF_CONFIRMED=true npm run upgrade:scrum559:rollback:baseSepolia
 *
 * Afterwards confirm the routing, and leave the switch off:
 *   cast call 0x2f03d47520fb8bc8aDAab392BF280D99De7cAe3f "facetAddress(bytes4)(address)" 0xe81d20c4 \
 *     --rpc-url https://base-sepolia-rpc.publicnode.com
 */

const fs = require("fs");
const path = require("path");
const { networkConfig } = require("./upgrade-scrum521-oracle-reorg-underflow.js");
const {
  CUT_SELECTORS,
  FacetCutAction,
  refuseMainnet,
  resolveTarget,
  gitProvenance,
  chooseRoute,
  sendCut,
  pollUntil,
  readRouting,
  routingDiff,
  readState,
  compareStateAroundCut,
  writeRecord,
} = require("./upgrade-scrum559-market-orders.js");

const MIN_DEPLOYER_BALANCE = ethers.utils.parseEther("0.0002"); // the Safe execution only, nothing is deployed
const WARNING_PAUSE_MS = 10000;

function printOrderWarning() {
  console.log("==========================================================");
  console.log("  ORDER MATTERS. Before this rollback:");
  console.log("    1. MARKET_ORDERS_ENABLED must be switched off on the API and the match engine.");
  console.log("    2. Expiry plus a margin must have passed since then: MARKET_ORDER_TTL_SECONDS");
  console.log("       (default 60 s) plus 5 minutes.");
  console.log("    3. No marked order the previous facet could settle may stay open: in any open status,");
  console.log("       including expiry 0, which never expires (the query is in this script's header).");
  console.log("  The previous facet has no market-order check. Reversing this order overcharges");
  console.log("  market orders still in flight (signed 400000, charged 401600).");
  console.log("==========================================================");
}

/** The one facet a record's previousRouting points the cut's selectors back to, or a refusal. */
function rollbackTarget(rec) {
  const selectors = Object.keys(rec.previousRouting || {}).map((s) => s.toLowerCase()).sort();
  const expected = Object.values(CUT_SELECTORS).sort();
  if (selectors.join() !== expected.join()) throw new Error(`The record's previousRouting has [${selectors.join(", ")}], expected this cut's [${expected.join(", ")}]`);
  const targets = [...new Set(Object.values(rec.previousRouting).map((a) => a.toLowerCase()))];
  if (targets.length !== 1) throw new Error(`The record's previousRouting points at ${targets.length} facets, expected one: ${targets.join(", ")}`);
  if (targets[0] === ethers.constants.AddressZero) throw new Error("The record's previousRouting is the zero address, but this cut was Replace-only");
  return { selectors, target: targets[0] };
}

/**
 * @param {object} opts
 * @param {string}  [opts.recordFile]          default: ROLLBACK_RECORD
 * @param {boolean} [opts.switchOffConfirmed]  default: MARKET_ORDERS_OFF_CONFIRMED=true
 * @param {boolean} [opts.dryRun]
 * @param {string}  [opts.recordDir]           rehearsal only, as in runUpgrade
 * @param {object}  [opts.safeClient]          rehearsal only, as in runUpgrade
 */
async function runRollback(opts = {}) {
  const cfg = networkConfig();
  refuseMainnet({ name: cfg.name });
  printOrderWarning();
  const dryRun = opts.dryRun ?? process.env.DRY_RUN === "true";
  const record = Boolean(opts.recordDir) || !cfg.local;

  if (!(opts.switchOffConfirmed ?? process.env.MARKET_ORDERS_OFF_CONFIRMED === "true")) {
    throw new Error("Refusing until MARKET_ORDERS_OFF_CONFIRMED=true: switch MARKET_ORDERS_ENABLED off and wait out expiry plus a margin first, as above.");
  }
  const recordFile = opts.recordFile || process.env.ROLLBACK_RECORD;
  if (!recordFile) throw new Error("Set ROLLBACK_RECORD to the upgrade record, deployments/<network>/scrum559-market-orders-<timestamp>.json");
  const rec = JSON.parse(fs.readFileSync(recordFile, "utf8"));
  if (rec.contractChange !== "SCRUM-559") throw new Error(`${recordFile} is not a SCRUM-559 upgrade record`);

  const { chainId, diamond } = await resolveTarget({ diamond: rec.diamond });
  if (rec.network !== cfg.name || Number(rec.chainId) !== chainId) {
    throw new Error(`The record is for ${rec.network} (chainId ${rec.chainId}), this run is on ${cfg.name} (chainId ${chainId})`);
  }
  const { selectors, target } = rollbackTarget(rec);
  const facetToRetire = rec.facets.settlement.toLowerCase();

  const [deployer] = await ethers.getSigners();
  const ownership = await ethers.getContractAt("OwnershipFacet", diamond);
  const loupe = await ethers.getContractAt("IDiamondLoupe", diamond);
  const diamondCut = await ethers.getContractAt("IDiamondCut", diamond);
  const owner = await ownership.owner();
  const provenance = gitProvenance();

  const routingBefore = await readRouting(loupe);
  const wrong = selectors.filter((s) => routingBefore[s] !== facetToRetire);
  if (wrong.length) {
    throw new Error(`${wrong.map((s) => `${s} routes to ${routingBefore[s] || "nothing"}`).join(", ")}, not the record's facet ${facetToRetire}: already rolled back, or a newer cut this record must not undo.`);
  }
  if ((await ethers.provider.getCode(target)) === "0x") throw new Error(`No bytecode at the previous facet ${target}`);
  const stateBefore = await readState(diamond);

  console.log(`  Network:   ${cfg.name} (chainId ${chainId})`);
  console.log(`  Diamond:   ${diamond}`);
  console.log(`  Owner:     ${owner}`);
  console.log(`  Record:    ${path.basename(recordFile)} (cut tx ${rec.cutTxHash})`);
  console.log(`  Replace:   ${selectors.join(", ")}`);
  console.log(`  From:      ${facetToRetire}`);
  console.log(`  To:        ${target}`);
  const mode = await chooseRoute({ cfg, chainId, owner, deployer, minBalance: MIN_DEPLOYER_BALANCE, safeClient: opts.safeClient });
  console.log(`  Cut route: ${mode}`);

  if (dryRun) {
    console.log("\nDRY_RUN — stopping before the cut.");
    return { dryRun: true, diamond, selectors, target, facetToRetire };
  }
  if (!cfg.local) {
    printOrderWarning();
    console.log(`  Pausing ${WARNING_PAUSE_MS / 1000}s before the cut — Ctrl-C to abort.\n`);
    await new Promise((r) => setTimeout(r, WARNING_PAUSE_MS));
  }

  console.log("\n--- diamondCut (Replace 3 back) ---");
  const cut = [{ facetAddress: target, action: FacetCutAction.Replace, functionSelectors: selectors }];
  const transaction = { to: diamond, data: diamondCut.interface.encodeFunctionData("diamondCut", [cut, ethers.constants.AddressZero, "0x"]) };
  const { cutTxHash, cutBlock, safeTxHash } = await sendCut({ mode, cfg, chainId, owner, deployer, transaction, label: "SCRUM-559 market-order SettlementFacet rollback", safeClient: opts.safeClient });

  // Record first: whatever the post-check finds, the cut is on-chain and must be documented.
  const timestamp = new Date().toISOString();
  const rollbackFile = path.join(opts.recordDir || path.join(__dirname, "..", "..", "deployments", cfg.name), `scrum559-rollback-${timestamp.replace(/[:.]/g, "-")}.json`);
  const summary = {
    ticket: "SCRUM-560",
    contractChange: "SCRUM-559",
    rollbackOf: path.basename(recordFile),
    rolledBackCutTxHash: rec.cutTxHash,
    network: cfg.name,
    chainId,
    diamond,
    owner,
    cutRoute: mode,
    gitCommit: provenance.commit,
    from: facetToRetire,
    to: target,
    cut: cut.map((c) => ({ ...c, action: "Replace" })),
    cutTxHash,
    cutBlock,
    safeTxHash,
    preflight: stateBefore,
    postCheck: "pending",
    timestamp,
  };
  if (record) {
    writeRecord(rollbackFile, summary);
    console.log(`  Record written: ${path.relative(process.cwd(), rollbackFile)}`);
  }

  console.log("\n--- post-check ---");
  const problems = [];
  const routingAfter = await pollUntil(() => readRouting(loupe), (r) => selectors.every((s) => r[s] === target), cfg.local);
  for (const s of selectors) {
    const ok = routingAfter[s] === target;
    console.log(`  ${ok ? "✔" : "✘"} facetAddress(${s}) = ${routingAfter[s]}`);
    if (!ok) problems.push(`${s} routes to ${routingAfter[s]}, expected ${target}`);
  }
  const movedOthers = routingDiff(routingBefore, routingAfter).filter((sel) => !selectors.includes(sel));
  if (movedOthers.length) problems.push(`selectors outside this cut moved: ${movedOthers.join(", ")}`);
  else console.log(`  ✔ the other ${Object.keys(routingAfter).length - selectors.length} selectors on the Diamond did not move`);
  const cmp = await compareStateAroundCut(diamond, cutBlock, stateBefore);
  cmp.notes.forEach((n) => console.log(`  · ${n}`));
  problems.push(...cmp.problems);
  if (!cmp.problems.length) console.log("  ✔ operator, pause flag, fee settings, units and domain unchanged; accrued fees did not fall");

  Object.assign(summary, {
    aroundCut: cmp.around,
    postCheck: problems.length ? { ok: false, problems, notes: cmp.notes } : { ok: true, notes: cmp.notes },
  });
  if (record) {
    writeRecord(rollbackFile, summary);
    console.log(`  Record updated with the post-check: ${path.relative(process.cwd(), rollbackFile)}`);
  }
  if (problems.length) {
    throw new Error(`The rollback tx ${cutTxHash} is MINED, but the post-check found:\n    - ${problems.join("\n    - ")}\n  Keep MARKET_ORDERS_ENABLED off.`);
  }

  console.log("\n==========================================================");
  console.log(`  ✅ Rolled back: the three selectors route to ${target}`);
  if (cfg.explorer) console.log(`  Cut tx:   ${cfg.explorer}/tx/${cutTxHash}`);
  console.log("  Leave MARKET_ORDERS_ENABLED off: this facet overcharges a marked order.");
  console.log("==========================================================\n");
  return { ...summary, recordFile: record ? rollbackFile : null };
}

if (require.main === module) {
  runRollback()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("\n❌ SCRUM-559 market-order rollback failed:", e);
      process.exit(1);
    });
}

module.exports = { runRollback };
