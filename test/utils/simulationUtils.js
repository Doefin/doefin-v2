const MATCH_TYPE_LABELS = {
  0: "None",
  1: "Complementary",
  2: "Mint",
  3: "Merge",
  4: "CrossCurrency",
};

/**
 * Simulates a market order and returns structured match route details.
 *
 * @param {Contract} routeSimFacet - The RouteSimulationFacet contract instance
 * @param {string} positionId - The ERC1155 position token ID
 * @param {BigNumber} amount - The desired amount to fill
 * @param {number} direction - 0 for BUY, 1 for SELL
 * @param {Object} crossCurrencyData - Optional cross-currency configuration.
 *   If not provided, defaults to standard order (quoteCurrencyToken = address(0))
 * @returns {{
 *   matches: {
 *     matchedOrderId: BigNumber,
 *     amount: BigNumber,
 *     effectivePrice: BigNumber,
 *     matchType: number
 *   }[],
 *   totalInputAmount: BigNumber,
 *   totalOutputAmount: BigNumber
 * }}
 */
async function simulateAndParseMatchRoute({
  routeSimFacet,
  positionId,
  amount,
  direction,
  crossCurrencyData
}) {
  // Default to standard order if no cross-currency data provided
  const ccData = crossCurrencyData || {
    quoteCurrencyToken: "0x0000000000000000000000000000000000000000", // address(0) for standard orders
    floorRate: 0
  };

  const matchRoute = await routeSimFacet.simulateMarketOrder(
    positionId,
    amount,
    direction,
    ccData
  );

  const structuredMatches = matchRoute.matches.map(
    ([orderId, amt, price, matchType]) => ({
      matchedOrderId: orderId,
      amount: amt,
      effectivePrice: price,
      matchType,
      matchTypeLabel: MATCH_TYPE_LABELS[matchType] || "Unknown",
    })
  );

  return {
    matches: structuredMatches,
    totalInputAmount: matchRoute.totalInputAmount,
    totalOutputAmount: matchRoute.totalOutputAmount,
  };
}

module.exports = {
  simulateAndParseMatchRoute,
};
