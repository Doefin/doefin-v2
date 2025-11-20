// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";

/**
 * @title Events
 * @notice Centralized event definitions for the Doefin protocol
 * @dev All events are defined here for consistency and easier maintenance
 */
library Events {
    // ========================================
    // ADMIN CONFIGURATION EVENTS
    // ========================================

    /// @notice Emitted when a collateral token is added to the system
    /// @param token Address of the collateral token
    /// @param unitPerPair Unit amount per token pair
    event CollateralTokenAdded(address indexed token, uint256 unitPerPair);

    /// @notice Emitted when a collateral token is removed from the system
    /// @param token Address of the collateral token
    event CollateralTokenRemoved(address indexed token);

    /// @notice Emitted when the fee receiver address is updated
    /// @param oldReceiver Previous fee receiver address
    /// @param newReceiver New fee receiver address
    event FeeReceiverUpdated(address indexed oldReceiver, address indexed newReceiver);

    /// @notice Emitted when the resolution fee is updated
    /// @param oldFeeBps Previous fee in basis points
    /// @param newFeeBps New fee in basis points
    event ResolutionFeeUpdated(uint16 oldFeeBps, uint16 newFeeBps);

    /// @notice Emitted when trading fees are updated
    /// @param oldMakerBps Previous maker fee in basis points
    /// @param oldTakerBps Previous taker fee in basis points
    /// @param newMakerBps New maker fee in basis points
    /// @param newTakerBps New taker fee in basis points
    event TradingFeesUpdated(uint16 oldMakerBps, uint16 oldTakerBps, uint16 newMakerBps, uint16 newTakerBps);

    // ========================================
    // ACCESS CONTROL EVENTS
    // ========================================

    /// @notice Emitted when market maker status is updated
    /// @param account Address of the account
    /// @param status New market maker status
    event MarketMakerStatusUpdated(address indexed account, bool status);

    /// @notice Emitted when contract ownership is transferred
    /// @param previousOwner Address of the previous owner
    /// @param newOwner Address of the new owner
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ========================================
    // CONDITION MANAGER EVENTS
    // ========================================

    /// @notice Emitted when a new condition is created
    /// @param conditionId Unique identifier for the condition
    /// @param oracle Address of the oracle
    /// @param questionId Question identifier
    /// @param outcomeSlotCount Number of possible outcomes
    /// @param metadataURI URI containing condition metadata
    /// @param creator Address that created the condition
    event ConditionCreated(
        bytes32 indexed conditionId,
        address indexed oracle,
        bytes32 indexed questionId,
        uint8 outcomeSlotCount,
        string metadataURI,
        address creator
    );

    /// @notice Emitted when a condition is cancelled
    /// @param conditionId Unique identifier for the condition
    /// @param cancelledBy Address that cancelled the condition
    event ConditionCancelled(bytes32 indexed conditionId, address indexed cancelledBy);

    // ========================================
    // CONDITIONAL TOKENS EVENTS
    // ========================================

    /// @notice Emitted when a condition is prepared in the CTF system
    /// @param conditionId Unique identifier for the condition
    /// @param oracle Address of the oracle
    /// @param questionId Question identifier
    /// @param outcomeSlotCount Number of possible outcomes
    event ConditionPreparation(bytes32 indexed conditionId, address indexed oracle, bytes32 indexed questionId, uint8 outcomeSlotCount);

    /// @notice Emitted when a condition is resolved with payout information
    /// @param conditionId Unique identifier for the condition
    /// @param oracle Address of the oracle that reported
    /// @param questionId Question identifier
    /// @param outcomeSlotCount Number of possible outcomes
    /// @param payouts Array of payout numerators
    event ConditionResolution(
        bytes32 indexed conditionId,
        address indexed oracle,
        bytes32 indexed questionId,
        uint8 outcomeSlotCount,
        uint256[] payouts
    );

    /// @notice Emitted when positions are split
    /// @param stakeholder Address performing the split
    /// @param collateralToken Address of the collateral token
    /// @param parentCollectionId Parent collection identifier
    /// @param conditionId Condition identifier
    /// @param partition Array of index sets for the split
    /// @param amount Amount being split
    event PositionSplit(
        address indexed stakeholder,
        address indexed collateralToken,
        bytes32 indexed parentCollectionId,
        bytes32 conditionId,
        uint256[] partition,
        uint256 amount
    );

    /// @notice Emitted when positions are merged
    /// @param stakeholder Address performing the merge
    /// @param collateralToken Address of the collateral token
    /// @param parentCollectionId Parent collection identifier
    /// @param conditionId Condition identifier
    /// @param partition Array of index sets for the merge
    /// @param amount Amount being merged
    event PositionsMerge(
        address indexed stakeholder,
        address indexed collateralToken,
        bytes32 indexed parentCollectionId,
        bytes32 conditionId,
        uint256[] partition,
        uint256 amount
    );

    /// @notice Emitted when positions are redeemed for payout
    /// @param redeemer Address redeeming the positions
    /// @param collateralToken Address of the collateral token
    /// @param parentCollectionId Parent collection identifier
    /// @param conditionId Condition identifier
    /// @param indexSets Array of index sets being redeemed
    /// @param payout Total payout amount
    event PayoutRedemption(
        address indexed redeemer,
        address indexed collateralToken,
        bytes32 indexed parentCollectionId,
        bytes32 conditionId,
        uint256[] indexSets,
        uint256 payout
    );

    /// @notice Emitted when redemption fees are paid
    /// @param redeemer Address redeeming the positions
    /// @param feeReceiver Address receiving the fee
    /// @param feeAmount Amount of fee paid
    /// @param userPayout Amount received by user after fee
    event PayoutRedemptionFeePaid(address indexed redeemer, address indexed feeReceiver, uint256 feeAmount, uint256 userPayout);

    /// @notice Emitted when positions are redeemed to parent position
    /// @param redeemer Address redeeming the positions
    /// @param collateralToken Address of the collateral token
    /// @param parentCollectionId Parent collection identifier
    /// @param conditionId Condition identifier
    /// @param parentPositionId Parent position ID
    /// @param payoutAmount Amount paid out to parent position
    event PayoutRedeemedToParentPosition(
        address indexed redeemer,
        address collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256 parentPositionId,
        uint256 payoutAmount
    );

    // ========================================
    // ORDERBOOK EVENTS
    // ========================================

    /// @notice Emitted when a new order is created
    /// @param orderId Unique identifier for the order
    /// @param maker Address that created the order
    /// @param positionId Position token identifier
    /// @param collateralToken Address of the collateral token
    /// @param amount Total order amount
    /// @param pricePerToken Price per token
    /// @param minFillAmount Minimum fill amount
    /// @param expiry Order expiry timestamp (0 for no expiry)
    /// @param direction Order direction (Buy/Sell)
    /// @param executionType Order execution type (Limit/Market)
    /// @param fillOrKill Whether order must be filled completely or cancelled
    /// @param makerFeeBps Maker fee in basis points
    /// @param takerFeeBps Taker fee in basis points
    /// @param orderType Type of order (Standard or CrossCurrency)
    /// @param quoteCurrencyToken Quote currency token address (only for CrossCurrency orders)
    /// @param exchangeRateType Exchange rate type (Fixed or Dynamic)
    /// @param exchangeRate Exchange rate (interpretation depends on exchangeRateType)
    event OrderCreated(
        uint256 indexed orderId,
        address indexed maker,
        uint256 indexed positionId,
        address collateralToken,
        uint256 amount,
        uint256 pricePerToken,
        uint256 minFillAmount,
        uint256 expiry,
        LibDoefinStorage.OrderDirection direction,
        LibDoefinStorage.ExecutionType executionType,
        bool fillOrKill,
        uint16 makerFeeBps,
        uint16 takerFeeBps,
        LibDoefinStorage.OrderType orderType,
        address quoteCurrencyToken,
        LibDoefinStorage.ExchangeRateType exchangeRateType,
        uint256 exchangeRate
    );

    /// @notice Emitted when an order is cancelled
    /// @param orderId Unique identifier for the order
    /// @param maker Address that owned the order
    /// @param remainingAmount Amount that was remaining
    event OrderCancelled(uint256 indexed orderId, address indexed maker, uint256 remainingAmount);

    /// @notice Emitted when an order is modified
    /// @param orderId Unique identifier for the order
    /// @param maker Address that owns the order
    /// @param oldAmount Previous order amount
    /// @param newAmount New order amount
    /// @param oldPrice Previous price per token
    /// @param newPrice New price per token
    /// @param oldMinFill Previous minimum fill amount
    /// @param newMinFill New minimum fill amount
    /// @param oldExpiry Previous expiry timestamp
    /// @param newExpiry New expiry timestamp
    event OrderModified(
        uint256 indexed orderId,
        address indexed maker,
        uint256 oldAmount,
        uint256 newAmount,
        uint256 oldPrice,
        uint256 newPrice,
        uint256 oldMinFill,
        uint256 newMinFill,
        uint256 oldExpiry,
        uint256 newExpiry
    );

    /// @notice Emitted when two orders are matched and filled
    /// @param makerOrderId ID of the maker order being filled
    /// @param takerOrderId ID of the taker order (0 for market orders via fillMarketOrderWithRoute)
    /// @param maker Address of the maker
    /// @param taker Address of the taker
    /// @param takerPositionId Position ID the taker is trading
    /// @param makerPositionId Position ID the maker is trading (same as takerPositionId for Complementary)
    /// @param collateralToken Collateral token used
    /// @param fillAmount Amount of tokens traded (same for both sides)
    /// @param makerPrice Price from maker's perspective (what maker receives/pays per token)
    /// @param takerPrice Price from taker's perspective (what taker pays/receives per token, includes fees)
    /// @param matchType Type of match (Complementary/Mint/Merge)
    /// @param makerRemainingAmount Maker's remaining amount after fill
    /// @param takerRemainingAmount Taker's remaining amount after fill
    /// @param makerOrderComplete Whether maker order is completely filled
    /// @param takerOrderComplete Whether taker order is completely filled
    /// @param timestamp Block timestamp
    event TradeFilled(
        uint256 indexed makerOrderId,
        uint256 indexed takerOrderId,
        address indexed maker,
        address taker,
        uint256 takerPositionId,
        uint256 makerPositionId,
        address collateralToken,
        uint256 fillAmount,
        uint256 makerPrice,
        uint256 takerPrice,
        LibDoefinStorage.MatchType matchType,
        uint256 makerRemainingAmount,
        uint256 takerRemainingAmount,
        bool makerOrderComplete,
        bool takerOrderComplete,
        uint256 timestamp
    );

    // ========================================
    // MARKET EXECUTION EVENTS
    // ========================================

    /// @notice Emitted when a market order is executed
    /// @param taker Address executing the market order
    /// @param positionId Position being traded
    /// @param direction Order direction (Buy/Sell)
    /// @param requestedAmount Originally requested amount
    /// @param filledAmount Actually filled amount
    /// @param totalCost Total cost of execution
    event MarketOrderExecuted(
        address indexed taker,
        uint256 indexed positionId,
        LibDoefinStorage.OrderDirection direction,
        uint256 requestedAmount,
        uint256 filledAmount,
        uint256 totalCost
    );

    /// @notice Emitted for each individual match in a market order
    /// @param taker Address executing the market order
    /// @param positionId Position being traded in the market order
    /// @param makerOrderId ID of the matched limit order (for consistency with other events)
    /// @param maker Address of the limit order maker
    /// @param takerOrderId ID of the taker order (0 for market orders, actual ID for limit orders acting as taker)
    /// @param fillAmount Amount filled in this match
    /// @param pricePerToken Price used for this match
    /// @param matchType Type of match (Complementary/Mint/Merge)
    /// @param direction Market order direction (Buy/Sell)
    event MarketOrderMatch(
        address indexed taker,
        uint256 indexed positionId,
        uint256 indexed makerOrderId,
        address maker,
        uint256 takerOrderId,
        uint256 fillAmount,
        uint256 pricePerToken,
        LibDoefinStorage.MatchType matchType,
        LibDoefinStorage.OrderDirection direction
    );

    // ========================================
    // ESCROW EVENTS
    // ========================================

    /// @notice Emitted when ERC20 collateral is locked in escrow
    /// @param user Address of the user
    /// @param token Address of the token
    /// @param amount Amount locked
    /// @param totalBalance New total balance for user
    event ERC20CollateralLocked(address indexed user, address indexed token, uint256 amount, uint256 totalBalance);

    /// @notice Emitted when ERC20 collateral is released from escrow
    /// @param user Address of the user
    /// @param token Address of the token
    /// @param amount Amount released
    /// @param totalBalance New total balance for user
    event ERC20CollateralReleased(address indexed user, address indexed token, uint256 amount, uint256 totalBalance);

    /// @notice Emitted when ERC1155 tokens are locked in escrow
    /// @param user Address of the user
    /// @param positionId Position token ID
    /// @param amount Amount locked
    /// @param totalBalance New total balance for user
    event ERC1155CollateralLocked(address indexed user, uint256 indexed positionId, uint256 amount, uint256 totalBalance);

    /// @notice Emitted when ERC1155 tokens are released from escrow
    /// @param user Address of the user
    /// @param positionId Position token ID
    /// @param amount Amount released
    /// @param totalBalance New total balance for user
    event ERC1155CollateralReleased(address indexed user, uint256 indexed positionId, uint256 amount, uint256 totalBalance);

    /// @notice Emitted when protocol fees are accrued
    /// @param token The token in which fees are collected
    /// @param makerOrderId ID of the maker order
    /// @param takerOrderId ID of the taker order (0 for market orders)
    /// @param maker Address of the maker
    /// @param taker Address of the taker
    /// @param fillAmount Amount filled in this trade
    /// @param pricePerToken Price used for the trade
    /// @param makerFeeAmount Fee paid by maker
    /// @param takerFeeAmount Fee paid by taker
    /// @param totalFeesAccrued Total fees from this trade
    /// @param cumulativeProtocolFees Cumulative protocol fees for this token
    event ProtocolFeesAccrued(
        address indexed token,
        uint256 indexed makerOrderId,
        uint256 indexed takerOrderId,
        address maker,
        address taker,
        uint256 fillAmount,
        uint256 pricePerToken,
        uint256 makerFeeAmount,
        uint256 takerFeeAmount,
        uint256 totalFeesAccrued,
        uint256 cumulativeProtocolFees
    );

    /// @notice Emitted when a refund is issued for surplus funds
    /// @param user Address of the user
    /// @param collateralToken Address of the collateral token
    /// @param refundAmount Amount being refunded
    /// @param takerPaidPerToken Amount paid by the taker per token
    /// @param tradeEffectivePrice Effective price of the trade
    event RefundSurplus(
        address indexed user,
        address indexed collateralToken,
        uint256 refundAmount,
        uint256 takerPaidPerToken,
        uint256 tradeEffectivePrice
    );

    /// @notice Emitted when protocol fees are withdrawn by admin
    /// @param token Address of the token
    /// @param recipient Address receiving the fees
    /// @param amount Amount withdrawn
    /// @param remainingFees Remaining fees after withdrawal
    event ProtocolFeesWithdrawn(address indexed token, address indexed recipient, uint256 amount, uint256 remainingFees);

    // ========================================
    // ORACLE MANAGEMENT EVENTS
    // ========================================

    /// @notice Emitted when a new oracle adapter is registered
    /// @param adapterId Unique identifier for the adapter
    /// @param adapterAddress Contract address of the adapter
    /// @param maxStaleness Maximum staleness time for this adapter
    event AdapterRegistered(bytes32 indexed adapterId, address adapterAddress, uint256 maxStaleness);

    /// @notice Emitted when an oracle adapter configuration is updated
    /// @param adapterId Adapter identifier
    /// @param config New adapter configuration
    event AdapterConfigUpdated(bytes32 indexed adapterId, LibDoefinStorage.AdapterConfig config);

    /// @notice Emitted when an oracle adapter is removed
    /// @param adapterId Adapter identifier
    event AdapterRemoved(bytes32 indexed adapterId);

    /// @notice Emitted when an asset's oracle configuration is set
    /// @param assetId Asset identifier
    /// @param adapterPriority Array of adapter IDs in priority order
    /// @param maxStaleness Maximum staleness time for this asset
    event AssetConfigured(bytes32 indexed assetId, bytes32[] adapterPriority, uint256 maxStaleness);

    /// @notice Emitted when an asset's adapter priority is updated
    /// @param assetId Asset identifier
    /// @param newPriority New priority order
    event AssetAdapterPriorityUpdated(bytes32 indexed assetId, bytes32[] newPriority);

    /// @notice Emitted when a price is successfully updated
    /// @param assetId Asset identifier
    /// @param price New price
    /// @param timestamp Price timestamp
    /// @param adapterId Adapter that provided the price
    event PriceUpdated(bytes32 indexed assetId, uint256 price, uint256 timestamp, bytes32 adapterId);

    /// @notice Emitted when an oracle adapter fails to provide a price
    /// @param adapterId Adapter identifier that failed
    /// @param assetId Asset identifier
    /// @param failureCount Total failure count for this adapter
    event AdapterFailed(bytes32 indexed adapterId, bytes32 indexed assetId, uint256 failureCount);

    /// @notice Event emitted when a cross-currency order is settled
    /// @param taker The address of the taker
    /// @param maker The address of the maker
    /// @param orderId The maker order ID
    /// @param quoteCurrencyToken The quote currency token used
    /// @param fillAmount The amount of position tokens traded
    /// @param exchangeRate The exchange rate used (1e18 scale)
    /// @param totalFees The total fees paid in quote currency
    event CrossCurrencySettlement(
        address indexed taker,
        address indexed maker,
        uint256 indexed orderId,
        address quoteCurrencyToken,
        uint256 fillAmount,
        uint256 exchangeRate,
        uint256 totalFees
    );

    /// @notice Emitted when all configured adapters fail for an asset
    /// @param assetId Asset identifier
    /// @param attemptedAdapters Array of adapter IDs that were attempted
    event AllAdaptersFailed(bytes32 indexed assetId, bytes32[] attemptedAdapters);

    /// @notice Emitted when a price becomes stale
    /// @param assetId Asset identifier
    /// @param lastUpdateTimestamp When the price was last updated
    /// @param currentTimestamp Current block timestamp
    event PriceStale(bytes32 indexed assetId, uint256 lastUpdateTimestamp, uint256 currentTimestamp);

    /// @notice Emitted when trading is paused due to oracle issues
    /// @param assetId Asset identifier
    event TradingPaused(bytes32 indexed assetId);

    /// @notice Emitted when trading is resumed after price update
    /// @param assetId Asset identifier
    /// @param newPrice Price that resumed trading
    /// @param timestamp Price timestamp
    event TradingResumed(bytes32 indexed assetId, uint256 newPrice, uint256 timestamp);

    /// @notice Emitted when a price is manually updated with signature
    /// @param assetId Asset identifier
    /// @param price Manually set price
    /// @param timestamp Price timestamp
    /// @param signer Address that signed the price data
    event ManualPriceUpdate(bytes32 indexed assetId, uint256 price, uint256 timestamp, address signer);

    /// @notice Emitted when an emergency price update is performed
    /// @param assetId Asset identifier
    /// @param price Emergency price
    /// @param justification Human-readable justification for the emergency update
    event EmergencyPriceUpdate(bytes32 indexed assetId, uint256 price, string justification);

    // ========================================
    // POSITION REGISTRY EVENTS
    // ========================================

    /// @notice Emitted when position pairs are registered
    /// @param conditionId Condition identifier
    /// @param collateralToken Address of the collateral token
    /// @param parentCollectionId Parent collection identifier
    /// @param positionIds Array of position IDs
    /// @param partitions Array of partitions
    event PositionPairsRegistered(
        bytes32 indexed conditionId,
        address indexed collateralToken,
        bytes32 parentCollectionId,
        uint256[] positionIds,
        uint256[] partitions
    );

    // ========================================
    // ERC1155 EVENTS
    // ========================================

    /// @notice Emitted when tokens are transferred
    /// @param operator Address performing the transfer
    /// @param from Address tokens are transferred from
    /// @param to Address tokens are transferred to
    /// @param id Token ID
    /// @param value Amount transferred
    event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value);

    /// @notice Emitted when multiple tokens are transferred
    /// @param operator Address performing the transfer
    /// @param from Address tokens are transferred from
    /// @param to Address tokens are transferred to
    /// @param ids Array of token IDs
    /// @param values Array of amounts transferred
    event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values);

    /// @notice Emitted when approval for all tokens is set
    /// @param owner Address of the owner
    /// @param operator Address of the operator
    /// @param approved Whether operator is approved
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
}
