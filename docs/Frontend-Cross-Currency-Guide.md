# Cross-Currency Orders - Frontend Integration Guide

## Overview

The Doefin V2 protocol supports **three types of orders** to enable flexible trading across different currencies. This guide explains how to integrate these order types in your frontend application.

## 🎯 Order Types

### 1. **Standard Orders** (Same Currency)
- **What**: Traditional orders priced and settled in the same collateral token
- **Use Case**: Trading USDC positions using USDC
- **Pricing**: All amounts in collateral token (e.g., USDC)
- **Matching Option**: Complementary (In Collateral Currency), Mint and Merge

```javascript
// Example: Buy 100 YES tokens at 0.6 USDC each
{
  positionId: "0x123...",
  collateralToken: "0xUSDC_ADDRESS",
  amount: ethers.utils.parseUnits("100", 6), // 100 tokens
  pricePerToken: ethers.utils.parseUnits("0.6", 6), // 0.6 USDC
  // crossCurrencyData not needed
  crossCurrencyData: {
    quoteCurrencyToken: ethers.constants.AddressZero,
    floorRate: 0
  }
}
```

### 2. **Fixed Orders** (Cross-Currency, Fixed Price in quote currency)
- **What**: Orders where you pay in one currency but list price in another
- **Use Case**: Pay with BTC but list price in USDT
- **Pricing**: Price displayed in quote currency (USDT), payment in collateral (BTC)
- **Matching Option**: Only Complementary is available, could matched against Dynamics as well

```javascript
// Example: Buy 100 YES tokens at 0.6 USDT each, paying with BTC
{
  positionId: "0x123...",
  collateralToken: "0xBTC_ADDRESS", // Paying with BTC
  amount: ethers.utils.parseUnits("100", 18),
  pricePerToken: ethers.utils.parseUnits("0.6", 6), // Price in USDT
  crossCurrencyData: {
    quoteCurrencyToken: "0xUSDT_ADDRESS", // Price currency
    floorRate: 0 // No floor rate for Fixed orders
  }
}
```

### 3. **Dynamic Orders** (Cross-Currency, Get the exchange rate at the execution time)
- **What**: Orders with oracle-based pricing and worst-case rate protection
- **Use Case**: List in BTC but want rate protection against unfavorable moves
- **Pricing**: Listed in collateral currency but effective price in quote currency
- **Matching Option**: Only Complementary is available, could matched against Fixed as well

```javascript
// Example: Sell 100 YES tokens at 0.001 BTC each, but protect against BTC rate below $45,000
{
  positionId: "0x123...",
  collateralToken: "0xBTC_ADDRESS",
  amount: ethers.utils.parseUnits("100", 18),
  pricePerToken: ethers.utils.parseUnits("0.001", 8), // Listed in BTC
  crossCurrencyData: {
    quoteCurrencyToken: "0xUSDT_ADDRESS", // Oracle pair
    floorRate: 45000000000 // $45,000 minimum rate (scaled)
  }
}
```

## 🔄 How Cross-Currency Matching Works

### Order Matching Rules
1. **Standard orders** only match with **Standard orders**
2. **Cross-currency orders** (Fixed + Dynamic) only match with **cross-currency orders**
3. **Price priority**: Best prices get filled first, regardless of order type

### Price Conversion
- **Fixed orders**: Price already in quote currency → use directly
- **Dynamic orders**: Price converted using live oracle rate
- All cross-currency orders are compared in the same quote currency
