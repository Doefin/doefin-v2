// PENTEST BATCH · LOW + INFO findings
// ============================================================================
// Most LOW/INFO findings from `audit/findings-ledger.md` are cleanup or doc
// drift, not exploitable bugs. This file is the consolidated coverage for
// those — runnable mini-pentests for items that DO have observable
// behaviour, documentation describe-blocks for the rest. Per-finding detail
// (recommendation, location, NatSpec) lives in the ledger.
//
// Already covered elsewhere (under test/unit and the FIXED pentests):
//   BIZ-004 (FIXED, SEC-002 file)   BIZ-006 (FIXED, SEC-002 file)
//   Fixes touched: SEC-001/002/003 + BIZ-004/006 — see Phase-5 changelog.
//
// Runnable in this file:
//   SEC-011 — setOperator accepts address(0) and emits no event.
//   SEC-014 — ERC1155Facet.setApprovalForAll emits `ApprovalForAll` twice.
//
// Documentation-only (`it.skip` blocks summarise the finding):
//   SEC-008/009/010 (accept-risk)
//   BIZ-002, BIZ-005, BIZ-008 (cleanup / documentation)
//   CPX-003, CPX-005, CPX-006, CPX-007 (maintainability)
//   SEC-012 (orphaned event)
//   SEC-013 (RESOLVED SCRUM-224 — dead v2.0 trading-fee config removed)
//   CPX-A2, CPX-A4567 (residual types + nits)
//   GAS-001..GAS-007 (gas optimisations — see audit/gas/report.md)

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupAuditFixture } = require("../utils/auditFixture.js");

describe("PENTEST BATCH · LOW + INFO", function () {
  let ctx;

  before(async function () {
    ctx = await setupAuditFixture();
  });

  // ==========================================================================
  // RUNNABLE
  // ==========================================================================

  describe("SEC-011 (LOW, FIXED) — setOperator zero-address guard + OperatorUpdated event", function () {
    it("FIX VERIFIED — setOperator(address(0)) reverts ZeroAddress()", async function () {
      const { settlementAdmin } = ctx.contracts;
      const { owner } = ctx.signers;

      // Pre-fix: silently accepted, bricking settlement with no on-chain trace.
      // Post-fix: a clean, named revert.
      await expect(
        settlementAdmin.connect(owner).setOperator(ethers.constants.AddressZero),
      ).to.be.revertedWith("ZeroAddress()");
    });

    it("FIX VERIFIED — setOperator(non-zero) emits OperatorUpdated(old, new)", async function () {
      const { settlementAdmin } = ctx.contracts;
      const { owner, operator, attacker } = ctx.signers;

      const oldOperator = await settlementAdmin.getOperator();

      // Change to a new operator and watch for the event.
      await expect(settlementAdmin.connect(owner).setOperator(attacker.address))
        .to.emit(settlementAdmin, "OperatorUpdated")
        .withArgs(oldOperator, attacker.address);

      expect(await settlementAdmin.getOperator()).to.equal(attacker.address);

      // Restore the fixture operator so subsequent tests aren't impacted.
      await settlementAdmin.connect(owner).setOperator(operator.address);
    });
  });

  describe("SEC-014 (INFO, FIXED) — ERC1155Facet.setApprovalForAll emits ApprovalForAll exactly once", function () {
    it("FIX VERIFIED — calling setApprovalForAll emits the event exactly once per call", async function () {
      const { erc1155Facet } = ctx.contracts;
      const { attacker } = ctx.signers;

      const tx = await erc1155Facet.connect(attacker).setApprovalForAll(ctx.diamondAddress, true);
      const receipt = await tx.wait();

      const approvalEvents = receipt.events.filter((e) => e.event === "ApprovalForAll");
      // Pre-fix: the facet emitted AND `LibERC1155.setApprovalForAll` emitted
      // — two identical logs per call confused indexers. The facet emit was
      // removed; only the library emission remains.
      expect(approvalEvents.length).to.equal(1);
    });
  });

  // ==========================================================================
  // DOCUMENTATION-ONLY (skipped — each names the finding + recommendation)
  // ==========================================================================

  describe("Accept-risk LOWs (intentional patterns; no fix required)", function () {
    it.skip("SEC-008 — RESOLVED (SCRUM-223): the OracleManagerFacet permissionless-keeper finding is moot — the cross-currency oracle stack has been removed entirely.", function () {});
    it.skip("SEC-009 — Cancellation keys off `msg.sender`; SCW maker cannot delegate. Optional: add cancelOrderFor / incrementNonceFor for registered signers.", function () {});
    it.skip("SEC-010 — `orderHashToFilledAmount` is uint256 but `_checkFillAmount` caps it at the uint128 `orderAmount`; the wider type is harmless. Optional narrow.", function () {});
  });

  describe("Cleanup LOWs / INFOs (no exploitable behaviour; one cleanup commit)", function () {
    it.skip("BIZ-002 — _settleMerge runs the CTF burn BEFORE the crossing-check (effects-before-checks). Atomic-revert unwinds it today; move the check above the burn for consistency with _settleMint.", function () {});
    it.skip("BIZ-005 — On-chain _computeFee asserted in tests only at price=0.5; add coverage at 0.1·unit and 0.9·unit (asymmetric branch), plus a multi-maker matchOrders with feeRateBps>0.", function () {});
    it.skip("BIZ-008 — RESOLVED (SCRUM-226): `minFillAmount` was signed but never enforced on-chain; it has been removed from the DoefinOrder struct and EIP-712 typehash (10-field v3 form).", function () {});
    it.skip("CPX-003 — _getOrderHash and the order-validity predicate are duplicated across NonceManagerFacet + SettlementFacet. Extract a single LibSettlementValidity.", function () {});
    it.skip("CPX-005 — RESOLVED (SCRUM-223): the cross-currency conversion-path machinery on AdminConfigFacet (4 functions + mapping + 2 events) has been deleted.", function () {});
    it.skip("CPX-006 — `matchOrders` is a long multi-responsibility function (cyclomatic ~9-10). Extract a `_settleAgainstMaker` loop-body helper + a `_sumFills` helper.", function () {});
    it.skip("CPX-007 — `_getIndexSet` is O(n) but its comment claims O(1); _settleMint/_settleMerge duplicate the same partition+conditionId block. Extract `_conditionAndPartition`.", function () {});
    it.skip("SEC-012 — Orphaned `ProtocolFeesWithdrawn` event in Events.sol — delete the declaration.", function () {});
    it.skip("SEC-013 — RESOLVED (SCRUM-224): the non-functional v2.0 maker/taker trading-fee config (makerTradingFeeBps/takerTradingFeeBps fields, setTradingFeesBps, TradingFeesUpdated) has been deleted; settlement uses only the operator-supplied fee bounded by maxFeeRateBps.", function () {});
    it.skip("CPX-A2 — Residual v2.0 type zoo in LibDoefinStorage (~12 deprecated types + 2 AppStorage-embedded structs). Delete the enums/standalone structs post-launch; keep the embedded structs (slot/__gap hazard).", function () {});
    it.skip("CPX-A4567 — Bundled cosmetic nits: name 0x1626ba7e + 10000 constants, reword 'Fix N' comments, fix stale AdminConfig header, pin pragmas to 0.8.20, unify loop-index style.", function () {});
  });

  describe("Gas findings (severity-capped MEDIUM; see audit/gas/report.md)", function () {
    it.skip("GAS-001 (MED, defer) — Four dead DoefinOrder fields cost 128 calldata bytes/order on Base L2. Breaking EIP-712/ABI change; coordinate byte-for-byte with backend (encoder.py, models.py, settlement_abi.py) before the fresh deploy.", function () {});
    it.skip("GAS-002 (MED) — _isBinaryComplement + _getIndexSet re-resolve the same registry slots in Mint/Merge (~9-12 redundant warm SLOADs). Thread a MatchContext struct from _determineMatchType.", function () {});
    it.skip("GAS-003 (LOW) — Settlement fee transfers not coalesced (down-scoped; most batching blocked by distinct debtors). Coalesce only same-(token,debtor,recipient) transfers.", function () {});
    it.skip("GAS-004 (LOW) — _computeFee re-resolves unitPerPair/feeReceiver per call (2× per maker). Read once at the maker-loop top, pass into _computeFee (pure) and _settleX.", function () {});
    it.skip("GAS-005 (MED) — `optimizer runs=1` is the size-minimizing extreme; SettlementFacet has 10.7 KiB EIP-170 headroom. Sweep runs ∈ {200,1000,100000}; pick highest that beats baseline without breaching size.", function () {});
    it.skip("GAS-006 (LOW) — matchOrders double-walks makerFillAmounts. Accumulate totalMakerFill inside the main loop (combine with CPX-006).", function () {});
    it.skip("GAS-007 (LOW) — `unchecked` for loop increments + the four specifically-guarded subtractions (orderAmount-filled, fillAmount-makerCollateral/makerPayout, unit-price). Keep every revert guard.", function () {});
  });
});
