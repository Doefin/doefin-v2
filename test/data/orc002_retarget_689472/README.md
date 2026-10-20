# ORC-002 — real Bitcoin headers across two difficulty adjustments

Used by `test/audit/ORC-002-downward-retarget-rejected.test.js` (oracle review
`audit/findings/oracle-scsvs-v10-review.md`, finding ORC-002).

## Source

Fetched 2026-10-19 from Bitcoin **mainnet** via mempool.space:

```
curl -s https://mempool.space/api/block-height/<h>       # -> block hash
curl -s https://mempool.space/api/block/<hash>/header     # -> raw 80-byte header (hex)
```

Every entry keeps the raw header (`rawHeader`). Each `blockHash` is re-derived by
double-SHA256 of those 80 bytes, exactly as `BlockHeaderUtils.calculateBlockHash` does
(see `test/utils/syntheticChain.js`), and matches the hash mempool.space returns for the
height. Every header links to its predecessor and meets its **own** nBits target
(Bitcoin's rule).

## Files

| File | Heights | What it shows |
|---|---|---|
| `blocks-689438-689475.json` | 689438–689475 | **Downward** adjustment at **689472** (2021-07-03, −27.94%): nBits `0x170e1ef9` → `0x171398ce`. Block 689472's hash `0x000000000000000000124347f70edac3…` is below its own target but **above** block 689471's target, so the oracle's `hash < target(parent.nBits)` rejects this valid block with `BlockHeaderOracle_InvalidBlockHash`. 689438–689454 allow a buffer from which every real header up to 689471 can be submitted (the control). |
| `blocks-971695-971713-upward.json` | 971695–971713 | **Upward** adjustment at **971712** (2026-10-16, +5.92%): nBits `0x17021ef0` → `0x17020093`. The new target is lower than the old one, so today's check passes (CONTROL). |

Difficulty-adjustment figures are from `https://mempool.space/api/v1/mining/difficulty-adjustments/all`.
