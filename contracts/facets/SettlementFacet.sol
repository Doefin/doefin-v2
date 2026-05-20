// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinOrder} from "../libraries/LibDoefinOrder.sol";
import {LibSettlementStorage} from "../libraries/LibSettlementStorage.sol";
import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {LibCTFCondition} from "../libraries/LibCTFCondition.sol";
import {LibERC1155} from "../libraries/LibERC1155.sol";
import {LibReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {LibDiamond} from "../libraries/LibDiamond.sol";
import {Errors} from "../libraries/Errors.sol";
import {Events} from "../libraries/Events.sol";
import {ISettlement} from "../interfaces/ISettlement.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title SettlementFacet
 * @author Doefin
 * @notice Core on-chain settlement for the v2.1 hybrid model
 * @dev Operator-only entry point that executes matched order pairs. Replaces on-chain matching
 *      with a simpler validate-and-execute model. Supports Complementary, Mint, and Merge paths.
 *      Cross-currency settlement is intentionally excluded (SC-006).
 */
contract SettlementFacet is ISettlement {
    using SafeERC20 for IERC20;

    // Match type constants
    uint8 internal constant MATCH_COMPLEMENTARY = 1;
    uint8 internal constant MATCH_MINT = 2;
    uint8 internal constant MATCH_MERGE = 3;

    // Fee safety cap (5%)
    uint16 internal constant MAX_FEE_RATE_BPS = 500;

    // ========================================
    // MODIFIERS
    // ========================================

    modifier onlyOperator() {
        LibSettlementStorage.SettlementStorage storage ss = LibSettlementStorage.settlementStorage();
        if (msg.sender != ss.operator) revert Errors.UnauthorizedOperator(msg.sender);
        _;
    }

    modifier notPaused() {
        LibSettlementStorage.SettlementStorage storage ss = LibSettlementStorage.settlementStorage();
        if (ss.tradingPaused) revert Errors.TradingIsPaused();
        _;
    }

    modifier nonReentrant() {
        LibReentrancyGuard._nonReentrantBefore();
        _;
        LibReentrancyGuard._nonReentrantAfter();
    }

    // ========================================
    // CORE SETTLEMENT
    // ========================================

    /**
     * @notice Settle a matched pair: one taker against one or more makers
     * @dev Only callable by the authorized operator. Validates signatures, order validity,
     *      fill amounts, determines match type, and executes the appropriate settlement path.
     * @param takerOrder The taker's signed order
     * @param takerSignature The taker's ECDSA signature
     * @param takerSignatureType 0 = EOA, 1 = EIP-1271
     * @param makerOrders Array of maker orders to match against
     * @param makerSignatures Array of maker signatures
     * @param makerSignatureTypes Array of maker signature types
     * @param takerFillAmount Total amount to fill for the taker across all makers
     * @param makerFillAmounts Amount to fill for each maker order
     * @custom:reverts TradingIsPaused, UnauthorizedOperator, MismatchedInputLengths,
     *                 InvalidOrderSignature, OrderCancelled, OrderOverfilled, InvalidMatch, ZeroAmount
     */
    function matchOrders(
        LibDoefinOrder.DoefinOrder calldata takerOrder,
        bytes calldata takerSignature,
        uint8 takerSignatureType,
        LibDoefinOrder.DoefinOrder[] calldata makerOrders,
        bytes[] calldata makerSignatures,
        uint8[] calldata makerSignatureTypes,
        uint128 takerFillAmount,
        uint128[] calldata makerFillAmounts
    ) external onlyOperator notPaused nonReentrant {
        // Input validation
        if (makerOrders.length != makerFillAmounts.length || makerOrders.length != makerSignatures.length || makerOrders.length != makerSignatureTypes.length) {
            revert Errors.MismatchedInputLengths();
        }
        if (takerFillAmount == 0) revert Errors.ZeroAmount();

        // Fix 4: Validate fill amount consistency
        {
            uint128 totalMakerFill;
            for (uint256 i; i < makerFillAmounts.length; ++i) {
                totalMakerFill += makerFillAmounts[i];
            }
            if (totalMakerFill != takerFillAmount) revert Errors.MismatchedInputLengths();
        }

        LibSettlementStorage.SettlementStorage storage ss = LibSettlementStorage.settlementStorage();
        bytes32 domainSep = _getDomainSeparator();

        // Validate taker
        bytes32 takerHash = LibDoefinOrder.hashOrderCalldata(takerOrder, domainSep);
        _verifySignature(takerOrder, takerHash, takerSignature, takerSignatureType);
        _validateOrder(ss, takerOrder, takerHash);
        _checkFillAmount(ss, takerHash, takerOrder.amount, takerFillAmount);

        // Process each maker (Fix 3: taker fee computed per-maker, not once for full amount)
        uint128 totalTakerFee;
        for (uint256 i; i < makerOrders.length; ++i) {
            if (makerFillAmounts[i] == 0) revert Errors.ZeroAmount();
            if (makerOrders[i].maker == takerOrder.maker) revert Errors.SelfTrade();

            bytes32 makerHash = LibDoefinOrder.hashOrderCalldata(makerOrders[i], domainSep);
            _verifySignature(makerOrders[i], makerHash, makerSignatures[i], makerSignatureTypes[i]);
            _validateOrder(ss, makerOrders[i], makerHash);
            _checkFillAmount(ss, makerHash, makerOrders[i].amount, makerFillAmounts[i]);

            // Determine and execute settlement path
            uint8 matchType = _determineMatchType(takerOrder, makerOrders[i]);
            uint128 makerFee = _computeFee(makerOrders[i].feeRateBps, makerOrders[i].pricePerToken, makerFillAmounts[i], makerOrders[i].collateralToken);
            uint128 takerFeeForThisMaker = _computeFee(takerOrder.feeRateBps, takerOrder.pricePerToken, makerFillAmounts[i], takerOrder.collateralToken);
            totalTakerFee += takerFeeForThisMaker;

            _executeSettlement(takerOrder, makerOrders[i], makerFillAmounts[i], takerFeeForThisMaker, makerFee, matchType);

            // Update maker fill state
            ss.orderHashToFilledAmount[makerHash] += makerFillAmounts[i];

            emit Events.OrderSettled(makerHash, makerOrders[i].maker, makerFillAmounts[i], makerFee);
            emit Events.OrdersMatched(takerHash, makerHash, matchType, makerFillAmounts[i]);
        }

        // Update taker fill state
        ss.orderHashToFilledAmount[takerHash] += takerFillAmount;
        emit Events.OrderSettled(takerHash, takerOrder.maker, takerFillAmount, totalTakerFee);
    }

    /**
     * @notice Fill a single order (operator is the counterparty)
     * @dev The operator fills the order directly — no matching. Validates signature and fill amount.
     * @param order The order to fill
     * @param signature The order's ECDSA signature
     * @param signatureType 0 = EOA, 1 = EIP-1271
     * @param fillAmount Amount to fill
     */
    function fillOrder(
        LibDoefinOrder.DoefinOrder calldata order,
        bytes calldata signature,
        uint8 signatureType,
        uint128 fillAmount
    ) external onlyOperator notPaused nonReentrant {
        if (fillAmount == 0) revert Errors.ZeroAmount();

        LibSettlementStorage.SettlementStorage storage ss = LibSettlementStorage.settlementStorage();
        bytes32 domainSep = _getDomainSeparator();
        bytes32 orderHash = LibDoefinOrder.hashOrderCalldata(order, domainSep);

        _verifySignature(order, orderHash, signature, signatureType);
        _validateOrder(ss, order, orderHash);
        _checkFillAmount(ss, orderHash, order.amount, fillAmount);

        uint128 fee = _computeFee(order.feeRateBps, order.pricePerToken, fillAmount, order.collateralToken);

        // Transfer collateral between maker and operator based on side
        _executeOperatorFill(order, fillAmount, fee);

        ss.orderHashToFilledAmount[orderHash] += fillAmount;
        emit Events.OrderSettled(orderHash, order.maker, fillAmount, fee);
    }

    // ========================================
    // ADMIN FUNCTIONS
    // ========================================

    /**
     * @notice Set the authorized operator address.
     * @dev Only contract owner.
     * @param _operator The new operator address. Must not be `address(0)`.
     * @custom:audit SEC-011 — pre-fix this function accepted `address(0)` (silently
     *      disabling settlement until a follow-up call) and emitted no event. Now reverts
     *      on zero and emits `OperatorUpdated(old, new)`.
     * @custom:reverts Errors.ZeroAddress when `_operator == address(0)`.
     * @custom:emits OperatorUpdated
     */
    function setOperator(address _operator) external {
        LibDiamond.enforceIsContractOwner();
        if (_operator == address(0)) revert Errors.ZeroAddress();
        LibSettlementStorage.SettlementStorage storage ss = LibSettlementStorage.settlementStorage();
        address oldOperator = ss.operator;
        ss.operator = _operator;
        emit Events.OperatorUpdated(oldOperator, _operator);
    }

    /**
     * @notice Pause all settlement
     * @dev Only contract owner
     * @custom:emits SettlementTradingPaused
     */
    function pauseTrading() external {
        LibDiamond.enforceIsContractOwner();
        LibSettlementStorage.SettlementStorage storage ss = LibSettlementStorage.settlementStorage();
        ss.tradingPaused = true;
        emit Events.SettlementTradingPaused(msg.sender);
    }

    /**
     * @notice Unpause settlement
     * @dev Only contract owner
     * @custom:emits SettlementTradingUnpaused
     */
    function unpauseTrading() external {
        LibDiamond.enforceIsContractOwner();
        LibSettlementStorage.SettlementStorage storage ss = LibSettlementStorage.settlementStorage();
        ss.tradingPaused = false;
        emit Events.SettlementTradingUnpaused(msg.sender);
    }

    // ========================================
    // VIEW FUNCTIONS
    // ========================================

    /// @notice Get filled amount for an order hash
    function getFilledAmount(bytes32 orderHash) external view returns (uint256) {
        return LibSettlementStorage.settlementStorage().orderHashToFilledAmount[orderHash];
    }

    /// @notice Get the current operator
    function getOperator() external view returns (address) {
        return LibSettlementStorage.settlementStorage().operator;
    }

    /// @notice Check if trading is paused
    function isTradingPaused() external view returns (bool) {
        return LibSettlementStorage.settlementStorage().tradingPaused;
    }

    // ========================================
    // INTERNAL: VALIDATION
    // ========================================

    function _getDomainSeparator() internal view returns (bytes32) {
        LibSettlementStorage.SettlementStorage storage ss = LibSettlementStorage.settlementStorage();
        if (ss.domainSeparator != bytes32(0)) return ss.domainSeparator;
        return LibDoefinOrder.domainSeparator("Doefin Exchange", "2.1", block.chainid, address(this));
    }

    /// @notice Cache the EIP-712 domain separator (owner only, call once after deployment)
    function cacheDomainSeparator() external {
        LibDiamond.enforceIsContractOwner();
        LibSettlementStorage.SettlementStorage storage ss = LibSettlementStorage.settlementStorage();
        ss.domainSeparator = LibDoefinOrder.domainSeparator("Doefin Exchange", "2.1", block.chainid, address(this));
    }

    /**
     * @dev Verify EIP-712 order signature (EOA or EIP-1271)
     */
    function _verifySignature(
        LibDoefinOrder.DoefinOrder calldata order,
        bytes32 orderHash,
        bytes calldata signature,
        uint8 signatureType
    ) internal view {
        if (signature.length != 65) revert Errors.InvalidSignatureLength();

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;

        // Reject malleable signatures: s must be in the lower half of the curve order
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            revert Errors.InvalidOrderSignature(orderHash);
        }

        address recoveredSigner = ecrecover(orderHash, v, r, s);
        if (recoveredSigner == address(0) || recoveredSigner != order.signer) {
            revert Errors.InvalidOrderSignature(orderHash);
        }

        if (signatureType == 0) {
            // EOA: signer must be maker
            if (order.signer != order.maker) revert Errors.InvalidOrderSignature(orderHash);
        } else if (signatureType == 1) {
            // EIP-1271: check registered signer or call isValidSignature
            LibSettlementStorage.SettlementStorage storage ss = LibSettlementStorage.settlementStorage();
            if (!ss.registeredOrderSigners[order.maker][order.signer]) {
                (bool success, bytes memory result) = order.maker.staticcall(
                    abi.encodeWithSignature("isValidSignature(bytes32,bytes)", orderHash, signature)
                );
                if (!success || result.length < 32 || abi.decode(result, (bytes4)) != bytes4(0x1626ba7e)) {
                    revert Errors.InvalidOrderSignature(orderHash);
                }
            }
        } else {
            revert Errors.InvalidOrderSignature(orderHash);
        }
    }

    /**
     * @dev Validate order is not cancelled, nonce is current, salt is valid, not expired
     */
    function _validateOrder(
        LibSettlementStorage.SettlementStorage storage ss,
        LibDoefinOrder.DoefinOrder calldata order,
        bytes32 orderHash
    ) internal view {
        if (ss.cancelledOrders[orderHash]) revert Errors.OrderCancelled(orderHash);
        if (order.nonce < ss.makerToNonce[order.maker]) {
            revert Errors.OrderNonceInvalid(orderHash, order.nonce, ss.makerToNonce[order.maker]);
        }
        if (order.salt < ss.makerPositionToMinSalt[order.maker][order.positionId]) {
            revert Errors.OrderCancelled(orderHash);
        }
        if (order.expiration != 0 && block.timestamp >= order.expiration) {
            revert Errors.OrderCancelled(orderHash);
        }
    }

    /**
     * @dev Check fill amount does not exceed remaining
     */
    function _checkFillAmount(
        LibSettlementStorage.SettlementStorage storage ss,
        bytes32 orderHash,
        uint128 orderAmount,
        uint128 fillAmount
    ) internal view {
        uint256 filled = ss.orderHashToFilledAmount[orderHash];
        uint256 remaining = uint256(orderAmount) - filled;
        if (uint256(fillAmount) > remaining) {
            revert Errors.OrderOverfilled(orderHash, fillAmount, remaining);
        }
    }

    // ========================================
    // INTERNAL: MATCH TYPE DETERMINATION
    // ========================================

    /**
     * @dev Determine settlement path based on position relationship and order sides.
     * @dev Complement lookup reads the CTF registry (LibPositionRegistry) as the single
     *      source of truth. Any position that has been through splitPosition is
     *      registered automatically, so no owner-only registration step is required.
     * @return matchType 1=Complementary, 2=Mint, 3=Merge
     */
    function _determineMatchType(
        LibDoefinOrder.DoefinOrder calldata taker,
        LibDoefinOrder.DoefinOrder calldata maker
    ) internal view returns (uint8) {
        // Same position, opposite sides -> Complementary
        if (taker.positionId == maker.positionId && taker.side != maker.side) {
            return MATCH_COMPLEMENTARY;
        }

        // Check if positions are complements via the CTF registry
        if (_isBinaryComplement(uint256(taker.positionId), uint256(maker.positionId))) {
            if (taker.side == 0 && maker.side == 0) return MATCH_MINT;
            if (taker.side == 1 && maker.side == 1) return MATCH_MERGE;
        }

        revert Errors.InvalidMatch();
    }

    /**
     * @dev Registry-backed complement check. Returns false (not revert) for
     *      unregistered positions, non-binary markets, or cross-market pairs,
     *      so `_determineMatchType` can fall through to a single InvalidMatch()
     *      revert instead of leaking low-level registry errors to callers.
     */
    function _isBinaryComplement(uint256 takerPos, uint256 makerPos) private view returns (bool) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        bytes32 marketKey = ds.positionRegistry.marketKeyByPositionId[takerPos];
        if (marketKey == bytes32(0)) return false;
        // Cross-market pairs are never complements
        if (ds.positionRegistry.marketKeyByPositionId[makerPos] != marketKey) return false;
        uint256[] storage positionIds = ds.positionRegistry.marketsByKey[marketKey].positionIds;
        if (positionIds.length != 2) return false;
        if (positionIds[0] == takerPos) return positionIds[1] == makerPos;
        if (positionIds[1] == takerPos) return positionIds[0] == makerPos;
        return false;
    }

    // ========================================
    // INTERNAL: SETTLEMENT EXECUTION
    // ========================================

    /**
     * @dev Route to the correct settlement path
     */
    function _executeSettlement(
        LibDoefinOrder.DoefinOrder calldata taker,
        LibDoefinOrder.DoefinOrder calldata maker,
        uint128 fillAmount,
        uint128 takerFee,
        uint128 makerFee,
        uint8 matchType
    ) internal {
        if (matchType == MATCH_COMPLEMENTARY) {
            _settleComplementary(taker, maker, fillAmount, takerFee, makerFee);
        } else if (matchType == MATCH_MINT) {
            _settleMint(taker, maker, fillAmount, takerFee, makerFee);
        } else if (matchType == MATCH_MERGE) {
            _settleMerge(taker, maker, fillAmount, takerFee, makerFee);
        }
    }

    /**
     * @dev Complementary settlement: Buy vs Sell on same position
     *      Buyer pays collateral to seller + buyer's own fee to feeReceiver.
     *      Seller pays their own fee to feeReceiver from proceeds.
     *      Seller transfers position tokens to buyer.
     */
    function _settleComplementary(
        LibDoefinOrder.DoefinOrder calldata taker,
        LibDoefinOrder.DoefinOrder calldata maker,
        uint128 fillAmount,
        uint128 takerFee,
        uint128 makerFee
    ) internal {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        uint256 unit = ds.adminConfigStorage.unitPerPair[taker.collateralToken];
        address feeReceiver = ds.adminConfigStorage.feeReceiver;

        // Determine buyer/seller and their respective fees
        bool takerIsBuyer = taker.side == 0;
        address buyerAddr = takerIsBuyer ? taker.maker : maker.maker;
        address sellerAddr = takerIsBuyer ? maker.maker : taker.maker;
        uint128 buyerFee = takerIsBuyer ? takerFee : makerFee;
        uint128 sellerFee = takerIsBuyer ? makerFee : takerFee;

        // Verify price compatibility: buyer's price must be >= seller's price
        uint128 buyerPrice = takerIsBuyer ? taker.pricePerToken : maker.pricePerToken;
        uint128 sellerPrice = takerIsBuyer ? maker.pricePerToken : taker.pricePerToken;
        if (buyerPrice < sellerPrice) revert Errors.InvalidMatch();

        // Use maker's price as execution price (maker is passive, taker is aggressor)
        uint256 collateralAmount = (uint256(maker.pricePerToken) * uint256(fillAmount)) / unit;

        // Buyer pays collateral to seller
        IERC20(taker.collateralToken).safeTransferFrom(buyerAddr, sellerAddr, collateralAmount);

        // Buyer pays their own fee
        if (buyerFee > 0) {
            IERC20(taker.collateralToken).safeTransferFrom(buyerAddr, feeReceiver, buyerFee);
        }

        // Seller pays their own fee (from proceeds)
        if (sellerFee > 0) {
            IERC20(taker.collateralToken).safeTransferFrom(sellerAddr, feeReceiver, sellerFee);
        }

        // Seller transfers position tokens to buyer
        LibERC1155.safeTransferFrom(address(this), sellerAddr, buyerAddr, uint256(taker.positionId), fillAmount, "");
    }

    /**
     * @dev Mint settlement: Both buyers of complement positions
     *      Both buyers' SCWs transfer collateral to Diamond
     *      Diamond splits to mint both outcome tokens
     *      Each buyer receives their desired position
     */
    function _settleMint(
        LibDoefinOrder.DoefinOrder calldata taker,
        LibDoefinOrder.DoefinOrder calldata maker,
        uint128 fillAmount,
        uint128 takerFee,
        uint128 makerFee
    ) internal {
        if (taker.collateralToken != maker.collateralToken) revert Errors.InvalidMatch();

        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        uint256 unit = ds.adminConfigStorage.unitPerPair[taker.collateralToken];
        address feeReceiver = ds.adminConfigStorage.feeReceiver;

        // Validate crossing: taker's ceiling >= effective price (unit - maker.price)
        if (uint256(taker.pricePerToken) + uint256(maker.pricePerToken) < unit) revert Errors.InvalidMatch();

        // Maker pays their committed price; taker pays the complement (effective price = unit - P_m)
        uint256 makerCollateral = (uint256(maker.pricePerToken) * uint256(fillAmount)) / unit;
        uint256 takerCollateral = uint256(fillAmount) - makerCollateral;
        // 1-wei rounding surplus (from integer division) flows to taker by construction.
        // Do not add a makerExpected + 1 tolerance — this is intentional.

        // Collect collateral from both buyers to Diamond
        IERC20(taker.collateralToken).safeTransferFrom(taker.maker, address(this), takerCollateral);
        IERC20(maker.collateralToken).safeTransferFrom(maker.maker, address(this), makerCollateral);

        // Collect fees
        if (takerFee > 0) {
            IERC20(taker.collateralToken).safeTransferFrom(taker.maker, feeReceiver, takerFee);
        }
        if (makerFee > 0) {
            IERC20(maker.collateralToken).safeTransferFrom(maker.maker, feeReceiver, makerFee);
        }

        // Split position: Diamond mints both outcome tokens to itself.
        // Read conditionId from the CTF registry — populated by the initial splitPosition
        // that seeded this market. _determineMatchType already verified both positions
        // belong to the same binary market, so this lookup cannot be zero here.
        bytes32 conditionId = ds.positionRegistry.conditionIdByPositionId[uint256(taker.positionId)];
        // Build partition for the two complement positions
        // positionId encodes the indexSet — we need to reconstruct the partition
        // For a binary market with positions at indexSets [1, 2], partition = [1, 2]
        uint256[] memory partition = new uint256[](2);
        partition[0] = _getIndexSet(taker.positionId);
        partition[1] = _getIndexSet(maker.positionId);

        // Use internal variant that skips reentrancy guard — caller (matchOrders) already holds the lock.
        // Safe because sender == address(this) means no external calls in the split path.
        LibCTFCondition._splitPositionInternal(
            address(this),
            taker.collateralToken,
            bytes32(0),
            conditionId,
            fillAmount,
            partition
        );

        // Transfer minted positions to respective buyers
        LibERC1155.safeTransferFrom(address(this), address(this), taker.maker, uint256(taker.positionId), fillAmount, "");
        LibERC1155.safeTransferFrom(address(this), address(this), maker.maker, uint256(maker.positionId), fillAmount, "");
    }

    /**
     * @dev Merge settlement: Both sellers of complement positions
     *      Both sellers' SCWs transfer position tokens to Diamond
     *      Diamond merges to recover collateral
     *      Collateral distributed to sellers proportionally minus fees
     */
    function _settleMerge(
        LibDoefinOrder.DoefinOrder calldata taker,
        LibDoefinOrder.DoefinOrder calldata maker,
        uint128 fillAmount,
        uint128 takerFee,
        uint128 makerFee
    ) internal {
        if (taker.collateralToken != maker.collateralToken) revert Errors.InvalidMatch();

        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        uint256 unit = ds.adminConfigStorage.unitPerPair[taker.collateralToken];
        address feeReceiver = ds.adminConfigStorage.feeReceiver;

        // Collect position tokens from both sellers to Diamond
        LibERC1155.safeTransferFrom(address(this), taker.maker, address(this), uint256(taker.positionId), fillAmount, "");
        LibERC1155.safeTransferFrom(address(this), maker.maker, address(this), uint256(maker.positionId), fillAmount, "");

        // Merge positions: Diamond burns both outcome tokens, recovers collateral.
        // Read conditionId from the CTF registry — _determineMatchType already verified
        // both positions belong to the same binary market, so this cannot be zero.
        bytes32 conditionId = ds.positionRegistry.conditionIdByPositionId[uint256(taker.positionId)];
        uint256[] memory partition = new uint256[](2);
        partition[0] = _getIndexSet(taker.positionId);
        partition[1] = _getIndexSet(maker.positionId);

        // Use internal variant that skips reentrancy guard — caller (matchOrders) already holds the lock.
        // Safe because sender == address(this) means no external calls in the merge path.
        LibCTFCondition._mergePositionsInternal(
            address(this),
            taker.collateralToken,
            bytes32(0),
            conditionId,
            partition,
            fillAmount
        );

        // Validate crossing: taker's floor <= effective return (unit - maker.price)
        if (uint256(taker.pricePerToken) + uint256(maker.pricePerToken) > unit) revert Errors.InvalidMatch();

        // Maker receives their committed price; taker receives the complement (effective return = unit - P_m)
        uint256 makerPayout = (uint256(maker.pricePerToken) * uint256(fillAmount)) / unit;
        uint256 takerPayout = uint256(fillAmount) - makerPayout;
        // 1-wei rounding surplus (from integer division) flows to taker by construction.
        // Do not add a makerExpected + 1 tolerance — this is intentional.

        // Deduct fees and transfer
        if (takerPayout > takerFee) {
            IERC20(taker.collateralToken).safeTransfer(taker.maker, takerPayout - takerFee);
        }
        if (makerPayout > makerFee) {
            IERC20(maker.collateralToken).safeTransfer(maker.maker, makerPayout - makerFee);
        }

        // Send fees
        uint256 totalFees = uint256(takerFee) + uint256(makerFee);
        if (totalFees > 0) {
            IERC20(taker.collateralToken).safeTransfer(feeReceiver, totalFees);
        }
    }

    /**
     * @dev Operator direct fill — operator is the counterparty
     */
    function _executeOperatorFill(
        LibDoefinOrder.DoefinOrder calldata order,
        uint128 fillAmount,
        uint128 fee
    ) internal {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        uint256 unit = ds.adminConfigStorage.unitPerPair[order.collateralToken];
        address feeReceiver = ds.adminConfigStorage.feeReceiver;
        uint256 collateralAmount = (uint256(order.pricePerToken) * uint256(fillAmount)) / unit;

        if (order.side == 0) {
            // Order is a buy: maker pays collateral to operator, operator gives position tokens
            IERC20(order.collateralToken).safeTransferFrom(order.maker, msg.sender, collateralAmount - fee);
            if (fee > 0) {
                IERC20(order.collateralToken).safeTransferFrom(order.maker, feeReceiver, fee);
            }
            // Operator transfers position tokens to maker
            LibERC1155.safeTransferFrom(address(this), msg.sender, order.maker, uint256(order.positionId), fillAmount, "");
        } else {
            // Order is a sell: maker gives position tokens, operator pays collateral
            LibERC1155.safeTransferFrom(address(this), order.maker, msg.sender, uint256(order.positionId), fillAmount, "");
            IERC20(order.collateralToken).safeTransferFrom(msg.sender, order.maker, collateralAmount - fee);
            if (fee > 0) {
                IERC20(order.collateralToken).safeTransferFrom(msg.sender, feeReceiver, fee);
            }
        }
    }

    // ========================================
    // INTERNAL: FEE CALCULATION
    // ========================================

    /**
     * @dev Symmetric fee: fee = rate * min(price, 1-price) * amount / (unit * 10000)
     * @param feeRateBps Fee rate in basis points
     * @param price Price per token
     * @param amount Fill amount
     * @param collateralToken Collateral token (for unit lookup)
     * @return fee The computed fee
     */
    function _computeFee(
        uint16 feeRateBps,
        uint128 price,
        uint128 amount,
        address collateralToken
    ) internal view returns (uint128) {
        if (feeRateBps == 0) return 0;
        if (feeRateBps > MAX_FEE_RATE_BPS) revert Errors.FeeTooHigh();
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        uint128 unit = uint128(ds.adminConfigStorage.unitPerPair[collateralToken]);
        if (price > unit) revert Errors.InvalidPrice();
        uint128 complementPrice = unit - price;
        uint128 effectivePrice = price < complementPrice ? price : complementPrice;
        return uint128((uint256(feeRateBps) * uint256(effectivePrice) * uint256(amount)) / (uint256(unit) * 10000));
    }

    // ========================================
    // INTERNAL: HELPERS
    // ========================================

    /**
     * @dev Extract the index set for a positionId from the CTF position registry.
     * @dev positionId = keccak256(collateralToken, collectionId), where collectionId
     *      encodes the indexSet via alt-bn128 EC arithmetic — it cannot be reversed,
     *      so we look it up in the registry populated during splitPosition.
     */
    function _getIndexSet(bytes32 positionId) internal view returns (uint256) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        bytes32 marketKey = ds.positionRegistry.marketKeyByPositionId[uint256(positionId)];
        LibDoefinStorage.MarketMetadata storage meta = ds.positionRegistry.marketsByKey[marketKey];

        // Find which partition slot this positionId occupies
        for (uint256 i; i < meta.positionIds.length; ++i) {
            if (meta.positionIds[i] == uint256(positionId)) {
                return meta.partitions[i];
            }
        }
        revert Errors.InvalidPositionId();
    }
}
