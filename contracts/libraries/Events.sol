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

    /// @notice Emitted when a token symbol is updated
    /// @param token Address of the token
    /// @param symbol New symbol for the token
    event TokenSymbolUpdated(address indexed token, string symbol);

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

    /// @notice Emitted when the admin updates the maximum settlement fee rate (SCRUM-224)
    /// @param oldRate Previous maximum fee rate in basis points
    /// @param newRate New maximum fee rate in basis points
    event MaxFeeRateUpdated(uint16 oldRate, uint16 newRate);

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
    // FEE EVENTS
    // ========================================
    // (SEC-012) `ProtocolFeesWithdrawn` was removed — dead since LibFeeManager was
    // deleted in v3 cleanup; zero emit sites remained in the codebase.

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
    // Block HEADER ORACLE EVENTS
    // ========================================
    event BlockReorged(bytes32 merkleRootHash);
    event BlockSubmitted(bytes32 blockHash, uint32 timestamp);

    // ========================================
    // ORACLE ADAPTER EVENTS
    // ========================================

    /// @notice Emitted when a new question is created
    /// @param questionId Unique identifier for the question
    /// @param conditionId Associated condition identifier
    /// @param questionType Type of question (Threshold, Range, BlockCount, Duration)
    /// @param settlementTrigger Block height or timestamp when condition can resolve
    /// @param creator Address that created the question
    event QuestionCreated(
        bytes32 indexed questionId,
        bytes32 indexed conditionId,
        LibDoefinStorage.QuestionType questionType,
        uint256 settlementTrigger,
        address indexed creator
    );

    /// @notice Emitted when a difficulty threshold question is created
    /// @param questionId Unique identifier for the question
    /// @param conditionId Associated condition identifier
    /// @param threshold Difficulty threshold value
    /// @param targetBlockHeight Block height to measure difficulty at
    /// @param settlementBlock Block height when question becomes resolvable (includes settlement delay)
    /// @param creator Address that created the question
    event DifficultyThresholdQuestionCreated(
        bytes32 indexed questionId,
        bytes32 indexed conditionId,
        uint256 threshold,
        uint256 targetBlockHeight,
        uint256 settlementBlock,
        address indexed creator
    );

    /// @notice Emitted when a difficulty range question is created
    /// @param questionId Unique identifier for the question
    /// @param conditionId Associated condition identifier
    /// @param targetBlockHeight Block height to measure difficulty at
    /// @param buckets Range boundaries (sorted ascending)
    /// @param settlementBlock Block height when question becomes resolvable (includes settlement delay)
    /// @param creator Address that created the question
    event DifficultyRangeQuestionCreated(
        bytes32 indexed questionId,
        bytes32 indexed conditionId,
        uint256 targetBlockHeight,
        uint256[] buckets,
        uint256 settlementBlock,
        address indexed creator
    );

    /// @notice Emitted when a block count question is created
    /// @param questionId Unique identifier for the question
    /// @param conditionId Associated condition identifier
    /// @param startTimestamp Start of time window
    /// @param endTimestamp End of time window
    /// @param countBuckets Block count range boundaries
    /// @param settlementBucket Timestamp bucket when question becomes resolvable
    /// @param creator Address that created the question
    event BlockCountQuestionCreated(
        bytes32 indexed questionId,
        bytes32 indexed conditionId,
        uint256 startTimestamp,
        uint256 endTimestamp,
        uint256[] countBuckets,
        uint256 settlementBucket,
        address indexed creator
    );

    /// @notice Emitted when a mining duration question is created
    /// @param questionId Unique identifier for the question
    /// @param conditionId Associated condition identifier
    /// @param startBlockHeight Starting block height
    /// @param blockCount Number of blocks to measure duration for
    /// @param durationBuckets Duration range boundaries in seconds
    /// @param settlementBlock Block height when question becomes resolvable (includes settlement delay)
    /// @param creator Address that created the question
    event MiningDurationQuestionCreated(
        bytes32 indexed questionId,
        bytes32 indexed conditionId,
        uint256 startBlockHeight,
        uint256 blockCount,
        uint256[] durationBuckets,
        uint256 settlementBlock,
        address indexed creator
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

    // ========================================
    // SETTLEMENT EVENTS (v2.1)
    // ========================================

    /// @notice Emitted when an individual order is settled (partially or fully filled)
    /// @param orderHash The EIP-712 hash of the settled order
    /// @param maker The maker (SCW) address
    /// @param filledAmount The amount filled in this settlement
    /// @param fee The fee charged for this fill
    event OrderSettled(bytes32 indexed orderHash, address indexed maker, uint128 filledAmount, uint128 fee);

    /// @notice Emitted when two orders are matched and settled against each other
    /// @param takerHash The EIP-712 hash of the taker order
    /// @param makerHash The EIP-712 hash of the maker order
    /// @param matchType The settlement path used (0 = Complementary, 1 = Mint, 2 = Merge)
    /// @param amount The amount matched
    event OrdersMatched(bytes32 indexed takerHash, bytes32 indexed makerHash, uint8 matchType, uint128 amount);

    /// @notice Emitted when an order is cancelled on-chain by its maker
    /// @param orderHash The EIP-712 hash of the cancelled order
    /// @param maker The maker address that cancelled
    event OrderCancelledOnChain(bytes32 indexed orderHash, address indexed maker);

    /// @notice Emitted when a maker bumps their nonce, invalidating all prior orders
    /// @param maker The maker address
    /// @param newNonce The new nonce value
    event NonceBumped(address indexed maker, uint256 newNonce);

    /// @notice Emitted when the admin pauses settlement trading
    /// @param admin The admin address that paused
    event SettlementTradingPaused(address indexed admin);

    /// @notice Emitted when the admin unpauses settlement trading
    /// @param admin The admin address that unpaused
    event SettlementTradingUnpaused(address indexed admin);

    /// @notice Emitted when a SCW registers or unregisters an authorized order signer
    /// @param scw The smart contract wallet address
    /// @param signer The EOA signer address
    /// @param allowed Whether the signer is authorized
    event OrderSignerRegistered(address indexed scw, address indexed signer, bool allowed);

    /// @notice Emitted when a maker sets a minimum valid salt for a position, cancelling all orders with lower salt
    /// @param maker The maker address
    /// @param positionId The position ID
    /// @param minValidSalt The new minimum valid salt
    event PositionOrdersCancelled(address indexed maker, bytes32 indexed positionId, uint256 minValidSalt);

    /// @notice Emitted when the authorized settlement operator is changed (SEC-011)
    /// @param oldOperator Previous operator address (may be `address(0)` on first-set)
    /// @param newOperator New operator address (never `address(0)`)
    event OperatorUpdated(address indexed oldOperator, address indexed newOperator);

    /// @notice Emitted when a settlement fee is transferred to the protocol fee receiver (SCRUM-224)
    /// @param receiver The protocol fee receiver address
    /// @param amount The fee amount transferred
    event FeeCharged(address indexed receiver, uint256 amount);
}
