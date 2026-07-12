# Deployment Guide

This guide covers deploying Doefin V3 to Base and other EVM networks.

## 📋 Prerequisites

### Required Tools
- Node.js 16.0.0 or later
- Git
- Hardhat CLI

### Required Information
- **Deployer Private Key**: Account with sufficient ETH for deployment
- **RPC URL**: Node endpoint for the target network
- **API Keys**: For contract verification (Basescan)

### Network Requirements

| Network | Chain ID | Min ETH Required |
|---------|----------|------------------|
| Hardhat Local | 31337 | 0 ETH |
| Base Sepolia | 84532 | ~0.01 ETH |
| Base Mainnet | 8453 | ~0.05 ETH |

## 🔧 Environment Setup

### 1. Clone and Install

```bash
git clone https://github.com/predexyo/doefin-v2.git
cd doefin-v2
npm install
```

### 2. Environment Configuration

```bash
# Copy template
cp .env.example .env

# Edit with your values
nano .env
```

**Required Environment Variables:**

```bash
# Deployment
PRIVATE_KEY=0x1234567890abcdef...
BASE_SEPOLIA_RPC_URL=https://base-sepolia.g.alchemy.com/v2/YOUR_KEY
BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
BASESCAN_API_KEY=YOUR_BASESCAN_API_KEY
```

### 3. Compilation Test

```bash
# Compile contracts and run tests
npm run compile
npm test
```

## 🚀 Deployment Process

### Local Development Network

```bash
# Terminal 1: Start local node
npm run node

# Terminal 2: Deploy to local network  
npm run deploy:local
```

**Expected Output:**
```
Deploying contracts with the account: 0x...
DiamondCutFacet deployed: 0x...
Diamond deployed: 0x...
DiamondLoupeFacet deployed: 0x...
OwnershipFacet deployed: 0x...
...
Diamond cut tx: 0x...
Completed diamond cut
Diamond address: 0x...
```

### Base Sepolia Testnet

```bash
# Deploy to testnet
npm run deploy:baseSepolia

# Verify the deployment
npm run verify:baseSepolia
```

### Base Mainnet Deployment

⚠️ **CRITICAL: Mainnet deployment checklist**

- [ ] All tests passing with 100% success rate
- [ ] Security audit completed
- [ ] Multi-sig (Safe) wallet set up for contract ownership
- [ ] Deployment parameters review
- [ ] Gas price optimization
- [ ] Emergency pause mechanism tested

```bash
# Deploy to Base mainnet (when ready) — Safe-owned Diamond deployment
npm run deploy:safe:base
```

## 📝 Post-Deployment Configuration

### 1. Verify Contract Deployment

```bash
# Check diamond deployment
npx hardhat run scripts/verifyDeployment.js --network NETWORK_NAME
```

### 2. Initialize Oracle

```bash
# Upload initial Bitcoin block headers (17-block buffer)
npx hardhat run scripts/admin-scripts/initializeOracle.js --network NETWORK_NAME
```

**Required Data:**
- 17 consecutive Bitcoin block headers
- Starting block height
- Current difficulty value

### 3. Configure Access Control

```bash
# Set up admin roles
npx hardhat run scripts/admin-scripts/setupRoles.js --network NETWORK_NAME
```

**Roles to Configure:**
- Contract Owner (multi-sig recommended)
- Oracle Role (for block submission)
- Market Maker Role (if applicable)

### 4. Test Core Functionality

```bash
# Run integration tests against deployed contracts
DIAMOND_ADDRESS=0x... npm run test:integration
```

### 5. Initial Market Setup

```bash
# Create first prediction market
npx hardhat run scripts/admin-scripts/createInitialMarket.js --network NETWORK_NAME
```

## 🔍 Verification & Monitoring

### Contract Verification

Automatic verification is included in deployment script, but manual verification:

```bash
# Verify main diamond
npx hardhat verify --network NETWORK_NAME DIAMOND_ADDRESS "OWNER_ADDRESS" "DIAMOND_CUT_FACET_ADDRESS"

# Verify individual facets
npx hardhat verify --network NETWORK_NAME FACET_ADDRESS
```

### Monitoring Setup

1. **Block Explorer**: Bookmark contract addresses on Basescan
2. **Event Monitoring**: Set up event indexing for critical events
3. **Oracle Monitoring**: Track block header submissions
4. **Gas Monitoring**: Monitor transaction costs

## 🔧 Common Deployment Issues

### Issue: Contract Too Large

**Error:** Contract code size exceeds limit
**Solution:**
```bash
# Enable size optimization
ALLOW_UNLIMITED_CONTRACT_SIZE=true npm run compile
```

### Issue: Insufficient Gas

**Error:** Transaction out of gas
**Solutions:**
1. Increase gas limit in hardhat.config.js
2. Deploy facets individually if needed
3. Use Hardhat's auto gas estimation

### Issue: RPC Rate Limiting  

**Error:** Too many requests
**Solutions:**  
1. Add delays between transactions
2. Use premium RPC endpoint
3. Reduce concurrent deployments

### Issue: Verification Failed

**Error:** Contract verification failed
**Solutions:**
1. Wait for block confirmations
2. Check constructor parameters
3. Verify correct network specified

## 📊 Deployment Costs

### Gas Usage Estimates

Total deployment is the Diamond proxy plus its facets (settlement, CTF, oracle, and
infrastructure facets) and the diamond-cut transaction that wires them together. Run
`npx hardhat size-contracts` before deployment to confirm every facet is under the 24 KiB
limit, and use Hardhat's gas estimation for current per-facet figures.

### Network Notes

**Base (L2):**
- Low gas costs and fast confirmations
- The intended production network — chain ID 8453 (mainnet), 84532 (Sepolia)

## 🔄 Upgrade Process

### Planning Upgrades

1. **Test thoroughly** on testnet
2. **Document changes** in upgrade notes
3. **Prepare migration scripts** if needed
4. **Coordinate with users** about downtime

### Executing Upgrades

```bash
# Deploy new facet
npx hardhat run scripts/upgrades/deployNewFacet.js --network NETWORK_NAME

# Execute diamond cut
npx hardhat run scripts/upgrades/upgradeImplementation.js --network NETWORK_NAME
```

### Post-Upgrade Verification

```bash
# Verify upgrade successful
npx hardhat run scripts/upgrades/verifyUpgrade.js --network NETWORK_NAME

# Test functionality
npm run test:integration
```

## 📞 Support

### Deployment Issues

- **GitHub Issues**: Report technical problems
- **Discord**: Real-time deployment support
- **Documentation**: Check troubleshooting guides

### Emergency Contacts

- **Critical Issues**: team@doefin.io
- **Security Issues**: security@doefin.io  
- **Technical Support**: dev@doefin.io

---

**⚠️ Security Reminder:** Always test deployments thoroughly on testnets before mainnet deployment. Never share private keys or store them in version control.