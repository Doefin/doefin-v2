// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

/**
 * @title Errors
 * @notice Custom error definitions for the Doefin protocol
 * @dev Using custom errors instead of require strings for gas efficiency
 */
library Errors {
    // ========================================
    // ACCESS CONTROL ERRORS
    // ========================================

    /// @notice Thrown when caller is not the contract owner
    error NotContractOwner();

    /// @notice Thrown when caller is not a market maker
    error NotMarketMaker();

    /// @notice Thrown when caller is not authorized to perform action
    error NotAuthorized();

    /// @notice Thrown when caller is not the order maker
    error NotOrderMaker();

    /// @notice Thrown when maker address is invalid
    error InvalidMakerAddress();

    /// @notice Thrown when already a market maker
    error AlreadyMarketMaker();

    // ========================================
    // ADMIN CONFIG ERRORS
    // ========================================

    /// @notice Thrown when token address is zero
    error InvalidTokenAddress();

    /// @notice Thrown when unit per pair is zero
    error InvalidUnitPerPair();

    /// @notice Thrown when token is already allowed
    error TokenAlreadyAllowed();

    /// @notice Thrown when token is not allowed
    error TokenNotAllowed();

    /// @notice Thrown when fee receiver address is zero
    error InvalidFeeReceiver();

    /// @notice Thrown when fee percentage exceeds maximum (100%)
    error FeeTooHigh();

    /// @notice Thrown when no change is made for fees/receiver
    error NoChangeRequired();

    /// @notice Thrown when conversion path is invalid (e.g., same from/to tokens)
    error InvalidConversionPath();

    // ========================================
    // CONDITION MANAGER ERRORS
    // ========================================

    /// @notice Thrown when oracle address is zero
    error InvalidOracleAddress();

    /// @notice Thrown when condition does not exist
    error ConditionDoesNotExist();

    /// @notice Thrown when condition is already inactive
    error ConditionAlreadyInactive();

    /// @notice Thrown when not authorized to cancel condition
    error NotAuthorizedToCancel();

    // ========================================
    // CONDITIONAL TOKENS ERRORS
    // ========================================

    /// @notice Thrown when condition is already prepared
    error ConditionAlreadyPrepared();

    /// @notice Thrown when condition is not prepared
    error ConditionNotPrepared();

    /// @notice Thrown when condition is already resolved
    error ConditionAlreadyResolved();

    /// @notice Thrown when condition is not resolved
    error ConditionNotResolved();

    /// @notice Thrown when payout is already set
    error PayoutAlreadySet();

    /// @notice Thrown when all payouts are zero
    error AllZeroPayouts();

    /// @notice Thrown when payout length is invalid
    error InvalidPayoutLength();

    /// @notice Thrown when there are too many outcome slots
    error TooManyOutcomeSlots();

    /// @notice Thrown when outcome slot count is invalid
    error InvalidOutcomeSlotCount();

    /// @notice Thrown when partition is trivial
    error TrivialPartition();

    /// @notice Thrown when index set is invalid
    error InvalidIndexSet();

    /// @notice Thrown when partition is not disjoint
    error PartitionNotDisjoint();

    /// @notice Thrown when condition is not active
    error ConditionNotActive();

    // ========================================
    // COLLATERAL ERRORS
    // ========================================

    /// @notice Thrown when collateral amount is not aligned to unit
    error CollateralNotAligned();

    // ========================================
    // FEE MANAGEMENT ERRORS
    // ========================================

    // ========================================
    // REENTRANCY ERRORS
    // ========================================

    /// @notice Thrown when a reentrant call is detected
    error ReentrantCall();

    // ========================================
    // ORDERBOOK / PRICE ERRORS
    // ========================================

    /// @notice Thrown when order price exceeds maximum
    error InvalidPrice();

    // ========================================
    // POSITION REGISTRY ERRORS
    // ========================================

    /// @notice Thrown when position ID is invalid
    error InvalidPositionId();

    /// @notice Thrown when position is not found in condition
    error PositionNotFound();

    /// @notice Thrown when invalid match between positions
    error InvalidMatch();

    /// @notice Thrown when complement position is invalid
    error InvalidComplement();

    /// @notice Thrown when input lengths are mismatched
    error MismatchedInputLengths();

    // ========================================
    // ERC1155 ERRORS
    // ========================================

    /// @notice Thrown when querying balance for zero address
    error ZeroAddressQuery();

    /// @notice Thrown when transferring to zero address
    error TransferToZeroAddress();

    /// @notice Thrown when minting to zero address
    error MintToZeroAddress();

    /// @notice Thrown when caller is not owner nor approved
    error NotOwnerNorApproved();

    /// @notice Thrown when empty array is provided where non-empty expected
    error EmptyArray();

    /// @notice Thrown when arrays have mismatched lengths
    error ArrayLengthMismatch();

    /// @notice Thrown when receiver rejects tokens
    error ERC1155ReceiverRejectedTokens();

    // ========================================
    // CRYPTOGRAPHIC ERRORS
    // ========================================

    /// @notice Thrown when modulus is zero in cryptographic operations
    error ZeroModulus();

    /// @notice Thrown when ECADD precompile fails
    error ECAddFailed();

    /// @notice Thrown when parent collection ID is invalid
    error InvalidParentCollectionId();

    // ========================================
    // ORACLE ERRORS
    // ========================================

    /// @notice Thrown when oracle adapter is not registered
    error AdapterNotRegistered(bytes32 adapterId);

    /// @notice Thrown when oracle adapter already exists
    error AdapterAlreadyExists(bytes32 adapterId);

    /// @notice Thrown when asset is not configured for oracle
    error AssetNotConfigured(bytes32 assetId);

    /// @notice Thrown when adapter priority array is empty
    error EmptyAdapterPriority();

    /// @notice Thrown when all configured oracle adapters fail to provide a valid price
    error AllOracleAdaptersFailed(bytes32 assetId);

    /// @notice Thrown when oracle timestamp is invalid
    error InvalidTimestamp();

    /// @notice Thrown when signature signer is not authorized
    error UnauthorizedSigner();

    /// @notice Thrown when nonce has already been used for replay protection
    error NonceAlreadyUsed();

    /// @notice Thrown when signature has expired
    error SignatureExpired();

    /// @notice Thrown when signature is invalid or ecrecover fails
    error InvalidSignature();

    /// @notice Thrown when oracle decimals configuration is invalid (must be 0-18)
    error InvalidOracleDecimals(bytes32 assetId, uint8 decimals);

    /// @notice Thrown when feed ID is invalid (zero)
    error InvalidFeedId();

    /// @notice Thrown when decimals value is invalid (zero or greater than 18)
    error InvalidDecimals();

    // ========================================
    // BLOCK HEADER ORACLE ERRORS
    // ========================================
    error BlockHeaderOracle_NewChainNotLonger();

    error BlockHeaderOracle_CannotFindForkPoint();

    error BlockHeaderOracle_PrevBlockHashMismatch();

    error BlockHeaderOracle_InvalidTimestamp();

    error BlockHeaderOracle_InvalidBlockHash();

    error BlockHeaderOracle_InvalidInitialHistoryLength();

    /// @notice Thrown when nBits coefficient is zero resulting in invalid target
    error BlockHeaderOracle_InvalidTargetNBits();

    // ========================================
    // ORACLE ADAPTER ERRORS
    // ========================================

    /// @notice Thrown when bucket configuration is invalid
    error OracleAdapter_InvalidBucketConfiguration();

    /// @notice Thrown when block not found for timestamp
    error OracleAdapter_BlockNotFoundForTimestamp();

    /// @notice Thrown when block is not in buffer
    error OracleAdapter_BlockNotInBuffer();

    /// @notice Thrown when question already exists with same parameters
    error OracleAdapter_QuestionAlreadyExists();

    /// @notice Thrown when question type is invalid
    error OracleAdapter_InvalidQuestionType();

    /// @notice Thrown when bucket values are not sorted in ascending order
    error OracleAdapter_BucketsNotSorted();

    /// @notice Thrown when duplicate bucket values are provided
    error OracleAdapter_DuplicateBucketValue();

    // ========================================
    // VALIDATION ERRORS
    // ========================================

    /// @notice Thrown when zero address is provided where non-zero expected
    error ZeroAddress();

    /// @notice Thrown when amount is zero where non-zero expected
    error ZeroAmount();

    /// @notice Thrown when value is out of valid range
    error ValueOutOfRange();

    /// @notice Thrown when operation would cause overflow
    error ArithmeticOverflow();

    /// @notice Thrown when operation would cause underflow
    error ArithmeticUnderflow();

    // ========================================
    // INITIALIZATION ERRORS
    // ========================================

    /// @notice Thrown when contract is already initialized
    error AlreadyInitialized();

    // ========================================
    // DIAMOND ERRORS
    // ========================================

    /// @notice Thrown when function does not exist in diamond
    error FunctionDoesNotExist();

    /// @notice Thrown when no function selectors provided for facet cut
    error NoSelectorsInFacet();

    /// @notice Thrown when facet address is zero for add operation
    error AddFacetCannotBeZero();

    /// @notice Thrown when trying to add function that already exists
    error CannotAddExistingFunction();

    /// @notice Thrown when trying to replace function with same function
    error CannotReplaceWithSameFunction();

    /// @notice Thrown when remove facet address is not zero
    error RemoveFacetAddressMustBeZero();

    /// @notice Thrown when trying to remove function that doesn't exist
    error CannotRemoveNonExistentFunction();

    /// @notice Thrown when trying to remove immutable function
    error CannotRemoveImmutableFunction();

    /// @notice Thrown when contract code size is zero during initialization
    error ContractCodeSizeZero();

    // ========================================
    // SIGNATURE ERRORS
    // ========================================

    /// @notice Thrown when signature length is invalid
    error InvalidSignatureLength();

    // ========================================
    // MOCK CONTRACT ERRORS
    // ========================================

    /// @notice Thrown when caller is not owner in mock contracts
    error NotOwner();

    /// @notice Thrown when trying to set owner to invalid address
    error InvalidAddress();

    /// @notice Thrown when mock adapter is configured to fail for testing
    error MockAdapterConfiguredToFail();

    /// @notice Thrown when caller is not the pending owner
    error NotPendingOwner();

    /// @notice Thrown when max manual update age is invalid (too short or too long)
    error InvalidMaxManualUpdateAge();

    // ========================================
    // SETTLEMENT ERRORS (v2.1)
    // ========================================

    /// @notice Thrown when EIP-712 order signature verification fails
    error InvalidOrderSignature(bytes32 orderHash);

    /// @notice Thrown when attempting to fill a cancelled order
    error OrderCancelled(bytes32 orderHash);

    /// @notice Thrown when order nonce is below the maker's current nonce
    error OrderNonceInvalid(bytes32 orderHash, uint256 orderNonce, uint256 currentNonce);

    /// @notice Thrown when fill amount exceeds the order's remaining unfilled amount
    error OrderOverfilled(bytes32 orderHash, uint256 requested, uint256 remaining);

    /// @notice Thrown when settlement is attempted while trading is paused
    error TradingIsPaused();

    /// @notice Thrown when caller is not the authorized settlement operator
    error UnauthorizedOperator(address caller);

    /// @notice Thrown when minValidSalt is not strictly greater than the current value
    error InvalidSaltThreshold();

    /// @notice Thrown when taker and maker are the same address (self-trade prevention)
    error SelfTrade();
}
