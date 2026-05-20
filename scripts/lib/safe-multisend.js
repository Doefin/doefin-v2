/* global ethers */
/**
 * Safe MultiSend helper — propose, wait for confirmations, execute.
 *
 * Bundles N owner-only calls into a single Safe transaction (uses
 * MultiSendCallOnly under the hood, so each inner call is a plain CALL whose
 * msg.sender is the Safe address — which is exactly what
 * LibDiamond.enforceIsContractOwner() expects when the Safe is the Diamond owner).
 *
 * Returns the hash of the on-chain execution transaction once the Safe
 * threshold has been met. On 1-of-1 Safes this is effectively synchronous;
 * on N-of-M Safes the function polls the Safe Transaction Service until the
 * remaining signers confirm via the Safe app.
 *
 * Usage:
 *   const { proposeAndExecute } = require("./lib/safe-multisend");
 *   await proposeAndExecute({
 *     safeAddress: process.env.SAFE_ADDRESS,
 *     chainId: 84532,
 *     rpcUrl: process.env.BASE_SEPOLIA_RPC_ENDPOINT,
 *     signerKey: process.env.PRIVATE_KEY,
 *     transactions: [
 *       { to: diamondAddr, data: cutCalldata },
 *       { to: diamondAddr, data: setOperatorCalldata },
 *       ...
 *     ],
 *   });
 */

const POLL_INTERVAL_MS = 15_000;
const POLL_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function proposeAndExecute({
  safeAddress,
  chainId,
  rpcUrl,
  signerKey,
  transactions,
  label = "Safe MultiSend",
}) {
  if (!safeAddress) throw new Error("safeAddress required");
  if (!rpcUrl) throw new Error("rpcUrl required");
  if (!signerKey) throw new Error("signerKey required");
  if (!Array.isArray(transactions) || transactions.length === 0) {
    throw new Error("transactions must be a non-empty array");
  }

  // Lazy-load so the script still parses even if @safe-global/* isn't installed
  // yet (helps `--help` and similar).
  const Safe = require("@safe-global/protocol-kit").default;
  const SafeApiKit = require("@safe-global/api-kit").default;

  const protocolKit = await Safe.init({
    provider: rpcUrl,
    signer: signerKey,
    safeAddress,
  });

  const apiKit = new SafeApiKit({ chainId: BigInt(chainId) });

  const deployerAddress = await protocolKit.getSafeProvider().getSignerAddress();
  const owners = await protocolKit.getOwners();
  const threshold = await protocolKit.getThreshold();

  console.log(`\n  Safe: ${safeAddress}`);
  console.log(`  Threshold: ${threshold}-of-${owners.length}`);
  console.log(`  Proposer (this script): ${deployerAddress}`);

  if (!owners.map((o) => o.toLowerCase()).includes(deployerAddress.toLowerCase())) {
    throw new Error(
      `Deployer ${deployerAddress} is not a signer on Safe ${safeAddress}. ` +
        `Cannot propose. Owners: ${owners.join(", ")}`
    );
  }

  console.log(`\n  Building MultiSend with ${transactions.length} inner call(s):`);
  transactions.forEach((tx, i) => {
    console.log(`    [${i}] to=${tx.to} data=${tx.data.slice(0, 10)}… (${(tx.data.length - 2) / 2} bytes)`);
  });

  // Build the Safe transaction. SDK auto-batches via MultiSendCallOnly when
  // more than one inner tx is passed.
  const safeTransaction = await protocolKit.createTransaction({
    transactions: transactions.map((tx) => ({
      to: tx.to,
      value: (tx.value ?? "0").toString(),
      data: tx.data,
      operation: 0, // CALL
    })),
  });

  const safeTxHash = await protocolKit.getTransactionHash(safeTransaction);
  console.log(`\n  Safe tx hash: ${safeTxHash}`);

  // Sign as the deployer
  const signedTx = await protocolKit.signTransaction(safeTransaction);
  const senderSig =
    signedTx.signatures.get(deployerAddress.toLowerCase()) ||
    signedTx.signatures.get(deployerAddress);

  if (!senderSig) {
    throw new Error("Failed to obtain deployer signature for Safe tx");
  }

  // Propose to the Safe Transaction Service
  await apiKit.proposeTransaction({
    safeAddress,
    safeTransactionData: safeTransaction.data,
    safeTxHash,
    senderAddress: deployerAddress,
    senderSignature: senderSig.data,
  });

  console.log(`\n  ✅ Proposed "${label}" — visible at:`);
  console.log(`     https://app.safe.global/transactions/queue?safe=${safeNetworkPrefix(chainId)}:${safeAddress}`);

  // Poll until threshold reached
  console.log(`\n  Waiting for confirmations…`);
  const startedAt = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
      throw new Error(
        `Timed out after ${POLL_TIMEOUT_MS / 60_000} minutes waiting for Safe confirmations. ` +
          `Safe tx hash: ${safeTxHash}. You can execute manually from the Safe UI once threshold is met.`
      );
    }

    const txInfo = await apiKit.getTransaction(safeTxHash);
    const confs = txInfo.confirmations?.length ?? 0;
    process.stdout.write(`    confirmations: ${confs}/${threshold}\r`);

    if (confs >= threshold) {
      process.stdout.write("\n");
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  // Execute
  console.log(`\n  Executing on-chain…`);
  const execResp = await protocolKit.executeTransaction(safeTransaction);
  const txHash = execResp.hash || execResp.transactionResponse?.hash;
  if (execResp.transactionResponse?.wait) {
    await execResp.transactionResponse.wait();
  }

  console.log(`  ✅ Executed: ${txHash}`);
  return { safeTxHash, executionTxHash: txHash };
}

/** Map chainId → Safe app network prefix used in the UI URLs. */
function safeNetworkPrefix(chainId) {
  const id = Number(chainId);
  if (id === 1) return "eth";
  if (id === 8453) return "base";
  if (id === 84532) return "basesep";
  if (id === 42161) return "arb1";
  if (id === 421614) return "arbsep";
  return `chain-${id}`;
}

module.exports = { proposeAndExecute, safeNetworkPrefix };
