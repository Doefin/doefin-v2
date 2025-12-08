const { expect } = require("chai");
const { ethers } = require("hardhat");

// Enum mirrors contract values used by createOrder
const ExecutionType = {
  Market: 0,
  Limit: 1,
};

const OrderType = {
  Standard: 0,
  CrossCurrency: 1,
};

const OrderDirection = {
  Buy: 0,
  Sell: 1,
};

const ExchangeRateType = {
  Fixed: 0,
  Dynamic: 1,
};

const EMPTY_CROSS_CURRENCY_CONFIG = {
  quoteCurrencyToken: ethers.constants.AddressZero,
  exchangeRateType: ExchangeRateType.Fixed,
  exchangeRate: 0,
};

const buildCrossCurrencyConfig = ({
  quoteCurrencyToken,
  exchangeRateType = ExchangeRateType.Fixed,
  exchangeRate = 0,
}) => ({
  quoteCurrencyToken,
  exchangeRateType,
  exchangeRate,
});

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
      OrderType.Standard,
      EMPTY_CROSS_CURRENCY_CONFIG
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
      OrderType.Standard,
      EMPTY_CROSS_CURRENCY_CONFIG
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
    exchangeRateType,
    exchangeRate,
  }
) {
  // Cross-currency limit order uses the provided FX config
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
      OrderType.CrossCurrency,
      buildCrossCurrencyConfig({ quoteCurrencyToken, exchangeRateType, exchangeRate })
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
    exchangeRateType,
    exchangeRate,
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
      OrderType.CrossCurrency,
      buildCrossCurrencyConfig({ quoteCurrencyToken, exchangeRateType, exchangeRate })
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
  validateOrderState,
  ExecutionType,
  OrderType,
  OrderDirection,
  ExchangeRateType,
};
