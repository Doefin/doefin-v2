// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.20;

import {LibDoefinOrder} from "../libraries/LibDoefinOrder.sol";
import {LibSettlementStorage} from "../libraries/LibSettlementStorage.sol";
import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {LibAdminConfigStorage} from "../libraries/LibAdminConfigStorage.sol";
import {LibCTFCondition} from "../libraries/LibCTFCondition.sol";
import {LibERC1155} from "../libraries/LibERC1155.sol";
import {LibReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {LibAccessControl} from "../libraries/LibAccessControl.sol";
import {LibSignature} from "../libraries/LibSignature.sol";
import {LibOrderValidity} from "../libraries/LibOrderValidity.sol";
import {LibConstants} from "../libraries/LibConstants.sol";
import {Errors} from "../libraries/Errors.sol";
import {Events} from "../libraries/Events.sol";
import {ISettlement} from "../interfaces/ISettlement.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title SettlementFacet
 * @author Doefin
 * @notice Core on-chain settlement for the v3 hybrid model
 * @dev Operator-only entry point that executes matched order pairs. Replaces on-chain matching
 *      with a simpler validate-and-execute model. Supports Complementary, Mint, and Merge paths.
 */
contract SettlementFacet is ISettlement {
    using SafeERC20 for IERC20;

    // Match type constants
    uint8 internal constant MATCH_COMPLEMENTARY = 1;
    uint8 internal constant MATCH_MINT = 2;
    uint8 internal constant MATCH_MERGE = 3;

    // ========================================
    // MODIFIERS
    // ========================================

    modifier onlyOperator() {
        LibAccessControl.enforceIsOperator();
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
     * @notice Settle a matched pair: one taker against one or more makers (user-vs-user CLOB).
     * @dev Only callable by the authorized operator. Validates signatures, order validity,
     *      fill amounts, determines match type, and executes the appropriate settlement path.
     * @dev See {fillOrder} for the operator-as-counterparty primitive used by any
     *      market-making service (LMSR / FPMM / discretionary).
     * @param takerOrder The taker's signed order
     * @param takerSignature The taker's ECDSA signature
     * @param takerSignatureType 0 = EOA, 1 = EIP-1271
     * @param makerOrders Array of maker orders to match against
     * @param makerSignatures Array of maker signatures
     * @param makerSignatureTypes Array of maker signature types
     * @param takerFillAmount Total amount to fill for the taker across all makers
     * @param makerFillAmounts Amount to fill for each maker order
     * @param takerFees Operator-supplied taker fee for each settlement leg (length == makerOrders.length)
     * @param makerFees Operator-supplied maker fee for each settlement leg (length == makerOrders.length)
     * @custom:audit SCRUM-224 — the fee is no longer signed by the maker. The operator
     *      supplies a per-leg fee amount; `_validateFee` enforces the admin-set maximum
     *      rate (fail-closed: a 0 rate forbids any non-zero fee) and that the fee never
     *      exceeds the contract-derived per-party collateral.
     * @custom:reverts TradingIsPaused, UnauthorizedOperator, MismatchedInputLengths, FillAmountMismatch,
     *                 InvalidOrderSignature, OrderCancelled, OrderOverfilled, InvalidMatch, ZeroAmount,
     *                 FeeExceedsMaxRate, FeeExceedsProceeds
     */
    function matchOrders(
        LibDoefinOrder.DoefinOrder calldata takerOrder,
        bytes calldata takerSignature,
        uint8 takerSignatureType,
        LibDoefinOrder.DoefinOrder[] calldata makerOrders,
        bytes[] calldata makerSignatures,
        uint8[] calldata makerSignatureTypes,
        uint128 takerFillAmount,
        uint128[] calldata makerFillAmounts,
        uint128[] calldata takerFees,
        uint128[] calldata makerFees
    ) external onlyOperator notPaused nonReentrant {
        // Input validation — every per-leg array must have one entry per maker order.
        if (
            makerOrders.length != makerFillAmounts.length ||
            makerOrders.length != makerSignatures.length ||
            makerOrders.length != makerSignatureTypes.length ||
            makerOrders.length != takerFees.length ||
            makerOrders.length != makerFees.length
        ) {
            revert Errors.MismatchedInputLengths();
        }
        if (takerFillAmount == 0) revert Errors.ZeroAmount();

        LibSettlementStorage.SettlementStorage storage ss = LibSettlementStorage.settlementStorage();
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        bytes32 domainSep = _getDomainSeparator();

        // Validate taker once. The settlement-only invariants in `_validateOrder` (collateral
        // allow-list, non-zero unit, `pricePerToken <= unit`) hold for every maker too
        // because `_validateOrder` is called per-maker below; the `_settleX` routines may
        // therefore trust `unit != 0` and `price <= unit`.
        bytes32 takerHash = LibDoefinOrder.hashOrderCalldata(takerOrder, domainSep);
        LibSignature.verifyOrderSignature(takerOrder, takerHash, takerSignature, takerSignatureType);
        _validateOrder(ss, takerOrder, takerHash);
        _checkFillAmount(ss, takerHash, takerOrder.amount, takerFillAmount);

        // GAS-004: hoist `unit` and `feeReceiver` for the taker collateral once per loop,
        // pass them into the settle/fee helpers so they're not re-resolved per call.
        // SEC-001 is checked again inside each `_settleX` so taker/maker tokens cannot
        // diverge — if either differs, the call reverts before any transfer.
        LibAdminConfigStorage.AdminConfigStorage storage acs = LibAdminConfigStorage.adminConfigStorage();
        uint256 takerUnit = acs.unitPerPair[takerOrder.collateralToken];
        address feeReceiver = acs.feeReceiver;
        // GAS-003: hoist maxFeeRateBps once (same packed slot as feeReceiver — already
        // warm) and thread it to _validateFee, which becomes a pure, storage-free check.
        uint16 maxFeeRateBps = acs.maxFeeRateBps;

        // CPX-006 + GAS-006: single linear maker loop. The aggregate
        // `sum(makerFillAmounts) == takerFillAmount` consistency check that previously
        // ran in a separate pre-loop is now accumulated alongside the main work. Each
        // leg is independently bounded by `_checkFillAmount` (per-maker remaining
        // capacity); the aggregate is a router-input consistency invariant.
        uint128 totalMakerFill;
        uint128 totalTakerFee;
        uint256 makerCount = makerOrders.length;
        for (uint256 i; i < makerCount;) {
            uint128 fill = makerFillAmounts[i];
            totalMakerFill += fill;
            _settleAgainstMaker(
                takerOrder,
                makerOrders[i],
                makerSignatures[i],
                makerSignatureTypes[i],
                fill,
                takerFees[i],
                makerFees[i],
                takerHash,
                domainSep,
                takerUnit,
                feeReceiver,
                maxFeeRateBps,
                ss,
                ds
            );
            totalTakerFee += takerFees[i];
            unchecked { ++i; }
        }
        // Router-input invariant: total maker fill equals declared taker fill.
        if (totalMakerFill != takerFillAmount) revert Errors.FillAmountMismatch(totalMakerFill, takerFillAmount);

        // Update taker fill state
        ss.orderHashToFilledAmount[takerHash] += takerFillAmount;
        emit Events.OrderSettled(takerHash, takerOrder.maker, takerFillAmount, totalTakerFee);
    }

    /**
     * @dev Single-maker loop body extracted from {matchOrders} (CPX-006). Handles signature
     *      verification, the shared order-validity rules, fill-amount cap, match-type
     *      routing, settlement execution, and maker-side fill bookkeeping + events.
     * @dev SCRUM-224 — `takerFee` / `makerFee` are operator-supplied (no longer derived
     *      from a signed `feeRateBps`). Each is validated inside the settle helper against
     *      the contract-derived per-party collateral via `_validateFee`.
     * @param takerFee Operator-supplied taker fee for this leg.
     * @param makerFee Operator-supplied maker fee for this leg.
     */
    function _settleAgainstMaker(
        LibDoefinOrder.DoefinOrder calldata takerOrder,
        LibDoefinOrder.DoefinOrder calldata makerOrder,
        bytes calldata makerSignature,
        uint8 makerSignatureType,
        uint128 fillAmount,
        uint128 takerFee,
        uint128 makerFee,
        bytes32 takerHash,
        bytes32 domainSep,
        uint256 takerUnit,
        address feeReceiver,
        uint16 maxFeeRateBps,
        LibSettlementStorage.SettlementStorage storage ss,
        LibDoefinStorage.AppStorage storage ds
    ) private {
        if (fillAmount == 0) revert Errors.ZeroAmount();
        if (makerOrder.maker == takerOrder.maker) revert Errors.SelfTrade();

        bytes32 makerHash = LibDoefinOrder.hashOrderCalldata(makerOrder, domainSep);
        LibSignature.verifyOrderSignature(makerOrder, makerHash, makerSignature, makerSignatureType);
        _validateOrder(ss, makerOrder, makerHash);
        _checkFillAmount(ss, makerHash, makerOrder.amount, fillAmount);

        // Determine and execute settlement path. Fees are operator-supplied (SCRUM-224)
        // and validated inside each settle helper against the per-party collateral.
        uint8 matchType = _determineMatchType(takerOrder, makerOrder);

        _executeSettlement(
            takerOrder,
            makerOrder,
            fillAmount,
            takerFee,
            makerFee,
            matchType,
            takerUnit,
            feeReceiver,
            maxFeeRateBps,
            ds
        );

        // Update maker fill state
        ss.orderHashToFilledAmount[makerHash] += fillAmount;

        emit Events.OrderSettled(makerHash, makerOrder.maker, fillAmount, makerFee);
        emit Events.OrdersMatched(takerHash, makerHash, matchType, fillAmount);
    }

    /**
     * @notice Fill a single order — the operator is the counterparty (no user-on-user matching).
     *
     * @dev Distinct from {matchOrders} (user-vs-user CLOB settlement). This is the
     *      operator-as-counterparty primitive: the operator (or a market-maker service
     *      run under the operator role) settles collateral and position tokens directly
     *      against its own inventory. No CTF split/merge is performed — for a buy order
     *      the operator must already hold the position tokens; for a sell order it
     *      receives them. The execution helper is `_executeOperatorFill` (vs
     *      `_settleComplementary` / `_settleMint` / `_settleMerge` for {matchOrders}).
     *
     * @dev Strategic role — automated or discretionary market making.
     *      {matchOrders} requires two crossing user orders to exist; if a book is thin
     *      or one-sided, only an operator-as-MM can provide the missing side.
     *      `fillOrder` is the on-chain primitive any market-making algorithm uses to
     *      settle a quote, including:
     *        - Hanson's LMSR (cost function `C(q) = b·ln Σ exp(q_i/b)`; bounded subsidy
     *          `b·ln N`; the canonical academic MM for prediction markets);
     *        - Fixed-product (FPMM, constant-product — the Gnosis design used by
     *          Polymarket's early AMM pools);
     *        - Reservation-price / inventory-skewed quoting;
     *        - Human-discretionary market making.
     *      Polymarket CTF Exchange V2 ships the same `fillOrder` + `matchOrders` pair
     *      for the same reason: the CLOB matches user orders, an MM service quotes
     *      via `fillOrder`.
     *
     * @dev Current Doefin integration. The doefin-backend `match-engine` settles via
     *      `matchOrders` exclusively (pure orderbook relayer; the operator never takes
     *      inventory risk). `fillOrder` is currently unused on-chain — it is retained
     *      as the standing primitive for any future Doefin-operated or licensed
     *      market-making service.
     *
     * @dev SCRUM-224 — `fee` is operator-supplied (no longer derived from a signed
     *      `feeRateBps`). `_executeOperatorFill` validates it against the contract-derived
     *      collateral leg via `_validateFee`.
     *
     * @param order The order to fill.
     * @param signature The order's ECDSA signature.
     * @param signatureType 0 = EOA, 1 = EIP-1271.
     * @param fillAmount Amount to fill.
     * @param fee Operator-supplied fee for this fill.
     * @custom:reverts ZeroAmount, FeeExceedsMaxRate, FeeExceedsProceeds
     */
    function fillOrder(
        LibDoefinOrder.DoefinOrder calldata order,
        bytes calldata signature,
        uint8 signatureType,
        uint128 fillAmount,
        uint128 fee
    ) external onlyOperator notPaused nonReentrant {
        if (fillAmount == 0) revert Errors.ZeroAmount();

        LibSettlementStorage.SettlementStorage storage ss = LibSettlementStorage.settlementStorage();
        bytes32 domainSep = _getDomainSeparator();
        bytes32 orderHash = LibDoefinOrder.hashOrderCalldata(order, domainSep);

        LibSignature.verifyOrderSignature(order, orderHash, signature, signatureType);
        _validateOrder(ss, order, orderHash);
        _checkFillAmount(ss, orderHash, order.amount, fillAmount);

        // GAS-004: read `unit` once. GAS-003: hoist feeReceiver + maxFeeRateBps alongside it.
        // `_validateOrder` already enforces `unit != 0` and `price <= unit` (SEC-002/BIZ-004).
        LibAdminConfigStorage.AdminConfigStorage storage acs = LibAdminConfigStorage.adminConfigStorage();
        uint256 unit = acs.unitPerPair[order.collateralToken];

        // Transfer collateral between maker and operator based on side
        _executeOperatorFill(order, fillAmount, fee, unit, acs.feeReceiver, acs.maxFeeRateBps);

        ss.orderHashToFilledAmount[orderHash] += fillAmount;
        emit Events.OrderSettled(orderHash, order.maker, fillAmount, fee);
    }

    // ========================================
    // VIEW FUNCTIONS
    // ========================================

    /// @notice Get filled amount for an order hash
    function getFilledAmount(bytes32 orderHash) external view returns (uint256) {
        return LibSettlementStorage.settlementStorage().orderHashToFilledAmount[orderHash];
    }

    // ========================================
    // INTERNAL: VALIDATION
    // ========================================

    /// @dev Recomputed on every call via {LibDoefinOrder.diamondDomainSeparator}.
    /// @custom:audit SEC-004 — the storage-cached separator was removed: it had no
    ///      `chainId` guard and the other two facets always recomputed; a chain fork would
    ///      have made cancellations and settlement disagree on the digest. The `~300 gas`
    ///      saved by the cache is negligible on Base L2 next to that hazard.
    function _getDomainSeparator() internal view returns (bytes32) {
        return LibDoefinOrder.diamondDomainSeparator(address(this));
    }


    /**
     * @dev Validate an order on the settlement hot path: shared orderbook-validity rules
     *      from {LibOrderValidity} plus the settlement-only invariants (collateral
     *      whitelist, non-zero unit, price bounds, supported side).
     * @custom:audit CPX-003 — the shared rules now live in {LibOrderValidity}. The bool
     *      wrapper {NonceManagerFacet.isOrderValid} stays for off-chain orderbook use,
     *      so this function only needs to encode "why" each rule failed and add the
     *      settlement-only invariants. Pre-fix, the rules were duplicated.
     * @custom:security SEC-002 — the collateral token must be allow-listed and must have a
     *      non-zero `unitPerPair`. Without this central gate a compromised operator could
     *      settle trades for an unwhitelisted/removed token: a removed token has `unit==0`
     *      (div-by-zero panic on the price math) and a zero-fee order against a mis-set
     *      `unitPerPair` would settle at a wrong price with no revert.
     * @custom:security BIZ-004 — `pricePerToken` must not exceed `unitPerPair` (a price of
     *      one whole token). Reuses the SEC-002 `unitPerPair` read.
     * @custom:security BIZ-006 — `side` must be 0 (buy) or 1 (sell); a `side >= 2` order
     *      would otherwise reach the complementary path through `_determineMatchType`.
     * @custom:security SCRUM-235 — the order's CTF condition must still be active (not
     *      cancelled via {ConditionManagerFacet.cancelCondition}) AND not yet resolved
     *      (`payoutDenominator == 0`). Without these gates a compromised operator could
     *      (1) route still-validly-signed orders against a cancelled market and drain
     *      buyers' collateral for tokens with no economic backing, or (2) settle
     *      losers' open orders post-resolution at pre-resolution prices. The check is
     *      skipped when the positionId is not in the registry (conditionId == 0) —
     *      unregistered positions are rejected downstream by `_determineMatchType` /
     *      the CTF split/merge paths, and `ConditionNotActive` would be a misnomer for
     *      that case.
     */
    function _validateOrder(
        LibSettlementStorage.SettlementStorage storage ss,
        LibDoefinOrder.DoefinOrder calldata order,
        bytes32 orderHash
    ) internal view {
        // Replays the shared LibOrderValidity rules but reverts with a specific reason so
        // a failed match doesn't return a generic boolean to the operator.
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

        // BIZ-006: reject orders with an unsupported side before any settlement routing.
        if (order.side > 1) revert Errors.InvalidMatch();

        // SEC-002: enforce the collateral allow-list and a non-zero settlement unit on the
        // settlement hot path — the gate is otherwise silently skipped.
        LibAdminConfigStorage.AdminConfigStorage storage cfg = LibAdminConfigStorage.adminConfigStorage();
        if (!cfg.isAllowed[order.collateralToken]) revert Errors.TokenNotAllowed();
        uint256 unit = cfg.unitPerPair[order.collateralToken];
        if (unit == 0) revert Errors.InvalidUnitPerPair();

        // BIZ-004: a price above one whole token (unit) is never valid.
        if (uint256(order.pricePerToken) > unit) revert Errors.InvalidPrice();

        // SCRUM-235: the order's CTF condition must still be active and unresolved.
        // The check is gated on `conditionId != 0` to preserve the existing
        // "unregistered position -> InvalidMatch" surface (see NatSpec above).
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        bytes32 conditionId = ds.positionRegistry.conditionIdByPositionId[uint256(order.positionId)];
        if (conditionId != bytes32(0)) {
            LibCTFCondition.enforceConditionIsActive(conditionId);
            if (ds.conditionalTokens.payoutDenominator[conditionId] != 0) {
                revert Errors.ConditionAlreadyResolved();
            }
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
     * @dev Route to the correct settlement path. Threads the per-loop hoisted `unit` and
     *      `feeReceiver` (GAS-004) and the AppStorage pointer (GAS-002) so the helpers do
     *      not re-resolve them per call.
     */
    function _executeSettlement(
        LibDoefinOrder.DoefinOrder calldata taker,
        LibDoefinOrder.DoefinOrder calldata maker,
        uint128 fillAmount,
        uint128 takerFee,
        uint128 makerFee,
        uint8 matchType,
        uint256 unit,
        address feeReceiver,
        uint16 maxFeeRateBps,
        LibDoefinStorage.AppStorage storage ds
    ) internal {
        if (matchType == MATCH_COMPLEMENTARY) {
            _settleComplementary(taker, maker, fillAmount, takerFee, makerFee, unit, feeReceiver, maxFeeRateBps);
        } else if (matchType == MATCH_MINT) {
            _settleMint(taker, maker, fillAmount, takerFee, makerFee, unit, feeReceiver, maxFeeRateBps, ds);
        } else if (matchType == MATCH_MERGE) {
            _settleMerge(taker, maker, fillAmount, takerFee, makerFee, unit, feeReceiver, maxFeeRateBps, ds);
        }
    }

    /**
     * @dev Complementary settlement: Buy vs Sell on same position
     *      Buyer pays collateral to seller + buyer's own fee to feeReceiver.
     *      Seller pays their own fee to feeReceiver from proceeds.
     *      Seller transfers position tokens to buyer.
     * @custom:security SEC-001 — both orders must be denominated in the same collateral
     *      token. Without this guard a compromised operator could pair a maker SELL signed
     *      in token A with a taker BUY in token B; settlement would execute wholly in token B
     *      (the maker's signed token is never read on this path). Matches the identical
     *      guard at the top of `_settleMint` and `_settleMerge`.
     */
    function _settleComplementary(
        LibDoefinOrder.DoefinOrder calldata taker,
        LibDoefinOrder.DoefinOrder calldata maker,
        uint128 fillAmount,
        uint128 takerFee,
        uint128 makerFee,
        uint256 unit,
        address feeReceiver,
        uint16 maxFeeRateBps
    ) internal {
        if (taker.collateralToken != maker.collateralToken) revert Errors.InvalidMatch();

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

        // Use maker's price as execution price (maker is passive, taker is aggressor).
        // GAS-006: unchecked — `_validateOrder` enforces `pricePerToken <= unit` (BIZ-004)
        // and `unit` is a practical collateral scale, so the product stays far below 2^256.
        uint256 collateralAmount;
        unchecked { collateralAmount = (uint256(maker.pricePerToken) * uint256(fillAmount)) / unit; }

        // BL-N2: reject a dust leg whose collateral truncates to 0 (`P_maker == 0` or
        // `P_maker * fillAmount < unit`) — a zero-value trade would transfer `fillAmount`
        // position tokens for no payment. Symmetric with the `_executeOperatorFill`
        // SEC-003 guard so both settlement entrypoints fail closed on a degenerate leg.
        if (collateralAmount == 0) revert Errors.ZeroAmount();

        // SCRUM-224: operator-supplied fees, validated against the per-party collateral
        // (the contract-derived cash value of this leg) and the admin-set max rate.
        // The seller's fee is paid out of their `collateralAmount` proceeds, so it is
        // additionally bounded by `fee <= proceeds`.
        _validateFee(buyerFee, collateralAmount, maxFeeRateBps);
        _validateFee(sellerFee, collateralAmount, maxFeeRateBps);
        if (sellerFee > collateralAmount) revert Errors.FeeExceedsProceeds();

        // Buyer pays collateral to seller
        IERC20(taker.collateralToken).safeTransferFrom(buyerAddr, sellerAddr, collateralAmount);

        // Buyer pays their own fee
        if (buyerFee > 0) {
            IERC20(taker.collateralToken).safeTransferFrom(buyerAddr, feeReceiver, buyerFee);
            emit Events.FeeCharged(feeReceiver, buyerFee);
        }

        // Seller pays their own fee (from proceeds)
        if (sellerFee > 0) {
            IERC20(taker.collateralToken).safeTransferFrom(sellerAddr, feeReceiver, sellerFee);
            emit Events.FeeCharged(feeReceiver, sellerFee);
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
        uint128 makerFee,
        uint256 unit,
        address feeReceiver,
        uint16 maxFeeRateBps,
        LibDoefinStorage.AppStorage storage ds
    ) internal {
        if (taker.collateralToken != maker.collateralToken) revert Errors.InvalidMatch();

        // Validate crossing: taker's ceiling >= effective price (unit - maker.price)
        if (uint256(taker.pricePerToken) + uint256(maker.pricePerToken) < unit) revert Errors.InvalidMatch();

        // Maker pays their committed price; taker pays the complement (effective price = unit - P_m).
        // GAS-007: `fillAmount - makerCollateral` is guarded by the crossing check above —
        // when `P_t + P_m >= unit`, `makerCollateral = (P_m * fill) / unit <= fill`.
        // GAS-006: unchecked — `pricePerToken <= unit` (BIZ-004) bounds the product.
        uint256 makerCollateral;
        unchecked { makerCollateral = (uint256(maker.pricePerToken) * uint256(fillAmount)) / unit; }
        uint256 takerCollateral;
        unchecked { takerCollateral = uint256(fillAmount) - makerCollateral; }
        // 1-wei rounding surplus (from integer division) flows to taker by construction.
        // Do not add a makerExpected + 1 tolerance — this is intentional.

        // BL-N2: reject a dust leg — either buyer's collateral truncating to 0 would
        // mint them `fillAmount` outcome tokens for no payment. Symmetric with the
        // `_executeOperatorFill` SEC-003 guard.
        if (makerCollateral == 0 || takerCollateral == 0) revert Errors.ZeroAmount();

        // SCRUM-224: operator-supplied fees, validated against each buyer's per-party
        // collateral (the contract-derived cash value of their leg) and the admin-set
        // max rate. Both fees are paid on top of the collateral (not out of a payout),
        // so only the max-rate / cash-value bound applies.
        _validateFee(takerFee, takerCollateral, maxFeeRateBps);
        _validateFee(makerFee, makerCollateral, maxFeeRateBps);

        // Collect collateral from both buyers to Diamond
        IERC20(taker.collateralToken).safeTransferFrom(taker.maker, address(this), takerCollateral);
        IERC20(maker.collateralToken).safeTransferFrom(maker.maker, address(this), makerCollateral);

        // Collect fees
        if (takerFee > 0) {
            IERC20(taker.collateralToken).safeTransferFrom(taker.maker, feeReceiver, takerFee);
            emit Events.FeeCharged(feeReceiver, takerFee);
        }
        if (makerFee > 0) {
            IERC20(maker.collateralToken).safeTransferFrom(maker.maker, feeReceiver, makerFee);
            emit Events.FeeCharged(feeReceiver, makerFee);
        }

        // Split position: Diamond mints both outcome tokens to itself.
        // CPX-007 + GAS-002: shared with `_settleMerge` via {_conditionAndPartition}.
        (bytes32 conditionId, uint256[] memory partition) = _conditionAndPartition(taker.positionId, maker.positionId, ds);

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
        uint128 makerFee,
        uint256 unit,
        address feeReceiver,
        uint16 maxFeeRateBps,
        LibDoefinStorage.AppStorage storage ds
    ) internal {
        if (taker.collateralToken != maker.collateralToken) revert Errors.InvalidMatch();

        // BIZ-002: validate the crossing (taker's floor <= effective return = unit - P_m)
        // BEFORE any state mutation, mirroring `_settleMint`. Pre-fix the check ran after
        // the CTF burn — atomic revert still ensured no fund loss, but the effects-before-
        // checks ordering was inconsistent and harder to reason about.
        if (uint256(taker.pricePerToken) + uint256(maker.pricePerToken) > unit) revert Errors.InvalidMatch();

        // Maker receives their committed price; taker receives the complement (effective return = unit - P_m).
        // GAS-007: `fillAmount - makerPayout` is guarded by the crossing check above —
        // when `P_t + P_m <= unit`, `makerPayout = (P_m * fill) / unit <= fill`.
        // GAS-006: unchecked — `pricePerToken <= unit` (BIZ-004) bounds the product.
        uint256 makerPayout;
        unchecked { makerPayout = (uint256(maker.pricePerToken) * uint256(fillAmount)) / unit; }
        uint256 takerPayout;
        unchecked { takerPayout = uint256(fillAmount) - makerPayout; }
        // 1-wei rounding surplus (from integer division) flows to taker by construction.
        // Do not add a makerExpected + 1 tolerance — this is intentional.

        // BL-N2: reject a dust leg BEFORE any state mutation — either seller's payout
        // truncating to 0 would burn `fillAmount` of their position tokens for no
        // collateral return. Checked here (checks-before-effects, mirroring `_settleMint`
        // and the BIZ-002 crossing check) so the CTF burn is never reached on a
        // degenerate leg. Symmetric with the `_executeOperatorFill` SEC-003 guard.
        if (makerPayout == 0 || takerPayout == 0) revert Errors.ZeroAmount();

        // Collect position tokens from both sellers to Diamond
        LibERC1155.safeTransferFrom(address(this), taker.maker, address(this), uint256(taker.positionId), fillAmount, "");
        LibERC1155.safeTransferFrom(address(this), maker.maker, address(this), uint256(maker.positionId), fillAmount, "");

        // Merge positions: Diamond burns both outcome tokens, recovers collateral.
        // CPX-007 + GAS-002: shared with `_settleMint` via {_conditionAndPartition}.
        (bytes32 conditionId, uint256[] memory partition) = _conditionAndPartition(taker.positionId, maker.positionId, ds);

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

        // SCRUM-224: operator-supplied fees, validated against each seller's per-party
        // payout (the contract-derived cash value of their leg) and the admin-set max
        // rate. Each fee is deducted from that payout, so it is additionally bounded by
        // `fee <= proceeds` — this generalises and replaces the BIZ-001 checked-
        // subtraction guard: if a fee ever exceeds the payout the call reverts cleanly
        // instead of silently skipping a party's payout while still remitting the fee.
        _validateFee(takerFee, takerPayout, maxFeeRateBps);
        _validateFee(makerFee, makerPayout, maxFeeRateBps);
        if (takerFee > takerPayout || makerFee > makerPayout) revert Errors.FeeExceedsProceeds();

        uint256 takerNet;
        uint256 makerNet;
        unchecked {
            takerNet = takerPayout - takerFee;
            makerNet = makerPayout - makerFee;
        }
        IERC20(taker.collateralToken).safeTransfer(taker.maker, takerNet);
        IERC20(maker.collateralToken).safeTransfer(maker.maker, makerNet);

        // Send fees (single recipient, single transfer)
        uint256 totalFees = uint256(takerFee) + uint256(makerFee);
        if (totalFees > 0) {
            IERC20(taker.collateralToken).safeTransfer(feeReceiver, totalFees);
            emit Events.FeeCharged(feeReceiver, totalFees);
        }
    }

    /**
     * @dev Operator direct fill — operator is the counterparty
     * @dev SCRUM-224 — `fee` is operator-supplied. `_validateFee` enforces the admin-set
     *      max rate against the contract-derived `collateralAmount`; the explicit
     *      `fee > collateralAmount` check generalises and replaces the SEC-003
     *      `collateralAmount < fee` guard (the fee is deducted from `collateralAmount`,
     *      so it is bounded by those proceeds and the `collateralAmount - fee`
     *      subtraction cannot underflow).
     * @custom:security SEC-003 — `collateralAmount` is floored by integer division; when
     *      `price * fillAmount < unit` it truncates to 0, which would hand the maker free
     *      position tokens for no payment — still rejected by the `collateralAmount == 0`
     *      guard.
     */
    function _executeOperatorFill(
        LibDoefinOrder.DoefinOrder calldata order,
        uint128 fillAmount,
        uint128 fee,
        uint256 unit,
        address feeReceiver,
        uint16 maxFeeRateBps
    ) internal {
        // GAS-006: unchecked — `pricePerToken <= unit` (BIZ-004) bounds the product.
        uint256 collateralAmount;
        unchecked { collateralAmount = (uint256(order.pricePerToken) * uint256(fillAmount)) / unit; }

        // SEC-003: reject dust fills that round the collateral leg down to nothing.
        if (collateralAmount == 0) revert Errors.ZeroAmount();

        // SCRUM-224: validate the operator-supplied fee against the contract-derived
        // collateral leg and the admin-set max rate. The fee is paid out of
        // `collateralAmount`, so it must not exceed those proceeds.
        _validateFee(fee, collateralAmount, maxFeeRateBps);
        if (fee > collateralAmount) revert Errors.FeeExceedsProceeds();

        // GAS-007: `collateralAmount - fee` is guarded by the `fee > collateralAmount`
        // check above, so the subtraction cannot underflow.
        uint256 netCollateral;
        unchecked { netCollateral = collateralAmount - fee; }

        if (order.side == 0) {
            // Order is a buy: maker pays collateral to operator, operator gives position tokens
            IERC20(order.collateralToken).safeTransferFrom(order.maker, msg.sender, netCollateral);
            if (fee > 0) {
                IERC20(order.collateralToken).safeTransferFrom(order.maker, feeReceiver, fee);
                emit Events.FeeCharged(feeReceiver, fee);
            }
            // Operator transfers position tokens to maker
            LibERC1155.safeTransferFrom(address(this), msg.sender, order.maker, uint256(order.positionId), fillAmount, "");
        } else {
            // Order is a sell: maker gives position tokens, operator pays collateral
            LibERC1155.safeTransferFrom(address(this), order.maker, msg.sender, uint256(order.positionId), fillAmount, "");
            IERC20(order.collateralToken).safeTransferFrom(msg.sender, order.maker, netCollateral);
            if (fee > 0) {
                IERC20(order.collateralToken).safeTransferFrom(msg.sender, feeReceiver, fee);
                emit Events.FeeCharged(feeReceiver, fee);
            }
        }
    }

    // ========================================
    // INTERNAL: FEE VALIDATION
    // ========================================

    /**
     * @dev Validate an operator-supplied fee against the admin-set maximum rate.
     * @dev SCRUM-224 — replaces the old `_computeFee`. The operator supplies the fee
     *      amount; the contract decides whether it is legal. `cashValue` is always the
     *      contract-derived per-party collateral for the leg (price × fill, never an
     *      operator-asserted value).
     * @param fee The operator-supplied fee for this leg.
     * @param cashValue The contract-derived per-party collateral value of the leg.
     * @param maxFeeRateBps The admin-set maximum fee rate, hoisted once by the caller (GAS-003).
     * @custom:security Fail-closed — `maxFeeRateBps == 0` is NOT treated as "unlimited":
     *      it makes `maxAllowed` zero, so any non-zero fee reverts. This is a deliberate
     *      divergence from Polymarket CTF Exchange V2 (fail-closed is the safer posture).
     * @custom:reverts FeeExceedsMaxRate when `fee` exceeds `cashValue * maxFeeRateBps / 10000`.
     */
    function _validateFee(uint128 fee, uint256 cashValue, uint16 maxFeeRateBps) internal pure {
        if (fee == 0) return;
        uint256 maxAllowed = (cashValue * uint256(maxFeeRateBps)) / LibConstants.BPS_DENOMINATOR;
        if (uint256(fee) > maxAllowed) revert Errors.FeeExceedsMaxRate();
    }

    // ========================================
    // INTERNAL: HELPERS
    // ========================================

    /**
     * @dev Resolve the (conditionId, partition) pair for a binary-complement maker/taker
     *      match. Previously duplicated verbatim across `_settleMint` and `_settleMerge`
     *      (CPX-007 + GAS-002).
     * @param takerPositionId The taker's CTF position id.
     * @param makerPositionId The maker's CTF position id.
     * @param ds The shared AppStorage pointer (caller already resolves the namespace once
     *           per maker iteration to avoid re-SLOADing the registry root).
     * @return conditionId The CTF condition that both positions belong to.
     * @return partition A fresh memory array of length 2 with the matching index sets.
     */
    function _conditionAndPartition(
        bytes32 takerPositionId,
        bytes32 makerPositionId,
        LibDoefinStorage.AppStorage storage ds
    ) private view returns (bytes32 conditionId, uint256[] memory partition) {
        // `_determineMatchType` has already verified that both positions belong to the
        // same binary market, so neither lookup can be zero here.
        conditionId = ds.positionRegistry.conditionIdByPositionId[uint256(takerPositionId)];
        partition = new uint256[](2);
        partition[0] = _getIndexSetIn(takerPositionId, ds);
        partition[1] = _getIndexSetIn(makerPositionId, ds);
    }

    /**
     * @dev Extract the index set for a positionId from the CTF position registry.
     *      Takes a caller-resolved AppStorage pointer so the namespace is not
     *      re-resolved per partition slot.
     * @dev positionId = keccak256(collateralToken, collectionId), where collectionId
     *      encodes the indexSet via alt-bn128 EC arithmetic — it cannot be reversed,
     *      so we look it up in the registry populated during splitPosition.
     * @dev The "scan" is a linear walk over `meta.positionIds` whose length is always 2
     *      for binary markets (the only kind v3 currently routes through settlement),
     *      so the cost is bounded — but it is NOT O(1) (the pre-fix comment said so;
     *      corrected here per CPX-007).
     */
    function _getIndexSetIn(
        bytes32 positionId,
        LibDoefinStorage.AppStorage storage ds
    ) private view returns (uint256) {
        bytes32 marketKey = ds.positionRegistry.marketKeyByPositionId[uint256(positionId)];
        LibDoefinStorage.MarketMetadata storage meta = ds.positionRegistry.marketsByKey[marketKey];

        // Linear scan over the market's position slots (length 2 for binary markets).
        uint256 len = meta.positionIds.length;
        for (uint256 i; i < len;) {
            if (meta.positionIds[i] == uint256(positionId)) {
                return meta.partitions[i];
            }
            unchecked { ++i; }
        }
        revert Errors.InvalidPositionId();
    }
}
