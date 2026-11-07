/* global ethers */
/**
 * SCRUM-560 — the SCRUM-559 market-order cut and its rollback, rehearsed on a local fork of Base Sepolia.
 *
 * Applies upgrade-scrum559-market-orders.js and rollback-scrum559-market-orders.js to the live state
 * with the owner impersonated, then settles on real collateral through real Safe 1.4.1 wallets with
 * signature type 1, the way the backend submits. Checks, in order:
 *   - the refusals: Base mainnet, a cut plan other than Replace 3 and Add 0, a build that is not clean;
 *   - before the cut: a limit order is half filled, and a marked order is overcharged, which is why
 *     MARKET_ORDERS_ENABLED stays off until the cut has landed;
 *   - the cut: a settlement landing between the cut and the post-check is tolerated, the record and
 *     the kept build-info read back correctly, and a second run refuses;
 *   - after the cut: the limit order signed before it settles; a limit taker's non-crossing leg is
 *     InvalidMatch; a far-leg market taker settles; a marked taker whose fee breaks the all-in reverts
 *     TakerPriceBreached; a marked order as a maker and in fillOrder reverts OrderCancelled; a seller
 *     with no allowance settles;
 *   - market orders settle at the exact all-in, and one raw tighter reverts, on all three paths on both
 *     collaterals; nonce, salt floor and cancelOrder stop a marked order;
 *   - the Safe route: the cut and the rollback through the real owner Safe's execTransaction on the
 *     fork. Only the Safe service is left out, because a proposal must not be created by a rehearsal;
 *   - the rollback: it refuses without the switch-off confirmation and on a wrong record, it restores
 *     the routing exactly, fills and accrued fees are retained, every behaviour matches before the cut,
 *     and a marked order is overcharged inside its expiry but reverts past it, which is why the switch
 *     goes off and expiry is waited out first.
 *
 * Run:  npm run upgrade:scrum559:rehearse:sepolia
 * Needs BASE_SEPOLIA_RPC_ENDPOINT. FORK_BLOCK_NUMBER pins the fork, otherwise it forks LOOKBACK blocks
 * (default 5) behind the tip. Never sends anything to a live network and writes nothing under
 * deployments/: records go to a temp dir, read back, then removed.
 */

const hre = require("hardhat");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { runUpgrade, CUT_SELECTORS, COLLATERALS, FacetCutAction, refuseMainnet, impersonate, readRouting, routingDiff, _test } = require("./upgrade-scrum559-market-orders.js");
const { runRollback } = require("./rollback-scrum559-market-orders.js");
const { BASE_MAINNET_DIAMOND, BASE_SEPOLIA_DIAMOND } = require("./upgrade-scrum521-oracle-reorg-underflow.js");
const { SAFE, safeInterface, BUY, SELL, MARKET_ORDER_MARKER, pad, toBigInt, ceilDiv, snapshotted, decodeRevert } = require("../../test/utils/safeSettlementFixture.js");

const { network } = hre;
const Z = ethers.constants.AddressZero;
const H0 = ethers.constants.HashZero;
const MAX = ethers.constants.MaxUint256;
const BASE_SEPOLIA_CHAIN_ID = 84532;
const HUNDRED_ETH = "0x56BC75E2D63100000";
const FEE_BPS = 40n; // Under the Diamond's 100 bps cap. At 0.40 it turns signed 400000 into charged 401600.
const fee40 = (cash) => (cash * FEE_BPS) / 10000n;

const ORDER_TYPE = {
  DoefinOrder: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "positionId", type: "bytes32" },
    { name: "collateralToken", type: "address" },
    { name: "side", type: "uint8" },
    { name: "amount", type: "uint128" },
    { name: "pricePerToken", type: "uint128" },
    { name: "expiration", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
};
const FACTORY_ABI = ["function createProxyWithNonce(address,bytes,uint256) returns (address)", "event ProxyCreation(address indexed proxy, address singleton)"];
const OWNER_SAFE_ABI = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function VERSION() view returns (string)",
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns (bytes32)",
  "function approveHash(bytes32)",
  "function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) payable returns (bool)",
];
const EXECUTION_SUCCESS = ethers.utils.id("ExecutionSuccess(bytes32,uint256)");

let passed = 0;
const failed = [];
function check(ok, msg) {
  if (ok) passed++;
  else failed.push(msg);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}`);
}
const section = (title) => console.log(`\n=== ${title} ===`);

/** Null when `fn` refuses with `needle` in its message, otherwise what happened instead. */
async function refusal(fn, needle) {
  try {
    await fn();
    return "did not refuse";
  } catch (e) {
    const text = String(e.message || e);
    return text.includes(needle) ? null : `refused for another reason: ${text.slice(0, 240)}`;
  }
}

/** Run `fn`, keeping what it logged. */
async function capturingLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    lines.push(args.join(" "));
    original(...args);
  };
  try {
    return { result: await fn(), log: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

function listDeployments(dir = path.join(hre.config.paths.root, "deployments"), out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listDeployments(full, out);
    else out.push(full);
  }
  return out.sort();
}

async function forkBaseSepolia() {
  const rpc = process.env.BASE_SEPOLIA_RPC_ENDPOINT;
  if (!rpc) throw new Error("BASE_SEPOLIA_RPC_ENDPOINT is required to fork Base Sepolia");
  const live = new ethers.providers.StaticJsonRpcProvider(rpc);
  const { chainId } = await live.getNetwork();
  if (chainId !== BASE_SEPOLIA_CHAIN_ID) throw new Error(`BASE_SEPOLIA_RPC_ENDPOINT serves chain ${chainId}, expected ${BASE_SEPOLIA_CHAIN_ID}`);
  const blockNumber = process.env.FORK_BLOCK_NUMBER ? Number(process.env.FORK_BLOCK_NUMBER) : (await live.getBlockNumber()) - Number(process.env.LOOKBACK || 5);
  await network.provider.request({ method: "hardhat_reset", params: [{ forking: { jsonRpcUrl: rpc, blockNumber } }] });
  await network.provider.send("evm_mine"); // See rehearse-scrum521-fork.js: run on a local block
  return blockNumber;
}

/** Set `holder`'s balance of a standard ERC-20 by finding its balance mapping slot (fork only). */
async function deal(token, holder, amount) {
  const contract = await ethers.getContractAt("MockERC20", token);
  const value = ethers.utils.hexZeroPad(ethers.BigNumber.from(amount.toString()).toHexString(), 32);
  for (let slot = 0; slot < 60; slot++) {
    for (const [types, values] of [[["address", "uint256"], [holder, slot]], [["uint256", "address"], [slot, holder]]]) {
      const key = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(types, values));
      const original = await ethers.provider.getStorageAt(token, key);
      await network.provider.send("hardhat_setStorageAt", [token, key, value]);
      if (toBigInt(await contract.balanceOf(holder)) === BigInt(amount)) return;
      await network.provider.send("hardhat_setStorageAt", [token, key, ethers.utils.hexZeroPad(original, 32)]);
    }
  }
  throw new Error(`Could not find the balance slot of ${token}`);
}

/**
 * The Safe route without the Safe service: the same single inner call the SDK would build (one
 * transaction is a plain CALL, not a MultiSend) runs through the real owner Safe's execTransaction,
 * approved by its real owners, who are impersonated on this fork.
 */
function forkSafeClient() {
  const safeAt = (address) => new ethers.Contract(address, OWNER_SAFE_ABI, ethers.provider);
  return {
    preflight: async ({ safeAddress }) => {
      const safe = safeAt(safeAddress);
      const [owners, threshold, nonce, version] = await Promise.all([safe.getOwners(), safe.getThreshold(), safe.nonce(), safe.VERSION()]);
      return { owners, threshold: threshold.toNumber(), nonce: nonce.toNumber(), version, pending: 0, isOwner: true };
    },
    proposeAndExecute: async ({ safeAddress, transactions }) => {
      if (transactions.length !== 1) throw new Error("This cut is one inner call");
      const [{ to, data }] = transactions;
      const safe = safeAt(safeAddress);
      const safeTxHash = await safe.getTransactionHash(to, 0, data, 0, 0, 0, 0, Z, Z, await safe.nonce());
      const threshold = (await safe.getThreshold()).toNumber();
      const signers = [...(await safe.getOwners())].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)).slice(0, threshold);
      for (const owner of signers) await (await safe.connect(await impersonate(owner)).approveHash(safeTxHash)).wait();
      const signatures = ethers.utils.hexConcat(signers.flatMap((owner) => [ethers.utils.hexZeroPad(owner, 32), H0, "0x01"]));
      const [relayer] = await ethers.getSigners();
      const receipt = await (await safe.connect(relayer).execTransaction(to, 0, data, 0, 0, 0, 0, Z, Z, signatures, { gasLimit: 2_000_000 })).wait();
      if (!receipt.logs.some((l) => l.address.toLowerCase() === safeAddress.toLowerCase() && l.topics[0] === EXECUTION_SUCCESS)) throw new Error("No ExecutionSuccess from the owner Safe");
      return { safeTxHash, executionTxHash: receipt.transactionHash, blockNumber: receipt.blockNumber };
    },
  };
}

async function main() {
  if (network.name !== "hardhat") throw new Error(`Run on the in-process hardhat network (the script forks Base Sepolia itself), not "${network.name}"`);
  // hardhat.config.js loads .env, and a ceremony variable left in it must not steer a rehearsal.
  for (const k of ["DRY_RUN", "SKIP_VERIFY", "DIAMOND_ADDRESS", "NEW_SETTLEMENT_FACET_ADDRESS", "MARKET_ORDERS_OFF_CONFIRMED", "ROLLBACK_RECORD"]) delete process.env[k];
  const deploymentsBefore = listDeployments();

  const forkBlock = await forkBaseSepolia();
  const d = BASE_SEPOLIA_DIAMOND;
  if ((await ethers.provider.getCode(d)) === "0x") throw new Error("No Diamond bytecode — fork failed");
  const at = (n) => ethers.getContractAt(n, d);
  const loupe = await at("IDiamondLoupe");
  const settlementAdmin = await at("SettlementAdminFacet");
  const adminConfig = await at("AdminConfigFacet");
  const settlement = await at("SettlementFacet");
  const verifier = await at("SignatureVerifierFacet");
  const erc1155 = await at("ERC1155Facet");
  const ctf = await at("ConditionalTokensFacet");
  const condMgr = await at("ConditionManagerFacet");
  const nonceMgr = await at("NonceManagerFacet");
  const marketData = await at("MarketDataFacet");
  const ownerAddress = await (await at("OwnershipFacet")).owner();
  const operatorAddress = await settlementAdmin.getOperator();
  const ownerSigner = await impersonate(ownerAddress);
  const operator = await impersonate(operatorAddress);
  const ownerSafe = new ethers.Contract(ownerAddress, OWNER_SAFE_ABI, ethers.provider);
  const safeSummary = `${(await ownerSafe.getThreshold()).toString()}-of-${(await ownerSafe.getOwners()).length} v${await ownerSafe.VERSION()}, signer(s) ${(await ownerSafe.getOwners()).join(", ")}`;

  console.log("==========================================================");
  console.log("  SCRUM-560 — market-order cut and rollback, Base Sepolia fork rehearsal");
  console.log("==========================================================");
  console.log(`  Fork block ${forkBlock}  Diamond ${d}`);
  console.log(`  Owner ${ownerAddress} (${safeSummary})`);
  console.log(`  Operator ${operatorAddress}  max fee ${await adminConfig.getMaxFeeRate()} bps  paused ${await settlementAdmin.isTradingPaused()}`);

  // ---------------------------------------------------------------- refusals
  section("Refusals");
  const refusesMainnet = (args) => {
    try {
      refuseMainnet(args);
      return false;
    } catch (e) {
      return e.message.startsWith("Refusing Base mainnet");
    }
  };
  check(refusesMainnet({ name: "base" }), "refuses Base mainnet by network name");
  check(refusesMainnet({ name: "localhost", chainId: 8453 }), "refuses Base mainnet by chain ID");
  check(refusesMainnet({ name: "hardhat", chainId: 31337, diamond: BASE_MAINNET_DIAMOND }), "refuses Base mainnet by Diamond, so a mainnet fork is refused too");
  check(!refusesMainnet({ name: "baseSepolia", chainId: BASE_SEPOLIA_CHAIN_ID, diamond: BASE_SEPOLIA_DIAMOND }), "does not refuse Base Sepolia");
  let err = await refusal(() => runUpgrade({ diamond: BASE_MAINNET_DIAMOND, dryRun: true }), "Refusing Base mainnet");
  check(err === null, `runUpgrade refuses the mainnet Diamond${err ? `: ${err}` : ""}`);

  const blockBeforeDry = await ethers.provider.getBlockNumber();
  const dry = await runUpgrade({ diamond: d, dryRun: true });
  const { plan, build } = dry;
  const cutNames = plan.replace.map((s) => s.name).sort().join(", ");
  check(cutNames === Object.keys(CUT_SELECTORS).sort().join(", ") && plan.add.length === 0, `the plan is Replace ${plan.replace.length} (${cutNames}), Add ${plan.add.length}`);
  check(plan.oldFacets.length === 1 && plan.stranded.length === 0, `all three sit on one facet (${plan.oldFacets[0]}), none stranded`);
  check((await ethers.provider.getBlockNumber()) === blockBeforeDry && JSON.stringify(listDeployments()) === JSON.stringify(deploymentsBefore), "DRY_RUN sends nothing and writes no record");

  const other = { name: "somethingElse", selector: "0x12345678" };
  const badPlans = {
    "an Add": { ...plan, add: [other] },
    "a selector missing": { ...plan, replace: plan.replace.slice(1) },
    "an extra Replace": { ...plan, replace: [...plan.replace, other] },
    "two old facets": { ...plan, oldFacets: [...plan.oldFacets, "0x0000000000000000000000000000000000000001"] },
    "a stranded selector": { ...plan, stranded: [{ facet: plan.oldFacets[0], selector: other.selector }] },
  };
  check(_test.planProblems(plan).length === 0, "the live plan has no differences from Replace 3, Add 0");
  for (const [label, bad] of Object.entries(badPlans)) check(_test.planProblems(bad).length > 0, `refuses a plan with ${label}`);
  // The same refusal end to end, on the live Diamond with its routing changed in a snapshot.
  const ownerCutter = (await at("IDiamondCut")).connect(ownerSigner);
  const changedRouting = [
    ["a selector is not routed, so the plan would be Replace 2, Add 1", { facetAddress: Z, action: FacetCutAction.Remove, functionSelectors: [CUT_SELECTORS.getFilledAmount] }],
    ["the old facet also serves a selector the new ABI lacks", { facetAddress: plan.oldFacets[0], action: FacetCutAction.Add, functionSelectors: [other.selector] }],
  ];
  for (const [label, change] of changedRouting) {
    await snapshotted(async () => {
      await (await ownerCutter.diamondCut([change], Z, "0x")).wait();
      const block = await ethers.provider.getBlockNumber();
      err = await refusal(() => runUpgrade({ diamond: d }), "must be Replace 3 and Add 0");
      check(err === null && (await ethers.provider.getBlockNumber()) === block, `refuses before sending anything when ${label}${err ? `: ${err}` : ""}`);
    });
  }

  const info = JSON.parse(fs.readFileSync(build.file));
  const artifact = await hre.artifacts.readArtifact("SettlementFacet");
  const clean = { buildInfoCount: 1, info, artifact, onDisk: _test.listSources(), readSource: _test.readSource, compiler: _test.configuredCompiler() };
  const { [artifact.sourceName]: _facetSource, ...withoutFacet } = info.input.sources;
  check(_test.buildProblems(clean).length === 0, `the build is clean: one build-info ${build.id}, ${build.sources} sources matching the disk, solc ${build.solc}`);
  check(_test.buildProblems({ ...clean, buildInfoCount: 2 }).length > 0, "refuses two build-infos (a partial compile left beside a full one)");
  check(_test.buildProblems({ ...clean, info: { ...info, input: { ...info.input, sources: withoutFacet } } }).length > 0, "refuses a build that left out a source");
  check(_test.buildProblems({ ...clean, readSource: (s) => (s === artifact.sourceName ? "edited since the build" : _test.readSource(s)) }).length > 0, "refuses a source edited after the build");
  check(_test.buildProblems({ ...clean, artifact: { ...artifact, deployedBytecode: "0x00" } }).length > 0, "refuses an artifact that is not this build's output");
  check(_test.buildProblems({ ...clean, info: { ...info, input: { ...info.input, settings: { ...info.input.settings, optimizer: { enabled: true, runs: 1 } } } } }).length > 0, "refuses a build made with other compiler settings");
  console.log(`  Facet: ${build.facetBytes} bytes (init ${build.facetInitBytes}), runtime keccak ${build.facetRuntimeKeccak}`);

  // ---------------------------------------------------------------- the world
  section("Worlds: real Safes and real collateral on the fork");
  for (const part of ["singleton", "factory", "handler"]) {
    const live = await ethers.provider.getCode(SAFE[part].address);
    check(live.toLowerCase() === SAFE[part].code.toLowerCase(), `Safe 1.4.1 ${part} is live at ${SAFE[part].address}`);
  }
  const { chainId } = await ethers.provider.getNetwork();
  const domain = { name: "Doefin Exchange", version: "3", chainId, verifyingContract: d };
  check(ethers.utils._TypedDataEncoder.hashDomain(domain) === (await verifier.getDomainSeparator()), "EIP-712 domain matches the Diamond's");

  const mm = ethers.Wallet.createRandom().connect(ethers.provider);
  await network.provider.send("hardhat_setBalance", [mm.address, HUNDRED_ETH]);
  await (await (await at("AccessControlFacet")).connect(ownerSigner).addMarketMaker(mm.address)).wait();
  const factory = new ethers.Contract(SAFE.factory.address, FACTORY_ABI, mm);
  const expiry = (await ethers.provider.getBlock("latest")).timestamp + 86400;
  const startMs = BigInt(Date.now());
  let saltCounter = 1n;
  let safeSeq = startMs;
  const limitSalt = () => ((startMs + saltCounter++) << 64n) | saltCounter;
  const marketSalt = () => ((startMs + saltCounter++) << 64n) | (MARKET_ORDER_MARKER << 32n) | saltCounter;

  /** Run `data` against `to` as a real Safe transaction signed by the Safe's owner. */
  const exec = async (safe, to, data) => {
    const contract = new ethers.Contract(safe.address, safeInterface, safe.wallet);
    const digest = await contract.getTransactionHash(to, 0, data, 0, 0, 0, 0, Z, Z, await contract.nonce());
    const signature = ethers.utils.joinSignature(safe.wallet._signingKey().signDigest(digest));
    await (await contract.execTransaction(to, 0, data, 0, 0, 0, 0, Z, Z, signature, { gasLimit: 2_000_000 })).wait();
  };

  const makeWorld = async (symbol, token) => {
    const collateral = await ethers.getContractAt("MockERC20", token);
    const unit = toBigInt(await adminConfig.getCollateralUnit(token));
    const questionId = ethers.utils.id(`scrum559-rehearsal-${token}-${startMs}`);
    const conditionId = ethers.utils.solidityKeccak256(["address", "bytes32", "uint8"], [ownerAddress, questionId, 2]);
    await (await condMgr.connect(ownerSigner).createCondition(ownerAddress, questionId, 2, "ipfs://scrum559-rehearsal")).wait();
    const seed = 10000n * unit;
    await deal(token, mm.address, seed);
    await (await collateral.connect(mm).approve(d, MAX)).wait();
    await (await ctf.connect(mm).splitPosition(token, H0, conditionId, [1, 2], (seed / 2n).toString())).wait();
    const [market] = await marketData.getMarketsByCondition(conditionId);
    if (!market || market.partitions.map(Number).join() !== "1,2") throw new Error(`The ${symbol} split registered no canonical market`);
    const [posA, posB] = market.positionIds;
    const newSafe = async () => {
      const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
      await network.provider.send("hardhat_setBalance", [wallet.address, HUNDRED_ETH]);
      const initializer = safeInterface.encodeFunctionData("setup", [[wallet.address], 1, Z, "0x", Z, Z, 0, Z]);
      const receipt = await (await factory.createProxyWithNonce(SAFE.singleton.address, initializer, (safeSeq++).toString())).wait();
      const safe = { address: receipt.events.find((e) => e.event === "ProxyCreation").args.proxy, wallet };
      await exec(safe, safe.address, safeInterface.encodeFunctionData("setFallbackHandler", [SAFE.handler.address]));
      await exec(safe, token, collateral.interface.encodeFunctionData("approve", [d, MAX]));
      await exec(safe, d, erc1155.interface.encodeFunctionData("setApprovalForAll", [d, true]));
      await exec(safe, d, verifier.interface.encodeFunctionData("registerOrderSigner", [wallet.address, true]));
      await deal(token, safe.address, 100n * unit);
      for (const pos of [posA, posB]) await (await erc1155.connect(mm).safeTransferFrom(mm.address, safe.address, pos, (100n * unit).toString(), "0x")).wait();
      return safe;
    };
    const [T, M, N, R, V] = [await newSafe(), await newSafe(), await newSafe(), await newSafe(), await newSafe()];
    const ord = (safe, position, side, amount, price, salt = limitSalt()) => ({
      salt: salt.toString(),
      maker: safe.address,
      signer: safe.wallet.address,
      positionId: pad(position),
      collateralToken: token,
      side,
      amount: amount.toString(),
      pricePerToken: price.toString(),
      expiration: expiry,
      nonce: 0,
    });
    console.log(`  ${symbol} (${await collateral.decimals()} decimals, unit ${unit}): condition ${conditionId.slice(0, 10)}…, 5 Safes funded`);
    return { symbol, token, collateral, unit, posA, posB, T, M, N, R, V, ord };
  };
  const USDT = await makeWorld("mUSDT", COLLATERALS.mUSDT);
  const WBTC = await makeWorld("mWBTC", COLLATERALS.mWBTC);

  const sign = (safe, order) => safe.wallet._signTypedData(domain, ORDER_TYPE, order);
  /** matchOrders arguments. A leg is { safe, order, fill, takerFee, makerFee }; the fees default to 0. */
  const matchArgs = async (takerSafe, taker, legs) => [
    taker,
    await sign(takerSafe, taker),
    1,
    legs.map((l) => l.order),
    await Promise.all(legs.map((l) => sign(l.safe, l.order))),
    legs.map(() => 1),
    legs.reduce((n, l) => n + BigInt(l.fill), 0n).toString(),
    legs.map((l) => l.fill.toString()),
    legs.map((l) => (l.takerFee ?? 0n).toString()),
    legs.map((l) => (l.makerFee ?? 0n).toString()),
  ];
  const tryTx = async (fn) => {
    try {
      const receipt = await (await fn()).wait();
      return { name: "OK", gas: receipt.gasUsed.toNumber() };
    } catch (e) {
      return { name: decodeRevert(e).name };
    }
  };
  const sendMatch = (args) => tryTx(() => settlement.connect(operator).matchOrders(...args, { gasLimit: 6_000_000 }));
  // A raw eth_call: ethers' callStatic reports an empty revert as success on a function with no return value.
  const simulateMatch = async (args) => {
    try {
      await network.provider.send("eth_call", [{ from: operatorAddress, to: d, data: settlement.interface.encodeFunctionData("matchOrders", args) }, "latest"]);
      return "OK";
    } catch (e) {
      return decodeRevert(e).name;
    }
  };

  const { unit: U, posA, T, M, N, collateral, ord } = USDT;
  const p3 = (U * 3n) / 10n;
  const p4 = (U * 4n) / 10n;

  /** The behaviours compared before the cut, after it and after the rollback. Each runs in a snapshot. */
  const behaviours = async (label) => {
    const farLegs = (salt) =>
      snapshotted(async () => {
        const near = { safe: M, order: ord(M, posA, SELL, U, (U * 99n) / 100n), fill: U };
        const far = { safe: N, order: ord(N, posA, SELL, U, U / 100n), fill: U };
        return (await sendMatch(await matchArgs(T, ord(T, posA, BUY, 2n * U, U / 2n, salt), [near, far]))).name;
      });
    const fillCase = (salt) =>
      snapshotted(async () => {
        await deal(COLLATERALS.mUSDT, operatorAddress, 10n * U);
        await (await collateral.connect(operator).approve(d, MAX)).wait();
        const o = ord(M, posA, SELL, U, p4, salt);
        return (await tryTx(async () => settlement.connect(operator).fillOrder(o, await sign(M, o), 1, U.toString(), fee40(p4).toString(), { gasLimit: 3_000_000 }))).name;
      });
    const out = {};
    out.limitNonCross = await snapshotted(async () => {
      const m = ord(M, posA, SELL, U, (U * 5n) / 10n);
      return (await sendMatch(await matchArgs(T, ord(T, posA, BUY, U, p4), [{ safe: M, order: m, fill: U }]))).name;
    });
    out.limitFar = await farLegs(limitSalt());
    out.markedFar = await farLegs(marketSalt());
    out.markedFeeOver = await snapshotted(async () => {
      const m = ord(M, posA, SELL, U, p4);
      const before = toBigInt(await collateral.balanceOf(T.address));
      const r = await sendMatch(await matchArgs(T, ord(T, posA, BUY, U, p4, marketSalt()), [{ safe: M, order: m, fill: U, takerFee: fee40(p4) }]));
      return `${r.name}, paid ${before - toBigInt(await collateral.balanceOf(T.address))} against signed ${p4}`;
    });
    out.markedMaker = await snapshotted(async () => {
      const m = ord(M, posA, SELL, U, p4, marketSalt());
      return (await sendMatch(await matchArgs(T, ord(T, posA, BUY, U, p4), [{ safe: M, order: m, fill: U }]))).name;
    });
    out.markedFill = await fillCase(marketSalt());
    out.limitFill = await fillCase(limitSalt());
    out.noAllowanceSeller = await snapshotted(async () => {
      await exec(M, COLLATERALS.mUSDT, collateral.interface.encodeFunctionData("approve", [d, 0]));
      const p = U / 2n;
      const m = ord(M, posA, SELL, U, p);
      return (await sendMatch(await matchArgs(T, ord(T, posA, BUY, U, p), [{ safe: M, order: m, fill: U, takerFee: fee40(p), makerFee: fee40(p) }]))).name;
    });
    console.log(`  --- behaviours ${label}`);
    for (const k of Object.keys(out)) console.log(`      ${k.padEnd(18)} ${out[k]}`);
    return out;
  };
  const overcharged = `OK, paid ${p4 + fee40(p4)} against signed ${p4}`;

  // ---------------------------------------------------------------- before the cut
  section("Before the cut, on the live facet");
  const preMaker = ord(M, posA, SELL, U, p3);
  const preTaker = ord(T, posA, BUY, U, p4);
  const halfFill = U / 2n;
  const preArgs = await matchArgs(T, preTaker, [{ safe: M, order: preMaker, fill: halfFill }]);
  const preHash = await verifier.getOrderHash(preTaker);
  const preFirst = await sendMatch(preArgs);
  check(preFirst.name === "OK" && toBigInt(await settlement.getFilledAmount(preHash)) === halfFill, "a limit order signed now is half filled on the live facet");
  const bBefore = await behaviours("before the cut");
  check(bBefore.markedFeeOver === overcharged, `a marked order is overcharged on the live facet (${bBefore.markedFeeOver}), which is why MARKET_ORDERS_ENABLED stays off until the cut lands`);
  check(bBefore.noAllowanceSeller === "ERC20InsufficientAllowance", "a seller with no allowance fails on the live facet");

  const routingBefore = await readRouting(loupe);
  const facetCountBefore = (await loupe.facets()).length;
  const oldFacet = plan.oldFacets[0];
  const fixedBefore = { operator: operatorAddress, maxFee: await adminConfig.getMaxFeeRate() };

  // ---------------------------------------------------------------- the cut
  section("The cut (owner impersonated)");
  const recordDir = fs.mkdtempSync(path.join(os.tmpdir(), "scrum559-rehearsal-"));
  const liveFeeDuringCeremony = 2n * fee40(p3);
  const accruedBeforeCut = toBigInt(await adminConfig.getAccruedFees(COLLATERALS.mUSDT));
  const upgrade = await runUpgrade({
    diamond: d,
    recordDir,
    afterCut: async () => {
      const m = ord(M, posA, SELL, U, p3);
      const r = await sendMatch(await matchArgs(T, ord(T, posA, BUY, U, p4), [{ safe: M, order: m, fill: U, takerFee: fee40(p3), makerFee: fee40(p3) }]));
      if (r.name !== "OK") throw new Error(`The settlement during the ceremony failed: ${r.name}`);
      console.log("  (rehearsal: a limit settlement lands between the cut and the post-check, as the match engine's would)");
    },
  });
  const newFacet = upgrade.facets.settlement.toLowerCase();
  const rec = JSON.parse(fs.readFileSync(upgrade.recordFile, "utf8"));
  check(rec.postCheck.ok === true && rec.postCheck.notes.some((n) => n.includes("accrued mUSDT fees rose")), `record written, post-check passed and tolerated the live settlement (${rec.postCheck.notes.join("; ")})`);
  check(
    rec.cut.length === 1 && rec.cut[0].action === "Replace" && rec.cut[0].facetAddress.toLowerCase() === newFacet && [...rec.cut[0].functionSelectors].sort().join() === Object.values(CUT_SELECTORS).sort().join(),
    `the record's cut is one Replace of the 3 selectors to ${newFacet}`
  );
  check(
    Object.keys(rec.previousRouting).sort().join() === Object.values(CUT_SELECTORS).sort().join() && Object.values(rec.previousRouting).every((a) => a === oldFacet) && rec.gitCommit && rec.cutBlock,
    `the record has previousRouting back to ${oldFacet}, commit ${String(rec.gitCommit).slice(0, 7)} and cut block ${rec.cutBlock}`
  );
  const deployedCode = await ethers.provider.getCode(newFacet);
  check((deployedCode.length - 2) / 2 === rec.build.facetBytes && ethers.utils.keccak256(deployedCode) === rec.build.facetRuntimeKeccak, `the facet on the fork is the build's: ${rec.build.facetBytes} bytes, runtime keccak ${rec.build.facetRuntimeKeccak}`);
  const keptSha = crypto.createHash("sha256").update(zlib.gunzipSync(fs.readFileSync(upgrade.keptBuildInfo))).digest("hex");
  check(keptSha === rec.build.sha256, `the build-info kept beside the record is the build's (${(fs.statSync(upgrade.keptBuildInfo).size / 1e6).toFixed(1)} MB gzipped)`);
  err = await refusal(() => runUpgrade({ diamond: d, dryRun: true }), "looks applied already");
  check(err === null, `a second run refuses: the cut is already applied${err ? `: ${err}` : ""}`);

  // ---------------------------------------------------------------- after the cut
  section("After the cut");
  const routingAfterCut = await readRouting(loupe);
  const moved = routingDiff(routingBefore, routingAfterCut);
  check(moved.join() === Object.values(CUT_SELECTORS).sort().join() && moved.every((sel) => routingAfterCut[sel] === newFacet), "exactly the 3 selectors moved, all to the new facet");
  check((await loupe.facets()).length === facetCountBefore && !Object.values(routingAfterCut).includes(oldFacet), "the old facet is gone from the loupe, facet count unchanged");
  check((await loupe.facetAddress(CUT_SELECTORS.matchOrders)).toLowerCase() === newFacet, "facetAddress(matchOrders) is the new facet");
  check((await settlementAdmin.getOperator()) === fixedBefore.operator && (await adminConfig.getMaxFeeRate()) === fixedBefore.maxFee && toBigInt(await settlement.getFilledAmount(preHash)) === halfFill, "operator, fee cap and fill state unchanged");
  check(toBigInt(await adminConfig.getAccruedFees(COLLATERALS.mUSDT)) === accruedBeforeCut + liveFeeDuringCeremony, `accrued fees carried over, plus exactly the ${liveFeeDuringCeremony} from the live settlement`);
  const preSecond = await sendMatch(preArgs);
  check(preSecond.name === "OK" && toBigInt(await settlement.getFilledAmount(preHash)) === U, "the limit order signed before the cut settles its other half (type 1)");

  const bAfter = await behaviours("after the cut");
  check(bAfter.limitNonCross === "InvalidMatch", "a limit taker's non-crossing leg is still InvalidMatch");
  check(bAfter.limitFar === "InvalidMatch", "a limit taker's far legs averaging at its limit are still InvalidMatch");
  check(bAfter.markedFar === "OK", "a marked taker's far legs averaging at the signed price settle");
  check(bAfter.markedFeeOver.startsWith("TakerPriceBreached") && bAfter.markedFeeOver.includes("paid 0 "), `a marked taker whose fee breaks the all-in reverts TakerPriceBreached (${bAfter.markedFeeOver})`);
  check(bAfter.markedMaker === "OrderCancelled", "a marked order as a maker reverts OrderCancelled");
  check(bAfter.markedFill === "OrderCancelled", "a marked order in fillOrder reverts OrderCancelled");
  check(bAfter.limitFill === "OK", "a limit order in fillOrder still settles");
  check(bAfter.noAllowanceSeller === "OK", "a seller with no allowance settles (the fee comes out of proceeds)");

  // ---------------------------------------------------------------- market orders
  section("Market orders: the exact all-in on all three paths, both collaterals");
  const settledMarketOrders = [];
  /** One market order against `legs`: { maker, kind, price, fill }. Checks every balance the settlement moves. */
  const runMarket = async (w, label, side, legs) => {
    const { unit: u, T: taker, posA: A, posB: B, collateral: col, ord: o } = w;
    let cash = 0n;
    let takerFees = 0n;
    let allFees = 0n;
    let filled = 0n;
    const args = [];
    const makerWants = [];
    for (const leg of legs) {
      const complementary = leg.kind === "Complementary";
      const makerSide = complementary ? (side === BUY ? SELL : BUY) : side;
      const makerCash = (leg.price * leg.fill) / u;
      const takerCash = complementary ? makerCash : leg.fill - makerCash;
      const [takerFee, makerFee] = [fee40(takerCash), fee40(makerCash)];
      cash += takerCash;
      takerFees += takerFee;
      allFees += takerFee + makerFee;
      filled += leg.fill;
      args.push({ safe: leg.maker, order: o(leg.maker, complementary ? A : B, makerSide, leg.fill, leg.price), fill: leg.fill, takerFee, makerFee });
      // A maker who buys pays its fee on top. A maker who sells receives its cash less its fee.
      makerWants.push(makerSide === BUY ? -(makerCash + makerFee) : makerCash - makerFee);
    }
    const allIn = side === BUY ? cash + takerFees : cash - takerFees;
    const signed = side === BUY ? ceilDiv(allIn * u, filled) : (allIn * u) / filled;

    // One raw tighter must fail: the contract checks the all-in exactly, with no rounding allowance.
    const tighter = await snapshotted(async () => (await sendMatch(await matchArgs(taker, o(taker, A, side, filled, side === BUY ? signed - 1n : signed + 1n, marketSalt()), args))).name);

    const order = o(taker, A, side, filled, signed, marketSalt());
    const holders = [taker.address, ...legs.map((l) => l.maker.address), d];
    const read = async () => ({
      collateral: await Promise.all(holders.map(async (h) => toBigInt(await col.balanceOf(h)))),
      position: toBigInt(await erc1155.balanceOf(taker.address, A)),
      accrued: toBigInt(await adminConfig.getAccruedFees(w.token)),
    });
    const before = await read();
    const result = await sendMatch(await matchArgs(taker, order, args));
    const after = await read();
    const deltas = after.collateral.map((v, i) => v - before.collateral[i]);
    const hash = await verifier.getOrderHash(order);
    const fillOnChain = toBigInt(await settlement.getFilledAmount(hash));
    const ok =
      result.name === "OK" &&
      tighter === "TakerPriceBreached" &&
      deltas[0] === (side === BUY ? -allIn : allIn) &&
      (side === BUY ? allIn * u <= signed * filled : allIn * u >= signed * filled) &&
      makerWants.every((want, i) => deltas[i + 1] === want) &&
      deltas.reduce((n, v) => n + v, 0n) === 0n &&
      after.accrued - before.accrued === allFees &&
      after.position - before.position === (side === BUY ? filled : -filled) &&
      fillOnChain === filled;
    check(ok, `${w.symbol} market ${label}: ${result.name}, all-in ${allIn} vs signed ${signed}, moved ${deltas[0]}, makers ${deltas.slice(1, -1).join("/")}, fees ${after.accrued - before.accrued}, one raw tighter ${tighter}, gas ${result.gas}`);
    if (result.name === "OK") settledMarketOrders.push({ hash, filled });
  };
  for (const w of [USDT, WBTC]) {
    const u = w.unit;
    await runMarket(w, "Complementary buy", BUY, [{ maker: w.M, kind: "Complementary", price: (u * 3n) / 10n, fill: u }]);
    await runMarket(w, "Complementary sell", SELL, [{ maker: w.M, kind: "Complementary", price: (u * 3n) / 10n, fill: u }]);
    await runMarket(w, "Mint", BUY, [{ maker: w.M, kind: "Mint", price: (u * 6n) / 10n, fill: u }]);
    await runMarket(w, "Merge", SELL, [{ maker: w.M, kind: "Merge", price: (u * 6n) / 10n, fill: u }]);
    const walk = (kinds) => kinds.map((kind, i) => ({ maker: [w.M, w.N, w.R, w.V][i], kind, price: kind === "Complementary" ? (u * 4n) / 10n : (u * 6n) / 10n, fill: u / 2n }));
    await runMarket(w, "buy walking Complementary + Mint x2", BUY, walk(["Complementary", "Mint", "Complementary", "Mint"]));
    await runMarket(w, "sell walking Complementary + Merge x2", SELL, walk(["Complementary", "Merge", "Complementary", "Merge"]));
  }

  // ---------------------------------------------------------------- cancel paths
  section("Nonce, salt floor and cancelOrder stop a marked order");
  const floorAbove = (salt) => ((BigInt(salt) >> 64n) + 1n) << 64n;
  const stops = [
    ["incrementNonce", () => nonceMgr.interface.encodeFunctionData("incrementNonce"), "OrderNonceInvalid"],
    ["the salt floor (cancelOrdersForPosition)", (o) => nonceMgr.interface.encodeFunctionData("cancelOrdersForPosition", [pad(posA), floorAbove(o.salt).toString()]), "OrderCancelled"],
    ["cancelOrder", (o) => nonceMgr.interface.encodeFunctionData("cancelOrder", [o]), "OrderCancelled"],
  ];
  for (const [label, encode, expected] of stops) {
    await snapshotted(async () => {
      const marked = ord(T, posA, BUY, U, U / 2n, marketSalt());
      const args = await matchArgs(T, marked, [{ safe: M, order: ord(M, posA, SELL, U, U / 2n), fill: U }]);
      const settlesUntilThen = await simulateMatch(args);
      const validBefore = await nonceMgr.isOrderValid(marked);
      await exec(T, d, encode(marked));
      const validAfter = await nonceMgr.isOrderValid(marked);
      const result = await sendMatch(args);
      check(settlesUntilThen === "OK" && validBefore && !validAfter && result.name === expected, `${label} stops a marked order: it would settle (${settlesUntilThen}) until then, then reverts ${result.name}`);
      if (label.startsWith("the salt floor")) {
        // A marked salt keeps the time ordering, so the floor reaches the old order and not a later one.
        const later = ord(T, posA, BUY, U, U / 2n, (floorAbove(marked.salt) | (MARKET_ORDER_MARKER << 32n)) + 1n);
        check(await nonceMgr.isOrderValid(later), "the salt floor leaves a marked order signed after it valid");
      }
    });
  }

  // ---------------------------------------------------------------- Safe route
  section("The Safe route, through the real owner Safe on the fork");
  const safeClient = forkSafeClient();
  await snapshotted(async () => {
    const down = await runRollback({ recordFile: upgrade.recordFile, switchOffConfirmed: true, safeClient, dryRun: false });
    check(down.cutRoute === "safe" && Boolean(down.safeTxHash) && routingDiff(routingBefore, await readRouting(loupe)).length === 0, `rollback executes through Safe ${ownerAddress} (${safeSummary})`);
    const up = await runUpgrade({ diamond: d, facetAddress: newFacet, safeClient });
    const routing = await readRouting(loupe);
    check(up.cutRoute === "safe" && Boolean(up.safeTxHash) && routingDiff(routingAfterCut, routing).length === 0, "the cut executes through the same Safe, reusing the deployed facet");
  });

  // ---------------------------------------------------------------- rollback
  section("Rollback");
  const filledBeforeRollback = [{ hash: preHash, filled: U }, ...settledMarketOrders];
  const accruedBeforeRollback = { mUSDT: toBigInt(await adminConfig.getAccruedFees(COLLATERALS.mUSDT)), mWBTC: toBigInt(await adminConfig.getAccruedFees(COLLATERALS.mWBTC)) };

  err = await refusal(() => runRollback({ recordFile: upgrade.recordFile, dryRun: true }), "MARKET_ORDERS_OFF_CONFIRMED");
  check(err === null, `refuses without the switch-off confirmation${err ? `: ${err}` : ""}`);
  const writeVariant = (name, changes) => {
    const file = path.join(recordDir, name);
    fs.writeFileSync(file, JSON.stringify({ ...rec, ...changes }));
    return file;
  };
  const selectors = Object.keys(rec.previousRouting);
  const wrongRecords = [
    ["a record from another network", { network: "baseSepolia", chainId: BASE_SEPOLIA_CHAIN_ID }, "The record is for"],
    ["a record naming the mainnet Diamond", { diamond: BASE_MAINNET_DIAMOND }, "Refusing Base mainnet"],
    ["a record missing a selector", { previousRouting: { [selectors[0]]: oldFacet, [selectors[1]]: oldFacet } }, "expected this cut's"],
    ["a record routing to two facets", { previousRouting: { [selectors[0]]: oldFacet, [selectors[1]]: oldFacet, [selectors[2]]: newFacet } }, "expected one"],
    ["a record routing to nothing", { previousRouting: { [selectors[0]]: Z, [selectors[1]]: Z, [selectors[2]]: Z } }, "Replace-only"],
    ["a record whose facet is not the one routed", { facets: { settlement: oldFacet } }, "already rolled back"],
  ];
  for (const [label, changes, needle] of wrongRecords) {
    err = await refusal(() => runRollback({ recordFile: writeVariant("variant.json", changes), switchOffConfirmed: true, dryRun: true }), needle);
    check(err === null, `refuses ${label}${err ? `: ${err}` : ""}`);
  }

  const { result: rolled, log: rollbackLog } = await capturingLog(() => runRollback({ recordFile: upgrade.recordFile, switchOffConfirmed: true, recordDir }));
  check(rollbackLog.includes("MARKET_ORDERS_ENABLED must be switched off") && rollbackLog.includes("Expiry plus a margin") && rollbackLog.includes("overcharges"), "its log states the switch-off, the expiry wait and the overcharge");
  check(rolled.postCheck.ok === true && Boolean(rolled.recordFile) && JSON.parse(fs.readFileSync(rolled.recordFile, "utf8")).to === oldFacet, "rollback record written, post-check passed");
  const routingRolledBack = await readRouting(loupe);
  check(routingDiff(routingBefore, routingRolledBack).length === 0, `the routing is restored exactly: all ${Object.keys(routingRolledBack).length} selectors as before the cut`);
  check((await loupe.facets()).length === facetCountBefore && (await loupe.facetAddress(CUT_SELECTORS.matchOrders)).toLowerCase() === oldFacet, "facetAddress(matchOrders) is the previous facet, facet count unchanged");
  let fillsRetained = true;
  for (const { hash, filled } of filledBeforeRollback) fillsRetained = fillsRetained && toBigInt(await settlement.getFilledAmount(hash)) === filled;
  check(fillsRetained, `fills retained: ${filledBeforeRollback.length} orders settled on both facets read the same`);
  check(
    toBigInt(await adminConfig.getAccruedFees(COLLATERALS.mUSDT)) === accruedBeforeRollback.mUSDT && toBigInt(await adminConfig.getAccruedFees(COLLATERALS.mWBTC)) === accruedBeforeRollback.mWBTC,
    `accrued fees retained: mUSDT ${accruedBeforeRollback.mUSDT}, mWBTC ${accruedBeforeRollback.mWBTC}`
  );
  const limitAfterRollback = await sendMatch(await matchArgs(T, ord(T, posA, BUY, U, p4), [{ safe: M, order: ord(M, posA, SELL, U, p3), fill: U }]));
  check(limitAfterRollback.name === "OK", "limit settlement works on the previous facet");
  const bRolled = await behaviours("after the rollback");
  check(JSON.stringify(bRolled) === JSON.stringify(bBefore), "every behaviour matches before the cut");
  check(bRolled.markedFeeOver === overcharged, `inside its expiry a marked order is overcharged again (${bRolled.markedFeeOver}), which is why the switch goes off and expiry is waited out first`);
  const pastExpiry = await snapshotted(async () => {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const order = { ...ord(T, posA, BUY, U, p4, marketSalt()), expiration: now + 60 };
    const args = await matchArgs(T, order, [{ safe: M, order: ord(M, posA, SELL, U, p4), fill: U, takerFee: fee40(p4) }]);
    const inside = await simulateMatch(args);
    await network.provider.send("evm_increaseTime", [120]);
    await network.provider.send("evm_mine");
    const paidBefore = toBigInt(await collateral.balanceOf(T.address));
    const result = await sendMatch(args);
    return { inside, after: result.name, paid: paidBefore - toBigInt(await collateral.balanceOf(T.address)) };
  });
  check(pastExpiry.inside === "OK" && pastExpiry.after === "OrderCancelled" && pastExpiry.paid === 0n, `past its expiry the same order reverts ${pastExpiry.after} and pays ${pastExpiry.paid}, so the wait closes that gap`);
  err = await refusal(() => runRollback({ recordFile: upgrade.recordFile, switchOffConfirmed: true }), "already rolled back");
  check(err === null, `a second rollback refuses: the routing no longer matches the record${err ? `: ${err}` : ""}`);

  await snapshotted(async () => {
    err = await refusal(() => runUpgrade({ diamond: d, facetAddress: oldFacet }), "does not carry the compiled");
    check(err === null, `resuming refuses a NEW_SETTLEMENT_FACET_ADDRESS that is not this build's facet${err ? `: ${err}` : ""}`);
    const again = await runUpgrade({ diamond: d, facetAddress: newFacet });
    check(again.recordFile === null && (await loupe.facetAddress(CUT_SELECTORS.matchOrders)).toLowerCase() === newFacet, "the cut can be applied again after a rollback, reusing the deployed facet");
  });

  check(JSON.stringify(listDeployments()) === JSON.stringify(deploymentsBefore), "nothing was written under deployments/");
  fs.rmSync(recordDir, { recursive: true, force: true });

  console.log("\n==========================================================");
  console.log(`  Fork block: ${forkBlock}`);
  console.log(`  Build:      ${build.id} (${build.sources} sources, solc ${build.solc})`);
  console.log(`  Facet:      ${build.facetBytes} bytes (init ${build.facetInitBytes}), runtime keccak ${build.facetRuntimeKeccak}`);
  console.log(`  Old facet:  ${oldFacet}`);
  console.log(`  Owner:      ${ownerAddress} (${safeSummary})`);
  console.log(`  REHEARSAL:  ${passed} PASS, ${failed.length} FAIL`);
  if (failed.length) {
    failed.forEach((f) => console.log(`     - ${f}`));
    console.log("==========================================================\n");
    process.exit(1);
  }
  console.log("==========================================================\n");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`\n❌ rehearsal errored after ${passed} PASS, ${failed.length} FAIL:`, e);
    process.exit(1);
  });
