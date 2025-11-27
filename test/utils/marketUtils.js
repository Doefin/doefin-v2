const { ethers } = require("hardhat");
const { getConditionId } = require("./ctfUtils.js");
const { mintAndApproveERC20 } = require("./erc20Utils.js");
const { splitConditionAndGetPositionIds } = require("./conditionUtils.js");
const { createLimitOrder } = require("./orderUtils.js");

/**
 * Creates a complete market setup with condition, positions, and initial liquidity
 * @param {Object} params
 * @param {Contract} params.conditionManagerFacet
 * @param {Contract} params.conditionalFacet
 * @param {Contract} params.exchangeFacet
 * @param {Contract} params.erc20
 * @param {Signer} params.oracle
 * @param {Signer} params.owner
 * @param {string} params.questionId
 * @param {number} params.outcomeSlotCount
 * @param {BigNumber} params.initialLiquidity
 * @param {string} params.ipfsHash
 * @returns {Promise<{conditionId: string, positionIds: string[], yesId: string, noId: string}>}
 */
async function createCompleteMarket({
  conditionManagerFacet,
  conditionalFacet,
  exchangeFacet,
  erc20,
  oracle,
  owner,
  questionId,
  outcomeSlotCount = 2,
  initialLiquidity = ethers.utils.parseEther("100"),
  ipfsHash = "ipfs://default",
  diamondAddress,
}) {
  // Create condition
  const conditionId = getConditionId(
    oracle.address,
    questionId,
    outcomeSlotCount
  );

  await conditionManagerFacet
    .connect(owner)
    .createCondition(oracle.address, questionId, outcomeSlotCount, ipfsHash);

  // Check current balance and allowance
  const currentBalance = await erc20.balanceOf(owner.address);
  const currentAllowance = await erc20.allowance(owner.address, diamondAddress);

  // Mint additional tokens if needed
  if (currentBalance.lt(initialLiquidity)) {
    await erc20.mint(owner.address, initialLiquidity.sub(currentBalance));
  }

  // Approve additional allowance if needed
  if (currentAllowance.lt(initialLiquidity)) {
    await erc20
      .connect(owner)
      .approve(diamondAddress, currentAllowance.add(initialLiquidity));
  }

  // Split condition to create position tokens
  const indexSets = Array.from({ length: outcomeSlotCount }, (_, i) => 1 << i);
  const [positionIds, _amounts] = await splitConditionAndGetPositionIds({
    user: owner,
    amount: initialLiquidity,
    conditionId,
    indexSets,
    erc20,
    conditionalFacet,
  });

  return {
    conditionId,
    positionIds,
    yesId: positionIds[0],
    noId: positionIds[1],
  };
}

/**
 * Creates multiple limit orders at different price levels
 * @param {Object} params
 * @param {Contract} params.exchangeFacet
 * @param {Contract} params.erc1155
 * @param {Contract} params.erc20
 * @param {Signer} params.maker
 * @param {Signer} params.owner
 * @param {string} params.positionId
 * @param {Array} params.orderConfigs - Array of {amount, price, direction, minFill?}
 * @param {string} params.diamondAddress
 * @returns {Promise<Array<BigNumber>>} Array of order IDs
 */
async function createMultipleLimitOrders({
  exchangeFacet,
  erc1155,
  erc20,
  maker,
  owner,
  positionId,
  orderConfigs,
  diamondAddress,
}) {
  const orderIds = [];

  // Set approval for all first
  await erc1155.connect(maker).setApprovalForAll(diamondAddress, true);

  for (const config of orderConfigs) {
    const { amount, price, direction, minFill = amount } = config;

    if (direction === 1) {
      // SELL - need ERC1155 tokens
      await erc1155
        .connect(owner)
        .safeTransferFrom(
          owner.address,
          maker.address,
          positionId,
          amount,
          "0x"
        );
    } else {
      // BUY - need ERC20 tokens
      const cost = amount.mul(price).div(ethers.utils.parseEther("1"));
      const fee = cost.mul(200).div(10000); // Assume 2% maker fee
      const totalCost = cost.add(fee);

      await mintAndApproveERC20({
        token: erc20,
        minter: owner,
        to: maker,
        amount: totalCost,
        spender: diamondAddress,
      });
    }

    try {
      await createLimitOrder(exchangeFacet, maker, {
        positionId,
        collateralToken: erc20.address,
        amount,
        pricePerToken: price,
        minFillAmount: minFill,
        expiry: 0,
        direction,
      });

      const orderId = (await exchangeFacet.callStatic.getNextOrderId()) - 1;
      orderIds.push(orderId);
    } catch (error) {
      console.error("Failed to create limit order:", error.message);
      throw error;
    }
  }

  return orderIds;
}

/**
 * Sets up a complex orderbook with multiple makers and price levels
 * @param {Object} params
 * @param {Contract} params.exchangeFacet
 * @param {Contract} params.erc1155
 * @param {Contract} params.erc20
 * @param {Array<Signer>} params.makers
 * @param {Signer} params.owner
 * @param {string} params.positionId
 * @param {Object} params.config - {sellOrders: Array, buyOrders: Array}
 * @param {string} params.diamondAddress
 * @returns {Promise<{sellOrderIds: Array, buyOrderIds: Array}>}
 */
async function setupComplexOrderbook({
  exchangeFacet,
  erc1155,
  erc20,
  makers,
  owner,
  positionId,
  config,
  diamondAddress,
}) {
  const { sellOrders = [], buyOrders = [] } = config;

  const sellOrderIds = [];
  const buyOrderIds = [];

  // Create SELL orders
  for (let i = 0; i < sellOrders.length; i++) {
    const maker = makers[i % makers.length];
    const orderConfig = { ...sellOrders[i], direction: 1 };

    try {
      const [orderId] = await createMultipleLimitOrders({
        exchangeFacet,
        erc1155,
        erc20,
        maker,
        owner,
        positionId,
        orderConfigs: [orderConfig],
        diamondAddress,
      });

      sellOrderIds.push(orderId);
    } catch (error) {
      console.error(`Failed to create SELL order ${i + 1}:`, error.message);
    }
  }

  // Create BUY orders
  for (let i = 0; i < buyOrders.length; i++) {
    const maker = makers[i % makers.length];
    const orderConfig = { ...buyOrders[i], direction: 0 };

    try {
      const [orderId] = await createMultipleLimitOrders({
        exchangeFacet,
        erc1155,
        erc20,
        maker,
        owner,
        positionId,
        orderConfigs: [orderConfig],
        diamondAddress,
      });

      buyOrderIds.push(orderId);
    } catch (error) {
      console.error(`Failed to create BUY order ${i + 1}:`, error.message);
    }
  }

  return { sellOrderIds, buyOrderIds };
}

/**
 * Validates order book state and sorting
 * @param {Contract} exchangeFacet
 * @param {string} positionId
 * @param {number} direction - 0 for BUY, 1 for SELL
 * @returns {Promise<{orders: Array, isSorted: boolean, totalLiquidity: BigNumber}>}
 */
async function validateOrderbook(exchangeFacet, positionId, direction) {
  const orderIds = await exchangeFacet.getOrderbook(positionId, direction);
  const orders = [];
  let totalLiquidity = ethers.constants.Zero;
  let isSorted = true;

  for (let i = 0; i < orderIds.length; i++) {
    const order = await exchangeFacet.getOrder(orderIds[i]);
    orders.push(order);
    totalLiquidity = totalLiquidity.add(order.amount);

    // Check sorting
    if (i > 0) {
      const prevOrder = orders[i - 1];
      if (direction === 1) {
        // SELL orders should be ascending by price
        if (order.pricePerToken.lt(prevOrder.pricePerToken)) {
          isSorted = false;
        }
      } else {
        // BUY orders should be descending by price
        if (order.pricePerToken.gt(prevOrder.pricePerToken)) {
          isSorted = false;
        }
      }
    }
  }

  return { orders, isSorted, totalLiquidity };
}

/**
 * Calculates expected trade costs including fees
 * @param {BigNumber} amount
 * @param {BigNumber} price
 * @param {number} direction - 0 for BUY, 1 for SELL
 * @param {Object} feeConfig - {makerBps, takerBps}
 * @param {BigNumber} unit - Price unit (e.g., parseEther("1"))
 * @returns {Object} - {baseCost, makerFee, takerFee, totalMakerCost, totalTakerCost, netReceived}
 */
function calculateTradeCosts(amount, price, direction, feeConfig, unit) {
  const baseCost = amount.mul(price).div(unit);
  const makerFee = baseCost.mul(feeConfig.makerBps).div(10000);
  const takerFee = baseCost.mul(feeConfig.takerBps).div(10000);

  let totalMakerCost, totalTakerCost, netReceived;

  if (direction === 0) {
    // BUY
    totalMakerCost = baseCost.add(makerFee);
    totalTakerCost = baseCost.add(takerFee);
    netReceived = ethers.constants.Zero; // Receives ERC1155 tokens
  } else {
    // SELL
    totalMakerCost = ethers.constants.Zero; // Locks ERC1155 tokens
    totalTakerCost = ethers.constants.Zero; // Pays ERC1155 tokens
    netReceived = baseCost.sub(takerFee);
  }

  return {
    baseCost,
    makerFee,
    takerFee,
    totalMakerCost,
    totalTakerCost,
    netReceived,
  };
}

/**
 * Creates a market scenario for testing specific conditions
 * @param {Object} params
 * @param {string} params.scenario - "low_liquidity", "high_spread", "balanced", "one_sided"
 * @param {Object} params.contracts - All required contract instances
 * @param {Array<Signer>} params.signers
 * @param {string} params.diamondAddress
 * @param {Object} params.existingMarket - Optional existing market to use instead of creating new one
 * @returns {Promise<Object>} Market setup details
 */
async function createMarketScenario({
  scenario,
  contracts,
  signers,
  diamondAddress,
  existingMarket = null,
}) {
  const {
    conditionManagerFacet,
    conditionalFacet,
    exchangeFacet,
    erc20,
    erc1155,
  } = contracts;
  const [owner, oracle, ...makers] = signers;

  let market;
  
  if (existingMarket) {
    market = existingMarket;
  } else {
    const questionId = ethers.utils.id(`scenario-${scenario}-${Date.now()}`);

    // Create basic market
    market = await createCompleteMarket({
      conditionManagerFacet,
      conditionalFacet,
      exchangeFacet,
      erc20,
      oracle,
      owner,
      questionId,
      diamondAddress,
    });
  }

  let orderConfig;

  switch (scenario) {
    case "low_liquidity":
      orderConfig = {
        sellOrders: [
          {
            amount: ethers.utils.parseEther("1"),
            price: ethers.utils.parseEther("0.6"),
          },
        ],
        buyOrders: [
          {
            amount: ethers.utils.parseEther("1"),
            price: ethers.utils.parseEther("0.4"),
          },
        ],
      };
      break;

    case "high_spread":
      orderConfig = {
        sellOrders: [
          {
            amount: ethers.utils.parseEther("5"),
            price: ethers.utils.parseEther("0.8"),
          },
        ],
        buyOrders: [
          {
            amount: ethers.utils.parseEther("5"),
            price: ethers.utils.parseEther("0.2"),
          },
        ],
      };
      break;

    case "balanced":
      orderConfig = {
        sellOrders: [
          {
            amount: ethers.utils.parseEther("10"),
            price: ethers.utils.parseEther("0.52"),
          },
          {
            amount: ethers.utils.parseEther("8"),
            price: ethers.utils.parseEther("0.55"),
          },
          {
            amount: ethers.utils.parseEther("6"),
            price: ethers.utils.parseEther("0.58"),
          },
        ],
        buyOrders: [
          {
            amount: ethers.utils.parseEther("10"),
            price: ethers.utils.parseEther("0.48"),
          },
          {
            amount: ethers.utils.parseEther("8"),
            price: ethers.utils.parseEther("0.45"),
          },
          {
            amount: ethers.utils.parseEther("6"),
            price: ethers.utils.parseEther("0.42"),
          },
        ],
      };
      break;

    case "one_sided":
      orderConfig = {
        sellOrders: [
          {
            amount: ethers.utils.parseEther("20"),
            price: ethers.utils.parseEther("0.3"),
          },
          {
            amount: ethers.utils.parseEther("15"),
            price: ethers.utils.parseEther("0.4"),
          },
          {
            amount: ethers.utils.parseEther("10"),
            price: ethers.utils.parseEther("0.5"),
          },
        ],
        buyOrders: [],
      };
      break;

    default:
      throw new Error(`Unknown scenario: ${scenario}`);
  }

  const orderbook = await setupComplexOrderbook({
    exchangeFacet,
    erc1155,
    erc20,
    makers,
    owner,
    positionId: market.yesId,
    config: orderConfig,
    diamondAddress,
  });

  return {
    ...market,
    ...orderbook,
    scenario,
    orderConfig,
  };
}

/**
 * Measures gas usage for a transaction
 * @param {Promise} txPromise - Transaction promise
 * @returns {Promise<{receipt: Object, gasUsed: BigNumber}>}
 */
async function measureGas(txPromise) {
  const tx = await txPromise;
  const receipt = await tx.wait();
  return {
    receipt,
    gasUsed: receipt.gasUsed,
  };
}

/**
 * Waits for a specific number of blocks
 * @param {number} blocks - Number of blocks to wait
 */
async function waitBlocks(blocks) {
  for (let i = 0; i < blocks; i++) {
    await ethers.provider.send("evm_mine");
  }
}

/**
 * Sets the next block timestamp
 * @param {number} timestamp - Unix timestamp
 */
async function setNextBlockTimestamp(timestamp) {
  await ethers.provider.send("evm_setNextBlockTimestamp", [timestamp]);
}

/**
 * Increases time by specified seconds
 * @param {number} seconds - Seconds to increase
 */
async function increaseTime(seconds) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine");
}

module.exports = {
  createCompleteMarket,
  createMultipleLimitOrders,
  setupComplexOrderbook,
  validateOrderbook,
  calculateTradeCosts,
  createMarketScenario,
  measureGas,
  waitBlocks,
  setNextBlockTimestamp,
  increaseTime,
};
