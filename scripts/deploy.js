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

  console.log("Deploying contracts with the account:", contractOwner.address);

  // deploy DiamondCutFacet
  const DiamondCutFacet = await ethers.getContractFactory("DiamondCutFacet");
  const diamondCutFacet = await DiamondCutFacet.deploy();
  await diamondCutFacet.deployed();
  console.log("DiamondCutFacet deployed:", diamondCutFacet.address);
  await verifyContract(diamondCutFacet.address);

  // deploy Diamond
  const Diamond = await ethers.getContractFactory("Diamond");
  const diamond = await Diamond.deploy(
    contractOwner.address,
    diamondCutFacet.address
  );
  await diamond.deployed();
  console.log("Diamond deployed:", diamond.address);
  await verifyContract(diamond.address, [contractOwner.address, diamondCutFacet.address]);

  // deploy DiamondInit
  // DiamondInit provides a function that is called when the diamond is upgraded to initialize state variables
  // Read about how the diamondCut function works here: https://eips.ethereum.org/EIPS/eip-2535#addingreplacingremoving-functions

  const DiamondInit = await ethers.getContractFactory("DiamondInit");
  const diamondInit = await DiamondInit.deploy();
  await diamondInit.deployed();
  console.log("DiamondInit deployed:", diamondInit.address);
  await verifyContract(diamondInit.address);

  // deploy facets
  console.log("");
  console.log("Deploying facets");
  const FacetNames = [
    "DiamondLoupeFacet",
    "OwnershipFacet",
    "ERC1155Facet",
    "ERC1155ReceiverFacet",
    "ConditionalTokensFacet",
    "ConditionManagerFacet",
    "AccessControlFacet",
    "AdminConfigFacet",
    "ExchangeFacet",
    "MarketExecutionFacet",
    "RouteSimulationFacet",
    "MarketDataFacet",
  ];
  const cut = [];
  for (const FacetName of FacetNames) {
    const Facet = await ethers.getContractFactory(FacetName);
    const facet = await Facet.deploy();
    await facet.deployed();
    console.log(`${FacetName} deployed: ${facet.address}`);
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
    console.log("Completed diamond cut");
  } catch (err) {
    console.error("Diamond cut failed:", err);
    throw err;
  }

  // Verify facets after deployment
  try {
    const loupe = await ethers.getContractAt("DiamondLoupeFacet", diamond.address);
    const facets = await loupe.facets();
    console.log("Facets registered in diamond:", facets);
  } catch (loupeErr) {
    console.error("Error reading facets from loupe:", loupeErr);
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
