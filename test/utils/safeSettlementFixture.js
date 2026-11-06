// Shared fixture for settlement tests that need real smart-contract wallets: Safe 1.4.1 bytecode at
// its canonical addresses, 1-of-1 Safes created through the real factory, and orders signed by the
// Safe's owner with signature type 1 and a registered signer, the way the backend submits them.
//
// Mocha loads .js files under test/, but files without `describe`/`it` blocks register no tests, so
// this helper is silent at test discovery.
//
// Two rules for anything built on it:
//
//   1. A Safe's address is a CREATE2 hash of its wallet tag, and the canonical factory outlives any
//      one suite's Diamond when suites share a Hardhat run. Each suite therefore passes its own name
//      to `setupSafeSettlement`; the name prefixes every wallet tag, so suites cannot collide.
//
//   2. Check reverts with `simulate` (a raw `eth_call`) or `send` (a real transaction). Never use
//      `callStatic`: ethers v5 reports an empty revert as success on a function with no return value,
//      and a Safe with its fallback handler removed reverts with empty data.

const { ethers, network, artifacts } = require("hardhat");
const { deployDiamond } = require("../../scripts/deploy.js");
const { getConditionId, getCollectionId, getPositionId } = require("./ctfUtils.js");
const SAFE = require("../data/safe-1.4.1-code.json");

const ZERO_ADDRESS = ethers.constants.AddressZero;
const ZERO_HASH = ethers.constants.HashZero;
const MAX_UINT = ethers.constants.MaxUint256;

const BUY = 0;
const SELL = 1;

/// Bits 32..63 of the signed salt of a market order: bytes4(keccak256("doefin.market-order.v1")).
const MARKET_ORDER_MARKER = 0xef860c2en;

/// What `decodeRevert` calls a revert that carries no data at all.
const EMPTY_REVERT = "(empty revert data)";

/// The fee ceiling `setupSafeSettlement` configures, and the bell-curve rate `bellFees` charges.
const MAX_FEE_RATE_BPS = 100n;

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

const SAFE_ABI = [
  "function setup(address[],uint256,address,bytes,address,address,uint256,address)",
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns (bytes32)",
  "function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) payable returns (bool)",
  "function setFallbackHandler(address)",
  "function setGuard(address)",
  "function enableModule(address)",
];
const FACTORY_ABI = [
  "function createProxyWithNonce(address,bytes,uint256) returns (address)",
  "event ProxyCreation(address indexed proxy, address singleton)",
];
const safeInterface = new ethers.utils.Interface(SAFE_ABI);

const TEN_THOUSAND_ETH_HEX = "0x21E19E0C9BAB2400000";

const suitesInThisRun = new Set();

const pad = (positionId) => ethers.utils.hexZeroPad(ethers.BigNumber.from(positionId).toHexString(), 32);
const toBigInt = (x) => BigInt(x.toString());
const ceilDiv = (a, unit) => (a + unit - 1n) / unit;

/// Run `fn` and roll the chain back afterwards, whatever it did.
async function snapshotted(fn) {
  const id = await network.provider.send("evm_snapshot");
  try {
    return await fn();
  } finally {
    await network.provider.send("evm_revert", [id]);
  }
}

/// What a leg moves, in raw units. The maker pays or receives floor(price * fill / unit); on Mint and
/// Merge the taker takes the remainder of `fill`, so the rounding raw goes to the taker.
function legCash(world, leg) {
  const makerCash = (leg.price * leg.fill) / world.unit;
  return { makerCash, takerCash: leg.kind === "Complementary" ? makerCash : leg.fill - makerCash };
}

/// The operator's bell-curve fee at `MAX_FEE_RATE_BPS`, clamped to the on-chain ceiling.
function bellFees(world, leg) {
  const unit = world.unit;
  const { makerCash, takerCash } = legCash(world, leg);
  const effectivePrice = leg.kind === "Complementary" ? leg.price : unit - leg.price;
  const lesserSide = (price) => (price < unit - price ? price : unit - price);
  const fee = (price, cash) => {
    const bell = (MAX_FEE_RATE_BPS * lesserSide(price) * leg.fill) / (unit * 10000n);
    const ceiling = (cash * MAX_FEE_RATE_BPS) / 10000n;
    return bell < ceiling ? bell : ceiling;
  };
  return { takerFee: fee(effectivePrice, takerCash), makerFee: fee(leg.price, makerCash) };
}

let cachedErrorsInterface;
function errorsInterface() {
  if (!cachedErrorsInterface) {
    const { abi } = artifacts.readArtifactSync("contracts/libraries/Errors.sol:Errors");
    cachedErrorsInterface = new ethers.utils.Interface([
      ...abi,
      "error ERC20InsufficientAllowance(address spender,uint256 allowance,uint256 needed)",
      "error ERC20InsufficientBalance(address sender,uint256 balance,uint256 needed)",
    ]);
  }
  return cachedErrorsInterface;
}

/// Turn a caught revert into `{ name, raw }`: the custom error's name, `Panic(0x..)`, `Error("..")`,
/// or `EMPTY_REVERT`. Anything unrecognised keeps its message, so it cannot match an expected name.
function decodeRevert(e) {
  const data = e.data ?? e.error?.data ?? e.error?.error?.data ?? null;
  const raw = typeof data === "string" ? data : data?.data ?? null;
  if (raw === "0x") return { name: EMPTY_REVERT, raw };
  if (raw && raw.startsWith("0x4e487b71")) {
    return { name: `Panic(0x${BigInt("0x" + raw.slice(10)).toString(16)})`, raw };
  }
  if (raw && raw.startsWith("0x08c379a0")) {
    return { name: `Error("${ethers.utils.defaultAbiCoder.decode(["string"], "0x" + raw.slice(10))[0]}")`, raw };
  }
  if (raw) {
    try {
      return { name: errorsInterface().parseError(raw).name, raw };
    } catch (_) {
      return { name: `undecoded ${raw.slice(0, 10)}`, raw };
    }
  }
  const message = e.message ?? String(e);
  const match =
    /custom error '([A-Za-z0-9_]+)/.exec(message) ||
    /reason string '([^']+)/.exec(message) ||
    /(panic code 0x[0-9a-f]+)/.exec(message) ||
    /(function returned an unexpected amount of data)/.exec(message) ||
    /(without a reason string)/.exec(message) ||
    /(out of gas)/i.exec(message) ||
    /(function selector was not recognized[^"]*)/.exec(message);
  return { name: match ? match[1] : message.slice(0, 200), raw };
}

/// The `orderHash` a `simulate` result's custom error carries, or null if it carries none.
function namedHash(result) {
  try {
    return errorsInterface().parseError(result.raw).args.orderHash ?? null;
  } catch (_) {
    return null;
  }
}

/// Deterministic PRNG, so a randomised case settles the same bundles on every run.
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  const big = (bits) => {
    let x = 0n;
    for (let i = 0; i < Math.ceil(bits / 32); i++) x = (x << 32n) | BigInt(next());
    return x & ((1n << BigInt(bits)) - 1n);
  };
  return {
    next,
    big,
    int: (n) => next() % n,
    below: (m) => (m === 0n ? 0n : big(m.toString(2).length + 16) % m),
    chance: (p) => next() / 2 ** 32 < p,
  };
}

/**
 * Stand up a fresh Diamond plus the real Safe contracts for one suite. `suite` must be unique within
 * a Hardhat run (see rule 1 above). Returns the contracts, the signers, and the helpers below.
 */
async function setupSafeSettlement(suite) {
  if (suitesInThisRun.has(suite)) {
    throw new Error(`setupSafeSettlement("${suite}") called twice: Safe tags must be unique to each suite`);
  }
  suitesInThisRun.add(suite);

  const [owner, operator, outsider] = await ethers.getSigners();
  for (const part of ["singleton", "factory", "handler", "multisend"]) {
    await network.provider.send("hardhat_setCode", [SAFE[part].address, SAFE[part].code]);
  }
  const factory = new ethers.Contract(SAFE.factory.address, FACTORY_ABI, owner);

  const diamond = await deployDiamond();
  const at = (name) => ethers.getContractAt(name, diamond);
  const settlement = await at("SettlementFacet");
  const settlementAdmin = await at("SettlementAdminFacet");
  const sigVerifier = await at("SignatureVerifierFacet");
  const nonceMgr = await at("NonceManagerFacet");
  const adminConfig = await at("AdminConfigFacet");
  const conditionMgr = await at("ConditionManagerFacet");
  const conditionalTokens = await at("ConditionalTokensFacet");
  const erc1155Facet = await at("ERC1155Facet");
  const accessControl = await at("AccessControlFacet");

  await adminConfig.setMaxFeeRate(MAX_FEE_RATE_BPS.toString());
  await settlementAdmin.setOperator(operator.address);
  await accessControl.addMarketMaker(owner.address);

  const expiry = (await ethers.provider.getBlock("latest")).timestamp + 100_000_000;
  const domain = { name: "Doefin Exchange", version: "3", chainId: 31337, verifyingContract: diamond };
  let clock = 1790000000000n;
  let randomWord = 1n;

  // The frontend's layout for a limit salt; a market salt adds the marker in bits 32..63.
  const limitSalt = () => (clock++ << 64n) | (randomWord++ & 0xffffffffn);
  const marketSalt = () => (clock++ << 64n) | (MARKET_ORDER_MARKER << 32n) | (randomWord++ & 0xffffffffn);

  /// Run `data` against `to` as a real Safe transaction signed by the Safe's owner.
  async function exec(safe, to, data, operation = 0) {
    const contract = new ethers.Contract(safe.address, SAFE_ABI, safe.wallet);
    const safeNonce = await contract.nonce();
    const digest = await contract.getTransactionHash(to, 0, data, operation, 0, 0, 0, ZERO_ADDRESS, ZERO_ADDRESS, safeNonce);
    const signature = ethers.utils.joinSignature(safe.wallet._signingKey().signDigest(digest));
    const tx = await contract.execTransaction(to, 0, data, operation, 0, 0, 0, ZERO_ADDRESS, ZERO_ADDRESS, signature, {
      gasLimit: 3_000_000,
    });
    await tx.wait();
  }

  /// A funded owner wallet whose address depends on this suite and `tag` alone.
  async function ownerWallet(tag) {
    const wallet = new ethers.Wallet(ethers.utils.id(`doefin-test-wallet-${suite}-${tag}`), ethers.provider);
    await network.provider.send("hardhat_setBalance", [wallet.address, TEN_THOUSAND_ETH_HEX]);
    return wallet;
  }

  async function newSafe(tag) {
    const wallet = await ownerWallet(tag);
    const initializer = safeInterface.encodeFunctionData("setup", [
      [wallet.address], 1, ZERO_ADDRESS, "0x", ZERO_ADDRESS, ZERO_ADDRESS, 0, ZERO_ADDRESS,
    ]);
    const saltNonce = ethers.BigNumber.from(ethers.utils.id(`doefin-test-nonce-${suite}-${tag}`));
    const receipt = await (await factory.createProxyWithNonce(SAFE.singleton.address, initializer, saltNonce)).wait();
    const address = receipt.events.find((e) => e.event === "ProxyCreation").args.proxy;
    return { tag, address, wallet };
  }

  /// What a Safe does before its first order: install the handler, approve the Diamond, register the signer.
  async function activate(safe) {
    await exec(safe, safe.address, safeInterface.encodeFunctionData("setFallbackHandler", [SAFE.handler.address]));
    await exec(safe, diamond, erc1155Facet.interface.encodeFunctionData("setApprovalForAll", [diamond, true]));
    await exec(safe, diamond, sigVerifier.interface.encodeFunctionData("registerOrderSigner", [safe.wallet.address, true]));
  }

  async function activeSafes(tags) {
    const safes = [];
    for (const tag of tags) {
      const safe = await newSafe(tag);
      await activate(safe);
      safes.push(safe);
    }
    return safes;
  }

  /// A fresh collateral token and binary market, with `perUnits` whole tokens of collateral and of both
  /// outcomes in each Safe. `question` must be unique within the suite.
  async function makeWorld(decimals, safes, question, perUnits = 1000n) {
    const unit = 10n ** BigInt(decimals);
    const token = await (await ethers.getContractFactory("MockERC20")).deploy("Mock", "M", decimals);
    await token.deployed();
    await adminConfig.addCollateralToken(token.address, unit.toString());

    const questionId = ethers.utils.formatBytes32String(question);
    const conditionId = getConditionId(owner.address, questionId, 2);
    await conditionMgr.createCondition(owner.address, questionId, 2, "ipfs://settlement-tests");
    const normalise = (hex) => "0x" + hex.slice(hex.indexOf("x") + 1).padStart(64, "0");
    const collectionA = normalise(await getCollectionId(ZERO_HASH, conditionId, 1, ethers.provider));
    const collectionB = normalise(await getCollectionId(ZERO_HASH, conditionId, 2, ethers.provider));
    const posA = getPositionId(token.address, collectionA);
    const posB = getPositionId(token.address, collectionB);

    const perSafe = perUnits * unit;
    const total = perSafe * BigInt(safes.length + 1);
    await token.mint(owner.address, (total * 3n).toString());
    await token.connect(owner).approve(diamond, MAX_UINT);
    await erc1155Facet.connect(owner).setApprovalForAll(diamond, true);
    await conditionalTokens.connect(owner).splitPosition(token.address, ZERO_HASH, conditionId, [1, 2], total.toString());
    for (const safe of safes) {
      await token.mint(safe.address, perSafe.toString());
      await exec(safe, token.address, token.interface.encodeFunctionData("approve", [diamond, MAX_UINT]));
      await erc1155Facet.connect(owner).safeTransferFrom(owner.address, safe.address, posA, perSafe.toString(), "0x");
      await erc1155Facet.connect(owner).safeTransferFrom(owner.address, safe.address, posB, perSafe.toString(), "0x");
    }
    return { token, unit, posA, posB, conditionId };
  }

  function order(world, safe, positionId, side, amount, price, overrides = {}) {
    return {
      salt: limitSalt().toString(),
      maker: safe.address,
      signer: safe.wallet.address,
      positionId: pad(positionId),
      collateralToken: world.token.address,
      side,
      amount: amount.toString(),
      pricePerToken: price.toString(),
      expiration: expiry,
      nonce: 0,
      ...overrides,
    };
  }

  const signOrder = (safe, o) => safe.wallet._signTypedData(domain, ORDER_TYPE, o);

  function legOrder(world, leg) {
    if (leg.order) return leg.order;
    let positionId = world.posB;
    let side = leg.kind === "Mint" ? BUY : SELL;
    if (leg.kind === "Complementary") {
      positionId = world.posA;
      side = leg.takerSide === BUY ? SELL : BUY;
    }
    return order(world, leg.maker, positionId, side, leg.makerAmount ?? leg.fill, leg.price, leg.overrides ?? {});
  }

  /**
   * Build and sign one `matchOrders` call: a taker on `world.posA` against `legs`, all signature type 1.
   *
   * A leg is `{ maker, kind, price, fill }` with `kind` "Complementary", "Mint" or "Merge" and `price` the
   * maker's. Fees default to `bellFees`; set `noFee`, or `takerFee` and `makerFee`, to override them.
   * `makerAmount`, `overrides`, `order` and `sig` shape the maker's order.
   *
   * `opts`: `market` puts the marker in the taker's salt; `price` is the taker's signed price, default
   * the tightest all-in average of these legs; `amount` and `takerOverrides` shape the taker's order;
   * `taker` and `sig` replace it outright.
   */
  async function bundle(world, takerSafe, takerSide, legs, opts = {}) {
    let cash = 0n;
    let fee = 0n;
    let filled = 0n;
    const orders = [];
    const sigs = [];
    const fills = [];
    const takerFees = [];
    const makerFees = [];
    for (const raw of legs) {
      const leg = { takerSide, ...raw };
      const fees = leg.noFee
        ? { takerFee: 0n, makerFee: 0n }
        : { takerFee: leg.takerFee ?? bellFees(world, leg).takerFee, makerFee: leg.makerFee ?? bellFees(world, leg).makerFee };
      cash += legCash(world, leg).takerCash;
      fee += fees.takerFee;
      filled += leg.fill;
      const o = legOrder(world, leg);
      orders.push(o);
      sigs.push(leg.sig ?? (await signOrder(leg.maker, o)));
      fills.push(leg.fill.toString());
      takerFees.push(fees.takerFee.toString());
      makerFees.push(fees.makerFee.toString());
    }
    const exact = takerSide === BUY ? ceilDiv((cash + fee) * world.unit, filled) : ((cash - fee) * world.unit) / filled;
    const taker =
      opts.taker ??
      order(world, takerSafe, world.posA, takerSide, opts.amount ?? filled, opts.price ?? exact, {
        ...(opts.market ? { salt: marketSalt().toString() } : {}),
        ...(opts.takerOverrides ?? {}),
      });
    return {
      taker,
      sig: opts.sig ?? (await signOrder(takerSafe, taker)),
      orders,
      sigs,
      types: legs.map(() => 1),
      filled: filled.toString(),
      fills,
      takerFees,
      makerFees,
      cash,
      fee,
      price: BigInt(taker.pricePerToken),
      exact,
    };
  }

  const matchArgs = (a) => [a.taker, a.sig, 1, a.orders, a.sigs, a.types, a.filled, a.fills, a.takerFees, a.makerFees];

  /// A raw `eth_call` as the operator. `extra` adds call fields, such as a gas cap.
  async function rawCall(data, extra = {}) {
    try {
      await network.provider.send("eth_call", [{ from: operator.address, to: diamond, data, ...extra }, "latest"]);
      return { ok: true, name: "OK", raw: null };
    } catch (e) {
      return { ok: false, ...decodeRevert(e) };
    }
  }

  const simulate = (a, extra = {}) => rawCall(settlement.interface.encodeFunctionData("matchOrders", matchArgs(a)), extra);

  const simulateFill = (o, sig, fill, fee) =>
    rawCall(settlement.interface.encodeFunctionData("fillOrder", [o, sig, 1, fill.toString(), fee.toString()]));

  /// A real `matchOrders` transaction from the operator. The default gas is the network's own: the
  /// per-transaction cap, which a large bundle needs on the instrumented `hardhat coverage` build.
  async function send(a, overrides = { gasLimit: network.config.gas }) {
    try {
      const tx = await settlement.connect(operator).matchOrders(...matchArgs(a), overrides);
      const receipt = await tx.wait();
      return { ok: true, name: "OK", receipt };
    } catch (e) {
      return { ok: false, ...decodeRevert(e) };
    }
  }

  /// A real `fillOrder` transaction from the operator.
  async function sendFill(o, sig, fill, fee) {
    try {
      const tx = await settlement.connect(operator).fillOrder(o, sig, 1, fill.toString(), fee.toString(), { gasLimit: 3_000_000 });
      await tx.wait();
      return { ok: true, name: "OK" };
    } catch (e) {
      return { ok: false, ...decodeRevert(e) };
    }
  }

  const balance = async (world, address) => toBigInt(await world.token.balanceOf(address));
  const positionBalance = async (address, positionId) => toBigInt(await erc1155Facet.balanceOf(address, positionId));
  const accruedFees = async (world) => toBigInt(await adminConfig.getAccruedFees(world.token.address));

  return {
    diamond,
    contracts: {
      settlement, settlementAdmin, sigVerifier, nonceMgr, adminConfig, conditionMgr,
      conditionalTokens, erc1155Facet, accessControl,
    },
    signers: { owner, operator, outsider },
    exec,
    ownerWallet,
    activeSafes,
    makeWorld,
    limitSalt,
    marketSalt,
    order,
    signOrder,
    bundle,
    simulate,
    simulateFill,
    send,
    sendFill,
    balance,
    positionBalance,
    accruedFees,
    orderDigest: (o) => ethers.utils._TypedDataEncoder.hash(domain, ORDER_TYPE, o),
  };
}

module.exports = {
  setupSafeSettlement,
  SAFE,
  safeInterface,
  ZERO_ADDRESS,
  BUY,
  SELL,
  MARKET_ORDER_MARKER,
  MAX_FEE_RATE_BPS,
  EMPTY_REVERT,
  pad,
  toBigInt,
  ceilDiv,
  snapshotted,
  legCash,
  bellFees,
  decodeRevert,
  namedHash,
  rng,
};
