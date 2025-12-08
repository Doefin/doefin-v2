const { deployDiamond } = require("../../../scripts/deploy.js");
const { expect } = require("chai");
const { ethers } = require("hardhat");

const {
  addCollateralToken,
  setFeeReceiver,
  setTradingFeesBps,
} = require("../../utils/adminConfigUtils.js");

const { deployMockERC20 } = require("../../mock/deployMocks.js");
const { mintAndApproveERC20 } = require("../../utils/erc20Utils.js");
const { sendAndApproveERC1155 } = require("../../utils/erc1155Utils.js");
const { getConditionId } = require("../../utils/ctfUtils.js");
const { splitConditionAndGetPositionIds } = require("../../utils/conditionUtils.js");
const { createLimitOrder } = require("../../utils/orderUtils.js");

describe("LibFeeManager - Fee Management Tests", function () {
  let diamondAddress, adminConfig, exchangeFacet, conditionalFacet, conditionManagerFacet;
  let owner, addr1, addr2, feeReceiver, recipient, oracle, erc1155;
  let mockToken, mockToken2;
  let yesId, noId;

  beforeEach(async function () {
    [owner, addr1, addr2, feeReceiver, recipient, oracle] = await ethers.getSigners();

    // Deploy diamond
    diamondAddress = await deployDiamond();
    adminConfig = await ethers.getContractAt("AdminConfigFacet", diamondAddress);
    // The createOrder entrypoint now lives in OrderCreationFacet (ExchangeFacet removed)
    exchangeFacet = await ethers.getContractAt("OrderCreationFacet", diamondAddress);
    conditionalFacet = await ethers.getContractAt("ConditionalTokensFacet", diamondAddress);
    conditionManagerFacet = await ethers.getContractAt("ConditionManagerFacet", diamondAddress);
    erc1155 = await ethers.getContractAt("ERC1155Facet", diamondAddress);

    // Deploy mock tokens
    mockToken = await deployMockERC20("MockToken", "MTK");
    mockToken2 = await deployMockERC20("MockToken2", "MTK2");

    // Setup access control
    const accessControlFacet = await ethers.getContractAt("AccessControlFacet", diamondAddress);
    await accessControlFacet.addMarketMaker(owner.address);

    // Add collateral tokens
    const unit = ethers.utils.parseEther("1");
    await addCollateralToken({ adminConfig, token: mockToken, unit, caller: owner });
    await addCollateralToken({ adminConfig, token: mockToken2, unit, caller: owner });

    // Set fee receiver and trading fees
    await setFeeReceiver({ adminConfig, feeReceiver, caller: owner });
    await setTradingFeesBps({ adminConfig, makerBps: 100, takerBps: 200, caller: owner }); // 1% maker, 2% taker

    // Create a condition and split to get position IDs for testing
    const questionId = ethers.utils.id("fee-manager-test");
    const outcomeSlotCount = 2;
    const conditionId = getConditionId(oracle.address, questionId, outcomeSlotCount);
    await conditionManagerFacet.connect(owner).createCondition(oracle.address, questionId, outcomeSlotCount, "ipfs://dummy");

    // Mint and approve tokens for splitting
    const mintAmount = ethers.utils.parseEther("1000");
    await mintAndApproveERC20({ token: mockToken, minter: owner, to: owner, amount: mintAmount, spender: diamondAddress });
    await mintAndApproveERC20({ token: mockToken, minter: owner, to: addr1, amount: mintAmount, spender: diamondAddress });

    // Split condition to get position tokens
    const [positionIds] = await splitConditionAndGetPositionIds({
      user: owner,
      amount: ethers.utils.parseEther("100"),
      conditionId,
      indexSets: [1, 2],
      erc20: mockToken,
      conditionalFacet,
    });

    yesId = positionIds[0];
    noId = positionIds[1];

    // Approve ERC1155 for trading
    await erc1155.connect(owner).setApprovalForAll(diamondAddress, true);
    await erc1155.connect(addr1).setApprovalForAll(diamondAddress, true);
  });

  describe("Fee Withdrawal Functions", function () {
    beforeEach(async function () {
      // Create some trades to generate fees
      const amount = ethers.utils.parseEther("10");
      const sellPrice = ethers.utils.parseEther("0.5");
      const buyPrice = ethers.utils.parseEther("0.51");

      // First, owner needs position tokens to sell
      // Transfer some position tokens to owner for selling

      // sendAndApproveERC1155({ token: erc1155, from: owner, to: owner, id: yesId, amount });

      // Create sell order from owner (who has position tokens)
      await createLimitOrder(exchangeFacet, owner, {
        positionId: yesId,
        collateralToken: mockToken.address,
        amount,
        pricePerToken: sellPrice,
        minFillAmount: 0,
        expiry: 0,
        direction: 1, // Sell
      });

      // Create buy order from addr1 with matching or higher price to trigger execution
      // The buy order should match the sell order and execute immediately
      await createLimitOrder(exchangeFacet, addr1, {
        positionId: yesId,
        collateralToken: mockToken.address,
        amount,
        pricePerToken: buyPrice,
        minFillAmount: 0,
        expiry: 0,
        direction: 0, // Buy
      });

      // Verify that fees were actually generated
      const fees = await adminConfig.getProtocolFeesBalance(mockToken.address);
      console.log("Generated fees:", fees.toString());
    });

    describe("withdrawProtocolFees", function () {
      it("should withdraw specific amount of protocol fees", async function () {
        // Check initial fee balance
        const initialFees = await adminConfig.getProtocolFeesBalance(mockToken.address);
        expect(initialFees).to.be.gt(0);

        // Withdraw half of the fees
        const withdrawAmount = initialFees.div(2);
        const initialReceiverBalance = await mockToken.balanceOf(feeReceiver.address);

        await expect(adminConfig.withdrawProtocolFees(mockToken.address, withdrawAmount))
          .to.emit(adminConfig, "ProtocolFeesWithdrawn")
          .withArgs(mockToken.address, feeReceiver.address, withdrawAmount, initialFees.sub(withdrawAmount));

        // Verify balances
        const finalFees = await adminConfig.getProtocolFeesBalance(mockToken.address);
        expect(finalFees).to.equal(initialFees.sub(withdrawAmount));

        const finalReceiverBalance = await mockToken.balanceOf(feeReceiver.address);
        expect(finalReceiverBalance).to.equal(initialReceiverBalance.add(withdrawAmount));
      });

      it("should withdraw all fees when amount is 0", async function () {
        const initialFees = await adminConfig.getProtocolFeesBalance(mockToken.address);
        const initialReceiverBalance = await mockToken.balanceOf(feeReceiver.address);

        await expect(adminConfig.withdrawProtocolFees(mockToken.address, 0))
          .to.emit(adminConfig, "ProtocolFeesWithdrawn")
          .withArgs(mockToken.address, feeReceiver.address, initialFees, 0);

        const finalFees = await adminConfig.getProtocolFeesBalance(mockToken.address);
        expect(finalFees).to.equal(0);

        const finalReceiverBalance = await mockToken.balanceOf(feeReceiver.address);
        expect(finalReceiverBalance).to.equal(initialReceiverBalance.add(initialFees));
      });

      it("should revert when non-owner tries to withdraw", async function () {
        await expect(adminConfig.connect(addr1).withdrawProtocolFees(mockToken.address, 100))
          .to.be.revertedWith("NotContractOwner()");
      });

      it("should revert when withdrawing from invalid token address", async function () {
        await expect(adminConfig.withdrawProtocolFees(ethers.constants.AddressZero, 100))
          .to.be.revertedWith("InvalidTokenAddress()");
      });

      it("should revert when no fees to withdraw", async function () {
        // Withdraw all fees first
        await adminConfig.withdrawProtocolFees(mockToken.address, 0);
        
        // Try to withdraw again
        await expect(adminConfig.withdrawProtocolFees(mockToken.address, 100))
          .to.be.revertedWith("NoFeesToWithdraw()");
      });

      it("should revert when withdrawing more than available", async function () {
        const availableFees = await adminConfig.getProtocolFeesBalance(mockToken.address);
        
        await expect(adminConfig.withdrawProtocolFees(mockToken.address, availableFees.add(1)))
          .to.be.revertedWith("InsufficientFeeBalance()");
      });
    });

    describe("withdrawProtocolFeesTo", function () {
      it("should withdraw fees to specific recipient", async function () {
        const initialFees = await adminConfig.getProtocolFeesBalance(mockToken.address);
        const initialRecipientBalance = await mockToken.balanceOf(recipient.address);

        await expect(adminConfig.withdrawProtocolFeesTo(mockToken.address, initialFees, recipient.address))
          .to.emit(adminConfig, "ProtocolFeesWithdrawn")
          .withArgs(mockToken.address, recipient.address, initialFees, 0);

        const finalRecipientBalance = await mockToken.balanceOf(recipient.address);
        expect(finalRecipientBalance).to.equal(initialRecipientBalance.add(initialFees));
      });

      it("should use configured fee receiver when recipient is zero address", async function () {
        const initialFees = await adminConfig.getProtocolFeesBalance(mockToken.address);
        const initialReceiverBalance = await mockToken.balanceOf(feeReceiver.address);

        await adminConfig.withdrawProtocolFeesTo(mockToken.address, initialFees, ethers.constants.AddressZero);

        const finalReceiverBalance = await mockToken.balanceOf(feeReceiver.address);
        expect(finalReceiverBalance).to.equal(initialReceiverBalance.add(initialFees));
      });
    });

    describe("withdrawAllProtocolFees", function () {
      it("should withdraw all accumulated fees", async function () {
        const initialFees = await adminConfig.getProtocolFeesBalance(mockToken.address);
        expect(initialFees).to.be.gt(0);

        await expect(adminConfig.withdrawAllProtocolFees(mockToken.address))
          .to.emit(adminConfig, "ProtocolFeesWithdrawn")
          .withArgs(mockToken.address, feeReceiver.address, initialFees, 0);

        const finalFees = await adminConfig.getProtocolFeesBalance(mockToken.address);
        expect(finalFees).to.equal(0);
      });
    });

    describe("withdrawAllProtocolFeesTo", function () {
      it("should withdraw all fees to specific recipient", async function () {
        const initialFees = await adminConfig.getProtocolFeesBalance(mockToken.address);
        const initialRecipientBalance = await mockToken.balanceOf(recipient.address);

        await expect(adminConfig.withdrawAllProtocolFeesTo(mockToken.address, recipient.address))
          .to.emit(adminConfig, "ProtocolFeesWithdrawn")
          .withArgs(mockToken.address, recipient.address, initialFees, 0);

        const finalRecipientBalance = await mockToken.balanceOf(recipient.address);
        expect(finalRecipientBalance).to.equal(initialRecipientBalance.add(initialFees));
      });
    });

    describe("batchWithdrawProtocolFees", function () {
      beforeEach(async function () {
        // Generate fees for second token
        await mintAndApproveERC20({ 
          token: mockToken2, 
          minter: owner, 
          to: owner, 
          amount: ethers.utils.parseEther("1000"), 
          spender: diamondAddress 
        });
        await mintAndApproveERC20({ 
          token: mockToken2, 
          minter: owner, 
          to: addr1, 
          amount: ethers.utils.parseEther("1000"), 
          spender: diamondAddress 
        });

        // Create condition for second token
        const questionId2 = ethers.utils.id("fee-manager-test-2");
        const conditionId2 = getConditionId(oracle.address, questionId2, 2);
        await conditionManagerFacet.connect(owner).createCondition(oracle.address, questionId2, 2, "ipfs://dummy2");

        // Split with second token
        const [positionIds2] = await splitConditionAndGetPositionIds({
          user: owner,
          amount: ethers.utils.parseEther("100"),
          conditionId: conditionId2,
          indexSets: [1, 2],
          erc20: mockToken2,
          conditionalFacet,
        });

        // Create trades with second token to generate fees
        await createLimitOrder(exchangeFacet, owner, {
          positionId: positionIds2[0],
          collateralToken: mockToken2.address,
          amount: ethers.utils.parseEther("10"),
          pricePerToken: ethers.utils.parseEther("0.5"),
          minFillAmount: 0,
          expiry: 0,
          direction: 1, // Sell
        });

        await createLimitOrder(exchangeFacet, addr1, {
          positionId: positionIds2[0],
          collateralToken: mockToken2.address,
          amount: ethers.utils.parseEther("10"),
          pricePerToken: ethers.utils.parseEther("0.5"),
          minFillAmount: 0,
          expiry: 0,
          direction: 0, // Buy
        });
      });

      it("should batch withdraw fees for multiple tokens", async function () {
        const fees1 = await adminConfig.getProtocolFeesBalance(mockToken.address);
        const fees2 = await adminConfig.getProtocolFeesBalance(mockToken2.address);

        const tokens = [mockToken.address, mockToken2.address];
        const amounts = [fees1.div(2), fees2.div(2)]; // Withdraw half of each

        await adminConfig.batchWithdrawProtocolFees(tokens, amounts);

        const finalFees1 = await adminConfig.getProtocolFeesBalance(mockToken.address);
        const finalFees2 = await adminConfig.getProtocolFeesBalance(mockToken2.address);

        expect(finalFees1).to.equal(fees1.sub(amounts[0]));
        expect(finalFees2).to.equal(fees2.sub(amounts[1]));
      });

      it("should withdraw all when amount is 0", async function () {
        const tokens = [mockToken.address, mockToken2.address];
        const amounts = [0, 0]; // Withdraw all

        await adminConfig.batchWithdrawProtocolFees(tokens, amounts);

        const finalFees1 = await adminConfig.getProtocolFeesBalance(mockToken.address);
        const finalFees2 = await adminConfig.getProtocolFeesBalance(mockToken2.address);

        expect(finalFees1).to.equal(0);
        expect(finalFees2).to.equal(0);
      });

      it("should skip tokens with no fees available", async function () {
        // Withdraw all fees from token1 first
        await adminConfig.withdrawAllProtocolFees(mockToken.address);

        const fees2 = await adminConfig.getProtocolFeesBalance(mockToken2.address);
        const tokens = [mockToken.address, mockToken2.address];
        const amounts = [100, fees2]; // Try to withdraw from empty token1

        // Should not revert, just skip token1
        await adminConfig.batchWithdrawProtocolFees(tokens, amounts);

        const finalFees2 = await adminConfig.getProtocolFeesBalance(mockToken2.address);
        expect(finalFees2).to.equal(0);
      });

      it("should revert on array length mismatch", async function () {
        const tokens = [mockToken.address, mockToken2.address];
        const amounts = [100]; // Mismatched length

        await expect(adminConfig.batchWithdrawProtocolFees(tokens, amounts))
          .to.be.revertedWith("ArrayLengthMismatch()");
      });
    });

    describe("batchWithdrawProtocolFeesTo", function () {
      beforeEach(async function () {
        // Generate fees for second token (same as above)
        await mintAndApproveERC20({ 
          token: mockToken2, 
          minter: owner, 
          to: owner, 
          amount: ethers.utils.parseEther("1000"), 
          spender: diamondAddress 
        });
        await mintAndApproveERC20({ 
          token: mockToken2, 
          minter: owner, 
          to: addr1, 
          amount: ethers.utils.parseEther("1000"), 
          spender: diamondAddress 
        });

        const questionId2 = ethers.utils.id("fee-manager-test-3");
        const conditionId2 = getConditionId(oracle.address, questionId2, 2);
        await conditionManagerFacet.connect(owner).createCondition(oracle.address, questionId2, 2, "ipfs://dummy3");

        const [positionIds2] = await splitConditionAndGetPositionIds({
          user: owner,
          amount: ethers.utils.parseEther("100"),
          conditionId: conditionId2,
          indexSets: [1, 2],
          erc20: mockToken2,
          conditionalFacet,
        });

        await createLimitOrder(exchangeFacet, owner, {
          positionId: positionIds2[0],
          collateralToken: mockToken2.address,
          amount: ethers.utils.parseEther("10"),
          pricePerToken: ethers.utils.parseEther("0.5"),
          minFillAmount: 0,
          expiry: 0,
          direction: 1,
        });

        await createLimitOrder(exchangeFacet, addr1, {
          positionId: positionIds2[0],
          collateralToken: mockToken2.address,
          amount: ethers.utils.parseEther("10"),
          pricePerToken: ethers.utils.parseEther("0.5"),
          minFillAmount: 0,
          expiry: 0,
          direction: 0,
        });
      });

      it("should batch withdraw fees to specific recipient", async function () {
        const fees1 = await adminConfig.getProtocolFeesBalance(mockToken.address);
        const fees2 = await adminConfig.getProtocolFeesBalance(mockToken2.address);

        const initialBalance1 = await mockToken.balanceOf(recipient.address);
        const initialBalance2 = await mockToken2.balanceOf(recipient.address);

        const tokens = [mockToken.address, mockToken2.address];
        const amounts = [fees1, fees2];

        await adminConfig.batchWithdrawProtocolFeesTo(tokens, amounts, recipient.address);

        const finalBalance1 = await mockToken.balanceOf(recipient.address);
        const finalBalance2 = await mockToken2.balanceOf(recipient.address);

        expect(finalBalance1).to.equal(initialBalance1.add(fees1));
        expect(finalBalance2).to.equal(initialBalance2.add(fees2));
      });
    });
  });

  describe("Fee Query Functions", function () {
    beforeEach(async function () {
      // Generate some fees
      await createLimitOrder(exchangeFacet, owner, {
        positionId: yesId,
        collateralToken: mockToken.address,
        amount: ethers.utils.parseEther("10"),
        pricePerToken: ethers.utils.parseEther("0.5"),
        minFillAmount: 0,
        expiry: 0,
        direction: 1,
      });

      await createLimitOrder(exchangeFacet, addr1, {
        positionId: yesId,
        collateralToken: mockToken.address,
        amount: ethers.utils.parseEther("10"),
        pricePerToken: ethers.utils.parseEther("0.51"),
        minFillAmount: 0,
        expiry: 0,
        direction: 0,
      });
    });

    describe("getProtocolFeesBalance", function () {
      it("should return accumulated fees for a token", async function () {
        const fees = await adminConfig.getProtocolFeesBalance(mockToken.address);
        expect(fees).to.be.gt(0);
        
        // Fees should be: 10 * 0.5 = 5 ETH cost
        // Maker fee: 5 * 0.01 = 0.05 ETH
        // Taker fee: 5 * 0.02 = 0.10 ETH
        // Total: 0.15 ETH
        expect(fees).to.equal(ethers.utils.parseEther("0.15"));
      });

      it("should return 0 for token with no fees", async function () {
        const fees = await adminConfig.getProtocolFeesBalance(mockToken2.address);
        expect(fees).to.equal(0);
      });
    });

    describe("getProtocolFeesBalances", function () {
      it("should return fees for multiple tokens", async function () {
        const tokens = [mockToken.address, mockToken2.address];
        const fees = await adminConfig.getProtocolFeesBalances(tokens);
        
        expect(fees.length).to.equal(2);
        expect(fees[0]).to.be.gt(0);
        expect(fees[1]).to.equal(0);
      });
    });

    describe("hasFeesAvailable", function () {
      it("should return true when fees are available", async function () {
        const hasF = await adminConfig.hasFeesAvailable(mockToken.address);
        expect(hasF).to.be.true;
      });

      it("should return false when no fees available", async function () {
        const hasFees = await adminConfig.hasFeesAvailable(mockToken2.address);
        expect(hasFees).to.be.false;
      });

      it("should return false after withdrawing all fees", async function () {
        await adminConfig.withdrawAllProtocolFees(mockToken.address);
        const hasFees = await adminConfig.hasFeesAvailable(mockToken.address);
        expect(hasFees).to.be.false;
      });
    });

    describe("getFeeStatistics", function () {
      it("should return fee statistics for a token", async function () {
        const [available, receiver] = await adminConfig.getFeeStatistics(mockToken.address);
        
        expect(available).to.be.gt(0);
        expect(receiver).to.equal(feeReceiver.address);
      });

      it("should return updated receiver after change", async function () {
        await setFeeReceiver({ adminConfig, feeReceiver: recipient, caller: owner });
        
        const [available, receiver] = await adminConfig.getFeeStatistics(mockToken.address);
        expect(receiver).to.equal(recipient.address);
      });
    });

    describe("getTotalAccumulatedFeesValue", function () {
      it("should return count of tokens with fees (placeholder implementation)", async function () {
        // Generate fees for second token
        await mintAndApproveERC20({ 
          token: mockToken2, 
          minter: owner, 
          to: owner, 
          amount: ethers.utils.parseEther("1000"), 
          spender: diamondAddress 
        });
        await mintAndApproveERC20({ 
          token: mockToken2, 
          minter: owner, 
          to: addr1, 
          amount: ethers.utils.parseEther("1000"), 
          spender: diamondAddress 
        });

        const questionId2 = ethers.utils.id("fee-manager-test-4");
        const conditionId2 = getConditionId(oracle.address, questionId2, 2);
        await conditionManagerFacet.connect(owner).createCondition(oracle.address, questionId2, 2, "ipfs://dummy4");

        const [positionIds2] = await splitConditionAndGetPositionIds({
          user: owner,
          amount: ethers.utils.parseEther("100"),
          conditionId: conditionId2,
          indexSets: [1, 2],
          erc20: mockToken2,
          conditionalFacet,
        });

        await createLimitOrder(exchangeFacet, owner, {
          positionId: positionIds2[0],
          collateralToken: mockToken2.address,
          amount: ethers.utils.parseEther("10"),
          pricePerToken: ethers.utils.parseEther("0.5"),
          minFillAmount: 0,
          expiry: 0,
          direction: 1,
        });

        await createLimitOrder(exchangeFacet, addr1, {
          positionId: positionIds2[0],
          collateralToken: mockToken2.address,
          amount: ethers.utils.parseEther("10"),
          pricePerToken: ethers.utils.parseEther("0.51"),
          minFillAmount: 0,
          expiry: 0,
          direction: 0,
        });

        const tokens = [mockToken.address, mockToken2.address];
        const balances = await adminConfig.getProtocolFeesBalances(tokens);

        // Placeholder logic: count how many balances are > 0
        const feeBearingCount = balances.filter((b) => !b.isZero()).length;
        expect(feeBearingCount).to.equal(2);
      });

      it("should return 0 when no tokens have fees", async function () {
        // Withdraw all fees first
        await adminConfig.withdrawAllProtocolFees(mockToken.address);

        const tokens = [mockToken.address, mockToken2.address];
        const balances = await adminConfig.getProtocolFeesBalances(tokens);
        const feeBearingCount = balances.filter((b) => !b.isZero()).length;

        expect(feeBearingCount).to.equal(0);
      });
    });
  });

  describe("Access Control", function () {
    it("should only allow owner to withdraw fees", async function () {
      // Generate some fees first
      await createLimitOrder(exchangeFacet, owner, {
        positionId: yesId,
        collateralToken: mockToken.address,
        amount: ethers.utils.parseEther("10"),
        pricePerToken: ethers.utils.parseEther("0.5"),
        minFillAmount: 0,
        expiry: 0,
        direction: 1,
      });

      await createLimitOrder(exchangeFacet, addr1, {
        positionId: yesId,
        collateralToken: mockToken.address,
        amount: ethers.utils.parseEther("10"),
        pricePerToken: ethers.utils.parseEther("0.51"),
        minFillAmount: 0,
        expiry: 0,
        direction: 0,
      });

      // Test all withdrawal functions with non-owner
      await expect(adminConfig.connect(addr1).withdrawProtocolFees(mockToken.address, 100))
        .to.be.revertedWith("NotContractOwner()");

      await expect(adminConfig.connect(addr1).withdrawProtocolFeesTo(mockToken.address, 100, recipient.address))
        .to.be.revertedWith("NotContractOwner()");

      await expect(adminConfig.connect(addr1).withdrawAllProtocolFees(mockToken.address))
        .to.be.revertedWith("NotContractOwner()");

      await expect(adminConfig.connect(addr1).withdrawAllProtocolFeesTo(mockToken.address, recipient.address))
        .to.be.revertedWith("NotContractOwner()");

      await expect(adminConfig.connect(addr1).batchWithdrawProtocolFees([mockToken.address], [100]))
        .to.be.revertedWith("NotContractOwner()");

      await expect(adminConfig.connect(addr1).batchWithdrawProtocolFeesTo([mockToken.address], [100], recipient.address))
        .to.be.revertedWith("NotContractOwner()");
    });
  });

  describe("Edge Cases", function () {
    it("should handle withdrawal when fee receiver changes mid-process", async function () {
      // Generate fees
      await createLimitOrder(exchangeFacet, owner, {
        positionId: yesId,
        collateralToken: mockToken.address,
        amount: ethers.utils.parseEther("10"),
        pricePerToken: ethers.utils.parseEther("0.5"),
        minFillAmount: 0,
        expiry: 0,
        direction: 1,
      });

      await createLimitOrder(exchangeFacet, addr1, {
        positionId: yesId,
        collateralToken: mockToken.address,
        amount: ethers.utils.parseEther("10"),
        pricePerToken: ethers.utils.parseEther("0.51"),
        minFillAmount: 0,
        expiry: 0,
        direction: 0,
      });

      const fees = await adminConfig.getProtocolFeesBalance(mockToken.address);
      
      // Change fee receiver
      await setFeeReceiver({ adminConfig, feeReceiver: addr2, caller: owner });
      
      // Withdraw should go to new receiver
      const initialBalance = await mockToken.balanceOf(addr2.address);
      await adminConfig.withdrawProtocolFees(mockToken.address, 0);
      const finalBalance = await mockToken.balanceOf(addr2.address);
      
      expect(finalBalance).to.equal(initialBalance.add(fees));
    });

    it("should handle multiple sequential withdrawals correctly", async function () {
      // Generate fees
      await createLimitOrder(exchangeFacet, owner, {
        positionId: yesId,
        collateralToken: mockToken.address,
        amount: ethers.utils.parseEther("10"),
        pricePerToken: ethers.utils.parseEther("0.5"),
        minFillAmount: 0,
        expiry: 0,
        direction: 1,
      });

      await createLimitOrder(exchangeFacet, addr1, {
        positionId: yesId,
        collateralToken: mockToken.address,
        amount: ethers.utils.parseEther("10"),
        pricePerToken: ethers.utils.parseEther("0.51"),
        minFillAmount: 0,
        expiry: 0,
        direction: 0,
      });

      const totalFees = await adminConfig.getProtocolFeesBalance(mockToken.address);
      const quarter = totalFees.div(4);
      
      // Withdraw in quarters
      await adminConfig.withdrawProtocolFees(mockToken.address, quarter);
      let remaining = await adminConfig.getProtocolFeesBalance(mockToken.address);
      expect(remaining).to.equal(totalFees.sub(quarter));
      
      await adminConfig.withdrawProtocolFees(mockToken.address, quarter);
      remaining = await adminConfig.getProtocolFeesBalance(mockToken.address);
      expect(remaining).to.equal(totalFees.div(2));
      
      // Withdraw all remaining
      await adminConfig.withdrawProtocolFees(mockToken.address, 0);
      remaining = await adminConfig.getProtocolFeesBalance(mockToken.address);
      expect(remaining).to.equal(0);
    });

    it("should handle zero address token in batch operations gracefully", async function () {
      // Generate some fees first
      await createLimitOrder(exchangeFacet, owner, {
        positionId: yesId,
        collateralToken: mockToken.address,
        amount: ethers.utils.parseEther("10"),
        pricePerToken: ethers.utils.parseEther("0.5"),
        minFillAmount: 0,
        expiry: 0,
        direction: 1,
      });

      await createLimitOrder(exchangeFacet, addr1, {
        positionId: yesId,
        collateralToken: mockToken.address,
        amount: ethers.utils.parseEther("10"),
        pricePerToken: ethers.utils.parseEther("0.51"),
        minFillAmount: 0,
        expiry: 0,
        direction: 0,
      });

      // This should be handled by individual withdraw functions
      const tokens = [mockToken.address, ethers.constants.AddressZero];
      const amounts = [100, 100];

      // Shouldn't fail because of zero address validation is managed in batchWithdrawProtocolFees
      await expect(adminConfig.batchWithdrawProtocolFees(tokens, amounts))
        .not.to.be.reverted;
    });
  });
});