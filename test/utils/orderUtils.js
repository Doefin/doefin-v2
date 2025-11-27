const { expect } = require("chai");
const { ethers } = require("hardhat");

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
  const ExecutionType = { Market: 0, Limit: 1 };
  const OrderType = { Standard: 0, CrossCurrency: 1 };
  const emptyCrossCurrencyConfig = {
    quoteCurrencyToken: ethers.constants.AddressZero,
    exchangeRateType: 0,
    exchangeRate: 0,
  };
  
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
      emptyCrossCurrencyConfig
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
  const ExecutionType = { Market: 0, Limit: 1 };
  const OrderType = { Standard: 0, CrossCurrency: 1 };
  const emptyCrossCurrencyConfig = {
    quoteCurrencyToken: ethers.constants.AddressZero,
    exchangeRateType: 0,
    exchangeRate: 0,
  };
  
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
      emptyCrossCurrencyConfig
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
  // Pass CrossCurrencyConfig as object struct
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
      {
        quoteCurrencyToken,
        exchangeRateType,
        exchangeRate,
      }
    );
}

async function createCrossCurrencyMarketOrder(
  facet,
  taker,
  {
    positionId,
    collateralToken,
    amount,
    pricePerToken = 0, // Market orders typically use 0 or max price
    minFillAmount = 0,
    expiry = 0,
    direction,
    fillOrKill = false,
    quoteCurrencyToken,
    exchangeRateType,
    exchangeRate,
  }
) {
  // Pass CrossCurrencyConfig as object struct
  return facet
    .connect(taker)
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
      {
        quoteCurrencyToken,
        exchangeRateType,
        exchangeRate,
      }
    );
}

async function validateOrderState(facet, orderId, expected) {
  const order = await facet.callStatic.getOrder(orderId);
  expect(order.amount).to.equal(expected.amount);
  expect(order.pricePerToken).to.equal(expected.price);
  expect(order.direction).to.equal(expected.direction);
  expect(order.active).to.equal(true);
}

// Enums matching contract definitions
const OrderDirection = {
  Buy: 0,
  Sell: 1,
};

const ExecutionType = {
  Market: 0,
  Limit: 1,
};

const OrderType = {
  Standard: 0,
  CrossCurrency: 1,
};

const ExchangeRateType = {
  Fixed: 0,
  Dynamic: 1,
};

module.exports = {
  createLimitOrder,
  createMarketOrder,
  createCrossCurrencyLimitOrder,
  createCrossCurrencyMarketOrder,
  validateOrderState,
  OrderDirection,
  ExecutionType,
  OrderType,
  ExchangeRateType,
};
