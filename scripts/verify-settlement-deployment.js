const { ethers } = require("hardhat");

async function main() {
  const diamondAddress = process.env.DIAMOND_ADDRESS;
  if (!diamondAddress) {
    throw new Error(
      "Set DIAMOND_ADDRESS environment variable to the deployed diamond address"
    );
  }

  console.log("Verifying deployment at:", diamondAddress);
  console.log("Network:", (await ethers.provider.getNetwork()).chainId);
  console.log("");

  // 1. Check Diamond Loupe -- how many facets are registered
  const loupe = await ethers.getContractAt("IDiamondLoupe", diamondAddress);
  const facets = await loupe.facets();
  console.log("Total facets registered:", facets.length);
  let totalSelectors = 0;
  for (const f of facets) {
    console.log(
      "  Facet",
      f.facetAddress,
      "->",
      f.functionSelectors.length,
      "selectors"
    );
    totalSelectors += f.functionSelectors.length;
  }
  console.log("Total selectors:", totalSelectors);
  console.log("");

  // 2. Check SettlementFacet
  const settlement = await ethers.getContractAt("ISettlement", diamondAddress);
  const operator = await settlement.getOperator();
  const paused = await settlement.isTradingPaused();
  const zeroFill = await settlement.getFilledAmount(ethers.constants.HashZero);
  console.log("SettlementFacet:");
  console.log("  Operator:", operator);
  console.log("  Trading paused:", paused);
  console.log("  Zero hash fill amount:", zeroFill.toString());

  if (operator === ethers.constants.AddressZero) {
    console.log(
      "  WARNING: Operator is zero address. Call setOperator() before testing."
    );
  } else {
    console.log("  Operator is set");
  }
  console.log("");

  // 3. Check SignatureVerifierFacet
  const verifier = await ethers.getContractAt(
    "ISignatureVerifier",
    diamondAddress
  );
  const domainSep = await verifier.getDomainSeparator();
  console.log("SignatureVerifierFacet:");
  console.log("  Domain separator:", domainSep);
  console.log("  Accessible");
  console.log("");

  // 4. Check NonceManagerFacet
  const nonce = await ethers.getContractAt("INonceManager", diamondAddress);
  const zeroNonce = await nonce.getNonce(ethers.constants.AddressZero);
  const zeroCancelled = await nonce.isCancelled(ethers.constants.HashZero);
  console.log("NonceManagerFacet:");
  console.log("  Zero address nonce:", zeroNonce.toString());
  console.log("  Zero hash cancelled:", zeroCancelled);
  console.log("  Accessible");
  console.log("");

  // 5. Check ownership
  const ownership = await ethers.getContractAt(
    "OwnershipFacet",
    diamondAddress
  );
  const owner = await ownership.owner();
  console.log("Diamond owner:", owner);
  console.log("");

  // Summary
  console.log("========== VERIFICATION COMPLETE ==========");
  console.log("All v2.1 settlement facets are accessible.");
  if (operator !== ethers.constants.AddressZero && !paused) {
    console.log("Ready for settlement testing.");
  } else {
    if (operator === ethers.constants.AddressZero)
      console.log("WARNING: setOperator() still needed.");
    if (paused) console.log("WARNING: Trading is paused. Call unpauseTrading().");
  }
  console.log("===========================================");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Verification failed:", error);
    process.exit(1);
  });
