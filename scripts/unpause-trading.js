// One-off: unpause trading on the Safe-owned Diamond.
// unpauseTrading lives on SettlementAdminFacet (ISettlementAdmin) and is
// onlyOwner; owner is the Safe; we use the same propose-and-execute helper
// the deploy uses. 1-of-1 = auto-executes on the deployer's single signature.

const hre = require("hardhat");
const { proposeAndExecute } = require("./lib/safe-multisend");

const DIAMOND = "0x2f03d47520fb8bc8aDAab392BF280D99De7cAe3f";
const SAFE_ADDRESS = process.env.SAFE_ADDRESS;
const SIGNER_KEY = process.env.PRIVATE_KEY;

async function main() {
  if (!SAFE_ADDRESS) throw new Error("SAFE_ADDRESS not set");
  if (!SIGNER_KEY) throw new Error("PRIVATE_KEY not set");

  const network = await hre.ethers.provider.getNetwork();
  const [deployer] = await hre.ethers.getSigners();

  console.log("==========================================================");
  console.log("  Unpause trading via Safe");
  console.log("==========================================================");
  console.log(`  Network:      ${hre.network.name} (chainId ${network.chainId})`);
  console.log(`  Deployer EOA: ${deployer.address}  (Safe signer)`);
  console.log(`  Safe:         ${SAFE_ADDRESS}`);
  console.log(`  Diamond:      ${DIAMOND}`);
  console.log("==========================================================\n");

  const sa = await hre.ethers.getContractAt("ISettlementAdmin", DIAMOND);
  const before = await sa.isTradingPaused();
  console.log(`  Pre-check  isTradingPaused() = ${before}`);
  if (!before) {
    console.log("  Trading is already unpaused — nothing to do.");
    return;
  }

  const data = sa.interface.encodeFunctionData("unpauseTrading", []);
  console.log(`\n  Inner tx: unpauseTrading()`);
  console.log(`  to:   ${DIAMOND}`);
  console.log(`  data: ${data}\n`);

  const rpcUrl =
    hre.network.name === "baseSepolia" ? process.env.BASE_SEPOLIA_RPC_ENDPOINT :
    hre.network.name === "base" ? process.env.BASE_MAINNET_RPC_ENDPOINT :
    (() => { throw new Error(`No RPC URL mapping for network: ${hre.network.name}`); })();

  const { safeTxHash, executionTxHash } = await proposeAndExecute({
    safeAddress: SAFE_ADDRESS,
    chainId: Number(network.chainId),
    rpcUrl,
    signerKey: SIGNER_KEY,
    transactions: [{ to: DIAMOND, data }],
    label: "unpauseTrading()",
  });

  console.log(`\n  Safe tx hash:     ${safeTxHash}`);
  console.log(`  Exec tx hash:     ${executionTxHash}`);
  console.log(`\n  Note: post-check intentionally omitted — RPC propagation lag often returns`);
  console.log(`        stale state immediately after exec. Verify on chain via curl / Basescan.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("❌", e); process.exit(1); });
