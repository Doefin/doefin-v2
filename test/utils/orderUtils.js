const { expect } = require("chai");

async function createLimitOrder(
  facet,
  maker,
  {
    positionId,
    collateralToken,
    amount,
    pricePerToken,
    minFillAmount,
    expiry,
    direction,
  }
) {
  return facet
    .connect(maker)
    .createLimitOrder(
      positionId,
      collateralToken,
      amount,
      pricePerToken,
      minFillAmount,
      expiry,
      direction,
      1 // 1 is for limit orders
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
    minFillAmount,
    expiry,
    direction,
  }
) {
  return facet
    .connect(maker)
    .createLimitOrder(
      positionId,
      collateralToken,
      amount,
      pricePerToken,
      minFillAmount,
      expiry,
      direction,
      0 // 0 is for market order
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
  validateOrderState,
};
