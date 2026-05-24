# Doefin Smart Contracts — Project Instructions

## What This Is

Doefin is a prediction market platform on Base L2. This repo contains the EIP-2535 Diamond proxy smart contracts.

We are completing a migration to v3: **off-chain orderbook with on-chain settlement** (Polymarket model). The on-chain CLOB code (v2.0) is being removed. Only settlement, CTF, and oracle facets remain.

## Architecture

**EIP-2535 Diamond Proxy** — one proxy contract delegates to multiple facet contracts via function selectors. Storage is shared across facets via dedicated storage structs.

### v3 Facets (keep and maintain)

**Settlement (new):**
- `SettlementFacet` — `matchOrders()`, `fillOrder()`, operator management, fee collection
- `SignatureVerifierFacet` — EIP-712 domain separator, order hash, ecrecover + EIP-1271
- `NonceManagerFacet` — `incrementNonce()`, `cancelOrder()`, `cancelOrdersForPosition()`

**CTF Core:**
- `ConditionalTokensFacet` — `splitPosition()`, `mergePositions()`, `redeemPositions()`
- `ConditionManagerFacet` — `prepareCondition()`, `resolveCondition()`
- `ERC1155Facet` / `ERC1155ReceiverFacet` — position token standard

**Oracle (Bitcoin condition resolution):**
- `DoefinV1BlockHeaderOracleFacet` — Bitcoin block header submission + verification
- `OracleAdapterFacet` — view-only access to Bitcoin difficulty/block-count/duration questions
  used for condition resolution. (This is NOT a cross-currency price oracle.)

**Infrastructure:**
- `DiamondCutFacet` / `DiamondLoupeFacet` / `OwnershipFacet` — Diamond standard
- `AccessControlFacet` / `AdminConfigFacet` — admin management
- `MarketDataFacet` — read-only market queries

### v2.0 Facets (being removed)
- `OrderCreationFacet`, `OrderManagementFacet`, `MarketExecutionFacet`
- `ExchangeViewFacet`, `RouteSimulationFacet`
- Associated libraries: `LibMatchEngine`, `LibSettlement` (old), `LibTradeSettlement`, `LibOrderbook`, `LibCollateralManager`, `LibQuoteCurrency`, `LibCrossCurrencySettlement`

## Key Concepts

### EIP-712 Order Signing
Users sign orders off-chain. The contract verifies signatures on-chain at settlement time.

```
DoefinOrder(
    uint256 salt, address maker, address signer, bytes32 positionId,
    address collateralToken, uint8 side, uint128 amount, uint128 pricePerToken,
    uint64 expiration, uint256 nonce
)
```

The struct is 10 fields (SCRUM-223/224/226). The fields `minFillAmount`, `orderType`,
`quoteCurrency`, `exchangeRate`, and `feeRateBps` were removed — the old 15-field struct
no longer exists.

Domain: `EIP712Domain("Doefin Exchange", "3", chainId, diamondAddress)`

`signature` and `signatureType` are NOT part of the struct hash — they're separate function parameters.

### Settlement Paths
Three paths only — there is no Cross-Currency settlement path.
1. **Complementary**: Buy A vs Sell A — direct token swap
2. **Mint**: Buy A + Buy B — `splitPosition()` creates both outcome tokens from collateral
3. **Merge**: Sell A + Sell B — `mergePositions()` returns collateral from both outcome tokens

A single `matchOrders()` call can settle one taker against a mix of these match types —
the match type is determined per maker.

### Fee Model (operator-supplied + pull-payment bank, SCRUM-236)
- Trading fees are **not signed and not on-chain**. The off-chain operator computes the
  symmetric bell-curve fee (`fee ∝ min(price, 1-price) * fillAmount`) and passes the
  per-leg fee *amounts* into `matchOrders()` / `fillOrder()`.
- The contract enforces an admin-set ceiling via `_validateFee` in `SettlementFacet`:
  `fee <= cashValue * maxFeeRateBps / 10000` AND `fee <= proceeds`. Fail-closed — a
  `maxFeeRateBps` of 0 forbids any non-zero fee.
- `maxFeeRateBps` is set by the admin via `AdminConfigFacet.setMaxFeeRate`, bounded by the
  hard ceiling constant `MAX_FEE_RATE_BPS_CAP = 1000` (10%).
- **Pull-payment bank (SCRUM-236):** trading and resolution fees are NOT transferred to
  `feeReceiver` per trade. They accrue in the Diamond's per-token accumulator
  `LibAdminConfigStorage.AdminConfigStorage.accruedFees[token]`. Every settlement /
  redemption leg emits `Events.FeeAccrued(token, amount, kind)` where `kind` is
  `LibConstants.FEE_KIND_TRADING` (0) or `FEE_KIND_RESOLUTION` (1). The operator is NOT
  a fee sink (and never was) — it is the authorised `msg.sender` for
  `matchOrders()` / `fillOrder()` but never receives fees.
- **Sweeping fees:** the contract owner calls `AdminConfigFacet.withdrawFees(token, amount)`
  to move accrued fees from the Diamond bank to `acs.feeReceiver`. Pass
  `amount = type(uint256).max` to drain the full per-token balance. The function reverts
  `InvalidTokenAddress`, `ZeroAmount`, `InsufficientAccruedFees(requested, available)`,
  or `InvalidFeeReceiver` as appropriate. Emits `Events.FeesWithdrawn(token, feeReceiver,
  amount)`. The entire body sits inside a `LibReentrancyGuard` window. `getAccruedFees(token)`
  is the matching view. Under SCRUM-213 the owner is a Gnosis Safe; the owner gate
  composes cleanly.
- **Co-mingling note:** the Diamond's ERC-20 balance now serves two roles — position-token
  backing and the fee bank — kept distinguishable by the `accruedFees` accumulator. The
  master solvency property INV-SOLV-4-revised is
  `balanceOf(Diamond, token) >= outstandingPairs[token] + accruedFees[token]`. Standard-ERC20
  precondition applies: allow-listed collaterals must not be fee-on-transfer or rebasing.
- A separate `resolutionFeeBps` (redemption fee, charged in `ConditionalTokensFacet` when
  winning positions are redeemed) is distinct from the operator trading-fee surface and
  still exists; under SCRUM-236 it accrues into the same `accruedFees` bank via
  `FEE_KIND_RESOLUTION`.

### Storage (EIP-7201 namespaced — SCRUM-229)

Each storage namespace lives at an EIP-7201 slot:
`keccak256(abi.encode(uint256(keccak256(id)) - 1)) & ~bytes32(uint256(0xff))`,
with a `@custom:storage-location erc7201:<id>` annotation on its struct. The `& ~0xff`
mask reserves a 256-slot-aligned region, so namespaced structs need no hand-sized `__gap`.

- `LibDoefinStorage` (`doefin.storage`) — legacy `AppStorage` monolith, **grandfathered**:
  holds only the CTF / ERC1155 / position-registry / reentrancy / Bitcoin-oracle
  sub-structs (these keep their `__gap`s). Do not add new sub-structs here.
- `LibSettlementStorage` (`doefin.settlement.storage`) — v3 settlement storage
- `LibAdminConfigStorage` (`doefin.admin-config.storage`) — protocol admin config
- `LibAccessControlStorage` (`doefin.access-control.storage`) — market-maker role
- **New modules get their own EIP-7201 namespace library** — never embed sub-structs in
  `AppStorage`.
- `test/storage/storage-layout-snapshot.test.js` is the CI gate against layout drift;
  an intentional layout change must regenerate the snapshot (`UPDATE_STORAGE_SNAPSHOT=true`).

## Branch Strategy

- **Current branch:** `v3/dev` (all v3 development)
- **Main branch:** `main` (production — don't push directly)
- **Previous settlement work:** `features/SCRUM-25-On-Chain-Settlement` (merged into `v3/dev`)

## Git Workflow

- **Never add Co-Authored-By or AI attribution** to commit messages. Clean messages only.
- **Split changes into multiple commits** — one per logical unit (e.g., remove facets, remove libraries, update deploy script, update tests — separate commits).
- **Branch naming:** `feature/SCRUM-{id}-{Short-Description}` — always ask for a Jira ticket before creating a branch.
- **Work on:** `v3/dev` for v3 changes. Create feature branches off `v3/dev` for tasks.

## Conventions

- Solidity 0.8.20, optimizer enabled (runs: 1), viaIR
- Hardhat + Mocha + Chai testing (NOT Foundry)
- Central `Errors.sol` for custom errors (no revert strings)
- Central `Events.sol` for events
- Libraries: `internal` functions, named `Lib*`, comprehensive NatSpec with `@custom:*` tags
- EIP-7201 namespaced storage — new modules get their own namespace library (see Storage section)
- All facets must be under 24KiB (check with `npx hardhat size-contracts`)

## Verification Commands

```bash
# Compile
npx hardhat compile

# Contract sizes (must be under 24KiB)
npx hardhat size-contracts

# Run all tests
npx hardhat test

# Run specific test suites
npx hardhat test test/unit/SettlementFacet/
npx hardhat test test/unit/SignatureVerifierFacet/
npx hardhat test test/unit/NonceManagerFacet/

# Deploy to local node
npx hardhat node          # terminal 1
npm run deploy:local      # terminal 2

# Deploy to Base Sepolia
npm run deploy:baseSepolia

# Gas report
REPORT_GAS=true npx hardhat test
```

## Backend Repo (sibling)

The backend is at `/Users/reza/workspace/predexyo/doefin-backend/`.

Key integration points:
- `shared/scw/encoder.py` — EIP-712 encoding must match `LibDoefinOrder` byte-for-byte
- `match-engine/app/utils/settlement_abi.py` — ABI must match deployed contract
- `shared/scw/models.py` — `DoefinOrder` fields must match Solidity struct exactly
- Task documents are at `doefin-backend/docs/smart-contract-task-*.md`

## Current Deployment (Base Sepolia)

| Key | Value |
|-----|-------|
| Diamond | `0xb05a5f3272F83BB748CcDA59c71Ac197dfA60F17` |
| Chain ID | 84532 |
| Operator | `0xc99BdBE077BD060646aF7902b7612ecdDB7B2901` |
| Collateral | `0x55Dd0aBC9d270fAfF4Ad629627cAfD6907D4D4Ed` |

## Current Task

**SC-008:** Remove v2.0 on-chain CLOB code and deploy a fresh v3 Diamond.
Full instructions at: `/Users/reza/workspace/predexyo/doefin-backend/docs/smart-contract-task-008-v3-cleanup-fresh-deploy.md`

Before starting, ask the user for the Jira SCRUM ID and create a feature branch:
`feature/SCRUM-{id}-v3-Cleanup-Fresh-Deploy` off `v3/dev`.
