const { expect } = require("chai");
const { ethers } = require("hardhat");

// Enum mirrors contract values used by createOrder
const ExecutionType = {
  Market: 0,
  Limit: 1,
};

const OrderDirection = {
  Buy: 0,
  Sell: 1,
};

// Standard (empty) cross-currency data for non-cross-currency orders
const STANDARD_CROSS_CURRENCY_DATA = {
  quoteCurrencyToken: ethers.constants.AddressZero,
  floorRate: 0,
};

const buildCrossCurrencyData = ({
  quoteCurrencyToken,
  floorRate = 0,
}) => ({
  quoteCurrencyToken: quoteCurrencyToken || ethers.constants.AddressZero,
  floorRate: floorRate || 0,
});

// Helper function to create Fixed cross-currency orders (floorRate = 0)
async function createFixedCrossCurrencyOrder(
  facet,
  maker,
  {
    positionId,
    collateralToken,
    amount,
    pricePerToken, // For Fixed orders, this should already be in quote currency
    minFillAmount = 0,
    expiry = 0,
    direction,
    fillOrKill = false,
    quoteCurrencyToken,
    executionType = ExecutionType.Limit,
  }
) {
  return facet
    .connect(maker)
    .createOrder(
      positionId,
      collateralToken,
      amount,
      pricePerToken,
      minFillAmount,
      expiry,
      fillOrKill,
      direction,
      executionType,
      buildCrossCurrencyData({ quoteCurrencyToken, floorRate: 0 })
    );
}

// Helper function to create Dynamic cross-currency orders (floorRate > 0)
async function createDynamicCrossCurrencyOrder(
  facet,
  maker,
  {
    positionId,
    collateralToken,
    amount,
    pricePerToken, // For Dynamic orders, this should be in collateral currency
    minFillAmount = 0,
    expiry = 0,
    direction,
    fillOrKill = false,
    quoteCurrencyToken,
    floorRate, // Required for Dynamic orders
    executionType = ExecutionType.Limit,
  }
) {
  if (!floorRate || floorRate === 0) {
    throw new Error("Dynamic cross-currency orders require a non-zero floorRate");
  }
  
  return facet
    .connect(maker)
    .createOrder(
      positionId,
      collateralToken,
      amount,
      pricePerToken,
      minFillAmount,
      expiry,
      fillOrKill,
      direction,
      executionType,
      buildCrossCurrencyData({ quoteCurrencyToken, floorRate })
    );
}

async function createLimitOrder(
  facet,
  maker,
  {
    positionId,
    collateralToken,
    amount,
    pricePerToken,
    minFillAmount = 0,
    expiry = 0,
    direction,
    fillOrKill = false,
  }
) {
  
  return facet
    .connect(maker)
    .createOrder(
      positionId,
      collateralToken,
      amount,
      pricePerToken,
      minFillAmount,
      expiry,
      fillOrKill,
      direction,
      ExecutionType.Limit,
      STANDARD_CROSS_CURRENCY_DATA
    );
}

async function createMarketOrder(
  facet,
  maker,
  {
    positionId,
    collateralToken,
    amount,
    pricePerToken,
    minFillAmount = 0,
    expiry = 0,
    direction,
    fillOrKill = false,
  }
) {
  return facet
    .connect(maker)
    .createOrder(
      positionId,
      collateralToken,
      amount,
      pricePerToken,
      minFillAmount,
      expiry,
      fillOrKill,
      direction,
      ExecutionType.Market,
      STANDARD_CROSS_CURRENCY_DATA
    );
}

async function createCrossCurrencyLimitOrder(
  facet,
  maker,
  {
    positionId,
    collateralToken,
    amount,
    pricePerToken,
    minFillAmount = 0,
    expiry = 0,
    direction,
    fillOrKill = false,
    quoteCurrencyToken,
    floorRate = 0,
  }
) {
  // Cross-currency limit order uses the provided cross-currency data
  return facet
    .connect(maker)
    .createOrder(
      positionId,
      collateralToken,
      amount,
      pricePerToken,
      minFillAmount,
      expiry,
      fillOrKill,
      direction,
      ExecutionType.Limit,
      buildCrossCurrencyData({ quoteCurrencyToken, floorRate })
    );
}

async function createCrossCurrencyMarketOrder(
  facet,
  maker,
  {
    positionId,
    collateralToken,
    amount,
    pricePerToken,
    minFillAmount = 0,
    expiry = 0,
    direction,
    fillOrKill = false,
    quoteCurrencyToken,
    floorRate = 0,
  }
) {
  return facet
    .connect(maker)
    .createOrder(
      positionId,
      collateralToken,
      amount,
      pricePerToken,
      minFillAmount,
      expiry,
      fillOrKill,
      direction,
      ExecutionType.Market,
      buildCrossCurrencyData({ quoteCurrencyToken, floorRate })
    );
}

async function validateOrderState(facet, orderId, expected) {
  const order = await facet.callStatic.getOrder(orderId);
  expect(order.amount).to.equal(expected.amount);
  expect(order.pricePerToken).to.equal(expected.price);
  expect(order.direction).to.equal(expected.direction);
  expect(order.active).to.equal(true);
}

module.exports = {
  createLimitOrder,
  createMarketOrder,
  createCrossCurrencyLimitOrder,
  createCrossCurrencyMarketOrder,
  createFixedCrossCurrencyOrder,
  createDynamicCrossCurrencyOrder,
  validateOrderState,
  buildCrossCurrencyData,
  ExecutionType,
  OrderDirection,
  STANDARD_CROSS_CURRENCY_DATA,
};
