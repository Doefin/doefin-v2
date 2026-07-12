/* global ethers */
const { ethers } = require("hardhat");

async function main() {
  const diamondAddress = process.env.DIAMOND_ADDRESS;
  if (!diamondAddress) throw new Error("Set DIAMOND_ADDRESS env var");

  console.log("Setting up test market on Diamond:", diamondAddress);
  const network = await ethers.provider.getNetwork();
  console.log("Network:", network.chainId);
  console.log("");

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  // =====================================================
  // Step 0 — Collateral token
  // =====================================================
  let collateralToken = process.env.COLLATERAL_TOKEN;
  if (!collateralToken) {
    console.log("No COLLATERAL_TOKEN set — deploying new MockERC20 (6 decimals)...");
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const mockToken = await MockERC20.deploy("Doefin Test USDC", "tUSDC", 6);
    await mockToken.deployed();
    collateralToken = mockToken.address;
    console.log("MockERC20 deployed:", collateralToken);
  }
  console.log("Collateral token:", collateralToken);
  console.log("");

  const mockERC20 = await ethers.getContractAt("MockERC20", collateralToken);

  // =====================================================
  // Step 1 — Admin config (idempotent checks)
  // =====================================================
  const adminConfig = await ethers.getContractAt("IAdminConfig", diamondAddress);

  // Add collateral token to allowlist if not already set
  const isAllowed = await adminConfig.isAllowedCollateral(collateralToken);
  if (!isAllowed) {
    // unitPerPair = 10^6 for a 6-decimal token (1 full token = 1_000_000 units)
    const UNIT_PER_PAIR = ethers.utils.parseUnits("1", 6);
    const txAdd = await adminConfig.addCollateralToken(collateralToken, UNIT_PER_PAIR);
    await txAdd.wait();
    console.log("addCollateralToken tx:", txAdd.hash);
    console.log("Collateral token added with unitPerPair:", UNIT_PER_PAIR.toString());
  } else {
    console.log("Collateral token already in allowlist");
  }

  // Set fee receiver if not yet configured (needed for position redemptions)
  const fees = await adminConfig.getFees();
  const currentFeeReceiver = fees[0];
  if (currentFeeReceiver === ethers.constants.AddressZero) {
    const txFee = await adminConfig.setFeeReceiver(deployer.address);
    await txFee.wait();
    console.log("setFeeReceiver tx:", txFee.hash);
    console.log("Fee receiver set to:", deployer.address);
  } else {
    console.log("Fee receiver already set:", currentFeeReceiver);
  }
  console.log("");

  // =====================================================
  // Step 2 — Prepare condition
  // =====================================================
  const ctf = await ethers.getContractAt("IConditionalTokens", diamondAddress);

  // Deterministic questionId for repeatability
  const questionId = ethers.utils.formatBytes32String("v21-test-market-001");
  const outcomeSlotCount = 2; // binary: YES / NO

  // conditionId = keccak256(abi.encodePacked(oracle, questionId, uint8(outcomeSlotCount)))
  // The oracle is the deployer (passed as oracle param to prepareCondition)
  const conditionId = ethers.utils.solidityKeccak256(
    ["address", "bytes32", "uint8"],
    [deployer.address, questionId, outcomeSlotCount]
  );
  console.log("questionId:", questionId);
  console.log("conditionId:", conditionId);

  // Check if condition is already prepared (payoutNumerators array will be non-empty)
  const numerators = await ctf.getPayoutNumerators(conditionId);
  if (numerators.length === 0) {
    const tx1 = await ctf.prepareCondition(deployer.address, questionId, outcomeSlotCount);
    await tx1.wait();
    console.log("prepareCondition tx:", tx1.hash);
  } else {
    console.log("Condition already prepared (", numerators.length, "outcomes)");
  }
  console.log("");

  // =====================================================
  // Step 3 — Derive position IDs on-chain
  // getCollectionId uses alt-bn128 EC arithmetic — cannot replicate off-chain
  // =====================================================
  const collectionIdA = await ctf.getCollectionId(ethers.constants.HashZero, conditionId, 1);
  const collectionIdB = await ctf.getCollectionId(ethers.constants.HashZero, conditionId, 2);

  const positionIdAUint = await ctf.getPositionId(collateralToken, collectionIdA);
  const positionIdBUint = await ctf.getPositionId(collateralToken, collectionIdB);

  const positionIdA = ethers.utils.hexZeroPad(positionIdAUint.toHexString(), 32);
  const positionIdB = ethers.utils.hexZeroPad(positionIdBUint.toHexString(), 32);

  console.log("positionIdA (YES):", positionIdA);
  console.log("positionIdB (NO): ", positionIdB);
  console.log("");

  // Settlement complement registration happens automatically when Step 5 splits
  // the position — LibPositionRegistry.registerPositionPairs is invoked inside
  // LibCTFCondition._splitPosition. No owner-only registerPositionPair call is
  // needed (SCRUM-89).

  // =====================================================
  // Step 4 — Fund test wallets with ERC20
  // =====================================================
  const buyerAddress =
    process.env.TEST_BUYER_ADDRESS ||
    process.env.MARKET_MAKER_ADDRESS ||
    deployer.address;
  const sellerAddress = process.env.TEST_SELLER_ADDRESS || process.env.TAKER_ADDRESS;
  if (!sellerAddress) {
    throw new Error("Set TEST_SELLER_ADDRESS or TAKER_ADDRESS env var");
  }

  const COLLATERAL_AMOUNT = ethers.utils.parseUnits("1000", 6); // 1000 tUSDC
  const tx3 = await mockERC20.mint(buyerAddress, COLLATERAL_AMOUNT);
  await tx3.wait();
  console.log(`Minted ${COLLATERAL_AMOUNT.toString()} collateral to buyer: ${buyerAddress}`);

  const tx4 = await mockERC20.mint(sellerAddress, COLLATERAL_AMOUNT);
  await tx4.wait();
  console.log(`Minted ${COLLATERAL_AMOUNT.toString()} collateral to seller: ${sellerAddress}`);
  console.log("");

  // =====================================================
  // Step 5 — Split positions (deployer mints YES + NO position tokens)
  // =====================================================
  const SPLIT_AMOUNT = ethers.utils.parseUnits("500", 6); // 500 tUSDC worth of positions

  // If deployer is not the buyer, deployer may not have collateral yet — mint enough for split
  if (deployer.address.toLowerCase() !== buyerAddress.toLowerCase()) {
    const txMintDeployer = await mockERC20.mint(deployer.address, SPLIT_AMOUNT);
    await txMintDeployer.wait();
    console.log(`Minted ${SPLIT_AMOUNT.toString()} collateral to deployer for split`);
  }

  // Deployer approves Diamond to spend collateral
  const txApproveForSplit = await mockERC20.approve(diamondAddress, SPLIT_AMOUNT);
  await txApproveForSplit.wait();

  // splitPosition(collateralToken, parentCollectionId, conditionId, partition, amount)
  // partition: [1] = YES indexSet, [2] = NO indexSet
  const tx5 = await ctf.splitPosition(
    collateralToken,
    ethers.constants.HashZero,
    conditionId,
    [1, 2],
    SPLIT_AMOUNT
  );
  await tx5.wait();
  console.log("splitPosition tx:", tx5.hash);

  // =====================================================
  // Step 6 — Transfer positionA (YES) tokens to seller
  // Seller will sell YES tokens; they need them before settlement
  // =====================================================
  const erc1155 = await ethers.getContractAt("IERC1155Facet", diamondAddress);
  const tx6 = await erc1155.safeTransferFrom(
    deployer.address,
    sellerAddress,
    positionIdAUint, // uint256 token ID
    SPLIT_AMOUNT,
    "0x"
  );
  await tx6.wait();
  console.log(`Transferred ${SPLIT_AMOUNT.toString()} positionA (YES) tokens to seller: ${sellerAddress}`);
  console.log("");

  // =====================================================
  // Step 7 — Set approvals
  // =====================================================
  console.log("========== MANUAL APPROVAL STEPS (if keys not available below) ==========");
  console.log("BUYER must run:");
  console.log(`  ERC20(${collateralToken}).approve(${diamondAddress}, <amount>)`);
  console.log("");
  console.log("SELLER must run:");
  console.log(`  ERC1155(${diamondAddress}).setApprovalForAll(${diamondAddress}, true)`);
  console.log("==========================================================================\n");

  // Auto-approve using available keys — fall back to deployer key for buyer, taker key for seller
  const buyerKey = process.env.TEST_BUYER_KEY || process.env.PRIVATE_KEY;
  const sellerKey = process.env.TEST_SELLER_KEY || process.env.TAKER_PRIVATE_KEY;

  if (buyerKey) {
    try {
      const buyerSigner = new ethers.Wallet(buyerKey, ethers.provider);
      const erc20AsBuyer = mockERC20.connect(buyerSigner);
      const txApprove = await erc20AsBuyer.approve(diamondAddress, ethers.constants.MaxUint256);
      await txApprove.wait();
      console.log("ERC20 approval set for buyer:", buyerAddress);
    } catch (err) {
      console.warn("WARNING: ERC20 approval for buyer failed (fund wallet with ETH for gas):", err.message.split("\n")[0]);
    }
  }

  if (sellerKey) {
    try {
      const sellerSigner = new ethers.Wallet(sellerKey, ethers.provider);
      const erc1155AsSeller = erc1155.connect(sellerSigner);
      const txApproveAll = await erc1155AsSeller.setApprovalForAll(diamondAddress, true);
      await txApproveAll.wait();
      console.log("ERC1155 setApprovalForAll set for seller:", sellerAddress);
    } catch (err) {
      console.warn("WARNING: ERC1155 approval for seller failed (fund wallet with ETH for gas):", err.message.split("\n")[0]);
    }
  }
  console.log("");

  // =====================================================
  // Step 8 — Print backend configuration
  // =====================================================
  console.log("========== BACKEND TEST CONFIGURATION ==========");
  console.log("# Add these to your .env for E2E tests:");
  console.log("DIAMOND_ADDRESS=" + diamondAddress);
  console.log("CHAIN_ID=" + network.chainId);
  console.log("COLLATERAL_TOKEN=" + collateralToken);
  console.log("CONDITION_ID=" + conditionId);
  console.log("POSITION_ID_A=" + positionIdA);
  console.log("POSITION_ID_B=" + positionIdB);
  console.log("TEST_BUYER_ADDRESS=" + buyerAddress);
  console.log("TEST_SELLER_ADDRESS=" + sellerAddress);
  console.log("=================================================\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Setup failed:", error);
    process.exit(1);
  });
