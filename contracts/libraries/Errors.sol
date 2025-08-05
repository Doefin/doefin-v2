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

    /// 
    error InvalidMakerAddress();

    ///
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

    // ========================================
    // CONDITION MANAGER ERRORS
    // ========================================
    
    /// @notice Thrown when oracle address is zero
    error InvalidOracleAddress();
    
    /// @notice Thrown when condition does not exist
    error ConditionDoesNotExist();
    
    /// @notice Thrown when condition is already inactive
    error ConditionAlreadyInactive();
    
    /// @notice Thrown when condition is inactive
    error ConditionInactive();
    
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
    
    /// @notice Thrown when unit per pair is not set for token
    error UnitPerPairNotSet();
    
    /// @notice Thrown when price exceeds maximum (1.0)
    error PriceExceedsMaximum();

    // ========================================
    // ESCROW ERRORS
    // ========================================
    
    /// @notice Thrown when insufficient ERC20 balance in escrow
    error InsufficientERC20Balance();
    
    /// @notice Thrown when insufficient ERC1155 balance in escrow
    error InsufficientERC1155Balance();
    
    /// @notice Thrown when taker has not approved enough tokens
    error InsufficientAllowance();

    /// @notice Thrown when maker has not approved enough tokens
    error InsufficientERC20Allowance();

    // ========================================
    // FEE MANAGEMENT ERRORS
    // ========================================
    
    /// @notice Thrown when no fees are available for withdrawal
    error NoFeesToWithdraw();
    
    /// @notice Thrown when insufficient fee balance for withdrawal
    error InsufficientFeeBalance();

    // ========================================
    // ORDERBOOK ERRORS
    // ========================================
    
    /// @notice Thrown when order is not active
    error OrderNotActive();
    
    /// @notice Thrown when order has expired
    error OrderExpired();
    
    /// @notice Thrown when partially filled orders cannot be modified
    error PartiallyFilledOrdersNotModifiable();
    
    /// @notice Thrown when no matchable orders are available
    error NoMatchableOrders();

    /// @notice Thrown when order price exceeds maximum
    error InvalidPrice();

    /// @notice Thrown when order amounts are invalid
    error InvalidAmounts();

    /// @notice Thrown when order is created with past expiry
    error OrderCreatedWithPastExpiry();

    // ========================================
    // SETTLEMENT ERRORS
    // ========================================
    
    /// @notice Thrown when position IDs don't match
    error PositionIdMismatch();
    
    /// @notice Thrown when order directions are the same for complementary match
    error SameDirectionForComplementary();
    
    /// @notice Thrown when order directions differ for mint/merge match
    error DifferentOrderDirectionForNonComplementary();
    
    /// @notice Thrown when fill-or-kill order cannot be completely filled
    error FillOrKillFailed();

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
}