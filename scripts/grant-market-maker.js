// One-off: grant market-maker role to MARKET_MAKER_ADDRESS via the Safe.
// addMarketMaker is onlyOwner; owner is the Safe; we use the same
// propose-and-execute helper the deploy uses. 1-of-1 = auto-executes
// on the deployer's single signature.

const hre = require("hardhat");
const { proposeAndExecute } = require("./lib/safe-multisend");

const DIAMOND = "0x2f03d47520fb8bc8aDAab392BF280D99De7cAe3f";
const SAFE_ADDRESS = process.env.SAFE_ADDRESS;
const MARKET_MAKER = process.env.MARKET_MAKER_ADDRESS;
const SIGNER_KEY = process.env.PRIVATE_KEY;

async function main() {
  if (!SAFE_ADDRESS) throw new Error("SAFE_ADDRESS not set");
  if (!MARKET_MAKER) throw new Error("MARKET_MAKER_ADDRESS not set");
  if (!SIGNER_KEY) throw new Error("PRIVATE_KEY not set");

  const network = await hre.ethers.provider.getNetwork();
  const [deployer] = await hre.ethers.getSigners();

  console.log("==========================================================");
  console.log("  Grant market-maker via Safe");
  console.log("==========================================================");
  console.log(`  Network:      ${hre.network.name} (chainId ${network.chainId})`);
  console.log(`  Deployer EOA: ${deployer.address}  (Safe signer)`);
  console.log(`  Safe:         ${SAFE_ADDRESS}`);
  console.log(`  Diamond:      ${DIAMOND}`);
  console.log(`  Target MM:    ${MARKET_MAKER}`);
  console.log("==========================================================\n");

  // Pre-check
  const ac = await hre.ethers.getContractAt("AccessControlFacet", DIAMOND);
  const before = await ac.isMarketMaker(MARKET_MAKER);
  console.log(`  Pre-check  isMarketMaker(${MARKET_MAKER}) = ${before}`);
  if (before) {
    console.log("  Already a market maker — nothing to do.");
    return;
  }

  // Build calldata
  const data = ac.interface.encodeFunctionData("addMarketMaker", [MARKET_MAKER]);
  console.log(`\n  Inner tx: addMarketMaker(${MARKET_MAKER})`);
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
    label: `addMarketMaker(${MARKET_MAKER})`,
  });

  console.log(`\n  Safe tx hash:     ${safeTxHash}`);
  console.log(`  Exec tx hash:     ${executionTxHash}`);

  // Verify
  const after = await ac.isMarketMaker(MARKET_MAKER);
  console.log(`\n  Post-check isMarketMaker(${MARKET_MAKER}) = ${after}`);
  if (!after) throw new Error("Grant failed — isMarketMaker still false");
  console.log("\n  ✅ Market-maker role granted.");
}

main().then(() => process.exit(0)).catch((e) => { console.error("❌", e); process.exit(1); });
