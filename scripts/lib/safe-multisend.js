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
// Safe (v1.3+/v1.4) execution outcome events: execTransaction emits exactly one of them.
const { utils: ethersUtils, providers: ethersProviders } = require("ethers");
const EXECUTION_SUCCESS = ethersUtils.id("ExecutionSuccess(bytes32,uint256)");
const EXECUTION_FAILURE = ethersUtils.id("ExecutionFailure(bytes32,uint256)");

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

  // Execute — unless a co-signer already did from the Safe UI. On a multi-signer Safe the
  // service's copy carries every confirmation; the local object only has this signer's.
  let txHash;
  const confirmed = await apiKit.getTransaction(safeTxHash);
  if (confirmed.isExecuted && confirmed.transactionHash) {
    txHash = confirmed.transactionHash;
    console.log(`\n  Already executed by a co-signer: ${txHash}`);
  } else {
    console.log(`\n  Executing on-chain…`);
    try {
      const execResp = await protocolKit.executeTransaction(threshold > 1 ? confirmed : safeTransaction);
      txHash = execResp.hash || execResp.transactionResponse?.hash;
    } catch (err) {
      err.message =
        `${err.message}\n  The Safe tx ${safeTxHash} is proposed and fully confirmed but NOT executed. ` +
        "Execute it from the Safe UI or reject it there (a rejection uses the same nonce) before re-running.";
      throw err;
    }
  }

  // protocol-kit does not throw on a reverted receipt, and Safe.execTransaction succeeds at the
  // outer level even when the inner MultiSend fails (ExecutionFailure). Check both.
  const provider = new ethersProviders.JsonRpcProvider(rpcUrl);
  const receipt = await provider.waitForTransaction(txHash, 1, 10 * 60 * 1000);
  if (!receipt || receipt.status !== 1) throw new Error(`Safe execution tx ${txHash} reverted (status ${receipt && receipt.status})`);
  const fromSafe = receipt.logs.filter((l) => l.address.toLowerCase() === safeAddress.toLowerCase());
  if (fromSafe.some((l) => l.topics[0] === EXECUTION_FAILURE) || !fromSafe.some((l) => l.topics[0] === EXECUTION_SUCCESS)) {
    throw new Error(`Safe tx ${safeTxHash} executed in ${txHash} but the inner calls FAILED (no ExecutionSuccess) — nothing was applied`);
  }

  console.log(`  ✅ Executed: ${txHash} (block ${receipt.blockNumber}, ExecutionSuccess)`);
  return { safeTxHash, executionTxHash: txHash, blockNumber: receipt.blockNumber };
}

/**
 * Read-only Safe pre-flight, to run BEFORE deploying anything: the Transaction Service answers,
 * `signer` is an owner, and no proposal is already queued (a queued tx at the next nonce would
 * conflict with the new proposal).
 */
async function safePreflight({ safeAddress, chainId, signer }) {
  const SafeApiKit = require("@safe-global/api-kit").default;
  const apiKit = new SafeApiKit({ chainId: BigInt(chainId) });
  const info = await apiKit.getSafeInfo(safeAddress);
  const pending = await apiKit.getPendingTransactions(safeAddress);
  const isOwner = info.owners.map((o) => o.toLowerCase()).includes(signer.toLowerCase());
  return { owners: info.owners, threshold: Number(info.threshold), nonce: Number(info.nonce), version: info.version, pending: pending.count, isOwner };
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

module.exports = { proposeAndExecute, safePreflight, safeNetworkPrefix };
