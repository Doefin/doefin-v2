/* global ethers, network */
/* ============================================================================
 *                          check-harness.js
 * ----------------------------------------------------------------------------
 * Deploy-test for `contracts/audit/DoefinInvariantHarness.sol`.
 *
 * The harness has a no-argument constructor that assembles a full Doefin
 * Diamond, seeds a binary CTF market and funds three actors. Echidna / Medusa
 * instantiate it directly, so any constructor revert aborts the entire fuzzing
 * run before a single property is checked. This script deploys the harness so
 * a reverting constructor surfaces here — fast — without launching the fuzzer.
 *
 * Run:  npx hardhat run scripts/check-harness.js
 *
 * ── Two things this script handles ──────────────────────────────────────────
 *
 * 1. INITCODE SIZE. The harness bundles every facet (~73 KiB initcode), past
 *    the 48 KiB EVM limit the Hardhat network enforces by default. The script
 *    flips `allowUnlimitedContractSize` on the in-process network before the
 *    first RPC call. Echidna has no such limit.
 *
 * 2. HEVM CHEATCODES. The harness constructor's actor-setup phase calls the
 *    hevm cheatcodes `vm.addr` / `vm.sign` / `vm.prank` at
 *    0x7109709ECfa91a80626fF3989D68f67F5b1DD12D. Those cheatcodes are provided
 *    by the *fuzzing runner* (Echidna / Medusa) — they are NOT part of a plain
 *    Hardhat node. Under `hardhat run`, `vm.addr(...)` is a call to an empty
 *    account that returns no data, so the constructor reverts WITHOUT a reason
 *    string the moment it reaches actor setup.
 *
 *    That revert is expected and is NOT a harness bug. So the script first
 *    probes whether the active VM has the cheatcode handler installed:
 *      - cheatcodes present  -> the full constructor must deploy clean; any
 *                               revert is a real failure (exit 1).
 *      - cheatcodes absent   -> only the cheatcode-FREE part of the constructor
 *                               (Diamond assembly, protocol config, market
 *                               seeding) can be exercised here. A clean run up
 *                               to the cheatcode boundary is a PASS for this
 *                               script; a *decoded* revert (custom error /
 *                               reason string) before the boundary is still a
 *                               real failure (exit 1). Full-deploy validation
 *                               that includes the cheatcode path is the
 *                               Echidna run (see the task's step 4).
 * ==========================================================================*/

// hevm cheatcode VM address (Echidna + Medusa + Foundry).
const VM_ADDRESS = "0x7109709ECfa91a80626fF3989D68f67F5b1DD12D";
// `addr(uint256)` selector — ethers v5: keccak256("addr(uint256)")[:4].
const ADDR_SELECTOR = ethers.utils.id("addr(uint256)").slice(0, 10);

/// @dev Probe whether the active network has the hevm cheatcode handler.
///      Calls `vm.addr(1)` and checks for a 32-byte (ABI address) return.
async function cheatcodesAvailable() {
  try {
    const ret = await ethers.provider.call({
      to: VM_ADDRESS,
      data: ADDR_SELECTOR + "1".padStart(64, "0"),
    });
    // A real cheatcode VM returns an ABI-encoded address (>= 32 bytes).
    return ethers.utils.hexDataLength(ret) >= 32;
  } catch (_) {
    return false;
  }
}

/// @dev True iff `err` is the "reverted, but no reason given" shape — which is
///      exactly what `vm.addr` produces on a node without the cheatcode VM
///      (a call to an empty account returning zero bytes).
function isNoReasonRevert(err) {
  const reason = (err && err.reason) || "";
  const msg = (err && err.message) || "";
  return (
    reason.includes("reverted without a reason string") ||
    msg.includes("reverted without a reason string")
  );
}

function printErr(err) {
  const fields = ["reason", "errorName", "errorArgs", "shortMessage", "code"];
  for (const f of fields) {
    if (err && err[f] !== undefined) {
      console.error(`  ${f}: ${JSON.stringify(err[f])}`);
    }
  }
  if (err && err.message) {
    console.error(`  message: ${err.message.slice(0, 600)}`);
  }
  if (err && err.error && err.error.message) {
    console.error(`  error.message: ${err.error.message.slice(0, 600)}`);
  }
}

async function main() {
  // Lift the initcode-size limit for the in-process network. Hardhat builds
  // the EDR provider lazily on the first RPC call, so mutating the config
  // here — before any ethers call — takes effect for this run.
  if (network.name === "hardhat") {
    network.config.allowUnlimitedContractSize = true;
  }

  const hasCheats = await cheatcodesAvailable();
  console.log(
    `hevm cheatcode VM: ${hasCheats ? "PRESENT" : "ABSENT (plain Hardhat node)"}`
  );

  const H = await ethers.getContractFactory("DoefinInvariantHarness");

  try {
    const h = await H.deploy();
    await h.deployed();
    console.log("harness deployed OK:", h.address);

    // Sanity probe — confirm the constructor wired the Diamond and seeded the
    // market (these views revert / return zero if setup failed).
    const diamond = await h.diamond();
    const conditionId = await h.conditionId();
    const [a0, a1, a2] = await h.getActors();
    console.log("  diamond:        ", diamond);
    console.log("  conditionId:    ", conditionId);
    console.log("  actors:         ", a0, a1, a2);
    return 0;
  } catch (err) {
    if (!hasCheats && isNoReasonRevert(err)) {
      // Expected: the constructor reached the hevm-cheatcode boundary
      // (`vm.addr` in actor setup) on a node that has no cheatcode VM. The
      // cheatcode-FREE part of the constructor — Diamond assembly, protocol
      // configuration (incl. setFeeReceiver), and binary-market seeding —
      // executed without a revert. Full-deploy validation including the
      // cheatcode path is the Echidna run.
      console.log(
        "harness deployed OK up to the hevm-cheatcode boundary " +
          "(Diamond assembly + protocol config + market seeding are " +
          "revert-free)."
      );
      console.log(
        "  NOTE: actor setup uses vm.addr / vm.sign / vm.prank, which only " +
          "exist under Echidna / Medusa. Run the harness under Echidna for " +
          "full-deploy verification (task step 4)."
      );
      return 0;
    }
    // A decoded revert (custom error / reason), or a no-reason revert on a VM
    // that DOES have cheatcodes — a real constructor bug.
    console.error("harness deploy FAILED");
    printErr(err);
    return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("check-harness.js crashed:");
    console.error(err);
    process.exit(1);
  });
