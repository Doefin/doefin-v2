/* global ethers */
/* eslint prefer-const: "off" */
/**
 * Safe-owned Diamond deployment for Base Sepolia and Base mainnet.
 *
 * Differs from scripts/deploy.js in that the Diamond is owned by a Safe
 * multi-sig from genesis — the deployer EOA never holds ownership. The cut
 * and all owner-only bootstrap calls are bundled into a single Safe MultiSend
 * transaction, proposed and signed by the deployer (who must be a Safe
 * signer), then executed once threshold is met.
 *
 * Required env:
 *   PRIVATE_KEY                       Deployer EOA (must be a signer on SAFE_ADDRESS)
 *   SAFE_ADDRESS                      Safe multi-sig that will own the Diamond
 *   OPERATOR_ADDRESS                  Match-engine hot wallet (NOT the Safe)
 *   COLLATERAL_TOKEN_ADDRESS          ERC20 to whitelist as collateral
 *   COLLATERAL_TOKEN_DECIMALS         Decimals for unitPerPair scaling (default: 6)
 *   BASE_SEPOLIA_RPC_ENDPOINT         (for --network baseSepolia)
 *   BASE_MAINNET_RPC_ENDPOINT         (for --network base)
 *   ETHERSCAN_API_KEY                 For Basescan verification
 *
 * Optional env:
 *   FEE_RECEIVER_ADDRESS              Defaults to SAFE_ADDRESS
 *   START_PAUSED                      "false" to skip pauseTrading (default: "true")
 *   SKIP_VERIFY                       "true" to skip Basescan verification
 */

const hre = require("hardhat");
const { getSelectors, FacetCutAction } = require("./libraries/diamond.js");
const { proposeAndExecute, safeNetworkPrefix } = require("./lib/safe-multisend.js");

function isLocalNetwork() {
  return hre.network.name === "hardhat" || hre.network.name === "localhost";
}

function getConfirmationCount() {
  return isLocalNetwork() ? 1 : 2;
}

async function verifyContract(address, constructorArguments = []) {
  if (process.env.SKIP_VERIFY === "true" || isLocalNetwork()) return;
  try {
    await hre.run("verify:verify", { address, constructorArguments });
    console.log(`  ✔️ Verified: ${address}`);
  } catch (err) {
    console.warn(`  ⚠️ Verification skipped for ${address}: ${err.message}`);
  }
}

async function deployFacet(name, libraries = {}) {
  const factory = Object.keys(libraries).length
    ? await ethers.getContractFactory(name, { libraries })
    : await ethers.getContractFactory(name);
  const facet = await factory.deploy();
  await facet.deployed();
  if (!isLocalNetwork()) {
    await facet.deployTransaction.wait(getConfirmationCount());
  }
  const code = await ethers.provider.getCode(facet.address);
  if (code === "0x") throw new Error(`${name} has no code at ${facet.address}`);
  console.log(`  ${name} deployed: ${facet.address}`);
  await verifyContract(facet.address);
  return facet;
}

async function main() {
  // --- Env validation ---
  const SAFE_ADDRESS = process.env.SAFE_ADDRESS;
  const OPERATOR = process.env.OPERATOR_ADDRESS;
  const COLLATERAL = process.env.COLLATERAL_TOKEN_ADDRESS;
  const COLLATERAL_DECIMALS = parseInt(process.env.COLLATERAL_TOKEN_DECIMALS || "6", 10);
  const FEE_RECEIVER = process.env.FEE_RECEIVER_ADDRESS || SAFE_ADDRESS;
  const START_PAUSED = process.env.START_PAUSED !== "false";

  const required = {
    SAFE_ADDRESS,
    OPERATOR_ADDRESS: OPERATOR,
    COLLATERAL_TOKEN_ADDRESS: COLLATERAL,
  };
  for (const [k, v] of Object.entries(required)) {
    if (!v) throw new Error(`Missing required env: ${k}`);
  }
  if (!ethers.utils.isAddress(SAFE_ADDRESS)) throw new Error(`Invalid SAFE_ADDRESS: ${SAFE_ADDRESS}`);
  if (!ethers.utils.isAddress(OPERATOR)) throw new Error(`Invalid OPERATOR_ADDRESS: ${OPERATOR}`);
  if (!ethers.utils.isAddress(COLLATERAL)) throw new Error(`Invalid COLLATERAL_TOKEN_ADDRESS: ${COLLATERAL}`);
  if (!ethers.utils.isAddress(FEE_RECEIVER)) throw new Error(`Invalid FEE_RECEIVER_ADDRESS: ${FEE_RECEIVER}`);

  const network = await ethers.provider.getNetwork();
  const [deployer] = await ethers.getSigners();
  const balance = await deployer.getBalance();

  console.log("==========================================================");
  console.log("  Safe-owned Diamond deployment");
  console.log("==========================================================");
  console.log(`  Network:           ${hre.network.name} (chainId ${network.chainId})`);
  console.log(`  Deployer EOA:      ${deployer.address}`);
  console.log(`  Deployer balance:  ${ethers.utils.formatEther(balance)} ETH`);
  console.log(`  Safe (new owner):  ${SAFE_ADDRESS}`);
  console.log(`  Operator:          ${OPERATOR}`);
  console.log(`  Collateral token:  ${COLLATERAL} (${COLLATERAL_DECIMALS} decimals)`);
  console.log(`  Fee receiver:      ${FEE_RECEIVER}`);
  console.log(`  Start paused:      ${START_PAUSED}`);
  console.log("==========================================================\n");

  // --- Sanity check: Safe must be a deployed contract on this network ---
  if (!isLocalNetwork()) {
    const safeCode = await ethers.provider.getCode(SAFE_ADDRESS);
    if (safeCode === "0x") {
      throw new Error(
        `SAFE_ADDRESS ${SAFE_ADDRESS} has no bytecode on ${hre.network.name}. ` +
          `Wrong address, wrong network, or Safe not yet deployed.`
      );
    }
    console.log(`  Safe bytecode confirmed at ${SAFE_ADDRESS} (${safeCode.length} chars)`);
  }

  // --- Phase 1: Deploy contracts (deployer EOA, no ownership granted yet) ---
  console.log("\n--- Phase 1: Deploying facets ---\n");

  const DiamondCutFacet = await ethers.getContractFactory("DiamondCutFacet");
  const diamondCutFacet = await DiamondCutFacet.deploy();
  await diamondCutFacet.deployed();
  if (!isLocalNetwork()) await diamondCutFacet.deployTransaction.wait(getConfirmationCount());
  console.log(`  DiamondCutFacet deployed: ${diamondCutFacet.address}`);
  await verifyContract(diamondCutFacet.address);

  // Diamond constructor takes (owner, diamondCutFacet) — pass the Safe directly.
  const Diamond = await ethers.getContractFactory("Diamond");
  const diamond = await Diamond.deploy(SAFE_ADDRESS, diamondCutFacet.address);
  await diamond.deployed();
  if (!isLocalNetwork()) await diamond.deployTransaction.wait(getConfirmationCount());
  console.log(`  Diamond deployed:        ${diamond.address}`);
  console.log(`  Diamond owner (post-construct): ${SAFE_ADDRESS}`);
  await verifyContract(diamond.address, [SAFE_ADDRESS, diamondCutFacet.address]);

  const DiamondInit = await ethers.getContractFactory("DiamondInit");
  const diamondInit = await DiamondInit.deploy();
  await diamondInit.deployed();
  if (!isLocalNetwork()) await diamondInit.deployTransaction.wait(getConfirmationCount());
  console.log(`  DiamondInit deployed:    ${diamondInit.address}`);
  await verifyContract(diamondInit.address);

  // BlockHeaderUtils library is needed by DoefinV1BlockHeaderOracle facet
  const BlockHeaderUtilsLib = await ethers.getContractFactory("BlockHeaderUtils");
  const blockHeaderUtils = await BlockHeaderUtilsLib.deploy();
  await blockHeaderUtils.deployed();
  if (!isLocalNetwork()) await blockHeaderUtils.deployTransaction.wait(getConfirmationCount());
  console.log(`  BlockHeaderUtils:        ${blockHeaderUtils.address}`);
  await verifyContract(blockHeaderUtils.address);

  const FacetNames = [
    "DiamondLoupeFacet",
    "OwnershipFacet",
    "ERC1155Facet",
    "ERC1155ReceiverFacet",
    "ConditionalTokensFacet",
    "ConditionManagerFacet",
    "DoefinV1BlockHeaderOracle",
    "AccessControlFacet",
    "AdminConfigFacet",
    "MarketDataFacet",
    "OracleAdapterFacet",
    "SignatureVerifierFacet",
    "NonceManagerFacet",
    "SettlementFacet",
  ];

  const facets = {};
  const cut = [];
  for (const name of FacetNames) {
    const libs =
      name === "DoefinV1BlockHeaderOracle"
        ? { BlockHeaderUtils: blockHeaderUtils.address }
        : {};
    const facet = await deployFacet(name, libs);
    facets[name] = facet;
    cut.push({
      facetAddress: facet.address,
      action: FacetCutAction.Add,
      functionSelectors: getSelectors(facet),
    });
  }

  // --- Phase 2: Build MultiSend payload ---
  console.log("\n--- Phase 2: Building Safe MultiSend bootstrap ---\n");

  // 2a. diamondCut(cut, DiamondInit, init.calldata)
  const diamondCutIface = (await ethers.getContractAt("IDiamondCut", diamond.address)).interface;
  const initCalldata = diamondInit.interface.encodeFunctionData("init", [SAFE_ADDRESS]);
  const cutCalldata = diamondCutIface.encodeFunctionData("diamondCut", [
    cut,
    diamondInit.address,
    initCalldata,
  ]);

  // 2b. setOperator(operator)
  const settlementIface = (await ethers.getContractAt("ISettlement", diamond.address)).interface;
  const setOpCalldata = settlementIface.encodeFunctionData("setOperator", [OPERATOR]);

  // 2c. addCollateralToken(collateral, unitPerPair)
  const adminIface = (await ethers.getContractAt("IAdminConfig", diamond.address)).interface;
  const unitPerPair = ethers.utils.parseUnits("1", COLLATERAL_DECIMALS);
  const addCollCalldata = adminIface.encodeFunctionData("addCollateralToken", [
    COLLATERAL,
    unitPerPair,
  ]);

  // 2d. setFeeReceiver(feeReceiver)
  const setFeeRecvCalldata = adminIface.encodeFunctionData("setFeeReceiver", [FEE_RECEIVER]);

  // 2e. pauseTrading() — optional, default on
  const pauseCalldata = settlementIface.encodeFunctionData("pauseTrading", []);

  const innerTxs = [
    { to: diamond.address, data: cutCalldata, label: "diamondCut (14 facets + init)" },
    { to: diamond.address, data: setOpCalldata, label: `setOperator(${OPERATOR})` },
    { to: diamond.address, data: addCollCalldata, label: `addCollateralToken(${COLLATERAL}, 1e${COLLATERAL_DECIMALS})` },
    { to: diamond.address, data: setFeeRecvCalldata, label: `setFeeReceiver(${FEE_RECEIVER})` },
  ];
  if (START_PAUSED) {
    innerTxs.push({ to: diamond.address, data: pauseCalldata, label: "pauseTrading()" });
  }

  console.log(`  MultiSend bundle (${innerTxs.length} calls):`);
  innerTxs.forEach((tx, i) => console.log(`    [${i}] ${tx.label}`));

  // --- Phase 3: Propose, wait, execute through the Safe ---
  console.log("\n--- Phase 3: Safe MultiSend ceremony ---\n");

  const rpcUrl = (() => {
    if (hre.network.name === "baseSepolia") return process.env.BASE_SEPOLIA_RPC_ENDPOINT;
    if (hre.network.name === "base") return process.env.BASE_MAINNET_RPC_ENDPOINT;
    if (hre.network.name === "arbitrumSepolia") return process.env.SEPOLIA_RPC_URL;
    if (hre.network.name === "arbitrumOne") return process.env.ARBITRUM_MAINNET_RPC_URL;
    throw new Error(`No RPC URL mapping for network: ${hre.network.name}`);
  })();

  const { safeTxHash, executionTxHash } = await proposeAndExecute({
    safeAddress: SAFE_ADDRESS,
    chainId: Number(network.chainId),
    rpcUrl,
    signerKey: process.env.PRIVATE_KEY,
    transactions: innerTxs.map(({ to, data }) => ({ to, data })),
    label: "Doefin Diamond bootstrap",
  });

  // --- Phase 4: Verify ---
  console.log("\n--- Phase 4: Post-deploy verification ---\n");

  const loupe = await ethers.getContractAt("DiamondLoupeFacet", diamond.address);
  const facetsRegistered = await loupe.facets();
  console.log(`  Facets registered: ${facetsRegistered.length} (expected ${FacetNames.length + 1})`); // +1 for DiamondCutFacet

  const ownership = await ethers.getContractAt("OwnershipFacet", diamond.address);
  const currentOwner = await ownership.owner();
  console.log(`  Diamond owner:     ${currentOwner}`);
  if (currentOwner.toLowerCase() !== SAFE_ADDRESS.toLowerCase()) {
    throw new Error(`Owner mismatch! Expected ${SAFE_ADDRESS}, got ${currentOwner}`);
  }

  const settlement = await ethers.getContractAt("ISettlement", diamond.address);
  const operatorAddr = await settlement.operator();
  console.log(`  Operator:          ${operatorAddr}`);

  const admin = await ethers.getContractAt("AdminConfigFacet", diamond.address);
  const collAllowed = await admin.isAllowedCollateral(COLLATERAL);
  console.log(`  Collateral whitelisted: ${collAllowed}`);

  const isPaused = await settlement.isTradingPaused();
  console.log(`  Trading paused:    ${isPaused}`);

  const verifier = await ethers.getContractAt("ISignatureVerifier", diamond.address);
  const domainSep = await verifier.getDomainSeparator();

  // --- Final output for backend ---
  const deployBlock = await ethers.provider.getBlockNumber();
  console.log("\n==========================================================");
  console.log("  ✅ Deployment complete");
  console.log("==========================================================");
  console.log(`  DIAMOND_CONTRACT_ADDRESS=${diamond.address}`);
  console.log(`  CHAIN_ID=${network.chainId}`);
  console.log(`  DOMAIN_SEPARATOR=${domainSep}`);
  console.log(`  DEPLOY_BLOCK=${deployBlock}`);
  console.log(`  OPERATOR_ADDRESS=${OPERATOR}`);
  console.log(`  SAFE_ADDRESS=${SAFE_ADDRESS}`);
  console.log(`  COLLATERAL_TOKEN=${COLLATERAL}`);
  console.log(`  SAFE_TX_HASH=${safeTxHash}`);
  console.log(`  BOOTSTRAP_EXEC_TX=${executionTxHash}`);
  console.log("==========================================================\n");

  console.log(`  Safe UI: https://app.safe.global/transactions/history?safe=${safeNetworkPrefix(network.chainId)}:${SAFE_ADDRESS}`);
  console.log(`  Basescan: https://${network.chainId === 84532 ? "sepolia." : ""}basescan.org/address/${diamond.address}`);
  if (START_PAUSED) {
    console.log(`\n  ⚠️  Trading is PAUSED. Unpause via a Safe tx when backend cutover is complete:`);
    console.log(`     settlement.interface.encodeFunctionData("unpauseTrading", [])`);
  }

  return diamond.address;
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("\n❌ Deployment failed:", err);
      process.exit(1);
    });
}

module.exports = { main };
