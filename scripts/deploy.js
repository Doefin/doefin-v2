/* global ethers */
/* eslint prefer-const: "off" */

const { getSelectors, FacetCutAction } = require("./libraries/diamond.js");
const hre = require("hardhat");

async function verifyContract(address, constructorArguments = []) {
  try {
    await hre.run("verify:verify", {
      address,
      constructorArguments,
    });
    console.log(`✔️ Verified: ${address}`);
  } catch (err) {
    console.warn(`⚠️ Verification skipped for ${address}:`, err.message);
  }
}

async function deployDiamond() {
  const accounts = await ethers.getSigners();
  const contractOwner = accounts[0];
  const provider = ethers.provider;

  console.log("Deploying contracts with the account:", contractOwner.address);

  // deploy DiamondCutFacet
  const DiamondCutFacet = await ethers.getContractFactory("DiamondCutFacet");
  const diamondCutFacet = await DiamondCutFacet.deploy();
  await diamondCutFacet.deployed();
  console.log("DiamondCutFacet deployed:", diamondCutFacet.address);
  
  // Wait for additional confirmations to ensure contract is fully deployed
  console.log("Waiting for additional confirmations...");
  await diamondCutFacet.deployTransaction.wait(2); // Wait for 2 confirmations
  
  // Verify contract has code deployed
  const code = await provider.getCode(diamondCutFacet.address);
  if (code === "0x") {
    throw new Error(`DiamondCutFacet has no code at address ${diamondCutFacet.address}`);
  }
  console.log("DiamondCutFacet contract verified with code");
  
  await verifyContract(diamondCutFacet.address);

  // deploy Diamond
  const Diamond = await ethers.getContractFactory("Diamond");
  const diamond = await Diamond.deploy(
    contractOwner.address,
    diamondCutFacet.address
  );
  await diamond.deployed();
  console.log("Diamond deployed:", diamond.address);
  
  // Wait for additional confirmations to ensure contract is fully deployed
  console.log("Waiting for Diamond deployment confirmations...");
  await diamond.deployTransaction.wait(2); // Wait for 2 confirmations
  
  // Verify contract has code deployed
  const diamondCode = await provider.getCode(diamond.address);
  if (diamondCode === "0x") {
    throw new Error(`Diamond has no code at address ${diamond.address}`);
  }
  console.log("Diamond contract verified with code");
  
  await verifyContract(diamond.address, [contractOwner.address, diamondCutFacet.address]);

  // deploy DiamondInit
  // DiamondInit provides a function that is called when the diamond is upgraded to initialize state variables
  // Read about how the diamondCut function works here: https://eips.ethereum.org/EIPS/eip-2535#addingreplacingremoving-functions

  const DiamondInit = await ethers.getContractFactory("DiamondInit");
  const diamondInit = await DiamondInit.deploy();
  await diamondInit.deployed();
  console.log("DiamondInit deployed:", diamondInit.address);
  
  // Wait for additional confirmations to ensure contract is fully deployed
  console.log("Waiting for DiamondInit deployment confirmations...");
  await diamondInit.deployTransaction.wait(2);
  
  // Verify contract has code deployed
  const diamondInitCode = await provider.getCode(diamondInit.address);
  if (diamondInitCode === "0x") {
    throw new Error(`DiamondInit has no code at address ${diamondInit.address}`);
  }
  console.log("DiamondInit contract verified with code");
  
  await verifyContract(diamondInit.address);

  // deploy facets
  console.log("");
  console.log("Deploying facets");

  const BlockHeaderUtilsLib = await ethers.getContractFactory("BlockHeaderUtils");
  const blockHeaderUtils = await BlockHeaderUtilsLib.deploy();
  await blockHeaderUtils.deployed();
  console.log("BlockHeaderUtils deployed:", blockHeaderUtils.address);
  
  // Wait for confirmations
  await blockHeaderUtils.deployTransaction.wait(2);
  const blockHeaderUtilsCode = await provider.getCode(blockHeaderUtils.address);
  if (blockHeaderUtilsCode === "0x") {
    throw new Error(`BlockHeaderUtils has no code at address ${blockHeaderUtils.address}`);
  }
  
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
    "OrderCreationFacet", // Split from ExchangeFacet to reduce size
    "OrderManagementFacet", // Split from ExchangeFacet to reduce size
    "ExchangeViewFacet", // Read-only exchange queries
    "MarketExecutionFacet",
    "RouteSimulationFacet",
    "MarketDataFacet",
    "OracleAdapterFacet",
    "OracleManagerFacet",
  ];
  const cut = [];
  for (const FacetName of FacetNames) {
    const factories = FacetName === "DoefinV1BlockHeaderOracle"
      ? await ethers.getContractFactory(FacetName, {
          libraries: { BlockHeaderUtils: blockHeaderUtils.address },
        })
      : await ethers.getContractFactory(FacetName);

    const facet = await factories.deploy();
    await facet.deployed();
    console.log(`${FacetName} deployed: ${facet.address}`);
    
    // Wait for confirmations and verify code exists
    await facet.deployTransaction.wait(2);
    const facetCode = await provider.getCode(facet.address);
    if (facetCode === "0x") {
      throw new Error(`${FacetName} has no code at address ${facet.address}`);
    }
    
    await verifyContract(facet.address);
    cut.push({
      facetAddress: facet.address,
      action: FacetCutAction.Add,
      functionSelectors: getSelectors(facet),
    });
  }

  // upgrade diamond with facets
  console.log("");
  console.log("Diamond Cut:", cut);
  const diamondCut = await ethers.getContractAt("IDiamondCut", diamond.address);
  let tx;
  let receipt;
  // call to init function
  let functionCall;
  try {
    functionCall = diamondInit.interface.encodeFunctionData("init", [contractOwner.address]);
  } catch (e) {
    console.error("Error encoding initializer:", e);
    throw e;
  }
  try {
    tx = await diamondCut.diamondCut(cut, diamondInit.address, functionCall, { gasLimit: 8000000 });
    console.log("Diamond cut tx: ", tx.hash);
    receipt = await tx.wait();
    if (!receipt.status) {
      console.error("Diamond cut transaction failed:", receipt);
      throw Error(`Diamond upgrade failed: ${tx.hash}`);
    }
    console.log("✅ Completed diamond cut successfully");
    console.log(`   Gas used: ${receipt.gasUsed.toString()}`);
    console.log(`   Block: ${receipt.blockNumber}`);
  } catch (err) {
    console.error("Diamond cut failed:", err);
    throw err;
  }

  // Verify facets after deployment
  try {
    // Wait a bit for the diamond cut to be fully processed
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Try to get the loupe interface
    const loupe = await ethers.getContractAt("DiamondLoupeFacet", diamond.address);
    
    // Test if the interface is accessible first
    console.log("Testing if DiamondLoupe interface is accessible...");
    const facets = await loupe.facets();
    console.log("✅ Facets registered in diamond:", facets.length);
    
    // Show first few facets for verification
    facets.slice(0, 3).forEach((facet, i) => {
      console.log(`  Facet ${i + 1}: ${facet.facetAddress} with ${facet.functionSelectors.length} functions`);
    });
  } catch (loupeErr) {
    console.warn("⚠️ Warning: Could not read facets from loupe (this may be normal):", loupeErr.message);
    
    // Try a more direct approach to verify diamond is working
    try {
      const diamondOwner = await ethers.getContractAt("OwnershipFacet", diamond.address);
      const owner = await diamondOwner.owner();
      console.log("✅ Diamond is functional - owner is:", owner);
    } catch (ownerErr) {
      console.error("❌ Diamond may not be properly initialized:", ownerErr.message);
    }
  }

  return diamond.address;
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
if (require.main === module) {
  deployDiamond()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

exports.deployDiamond = deployDiamond;
