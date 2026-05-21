// Shared fixture for audit/pentest tests under `test/audit/`. Mirrors the
// setup in `test/unit/SettlementFacet/SettlementFacet.test.js` but is reusable
// across pentests and exposes a 7th `attacker` signer.
//
// Mocha loads .js files under test/, but files without `describe`/`it` blocks
// register no tests, so this helper is silent at test discovery.

const { ethers } = require("hardhat");
const { deployDiamond } = require("../../scripts/deploy.js");
const { getConditionId, getCollectionId, getPositionId } = require("./ctfUtils.js");

const UNIT = ethers.utils.parseUnits("1", 6); // 1e6 (USDC-like)
const FEE_BPS = 200; // 2 % — operator fee rate used to size per-leg fees
const MAX_FEE_RATE_BPS = 500; // admin-set ceiling configured by the fixture
const DOMAIN_NAME = "Doefin Exchange";
const DOMAIN_VERSION = "3";

// SCRUM-224: 11-field struct — `feeRateBps` removed (operator-supplied fee model).
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
    { name: "minFillAmount", type: "uint128" },
    { name: "expiration", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
};

/**
 * Size an operator-supplied per-leg fee at `feeRateBps` of a contract-derived
 * collateral leg (`price * fill / UNIT`). Guaranteed within the configured
 * max-rate ceiling, so `_validateFee` accepts it.
 */
function legFee(price, fill, feeRateBps = FEE_BPS, unit = UNIT) {
  const cashValue = ethers.BigNumber.from(price).mul(fill).div(unit);
  return cashValue.mul(feeRateBps).div(10000);
}

/**
 * Stand up a fresh Diamond with the v3 settlement core wired in, one
 * allow-listed collateral token, a binary market, funded actors, and seeded
 * positionA/positionB inventory. Returns everything a pentest needs.
 */
async function setupAuditFixture() {
  const [owner, operator, buyer, seller, buyerB, feeReceiver, attacker] = await ethers.getSigners();

  const diamondAddress = await deployDiamond();

  const settlement       = await ethers.getContractAt("SettlementFacet",        diamondAddress);
  const sigVerifier      = await ethers.getContractAt("SignatureVerifierFacet", diamondAddress);
  const nonceMgr         = await ethers.getContractAt("NonceManagerFacet",      diamondAddress);
  const adminConfig      = await ethers.getContractAt("AdminConfigFacet",       diamondAddress);
  const conditionMgr     = await ethers.getContractAt("ConditionManagerFacet",  diamondAddress);
  const conditionalTokens = await ethers.getContractAt("ConditionalTokensFacet", diamondAddress);
  const erc1155Facet     = await ethers.getContractAt("ERC1155Facet",           diamondAddress);
  const accessControl    = await ethers.getContractAt("AccessControlFacet",     diamondAddress);

  // Mock USDC-like collateral (6 decimals, unitPerPair = 1e6).
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const collateral = await MockERC20.deploy("Mock USDC", "USDC", 6);
  await collateral.deployed();

  await adminConfig.addCollateralToken(collateral.address, UNIT);
  await adminConfig.setFeeReceiver(feeReceiver.address);
  await adminConfig.setMaxFeeRate(MAX_FEE_RATE_BPS);
  await settlement.setOperator(operator.address);
  await accessControl.addMarketMaker(owner.address);

  // One binary condition with outcomes A (indexSet=1) and B (indexSet=2).
  const questionId = ethers.utils.formatBytes32String("audit-pentest-q1");
  const conditionId = getConditionId(owner.address, questionId, 2);
  await conditionMgr.createCondition(owner.address, questionId, 2, "ipfs://audit");

  const collectionIdA = await getCollectionId(ethers.constants.HashZero, conditionId, 1, ethers.provider);
  const collectionIdB = await getCollectionId(ethers.constants.HashZero, conditionId, 2, ethers.provider);
  const positionIdA = getPositionId(collateral.address, collectionIdA);
  const positionIdB = getPositionId(collateral.address, collectionIdB);

  // Fund + approve all actors.
  const mintAmount = ethers.utils.parseUnits("100000", 6);
  const actors = [owner, buyer, seller, buyerB, operator, attacker];
  for (const a of actors) {
    await collateral.mint(a.address, mintAmount);
    await collateral.connect(a).approve(diamondAddress, ethers.constants.MaxUint256);
    await erc1155Facet.connect(a).setApprovalForAll(diamondAddress, true);
  }

  // Seed the position-pair registry by splitting once; distribute inventory.
  const splitAmount = ethers.utils.parseUnits("10000", 6);
  await conditionalTokens.connect(owner).splitPosition(
    collateral.address,
    ethers.constants.HashZero,
    conditionId,
    [1, 2],
    splitAmount,
  );
  await erc1155Facet.connect(owner).safeTransferFrom(owner.address, seller.address, positionIdA, splitAmount, "0x");
  await erc1155Facet.connect(owner).safeTransferFrom(owner.address, buyerB.address, positionIdB, splitAmount, "0x");

  function makeDomain() {
    return {
      name: DOMAIN_NAME,
      version: DOMAIN_VERSION,
      chainId: 31337,
      verifyingContract: diamondAddress,
    };
  }

  function makeOrder(maker, positionId, side, amount, price, overrides = {}) {
    // SCRUM-224: `feeRateBps` is no longer part of the signed order. Any
    // `feeRateBps` key in `overrides` is silently dropped for back-compat.
    const { feeRateBps, ...rest } = overrides;
    return {
      salt: 1,
      maker,
      signer: maker,
      positionId: ethers.utils.hexZeroPad(ethers.BigNumber.from(positionId).toHexString(), 32),
      collateralToken: collateral.address,
      side,
      amount,
      pricePerToken: price,
      minFillAmount: 0,
      expiration: 0,
      nonce: 0,
      ...rest,
    };
  }

  async function signOrder(signer, order) {
    return signer._signTypedData(makeDomain(), ORDER_TYPE, order);
  }

  /**
   * Deploy + allow-list a second collateral token with a chosen decimals/unit.
   * Used by cross-token pentests (e.g. SEC-001).
   */
  async function addCollateralToken(name, symbol, decimals, unit, fundAmount) {
    const T = await MockERC20.deploy(name, symbol, decimals);
    await T.deployed();
    await adminConfig.addCollateralToken(T.address, unit);
    const amount = fundAmount || ethers.utils.parseUnits("100000", decimals);
    for (const a of actors) {
      await T.mint(a.address, amount);
      await T.connect(a).approve(diamondAddress, ethers.constants.MaxUint256);
    }
    return T;
  }

  return {
    diamondAddress,
    contracts: {
      settlement, sigVerifier, nonceMgr, adminConfig, conditionMgr,
      conditionalTokens, erc1155Facet, accessControl, collateral,
    },
    signers: { owner, operator, buyer, seller, buyerB, feeReceiver, attacker },
    market: { conditionId, positionIdA, positionIdB },
    constants: { UNIT, FEE_BPS, MAX_FEE_RATE_BPS, DOMAIN_NAME, DOMAIN_VERSION },
    helpers: { makeOrder, signOrder, makeDomain, addCollateralToken, legFee },
  };
}

module.exports = { setupAuditFixture, ORDER_TYPE, UNIT, FEE_BPS, MAX_FEE_RATE_BPS, legFee };
