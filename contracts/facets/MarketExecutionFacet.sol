// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {LibSettlement} from "../libraries/LibSettlement.sol";
import {IMarketExecution} from "../interfaces/IMarketExecution.sol";

/**
 * @title MarketExecutionFacet
 * @notice Refactored market execution facet using the new library architecture
 */
contract MarketExecutionFacet is IMarketExecution {

    /// @dev Caller must provide a route returned from simulateMarketOrder, and enforce slippage
    /// @notice Fill a market order by simulating match route and executing fill
    function fillMarketOrderWithRoute(
        uint256 positionId,
        uint256 amount,
        uint256 targetAvgPrice,
        bool fillOrKill,
        LibDoefinStorage.OrderDirection direction,
        LibDoefinStorage.MatchExecution[] calldata matches
    ) external {
        LibDoefinStorage.TakerOrderContext memory takerOrder = LibDoefinStorage.TakerOrderContext({
            taker: msg.sender,
            positionId: positionId,
            amount: amount,
            remainingAmount: amount,
            targetAvgPrice: targetAvgPrice,
            fillOrKill: fillOrKill,
            direction: direction
        });
        LibSettlement.executeMatchedRoute(takerOrder, matches);
    }

    /**
     * @notice Execute a market order with enhanced validation and reporting
     * @param positionId The position ID to trade
     * @param amount The amount to trade
     * @param targetAvgPrice The target average price (0 = no limit)
     * @param fillOrKill Whether to revert if not completely filled
     * @param direction The order direction (Buy/Sell)
     * @param matches Array of match executions
     * @param maxSlippage Maximum allowed slippage in basis points (10000 = 100%)
     * @return executionReport Detailed execution report
     */
    function fillMarketOrderWithSlippageProtection(
        uint256 positionId,
        uint256 amount,
        uint256 targetAvgPrice,
        bool fillOrKill,
        LibDoefinStorage.OrderDirection direction,
        LibDoefinStorage.MatchExecution[] calldata matches,
        uint256 maxSlippage
    ) external returns (MarketExecutionReport memory executionReport) {
        // Pre-execution validation
        uint256 expectedCost = _calculateExpectedCost(matches, amount);
        
        // Execute the order and get results
        (uint256 actualFilled, uint256 actualCost) = _executeOrderWithTracking(
            positionId, amount, targetAvgPrice, fillOrKill, direction, matches
        );
        
        // Calculate and validate slippage
        uint256 slippage = _calculateAndValidateSlippage(expectedCost, actualCost, maxSlippage);
        
        // Build execution report
        executionReport = _buildExecutionReport(
            positionId, direction, amount, actualFilled, actualCost,
            expectedCost, slippage, matches.length
        );
    }

    /**
     * @notice Batch execute multiple market orders
     * @param orders Array of market order parameters
     * @return reports Array of execution reports
     */
    function batchFillMarketOrders(
        MarketOrderParams[] calldata orders
    ) external returns (MarketExecutionReport[] memory reports) {
        reports = new MarketExecutionReport[](orders.length);
        
        for (uint256 i = 0; i < orders.length; i++) {
            reports[i] = _executeSingleOrderInBatch(orders[i]);
        }
    }

    /**
     * @notice Execute a single order within a batch
     * @param order The order parameters
     * @return report The execution report
     */
    function _executeSingleOrderInBatch(
        MarketOrderParams calldata order
    ) internal returns (MarketExecutionReport memory report) {
        try this.fillMarketOrderWithSlippageProtection(
            order.positionId,
            order.amount,
            order.targetAvgPrice,
            order.fillOrKill,
            order.direction,
            order.matches,
            order.maxSlippage
        ) returns (MarketExecutionReport memory successReport) {
            return successReport;
        } catch {
            return _createFailedReport(order);
        }
    }

    /**
     * @notice Create a failed execution report
     * @param order The order parameters
     * @return report The failed execution report
     */
    function _createFailedReport(
        MarketOrderParams calldata order
    ) internal view returns (MarketExecutionReport memory report) {
        report = MarketExecutionReport({
            taker: msg.sender,
            positionId: order.positionId,
            direction: order.direction,
            requestedAmount: order.amount,
            filledAmount: 0,
            remainingAmount: order.amount,
            expectedCost: 0,
            actualCost: 0,
            slippage: 0,
            matchCount: 0,
            avgPrice: 0,
            success: false
        });
    }

    /**
     * @notice Simulate market order execution without actually executing
     * @param positionId The position ID to trade
     * @param amount The amount to trade
     * @param direction The order direction
     * @param matches Array of potential matches
     * @return simulation Simulation results
     */
    function simulateMarketOrderExecution(
        uint256 positionId,
        uint256 amount,
        LibDoefinStorage.OrderDirection direction,
        LibDoefinStorage.MatchExecution[] calldata matches
    ) external view returns (MarketSimulation memory simulation) {
        uint256 totalFilled = 0;
        uint256 totalCost = 0;
        uint256 remainingAmount = amount;
        
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        
        for (uint256 i = 0; i < matches.length && remainingAmount > 0; i++) {
            LibDoefinStorage.MatchExecution calldata matchExec = matches[i];
            LibDoefinStorage.Order storage makerOrder = ds.orderbookStorage.orders[matchExec.matchedOrderId];
            
            // Validate order is still active and has sufficient amount
            if (!makerOrder.active || makerOrder.remainingAmount == 0) {
                continue;
            }
            
            uint256 fillAmount = remainingAmount > makerOrder.remainingAmount 
                ? makerOrder.remainingAmount 
                : remainingAmount;
            
            if (fillAmount > matchExec.amount) {
                fillAmount = matchExec.amount;
            }
            
            totalFilled += fillAmount;
            totalCost += (fillAmount * matchExec.effectivePrice) / 1e18; // Assuming 18 decimal precision
            remainingAmount -= fillAmount;
        }
        
        simulation = MarketSimulation({
            positionId: positionId,
            direction: direction,
            requestedAmount: amount,
            simulatedFilled: totalFilled,
            simulatedRemaining: remainingAmount,
            simulatedCost: totalCost,
            simulatedAvgPrice: totalFilled > 0 ? (totalCost * 1e18) / totalFilled : 0,
            wouldSucceed: remainingAmount == 0 || !_wouldFillOrKillFail(amount, totalFilled),
            matchesUsed: matches.length
        });
    }

    // ----------------------------------------
    // Helper Functions
    // ----------------------------------------

    /**
     * @notice Execute order with tracking for slippage protection
     * @param positionId The position ID
     * @param amount The amount to trade
     * @param targetAvgPrice The target average price
     * @param fillOrKill Whether to revert if not completely filled
     * @param direction The order direction
     * @param matches Array of match executions
     * @return actualFilled The actual amount filled
     * @return actualCost The actual cost
     */
    function _executeOrderWithTracking(
        uint256 positionId,
        uint256 amount,
        uint256 targetAvgPrice,
        bool fillOrKill,
        LibDoefinStorage.OrderDirection direction,
        LibDoefinStorage.MatchExecution[] calldata matches
    ) internal returns (uint256 actualFilled, uint256 actualCost) {
        // Record pre-execution state
        uint256 preBalance = _getUserBalance(msg.sender, positionId, direction);
        
        // Create taker order context
        LibDoefinStorage.TakerOrderContext memory takerOrder = LibDoefinStorage.TakerOrderContext({
            taker: msg.sender,
            positionId: positionId,
            amount: amount,
            remainingAmount: amount,
            targetAvgPrice: targetAvgPrice,
            fillOrKill: fillOrKill,
            direction: direction
        });

        // Execute the order
        LibSettlement.executeMatchedRoute(takerOrder, matches);
        
        // Calculate results
        uint256 postBalance = _getUserBalance(msg.sender, positionId, direction);
        actualFilled = amount - takerOrder.remainingAmount;
        actualCost = _calculateActualCost(preBalance, postBalance, direction);
    }

    /**
     * @notice Calculate and validate slippage
     * @param expectedCost The expected cost
     * @param actualCost The actual cost
     * @param maxSlippage Maximum allowed slippage in basis points
     * @return slippage The calculated slippage in basis points
     */
    function _calculateAndValidateSlippage(
        uint256 expectedCost,
        uint256 actualCost,
        uint256 maxSlippage
    ) internal pure returns (uint256 slippage) {
        if (expectedCost > 0 && actualCost > expectedCost) {
            slippage = ((actualCost - expectedCost) * 10000) / expectedCost;
        }
        require(slippage <= maxSlippage, "MarketExecutionFacetV2: Slippage exceeded");
    }

    /**
     * @notice Build execution report
     * @param positionId The position ID
     * @param direction The order direction
     * @param requestedAmount The requested amount
     * @param filledAmount The filled amount
     * @param actualCost The actual cost
     * @param expectedCost The expected cost
     * @param slippage The slippage in basis points
     * @param matchCount The number of matches
     * @return report The execution report
     */
    function _buildExecutionReport(
        uint256 positionId,
        LibDoefinStorage.OrderDirection direction,
        uint256 requestedAmount,
        uint256 filledAmount,
        uint256 actualCost,
        uint256 expectedCost,
        uint256 slippage,
        uint256 matchCount
    ) internal view returns (MarketExecutionReport memory report) {
        report = MarketExecutionReport({
            taker: msg.sender,
            positionId: positionId,
            direction: direction,
            requestedAmount: requestedAmount,
            filledAmount: filledAmount,
            remainingAmount: requestedAmount - filledAmount,
            expectedCost: expectedCost,
            actualCost: actualCost,
            slippage: slippage,
            matchCount: matchCount,
            avgPrice: filledAmount > 0 ? (actualCost * 1e18) / filledAmount : 0,
            success: true
        });
    }

    /**
     * @notice Calculate expected cost from matches
     * @param matches Array of match executions
     * @param maxAmount Maximum amount to fill
     * @return expectedCost The expected cost
     */
    function _calculateExpectedCost(
        LibDoefinStorage.MatchExecution[] calldata matches,
        uint256 maxAmount
    ) internal pure returns (uint256 expectedCost) {
        uint256 remainingAmount = maxAmount;
        
        for (uint256 i = 0; i < matches.length && remainingAmount > 0; i++) {
            uint256 fillAmount = remainingAmount > matches[i].amount 
                ? matches[i].amount 
                : remainingAmount;
            
            expectedCost += (fillAmount * matches[i].effectivePrice) / 1e18;
            remainingAmount -= fillAmount;
        }
    }

    /**
     * @notice Get user balance for position or collateral
     * @param user The user address
     * @param positionId The position ID
     * @param direction The order direction
     * @return balance The user's balance
     */
    function _getUserBalance(
        address user,
        uint256 positionId,
        LibDoefinStorage.OrderDirection direction
    ) internal view returns (uint256 balance) {
        if (direction == LibDoefinStorage.OrderDirection.Buy) {
            // For buy orders, we care about collateral token balance
            // This is simplified - in practice you'd need to know the collateral token
            return 0; // Placeholder
        } else {
            // For sell orders, we care about position token balance
            LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
            return ds.erc1155Storage.erc1155Balances[positionId][user];
        }
    }

    /**
     * @notice Calculate actual cost based on balance changes
     * @param preBalance Balance before execution
     * @param postBalance Balance after execution
     * @param direction Order direction
     * @return actualCost The actual cost
     */
    function _calculateActualCost(
        uint256 preBalance,
        uint256 postBalance,
        LibDoefinStorage.OrderDirection direction
    ) internal pure returns (uint256 actualCost) {
        if (direction == LibDoefinStorage.OrderDirection.Buy) {
            // For buy orders, cost is the decrease in collateral balance
            actualCost = preBalance > postBalance ? preBalance - postBalance : 0;
        } else {
            // For sell orders, cost is the decrease in position token balance
            actualCost = preBalance > postBalance ? preBalance - postBalance : 0;
        }
    }

    /**
     * @notice Check if fill-or-kill would fail
     * @param requestedAmount The requested amount
     * @param filledAmount The filled amount
     * @return wouldFail True if fill-or-kill would fail
     */
    function _wouldFillOrKillFail(
        uint256 requestedAmount,
        uint256 filledAmount
    ) internal pure returns (bool wouldFail) {
        return filledAmount < requestedAmount;
    }

    // ----------------------------------------
    // Data Structures
    // ----------------------------------------

    struct MarketOrderParams {
        uint256 positionId;
        uint256 amount;
        uint256 targetAvgPrice;
        bool fillOrKill;
        LibDoefinStorage.OrderDirection direction;
        LibDoefinStorage.MatchExecution[] matches;
        uint256 maxSlippage;
    }

    struct MarketExecutionReport {
        address taker;
        uint256 positionId;
        LibDoefinStorage.OrderDirection direction;
        uint256 requestedAmount;
        uint256 filledAmount;
        uint256 remainingAmount;
        uint256 expectedCost;
        uint256 actualCost;
        uint256 slippage; // In basis points
        uint256 matchCount;
        uint256 avgPrice;
        bool success;
    }

    struct MarketSimulation {
        uint256 positionId;
        LibDoefinStorage.OrderDirection direction;
        uint256 requestedAmount;
        uint256 simulatedFilled;
        uint256 simulatedRemaining;
        uint256 simulatedCost;
        uint256 simulatedAvgPrice;
        bool wouldSucceed;
        uint256 matchesUsed;
    }
}