const { ethers } = require("hardhat");

async function mintAndApproveERC20({ token, minter, to, spender, amount }) {
  await token.connect(minter).mint(to.address, amount);
  await token.connect(to).approve(spender, amount);
}

function calculateMakerFee(amount, bps = 200) {
  return amount.mul(bps).div(10_000);
}

function calculateTotalWithFee(amount, bps = 200) {
  return amount.add(calculateMakerFee(amount, bps));
}

function computeTradeBreakdown(
  amount,
  pricePerToken,
  direction,
  makerFeeBps,
  takerFeeBps
) {
  const cost = pricePerToken.mul(amount);
  const makerFee = cost.mul(makerFeeBps).div(10_000);
  const takerFee = cost.mul(takerFeeBps).div(10_000);

  let totalTakerPays, totalMakerReceives, totalMakerLocks;

  if (direction === 0) {
    // Maker is BUYING: they lock cost + makerFee
    totalMakerLocks = cost.add(makerFee);
    totalMakerReceives = ethers.constants.Zero; // receives ERC1155, not ERC20
    totalTakerPays = cost.add(takerFee); // taker pays cost + takerFee (in ERC20)
  } else {
    // Maker is SELLING: they lock ERC1155
    totalMakerLocks = ethers.constants.Zero; // ERC20 not locked, ERC1155 is
    totalMakerReceives = cost.sub(makerFee); // receives net cost
    totalTakerPays = cost.add(takerFee); // taker pays cost + takerFee
  }

  return {
    cost,
    makerFee,
    takerFee,
    totalTakerPays,
    totalMakerReceives,
    totalMakerLocks,
  };
}

module.exports = {
  mintAndApproveERC20,
  calculateMakerFee,
  calculateTotalWithFee,
};
