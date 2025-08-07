const { ethers } = require("hardhat");

/**
 * Add a collateral token with a specified unit price.
 */
async function addCollateralToken({ adminConfig, token, unit, caller }) {
  return adminConfig.addCollateralToken(token.address, unit);
}

/**
 * Remove a collateral token from allowed list.
 */
async function removeCollateralToken({ adminConfig, token, caller }) {
  return adminConfig.connect(caller).removeCollateralToken(token.address);
}

/**
 * Set trading fees (maker and taker) in BPS.
 */
async function setTradingFeesBps({ adminConfig, makerBps, takerBps, caller }) {
  return adminConfig.connect(caller).setTradingFeesBps(makerBps, takerBps);
}

/**
 * Set the resolution fee in BPS.
 */
async function setResolutionFeeBps({ adminConfig, bps, caller }) {
  return adminConfig.connect(caller).setResolutionFeeBps(bps);
}

/**
 * Set the address that will receive all protocol fees.
 */
async function setFeeReceiver({ adminConfig, feeReceiver, caller }) {
  return adminConfig
    .connect(caller)
    .setFeeReceiver(feeReceiver.address || feeReceiver);
}

/**
 * Check if a token is allowed as collateral.
 */
async function isAllowedCollateral(adminConfig, token) {
  return adminConfig.isAllowedCollateral(token.address);
}

/**
 * Get the configured unit price per pair for a collateral token.
 */
async function getCollateralUnit(adminConfig, token) {
  return adminConfig.getCollateralUnit(token.address);
}

/**
 * Get current fee config (receiver, resolutionFeeBps, makerBps, takerBps).
 */
async function getFees(adminConfig) {
  const [receiver, resolutionFeeBps, makerBps, takerBps] =
    await adminConfig.getFees();
  return {
    receiver,
    resolutionFeeBps,
    makerBps,
    takerBps,
  };
}

module.exports = {
  addCollateralToken,
  removeCollateralToken,
  setTradingFeesBps,
  setResolutionFeeBps,
  setFeeReceiver,
  isAllowedCollateral,
  getCollateralUnit,
  getFees,
};
