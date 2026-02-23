# Doefin V2 Architecture Refactoring Guide

## Document Purpose

This guide provides **exact, step-by-step instructions** for refactoring Doefin V2 from the current architecture to the proposed domain-driven architecture. Every step includes:
- Exact file paths
- Complete function signatures
- Before/after code comparisons
- Testing requirements
- Rollback procedures

**Target Audience:** Development team and coding agents  
**Estimated Timeline:** 6-8 weeks  
**Risk Level:** Medium (comprehensive testing required)

---

## Table of Contents

1. [Pre-Refactoring Setup](#pre-refactoring-setup)
2. [Phase 1: Establish Cross-Currency Single Source of Truth](#phase-1-establish-cross-currency-single-source-of-truth)
3. [Phase 2: Consolidate Settlement Domain](#phase-2-consolidate-settlement-domain)
4. [Phase 3: Move Orchestration to Facets](#phase-3-move-orchestration-to-facets)
5. [Phase 4: Eliminate LibEscrowLogic](#phase-4-eliminate-libescrowlogic)
6. [Phase 5: Optimization & Cleanup](#phase-5-optimization--cleanup)
7. [Testing Requirements](#testing-requirements)
8. [Rollback Procedures](#rollback-procedures)

---

## Pre-Refactoring Setup

### Step 0.1: Create Feature Branch

```bash
git checkout -b refactor/architecture-consolidation
git push -u origin refactor/architecture-consolidation
```

### Step 0.2: Backup Current State

```bash
# Create snapshot branch
git checkout -b backup/pre-refactor-snapshot
git push -u origin backup/pre-refactor-snapshot
git checkout refactor/architecture-consolidation
```

### Step 0.3: Create Test Baseline

```bash
# Run full test suite and save results
npx hardhat test > test-baseline-before.log
npx hardhat coverage > coverage-baseline-before.log

# Save gas report
REPORT_GAS=true npx hardhat test > gas-baseline-before.log
```

**Acceptance Criteria:**
- ✅ All existing tests pass (100%)
- ✅ Coverage >= 85%
- ✅ Gas baseline established

### Step 0.4: Document Current Architecture

Create `docs/architecture-before.md`:

```markdown
# Current Architecture State (Before Refactor)

## Libraries
- LibOrderbook.sol - 850 lines
- LibEscrowLogic.sol - 320 lines
- LibCollateralManager.sol - 450 lines
- LibSettlement.sol - 680 lines
- LibTradeSettlement.sol - 920 lines
- LibQuoteCurrency.sol - 280 lines
- LibFeeManager.sol - 310 lines

## Call Flow Example (Order Creation)
OrderCreationFacet.createOrder()
  → LibOrderbook.createOrder() [Line 19]
    → LibEscrowLogic.lockCollateral() [Line 25]
      → LibCollateralManager.lockERC20Collateral() [Line 78]
    → LibOrderbook._tryFillImmediately() [Line 99]
      → LibSettlement.fillOrders() [Line 45]
        → LibTradeSettlement.settlementDispatcher() [Line 123]

## Cross-Currency Logic Locations
1. LibEscrowLogic.lockCollateral() - Lines 25-48
2. LibEscrowLogic.releaseCollateral() - Lines 51-73
3. LibTradeSettlement._handleCrossCurrencySettlement() - Lines 298-320
4. LibQuoteCurrency.getOracleExchangeRate() - Lines 89-115
```

---

## Phase 1: Establish Cross-Currency Single Source of Truth

**Goal:** Centralize ALL cross-currency conversion logic in LibQuoteCurrency, eliminating duplication.

**Duration:** Week 1-2  
**Risk:** Low (additive changes only, no deletions yet)

### Step 1.1: Enhance LibQuoteCurrency

**File:** `contracts/libraries/LibQuoteCurrency.sol`

#### Step 1.1.1: Add Comprehensive Data Structures

Add to top of LibQuoteCurrency.sol after existing structs:

```solidity
// ADD THESE STRUCTS

/// @notice Complete result of cross-currency calculation
/// @dev Single return type for all conversion operations
struct CrossCurrencyCalculation {
    uint256 collateralValue;      // Value in collateral currency
    uint256 quoteAmount;           // Amount in quote currency (before fees)
    uint256 quoteFee;              // Fee in quote currency
    uint256 totalQuoteRequired;    // Total quote currency needed (amount + fee)
    uint256 exchangeRate;          // Exchange rate used (for logging/verification)
    bool usedFallback;             // Whether fallback rate was used
}

/// @notice Parameters for cross-currency calculations
/// @dev Consolidates all inputs needed for conversion
struct CrossCurrencyParams {
    address quoteCurrency;         // Quote currency token address
    address collateralToken;       // Collateral token address
    uint256 amount;                // Amount of outcome tokens
    uint256 pricePerToken;         // Price per outcome token in collateral
    uint256 feeBps;                // Fee in basis points
    ExchangeRateType rateType;     // Type of exchange rate to use
    uint256 fixedRate;             // Fixed rate (if applicable)
}
```

#### Step 1.1.2: Add Core Calculation Function

Add this function to LibQuoteCurrency.sol:

```solidity
/// @notice Calculate all amounts for cross-currency operations
/// @dev Single source of truth for collateral → quote conversions
/// @param params Complete parameters for cross-currency calculation
/// @return calc Complete calculation results
function calculateCrossCurrencyAmounts(
    CrossCurrencyParams memory params
) internal view returns (CrossCurrencyCalculation memory calc) {
    AppStorage storage ds = LibDoefinStorage.appStorage();
    
    // Get collateral unit (how many units per full position pair)
    uint256 collateralUnit = ds.adminConfigStorage.unitPerPair[params.collateralToken];
    if (collateralUnit == 0) revert Errors.InvalidCollateralToken();
    
    // Step 1: Calculate collateral value
    // Formula: (amount * pricePerToken) / collateralUnit
    calc.collateralValue = (params.amount * params.pricePerToken) / collateralUnit;
    
    // Step 2: Get exchange rate with failover logic
    (calc.exchangeRate, calc.usedFallback) = _getExchangeRateWithFailover(
        params.quoteCurrency,
        params.collateralToken,
        params.rateType,
        params.fixedRate
    );
    
    // Step 3: Convert collateral value to quote currency
    // Formula: (collateralValue * exchangeRate) / 1e18
    // Note: Exchange rates are scaled by 1e18
    calc.quoteAmount = (calc.collateralValue * calc.exchangeRate) / 1e18;
    
    // Step 4: Calculate fee in quote currency
    // Formula: (quoteAmount * feeBps) / 10000
    calc.quoteFee = (calc.quoteAmount * params.feeBps) / 10_000;
    
    // Step 5: Calculate total quote currency required
    calc.totalQuoteRequired = calc.quoteAmount + calc.quoteFee;
    
    return calc;
}
```

#### Step 1.1.3: Add Reverse Calculation Function

Add this function to LibQuoteCurrency.sol:

```solidity
/// @notice Calculate collateral amount from quote currency amount
/// @dev Reverse calculation for unlocking/refunding
/// @param quoteCurrency Quote currency token address
/// @param collateralToken Collateral token address
/// @param quoteAmount Amount in quote currency
/// @param rateType Exchange rate type
/// @param fixedRate Fixed rate (if applicable)
/// @return collateralAmount Equivalent amount in collateral currency
function calculateCollateralFromQuote(
    address quoteCurrency,
    address collateralToken,
    uint256 quoteAmount,
    ExchangeRateType rateType,
    uint256 fixedRate
) internal view returns (uint256 collateralAmount) {
    // Get exchange rate
    (uint256 exchangeRate, ) = _getExchangeRateWithFailover(
        quoteCurrency,
        collateralToken,
        rateType,
        fixedRate
    );
    
    // Reverse calculation: (quoteAmount * 1e18) / exchangeRate
    collateralAmount = (quoteAmount * 1e18) / exchangeRate;
    
    return collateralAmount;
}
```

#### Step 1.1.4: Add Internal Helper (Failover Logic)

Add this private function to LibQuoteCurrency.sol:

```solidity
/// @notice Get exchange rate with automatic failover
/// @dev Attempts primary oracle, falls back to fixed rate, then emergency rate
/// @return rate Exchange rate (scaled by 1e18)
/// @return usedFallback Whether fallback rate was used
function _getExchangeRateWithFailover(
    address quoteCurrency,
    address collateralToken,
    ExchangeRateType rateType,
    uint256 fixedRate
) private view returns (uint256 rate, bool usedFallback) {
    if (rateType == ExchangeRateType.Dynamic) {
        // Try primary oracle
        (uint256 oracleRate, bool isStale) = getOracleExchangeRate(
            quoteCurrency,
            collateralToken
        );
        
        if (!isStale) {
            return (oracleRate, false);
        }
        
        // Oracle stale - use fallback if configured
        AppStorage storage ds = LibDoefinStorage.appStorage();
        uint256 fallbackRate = ds.quoteCurrencyStorage.emergencyExchangeRates[quoteCurrency][collateralToken];
        
        if (fallbackRate > 0) {
            return (fallbackRate, true);
        }
        
        // No fallback available
        revert Errors.OraclePriceStaleNoFallback();
    } else {
        // Fixed rate
        if (fixedRate == 0) revert Errors.InvalidFixedRate();
        return (fixedRate, false);
    }
}
```

#### Step 1.1.5: Add Validation Functions

Add these functions to LibQuoteCurrency.sol:

```solidity
/// @notice Validate cross-currency order configuration
/// @dev Ensures all cross-currency parameters are valid
function validateCrossCurrencyOrder(
    Order memory order
) internal view {
    if (order.orderType != OrderType.CrossCurrency) {
        return; // Not a cross-currency order
    }
    
    CrossCurrencyConfig memory config = order.crossCurrencyConfig;
    
    // Validate quote currency is not zero address
    if (config.quoteCurrencyToken == address(0)) {
        revert Errors.InvalidQuoteCurrency();
    }
    
    // Validate quote currency != collateral (no point in cross-currency)
    if (config.quoteCurrencyToken == order.collateralToken) {
        revert Errors.QuoteCurrencyMatchesCollateral();
    }
    
    // Validate quote currency is whitelisted
    AppStorage storage ds = LibDoefinStorage.appStorage();
    if (!ds.quoteCurrencyStorage.supportedQuoteCurrencies[config.quoteCurrencyToken]) {
        revert Errors.QuoteCurrencyNotSupported();
    }
    
    // Validate fixed rate if applicable
    if (config.exchangeRateType == ExchangeRateType.Fixed) {
        if (config.exchangeRate == 0) {
            revert Errors.InvalidFixedRate();
        }
    }
    
    // Validate direction (only Buy orders can be cross-currency in current design)
    if (order.direction != OrderDirection.Buy) {
        revert Errors.CrossCurrencySellNotSupported();
    }
}

/// @notice Validate cross-currency match compatibility
/// @dev Ensures maker and taker orders can be matched for cross-currency
function validateCrossCurrencyMatch(
    Order storage makerOrder,
    Order memory takerOrder
) internal view returns (bool isValid) {
    // Both must be cross-currency or neither
    bool makerIsCrossCurrency = (makerOrder.orderType == OrderType.CrossCurrency);
    bool takerIsCrossCurrency = (takerOrder.orderType == OrderType.CrossCurrency);
    
    // For now, don't allow cross-currency matching (too complex)
    // Both orders must use the same currency type
    if (makerIsCrossCurrency != takerIsCrossCurrency) {
        return false;
    }
    
    // If both cross-currency, must use same quote currency
    if (makerIsCrossCurrency && takerIsCrossCurrency) {
        if (makerOrder.crossCurrencyConfig.quoteCurrencyToken != 
            takerOrder.crossCurrencyConfig.quoteCurrencyToken) {
            return false;
        }
    }
    
    return true;
}
```

### Step 1.2: Create Migration Helper (Temporary)

**File:** `contracts/libraries/helpers/LibCrossCurrencyMigration.sol` (NEW)

Create this temporary file to help migration:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "../LibQuoteCurrency.sol";
import "../LibEscrowLogic.sol";

/// @title LibCrossCurrencyMigration
/// @notice Temporary helper to validate new cross-currency logic matches old logic
/// @dev DELETE THIS FILE after Phase 4 is complete
library LibCrossCurrencyMigration {
    /// @notice Compare old vs new cross-currency calculation
    /// @dev Used in tests to ensure refactor doesn't change behavior
    function validateCalculationsMatch(
        address quoteCurrency,
        address collateralToken,
        uint256 amount,
        uint256 pricePerToken,
        uint256 feeBps,
        LibQuoteCurrency.ExchangeRateType rateType,
        uint256 fixedRate
    ) internal view returns (bool) {
        // Calculate using OLD logic (LibEscrowLogic)
        // NOTE: This requires keeping LibEscrowLogic temporarily
        (uint256 oldQuoteAmount, uint256 oldFee) = LibEscrowLogic.calculateQuoteAmountOld(
            quoteCurrency,
            collateralToken,
            amount,
            pricePerToken,
            feeBps,
            rateType,
            fixedRate
        );
        
        // Calculate using NEW logic (LibQuoteCurrency)
        LibQuoteCurrency.CrossCurrencyParams memory params = LibQuoteCurrency.CrossCurrencyParams({
            quoteCurrency: quoteCurrency,
            collateralToken: collateralToken,
            amount: amount,
            pricePerToken: pricePerToken,
            feeBps: feeBps,
            rateType: rateType,
            fixedRate: fixedRate
        });
        
        LibQuoteCurrency.CrossCurrencyCalculation memory calc = 
            LibQuoteCurrency.calculateCrossCurrencyAmounts(params);
        
        // Compare results
        return (calc.quoteAmount == oldQuoteAmount && calc.quoteFee == oldFee);
    }
}
```

### Step 1.3: Add Tests for New Cross-Currency Functions

**File:** `test/libraries/LibQuoteCurrency.test.ts` (NEW or UPDATE)

Add comprehensive tests:

```typescript
import { expect } from "chai";
import { ethers } from "hardhat";
import { LibQuoteCurrencyTest } from "../typechain-types";

describe("LibQuoteCurrency", function() {
  let libTest: LibQuoteCurrencyTest;
  
  beforeEach(async function() {
    const LibQuoteCurrencyTestFactory = await ethers.getContractFactory("LibQuoteCurrencyTest");
    libTest = await LibQuoteCurrencyTestFactory.deploy();
    await libTest.deployed();
  });

  describe("calculateCrossCurrencyAmounts", function() {
    it("should calculate amounts correctly with dynamic rate", async function() {
      const params = {
        quoteCurrency: "0x...", // USDC address
        collateralToken: "0x...", // WBTC address
        amount: ethers.utils.parseEther("100"), // 100 outcome tokens
        pricePerToken: ethers.utils.parseEther("0.6"), // 0.6 WBTC per token
        feeBps: 30, // 0.3% fee
        rateType: 0, // Dynamic
        fixedRate: 0
      };
      
      const result = await libTest.calculateCrossCurrencyAmounts(params);
      
      // Verify structure
      expect(result.collateralValue).to.be.gt(0);
      expect(result.quoteAmount).to.be.gt(0);
      expect(result.quoteFee).to.equal(result.quoteAmount.mul(30).div(10000));
      expect(result.totalQuoteRequired).to.equal(result.quoteAmount.add(result.quoteFee));
      expect(result.exchangeRate).to.be.gt(0);
    });

    it("should calculate amounts correctly with fixed rate", async function() {
      const params = {
        quoteCurrency: "0x...",
        collateralToken: "0x...",
        amount: ethers.utils.parseEther("100"),
        pricePerToken: ethers.utils.parseEther("0.6"),
        feeBps: 30,
        rateType: 1, // Fixed
        fixedRate: ethers.utils.parseEther("50000") // 1 BTC = 50,000 USDC
      };
      
      const result = await libTest.calculateCrossCurrencyAmounts(params);
      
      // With fixed rate, should be deterministic
      expect(result.exchangeRate).to.equal(params.fixedRate);
      expect(result.usedFallback).to.be.false;
    });

    it("should use fallback rate when oracle is stale", async function() {
      // Setup: Make oracle stale, configure fallback
      await libTest.setOracleStale(true);
      await libTest.setFallbackRate(
        "0x...", // quoteCurrency
        "0x...", // collateralToken
        ethers.utils.parseEther("49000") // Fallback rate
      );
      
      const params = {
        quoteCurrency: "0x...",
        collateralToken: "0x...",
        amount: ethers.utils.parseEther("100"),
        pricePerToken: ethers.utils.parseEther("0.6"),
        feeBps: 30,
        rateType: 0, // Dynamic
        fixedRate: 0
      };
      
      const result = await libTest.calculateCrossCurrencyAmounts(params);
      
      expect(result.usedFallback).to.be.true;
      expect(result.exchangeRate).to.equal(ethers.utils.parseEther("49000"));
    });

    it("should revert when oracle stale and no fallback", async function() {
      await libTest.setOracleStale(true);
      // Don't set fallback
      
      const params = {
        quoteCurrency: "0x...",
        collateralToken: "0x...",
        amount: ethers.utils.parseEther("100"),
        pricePerToken: ethers.utils.parseEther("0.6"),
        feeBps: 30,
        rateType: 0, // Dynamic
        fixedRate: 0
      };
      
      await expect(
        libTest.calculateCrossCurrencyAmounts(params)
      ).to.be.revertedWith("OraclePriceStaleNoFallback");
    });
  });

  describe("calculateCollateralFromQuote", function() {
    it("should correctly reverse the conversion", async function() {
      const quoteCurrency = "0x...";
      const collateralToken = "0x...";
      const exchangeRate = ethers.utils.parseEther("50000"); // 1 BTC = 50,000 USDC
      
      await libTest.setFixedExchangeRate(quoteCurrency, collateralToken, exchangeRate);
      
      // Forward: 1 BTC → 50,000 USDC
      const params = {
        quoteCurrency,
        collateralToken,
        amount: ethers.utils.parseEther("100"),
        pricePerToken: ethers.utils.parseEther("0.01"), // 0.01 BTC per token = 1 BTC total
        feeBps: 0,
        rateType: 1, // Fixed
        fixedRate: exchangeRate
      };
      
      const forward = await libTest.calculateCrossCurrencyAmounts(params);
      
      // Reverse: 50,000 USDC → 1 BTC
      const reverse = await libTest.calculateCollateralFromQuote(
        quoteCurrency,
        collateralToken,
        forward.quoteAmount,
        1, // Fixed
        exchangeRate
      );
      
      // Should get back ~1 BTC (within rounding error)
      expect(reverse).to.be.closeTo(
        ethers.utils.parseEther("1"),
        ethers.utils.parseEther("0.000001") // 1e-6 tolerance
      );
    });
  });

  describe("validateCrossCurrencyOrder", function() {
    it("should accept valid cross-currency order", async function() {
      const order = {
        // ... order fields
        orderType: 2, // CrossCurrency
        direction: 0, // Buy
        collateralToken: "0x...",
        crossCurrencyConfig: {
          quoteCurrencyToken: "0x...", // Different from collateral
          exchangeRateType: 1, // Fixed
          exchangeRate: ethers.utils.parseEther("50000")
        }
      };
      
      await libTest.addSupportedQuoteCurrency(order.crossCurrencyConfig.quoteCurrencyToken);
      
      await expect(
        libTest.validateCrossCurrencyOrder(order)
      ).to.not.be.reverted;
    });

    it("should revert when quote currency == collateral", async function() {
      const tokenAddress = "0x...";
      const order = {
        orderType: 2, // CrossCurrency
        direction: 0, // Buy
        collateralToken: tokenAddress,
        crossCurrencyConfig: {
          quoteCurrencyToken: tokenAddress, // SAME as collateral
          exchangeRateType: 1,
          exchangeRate: ethers.utils.parseEther("1")
        }
      };
      
      await expect(
        libTest.validateCrossCurrencyOrder(order)
      ).to.be.revertedWith("QuoteCurrencyMatchesCollateral");
    });

    it("should revert when quote currency not supported", async function() {
      const order = {
        orderType: 2,
        direction: 0,
        collateralToken: "0x...",
        crossCurrencyConfig: {
          quoteCurrencyToken: "0x...", // Not whitelisted
          exchangeRateType: 1,
          exchangeRate: ethers.utils.parseEther("50000")
        }
      };
      
      // Don't add to supported currencies
      
      await expect(
        libTest.validateCrossCurrencyOrder(order)
      ).to.be.revertedWith("QuoteCurrencyNotSupported");
    });

    it("should revert when sell order is cross-currency", async function() {
      const order = {
        orderType: 2,
        direction: 1, // Sell
        collateralToken: "0x...",
        crossCurrencyConfig: {
          quoteCurrencyToken: "0x...",
          exchangeRateType: 1,
          exchangeRate: ethers.utils.parseEther("50000")
        }
      };
      
      await expect(
        libTest.validateCrossCurrencyOrder(order)
      ).to.be.revertedWith("CrossCurrencySellNotSupported");
    });
  });
});
```

### Step 1.4: Create Test Contract for LibQuoteCurrency

**File:** `contracts/test/LibQuoteCurrencyTest.sol` (NEW)

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "../libraries/LibQuoteCurrency.sol";
import "../libraries/LibDoefinStorage.sol";

/// @title LibQuoteCurrencyTest
/// @notice Test wrapper for LibQuoteCurrency internal functions
/// @dev Only for testing, not deployed to production
contract LibQuoteCurrencyTest {
    using LibQuoteCurrency for *;
    
    // Test helpers to simulate storage state
    mapping(address => mapping(address => uint256)) public unitPerPairTest;
    mapping(address => bool) public supportedQuoteCurrenciesTest;
    mapping(address => mapping(address => uint256)) public emergencyExchangeRatesTest;
    bool public oracleStaleTest;
    
    function calculateCrossCurrencyAmounts(
        LibQuoteCurrency.CrossCurrencyParams memory params
    ) external view returns (LibQuoteCurrency.CrossCurrencyCalculation memory) {
        return LibQuoteCurrency.calculateCrossCurrencyAmounts(params);
    }
    
    function calculateCollateralFromQuote(
        address quoteCurrency,
        address collateralToken,
        uint256 quoteAmount,
        LibQuoteCurrency.ExchangeRateType rateType,
        uint256 fixedRate
    ) external view returns (uint256) {
        return LibQuoteCurrency.calculateCollateralFromQuote(
            quoteCurrency,
            collateralToken,
            quoteAmount,
            rateType,
            fixedRate
        );
    }
    
    function validateCrossCurrencyOrder(
        LibDoefinStorage.Order memory order
    ) external view {
        LibQuoteCurrency.validateCrossCurrencyOrder(order);
    }
    
    // Test setup helpers
    function setUnitPerPair(address token, uint256 unit) external {
        unitPerPairTest[token] = unit;
    }
    
    function addSupportedQuoteCurrency(address currency) external {
        supportedQuoteCurrenciesTest[currency] = true;
    }
    
    function setFallbackRate(address quote, address collateral, uint256 rate) external {
        emergencyExchangeRatesTest[quote][collateral] = rate;
    }
    
    function setOracleStale(bool stale) external {
        oracleStaleTest = stale;
    }
}
```

### Step 1.5: Run Migration Validation Tests

Create validation test that compares old vs new logic:

**File:** `test/migration/CrossCurrencyMigration.test.ts` (NEW)

```typescript
import { expect } from "chai";
import { ethers } from "hardhat";

describe("Cross-Currency Migration Validation", function() {
  // This test ensures new logic produces same results as old logic
  
  it("should produce identical results for all test cases", async function() {
    const testCases = [
      {
        name: "Standard BTC-USDC conversion",
        quoteCurrency: "0x...",
        collateralToken: "0x...",
        amount: ethers.utils.parseEther("100"),
        pricePerToken: ethers.utils.parseEther("0.6"),
        feeBps: 30,
        rateType: 1,
        fixedRate: ethers.utils.parseEther("50000")
      },
      {
        name: "Large amount conversion",
        quoteCurrency: "0x...",
        collateralToken: "0x...",
        amount: ethers.utils.parseEther("10000"),
        pricePerToken: ethers.utils.parseEther("0.45"),
        feeBps: 50,
        rateType: 1,
        fixedRate: ethers.utils.parseEther("48000")
      },
      // Add more test cases
    ];
    
    for (const testCase of testCases) {
      const matches = await migrationHelper.validateCalculationsMatch(
        testCase.quoteCurrency,
        testCase.collateralToken,
        testCase.amount,
        testCase.pricePerToken,
        testCase.feeBps,
        testCase.rateType,
        testCase.fixedRate
      );
      
      expect(matches, `Failed for: ${testCase.name}`).to.be.true;
    }
  });
});
```

### Step 1.6: Integration Test with Existing System

**File:** `test/integration/CrossCurrencyIntegration.test.ts` (UPDATE)

Update existing integration tests to call new LibQuoteCurrency functions:

```typescript
describe("Cross-Currency Integration Tests", function() {
  it("should create cross-currency order using new calculation", async function() {
    // Create order with cross-currency config
    const tx = await orderCreationFacet.createOrder({
      // ... order params
      orderType: 2, // CrossCurrency
      crossCurrencyConfig: {
        quoteCurrencyToken: usdcAddress,
        exchangeRateType: 1, // Fixed
        exchangeRate: ethers.utils.parseEther("50000")
      }
    });
    
    await tx.wait();
    
    // Verify collateral locked correctly
    const lockedBalance = await collateralManager.getERC20Balance(
      user.address,
      usdcAddress
    );
    
    expect(lockedBalance).to.be.gt(0);
    
    // Compare with expected calculation
    const expected = await libQuoteCurrency.calculateCrossCurrencyAmounts({
      // ... same params
    });
    
    expect(lockedBalance).to.equal(expected.totalQuoteRequired);
  });
});
```

### Step 1.7: Checkpoint & Review

**Testing Checklist:**
- ✅ All new LibQuoteCurrency functions have unit tests
- ✅ Migration validation tests pass (old == new)
- ✅ Integration tests pass with new functions
- ✅ Gas report generated (should show minimal change)
- ✅ Code review completed

**Acceptance Criteria for Phase 1:**
- [ ] LibQuoteCurrency.calculateCrossCurrencyAmounts() fully tested
- [ ] LibQuoteCurrency.calculateCollateralFromQuote() fully tested
- [ ] LibQuoteCurrency.validateCrossCurrencyOrder() fully tested
- [ ] Migration validation shows 100% match with old logic
- [ ] All existing tests still pass
- [ ] Gas usage unchanged (±1%)

**Review Questions:**
1. Do all test cases from old logic pass with new logic?
2. Are edge cases covered (zero amounts, max values, stale oracle)?
3. Is error handling consistent with existing patterns?

**Commit & Push:**
```bash
git add contracts/libraries/LibQuoteCurrency.sol
git add contracts/libraries/helpers/LibCrossCurrencyMigration.sol
git add contracts/test/LibQuoteCurrencyTest.sol
git add test/libraries/LibQuoteCurrency.test.ts
git add test/migration/CrossCurrencyMigration.test.ts
git commit -m "Phase 1: Add centralized cross-currency calculation to LibQuoteCurrency"
git push origin refactor/architecture-consolidation
```

---

## Phase 2: Consolidate Settlement Domain

**Goal:** Merge LibSettlement and LibTradeSettlement into unified settlement architecture with clear separation between coordination, calculation, and execution.

**Duration:** Week 3-4  
**Risk:** Medium (complex logic changes)

### Step 2.1: Create LibSettlementCalculator

**File:** `contracts/libraries/LibSettlementCalculator.sol` (NEW)

Create new file with ALL pure calculation functions:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./LibDoefinStorage.sol";
import "../interfaces/Errors.sol";

/// @title LibSettlementCalculator
/// @notice Pure calculation functions for settlement operations
/// @dev No storage access, no side effects - only math
library LibSettlementCalculator {
    using LibDoefinStorage for *;
    
    /// @notice Complete fee calculation result
    struct FeeCalculation {
        uint256 tradeCost;           // Base cost of trade in collateral
        uint256 makerFee;            // Fee paid by maker
        uint256 takerFee;            // Fee paid by taker
        uint256 totalFees;           // Total protocol fees (maker + taker)
        uint256 makerNet;            // Net amount for maker (cost - fee)
        uint256 takerCost;           // Total cost for taker (cost + fee)
    }
    
    /// @notice Calculate fees for complementary match
    /// @param fillAmount Amount of outcome tokens being traded
    /// @param effectivePrice Price per token
    /// @param collateralUnit Unit per pair for the collateral token
    /// @param makerFeeBps Maker fee in basis points
    /// @param takerFeeBps Taker fee in basis points
    /// @return fees Complete fee calculation
    function calculateComplementaryFees(
        uint256 fillAmount,
        uint256 effectivePrice,
        uint256 collateralUnit,
        uint256 makerFeeBps,
        uint256 takerFeeBps
    ) internal pure returns (FeeCalculation memory fees) {
        // Calculate trade cost: (amount * price) / unit
        fees.tradeCost = (fillAmount * effectivePrice) / collateralUnit;
        
        // Calculate maker fee: (cost * bps) / 10000
        fees.makerFee = (fees.tradeCost * makerFeeBps) / 10_000;
        
        // Calculate taker fee: (cost * bps) / 10000
        fees.takerFee = (fees.tradeCost * takerFeeBps) / 10_000;
        
        // Total protocol fees
        fees.totalFees = fees.makerFee + fees.takerFee;
        
        // Net amounts
        fees.makerNet = fees.tradeCost - fees.makerFee;
        fees.takerCost = fees.tradeCost + fees.takerFee;
        
        return fees;
    }
    
    /// @notice Calculate fees for mint/merge operations
    /// @param fillAmount Amount being minted/merged
    /// @param collateralPerPair Collateral required per full pair
    /// @param makerFeeBps Maker fee in basis points
    /// @param takerFeeBps Taker fee in basis points
    /// @return fees Complete fee calculation
    function calculateMintMergeFees(
        uint256 fillAmount,
        uint256 collateralPerPair,
        uint256 makerFeeBps,
        uint256 takerFeeBps
    ) internal pure returns (FeeCalculation memory fees) {
        // For mint/merge, each party contributes half the collateral
        fees.tradeCost = collateralPerPair / 2;
        
        // Calculate fees on each party's contribution
        fees.makerFee = (fees.tradeCost * makerFeeBps) / 10_000;
        fees.takerFee = (fees.tradeCost * takerFeeBps) / 10_000;
        
        fees.totalFees = fees.makerFee + fees.takerFee;
        fees.makerNet = fees.tradeCost - fees.makerFee;
        fees.takerCost = fees.tradeCost + fees.takerFee;
        
        return fees;
    }
    
    /// @notice Calculate maximum fillable amount for a match
    /// @param takerRemainingAmount Taker's remaining unfilled amount
    /// @param makerRemainingAmount Maker's remaining unfilled amount
    /// @param requestedFillAmount Requested fill amount from match
    /// @param makerMinFillAmount Maker's minimum fill requirement
    /// @return fillAmount Actual amount that can be filled (0 if cannot fill)
    function calculateFillableAmount(
        uint256 takerRemainingAmount,
        uint256 makerRemainingAmount,
        uint256 requestedFillAmount,
        uint256 makerMinFillAmount
    ) internal pure returns (uint256 fillAmount) {
        // Take minimum of all constraints
        fillAmount = min3(
            requestedFillAmount,
            takerRemainingAmount,
            makerRemainingAmount
        );
        
        // Check minimum fill requirement
        if (fillAmount < makerMinFillAmount) {
            return 0; // Cannot fill - below minimum
        }
        
        return fillAmount;
    }
    
    /// @notice Calculate effective price for taker based on match type
    /// @param makerPrice Maker's order price
    /// @param takerDirection Taker's order direction
    /// @param matchType Type of match being executed
    /// @return effectivePrice Price taker will pay
    function calculateEffectivePrice(
        uint256 makerPrice,
        LibDoefinStorage.OrderDirection takerDirection,
        LibDoefinStorage.MatchType matchType
    ) internal pure returns (uint256 effectivePrice) {
        if (matchType == LibDoefinStorage.MatchType.Complementary) {
            // Complementary: taker pays maker's price
            return makerPrice;
        } else {
            // Mint/Merge: price is based on probability
            // For mint: buying outcome = pay P, buying opposite = pay (1-P)
            // For merge: effective price depends on which position
            
            // This logic should match your existing MatchEngine
            // Placeholder - implement based on your specific logic
            return makerPrice;
        }
    }
    
    /// @notice Calculate average price for market order validation
    /// @param totalValue Total value traded (sum of fillAmount * price)
    /// @param totalAmount Total amount filled
    /// @param collateralUnit Unit per pair for collateral
    /// @return averagePrice Average price paid per token
    function calculateAveragePrice(
        uint256 totalValue,
        uint256 totalAmount,
        uint256 collateralUnit
    ) internal pure returns (uint256 averagePrice) {
        if (totalAmount == 0) return 0;
        
        // Average price = (totalValue * unit) / totalAmount
        averagePrice = (totalValue * collateralUnit) / totalAmount;
        
        return averagePrice;
    }
    
    /// @notice Check if average price meets market order requirement
    /// @param averagePrice Calculated average price
    /// @param limitPrice Market order's price limit
    /// @param direction Order direction (buy or sell)
    /// @return meetsRequirement True if average price is acceptable
    function meetsAveragePriceRequirement(
        uint256 averagePrice,
        uint256 limitPrice,
        LibDoefinStorage.OrderDirection direction
    ) internal pure returns (bool meetsRequirement) {
        if (direction == LibDoefinStorage.OrderDirection.Buy) {
            // Buyer: average price must be <= limit
            return averagePrice <= limitPrice;
        } else {
            // Seller: average price must be >= limit
            return averagePrice >= limitPrice;
        }
    }
    
    /// @notice Check if taker's order would cross with maker's order
    /// @param makerPrice Maker's price per token
    /// @param takerPrice Taker's price per token
    /// @param makerDirection Maker's order direction
    /// @param takerDirection Taker's order direction
    /// @return crosses True if orders cross
    function pricesCross(
        uint256 makerPrice,
        uint256 takerPrice,
        LibDoefinStorage.OrderDirection makerDirection,
        LibDoefinStorage.OrderDirection takerDirection
    ) internal pure returns (bool crosses) {
        // Orders must be in opposite directions
        if (makerDirection == takerDirection) {
            return false;
        }
        
        if (makerDirection == LibDoefinStorage.OrderDirection.Buy) {
            // Maker buying, taker selling: maker's bid >= taker's ask
            return makerPrice >= takerPrice;
        } else {
            // Maker selling, taker buying: taker's bid >= maker's ask
            return takerPrice >= makerPrice;
        }
    }
    
    // ========================================
    // INTERNAL HELPERS
    // ========================================
    
    /// @notice Return minimum of three values
    function min3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256) {
        return min(min(a, b), c);
    }
    
    /// @notice Return minimum of two values
    function min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
```

### Step 2.2: Create LibSettlementExecutor

**File:** `contracts/libraries/LibSettlementExecutor.sol` (NEW)

Create new file with ALL execution functions:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./LibDoefinStorage.sol";
import "./LibSettlementCalculator.sol";
import "./LibCollateralManager.sol";
import "./LibQuoteCurrency.sol";
import "./LibFeeManager.sol";
import "../interfaces/Errors.sol";

/// @title LibSettlementExecutor
/// @notice Executes token transfers and CTF operations for settlements
/// @dev Focused on execution only - no coordination logic
library LibSettlementExecutor {
    using LibDoefinStorage for *;
    
    /// @notice Context for settlement execution
    struct SettlementContext {
        address taker;                           // Taker address
        address maker;                           // Maker address (from storage)
        uint256 positionId;                      // Position ID being traded
        address collateralToken;                 // Collateral token address
        uint256 fillAmount;                      // Amount to fill
        uint256 effectivePrice;                  // Price for this fill
        LibDoefinStorage.OrderDirection takerDirection;  // Taker's direction
        LibDoefinStorage.OrderDirection makerDirection;  // Maker's direction
        LibDoefinStorage.MatchType matchType;    // Type of match
        LibDoefinStorage.OrderType makerOrderType; // Maker's order type
        LibDoefinStorage.CrossCurrencyConfig crossCurrencyConfig; // If cross-currency
        uint256 makerFeeBps;                     // Maker fee
        uint256 takerFeeBps;                     // Taker fee
        bool isMarketOrder;                      // Whether taker is market order
    }
    
    /// @notice Execute settlement based on match type
    /// @param ctx Complete settlement context
    function executeSettlement(SettlementContext memory ctx) internal {
        // Route to appropriate handler based on match type
        if (ctx.matchType == LibDoefinStorage.MatchType.Complementary) {
            _executeComplementary(ctx);
        } else if (ctx.matchType == LibDoefinStorage.MatchType.Mint) {
            _executeMint(ctx);
        } else if (ctx.matchType == LibDoefinStorage.MatchType.Merge) {
            _executeMerge(ctx);
        } else {
            revert Errors.InvalidMatchType();
        }
    }
    
    // ========================================
    // COMPLEMENTARY MATCH HANDLERS
    // ========================================
    
    /// @notice Execute complementary match (direct position trading)
    function _executeComplementary(SettlementContext memory ctx) private {
        AppStorage storage ds = LibDoefinStorage.appStorage();
        uint256 collateralUnit = ds.adminConfigStorage.unitPerPair[ctx.collateralToken];
        
        // Calculate fees
        LibSettlementCalculator.FeeCalculation memory fees = 
            LibSettlementCalculator.calculateComplementaryFees(
                ctx.fillAmount,
                ctx.effectivePrice,
                collateralUnit,
                ctx.makerFeeBps,
                ctx.takerFeeBps
            );
        
        // Route based on taker direction
        if (ctx.takerDirection == LibDoefinStorage.OrderDirection.Buy) {
            _executeComplementaryBuy(ctx, fees);
        } else {
            _executeComplementarySell(ctx, fees);
        }
        
        // Accrue protocol fees
        LibFeeManager.accrueFees(fees.makerFee, fees.takerFee, ctx.collateralToken);
    }
    
    /// @notice Execute complementary buy (taker buying, maker selling)
    function _executeComplementaryBuy(
        SettlementContext memory ctx,
        LibSettlementCalculator.FeeCalculation memory fees
    ) private {
        // CHECKS-EFFECTS-INTERACTIONS PATTERN
        
        // 1. EFFECTS - Update state first
        
        // Consume maker's locked position tokens
        LibCollateralManager.consumeERC1155(
            ctx.maker,
            ctx.positionId,
            ctx.fillAmount
        );
        
        // 2. INTERACTIONS - External calls last
        
        // Handle taker payment
        if (ctx.isMarketOrder) {
            // Market order: collect from taker
            LibCollateralManager.lockERC20(
                ctx.taker,
                ctx.collateralToken,
                fees.takerCost
            );
        } else {
            // Limit order: consume locked collateral
            LibCollateralManager.consumeERC20(
                ctx.taker,
                ctx.collateralToken,
                fees.takerCost
            );
        }
        
        // Transfer collateral to maker (net of fees)
        LibCollateralManager.releaseERC20(
            ctx.maker,
            ctx.collateralToken,
            fees.makerNet
        );
        
        // Transfer position tokens to taker
        _transferPositionTokens(ctx.taker, ctx.positionId, ctx.fillAmount);
    }
    
    /// @notice Execute complementary sell (taker selling, maker buying)
    function _executeComplementarySell(
        SettlementContext memory ctx,
        LibSettlementCalculator.FeeCalculation memory fees
    ) private {
        // CHECKS-EFFECTS-INTERACTIONS PATTERN
        
        // 1. EFFECTS
        
        // Consume taker's position tokens
        if (ctx.isMarketOrder) {
            // Market order: collect position tokens
            LibCollateralManager.lockERC1155(
                ctx.taker,
                ctx.positionId,
                ctx.fillAmount
            );
        }
        LibCollateralManager.consumeERC1155(
            ctx.taker,
            ctx.positionId,
            ctx.fillAmount
        );
        
        // Consume maker's locked collateral
        LibCollateralManager.consumeERC20(
            ctx.maker,
            ctx.collateralToken,
            fees.makerNet + fees.makerFee
        );
        
        // 2. INTERACTIONS
        
        // Transfer collateral to taker (cost - fee)
        _transferCollateral(ctx.taker, ctx.collateralToken, fees.tradeCost - fees.takerFee);
        
        // Transfer position tokens to maker
        _transferPositionTokens(ctx.maker, ctx.positionId, ctx.fillAmount);
    }
    
    /// @notice Execute cross-currency complementary match
    function _executeCrossCurrencyComplementary(
        SettlementContext memory ctx,
        LibSettlementCalculator.FeeCalculation memory fees
    ) private {
        // Use LibQuoteCurrency for all quote currency calculations
        LibQuoteCurrency.CrossCurrencyParams memory params = LibQuoteCurrency.CrossCurrencyParams({
            quoteCurrency: ctx.crossCurrencyConfig.quoteCurrencyToken,
            collateralToken: ctx.collateralToken,
            amount: ctx.fillAmount,
            pricePerToken: ctx.effectivePrice,
            feeBps: ctx.makerFeeBps,
            rateType: ctx.crossCurrencyConfig.exchangeRateType,
            fixedRate: ctx.crossCurrencyConfig.exchangeRate
        });
        
        LibQuoteCurrency.CrossCurrencyCalculation memory calc = 
            LibQuoteCurrency.calculateCrossCurrencyAmounts(params);
        
        // Execute transfer in quote currency
        if (ctx.takerDirection == LibDoefinStorage.OrderDirection.Buy) {
            // Taker pays in quote currency
            LibCollateralManager.consumeERC20(
                ctx.maker,
                ctx.crossCurrencyConfig.quoteCurrencyToken,
                calc.totalQuoteRequired
            );
            
            // Rest is similar to regular complementary
            LibCollateralManager.consumeERC1155(ctx.maker, ctx.positionId, ctx.fillAmount);
            _transferPositionTokens(ctx.taker, ctx.positionId, ctx.fillAmount);
        }
        
        // Accrue fees in quote currency
        LibFeeManager.accrueFees(
            calc.quoteFee,
            0, // Taker fee included in quote
            ctx.crossCurrencyConfig.quoteCurrencyToken
        );
    }
    
    // ========================================
    // MINT MATCH HANDLER
    // ========================================
    
    /// @notice Execute mint match (split collateral into positions)
    function _executeMint(SettlementContext memory ctx) private {
        AppStorage storage ds = LibDoefinStorage.appStorage();
        uint256 collateralUnit = ds.adminConfigStorage.unitPerPair[ctx.collateralToken];
        
        // Calculate collateral required
        uint256 collateralPerPair = (ctx.fillAmount * collateralUnit) / 1e18;
        
        // Calculate fees
        LibSettlementCalculator.FeeCalculation memory fees = 
            LibSettlementCalculator.calculateMintMergeFees(
                ctx.fillAmount,
                collateralPerPair,
                ctx.makerFeeBps,
                ctx.takerFeeBps
            );
        
        // Collect collateral from both parties
        _collectCollateralForMint(ctx, fees);
        
        // Execute CTF split operation
        _executeSplitOperation(ctx, collateralPerPair);
        
        // Distribute position tokens
        _distributePositionTokensAfterMint(ctx);
        
        // Accrue fees
        LibFeeManager.accrueFees(fees.makerFee, fees.takerFee, ctx.collateralToken);
    }
    
    // ========================================
    // MERGE MATCH HANDLER
    // ========================================
    
    /// @notice Execute merge match (merge positions into collateral)
    function _executeMerge(SettlementContext memory ctx) private {
        AppStorage storage ds = LibDoefinStorage.appStorage();
        uint256 collateralUnit = ds.adminConfigStorage.unitPerPair[ctx.collateralToken];
        
        // Calculate collateral to be released
        uint256 collateralPerPair = (ctx.fillAmount * collateralUnit) / 1e18;
        
        // Calculate fees
        LibSettlementCalculator.FeeCalculation memory fees = 
            LibSettlementCalculator.calculateMintMergeFees(
                ctx.fillAmount,
                collateralPerPair,
                ctx.makerFeeBps,
                ctx.takerFeeBps
            );
        
        // Consume position tokens from both parties
        _consumePositionTokensForMerge(ctx);
        
        // Execute CTF merge operation
        _executeMergeOperation(ctx, collateralPerPair);
        
        // Distribute collateral (minus fees)
        _distributeCollateralAfterMerge(ctx, fees);
        
        // Accrue fees
        LibFeeManager.accrueFees(fees.makerFee, fees.takerFee, ctx.collateralToken);
    }
    
    // ========================================
    // INTERNAL HELPERS - COLLATERAL TRANSFERS
    // ========================================
    
    function _transferCollateral(address to, address token, uint256 amount) private {
        LibCollateralManager.releaseERC20(to, token, amount);
    }
    
    function _transferPositionTokens(address to, uint256 positionId, uint256 amount) private {
        // Transfer from this contract to user
        // Implementation depends on your CTF integration
        AppStorage storage ds = LibDoefinStorage.appStorage();
        ds.ctfContract.safeTransferFrom(
            address(this),
            to,
            positionId,
            amount,
            ""
        );
    }
    
    function _collectCollateralForMint(
        SettlementContext memory ctx,
        LibSettlementCalculator.FeeCalculation memory fees
    ) private {
        // Each party contributes half + their fee
        if (ctx.isMarketOrder) {
            LibCollateralManager.lockERC20(ctx.taker, ctx.collateralToken, fees.takerCost);
        } else {
            LibCollateralManager.consumeERC20(ctx.taker, ctx.collateralToken, fees.takerCost);
        }
        
        LibCollateralManager.consumeERC20(ctx.maker, ctx.collateralToken, fees.makerNet + fees.makerFee);
    }
    
    // ========================================
    // INTERNAL HELPERS - CTF OPERATIONS
    // ========================================
    
    function _executeSplitOperation(SettlementContext memory ctx, uint256 collateralAmount) private {
        AppStorage storage ds = LibDoefinStorage.appStorage();
        
        // Split collateral into position tokens
        // This calls your CTF contract's split function
        ds.ctfContract.splitPosition(
            ctx.collateralToken,
            bytes32(0), // parentCollectionId - depends on your setup
            ctx.positionId, // conditionId
            partition, // partition array
            collateralAmount
        );
    }
    
    function _executeMergeOperation(SettlementContext memory ctx, uint256 collateralAmount) private {
        AppStorage storage ds = LibDoefinStorage.appStorage();
        
        // Merge position tokens back into collateral
        ds.ctfContract.mergePositions(
            ctx.collateralToken,
            bytes32(0),
            ctx.positionId,
            partition,
            collateralAmount
        );
    }
    
    function _distributePositionTokensAfterMint(SettlementContext memory ctx) private {
        // Distribute newly minted position tokens to participants
        // Taker gets one position, maker gets the complement
        uint256 complementPositionId = getComplementPosition(ctx.positionId);
        
        _transferPositionTokens(ctx.taker, ctx.positionId, ctx.fillAmount);
        _transferPositionTokens(ctx.maker, complementPositionId, ctx.fillAmount);
    }
    
    function _consumePositionTokensForMerge(SettlementContext memory ctx) private {
        // Consume complementary position tokens from both parties
        uint256 complementPositionId = getComplementPosition(ctx.positionId);
        
        LibCollateralManager.consumeERC1155(ctx.taker, ctx.positionId, ctx.fillAmount);
        LibCollateralManager.consumeERC1155(ctx.maker, complementPositionId, ctx.fillAmount);
    }
    
    function _distributeCollateralAfterMerge(
        SettlementContext memory ctx,
        LibSettlementCalculator.FeeCalculation memory fees
    ) private {
        // Each party gets half the collateral minus their fee
        _transferCollateral(ctx.taker, ctx.collateralToken, fees.tradeCost - fees.takerFee);
        _transferCollateral(ctx.maker, ctx.collateralToken, fees.tradeCost - fees.makerFee);
    }
    
    function getComplementPosition(uint256 positionId) private pure returns (uint256) {
        // Your logic to get complement position ID
        // This depends on how you structure position IDs
        return positionId ^ 1; // Example: flip last bit
    }
}
```

### Step 2.3: Refactor LibSettlement (Coordinator)

**File:** `contracts/libraries/LibSettlement.sol` (MODIFY)

Replace existing LibSettlement with coordinator-only logic:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./LibDoefinStorage.sol";
import "./LibSettlementExecutor.sol";
import "./LibSettlementCalculator.sol";
import "./LibOrderbook.sol";
import "../interfaces/Events.sol";
import "../interfaces/Errors.sol";

/// @title LibSettlement
/// @notice Coordinates settlement workflow - loops, validation, state updates
/// @dev Delegates execution to LibSettlementExecutor, calculations to LibSettlementCalculator
library LibSettlement {
    using LibDoefinStorage for *;
    
    /// @notice Taker order context for settlement
    struct TakerOrderContext {
        address taker;                              // Taker address
        uint256 orderId;                            // Taker order ID (0 for market orders)
        uint256 positionId;                         // Position ID
        address collateralToken;                    // Collateral token
        uint256 amount;                             // Total order amount
        uint256 remainingAmount;                    // Remaining unfilled amount
        uint256 pricePerToken;                      // Price per token
        LibDoefinStorage.OrderDirection direction;  // Buy or sell
        LibDoefinStorage.ExecutionType executionType; // Market or limit
        uint256 takerFeeBps;                        // Taker fee
        bool fillOrKill;                            // FOK requirement
    }
    
    /// @notice Match execution data
    struct Match {
        uint256 matchedOrderId;                     // Maker order ID
        uint256 fillAmount;                         // Amount to fill
        LibDoefinStorage.MatchType matchType;       // Type of match
    }
    
    // ========================================
    // ENTRY POINTS
    // ========================================
    
    /// @notice Execute settlement for market order with precomputed route
    /// @dev Called by MarketExecutionFacet with off-chain computed matches
    /// @param takerOrder Taker order context
    /// @param matches Array of matches to execute
    function executeMatchedRoute(
        TakerOrderContext memory takerOrder,
        Match[] memory matches
    ) internal {
        _executeMatches(takerOrder, matches, true);
    }
    
    /// @notice Execute settlement for limit order
    /// @dev Called by OrderCreationFacet after order creation
    /// @param takerOrderId ID of the taker order (must be in storage)
    /// @param makerOrderIds Array of maker order IDs to match against
    function executeMatchesForOrder(
        uint256 takerOrderId,
        uint256[] memory makerOrderIds
    ) internal {
        AppStorage storage ds = LibDoefinStorage.appStorage();
        
        // Load taker order from storage
        LibDoefinStorage.Order storage takerOrder = ds.orderbookStorage.orders[takerOrderId];
        
        if (!takerOrder.active) revert Errors.OrderNotActive();
        
        // Build taker context
        TakerOrderContext memory takerCtx = TakerOrderContext({
            taker: takerOrder.maker, // Order's maker is the taker in settlement
            orderId: takerOrderId,
            positionId: takerOrder.positionId,
            collateralToken: takerOrder.collateralToken,
            amount: takerOrder.amount,
            remainingAmount: takerOrder.remainingAmount,
            pricePerToken: takerOrder.pricePerToken,
            direction: takerOrder.direction,
            executionType: takerOrder.executionType,
            takerFeeBps: 0, // Limit order pays maker fee, not taker fee
            fillOrKill: takerOrder.fillOrKill
        });
        
        // Generate matches
        Match[] memory matches = _generateMatches(takerCtx, makerOrderIds);
        
        // Execute settlement
        _executeMatches(takerCtx, matches, false);
        
        // Update stored order
        takerOrder.remainingAmount = takerCtx.remainingAmount;
        
        if (takerCtx.remainingAmount == 0) {
            takerOrder.active = false;
            LibOrderbook.removeFromOrderbook(takerOrder);
        }
    }
    
    // ========================================
    // CORE SETTLEMENT FLOW
    // ========================================
    
    /// @notice Execute all matches in sequence
    /// @dev Main settlement loop - coordinates execution
    /// @param takerCtx Taker order context (mutable)
    /// @param matches Array of matches to execute
    /// @param isMarketOrder Whether taker is market order
    function _executeMatches(
        TakerOrderContext memory takerCtx,
        Match[] memory matches,
        bool isMarketOrder
    ) private {
        AppStorage storage ds = LibDoefinStorage.appStorage();
        uint256 totalValue = 0;
        uint256 totalFilled = 0;
        uint256 collateralUnit = ds.adminConfigStorage.unitPerPair[takerCtx.collateralToken];
        
        // Loop through all matches
        for (uint256 i = 0; i < matches.length && takerCtx.remainingAmount > 0; ++i) {
            Match memory matchExec = matches[i];
            LibDoefinStorage.Order storage makerOrder = ds.orderbookStorage.orders[matchExec.matchedOrderId];
            
            // Validate match can be executed
            (bool valid, uint256 fillAmount, uint256 effectivePrice) = _validateMatch(
                takerCtx,
                makerOrder,
                matchExec,
                isMarketOrder
            );
            
            if (!valid || fillAmount == 0) {
                continue; // Skip invalid matches
            }
            
            // Build settlement context
            LibSettlementExecutor.SettlementContext memory settlementCtx = 
                _buildSettlementContext(takerCtx, makerOrder, fillAmount, effectivePrice, matchExec.matchType);
            
            // Execute settlement (delegates to LibSettlementExecutor)
            LibSettlementExecutor.executeSettlement(settlementCtx);
            
            // Update state
            takerCtx.remainingAmount -= fillAmount;
            totalValue += (fillAmount * effectivePrice) / collateralUnit;
            totalFilled += fillAmount;
            
            // Update maker order
            _updateMakerOrder(makerOrder, fillAmount);
            
            // Emit trade event
            _emitTradeEvent(takerCtx, makerOrder, fillAmount, effectivePrice, matchExec.matchType);
        }
        
        // Validate average price for market orders
        if (isMarketOrder && totalFilled > 0) {
            uint256 avgPrice = LibSettlementCalculator.calculateAveragePrice(
                totalValue,
                totalFilled,
                collateralUnit
            );
            
            if (!LibSettlementCalculator.meetsAveragePriceRequirement(
                avgPrice,
                takerCtx.pricePerToken,
                takerCtx.direction
            )) {
                revert Errors.AveragePriceNotMet();
            }
        }
    }
    
    // ========================================
    // VALIDATION
    // ========================================
    
    /// @notice Validate a match can be executed
    /// @return valid Whether match is valid
    /// @return fillAmount Amount that can be filled
    /// @return effectivePrice Effective price for this fill
    function _validateMatch(
        TakerOrderContext memory takerCtx,
        LibDoefinStorage.Order storage makerOrder,
        Match memory matchExec,
        bool isMarketOrder
    ) private view returns (bool valid, uint256 fillAmount, uint256 effectivePrice) {
        // Check maker order is active
        if (!makerOrder.active) {
            return (false, 0, 0);
        }
        
        // Check not expired
        if (makerOrder.expiry != 0 && block.timestamp >= makerOrder.expiry) {
            return (false, 0, 0);
        }
        
        // Check prices cross (for complementary matches)
        if (matchExec.matchType == LibDoefinStorage.MatchType.Complementary) {
            if (!LibSettlementCalculator.pricesCross(
                makerOrder.pricePerToken,
                takerCtx.pricePerToken,
                makerOrder.direction,
                takerCtx.direction
            )) {
                return (false, 0, 0);
            }
        }
        
        // Calculate fillable amount
        fillAmount = LibSettlementCalculator.calculateFillableAmount(
            takerCtx.remainingAmount,
            makerOrder.remainingAmount,
            matchExec.fillAmount,
            makerOrder.minFillAmount
        );
        
        if (fillAmount == 0) {
            return (false, 0, 0);
        }
        
        // Calculate effective price
        effectivePrice = LibSettlementCalculator.calculateEffectivePrice(
            makerOrder.pricePerToken,
            takerCtx.direction,
            matchExec.matchType
        );
        
        return (true, fillAmount, effectivePrice);
    }
    
    // ========================================
    // STATE UPDATES
    // ========================================
    
    /// @notice Update maker order after fill
    function _updateMakerOrder(
        LibDoefinStorage.Order storage makerOrder,
        uint256 fillAmount
    ) private {
        makerOrder.remainingAmount -= fillAmount;
        
        if (makerOrder.remainingAmount == 0) {
            makerOrder.active = false;
            LibOrderbook.removeFromOrderbook(makerOrder);
        }
    }
    
    // ========================================
    // CONTEXT BUILDING
    // ========================================
    
    /// @notice Build settlement context from taker and maker orders
    function _buildSettlementContext(
        TakerOrderContext memory takerCtx,
        LibDoefinStorage.Order storage makerOrder,
        uint256 fillAmount,
        uint256 effectivePrice,
        LibDoefinStorage.MatchType matchType
    ) private view returns (LibSettlementExecutor.SettlementContext memory) {
        return LibSettlementExecutor.SettlementContext({
            taker: takerCtx.taker,
            maker: makerOrder.maker,
            positionId: takerCtx.positionId,
            collateralToken: takerCtx.collateralToken,
            fillAmount: fillAmount,
            effectivePrice: effectivePrice,
            takerDirection: takerCtx.direction,
            makerDirection: makerOrder.direction,
            matchType: matchType,
            makerOrderType: makerOrder.orderType,
            crossCurrencyConfig: makerOrder.crossCurrencyConfig,
            makerFeeBps: makerOrder.orderFeeConfig.makerFeeBps,
            takerFeeBps: takerCtx.takerFeeBps,
            isMarketOrder: (takerCtx.executionType == LibDoefinStorage.ExecutionType.Market)
        });
    }
    
    /// @notice Generate matches from maker order IDs
    function _generateMatches(
        TakerOrderContext memory takerCtx,
        uint256[] memory makerOrderIds
    ) private pure returns (Match[] memory) {
        Match[] memory matches = new Match[](makerOrderIds.length);
        
        for (uint256 i = 0; i < makerOrderIds.length; ++i) {
            matches[i] = Match({
                matchedOrderId: makerOrderIds[i],
                fillAmount: takerCtx.remainingAmount, // Try to fill remaining
                matchType: LibDoefinStorage.MatchType.Complementary // Determine from orders
            });
        }
        
        return matches;
    }
    
    // ========================================
    // EVENTS
    // ========================================
    
    /// @notice Emit trade executed event
    function _emitTradeEvent(
        TakerOrderContext memory takerCtx,
        LibDoefinStorage.Order storage makerOrder,
        uint256 fillAmount,
        uint256 effectivePrice,
        LibDoefinStorage.MatchType matchType
    ) private {
        emit Events.TradeExecuted(
            takerCtx.orderId,
            makerOrder.orderId,
            takerCtx.taker,
            makerOrder.maker,
            takerCtx.positionId,
            fillAmount,
            effectivePrice,
            matchType
        );
    }
}
```

### Step 2.4: Add Deprecation Comments to LibTradeSettlement

**File:** `contracts/libraries/LibTradeSettlement.sol` (MODIFY - DO NOT DELETE YET)

Add deprecation notice at top of file:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title LibTradeSettlement
 * @notice DEPRECATED - This library is being phased out
 * @dev DO NOT USE - All settlement logic has been moved to:
 *      - LibSettlement (coordination)
 *      - LibSettlementExecutor (execution)
 *      - LibSettlementCalculator (calculations)
 * 
 * This file will be deleted in Phase 4 after all references are removed.
 * 
 * Migration path:
 * 1. Replace settlementDispatcher() calls with LibSettlement.executeMatchedRoute()
 * 2. Replace _handleComplementaryMatch() with LibSettlementExecutor.executeSettlement()
 * 3. Replace fee calculations with LibSettlementCalculator functions
 */

// ... rest of existing code (unchanged for now)
```

### Step 2.5: Update Imports Throughout Codebase

Create a script to find all LibTradeSettlement imports:

```bash
# Find all files importing LibTradeSettlement
grep -r "import.*LibTradeSettlement" contracts/

# Create list of files to update
grep -r "import.*LibTradeSettlement" contracts/ | cut -d: -f1 | sort | uniq > files_to_update.txt
```

For each file, add new imports but keep old ones (for now):

```solidity
// OLD (keep for now)
import "./LibTradeSettlement.sol";

// NEW (add these)
import "./LibSettlement.sol";
import "./LibSettlementExecutor.sol";
import "./LibSettlementCalculator.sol";
```

### Step 2.6: Add Tests for New Settlement Architecture

**File:** `test/libraries/LibSettlementCalculator.test.ts` (NEW)

```typescript
import { expect } from "chai";
import { ethers } from "hardhat";

describe("LibSettlementCalculator", function() {
  describe("calculateComplementaryFees", function() {
    it("should calculate fees correctly", async function() {
      const fillAmount = ethers.utils.parseEther("100");
      const effectivePrice = ethers.utils.parseEther("0.6");
      const collateralUnit = ethers.utils.parseEther("1");
      const makerFeeBps = 30; // 0.3%
      const takerFeeBps = 50; // 0.5%
      
      const fees = await calculator.calculateComplementaryFees(
        fillAmount,
        effectivePrice,
        collateralUnit,
        makerFeeBps,
        takerFeeBps
      );
      
      // tradeCost = (100 * 0.6) / 1 = 60
      expect(fees.tradeCost).to.equal(ethers.utils.parseEther("60"));
      
      // makerFee = 60 * 30 / 10000 = 0.18
      expect(fees.makerFee).to.equal(ethers.utils.parseEther("0.18"));
      
      // takerFee = 60 * 50 / 10000 = 0.3
      expect(fees.takerFee).to.equal(ethers.utils.parseEther("0.3"));
      
      // makerNet = 60 - 0.18 = 59.82
      expect(fees.makerNet).to.equal(ethers.utils.parseEther("59.82"));
      
      // takerCost = 60 + 0.3 = 60.3
      expect(fees.takerCost).to.equal(ethers.utils.parseEther("60.3"));
    });
  });
  
  describe("calculateFillableAmount", function() {
    it("should return minimum of all constraints", async function() {
      const result = await calculator.calculateFillableAmount(
        100, // taker remaining
        80,  // maker remaining
        150, // requested
        10   // min fill
      );
      
      expect(result).to.equal(80); // Minimum is maker remaining
    });
    
    it("should return 0 if below minimum fill", async function() {
      const result = await calculator.calculateFillableAmount(
        5,   // taker remaining
        5,   // maker remaining
        5,   // requested
        10   // min fill (can't meet this)
      );
      
      expect(result).to.equal(0);
    });
  });
  
  describe("pricesCross", function() {
    it("should return true when buy order crosses sell order", async function() {
      const makerPrice = ethers.utils.parseEther("0.6"); // Maker selling at 0.6
      const takerPrice = ethers.utils.parseEther("0.65"); // Taker buying at 0.65
      
      const crosses = await calculator.pricesCross(
        makerPrice,
        takerPrice,
        1, // Maker direction: Sell
        0  // Taker direction: Buy
      );
      
      expect(crosses).to.be.true;
    });
    
    it("should return false when orders don't cross", async function() {
      const makerPrice = ethers.utils.parseEther("0.65"); // Maker selling at 0.65
      const takerPrice = ethers.utils.parseEther("0.6");  // Taker buying at 0.6
      
      const crosses = await calculator.pricesCross(
        makerPrice,
        takerPrice,
        1, // Sell
        0  // Buy
      );
      
      expect(crosses).to.be.false;
    });
  });
});
```

**File:** `test/libraries/LibSettlementExecutor.test.ts` (NEW)

```typescript
describe("LibSettlementExecutor", function() {
  describe("executeComplementary", function() {
    it("should execute buy settlement correctly", async function() {
      // Setup: Create maker sell order, taker buy order
      // ... setup code
      
      const ctx = {
        taker: taker.address,
        maker: maker.address,
        positionId: 1,
        collateralToken: wbtc.address,
        fillAmount: ethers.utils.parseEther("100"),
        effectivePrice: ethers.utils.parseEther("0.6"),
        takerDirection: 0, // Buy
        makerDirection: 1, // Sell
        matchType: 0, // Complementary
        makerOrderType: 0, // Standard
        makerFeeBps: 30,
        takerFeeBps: 50,
        isMarketOrder: false
      };
      
      await executor.executeSettlement(ctx);
      
      // Verify:
      // 1. Maker's position tokens consumed
      // 2. Taker's collateral consumed
      // 3. Collateral transferred to maker
      // 4. Position tokens transferred to taker
      // 5. Fees accrued
      
      // ... assertions
    });
  });
});
```

### Step 2.7: Integration Testing

**File:** `test/integration/SettlementIntegration.test.ts` (UPDATE)

Add tests that exercise the full settlement flow:

```typescript
describe("Settlement Integration (New Architecture)", function() {
  it("should execute complementary match end-to-end", async function() {
    // 1. Create maker sell order
    await orderCreationFacet.connect(maker).createOrder({
      // ... order params
      direction: 1, // Sell
      executionType: 0, // Limit
    });
    
    // 2. Create taker buy order (should match immediately)
    await orderCreationFacet.connect(taker).createOrder({
      // ... order params
      direction: 0, // Buy
      executionType: 0, // Limit
    });
    
    // 3. Verify settlement occurred correctly
    // - Check balances
    // - Check order states
    // - Check events
  });
  
  it("should handle market order with multiple matches", async function() {
    // Setup: Create multiple sell orders at different prices
    // Execute: Submit market buy order
    // Verify: Matches in price-time priority, average price validated
  });
  
  it("should handle cross-currency settlement", async function() {
    // Test cross-currency flow using new LibQuoteCurrency integration
  });
});
```

### Step 2.8: Migration Validation

Create comparison test between old and new settlement:

**File:** `test/migration/SettlementMigration.test.ts` (NEW)

```typescript
describe("Settlement Migration Validation", function() {
  it("new settlement produces same results as old settlement", async function() {
    const testCases = [
      {
        name: "Simple complementary buy",
        takerOrder: {/* ... */},
        makerOrder: {/* ... */},
        expectedResult: {/* ... */}
      },
      // ... more test cases
    ];
    
    for (const testCase of testCases) {
      // Execute with OLD settlement logic
      const oldResult = await executeWithOldSettlement(testCase);
      
      // Execute with NEW settlement logic  
      const newResult = await executeWithNewSettlement(testCase);
      
      // Compare results
      expect(newResult.takerBalance).to.equal(oldResult.takerBalance);
      expect(newResult.makerBalance).to.equal(oldResult.makerBalance);
      expect(newResult.protocolFees).to.equal(oldResult.protocolFees);
      // ... more comparisons
    }
  });
});
```

### Step 2.9: Checkpoint & Review

**Testing Checklist:**
- ✅ LibSettlementCalculator unit tests (all pure functions)
- ✅ LibSettlementExecutor unit tests (mocked storage)
- ✅ LibSettlement integration tests
- ✅ Migration validation tests (old vs new)
- ✅ Gas benchmarking (should be similar or better)
- ✅ All existing tests still pass

**Acceptance Criteria for Phase 2:**
- [ ] LibSettlementCalculator has 100% test coverage
- [ ] LibSettlementExecutor handles all match types
- [ ] LibSettlement correctly coordinates workflow
- [ ] Migration tests show identical behavior
- [ ] Gas usage improved or equivalent (±2%)
- [ ] LibTradeSettlement marked as deprecated (not deleted yet)

**Review Questions:**
1. Are all match types (complementary, mint, merge) handled correctly?
2. Is CEI pattern (Checks-Effects-Interactions) followed?
3. Are all edge cases covered (expired orders, insufficient balance, etc.)?
4. Is average price validation correct for market orders?

**Commit & Push:**
```bash
git add contracts/libraries/LibSettlementCalculator.sol
git add contracts/libraries/LibSettlementExecutor.sol
git add contracts/libraries/LibSettlement.sol
git add contracts/libraries/LibTradeSettlement.sol
git add test/libraries/LibSettlement*.test.ts
git add test/migration/SettlementMigration.test.ts
git commit -m "Phase 2: Consolidate settlement into calculator/executor/coordinator pattern"
git push origin refactor/architecture-consolidation
```

---

## Phase 3: Move Orchestration to Facets

**Goal:** Move workflow orchestration from libraries to facets, making libraries pure domain operations.

**Duration:** Week 5  
**Risk:** Medium (changes external interface behavior)

### Step 3.1: Refactor OrderCreationFacet

**File:** `contracts/facets/OrderCreationFacet.sol` (MODIFY)

Current structure has facet → LibOrderbook.createOrder() which does everything.  
New structure: facet orchestrates, library executes.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {LibOrderbook} from "../libraries/LibOrderbook.sol";
import {LibOrderValidation} from "../libraries/LibOrderValidation.sol";
import {LibCollateralManager} from "../libraries/LibCollateralManager.sol";
import {LibQuoteCurrency} from "../libraries/LibQuoteCurrency.sol";
import {LibMatchEngine} from "../libraries/LibMatchEngine.sol";
import {LibSettlement} from "../libraries/LibSettlement.sol";
import {LibReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {Events} from "../interfaces/Events.sol";
import {Errors} from "../interfaces/Errors.sol";

/// @title OrderCreationFacet
/// @notice External interface for creating orders
/// @dev Facet orchestrates workflow, delegates operations to libraries
contract OrderCreationFacet {
    using LibDoefinStorage for *;
    
    // ========================================
    // MODIFIERS
    // ========================================
    
    /// @notice Reentrancy protection at facet level
    modifier nonReentrant() {
        LibReentrancyGuard.lock();
        _;
        LibReentrancyGuard.unlock();
    }
    
    // ========================================
    // EXTERNAL FUNCTIONS
    // ========================================
    
    /// @notice Create a new order
    /// @dev Orchestrates order creation workflow
    /// @param positionId Position ID to trade
    /// @param collateralToken Collateral token address
    /// @param amount Amount of outcome tokens
    /// @param pricePerToken Price per outcome token
    /// @param minFillAmount Minimum fill amount (0 for no minimum)
    /// @param expiry Order expiry timestamp (0 for no expiry)
    /// @param fillOrKill Whether order must fill completely or revert
    /// @param direction Buy or Sell
    /// @param executionType Market or Limit
    /// @param orderType Standard or CrossCurrency
    /// @param crossCurrencyConfig Cross-currency configuration (if applicable)
    /// @return orderId The ID of the created order
    function createOrder(
        uint256 positionId,
        address collateralToken,
        uint256 amount,
        uint256 pricePerToken,
        uint256 minFillAmount,
        uint256 expiry,
        bool fillOrKill,
        LibDoefinStorage.OrderDirection direction,
        LibDoefinStorage.ExecutionType executionType,
        LibDoefinStorage.OrderType orderType,
        LibDoefinStorage.CrossCurrencyConfig memory crossCurrencyConfig
    ) external nonReentrant returns (uint256 orderId) {
        // ========================================
        // STEP 1: VALIDATION (FACET LEVEL)
        // ========================================
        
        LibOrderValidation.validateOrderCreationParams(
            positionId,
            collateralToken,
            amount,
            pricePerToken,
            minFillAmount,
            expiry,
            direction,
            executionType,
            orderType,
            crossCurrencyConfig
        );
        
        // ========================================
        // STEP 2: CREATE ORDER (LIBRARY)
        // ========================================
        
        orderId = LibOrderbook.createOrder(
            msg.sender,
            positionId,
            collateralToken,
            amount,
            pricePerToken,
            minFillAmount,
            expiry,
            fillOrKill,
            direction,
            executionType,
            orderType,
            crossCurrencyConfig
        );
        
        // ========================================
        // STEP 3: LOCK COLLATERAL (FACET ORCHESTRATES)
        // ========================================
        
        if (executionType == LibDoefinStorage.ExecutionType.Limit) {
            _lockCollateralForOrder(orderId);
        }
        
        // ========================================
        // STEP 4: ATTEMPT IMMEDIATE MATCHING (FACET ORCHESTRATES)
        // ========================================
        
        if (_shouldAttemptImmediateMatch(executionType)) {
            _attemptImmediateMatch(orderId, amount, fillOrKill);
        }
        
        // ========================================
        // STEP 5: EMIT EVENT (FACET LEVEL)
        // ========================================
        
        emit Events.OrderCreated(
            orderId,
            msg.sender,
            positionId,
            amount,
            pricePerToken,
            direction,
            executionType
        );
        
        return orderId;
    }
    
    // ========================================
    // INTERNAL ORCHESTRATION
    // ========================================
    
    /// @notice Lock collateral for limit order
    /// @dev Handles both standard and cross-currency collateral
    function _lockCollateralForOrder(uint256 orderId) private {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[orderId];
        
        if (order.direction == LibDoefinStorage.OrderDirection.Buy) {
            // Buy orders lock collateral/quote currency
            
            if (order.orderType == LibDoefinStorage.OrderType.CrossCurrency) {
                // CROSS-CURRENCY: Use LibQuoteCurrency
                LibQuoteCurrency.CrossCurrencyParams memory params = LibQuoteCurrency.CrossCurrencyParams({
                    quoteCurrency: order.crossCurrencyConfig.quoteCurrencyToken,
                    collateralToken: order.collateralToken,
                    amount: order.amount,
                    pricePerToken: order.pricePerToken,
                    feeBps: order.orderFeeConfig.makerFeeBps,
                    rateType: order.crossCurrencyConfig.exchangeRateType,
                    fixedRate: order.crossCurrencyConfig.exchangeRate
                });
                
                LibQuoteCurrency.CrossCurrencyCalculation memory calc = 
                    LibQuoteCurrency.calculateCrossCurrencyAmounts(params);
                
                // Lock quote currency (not collateral)
                LibCollateralManager.lockERC20(
                    order.maker,
                    order.crossCurrencyConfig.quoteCurrencyToken,
                    calc.totalQuoteRequired
                );
            } else {
                // STANDARD: Calculate collateral required
                uint256 collateralUnit = ds.adminConfigStorage.unitPerPair[order.collateralToken];
                uint256 cost = (order.amount * order.pricePerToken) / collateralUnit;
                uint256 fee = (cost * order.orderFeeConfig.makerFeeBps) / 10_000;
                
                // Lock collateral
                LibCollateralManager.lockERC20(
                    order.maker,
                    order.collateralToken,
                    cost + fee
                );
            }
        } else {
            // Sell orders lock position tokens
            LibCollateralManager.lockERC1155(
                order.maker,
                order.positionId,
                order.amount
            );
        }
    }
    
    /// @notice Determine if order should attempt immediate matching
    function _shouldAttemptImmediateMatch(
        LibDoefinStorage.ExecutionType executionType
    ) private pure returns (bool) {
        // Market orders always attempt matching
        // Limit orders attempt matching if there's available liquidity
        return executionType == LibDoefinStorage.ExecutionType.Market;
    }
    
    /// @notice Attempt to match order immediately
    /// @dev Implements Fill-or-Kill logic before execution
    function _attemptImmediateMatch(
        uint256 orderId,
        uint256 orderAmount,
        bool fillOrKill
    ) private {
        // Find available matches
        uint256[] memory makerOrderIds = LibMatchEngine.findMatchesForOrder(orderId);
        
        if (makerOrderIds.length == 0) {
            // No matches found
            if (fillOrKill) {
                // FOK requires full fill - cancel order
                LibOrderbook.cancelOrder(orderId);
                revert Errors.FillOrKillFailed();
            }
            // Otherwise, order remains open
            return;
        }
        
        // FOK VALIDATION BEFORE EXECUTION (CRITICAL)
        if (fillOrKill) {
            uint256 totalFillable = LibMatchEngine.calculateTotalFillable(
                orderId,
                makerOrderIds
            );
            
            if (totalFillable < orderAmount) {
                // Cannot fully fill - cancel order
                LibOrderbook.cancelOrder(orderId);
                revert Errors.FillOrKillFailed();
            }
        }
        
        // Execute settlement
        LibSettlement.executeMatchesForOrder(orderId, makerOrderIds);
        
        // If FOK and we reach here, order was fully filled
        // If not FOK, partial fill is acceptable
    }
}
```

### Step 3.2: Simplify LibOrderbook (Pure Domain Operations)

**File:** `contracts/libraries/LibOrderbook.sol` (MODIFY)

Remove orchestration, keep only domain operations:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./LibDoefinStorage.sol";
import "./LibFeeManager.sol";
import "../interfaces/Errors.sol";

/// @title LibOrderbook
/// @notice Pure order management operations
/// @dev No orchestration - just CRUD and orderbook management
library LibOrderbook {
    using LibDoefinStorage for *;
    
    // ========================================
    // ORDER CREATION
    // ========================================
    
    /// @notice Create and store an order
    /// @dev Pure domain operation - caller handles collateral and matching
    /// @return orderId ID of created order
    function createOrder(
        address maker,
        uint256 positionId,
        address collateralToken,
        uint256 amount,
        uint256 pricePerToken,
        uint256 minFillAmount,
        uint256 expiry,
        bool fillOrKill,
        LibDoefinStorage.OrderDirection direction,
        LibDoefinStorage.ExecutionType executionType,
        LibDoefinStorage.OrderType orderType,
        LibDoefinStorage.CrossCurrencyConfig memory crossCurrencyConfig
    ) internal returns (uint256 orderId) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        
        // Generate order ID
        orderId = ds.orderbookStorage.nextOrderId++;
        
        // Get current fee configuration
        LibDoefinStorage.OrderFeeConfig memory fees = LibFeeManager.getCurrentFees();
        
        // Build order struct
        LibDoefinStorage.Order memory order = LibDoefinStorage.Order({
            orderId: orderId,
            maker: maker,
            positionId: positionId,
            collateralToken: collateralToken,
            amount: amount,
            remainingAmount: amount,
            pricePerToken: pricePerToken,
            minFillAmount: minFillAmount,
            expiry: expiry,
            createdAt: block.timestamp,
            direction: direction,
            executionType: executionType,
            orderType: orderType,
            orderFeeConfig: fees,
            crossCurrencyConfig: crossCurrencyConfig,
            active: true,
            fillOrKill: fillOrKill
        });
        
        // Store order
        ds.orderbookStorage.orders[orderId] = order;
        
        // Add to orderbook index (only for limit orders)
        if (executionType == LibDoefinStorage.ExecutionType.Limit) {
            _addToOrderbook(order);
        }
        
        return orderId;
    }
    
    // ========================================
    // ORDER MODIFICATION
    // ========================================
    
    /// @notice Cancel an order
    /// @dev Caller must handle collateral release
    function cancelOrder(uint256 orderId) internal {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[orderId];
        
        if (!order.active) revert Errors.OrderNotActive();
        if (order.maker != msg.sender) revert Errors.Unauthorized();
        
        // Mark as inactive
        order.active = false;
        
        // Remove from orderbook
        removeFromOrderbook(order);
        
        // NOTE: Collateral release is caller's responsibility
    }
    
    /// @notice Modify an existing order
    /// @dev Limited modifications allowed, caller handles collateral adjustments
    function modifyOrder(
        uint256 orderId,
        uint256 newPricePerToken,
        uint256 newExpiry
    ) internal {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[orderId];
        
        if (!order.active) revert Errors.OrderNotActive();
        if (order.maker != msg.sender) revert Errors.Unauthorized();
        
        // Update fields
        if (newPricePerToken != order.pricePerToken) {
            // Remove from old position in orderbook
            removeFromOrderbook(order);
            
            // Update price
            order.pricePerToken = newPricePerToken;
            
            // Re-insert at new position
            _addToOrderbook(order);
            
            // NOTE: Price validation is caller's responsibility
        }
        
        if (newExpiry != order.expiry) {
            order.expiry = newExpiry;
        }
    }
    
    // ========================================
    // ORDERBOOK MANAGEMENT
    // ========================================
    
    /// @notice Add order to orderbook index
    /// @dev Internal - called during creation/modification
    function _addToOrderbook(LibDoefinStorage.Order memory order) private {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        LibDoefinStorage.OrderbookStorage storage obs = ds.orderbookStorage;
        
        // Get or create orderbook for this position
        LibDoefinStorage.Orderbook storage book = obs.orderbooks[order.positionId];
        
        if (order.direction == LibDoefinStorage.OrderDirection.Buy) {
            // Add to buy side (sorted descending by price)
            book.buyOrders.push(order.orderId);
            // TODO: Implement sorted insertion for gas efficiency
        } else {
            // Add to sell side (sorted ascending by price)
            book.sellOrders.push(order.orderId);
            // TODO: Implement sorted insertion for gas efficiency
        }
    }
    
    /// @notice Remove order from orderbook index
    /// @dev Called during cancellation or full fill
    function removeFromOrderbook(LibDoefinStorage.Order storage order) internal {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        LibDoefinStorage.OrderbookStorage storage obs = ds.orderbookStorage;
        LibDoefinStorage.Orderbook storage book = obs.orderbooks[order.positionId];
        
        uint256[] storage orders = (order.direction == LibDoefinStorage.OrderDirection.Buy)
            ? book.buyOrders
            : book.sellOrders;
        
        // Find and remove order
        for (uint256 i = 0; i < orders.length; ++i) {
            if (orders[i] == order.orderId) {
                // Swap with last element and pop
                orders[i] = orders[orders.length - 1];
                orders.pop();
                break;
            }
        }
    }
    
    // ========================================
    // QUERIES
    // ========================================
    
    /// @notice Get order by ID
    function getOrder(uint256 orderId) internal view returns (LibDoefinStorage.Order storage) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        return ds.orderbookStorage.orders[orderId];
    }
    
    /// @notice Get all orders for a position
    function getOrdersForPosition(
        uint256 positionId,
        LibDoefinStorage.OrderDirection direction
    ) internal view returns (uint256[] memory) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        LibDoefinStorage.Orderbook storage book = ds.orderbookStorage.orderbooks[positionId];
        
        return (direction == LibDoefinStorage.OrderDirection.Buy)
            ? book.buyOrders
            : book.sellOrders;
    }
}
```

### Step 3.3: Create LibOrderValidation

**File:** `contracts/libraries/LibOrderValidation.sol` (NEW)

Consolidate all validation logic:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./LibDoefinStorage.sol";
import "./LibQuoteCurrency.sol";
import "../interfaces/Errors.sol";

/// @title LibOrderValidation
/// @notice Centralized order validation logic
/// @dev Pure validation functions - no state changes
library LibOrderValidation {
    using LibDoefinStorage for *;
    
    /// @notice Validate order creation parameters
    /// @dev Comprehensive validation before order creation
    function validateOrderCreationParams(
        uint256 positionId,
        address collateralToken,
        uint256 amount,
        uint256 pricePerToken,
        uint256 minFillAmount,
        uint256 expiry,
        LibDoefinStorage.OrderDirection direction,
        LibDoefinStorage.ExecutionType executionType,
        LibDoefinStorage.OrderType orderType,
        LibDoefinStorage.CrossCurrencyConfig memory crossCurrencyConfig
    ) internal view {
        // Basic parameter validation
        if (amount == 0) revert Errors.ZeroAmount();
        if (pricePerToken == 0) revert Errors.ZeroPrice();
        if (collateralToken == address(0)) revert Errors.InvalidTokenAddress();
        
        // Min fill validation
        if (minFillAmount > amount) revert Errors.MinFillGreaterThanAmount();
        
        // Expiry validation
        if (expiry != 0 && expiry <= block.timestamp) {
            revert Errors.ExpiryInPast();
        }
        
        // Collateral token must be supported
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        if (ds.adminConfigStorage.unitPerPair[collateralToken] == 0) {
            revert Errors.CollateralNotSupported();
        }
        
        // Position validation
        if (positionId == 0) revert Errors.InvalidPositionId();
        
        // Cross-currency validation
        if (orderType == LibDoefinStorage.OrderType.CrossCurrency) {
            LibQuoteCurrency.validateCrossCurrencyOrder(
                LibDoefinStorage.Order({
                    orderId: 0, // Not created yet
                    maker: msg.sender,
                    positionId: positionId,
                    collateralToken: collateralToken,
                    amount: amount,
                    remainingAmount: amount,
                    pricePerToken: pricePerToken,
                    minFillAmount: minFillAmount,
                    expiry: expiry,
                    createdAt: block.timestamp,
                    direction: direction,
                    executionType: executionType,
                    orderType: orderType,
                    orderFeeConfig: LibDoefinStorage.OrderFeeConfig(0, 0), // Placeholder
                    crossCurrencyConfig: crossCurrencyConfig,
                    active: true,
                    fillOrKill: false
                })
            );
        }
        
        // Market order specific validation
        if (executionType == LibDoefinStorage.ExecutionType.Market) {
            // Market orders cannot have minFillAmount
            if (minFillAmount > 0) revert Errors.MarketOrderCannotHaveMinFill();
            
            // Market orders cannot have expiry
            if (expiry != 0) revert Errors.MarketOrderCannotHaveExpiry();
        }
    }
    
    /// @notice Validate order modification parameters
    function validateOrderModificationParams(
        LibDoefinStorage.Order storage order,
        uint256 newPricePerToken,
        uint256 newExpiry
    ) internal view {
        // Can only modify active orders
        if (!order.active) revert Errors.OrderNotActive();
        
        // Only maker can modify
        if (order.maker != msg.sender) revert Errors.Unauthorized();
        
        // Cannot modify market orders
        if (order.executionType == LibDoefinStorage.ExecutionType.Market) {
            revert Errors.CannotModifyMarketOrder();
        }
        
        // Price validation
        if (newPricePerToken == 0) revert Errors.ZeroPrice();
        
        // Expiry validation
        if (newExpiry != 0 && newExpiry <= block.timestamp) {
            revert Errors.ExpiryInPast();
        }
        
        // NEW: Validate new price still crosses market
        if (newPricePerToken != order.pricePerToken) {
            _validateModifiedPriceCrossesMarket(order, newPricePerToken);
        }
    }
    
    /// @notice Validate modified price still crosses market
    /// @dev Prevents manipulation by modifying to invalid prices
    function _validateModifiedPriceCrossesMarket(
        LibDoefinStorage.Order storage order,
        uint256 newPrice
    ) private view {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        LibDoefinStorage.Orderbook storage book = ds.orderbookStorage.orderbooks[order.positionId];
        
        if (order.direction == LibDoefinStorage.OrderDirection.Buy) {
            // Buy order: check against lowest sell price
            if (book.sellOrders.length > 0) {
                uint256 lowestSellOrderId = book.sellOrders[0]; // Assuming sorted
                LibDoefinStorage.Order storage lowestSellOrder = ds.orderbookStorage.orders[lowestSellOrderId];
                
                // New buy price must be >= lowest sell price to cross
                if (newPrice < lowestSellOrder.pricePerToken) {
                    revert Errors.ModifiedPriceDoesNotCross();
                }
            }
        } else {
            // Sell order: check against highest buy price
            if (book.buyOrders.length > 0) {
                uint256 highestBuyOrderId = book.buyOrders[0]; // Assuming sorted
                LibDoefinStorage.Order storage highestBuyOrder = ds.orderbookStorage.orders[highestBuyOrderId];
                
                // New sell price must be <= highest buy price to cross
                if (newPrice > highestBuyOrder.pricePerToken) {
                    revert Errors.ModifiedPriceDoesNotCross();
                }
            }
        }
    }
    
    /// @notice Validate order is in executable state
    function validateOrderActive(LibDoefinStorage.Order storage order) internal view {
        if (!order.active) revert Errors.OrderNotActive();
        if (order.expiry != 0 && block.timestamp >= order.expiry) {
            revert Errors.OrderExpired();
        }
    }
}
```

### Step 3.4: Update OrderManagementFacet

**File:** `contracts/facets/OrderManagementFacet.sol` (MODIFY)

Similar pattern - facet orchestrates, library executes:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {LibOrderbook} from "../libraries/LibOrderbook.sol";
import {LibOrderValidation} from "../libraries/LibOrderValidation.sol";
import {LibCollateralManager} from "../libraries/LibCollateralManager.sol";
import {LibQuoteCurrency} from "../libraries/LibQuoteCurrency.sol";
import {LibReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {Events} from "../interfaces/Events.sol";
import {Errors} from "../interfaces/Errors.sol";

/// @title OrderManagementFacet
/// @notice External interface for managing orders (cancel, modify)
contract OrderManagementFacet {
    using LibDoefinStorage for *;
    
    modifier nonReentrant() {
        LibReentrancyGuard.lock();
        _;
        LibReentrancyGuard.unlock();
    }
    
    /// @notice Cancel an order and release locked collateral
    /// @dev Orchestrates cancellation workflow
    function cancelOrder(uint256 orderId) external nonReentrant {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[orderId];
        
        // Validate
        LibOrderValidation.validateOrderActive(order);
        if (order.maker != msg.sender) revert Errors.Unauthorized();
        
        // Release locked collateral BEFORE canceling order (CEI pattern)
        _releaseCollateralForOrder(order);
        
        // Cancel order in library
        LibOrderbook.cancelOrder(orderId);
        
        // Emit event
        emit Events.OrderCancelled(orderId, msg.sender);
    }
    
    /// @notice Modify an order's price or expiry
    /// @dev Orchestrates modification workflow with collateral adjustments
    function modifyOrder(
        uint256 orderId,
        uint256 newPricePerToken,
        uint256 newExpiry
    ) external nonReentrant {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        LibDoefinStorage.Order storage order = ds.orderbookStorage.orders[orderId];
        
        // Validate
        LibOrderValidation.validateOrderModificationParams(
            order,
            newPricePerToken,
            newExpiry
        );
        
        // If price changed, adjust locked collateral
        if (newPricePerToken != order.pricePerToken) {
            _adjustCollateralForPriceChange(order, newPricePerToken);
        }
        
        // Modify order in library
        LibOrderbook.modifyOrder(orderId, newPricePerToken, newExpiry);
        
        // Emit event
        emit Events.OrderModified(orderId, newPricePerToken, newExpiry);
    }
    
    // ========================================
    // INTERNAL HELPERS
    // ========================================
    
    /// @notice Release collateral for canceled order
    function _releaseCollateralForOrder(LibDoefinStorage.Order storage order) private {
        if (order.direction == LibDoefinStorage.OrderDirection.Buy) {
            // Buy order: release collateral or quote currency
            
            if (order.orderType == LibDoefinStorage.OrderType.CrossCurrency) {
                // Cross-currency: calculate locked quote amount
                LibQuoteCurrency.CrossCurrencyParams memory params = LibQuoteCurrency.CrossCurrencyParams({
                    quoteCurrency: order.crossCurrencyConfig.quoteCurrencyToken,
                    collateralToken: order.collateralToken,
                    amount: order.remainingAmount, // Only release unfilled amount
                    pricePerToken: order.pricePerToken,
                    feeBps: order.orderFeeConfig.makerFeeBps,
                    rateType: order.crossCurrencyConfig.exchangeRateType,
                    fixedRate: order.crossCurrencyConfig.exchangeRate
                });
                
                LibQuoteCurrency.CrossCurrencyCalculation memory calc = 
                    LibQuoteCurrency.calculateCrossCurrencyAmounts(params);
                
                LibCollateralManager.releaseERC20(
                    order.maker,
                    order.crossCurrencyConfig.quoteCurrencyToken,
                    calc.totalQuoteRequired
                );
            } else {
                // Standard: release collateral
                LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
                uint256 collateralUnit = ds.adminConfigStorage.unitPerPair[order.collateralToken];
                uint256 cost = (order.remainingAmount * order.pricePerToken) / collateralUnit;
                uint256 fee = (cost * order.orderFeeConfig.makerFeeBps) / 10_000;
                
                LibCollateralManager.releaseERC20(
                    order.maker,
                    order.collateralToken,
                    cost + fee
                );
            }
        } else {
            // Sell order: release position tokens
            LibCollateralManager.releaseERC1155(
                order.maker,
                order.positionId,
                order.remainingAmount
            );
        }
    }
    
    /// @notice Adjust collateral when order price is modified
    function _adjustCollateralForPriceChange(
        LibDoefinStorage.Order storage order,
        uint256 newPrice
    ) private {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        
        if (order.direction == LibDoefinStorage.OrderDirection.Buy) {
            uint256 collateralUnit = ds.adminConfigStorage.unitPerPair[order.collateralToken];
            
            // Calculate old and new collateral requirements
            uint256 oldCost = (order.remainingAmount * order.pricePerToken) / collateralUnit;
            uint256 oldFee = (oldCost * order.orderFeeConfig.makerFeeBps) / 10_000;
            uint256 oldTotal = oldCost + oldFee;
            
            uint256 newCost = (order.remainingAmount * newPrice) / collateralUnit;
            uint256 newFee = (newCost * order.orderFeeConfig.makerFeeBps) / 10_000;
            uint256 newTotal = newCost + newFee;
            
            if (newTotal > oldTotal) {
                // Need more collateral - lock additional
                uint256 additional = newTotal - oldTotal;
                LibCollateralManager.lockERC20(
                    order.maker,
                    order.collateralToken,
                    additional
                );
            } else if (newTotal < oldTotal) {
                // Need less collateral - release surplus
                uint256 surplus = oldTotal - newTotal;
                LibCollateralManager.releaseERC20(
                    order.maker,
                    order.collateralToken,
                    surplus
                );
            }
            // If equal, no adjustment needed
        }
        // Sell orders don't need collateral adjustment for price changes
    }
}
```

### Step 3.5: Update MarketExecutionFacet

**File:** `contracts/facets/MarketExecutionFacet.sol` (MODIFY)

This facet already mostly orchestrates, just ensure reentrancy guard is at facet level:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {LibSettlement} from "../libraries/LibSettlement.sol";
import {LibReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {Events} from "../interfaces/Events.sol";

/// @title MarketExecutionFacet
/// @notice External interface for executing market orders with precomputed routes
contract MarketExecutionFacet {
    
    modifier nonReentrant() {
        LibReentrancyGuard.lock();
        _;
        LibReentrancyGuard.unlock();
    }
    
    /// @notice Execute market order with precomputed route
    /// @dev Route is computed off-chain for gas efficiency
    function executeMarketOrder(
        LibDoefinStorage.Order memory takerOrder,
        LibSettlement.Match[] memory matches
    ) external nonReentrant {
        // Build taker context
        LibSettlement.TakerOrderContext memory takerCtx = LibSettlement.TakerOrderContext({
            taker: msg.sender,
            orderId: 0, // Market orders don't have stored order ID
            positionId: takerOrder.positionId,
            collateralToken: takerOrder.collateralToken,
            amount: takerOrder.amount,
            remainingAmount: takerOrder.amount,
            pricePerToken: takerOrder.pricePerToken,
            direction: takerOrder.direction,
            executionType: LibDoefinStorage.ExecutionType.Market,
            takerFeeBps: 50, // Market orders pay taker fee
            fillOrKill: takerOrder.fillOrKill
        });
        
        // Execute settlement
        LibSettlement.executeMatchedRoute(takerCtx, matches);
        
        // Emit event
        emit Events.MarketOrderExecuted(
            msg.sender,
            takerOrder.positionId,
            takerOrder.amount,
            matches.length
        );
    }
}
```

### Step 3.6: Update Tests

Update all integration tests to reflect new facet behavior:

**File:** `test/facets/OrderCreationFacet.test.ts` (UPDATE)

```typescript
describe("OrderCreationFacet (Refactored)", function() {
  it("should orchestrate order creation correctly", async function() {
    // Setup
    const orderParams = {
      positionId: 1,
      collateralToken: wbtc.address,
      amount: ethers.utils.parseEther("100"),
      pricePerToken: ethers.utils.parseEther("0.6"),
      minFillAmount: 0,
      expiry: 0,
      fillOrKill: false,
      direction: 0, // Buy
      executionType: 0, // Limit
      orderType: 0, // Standard
      crossCurrencyConfig: {
        quoteCurrencyToken: ethers.constants.AddressZero,
        exchangeRateType: 0,
        exchangeRate: 0
      }
    };
    
    // Execute
    const tx = await orderCreationFacet.createOrder(
      orderParams.positionId,
      orderParams.collateralToken,
      orderParams.amount,
      orderParams.pricePerToken,
      orderParams.minFillAmount,
      orderParams.expiry,
      orderParams.fillOrKill,
      orderParams.direction,
      orderParams.executionType,
      orderParams.orderType,
      orderParams.crossCurrencyConfig
    );
    
    const receipt = await tx.wait();
    
    // Verify:
    // 1. Order created
    const orderId = receipt.events.find(e => e.event === "OrderCreated").args.orderId;
    expect(orderId).to.be.gt(0);
    
    // 2. Collateral locked
    const lockedBalance = await collateralManager.getERC20Balance(
      user.address,
      wbtc.address
    );
    expect(lockedBalance).to.be.gt(0);
    
    // 3. Event emitted
    expect(receipt.events.find(e => e.event === "OrderCreated")).to.exist;
  });
  
  it("should handle FOK validation before execution", async function() {
    // Create sell order to match against
    await createMakerOrder(/* ... */);
    
    // Create buy order with FOK that cannot be fully filled
    await expect(
      orderCreationFacet.createOrder({
        // ... params
        fillOrKill: true,
        amount: ethers.utils.parseEther("1000"), // More than available
      })
    ).to.be.revertedWith("FillOrKillFailed");
    
    // Verify order was not created (no collateral locked)
    const balance = await collateralManager.getERC20Balance(
      user.address,
      wbtc.address
    );
    expect(balance).to.equal(0);
  });
});
```

### Step 3.7: Checkpoint & Review

**Testing Checklist:**
- ✅ OrderCreationFacet orchestration tests
- ✅ OrderManagementFacet cancel/modify tests
- ✅ MarketExecutionFacet execution tests
- ✅ LibOrderbook unit tests (pure operations)
- ✅ LibOrderValidation unit tests
- ✅ Integration tests (end-to-end workflows)
- ✅ Gas benchmarking

**Acceptance Criteria for Phase 3:**
- [ ] All facets have reentrancy guards at entry points
- [ ] No reentrancy guards in libraries
- [ ] Facets orchestrate multi-step workflows
- [ ] Libraries execute single-purpose operations
- [ ] FOK validated before execution (not after)
- [ ] All existing tests pass
- [ ] Gas usage similar or improved (±3%)

**Review Questions:**
1. Is orchestration clearly separated from execution?
2. Can libraries be tested independently?
3. Are facet responsibilities clear and focused?
4. Is CEI pattern (Checks-Effects-Interactions) followed?

**Commit & Push:**
```bash
git add contracts/facets/OrderCreationFacet.sol
git add contracts/facets/OrderManagementFacet.sol
git add contracts/facets/MarketExecutionFacet.sol
git add contracts/libraries/LibOrderbook.sol
git add contracts/libraries/LibOrderValidation.sol
git add test/facets/*.test.ts
git commit -m "Phase 3: Move orchestration to facets, simplify libraries"
git push origin refactor/architecture-consolidation
```

---

## Phase 4: Eliminate LibEscrowLogic

**Goal:** Delete LibEscrowLogic wrapper entirely, all collateral operations go through LibCollateralManager with LibQuoteCurrency for conversions.

**Duration:** Week 6  
**Risk:** Low (validation already done in Phase 1)

### Step 4.1: Find All LibEscrowLogic References

```bash
# Find all files using LibEscrowLogic
grep -r "LibEscrowLogic" contracts/ --include="*.sol"

# Expected results (should be minimal after Phase 3):
# - Maybe some imports that weren't removed
# - Maybe LibCrossCurrencyMigration (temporary test helper)
```

### Step 4.2: Remove LibEscrowLogic Imports

For each file found in Step 4.1, remove the import:

```solidity
// DELETE THIS LINE
import "./LibEscrowLogic.sol";
```

### Step 4.3: Delete LibEscrowLogic

**File:** `contracts/libraries/LibEscrowLogic.sol` (DELETE)

```bash
git rm contracts/libraries/LibEscrowLogic.sol
```

### Step 4.4: Delete Migration Helper

**File:** `contracts/libraries/helpers/LibCrossCurrencyMigration.sol` (DELETE)

```bash
git rm contracts/libraries/helpers/LibCrossCurrencyMigration.sol
```

### Step 4.5: Run Full Test Suite

```bash
# Ensure no remaining references
npx hardhat compile

# Run all tests
npx hardhat test

# Generate coverage
npx hardhat coverage

# Gas report
REPORT_GAS=true npx hardhat test > gas-report-after-phase4.log
```

### Step 4.6: Checkpoint & Review

**Acceptance Criteria for Phase 4:**
- [ ] LibEscrowLogic.sol deleted
- [ ] No remaining references to LibEscrowLogic
- [ ] All tests pass
- [ ] Code compiles without errors
- [ ] Gas usage improved (should see savings from removed layer)

**Commit & Push:**
```bash
git commit -m "Phase 4: Delete LibEscrowLogic wrapper"
git push origin refactor/architecture-consolidation
```

---

## Phase 5: Optimization & Cleanup

**Goal:** Optimize gas usage, clean up deprecated code, finalize architecture.

**Duration:** Week 7-8  
**Risk:** Low (optimization only)

### Step 5.1: Delete LibTradeSettlement

**File:** `contracts/libraries/LibTradeSettlement.sol` (DELETE)

All references should already be updated to use new settlement architecture.

```bash
# Verify no references remain
grep -r "LibTradeSettlement" contracts/ --include="*.sol"

# Delete
git rm contracts/libraries/LibTradeSettlement.sol
```

### Step 5.2: Optimize Storage Access Patterns

Review all library functions for storage access optimization:

**Pattern to find:**
```solidity
// INEFFICIENT (multiple appStorage() calls)
function someFunction() internal {
    AppStorage storage ds = LibDoefinStorage.appStorage();
    uint256 units = ds.adminConfigStorage.unitPerPair[token];
    
    // ... 20 lines later ...
    
    AppStorage storage ds = LibDoefinStorage.appStorage(); // DUPLICATE!
    ds.orderbookStorage.nextOrderId++;
}
```

**Fix:**
```solidity
// EFFICIENT (single appStorage() call)
function someFunction() internal {
    AppStorage storage ds = LibDoefinStorage.appStorage(); // Cache once
    uint256 units = ds.adminConfigStorage.unitPerPair[token];
    
    // ... use ds throughout ...
    
    ds.orderbookStorage.nextOrderId++;
}
```

Create script to find these:

```bash
# Find files with multiple appStorage calls in same function
# This is a manual review task - look for this pattern
```

### Step 5.3: Optimize Order Struct Slot Packing

**File:** `contracts/libraries/LibDoefinStorage.sol` (MODIFY)

Optimize Order struct to use fewer storage slots:

```solidity
/// @notice Order structure (OPTIMIZED for slot packing)
/// @dev Reduced from 21 slots to 16 slots
struct Order {
    // Slot 0
    uint256 orderId;
    
    // Slot 1
    uint256 positionId;
    
    // Slot 2
    uint256 amount;
    
    // Slot 3
    uint256 remainingAmount;
    
    // Slot 4
    uint256 minFillAmount;
    
    // Slot 5
    uint256 pricePerToken;
    
    // Slot 6
    uint256 expiry;
    
    // Slot 7
    uint256 createdAt;
    
    // Slot 8
    address maker; // 20 bytes
    
    // Slot 9
    address collateralToken; // 20 bytes
    
    // Slot 10 (PACKED)
    OrderType orderType;           // 1 byte
    OrderDirection direction;      // 1 byte
    ExecutionType executionType;   // 1 byte
    bool active;                   // 1 byte
    bool fillOrKill;               // 1 byte
    // 11 bytes used, 21 bytes free
    
    // Slot 11
    OrderFeeConfig orderFeeConfig; // Assuming this fits in 1 slot
    
    // Slots 12-15
    CrossCurrencyConfig crossCurrencyConfig; // 4 slots
}
```

**Before:** 21 slots × 20,000 gas = 420,000 gas per order  
**After:** 16 slots × 20,000 gas = 320,000 gas per order  
**Savings:** 100,000 gas per order creation (24%)

### Step 5.4: Add `unchecked` Blocks Where Safe

Review all increment operations:

```solidity
// BEFORE (overflow checks enabled - unnecessary)
orderId = ds.orderbookStorage.nextOrderId++;

// AFTER (save ~100 gas)
unchecked {
    orderId = ds.orderbookStorage.nextOrderId++;
}
```

Add `unchecked` blocks for:
- Counter increments (orderId, etc.) - overflow takes 10,000+ years
- Loop counters
- Safe arithmetic (when bounds are known)

### Step 5.5: Create Architecture Documentation

**File:** `docs/architecture-after.md` (NEW)

```markdown
# Doefin V2 Architecture (After Refactor)

## Overview

Clear domain-driven architecture with separation between coordination, execution, and calculation.

## Libraries

### Domain: Order Management
- **LibOrderbook** (550 lines, -35%) - Pure CRUD operations
- **LibOrderValidation** (280 lines, NEW) - Centralized validation
- **LibMatchEngine** (unchanged) - Order matching logic

### Domain: Settlement
- **LibSettlement** (420 lines, -38%) - Settlement coordination
- **LibSettlementExecutor** (380 lines, NEW) - Execution handlers
- **LibSettlementCalculator** (220 lines, NEW) - Pure calculations

### Services
- **LibCollateralManager** (450 lines, unchanged) - Collateral operations
- **LibQuoteCurrency** (380 lines, +36%) - Cross-currency (single source)
- **LibFeeManager** (310 lines, unchanged) - Fee management
- **LibPositionRegistry** (unchanged) - Position metadata

### Infrastructure
- **LibDoefinStorage** - Centralized storage
- **LibReentrancyGuard** - Reentrancy protection

## Call Flow Example (Order Creation)

OrderCreationFacet.createOrder()  [ORCHESTRATION]
  ├─> LibOrderValidation.validateOrderCreationParams()  [VALIDATION]
  ├─> LibOrderbook.createOrder()  [DOMAIN LOGIC]
  ├─> LibQuoteCurrency.calculateCrossCurrencyAmounts()  [CALCULATION]
  ├─> LibCollateralManager.lockERC20()  [EXECUTION]
  ├─> LibMatchEngine.findMatchesForOrder()  [MATCHING]
  └─> LibSettlement.executeMatchesForOrder()  [SETTLEMENT]
      ├─> LibSettlementCalculator.calculateFillableAmount()  [CALCULATION]
      └─> LibSettlementExecutor.executeSettlement()  [EXECUTION]

**3 layers maximum, clear responsibilities**

## Key Improvements

1. **Eliminated Layers**
   - LibEscrowLogic deleted (pure wrapper)
   - LibTradeSettlement merged into settlement trio
   - 30% less code overall

2. **Single Source of Truth**
   - Cross-currency: LibQuoteCurrency ONLY
   - Validation: LibOrderValidation ONLY
   - Fees: LibFeeManager ONLY

3. **Clear Separation**
   - Facets: Orchestration
   - Coordinators: Workflows
   - Executors: Side effects
   - Calculators: Pure math

4. **Gas Savings**
   - Removed wrapper layer: 100-300 gas per operation
   - Order struct packing: 100,000 gas per order
   - Optimized storage access: 15-20% across operations
   - **Total: 25-35% gas savings**

5. **Security Improvements**
   - Reentrancy guards at facet level (correct)
   - FOK validated before execution (correct)
   - CEI pattern in all settlement (correct)
   - Price crossing validation on modification (new)
```

### Step 5.6: Run Final Test Suite

```bash
# Full test suite
npx hardhat test

# Coverage
npx hardhat coverage

# Gas comparison
REPORT_GAS=true npx hardhat test > gas-report-final.log

# Compare with baseline
diff gas-baseline-before.log gas-report-final.log
```

### Step 5.7: Generate Gas Comparison Report

Create script to compare gas usage:

**File:** `scripts/compareGas.ts` (NEW)

```typescript
import fs from "fs";

const before = fs.readFileSync("gas-baseline-before.log", "utf-8");
const after = fs.readFileSync("gas-report-final.log", "utf-8");

// Parse gas reports and generate comparison table
// Output markdown table showing savings per operation

console.log("## Gas Comparison Report\n");
console.log("| Operation | Before | After | Savings | Improvement |");
console.log("|-----------|--------|-------|---------|-------------|");
// ... parse and output
```

Run:
```bash
npx ts-node scripts/compareGas.ts > docs/gas-comparison.md
```

### Step 5.8: Final Review & Documentation

**Create:** `REFACTORING_SUMMARY.md`

```markdown
# Doefin V2 Architecture Refactoring Summary

## Changes Made

### Phase 1: Cross-Currency Consolidation
- Created LibQuoteCurrency as single source of truth
- Added calculateCrossCurrencyAmounts() centralized function
- Eliminated cross-currency logic duplication (4 locations → 1)

### Phase 2: Settlement Consolidation
- Split LibSettlement into coordinator/executor/calculator
- Deleted LibTradeSettlement (merged functionality)
- Clear separation: coordination vs execution vs calculation

### Phase 3: Orchestration Migration
- Moved workflows from libraries to facets
- Facets orchestrate, libraries execute
- Clear responsibility boundaries

### Phase 4: Wrapper Elimination
- Deleted LibEscrowLogic (pure wrapper)
- Direct calls to LibCollateralManager

### Phase 5: Optimization
- Order struct slot packing (21 → 16 slots)
- Storage access optimization
- Added unchecked blocks
- Deleted LibTradeSettlement

## Results

### Code Metrics
- Lines of code: 5,500 → 3,800 (-31%)
- Number of files: 20 → 18 (-10%)
- Average function size: 45 → 25 lines (-44%)
- Deepest call stack: 6 → 3 levels (-50%)

### Gas Savings
- Order creation: 350k → 290k gas (-17%)
- Market order: 550k → 450k gas (-18%)
- Settlement: 280k → 230k gas (-18%)
- Cancel order: 80k → 65k gas (-19%)

### Architecture Improvements
- Clear domain boundaries
- Single source of truth for cross-functionality
- Testability greatly improved
- Maintenance complexity reduced

## Migration Path

All changes are backward compatible at the external interface level. Users/integrators don't need to change their code. Internal architecture completely refactored.

## Testing

- 100% test pass rate maintained throughout
- Coverage improved: 85% → 92%
- All migration validation tests pass
- Gas benchmarks show consistent improvements

## Next Steps

1. Deploy to testnet
2. Run comprehensive testnet validation
3. Security audit with new architecture
4. Mainnet deployment

## Lessons Learned

1. **Start with single source of truth** - Eliminating duplication first makes other refactoring easier
2. **Test-driven refactoring** - Migration validation tests caught issues early
3. **Iterative approach** - Small phases with checkpoints prevented big mistakes
4. **Gas optimization last** - Get architecture right first, optimize second
```

### Step 5.9: Checkpoint & Review

**Final Acceptance Criteria:**
- [ ] All deprecated code deleted
- [ ] Gas savings achieved (25-35%)
- [ ] Code reduction achieved (30%)
- [ ] All tests pass (100%)
- [ ] Coverage improved (85% → 90%+)
- [ ] Documentation complete
- [ ] Architecture diagram updated
- [ ] Ready for deployment

**Final Commit:**
```bash
git add .
git commit -m "Phase 5: Final optimization and cleanup - Refactoring complete"
git push origin refactor/architecture-consolidation
```

---

## Testing Requirements

### Unit Testing

Each library must have comprehensive unit tests:

```typescript
// Test structure
describe("LibraryName", () => {
  describe("functionName", () => {
    it("should handle normal case", async () => { });
    it("should handle edge case", async () => { });
    it("should revert on invalid input", async () => { });
    it("should optimize gas usage", async () => { });
  });
});
```

**Coverage targets:**
- Pure functions (calculators): 100%
- Domain operations: 95%
- Orchestration: 90%

### Integration Testing

Full workflow tests:

```typescript
describe("End-to-End Workflows", () => {
  it("should create and fill limit order", async () => { });
  it("should create and fill market order", async () => { });
  it("should handle cross-currency order", async () => { });
  it("should handle FOK order", async () => { });
  it("should handle order cancellation", async () => { });
  it("should handle order modification", async () => { });
});
```

### Migration Validation

Comparison tests ensure behavior doesn't change:

```typescript
describe("Migration Validation", () => {
  it("new logic matches old logic for test case 1", async () => { });
  it("new logic matches old logic for test case 2", async () => { });
  // ... 100+ test cases
});
```

### Gas Benchmarking

Track gas usage throughout:

```bash
# Before each phase
REPORT_GAS=true npx hardhat test > gas-report-phase-N-before.log

# After each phase
REPORT_GAS=true npx hardhat test > gas-report-phase-N-after.log

# Compare
diff gas-report-phase-N-before.log gas-report-phase-N-after.log
```

---

## Rollback Procedures

### If Issues Discovered During Phase

1. **Stop immediately** - Don't proceed to next phase
2. **Identify root cause** - Review test failures
3. **Fix or rollback** - Either fix the issue or:
   ```bash
   git reset --hard HEAD~1  # Rollback last commit
   ```
4. **Re-test** - Ensure tests pass before continuing

### If Issues Discovered After Deployment

1. **Emergency pause** (if pause mechanism exists)
2. **Assess severity**:
   - Critical (funds at risk): Immediate rollback
   - High (functionality broken): Rollback within 24h
   - Medium (sub-optimal): Fix forward
3. **Rollback process**:
   ```bash
   # Revert to backup branch
   git checkout backup/pre-refactor-snapshot
   
   # Deploy old version
   npx hardhat run scripts/deploy.ts --network mainnet
   
   # Verify deployment
   npx hardhat run scripts/verify-deployment.ts
   ```

### Rollback Testing

Before starting refactor, test rollback procedure:

```bash
# 1. Create test deployment
npx hardhat deploy --network testnet

# 2. Make a change
# 3. Redeploy

# 4. Test rollback
# 5. Verify original functionality restored
```

---

## Success Metrics

### Code Quality
- [ ] Lines of code reduced by 25-35%
- [ ] Average function size reduced by 40%+
- [ ] Call stack depth reduced by 50%
- [ ] Cyclomatic complexity reduced

### Gas Efficiency
- [ ] Order creation: -15% to -25%
- [ ] Settlement: -15% to -25%
- [ ] Cancellation: -15% to -25%
- [ ] Overall: -20% to -30%

### Maintainability
- [ ] Clear domain boundaries established
- [ ] Single source of truth for all cross-cutting concerns
- [ ] Testability significantly improved
- [ ] Documentation complete and clear

### Testing
- [ ] 100% test pass rate maintained
- [ ] Coverage improved from 85% to 90%+
- [ ] All migration validation tests pass
- [ ] No regressions introduced

---

## Communication Plan

### Weekly Updates

Send to team every Friday:

```
Subject: Doefin V2 Refactoring - Week N Update

Status: On track / At risk / Blocked
Phase: N / 5
Completion: X%

Completed This Week:
- [bullet points]

Testing Status:
- Unit tests: X%
- Integration tests: X%
- Gas benchmarks: [improvements]

Blockers:
- [list or "None"]

Next Week:
- [preview]
```

### Phase Completion Reviews

After each phase:
1. Demo to team (15 min)
2. Review metrics
3. Discuss any issues
4. Get approval to proceed

---

## Appendix A: File Modification Summary

### Files to Create
- `contracts/libraries/LibQuoteCurrency.sol` (enhance existing)
- `contracts/libraries/LibSettlementCalculator.sol` (NEW)
- `contracts/libraries/LibSettlementExecutor.sol` (NEW)
- `contracts/libraries/LibOrderValidation.sol` (NEW)
- `contracts/test/LibQuoteCurrencyTest.sol` (NEW)
- `test/libraries/LibQuoteCurrency.test.ts` (NEW)
- `test/libraries/LibSettlementCalculator.test.ts` (NEW)
- `test/libraries/LibSettlementExecutor.test.ts` (NEW)
- `test/migration/CrossCurrencyMigration.test.ts` (NEW)
- `test/migration/SettlementMigration.test.ts` (NEW)
- `docs/architecture-after.md` (NEW)
- `REFACTORING_SUMMARY.md` (NEW)

### Files to Modify
- `contracts/libraries/LibSettlement.sol` (REFACTOR)
- `contracts/libraries/LibOrderbook.sol` (SIMPLIFY)
- `contracts/libraries/LibCollateralManager.sol` (SIMPLIFY)
- `contracts/facets/OrderCreationFacet.sol` (ADD ORCHESTRATION)
- `contracts/facets/OrderManagementFacet.sol` (ADD ORCHESTRATION)
- `contracts/facets/MarketExecutionFacet.sol` (ENSURE REENTRANCY)
- `contracts/libraries/LibDoefinStorage.sol` (OPTIMIZE STRUCTS)
- All test files (UPDATE)

### Files to Delete
- `contracts/libraries/LibEscrowLogic.sol` (DELETE in Phase 4)
- `contracts/libraries/LibTradeSettlement.sol` (DELETE in Phase 5)
- `contracts/libraries/helpers/LibCrossCurrencyMigration.sol` (DELETE in Phase 4)

---

## Appendix B: Key Function Signatures

### LibQuoteCurrency
```solidity
function calculateCrossCurrencyAmounts(
    CrossCurrencyParams memory params
) internal view returns (CrossCurrencyCalculation memory);

function calculateCollateralFromQuote(
    address quoteCurrency,
    address collateralToken,
    uint256 quoteAmount,
    ExchangeRateType rateType,
    uint256 fixedRate
) internal view returns (uint256 collateralAmount);

function validateCrossCurrencyOrder(Order memory order) internal view;
```

### LibSettlementCalculator
```solidity
function calculateComplementaryFees(...) internal pure returns (FeeCalculation memory);
function calculateMintMergeFees(...) internal pure returns (FeeCalculation memory);
function calculateFillableAmount(...) internal pure returns (uint256);
function calculateEffectivePrice(...) internal pure returns (uint256);
function calculateAveragePrice(...) internal pure returns (uint256);
function meetsAveragePriceRequirement(...) internal pure returns (bool);
function pricesCross(...) internal pure returns (bool);
```

### LibSettlementExecutor
```solidity
function executeSettlement(SettlementContext memory ctx) internal;
```

### LibSettlement
```solidity
function executeMatchedRoute(
    TakerOrderContext memory takerOrder,
    Match[] memory matches
) internal;

function executeMatchesForOrder(
    uint256 takerOrderId,
    uint256[] memory makerOrderIds
) internal;
```

### LibOrderbook
```solidity
function createOrder(...) internal returns (uint256 orderId);
function cancelOrder(uint256 orderId) internal;
function modifyOrder(uint256 orderId, uint256 newPrice, uint256 newExpiry) internal;
function getOrder(uint256 orderId) internal view returns (Order storage);
function removeFromOrderbook(Order storage order) internal;
```

### LibOrderValidation
```solidity
function validateOrderCreationParams(...) internal view;
function validateOrderModificationParams(...) internal view;
function validateOrderActive(Order storage order) internal view;
```

---

## Appendix C: Testing Commands

```bash
# Run all tests
npx hardhat test

# Run specific test file
npx hardhat test test/libraries/LibQuoteCurrency.test.ts

# Run with gas reporting
REPORT_GAS=true npx hardhat test

# Run coverage
npx hardhat coverage

# Compile contracts
npx hardhat compile

# Clean and recompile
npx hardhat clean && npx hardhat compile

# Deploy to testnet
npx hardhat run scripts/deploy.ts --network arbitrumSepolia

# Verify contracts
npx hardhat verify --network arbitrumSepolia DEPLOYED_ADDRESS

# Run linter
npm run lint

# Format code
npm run format
```

---

## Conclusion

This guide provides exact, step-by-step instructions for refactoring Doefin V2 to a cleaner, more maintainable architecture. Each phase is self-contained with clear acceptance criteria and rollback procedures.

**Key Principles:**
1. Incremental changes with testing at each step
2. Never break existing functionality
3. Migration validation ensures behavior preservation
4. Gas optimization is tracked throughout
5. Clear documentation at every phase

**Expected Timeline:**
- Phase 1 (Cross-Currency): 2 weeks
- Phase 2 (Settlement): 2 weeks
- Phase 3 (Orchestration): 1 week
- Phase 4 (Cleanup): 1 week
- Phase 5 (Optimization): 2 weeks
- **Total: 8 weeks**

**Risk Mitigation:**
- Comprehensive testing at each phase
- Migration validation ensures correctness
- Rollback procedures defined
- Incremental deployment strategy

Follow this guide precisely, and you'll successfully refactor to a cleaner, more efficient architecture while maintaining 100% functionality.
