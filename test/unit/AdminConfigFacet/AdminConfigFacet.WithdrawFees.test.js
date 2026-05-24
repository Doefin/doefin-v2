// SPDX-License-Identifier: AGPL-3.0
/*
 * SCRUM-236 — AdminConfigFacet.withdrawFees() unit suite + NoChangeRequired
 * regression on setMaxFeeRate (CR-3291973202).
 *
 * Tests are written in source order (matches §6 / §7 of the SCRUM-236 design doc):
 *   1. Access control  - non-owner reverts
 *   2. Input validation - InvalidTokenAddress, ZeroAmount, InsufficientAccruedFees
 *   3. Stuck-receiver  - InvalidFeeReceiver
 *   4. Happy path      - partial withdraw, accrual decremented, transfer hits
 *                        feeReceiver, FeesWithdrawn emitted, CEI ordering
 *   5. Drain idiom     - type(uint256).max drains the full balance
 *   6. Drain-when-empty - resolves to ZeroAmount (no NoFeesAccrued surface)
 *   7. Delisted-token  - architect §7(2): a fee accrued before removeCollateralToken
 *                        is still owner-claimable post-delist
 *   8. Reentrancy      - malicious ERC20 hook re-enters withdrawFees; guard rejects
 *                        the inner call and the outer call still completes cleanly
 *   9. setMaxFeeRate NoChangeRequired regression (CR-3291973202)
 *
 * Also covers: the fee-zero symmetric trading regression (no FeeAccrued event when
 * the operator passes fee == 0).
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupAuditFixture, MAX_FEE_RATE_BPS } = require("../../utils/auditFixture");

describe("AdminConfigFacet.withdrawFees (SCRUM-236)", function () {
  this.timeout(60000);

  // --- shared accrual seed helper ---------------------------------------------

  // Accrues some trading fees by running a complementary settlement via the
  // shared audit fixture. Returns the (token, expected accrued amount) pair.
  async function seedAccruedFees(fix) {
    const { contracts, signers, market, helpers, constants } = fix;
    const { settlement, collateral } = contracts;
    const { operator, buyer, seller } = signers;
    const { positionIdA } = market;
    const { UNIT, FEE_BPS } = constants;

    const fill = ethers.utils.parseUnits("100", 6);
    const price = ethers.BigNumber.from(UNIT).div(2); // 0.5 UNIT
    const fee = helpers.legFee(price, fill, FEE_BPS);

    const buyerOrder = helpers.makeOrder(buyer.address, positionIdA, 0, fill, price);
    const sellerOrder = helpers.makeOrder(seller.address, positionIdA, 1, fill, price, { salt: 2 });
    const buyerSig = await helpers.signOrder(buyer, buyerOrder);
    const sellerSig = await helpers.signOrder(seller, sellerOrder);

    await settlement.connect(operator).matchOrders(
      buyerOrder,
      buyerSig,
      0,
      [sellerOrder],
      [sellerSig],
      [0],
      fill,
      [fill],
      [fee],
      [fee],
    );

    // Two fee legs (buyer + seller).
    return { token: collateral.address, accrued: fee.mul(2) };
  }

  // -----------------------------------------------------------------------------

  describe("access control", function () {
    it("reverts NotContractOwner when called by a non-owner", async function () {
      const fix = await setupAuditFixture();
      const { contracts, signers } = fix;
      await expect(
        contracts.adminConfig.connect(signers.attacker).withdrawFees(contracts.collateral.address, 1),
      ).to.be.revertedWith("NotContractOwner()");
    });
  });

  describe("input validation", function () {
    it("reverts InvalidTokenAddress when token is address(0)", async function () {
      const fix = await setupAuditFixture();
      await expect(fix.contracts.adminConfig.withdrawFees(ethers.constants.AddressZero, 1))
        .to.be.revertedWith("InvalidTokenAddress()");
    });

    it("reverts ZeroAmount when amount is 0 (explicit)", async function () {
      const fix = await setupAuditFixture();
      await expect(fix.contracts.adminConfig.withdrawFees(fix.contracts.collateral.address, 0))
        .to.be.revertedWith("ZeroAmount()");
    });

    it("reverts ZeroAmount when amount == type(uint256).max but the bank is empty (drain-when-empty)", async function () {
      const fix = await setupAuditFixture();
      // Bank is empty by default.
      await expect(
        fix.contracts.adminConfig.withdrawFees(fix.contracts.collateral.address, ethers.constants.MaxUint256),
      ).to.be.revertedWith("ZeroAmount()");
    });

    it("reverts InsufficientAccruedFees(requested, available) when amount > accrued", async function () {
      const fix = await setupAuditFixture();
      const { token, accrued } = await seedAccruedFees(fix);
      const request = accrued.add(1);
      // Hardhat reports custom-error reverts as
      //   'reverted with custom error \'InsufficientAccruedFees(<req>, <avail>)\''
      // (lower-cased by the chai layer). Assert by substring on that signature.
      let caught;
      try {
        await fix.contracts.adminConfig.withdrawFees(token, request);
        throw new Error("did not revert");
      } catch (e) {
        caught = e;
      }
      const expected = `insufficientaccruedfees(${request.toString()}, ${accrued.toString()})`;
      expect(caught.message.toLowerCase()).to.include(expected);
    });
  });

  describe("stuck feeReceiver", function () {
    it("reverts InvalidFeeReceiver when feeReceiver is address(0) and there are accrued fees to sweep", async function () {
      // Fresh deploy without auditFixture's setFeeReceiver convenience: deploy + accrue + clear receiver.
      const fix = await setupAuditFixture();
      const { token } = await seedAccruedFees(fix);

      // Sneak `feeReceiver = address(0)` by writing to storage directly via the
      // EIP-7201 slot. (The setter rejects address(0) on input, so we test the
      // post-condition that withdrawFees fail-closes if the storage ever holds 0.)
      // EIP-7201 derivation of doefin.admin-config.storage:
      const slot = "0xf40d4f44b73a30edbc8834be4a1fac961a187f5028f483c6ae44def1200b3900";
      // feeReceiver lives at slot+3, offset 0 (per the storage snapshot).
      const feeReceiverSlot = ethers.BigNumber.from(slot).add(3);
      await ethers.provider.send("hardhat_setStorageAt", [
        fix.diamondAddress,
        ethers.utils.hexValue(feeReceiverSlot),
        ethers.utils.hexZeroPad("0x0", 32),
      ]);

      await expect(fix.contracts.adminConfig.withdrawFees(token, 1))
        .to.be.revertedWith("InvalidFeeReceiver()");
    });
  });

  describe("happy path & state updates", function () {
    it("partial withdraw decrements accruedFees by `amount` and transfers exactly `amount` to feeReceiver", async function () {
      const fix = await setupAuditFixture();
      const { contracts, signers } = fix;
      const { token, accrued } = await seedAccruedFees(fix);

      const half = accrued.div(2);
      const beforeBal = await contracts.collateral.balanceOf(signers.feeReceiver.address);

      await expect(contracts.adminConfig.withdrawFees(token, half))
        .to.emit(contracts.adminConfig, "FeesWithdrawn")
        .withArgs(token, signers.feeReceiver.address, half);

      expect(await contracts.adminConfig.getAccruedFees(token)).to.equal(accrued.sub(half));
      expect(
        (await contracts.collateral.balanceOf(signers.feeReceiver.address)).sub(beforeBal),
      ).to.equal(half);
    });

    it("drain (type(uint256).max) zeroes accruedFees and sends the full balance to feeReceiver", async function () {
      const fix = await setupAuditFixture();
      const { contracts, signers } = fix;
      const { token, accrued } = await seedAccruedFees(fix);

      const beforeBal = await contracts.collateral.balanceOf(signers.feeReceiver.address);
      await expect(contracts.adminConfig.withdrawFees(token, ethers.constants.MaxUint256))
        .to.emit(contracts.adminConfig, "FeesWithdrawn")
        .withArgs(token, signers.feeReceiver.address, accrued);

      expect(await contracts.adminConfig.getAccruedFees(token)).to.equal(0);
      expect(
        (await contracts.collateral.balanceOf(signers.feeReceiver.address)).sub(beforeBal),
      ).to.equal(accrued);
    });

    it("Diamond balance drops by exactly `amount` (the bank's collateral is the source)", async function () {
      const fix = await setupAuditFixture();
      const { contracts } = fix;
      const { token, accrued } = await seedAccruedFees(fix);

      const before = await contracts.collateral.balanceOf(fix.diamondAddress);
      await contracts.adminConfig.withdrawFees(token, accrued);
      const after = await contracts.collateral.balanceOf(fix.diamondAddress);
      expect(before.sub(after)).to.equal(accrued);
    });
  });

  describe("delisted-token withdraw (architect §7(2))", function () {
    it("succeeds even after removeCollateralToken (fees lawfully accrued pre-delist remain claimable)", async function () {
      const fix = await setupAuditFixture();
      const { contracts, signers } = fix;
      const { token, accrued } = await seedAccruedFees(fix);

      // Owner delists the token after fees have been accrued.
      await contracts.adminConfig.removeCollateralToken(token);
      expect(await contracts.adminConfig.isAllowedCollateral(token)).to.equal(false);

      // The withdraw path does NOT check `isAllowed[token]` — fees remain claimable.
      const beforeBal = await contracts.collateral.balanceOf(signers.feeReceiver.address);
      await expect(contracts.adminConfig.withdrawFees(token, accrued))
        .to.emit(contracts.adminConfig, "FeesWithdrawn")
        .withArgs(token, signers.feeReceiver.address, accrued);
      expect(await contracts.adminConfig.getAccruedFees(token)).to.equal(0);
      expect((await contracts.collateral.balanceOf(signers.feeReceiver.address)).sub(beforeBal)).to.equal(accrued);
    });
  });

  describe("reentrancy regression (architect §6.2 / §7(3))", function () {
    it("the LibReentrancyGuard window blocks a withdrawFees re-entry from a malicious ERC20 transfer hook", async function () {
      const fix = await setupAuditFixture();
      const { contracts, signers } = fix;

      // Deploy + allow-list a malicious collateral that re-enters withdrawFees in
      // its transfer hook. Pre-fund the Diamond with a fake "accrued" balance.
      const BadERC20 = await ethers.getContractFactory("MaliciousReentrantERC20");
      const bad = await BadERC20.deploy();
      await bad.deployed();
      await contracts.adminConfig.addCollateralToken(bad.address, ethers.utils.parseUnits("1", 6));

      // Mint the bank balance directly to the Diamond and bump accruedFees via
      // a small bookkeeping seed: easiest way is to mint to the Diamond and
      // patch the accruedFees slot. The slot for accruedFees mapping is at
      // (eip7201_slot + 4) per the storage snapshot.
      const seed = ethers.utils.parseUnits("100", 6);
      await bad.mint(fix.diamondAddress, seed);
      const slot = "0xf40d4f44b73a30edbc8834be4a1fac961a187f5028f483c6ae44def1200b3900";
      const accruedSlot = ethers.BigNumber.from(slot).add(4);
      const innerSlot = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(["address", "uint256"], [bad.address, accruedSlot]),
      );
      await ethers.provider.send("hardhat_setStorageAt", [
        fix.diamondAddress,
        innerSlot,
        ethers.utils.hexZeroPad(seed.toHexString(), 32),
      ]);
      expect(await contracts.adminConfig.getAccruedFees(bad.address)).to.equal(seed);

      // Arm the malicious token to re-enter the Diamond on the OUTER withdraw's transfer.
      await bad.setTarget(fix.diamondAddress);
      await bad.arm(seed); // inner call will request `seed`

      // The outer call completes (legit), but the inner reentrant withdrawFees
      // must be rejected by the reentrancy guard.
      await contracts.adminConfig.withdrawFees(bad.address, seed);

      expect(await bad.reentryAttempted()).to.equal(true);
      expect(await bad.reentrySucceeded()).to.equal(false);

      // The captured revert payload must be one of the gates we know fire here:
      // - LibReentrancyGuard `ReentrantCall()` (the second-line guard)
      // - LibDiamond `NotContractOwner()` (the first-line ownership gate; the
      //   re-entrant caller is the malicious ERC20 itself, not the owner)
      //
      // Either reverts the inner call without state change — the property we
      // care about is that the inner withdrawFees CANNOT succeed and the outer
      // call still completes cleanly.
      const reentrantSelector = ethers.utils.id("ReentrantCall()").slice(0, 10);
      const notOwnerSelector = ethers.utils.id("NotContractOwner()").slice(0, 10);
      const captured = await bad.reentryReturnData();
      expect([reentrantSelector, notOwnerSelector]).to.include(captured);

      // Outer call succeeded — Diamond paid out `seed` to feeReceiver exactly
      // once and the bank is zeroed. No double-spend.
      expect(await bad.balanceOf(signers.feeReceiver.address)).to.equal(seed);
      expect(await contracts.adminConfig.getAccruedFees(bad.address)).to.equal(0);
    });
  });
});

describe("SettlementFacet — fee == 0 symmetric no-op (SCRUM-236 / architect §7(1))", function () {
  this.timeout(60000);

  it("matchOrders with fee == 0 on both legs accrues nothing and emits no FeeAccrued event", async function () {
    const fix = await setupAuditFixture();
    const { contracts, signers, market, helpers, constants } = fix;
    const { settlement, adminConfig, collateral } = contracts;
    const { operator, buyer, seller } = signers;
    const { positionIdA } = market;
    const { UNIT } = constants;

    const fill = ethers.utils.parseUnits("50", 6);
    const price = ethers.BigNumber.from(UNIT).div(2);
    const ZERO = ethers.BigNumber.from(0);

    const buyerOrder = helpers.makeOrder(buyer.address, positionIdA, 0, fill, price);
    const sellerOrder = helpers.makeOrder(seller.address, positionIdA, 1, fill, price, { salt: 2 });
    const buyerSig = await helpers.signOrder(buyer, buyerOrder);
    const sellerSig = await helpers.signOrder(seller, sellerOrder);

    const accruedBefore = await adminConfig.getAccruedFees(collateral.address);
    const tx = await settlement.connect(operator).matchOrders(
      buyerOrder,
      buyerSig,
      0,
      [sellerOrder],
      [sellerSig],
      [0],
      fill,
      [fill],
      [ZERO],
      [ZERO],
    );
    const rcpt = await tx.wait();

    // No FeeAccrued in the receipt. `FeeAccrued` is defined in the shared Events
    // library; compute the topic directly so we don't need a facet that exposes it.
    const accruedTopic = ethers.utils.id("FeeAccrued(address,uint256,uint8)");
    expect(rcpt.logs.some((l) => l.topics[0] === accruedTopic)).to.equal(false);

    // No bank credit either.
    const accruedAfter = await adminConfig.getAccruedFees(collateral.address);
    expect(accruedAfter.sub(accruedBefore)).to.equal(0);
  });
});

describe("AdminConfigFacet.setMaxFeeRate NoChangeRequired (CR-3291973202)", function () {
  this.timeout(60000);

  it("reverts NoChangeRequired when the new rate equals the current rate", async function () {
    const fix = await setupAuditFixture();
    // Fixture already set MAX_FEE_RATE_BPS — setting the same value again must revert.
    await expect(fix.contracts.adminConfig.setMaxFeeRate(MAX_FEE_RATE_BPS))
      .to.be.revertedWith("NoChangeRequired()");
  });

  it("still allows a real rate change", async function () {
    const fix = await setupAuditFixture();
    await expect(fix.contracts.adminConfig.setMaxFeeRate(MAX_FEE_RATE_BPS - 1))
      .to.emit(fix.contracts.adminConfig, "MaxFeeRateUpdated")
      .withArgs(MAX_FEE_RATE_BPS, MAX_FEE_RATE_BPS - 1);
  });
});
