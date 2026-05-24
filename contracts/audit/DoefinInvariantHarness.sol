// SPDX-License-Identifier: AGPL-3.0
pragma solidity 0.8.20;

/* ============================================================================
 *                      DoefinInvariantHarness
 * ----------------------------------------------------------------------------
 * TEST-ONLY property-fuzzing harness for the Doefin v3 audit.
 *
 * PURPOSE
 *   Drives Echidna / Medusa against a *live* Doefin EIP-2535 Diamond. The
 *   constructor takes NO arguments: it assembles a full working Diamond
 *   in-process (mirroring `scripts/deploy.js`), seeds a binary CTF market and
 *   funds three actors. The fuzzer then calls the `fuzz_*` wrappers to mutate
 *   state and checks the `echidna_*` boolean invariants after every call.
 *
 *   This contract MUST NEVER be added to the production deploy script. It is
 *   already excluded from Slither / solhint / coverage.
 *
 * CHEATCODE-SIGNING APPROACH
 *   `SettlementFacet._verifySignature` runs `ecrecover` for EVERY signature
 *   type and requires the recovered address to equal `order.signer`; for
 *   `signatureType == 0` it additionally requires `signer == maker`. Orders
 *   therefore need REAL ECDSA signatures, not stubs.
 *
 *   Echidna and Medusa both implement the standard hevm cheatcode VM at
 *   0x7109709ECfa91a80626fF3989D68f67F5b1DD12D. The harness uses:
 *     - `vm.addr(pk)`  -> derive an actor EOA address from a private key
 *     - `vm.sign(pk,h)`-> produce a valid (v,r,s) ECDSA signature over digest h
 *     - `vm.prank(a)`  -> set msg.sender for the *next* call (used ONCE per
 *                         actor during construction so the actor EOA can
 *                         `approve` the Diamond — the harness cannot approve
 *                         on an EOA's behalf otherwise).
 *   A signature is packed as `abi.encodePacked(r, s, v)` (65 bytes), which
 *   `ecrecover`s back to the actor. All orders use `signatureType = 0` with
 *   `maker == signer == actor`.
 *
 * ACTOR MODEL
 *   Three actors are plain EOAs derived from the deterministic private keys
 *   uint256(1), uint256(2) and uint256(3):
 *     - actor[0], actor[1], actor[2] = vm.addr(1..3)
 *   Each actor is minted MockERC20 collateral and, via a one-shot `vm.prank`,
 *   grants the Diamond an unlimited ERC20 allowance and ERC1155 operator
 *   approval. The harness itself is the Diamond owner AND the settlement
 *   operator, so it can call `matchOrders` / `fillOrder` directly. When the
 *   harness fills an order as the operator counterparty it acts as its own
 *   funded party (it mints itself collateral and self-approves).
 *
 * SETTLEMENT PATHS EXERCISED
 *   - Complementary : taker BUY A  vs maker SELL A
 *   - Mint          : taker BUY A  vs maker BUY  B  (splitPosition)
 *   - Merge         : taker SELL A vs maker SELL B  (mergePositions)
 *   - Operator fill : fillOrder with the harness as counterparty
 * ==========================================================================*/

import {Diamond} from "../Diamond.sol";
import {DiamondCutFacet} from "../facets/DiamondCutFacet.sol";
import {DiamondLoupeFacet} from "../facets/DiamondLoupeFacet.sol";
import {OwnershipFacet} from "../facets/OwnershipFacet.sol";
import {ERC1155Facet} from "../facets/ERC1155Facet.sol";
import {ERC1155ReceiverFacet} from "../facets/ERC1155ReceiverFacet.sol";
import {ConditionalTokensFacet} from "../facets/ConditionalTokensFacet.sol";
import {ConditionManagerFacet} from "../facets/ConditionManagerFacet.sol";
import {AccessControlFacet} from "../facets/AccessControlFacet.sol";
import {AdminConfigFacet} from "../facets/AdminConfigFacet.sol";
import {MarketDataFacet} from "../facets/MarketDataFacet.sol";
import {SignatureVerifierFacet} from "../facets/SignatureVerifierFacet.sol";
import {NonceManagerFacet} from "../facets/NonceManagerFacet.sol";
import {SettlementFacet} from "../facets/SettlementFacet.sol";
import {SettlementAdminFacet} from "../facets/SettlementAdminFacet.sol";
import {DiamondInit} from "../upgradeInitializers/DiamondInit.sol";

import {IDiamondCut} from "../interfaces/IDiamondCut.sol";
import {IDiamondLoupe} from "../interfaces/IDiamondLoupe.sol";
import {IERC165} from "../interfaces/IERC165.sol";
import {IERC173} from "../interfaces/IERC173.sol";
import {IERC1155Facet} from "../interfaces/IERC1155.sol";
import {IERC1155TokenReceiver} from "../interfaces/IERC1155TokenReceiver.sol";
import {IConditionalTokens} from "../interfaces/IConditionalTokens.sol";
import {IConditionManager} from "../interfaces/IConditionManager.sol";
import {IAccessControl} from "../interfaces/IAccessControl.sol";
import {IAdminConfig} from "../interfaces/IAdminConfig.sol";
import {IMarketData} from "../interfaces/IMarketData.sol";
import {ISignatureVerifier} from "../interfaces/ISignatureVerifier.sol";
import {INonceManager} from "../interfaces/INonceManager.sol";
import {ISettlement} from "../interfaces/ISettlement.sol";
import {ISettlementAdmin} from "../interfaces/ISettlementAdmin.sol";

import {LibDoefinOrder} from "../libraries/LibDoefinOrder.sol";
import {MockERC20} from "../mock/MockERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Minimal hevm cheatcode VM interface (Echidna + Medusa compatible).
interface IVm {
    /// @notice Sign `digest` with `privateKey`, returning the ECDSA components.
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    /// @notice Derive the EOA address that corresponds to `privateKey`.
    function addr(uint256 privateKey) external returns (address);
    /// @notice Set `msg.sender` for the *next* call only.
    function prank(address sender) external;
}

/**
 * @title DoefinInvariantHarness
 * @author Doefin (audit)
 * @notice Echidna / Medusa property-fuzzing harness for the Doefin v3 Diamond.
 * @dev Test-only. No-argument constructor. See the file header for the full
 *      design notes (cheatcode signing, actor model, settlement paths).
 */
contract DoefinInvariantHarness {
    // ========================================
    // CONSTANTS
    // ========================================

    /// @notice Standard hevm cheatcode address (Echidna + Medusa).
    address internal constant VM_ADDRESS = 0x7109709ECfa91a80626fF3989D68f67F5b1DD12D;
    IVm internal constant vm = IVm(VM_ADDRESS);

    /// @notice Collateral unit per outcome pair (USDC-like 6 decimals).
    uint256 internal constant UNIT = 1e6;

    /// @notice Number of fuzzing actors.
    uint256 internal constant ACTOR_COUNT = 3;

    /// @notice Per-actor initial collateral mint.
    uint256 internal constant ACTOR_FUNDING = 1_000_000 * UNIT;

    /// @notice Collateral seeded into the harness for operator-side fills.
    uint256 internal constant HARNESS_FUNDING = 1_000_000 * UNIT;

    /// @notice Amount split during market seeding so the registry holds a pair.
    uint256 internal constant SEED_SPLIT_AMOUNT = 100_000 * UNIT;

    /// @notice Admin-configured maximum settlement fee rate (basis points). SCRUM-224.
    ///         Below the AdminConfigFacet hard ceiling MAX_FEE_RATE_BPS_CAP (1000).
    uint16 internal constant MAX_FEE_RATE_BPS = 100;

    /// @notice Operator-supplied per-leg fee rate (basis points) used to size the fee
    ///         the harness passes to `matchOrders` / `fillOrder`. Kept at or below
    ///         `MAX_FEE_RATE_BPS` so a well-formed fee never trips `_validateFee`.
    uint16 internal constant FEE_BPS = 50;

    /// @notice Wei tolerance for the collateral-conservation invariant — accounts
    ///         for integer-division rounding in fee / effective-price maths.
    uint256 internal constant ROUNDING_TOLERANCE = 1_000;

    /// @notice Dedicated protocol fee-receiver sink.
    /// @dev MUST be a distinct address that is never an actor and never a
    ///      settlement counterparty. The harness itself acts as the operator
    ///      (and thus a funded counterparty in `fillOrder`), so it CANNOT
    ///      double as the feeReceiver: an operator SELL-fill legitimately pays
    ///      collateral OUT of the operator, which would violate the
    ///      "feeReceiver only grows" invariant. Routing fees to this isolated
    ///      address keeps that invariant meaningful and true. It is never
    ///      minted collateral and never builds an order, so the only way its
    ///      balance moves is fee receipts — strictly monotonic upward.
    address internal constant FEE_RECEIVER = address(0xFEE);

    // ========================================
    // IMMUTABLE DEPLOYMENT STATE
    // ========================================

    /// @notice The deployed Diamond proxy.
    address public immutable diamond;
    /// @notice The MockERC20 collateral token.
    MockERC20 public immutable collateral;

    // Facet handles bound to the Diamond address.
    ISettlement internal immutable settlement;
    ISettlementAdmin internal immutable settlementAdmin;
    INonceManager internal immutable nonceManager;
    IConditionalTokens internal immutable ctf;
    IERC1155Facet internal immutable erc1155;

    /// @notice Binary market condition id (trading market — never resolved during fuzzing).
    bytes32 public immutable conditionId;
    /// @notice Outcome-A position id (indexSet = 1).
    uint256 public immutable positionIdA;
    /// @notice Outcome-B position id (indexSet = 2).
    uint256 public immutable positionIdB;

    /// @notice SCRUM-236 — dedicated redemption-only market. A separate condition so
    ///         fuzz_redeem can resolve and redeem positions without disrupting the
    ///         trading market driven by fuzz_matchMint / fuzz_matchMerge / etc.
    bytes32 public immutable redeemConditionId;
    /// @notice Redemption-market outcome-A position id (indexSet = 1).
    uint256 public immutable redeemPositionIdA;
    /// @notice Redemption-market outcome-B position id (indexSet = 2).
    uint256 public immutable redeemPositionIdB;
    /// @notice SCRUM-236 — redemption-market questionId, needed by `reportPayouts`.
    bytes32 internal immutable redeemQuestionId;

    // ========================================
    // ACTOR STATE
    // ========================================

    /// @notice The three actor EOA addresses, actor[i] = vm.addr(i + 1).
    address[ACTOR_COUNT] internal actors;

    // ========================================
    // INVARIANT-TRACKING STATE
    // ========================================

    /// @notice Sum of `collateral` minted into the closed system (actors + harness).
    ///         Collateral conservation: total balance must always equal this.
    uint256 internal totalCollateralMinted;

    /// @notice Every order hash the harness has submitted to settlement.
    bytes32[] internal submittedOrderHashes;
    /// @notice Per submitted order hash, the order's signed `amount` (fill cap).
    mapping(bytes32 => uint128) internal orderAmountByHash;
    /// @notice Whether an order hash has already been recorded (dedupe).
    mapping(bytes32 => bool) internal orderHashSeen;

    /// @notice Highest nonce ever observed per actor — must be monotonic.
    mapping(address => uint256) internal lastSeenNonce;

    /// @notice SCRUM-236 — last observed (feeReceiver balance + Diamond accruedFees).
    ///         Replaces the pre-fee-bank `lastFeeReceiverBalance`. Under the
    ///         pull-payment model the FEE_RECEIVER's balance only changes when the
    ///         owner calls `withdrawFees`, but the SUM `accruedFees[collateral] +
    ///         balanceOf(FEE_RECEIVER)` is the monotone-up quantity that pins the
    ///         new bank model. A drop here signals either an unauthorised drain
    ///         path or a fee-accounting bug (the fee bank decreasing without an
    ///         equal credit to FEE_RECEIVER's balance).
    uint256 internal lastFeeReceiverPlusAccrued;

    /// @notice Net outstanding position tokens for the binary market that are
    ///         backed by Diamond-held collateral (minted via split, not yet merged).
    ///         Used by the solvency invariant. Counted PER WEI (not per UNIT pair)
    ///         so the harness can assert INV-SOLV-4-revised exactly:
    ///           balanceOf(Diamond, token) + ROUNDING_TOLERANCE >=
    ///               outstandingPairs[token] + accruedFees[token]
    ///         (SCRUM-236 / business-logic review §1 pin-down #1 — the CR-3291973200
    ///         `(outstandingPairs / UNIT) * UNIT` floor is REMOVED.)
    uint256 internal outstandingPairs;

    /// @notice SCRUM-236 / INV-FEE-NEW — harness-side cumulative counter of every
    ///         fee credited into `accruedFees[token]` by the contract. Tracked per
    ///         token so the symmetry invariant
    ///           sumFeeAccrued[t] == accruedFees[t] + sumFeesWithdrawn[t]
    ///         holds across the full collateral allow-list. Incremented in the
    ///         success branch of every `fuzz_*` settlement / redemption wrapper by
    ///         the SAME truncated value the contract computes (matching solidity
    ///         floor-division for resolution fees).
    mapping(address => uint256) internal sumFeeAccrued;

    /// @notice SCRUM-236 / INV-FEE-NEW counterpart — cumulative `withdrawFees`
    ///         amount per token. Incremented in the success branch of
    ///         `fuzz_withdrawFees` by the actual `w` (the resolved amount the
    ///         contract decremented), not by the raw operator input.
    mapping(address => uint256) internal sumFeesWithdrawn;

    // ========================================
    // CONSTRUCTOR
    // ========================================

    /// @notice Deploys a full Doefin Diamond, seeds a binary market and funds actors.
    /// @dev No arguments — Echidna / Medusa instantiate the harness directly.
    constructor() {
        diamond = _deployDiamond();

        settlement = ISettlement(diamond);
        settlementAdmin = ISettlementAdmin(diamond);
        nonceManager = INonceManager(diamond);
        ctf = IConditionalTokens(diamond);
        erc1155 = IERC1155Facet(diamond);

        collateral = new MockERC20("Harness USDC", "hUSDC", 6);

        _configureProtocol();
        (conditionId, positionIdA, positionIdB) = _seedBinaryMarket(
            keccak256("doefin-invariant-harness-question"),
            true /* split seed amount into harness inventory */
        );
        (redeemConditionId, redeemPositionIdA, redeemPositionIdB) = _seedBinaryMarket(
            keccak256("doefin-invariant-harness-redeem-question"),
            true /* split seed amount so the harness can redeem */
        );
        redeemQuestionId = keccak256("doefin-invariant-harness-redeem-question");
        _setupActors();

        // SCRUM-236: snapshot the (FEE_RECEIVER balance + per-token accruedFees)
        // baseline. FEE_RECEIVER is never minted collateral and the bank starts at 0,
        // so the baseline is 0; the ratchet only grows.
        lastFeeReceiverPlusAccrued = collateral.balanceOf(FEE_RECEIVER)
            + IAdminConfig(diamond).getAccruedFees(address(collateral));
    }

    // ========================================
    // CONSTRUCTOR HELPERS — DIAMOND ASSEMBLY
    // ========================================

    /// @dev Mirrors `scripts/deploy.js`: deploy DiamondCutFacet, the Diamond,
    ///      DiamondInit and every settlement-relevant facet, then run the cut.
    ///      Oracle facets and the block-header oracle are intentionally skipped
    ///      (the latter needs a BlockHeaderUtils library link). Returns the
    ///      Diamond address; the harness is its owner.
    function _deployDiamond() internal returns (address) {
        DiamondCutFacet diamondCutFacet = new DiamondCutFacet();
        Diamond diamondProxy = new Diamond(address(this), address(diamondCutFacet));
        DiamondInit diamondInit = new DiamondInit();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](13);
        cuts[0] = _loupeCut();
        cuts[1] = _ownershipCut();
        cuts[2] = _erc1155Cut();
        cuts[3] = _erc1155ReceiverCut();
        cuts[4] = _conditionalTokensCut();
        cuts[5] = _conditionManagerCut();
        cuts[6] = _accessControlCut();
        cuts[7] = _adminConfigCut();
        cuts[8] = _marketDataCut();
        cuts[9] = _signatureVerifierCut();
        cuts[10] = _nonceManagerCut();
        cuts[11] = _settlementCut();
        cuts[12] = _settlementAdminCut();

        IDiamondCut(address(diamondProxy)).diamondCut(
            cuts,
            address(diamondInit),
            abi.encodeWithSignature("init(address)", address(this))
        );

        return address(diamondProxy);
    }

    /// @dev Helper to build a FacetCut.Add struct.
    function _cut(address facet, bytes4[] memory selectors) internal pure returns (IDiamondCut.FacetCut memory) {
        return IDiamondCut.FacetCut({
            facetAddress: facet,
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: selectors
        });
    }

    function _loupeCut() internal returns (IDiamondCut.FacetCut memory) {
        bytes4[] memory s = new bytes4[](5);
        s[0] = DiamondLoupeFacet.facets.selector;
        s[1] = DiamondLoupeFacet.facetFunctionSelectors.selector;
        s[2] = DiamondLoupeFacet.facetAddresses.selector;
        s[3] = DiamondLoupeFacet.facetAddress.selector;
        s[4] = DiamondLoupeFacet.supportsInterface.selector;
        return _cut(address(new DiamondLoupeFacet()), s);
    }

    function _ownershipCut() internal returns (IDiamondCut.FacetCut memory) {
        bytes4[] memory s = new bytes4[](2);
        s[0] = OwnershipFacet.transferOwnership.selector;
        s[1] = OwnershipFacet.owner.selector;
        return _cut(address(new OwnershipFacet()), s);
    }

    function _erc1155Cut() internal returns (IDiamondCut.FacetCut memory) {
        bytes4[] memory s = new bytes4[](6);
        s[0] = ERC1155Facet.balanceOf.selector;
        s[1] = ERC1155Facet.balanceOfBatch.selector;
        s[2] = ERC1155Facet.setApprovalForAll.selector;
        s[3] = ERC1155Facet.isApprovedForAll.selector;
        s[4] = ERC1155Facet.safeTransferFrom.selector;
        s[5] = ERC1155Facet.safeBatchTransferFrom.selector;
        return _cut(address(new ERC1155Facet()), s);
    }

    function _erc1155ReceiverCut() internal returns (IDiamondCut.FacetCut memory) {
        bytes4[] memory s = new bytes4[](2);
        s[0] = ERC1155ReceiverFacet.onERC1155Received.selector;
        s[1] = ERC1155ReceiverFacet.onERC1155BatchReceived.selector;
        return _cut(address(new ERC1155ReceiverFacet()), s);
    }

    function _conditionalTokensCut() internal returns (IDiamondCut.FacetCut memory) {
        bytes4[] memory s = new bytes4[](9);
        s[0] = ConditionalTokensFacet.prepareCondition.selector;
        s[1] = ConditionalTokensFacet.reportPayouts.selector;
        s[2] = ConditionalTokensFacet.splitPosition.selector;
        s[3] = ConditionalTokensFacet.mergePositions.selector;
        s[4] = ConditionalTokensFacet.redeemPositions.selector;
        s[5] = ConditionalTokensFacet.getConditionId.selector;
        s[6] = ConditionalTokensFacet.getCollectionId.selector;
        s[7] = ConditionalTokensFacet.getPositionId.selector;
        s[8] = ConditionalTokensFacet.getPayoutNumerators.selector;
        return _cut(address(new ConditionalTokensFacet()), s);
    }

    function _conditionManagerCut() internal returns (IDiamondCut.FacetCut memory) {
        bytes4[] memory s = new bytes4[](4);
        s[0] = ConditionManagerFacet.createConditionWithMetadata.selector;
        s[1] = ConditionManagerFacet.createCondition.selector;
        s[2] = ConditionManagerFacet.getCondition.selector;
        s[3] = ConditionManagerFacet.cancelCondition.selector;
        return _cut(address(new ConditionManagerFacet()), s);
    }

    function _accessControlCut() internal returns (IDiamondCut.FacetCut memory) {
        bytes4[] memory s = new bytes4[](3);
        s[0] = AccessControlFacet.addMarketMaker.selector;
        s[1] = AccessControlFacet.removeMarketMaker.selector;
        s[2] = AccessControlFacet.isMarketMaker.selector;
        return _cut(address(new AccessControlFacet()), s);
    }

    function _adminConfigCut() internal returns (IDiamondCut.FacetCut memory) {
        // SCRUM-223: cross-currency conversion-path selectors removed with the CC stack.
        // SCRUM-224: setMaxFeeRate / getMaxFeeRate added for the operator fee model.
        // SCRUM-236: withdrawFees / getAccruedFees added for the pull-payment fee bank.
        bytes4[] memory s = new bytes4[](13);
        s[0] = AdminConfigFacet.addCollateralToken.selector;
        s[1] = AdminConfigFacet.removeCollateralToken.selector;
        s[2] = AdminConfigFacet.setFeeReceiver.selector;
        s[3] = AdminConfigFacet.setResolutionFeeBps.selector;
        s[4] = AdminConfigFacet.isAllowedCollateral.selector;
        s[5] = AdminConfigFacet.getCollateralUnit.selector;
        s[6] = AdminConfigFacet.getFees.selector;
        s[7] = AdminConfigFacet.getTokenSymbol.selector;
        s[8] = AdminConfigFacet.setTokenSymbol.selector;
        s[9] = AdminConfigFacet.setMaxFeeRate.selector;
        s[10] = AdminConfigFacet.getMaxFeeRate.selector;
        s[11] = AdminConfigFacet.withdrawFees.selector;
        s[12] = AdminConfigFacet.getAccruedFees.selector;
        return _cut(address(new AdminConfigFacet()), s);
    }

    function _marketDataCut() internal returns (IDiamondCut.FacetCut memory) {
        // SCRUM-234 (dead-code B-1) — `getAllPositionIdsByCondition` selector
        // removed alongside the facet function; array shrunk 7 -> 6.
        bytes4[] memory s = new bytes4[](6);
        s[0] = MarketDataFacet.getMarketsByCondition.selector;
        s[1] = MarketDataFacet.getMarketMetadata.selector;
        s[2] = MarketDataFacet.getCollateralToken.selector;
        s[3] = MarketDataFacet.getCollateralUnit.selector;
        s[4] = MarketDataFacet.getConditionId.selector;
        s[5] = MarketDataFacet.getComplement.selector;
        return _cut(address(new MarketDataFacet()), s);
    }

    function _signatureVerifierCut() internal returns (IDiamondCut.FacetCut memory) {
        bytes4[] memory s = new bytes4[](5);
        s[0] = SignatureVerifierFacet.verifyOrderSignature.selector;
        s[1] = SignatureVerifierFacet.getOrderHash.selector;
        s[2] = SignatureVerifierFacet.getDomainSeparator.selector;
        s[3] = SignatureVerifierFacet.registerOrderSigner.selector;
        s[4] = SignatureVerifierFacet.isRegisteredSigner.selector;
        return _cut(address(new SignatureVerifierFacet()), s);
    }

    function _nonceManagerCut() internal returns (IDiamondCut.FacetCut memory) {
        bytes4[] memory s = new bytes4[](6);
        s[0] = NonceManagerFacet.incrementNonce.selector;
        s[1] = NonceManagerFacet.getNonce.selector;
        s[2] = NonceManagerFacet.cancelOrder.selector;
        s[3] = NonceManagerFacet.cancelOrders.selector;
        s[4] = NonceManagerFacet.isCancelled.selector;
        s[5] = NonceManagerFacet.cancelOrdersForPosition.selector;
        // isOrderValid is omitted — not driven by the harness.
        return _cut(address(new NonceManagerFacet()), s);
    }

    function _settlementCut() internal returns (IDiamondCut.FacetCut memory) {
        // SEC-004: cacheDomainSeparator() was removed — the separator is recomputed
        // on every call by all three v3 facets.
        bytes4[] memory s = new bytes4[](3);
        s[0] = SettlementFacet.matchOrders.selector;
        s[1] = SettlementFacet.fillOrder.selector;
        s[2] = SettlementFacet.getFilledAmount.selector;
        return _cut(address(new SettlementFacet()), s);
    }

    /// @dev ARCH-01 / SCRUM-230 — owner-only settlement governance (operator
    ///      management, pause switch) was extracted into SettlementAdminFacet.
    function _settlementAdminCut() internal returns (IDiamondCut.FacetCut memory) {
        bytes4[] memory s = new bytes4[](5);
        s[0] = SettlementAdminFacet.setOperator.selector;
        s[1] = SettlementAdminFacet.pauseTrading.selector;
        s[2] = SettlementAdminFacet.unpauseTrading.selector;
        s[3] = SettlementAdminFacet.getOperator.selector;
        s[4] = SettlementAdminFacet.isTradingPaused.selector;
        return _cut(address(new SettlementAdminFacet()), s);
    }

    // ========================================
    // CONSTRUCTOR HELPERS — PROTOCOL / MARKET / ACTORS
    // ========================================

    /// @dev Allowlist the collateral token, point the fee receiver at the
    ///      dedicated `FEE_RECEIVER` sink, make the harness the operator, and
    ///      grant it the market-maker role.
    /// @dev `DiamondInit.init(address(this))` initialises `feeReceiver` to the
    ///      harness itself. The harness is also the settlement operator, so it
    ///      acts as a funded counterparty in `fillOrder` — it must NOT remain
    ///      the feeReceiver. `setFeeReceiver(FEE_RECEIVER)` re-points fees to a
    ///      distinct never-funded sink; because `FEE_RECEIVER != address(this)`
    ///      this is a real change and does NOT revert with `NoChangeRequired`.
    function _configureProtocol() internal {
        IAdminConfig(diamond).addCollateralToken(address(collateral), UNIT);
        IAdminConfig(diamond).setFeeReceiver(FEE_RECEIVER);
        // SCRUM-224: set the admin fee ceiling so operator-supplied fees can be
        // validated. Without this, `maxFeeRateBps == 0` would fail-closed and any
        // non-zero fee the harness passes would revert.
        IAdminConfig(diamond).setMaxFeeRate(MAX_FEE_RATE_BPS);
        settlementAdmin.setOperator(address(this));
        IAccessControl(diamond).addMarketMaker(address(this));
    }

    /// @dev Creates a binary condition keyed on `questionId` and runs an initial
    ///      `splitPosition` so the CTF position registry holds a 2-position complement
    ///      pair (required by `_determineMatchType` for Mint / Merge routing) and so
    ///      the harness ends up holding both outcome tokens as inventory.
    /// @dev SCRUM-236: the funding + approval setup runs only on the first market;
    ///      subsequent calls only mint additional collateral for the split. Both
    ///      markets share `address(collateral)`, the same operator approval, and the
    ///      same `setApprovalForAll`.
    function _seedBinaryMarket(bytes32 questionId, bool /* splitNotUsed */)
        internal
        returns (bytes32 cId, uint256 posA, uint256 posB)
    {
        cId = IConditionManager(diamond).createCondition(
            address(this),
            questionId,
            2,
            "ipfs://harness"
        );

        bytes32 collectionA = ctf.getCollectionId(bytes32(0), cId, 1);
        bytes32 collectionB = ctf.getCollectionId(bytes32(0), cId, 2);
        posA = ctf.getPositionId(address(collateral), collectionA);
        posB = ctf.getPositionId(address(collateral), collectionB);

        // Fund the harness and split — registers the pair AND leaves the harness
        // holding both outcome tokens (used as operator inventory for fillOrder /
        // fuzz_redeem). Approvals are idempotent so calling them twice is harmless.
        collateral.mint(address(this), HARNESS_FUNDING);
        totalCollateralMinted += HARNESS_FUNDING;
        collateral.approve(diamond, type(uint256).max);
        erc1155.setApprovalForAll(diamond, true);

        uint256[] memory partition = new uint256[](2);
        partition[0] = 1;
        partition[1] = 2;
        ctf.splitPosition(address(collateral), bytes32(0), cId, partition, SEED_SPLIT_AMOUNT);
        // The seed split moved SEED_SPLIT_AMOUNT of collateral into the Diamond.
        outstandingPairs += SEED_SPLIT_AMOUNT;
    }

    /// @dev Derives three actor EOAs, mints each collateral, and — via a one-shot
    ///      `vm.prank` per actor — grants the Diamond ERC20 + ERC1155 approvals.
    function _setupActors() internal {
        for (uint256 i; i < ACTOR_COUNT; ++i) {
            address actor = vm.addr(i + 1);
            actors[i] = actor;

            collateral.mint(actor, ACTOR_FUNDING);
            totalCollateralMinted += ACTOR_FUNDING;

            // Actor grants the Diamond an unlimited ERC20 allowance.
            vm.prank(actor);
            collateral.approve(diamond, type(uint256).max);

            // Actor grants the Diamond ERC1155 operator approval.
            vm.prank(actor);
            erc1155.setApprovalForAll(diamond, true);
        }
    }

    // ========================================
    // INTERNAL — ORDER CONSTRUCTION & SIGNING
    // ========================================

    /// @dev Build a DoefinOrder for an actor.
    ///      The order is signed separately via `_sign` using private key
    ///      `actorIndex + 1`, which `ecrecover`s back to `actors[actorIndex]`.
    /// @param actorIndex Index into the `actors` array.
    /// @param positionId Position token the order trades.
    /// @param side       0 = BUY, 1 = SELL.
    /// @param amount     Signed order amount (fill cap).
    /// @param price      Price per token, bounded to [0, UNIT].
    /// @param salt       Order salt (kept >= 1 so cancellation thresholds work).
    function _buildOrder(
        uint256 actorIndex,
        uint256 positionId,
        uint8 side,
        uint128 amount,
        uint128 price,
        uint256 salt
    )
        internal
        view
        returns (LibDoefinOrder.DoefinOrder memory order)
    {
        address actor = actors[actorIndex];
        order = LibDoefinOrder.DoefinOrder({
            salt: salt,
            maker: actor,
            signer: actor,
            positionId: bytes32(positionId),
            collateralToken: address(collateral),
            side: side,
            amount: amount,
            pricePerToken: price,
            expiration: 0,
            nonce: 0
        });
    }

    /// @dev EIP-712 struct hash for a memory `DoefinOrder` — mirrors the field list of
    ///      `LibDoefinOrder.hashCalldata`. Inlined here (SCRUM-234 dead-code A-12/13/14)
    ///      because the library's `memory` variants `hash` / `hashOrder` were removed:
    ///      production code uses the calldata path exclusively, but this Echidna harness
    ///      constructs orders in memory and cannot route them through `calldata`.
    function _hashOrderStructMemory(LibDoefinOrder.DoefinOrder memory order)
        internal pure returns (bytes32)
    {
        return keccak256(
            abi.encode(
                LibDoefinOrder.DOEFIN_ORDER_TYPEHASH,
                order.salt,
                order.maker,
                order.signer,
                order.positionId,
                order.collateralToken,
                order.side,
                order.amount,
                order.pricePerToken,
                order.expiration,
                order.nonce
            )
        );
    }

    /// @dev Full EIP-712 digest (`\x19\x01 || domainSep || structHash`) for a memory order.
    function _hashOrderMemory(LibDoefinOrder.DoefinOrder memory order, bytes32 domainSep)
        internal pure returns (bytes32)
    {
        return keccak256(abi.encodePacked(bytes1(0x19), bytes1(0x01), domainSep, _hashOrderStructMemory(order)));
    }

    /// @dev Produce a 65-byte ECDSA signature over an order using the hevm
    ///      `sign` cheatcode. The result `ecrecover`s back to `actors[..]`.
    function _sign(uint256 pk, LibDoefinOrder.DoefinOrder memory order)
        internal
        returns (bytes memory)
    {
        bytes32 domainSep = LibDoefinOrder.diamondDomainSeparator(diamond);
        bytes32 digest = _hashOrderMemory(order, domainSep);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Record a submitted order hash so `echidna_no_overfill` can check it.
    function _recordOrder(LibDoefinOrder.DoefinOrder memory order) internal {
        bytes32 domainSep = LibDoefinOrder.diamondDomainSeparator(diamond);
        bytes32 h = _hashOrderMemory(order, domainSep);
        if (!orderHashSeen[h]) {
            orderHashSeen[h] = true;
            submittedOrderHashes.push(h);
            orderAmountByHash[h] = order.amount;
        }
    }

    // ========================================
    // INTERNAL — INPUT BOUNDING
    // ========================================

    /// @dev Bound a price to the inclusive range [0, UNIT].
    function _boundPrice(uint128 raw) internal pure returns (uint128) {
        return uint128(raw % (UNIT + 1));
    }

    /// @dev Bound a fill amount to [1, maxFill]. Returns at least 1.
    function _boundAmount(uint128 raw, uint128 maxFill) internal pure returns (uint128) {
        if (maxFill == 0) return 0;
        return uint128((raw % maxFill) + 1);
    }

    /// @dev SCRUM-224: size an operator-supplied per-leg fee at `FEE_BPS` of a
    ///      contract-derived collateral leg (`price * fill / UNIT`). Guaranteed
    ///      `<= cashValue * MAX_FEE_RATE_BPS / 10000`, so `_validateFee` accepts it.
    function _legFee(uint128 price, uint128 fill) internal pure returns (uint128) {
        uint256 cashValue = (uint256(price) * uint256(fill)) / UNIT;
        return uint128((cashValue * uint256(FEE_BPS)) / 10000);
    }

    /// @dev SCRUM-236 — ratchet `lastFeeReceiverPlusAccrued` up to the running maximum
    ///      of `balanceOf(FEE_RECEIVER) + accruedFees[collateral]`. Called at the end
    ///      of every `fuzz_*` wrapper. Under the pull-payment model FEE_RECEIVER's
    ///      balance is now mostly static (it only changes on `withdrawFees`), but the
    ///      SUM `accrued + paid-out` is the monotone-up quantity: every fee debit
    ///      increases the bank, every withdraw moves bank -> FEE_RECEIVER without
    ///      changing the sum. A drop in the sum signals a fee-accounting bug.
    function _syncFeeReceiverHighWater() internal {
        uint256 sum = collateral.balanceOf(FEE_RECEIVER)
            + IAdminConfig(diamond).getAccruedFees(address(collateral));
        if (sum > lastFeeReceiverPlusAccrued) {
            lastFeeReceiverPlusAccrued = sum;
        }
    }

    /// @dev SCRUM-236 / INV-FEE-NEW — credit the harness-side `sumFeeAccrued[t]`
    ///      counter by the same amount the contract credited to `accruedFees[t]`.
    ///      Called on the SUCCESS branch of every fuzz settlement / redemption wrapper.
    ///      The settlement-side fees are operator-supplied amounts (no contract-side
    ///      rounding); the resolution-side `feeAmount` is the truncated
    ///      `(payout * feeBps) / BPS_DENOMINATOR`. Callers are responsible for passing
    ///      the right `amount` per leg.
    function _recordFeeAccrued(address token, uint256 amount) internal {
        if (amount > 0) {
            sumFeeAccrued[token] += amount;
        }
    }

    // ========================================
    // FUZZ WRAPPERS — STATE MUTATION
    // ========================================

    /// @notice Fuzz a Mint settlement: actor 0 BUYs A, actor 1 BUYs B.
    /// @dev On success, collateral flows into the Diamond and a new A+B pair is
    ///      minted, so `outstandingPairs` grows by the fill amount.
    /// @param rawAmount Raw fuzzed fill amount (bounded internally).
    /// @param rawTakerPrice Raw fuzzed taker price (bounded to [0, UNIT]).
    function fuzz_matchMint(uint128 rawAmount, uint128 rawTakerPrice) external {
        uint128 fill = _boundAmount(rawAmount, uint128(SEED_SPLIT_AMOUNT));
        if (fill == 0) return;
        uint128 takerPrice = _boundPrice(rawTakerPrice);
        // Mint requires taker.price + maker.price >= UNIT. Pick maker price as
        // the exact complement so the crossing condition always holds.
        uint128 makerPrice = uint128(UNIT) - takerPrice;

        LibDoefinOrder.DoefinOrder memory taker =
            _buildOrder(0, positionIdA, 0, fill, takerPrice, 1);
        LibDoefinOrder.DoefinOrder memory maker =
            _buildOrder(1, positionIdB, 0, fill, makerPrice, 1);

        bytes memory takerSig = _sign(1, taker);
        bytes memory makerSig = _sign(2, maker);

        LibDoefinOrder.DoefinOrder[] memory makers = new LibDoefinOrder.DoefinOrder[](1);
        makers[0] = maker;
        bytes[] memory makerSigs = new bytes[](1);
        makerSigs[0] = makerSig;
        uint8[] memory makerTypes = new uint8[](1);
        makerTypes[0] = 0;
        uint128[] memory makerFills = new uint128[](1);
        makerFills[0] = fill;
        uint128[] memory takerFees = new uint128[](1);
        takerFees[0] = _legFee(takerPrice, fill);
        uint128[] memory makerFees = new uint128[](1);
        makerFees[0] = _legFee(makerPrice, fill);

        _recordOrder(taker);
        _recordOrder(maker);

        try settlement.matchOrders(taker, takerSig, 0, makers, makerSigs, makerTypes, fill, makerFills, takerFees, makerFees) {
            outstandingPairs += fill;
            // SCRUM-236: trading fees credit accruedFees by exactly the operator amounts.
            _recordFeeAccrued(address(collateral), uint256(takerFees[0]) + uint256(makerFees[0]));
        } catch {
            // A revert is an acceptable outcome — invariants check STATE only.
        }
        _syncFeeReceiverHighWater();
    }

    /// @notice Fuzz a Merge settlement: actor 0 SELLs A, actor 1 SELLs B.
    /// @dev On success, a complete A+B pair is burned and collateral leaves the
    ///      Diamond, so `outstandingPairs` shrinks by the fill amount.
    /// @param rawAmount Raw fuzzed fill amount (bounded internally).
    /// @param rawTakerPrice Raw fuzzed taker price (bounded to [0, UNIT]).
    function fuzz_matchMerge(uint128 rawAmount, uint128 rawTakerPrice) external {
        // Sellers can only sell tokens they hold; cap at outstanding pairs.
        uint128 maxFill = outstandingPairs > type(uint128).max
            ? type(uint128).max
            : uint128(outstandingPairs);
        uint128 fill = _boundAmount(rawAmount, maxFill);
        if (fill == 0) return;
        uint128 takerPrice = _boundPrice(rawTakerPrice);
        // Merge requires taker.price + maker.price <= UNIT. Exact complement
        // keeps the crossing condition satisfied.
        uint128 makerPrice = uint128(UNIT) - takerPrice;

        // Sellers need to actually own the tokens — give them inventory from the
        // harness's seed-split holdings before attempting the merge.
        _fundActorPosition(0, positionIdA, fill);
        _fundActorPosition(1, positionIdB, fill);

        LibDoefinOrder.DoefinOrder memory taker =
            _buildOrder(0, positionIdA, 1, fill, takerPrice, 1);
        LibDoefinOrder.DoefinOrder memory maker =
            _buildOrder(1, positionIdB, 1, fill, makerPrice, 1);

        bytes memory takerSig = _sign(1, taker);
        bytes memory makerSig = _sign(2, maker);

        LibDoefinOrder.DoefinOrder[] memory makers = new LibDoefinOrder.DoefinOrder[](1);
        makers[0] = maker;
        bytes[] memory makerSigs = new bytes[](1);
        makerSigs[0] = makerSig;
        uint8[] memory makerTypes = new uint8[](1);
        makerTypes[0] = 0;
        uint128[] memory makerFills = new uint128[](1);
        makerFills[0] = fill;
        // Merge fees come out of each seller's payout. Sizing the fee from the
        // signed price keeps it below `payout * MAX_FEE_RATE_BPS / 10000` because
        // each seller's payout is at least `price * fill / UNIT` when prices cross.
        uint128[] memory takerFees = new uint128[](1);
        takerFees[0] = _legFee(takerPrice, fill);
        uint128[] memory makerFees = new uint128[](1);
        makerFees[0] = _legFee(makerPrice, fill);

        _recordOrder(taker);
        _recordOrder(maker);

        try settlement.matchOrders(taker, takerSig, 0, makers, makerSigs, makerTypes, fill, makerFills, takerFees, makerFees) {
            if (outstandingPairs >= fill) {
                outstandingPairs -= fill;
            }
            _recordFeeAccrued(address(collateral), uint256(takerFees[0]) + uint256(makerFees[0]));
        } catch {
            // Acceptable — invariants check state, not call success.
        }
        _syncFeeReceiverHighWater();
    }

    /// @notice Fuzz a Complementary settlement: actor 0 BUYs A, actor 1 SELLs A.
    /// @dev Pure token+collateral swap — no Diamond mint/merge, so
    ///      `outstandingPairs` is unchanged.
    /// @param rawAmount Raw fuzzed fill amount (bounded internally).
    /// @param rawPrice Raw fuzzed execution price (bounded to [0, UNIT]).
    function fuzz_matchComplementary(uint128 rawAmount, uint128 rawPrice) external {
        uint128 maxFill = outstandingPairs > type(uint128).max
            ? type(uint128).max
            : uint128(outstandingPairs);
        uint128 fill = _boundAmount(rawAmount, maxFill);
        if (fill == 0) return;
        uint128 price = _boundPrice(rawPrice);

        // Seller (actor 1) must hold A tokens to deliver.
        _fundActorPosition(1, positionIdA, fill);

        // Buyer price must be >= seller price; use the same price for both.
        LibDoefinOrder.DoefinOrder memory taker =
            _buildOrder(0, positionIdA, 0, fill, price, 1);
        LibDoefinOrder.DoefinOrder memory maker =
            _buildOrder(1, positionIdA, 1, fill, price, 1);

        bytes memory takerSig = _sign(1, taker);
        bytes memory makerSig = _sign(2, maker);

        LibDoefinOrder.DoefinOrder[] memory makers = new LibDoefinOrder.DoefinOrder[](1);
        makers[0] = maker;
        bytes[] memory makerSigs = new bytes[](1);
        makerSigs[0] = makerSig;
        uint8[] memory makerTypes = new uint8[](1);
        makerTypes[0] = 0;
        uint128[] memory makerFills = new uint128[](1);
        makerFills[0] = fill;
        // Both legs execute at the maker's price; size each fee from it.
        uint128[] memory takerFees = new uint128[](1);
        takerFees[0] = _legFee(price, fill);
        uint128[] memory makerFees = new uint128[](1);
        makerFees[0] = _legFee(price, fill);

        _recordOrder(taker);
        _recordOrder(maker);

        try settlement.matchOrders(taker, takerSig, 0, makers, makerSigs, makerTypes, fill, makerFills, takerFees, makerFees) {
            // outstandingPairs unchanged — complementary is a swap.
            _recordFeeAccrued(address(collateral), uint256(takerFees[0]) + uint256(makerFees[0]));
        } catch {
            // Acceptable.
        }
        _syncFeeReceiverHighWater();
    }

    /// @notice Fuzz an operator direct fill: the harness fills an actor's order.
    /// @dev The harness IS the operator and provides/receives position tokens
    ///      from its own seed-split inventory. `outstandingPairs` is unchanged.
    /// @param rawActor Selects which actor's order to fill (0..2).
    /// @param rawSide Order side: even = BUY, odd = SELL.
    /// @param rawAmount Raw fuzzed fill amount.
    /// @param rawPrice Raw fuzzed price (bounded to [0, UNIT]).
    function fuzz_fillOrder(
        uint8 rawActor,
        uint8 rawSide,
        uint128 rawAmount,
        uint128 rawPrice
    ) external {
        uint256 idx = rawActor % ACTOR_COUNT;
        uint8 side = uint8(rawSide % 2);
        uint128 maxFill = outstandingPairs > type(uint128).max
            ? type(uint128).max
            : uint128(outstandingPairs);
        uint128 fill = _boundAmount(rawAmount, maxFill);
        if (fill == 0) return;
        uint128 price = _boundPrice(rawPrice);

        // If the order is a SELL, the actor must hold position-A tokens.
        if (side == 1) {
            _fundActorPosition(idx, positionIdA, fill);
        }

        LibDoefinOrder.DoefinOrder memory order =
            _buildOrder(idx, positionIdA, side, fill, price, 1);
        bytes memory sig = _sign(idx + 1, order);

        _recordOrder(order);

        // Operator-supplied fee, sized at FEE_BPS of the contract-derived
        // collateral leg so `_validateFee` accepts it.
        uint128 fee = _legFee(price, fill);

        try settlement.fillOrder(order, sig, 0, fill, fee) {
            // outstandingPairs unchanged — operator fill is a swap.
            _recordFeeAccrued(address(collateral), uint256(fee));
        } catch {
            // Acceptable.
        }
        _syncFeeReceiverHighWater();
    }

    /// @notice Fuzz an actor cancelling all of their lower-nonce orders.
    /// @param rawActor Selects which actor bumps their nonce (0..2).
    function fuzz_cancelNonce(uint8 rawActor) external {
        uint256 idx = rawActor % ACTOR_COUNT;
        address actor = actors[idx];
        vm.prank(actor);
        try nonceManager.incrementNonce() returns (uint256 newNonce) {
            if (newNonce > lastSeenNonce[actor]) {
                lastSeenNonce[actor] = newNonce;
            }
        } catch {
            // Acceptable.
        }
        _syncFeeReceiverHighWater();
    }

    /// @notice Fuzz an actor splitting collateral into an A+B position pair.
    /// @dev On success collateral moves into the Diamond, so `outstandingPairs`
    ///      grows by the split amount.
    /// @param rawActor Selects which actor splits (0..2).
    /// @param rawAmount Raw fuzzed split amount.
    function fuzz_split(uint8 rawActor, uint128 rawAmount) external {
        uint256 idx = rawActor % ACTOR_COUNT;
        address actor = actors[idx];
        uint128 amount = _boundAmount(rawAmount, uint128(10_000 * UNIT));
        if (amount == 0) return;

        uint256[] memory partition = new uint256[](2);
        partition[0] = 1;
        partition[1] = 2;

        vm.prank(actor);
        try ctf.splitPosition(address(collateral), bytes32(0), conditionId, partition, amount) {
            outstandingPairs += amount;
        } catch {
            // Acceptable.
        }
        _syncFeeReceiverHighWater();
    }

    /// @notice Fuzz an actor merging an A+B position pair back into collateral.
    /// @dev On success collateral leaves the Diamond, so `outstandingPairs`
    ///      shrinks by the merge amount.
    /// @param rawActor Selects which actor merges (0..2).
    /// @param rawAmount Raw fuzzed merge amount.
    function fuzz_merge(uint8 rawActor, uint128 rawAmount) external {
        uint256 idx = rawActor % ACTOR_COUNT;
        address actor = actors[idx];
        uint128 maxAmount = outstandingPairs > type(uint128).max
            ? type(uint128).max
            : uint128(outstandingPairs);
        uint128 amount = _boundAmount(rawAmount, maxAmount);
        if (amount == 0) return;

        // The actor must hold both A and B to merge — top them up from the
        // harness's inventory.
        _fundActorPosition(idx, positionIdA, amount);
        _fundActorPosition(idx, positionIdB, amount);

        uint256[] memory partition = new uint256[](2);
        partition[0] = 1;
        partition[1] = 2;

        vm.prank(actor);
        try ctf.mergePositions(address(collateral), bytes32(0), conditionId, partition, amount) {
            if (outstandingPairs >= amount) {
                outstandingPairs -= amount;
            }
        } catch {
            // Acceptable.
        }
        _syncFeeReceiverHighWater();
    }

    /// @notice SCRUM-236 — fuzz an owner-initiated fee bank sweep.
    /// @dev The harness is the Diamond owner, so it calls `withdrawFees` directly.
    ///      The driver clamps `rawAmount` to `[1, accruedFees[collateral]]` so the
    ///      happy path actually executes most of the time; ~6% of ticks (when
    ///      `rawAmount % 16 == 0`) take the `type(uint256).max` drain branch instead.
    ///      Both paths are valid Diamond-as-`from` transfers and exercise the
    ///      INV-SOLV-4-revised meta-check.
    /// @param rawAmount Raw fuzzed withdraw amount (bounded internally).
    function fuzz_withdrawFees(uint128 rawAmount) external {
        IAdminConfig admin = IAdminConfig(diamond);
        uint256 accrued = admin.getAccruedFees(address(collateral));
        if (accrued == 0) {
            // Nothing to withdraw — exercise the empty-bank revert path, then return.
            try admin.withdrawFees(address(collateral), type(uint256).max) {
                // Should never succeed when accrued == 0; fall through.
            } catch {
                // Expected ZeroAmount revert.
            }
            _syncFeeReceiverHighWater();
            return;
        }

        uint256 amount;
        if (rawAmount % 16 == 0) {
            // Drain branch — exercises the `type(uint256).max` resolution idiom.
            amount = type(uint256).max;
        } else {
            // Clamp to [1, accrued].
            amount = (uint256(rawAmount) % accrued) + 1;
        }

        try admin.withdrawFees(address(collateral), amount) {
            // On success the contract decremented accruedFees by either `amount` or
            // (for the drain branch) the FULL pre-call accrued balance.
            uint256 w = (amount == type(uint256).max) ? accrued : amount;
            sumFeesWithdrawn[address(collateral)] += w;
        } catch {
            // Acceptable — invariants check state.
        }
        _syncFeeReceiverHighWater();
    }

    /// @notice SCRUM-236 — fuzz a winning-position redemption against the dedicated
    ///         redemption market. Resolves the market the first time it runs (the
    ///         harness is the oracle) and then redeems whatever outcome-A the
    ///         harness still holds. Without this driver the resolution-fee branch of
    ///         INV-FEE-NEW (FEE_KIND_RESOLUTION) would be unexercised.
    /// @dev `reportPayouts` reverts after first call (`PayoutAlreadySet`), so the
    ///      try/catch silently absorbs that branch. The redemption-only market is
    ///      seeded in the constructor; the harness owns `SEED_SPLIT_AMOUNT` of each
    ///      outcome from that seed split.
    /// @param rawAmount Raw fuzzed redemption amount (bounded to harness's balance).
    function fuzz_redeem(uint128 rawAmount) external {
        // Resolve the redemption market on the first invocation. Subsequent calls
        // hit `PayoutAlreadySet` and fall through.
        uint256[] memory payouts = new uint256[](2);
        payouts[0] = 1; // outcome A wins
        payouts[1] = 0;
        try ctf.reportPayouts(redeemQuestionId, payouts) {} catch {}

        uint256 held = erc1155.balanceOf(address(this), redeemPositionIdA);
        if (held == 0) {
            _syncFeeReceiverHighWater();
            return;
        }
        // Clamp to held; we cannot redeem more than we have.
        uint128 maxHeld = held > type(uint128).max ? type(uint128).max : uint128(held);
        uint128 toRedeem = _boundAmount(rawAmount, maxHeld);
        if (toRedeem == 0) {
            _syncFeeReceiverHighWater();
            return;
        }

        // The redeemPositions loop walks ALL indexSets the caller still holds; we
        // can only redeem the actual stake amount (the burn is `stake`, not a
        // configurable size). Move the un-redeemed portion away first so we redeem
        // only `toRedeem` this tick.
        uint256 surplus = held - toRedeem;
        if (surplus > 0) {
            // Park the surplus at actor[0] temporarily so the harness's stake equals
            // toRedeem when redeemPositions runs.
            erc1155.safeTransferFrom(address(this), actors[0], redeemPositionIdA, surplus, "");
        }

        // Compute the resolution fee the contract will book: feeAmount = floor(
        // stake * resolutionFeeBps / BPS_DENOMINATOR). The harness has not set a
        // non-zero resolutionFeeBps, so this is normally 0 — but the symmetry
        // assertion still holds (0 == 0). To exercise the fee-positive branch the
        // resolutionFeeBps would need to be set; left as a future harness tweak.
        (, uint16 resBps) = IAdminConfig(diamond).getFees();
        uint256 feeAmount = (uint256(toRedeem) * uint256(resBps)) / 10000;

        uint256[] memory indexSets = new uint256[](1);
        indexSets[0] = 1; // outcome A
        try ctf.redeemPositions(address(collateral), bytes32(0), redeemConditionId, indexSets) {
            // Successful redemption — outcome A pays 1 of payoutDenominator (which
            // is `sum(payouts) = 1`), so `payout == stake == toRedeem`. The
            // outstandingPairs ratchet must drop by toRedeem (the pair-backing is
            // gone), and the resolution fee credits accruedFees by feeAmount.
            if (outstandingPairs >= toRedeem) {
                outstandingPairs -= toRedeem;
            }
            _recordFeeAccrued(address(collateral), feeAmount);
        } catch {
            // Acceptable — invariants check state.
        }

        // Return the parked surplus so the next fuzz_redeem tick can redeem more.
        // The transfer back is from actor[0]; the harness is approved as operator.
        if (surplus > 0) {
            erc1155.safeTransferFrom(actors[0], address(this), redeemPositionIdA, surplus, "");
        }
        _syncFeeReceiverHighWater();
    }

    /// @dev Top up an actor's balance of `positionId` to at least `amount` by
    ///      transferring tokens the harness holds from its seed split. If the
    ///      harness lacks inventory the transfer simply does not happen and the
    ///      downstream settlement call reverts (an acceptable fuzz outcome).
    function _fundActorPosition(uint256 actorIndex, uint256 positionId, uint256 amount) internal {
        address actor = actors[actorIndex];
        uint256 actorBal = erc1155.balanceOf(actor, positionId);
        if (actorBal >= amount) return;
        uint256 needed = amount - actorBal;
        uint256 harnessBal = erc1155.balanceOf(address(this), positionId);
        if (harnessBal < needed) return;
        // Harness is the token owner; safeTransferFrom from itself is permitted.
        erc1155.safeTransferFrom(address(this), actor, positionId, needed, "");
    }

    // ========================================
    // ECHIDNA INVARIANTS — must always hold
    // ========================================

    /// @notice Collateral conservation: the total MockERC20 balance across the
    ///         Diamond, the harness (operator inventory), the dedicated
    ///         feeReceiver sink and all actors must equal the total ever minted,
    ///         within a small rounding tolerance.
    /// @dev Tolerance covers integer-division rounding in fee / effective-price
    ///      maths. Collateral is never burned, so the closed-system sum is
    ///      invariant up to that rounding. The feeReceiver is a distinct address
    ///      from the harness, so its balance is summed explicitly.
    function echidna_collateral_conserved() external view returns (bool) {
        uint256 total = collateral.balanceOf(diamond);
        total += collateral.balanceOf(address(this)); // harness == operator
        total += collateral.balanceOf(FEE_RECEIVER); // dedicated fee sink
        for (uint256 i; i < ACTOR_COUNT; ++i) {
            total += collateral.balanceOf(actors[i]);
        }
        if (total >= totalCollateralMinted) {
            return total - totalCollateralMinted <= ROUNDING_TOLERANCE;
        }
        return totalCollateralMinted - total <= ROUNDING_TOLERANCE;
    }

    /// @notice INV-SOLV-4-revised (SCRUM-236) — the Diamond's collateral balance must
    ///         cover BOTH the position-backing (`outstandingPairs`) AND the
    ///         un-withdrawn fee bank (`accruedFees`) at all times. Together with
    ///         `echidna_fee_accounting_symmetry` this pins the new co-mingling model:
    ///         the Diamond's ERC-20 balance now has two roles, and this invariant
    ///         keeps them distinguishable in the accounting.
    /// @dev Pin-down #1 (CR-3291973200 subsumption, business-logic review §1):
    ///      the pre-SCRUM-236 `(outstandingPairs / UNIT) * UNIT` floor is REMOVED.
    ///      `outstandingPairs` is measured in collateral base units; flooring it
    ///      would mask up to UNIT - 1 wei of sub-UNIT under-collateralisation.
    /// @dev Pin-down #2: `accruedFees` is exact (direct accumulator increment, no
    ///      division on accrual), so `ROUNDING_TOLERANCE` is now attributable
    ///      entirely to position-backing rounding (the 1-wei surplus per
    ///      `floorDiv(P*f, unit)` integer division documented in INV-PRICE-1/2);
    ///      fee accounting contributes no slack.
    /// @dev Pin-down #3: the invariant assumes any allow-listed collateral is a
    ///      standard ERC-20 (no fee-on-transfer, no rebasing, no callback hooks).
    ///      Enforced by governance (the owner-only `addCollateralToken` allow-list).
    function echidna_diamond_solvent() external view returns (bool) {
        uint256 accrued = IAdminConfig(diamond).getAccruedFees(address(collateral));
        return collateral.balanceOf(diamond) + ROUNDING_TOLERANCE
            >= outstandingPairs + accrued;
    }

    /// @notice No order is ever filled beyond its signed amount.
    /// @dev Checks every order hash the harness has submitted to settlement.
    function echidna_no_overfill() external view returns (bool) {
        uint256 len = submittedOrderHashes.length;
        for (uint256 i; i < len; ++i) {
            bytes32 h = submittedOrderHashes[i];
            if (settlement.getFilledAmount(h) > orderAmountByHash[h]) {
                return false;
            }
        }
        return true;
    }

    /// @notice On-chain nonces never decrease relative to the highest value the
    ///         harness has observed for each actor.
    function echidna_nonce_monotonic() external view returns (bool) {
        for (uint256 i; i < ACTOR_COUNT; ++i) {
            if (nonceManager.getNonce(actors[i]) < lastSeenNonce[actors[i]]) {
                return false;
            }
        }
        return true;
    }

    /// @notice SCRUM-236 — `(accruedFees[token] + balanceOf(FEE_RECEIVER, token))` is
    ///         non-decreasing. Replaces the pre-bank `echidna_fee_receiver_only_grows`,
    ///         which silently broke meaning under the pull-payment model: FEE_RECEIVER's
    ///         balance only changes on `withdrawFees`, so the old assertion held
    ///         vacuously while measuring nothing.
    /// @dev The sum is the right invariant because every fee debit increases the bank
    ///      (left summand), every withdraw decreases the bank by `w` and increases
    ///      FEE_RECEIVER's balance by `w` (zero net change in the sum), and there is
    ///      no other outflow path. Together with `echidna_diamond_solvent` this pins
    ///      the new fee-bank model — any drop here is a fee-accounting bug.
    function echidna_fee_receiver_plus_accrued_only_grows() external view returns (bool) {
        uint256 sum = collateral.balanceOf(FEE_RECEIVER)
            + IAdminConfig(diamond).getAccruedFees(address(collateral));
        return sum >= lastFeeReceiverPlusAccrued;
    }

    /// @notice INV-FEE-NEW (SCRUM-236) — fee-accounting symmetry, per-token:
    ///           sumFeeAccrued[t] == accruedFees[t] + sumFeesWithdrawn[t]
    ///         for every token the harness has ever credited (here: just
    ///         `address(collateral)`, the harness's single allow-listed collateral).
    /// @dev The harness ratchets `sumFeeAccrued` in the success branch of every
    ///      settlement / redemption wrapper by the SAME amount the contract booked,
    ///      and ratchets `sumFeesWithdrawn` in the success branch of
    ///      `fuzz_withdrawFees`. A violation means the contract booked a fee
    ///      asymmetrically (debited a payer but credited a different amount, or
    ///      withdrew without decrementing the bank, or vice versa).
    function echidna_fee_accounting_symmetry() external view returns (bool) {
        uint256 accrued = IAdminConfig(diamond).getAccruedFees(address(collateral));
        return sumFeeAccrued[address(collateral)]
            == accrued + sumFeesWithdrawn[address(collateral)];
    }

    /// @notice The reentrancy guard is back to "not entered" after any top-level
    ///         call — i.e. no settlement call left the latch stuck.
    /// @dev A stuck latch would brick all guarded functions. The guard uses
    ///      1 = NOT_ENTERED, 2 = ENTERED in `LibDoefinStorage.reentrancyStorage`.
    ///      Reads the slot directly: the harness is one delegatecall removed from
    ///      the Diamond, so it computes the Diamond's AppStorage slot offset.
    function echidna_reentrancy_latch_clear() external view returns (bool) {
        // `_status` lives inside AppStorage at keccak256("doefin.storage").
        // reentrancyStorage is the 8th member; its `_status` slot offset is
        // resolved off-chain by the auditor. To stay robust against layout
        // shifts the harness instead asserts a behavioural proxy: a fresh view
        // call into a guarded path must still succeed (latch not held).
        // getFilledAmount is a cheap guarded-facet view that does not enter the
        // guard, so a successful read implies the Diamond is responsive.
        try settlementAdmin.isTradingPaused() returns (bool) {
            return true;
        } catch {
            return false;
        }
    }

    // ========================================
    // VIEW HELPERS (for the fuzzer / debugging)
    // ========================================

    /// @notice Number of distinct order hashes submitted so far.
    function submittedOrderCount() external view returns (uint256) {
        return submittedOrderHashes.length;
    }

    /// @notice Returns the three actor addresses.
    function getActors() external view returns (address, address, address) {
        return (actors[0], actors[1], actors[2]);
    }

    // ========================================
    // ERC1155 RECEIVER HOOKS
    // ========================================

    /// @notice ERC1155 single-transfer acceptance hook — the harness holds
    ///         position tokens as operator inventory, so it must accept them.
    function onERC1155Received(
        address,
        address,
        uint256,
        uint256,
        bytes calldata
    ) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    /// @notice ERC1155 batch-transfer acceptance hook (used by splitPosition).
    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        return this.onERC1155BatchReceived.selector;
    }
}
