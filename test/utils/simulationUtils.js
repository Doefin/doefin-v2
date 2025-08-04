const MATCH_TYPE_LABELS = {
    0: "Complementary",
    1: "Mint",
    2: "Merge"
};

/**
 * Simulates a market order and returns structured match route details.
 * 
 * @param {Contract} routeSimFacet - The RouteSimulationFacet contract instance
 * @param {string} positionId - The ERC1155 position token ID
 * @param {BigNumber} amount - The desired amount to fill
 * @param {number} direction - 0 for BUY, 1 for SELL
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
async function simulateAndParseMatchRoute({ routeSimFacet, positionId, amount, direction }) {
    const matchRoute = await routeSimFacet.simulateMarketOrder(positionId, amount, direction);

    const structuredMatches = matchRoute.matches.map(([orderId, amt, price, matchType]) => ({
        matchedOrderId: orderId,
        amount: amt,
        effectivePrice: price,
        matchType,
        matchTypeLabel: MATCH_TYPE_LABELS[matchType] || "Unknown"
    }));

    return {
        matches: structuredMatches,
        totalInputAmount: matchRoute.totalInputAmount,
        totalOutputAmount: matchRoute.totalOutputAmount
    };
}

module.exports = {
    simulateAndParseMatchRoute
};
