# Safe-owned Diamond Deployment — Runbook

Deploys the Doefin v3 Diamond so that a **Safe multi-sig owns it from genesis** —
the deployer EOA never holds ownership. Bootstrap (cut + operator + collateral
+ fee receiver + pause) is bundled into **one** Safe `MultiSend` transaction.

Same script runs on Base Sepolia (rehearsal) and Base mainnet (production) —
only `.env` and the Safe address change.

---

## Files

| File | Purpose |
|------|---------|
| [scripts/deploy-safe-owned.js](scripts/deploy-safe-owned.js) | Main deploy entry. Deploys facets, builds MultiSend, drives Safe ceremony. |
| [scripts/lib/safe-multisend.js](scripts/lib/safe-multisend.js) | Reusable helper: propose, wait for confirmations, execute. |
| [.env.baseSepolia.example](.env.baseSepolia.example) | Sepolia env template |
| [.env.base.example](.env.base.example) | Mainnet env template |
| [hardhat.config.js](hardhat.config.js) | `base` and `baseSepolia` network entries |
| [package.json](package.json) | `deploy:safe:baseSepolia` and `deploy:safe:base` scripts |

---

## One-time install

```bash
npm install            # picks up @safe-global/protocol-kit + api-kit
```

---

## Phase 1 — Base Sepolia rehearsal

### 1. Create a test Safe on Base Sepolia

- Go to [app.safe.global](https://app.safe.global), connect a wallet, switch to **Base Sepolia**.
- **Create new Safe** → add owners (just the deployer EOA for the first run) → threshold **1-of-1**.
- Note the Safe address — that's `SAFE_ADDRESS`.

> **Why 1-of-1 first?** It validates the Safe SDK plumbing end-to-end without
> needing other signers in the loop. After the first run succeeds, add owners
> and raise the threshold via the Safe UI (Settings → Owners → Add owner /
> Change threshold). Each of those changes is itself a Safe tx — easy while
> still 1-of-1.

### 2. Fund the deployer EOA

Hit a Base Sepolia faucet — Coinbase, Alchemy, or QuickNode work. ~0.05 ETH is plenty.

### 3. Configure `.env`

```bash
cp .env.baseSepolia.example .env
$EDITOR .env
```

Required values:

| Variable | Value |
|---|---|
| `PRIVATE_KEY` | Deployer EOA — must be a signer on `SAFE_ADDRESS` |
| `SAFE_ADDRESS` | Your Sepolia test Safe |
| `OPERATOR_ADDRESS` | Match-engine hot wallet (a fresh EOA, NOT the Safe) |
| `COLLATERAL_TOKEN_ADDRESS` | `0x290F9Aa4641E58A5E098e8860161Ab6B5df5C557` (existing mock USDT — `MUSDT_TOKEN_ADDRESS`) |
| `BASE_SEPOLIA_RPC_ENDPOINT` | Alchemy / QuickNode RPC URL |
| `ETHERSCAN_API_KEY` | Multichain Etherscan v2 key |

### 4. Run the deploy

```bash
npm run deploy:safe:baseSepolia
```

What you'll see:

```
==========================================================
  Safe-owned Diamond deployment
==========================================================
  Network:           baseSepolia (chainId 84532)
  Deployer EOA:      0x…
  Safe (new owner):  0x…
  Operator:          0x…
  Collateral token:  0x55Dd…D4D4Ed (6 decimals)
  Start paused:      true
==========================================================

--- Phase 1: Deploying facets ---
  DiamondCutFacet deployed: 0x…
  Diamond deployed:        0x…
  Diamond owner (post-construct): 0x…  (= Safe address)
  DiamondInit deployed:    0x…
  BlockHeaderUtils:        0x…
  DiamondLoupeFacet deployed: 0x…
  …  (14 facets total)

--- Phase 2: Building Safe MultiSend bootstrap ---
  MultiSend bundle (5 calls):
    [0] diamondCut (14 facets + init)
    [1] setOperator(0x…)
    [2] addCollateralToken(0x…, 1e6)
    [3] setFeeReceiver(0x…)
    [4] pauseTrading()

--- Phase 3: Safe MultiSend ceremony ---

  Safe: 0x…
  Threshold: 1-of-1
  Proposer (this script): 0x…

  Safe tx hash: 0x…

  ✅ Proposed "Doefin Diamond bootstrap" — visible at:
     https://app.safe.global/transactions/queue?safe=basesep:0x…

  Waiting for confirmations…
    confirmations: 1/1

  Executing on-chain…
  ✅ Executed: 0x…

--- Phase 4: Post-deploy verification ---
  Facets registered: 15
  Diamond owner:     0x…  (= Safe)
  Operator:          0x…
  Collateral whitelisted: true
  Trading paused:    true

==========================================================
  ✅ Deployment complete
==========================================================
```

On a **1-of-1 Safe**, the proposer signature alone meets threshold, so the
script proposes → confirms → executes back-to-back with no pause.

On a **2-of-2 or higher**, the script pauses after proposing. Other signers
open the Safe app (mobile or web), see the pending tx, tap **Confirm**.
Once threshold is met, the script unblocks and executes automatically.

### 5. Smoke test the deployment

With trading still paused, run an integration check:

```bash
# In a hardhat console:
npx hardhat console --network baseSepolia
> const d = "0x…"   // new Diamond address
> const o = await ethers.getContractAt("OwnershipFacet", d)
> await o.owner()                // should be SAFE_ADDRESS
> const sf = await ethers.getContractAt("SettlementFacet", d)
> await sf.operator()            // should be OPERATOR_ADDRESS
> await sf.isTradingPaused()     // should be true
> const ac = await ethers.getContractAt("AdminConfigFacet", d)
> await ac.isAllowedCollateral("0x290F9Aa4641E58A5E098e8860161Ab6B5df5C557")
```

All four should return the expected values.

### 6. Unpause via Safe (proves Safe control)

To unpause, go to your Safe in `app.safe.global` → **New Transaction →
Transaction Builder** → **Custom transaction**:

- **To:** the Diamond address
- **Value:** `0`
- **Data:** `0xc4c4d1ad` (= `unpauseTrading()` selector — verify by encoding locally)

Sign → execute → confirm `sf.isTradingPaused()` returns `false`.

This proves your Safe really controls the Diamond. Re-pause the same way if
you want to keep the rehearsal Diamond cold.

### 7. Raise the threshold (after the first run)

Once the 1-of-1 deploy is green, exercise the multi-sig path:

1. In Safe app → **Settings → Owners** → add your other signer EOAs.
2. **Change threshold** to e.g. 2-of-3.
3. Re-deploy a *second* test Diamond with `START_PAUSED=true` to rehearse
   the multi-signer ceremony before mainnet. Don't change the existing
   deployment — just confirm the script works at higher thresholds.

---

## Phase 2 — Base mainnet

⚠️ **Do not start this phase until Sepolia is fully green.**

### Pre-flight

- [ ] Audit signoff complete
- [ ] Sepolia rehearsal end-to-end successful (deploy + Safe ceremony + smoke test)
- [ ] Mainnet Safe created on Base, signers + threshold verified
- [ ] All signers have rehearsed the ceremony (saw the Sepolia version)
- [ ] Deployer EOA is a signer on the mainnet Safe AND funded with ~0.05 ETH
- [ ] Operator EOA created (fresh, isolated, not personal)
- [ ] Backend cutover plan written

### Deploy

```bash
cp .env.base.example .env
$EDITOR .env                     # fill in real mainnet values
npm run deploy:safe:base
```

Identical flow to Sepolia, with one difference: at higher thresholds the
script will pause for confirmations. Coordinate with signers via team chat
during that window — keep the Safe tx hash visible so they can verify what
they're confirming.

> **Decoding the diamondCut for signers.** The Safe app may show the
> `diamondCut` inner call as opaque bytes (it's a deeply nested struct).
> The deployer should post the `safeTxHash` plus `keccak256(cutCalldata)`
> in team chat *before* signers tap Confirm. Signers verify these match
> what the Safe UI displays for the tx.

### After deploy

1. Capture the printed deployment block:
   ```
   DIAMOND_CONTRACT_ADDRESS=0x…
   CHAIN_ID=8453
   DOMAIN_SEPARATOR=0x…
   DEPLOY_BLOCK=…
   ```
2. Update `doefin-backend/.env` (or its equivalent) with these.
3. Regenerate ABIs: `node scripts/admin-scripts/generate-diamond-abi.js`.
4. Compare the on-chain `DOMAIN_SEPARATOR` against the value the backend
   computes in `shared/scw/encoder.py` — must match exactly.
5. Smoke-test the backend against the new (paused) Diamond.
6. **Unpause** via a Safe tx when everything is green.

---

## Recovery — what to do if a step fails

| Failure | Recovery |
|---|---|
| EOA tx fails during facet deployment (Phase 1) | Re-run the script. Already-deployed facets are wasted gas but harmless — they're never referenced by the Diamond. |
| Safe tx proposal succeeds but execution reverts | The Diamond exists but is unwired. Build a *replacement* MultiSend (same calls, possibly with bug fix), propose, execute. The first proposal stays in Safe history. |
| Wrong `SAFE_ADDRESS` in env | Caught by the pre-flight bytecode check before any owner-only call runs. Fix env and re-run. |
| Wrong `OPERATOR_ADDRESS` baked into the MultiSend | After the MultiSend executes, propose a *follow-up* Safe tx calling `setOperator(newOperator)`. |
| Wrong collateral whitelisted | Propose `removeCollateralToken(wrongAddr)` then `addCollateralToken(rightAddr, ...)` as a follow-up Safe tx. |

The Diamond cannot be re-owned without a `transferOwnership` from the Safe,
so if any of the above happens *between* phases, the Diamond is still under
Safe control — you're just submitting cleanup Safe txs.

---

## Why this beats EOA-then-transferOwnership

| | EOA bootstrap → transferOwnership | Safe-as-owner + MultiSend (this) |
|---|---|---|
| Safe ceremonies during bootstrap | 0 | 1 |
| Window where EOA controls Diamond | ~5 minutes | 0 |
| Custody story for audit | "trust me, the handoff was fast" | Safe owned from block 0 |
| Recovery from mid-bootstrap failure | Single EOA tx | Single Safe tx (follow-up) |

The MultiSend bundle is the key — without it, Safe-as-owner means N separate
Safe transactions during launch day. With it, one ceremony does everything.

---

## Reference: the MultiSend bundle composition

Inner calls, in order:

1. `IDiamondCut.diamondCut(cut[], DiamondInit, init.calldata)`
   — wires all 14 facets and runs `DiamondInit.init(SAFE_ADDRESS)`
2. `ISettlement.setOperator(OPERATOR_ADDRESS)`
3. `IAdminConfig.addCollateralToken(COLLATERAL_TOKEN_ADDRESS, 10^DECIMALS)`
4. `IAdminConfig.setFeeReceiver(FEE_RECEIVER_ADDRESS)`
5. `ISettlement.pauseTrading()` (skipped if `START_PAUSED=false`)

All five execute atomically. If any one reverts, the entire MultiSend reverts
and the Diamond stays bare (which is recoverable — just build a corrected
MultiSend and propose again).
