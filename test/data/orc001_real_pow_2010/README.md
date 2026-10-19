# ORC-001 — real 2010 Bitcoin chain plus one attacker header with real proof-of-work

Used by `test/audit/ORC-001-nbits-not-validated.test.js` (oracle review
`audit/findings/oracle-scsvs-v10-review.md`, finding ORC-001), and reused by
`ORC-008` (honest real buffer).

## Why 2010 data

The end-to-end PoC needs a DifficultyThreshold question whose **honest** answer is YES,
i.e. a real chain with contract integer difficulty ≥ 2 (`threshold` must be ≥ 1 and the
rule is `difficulty > threshold`). A synthetic chain cannot provide that: integer
difficulty ≥ 1 means a target ≤ 2^224, i.e. ≥ 2^32 hashes per header. Real Bitcoin
headers already carry that work. The epoch starting at height 40320 (Feb 2010) has
nBits `0x1c654657`, difficulty 2.5277, contract integer difficulty **2**, which is low
enough that ONE attacker block at that difficulty can be mined on a laptop.

## Files

| File | Contents |
|---|---|
| `blocks-41000-41040.json` | Bitcoin mainnet headers 41000–41040, fetched 2026-10-19 from mempool.space (`/api/block-height/<h>` → hash, `/api/block/<hash>/header` → raw 80 bytes). Each `blockHash` is re-derived by double-SHA256 of `rawHeader`, matches mempool.space, links to its predecessor, and meets its own target. All share nBits `0x1c654657`. |
| `attacker-h1.json` | The attacker's header **H1**: child of real block 41016, hash `0x00000000055099d4…6bcf`, which is below block 41016's real target (one genuine block of proof-of-work at that difficulty), while **declaring nBits `0x2100ffff`** (target ≈ 2^256·(1 − 2^-16), integer difficulty 0). The oracle accepts it, and every later header then needs about one nonce try. Merkle root = SHA-256 of a fixed label (the oracle never checks it). |
| `mine-h1.c` | The one-off CPU miner that found H1 (ARMv8 SHA-256 instructions, midstate, 16 threads): ~1.65e10 double-SHA256 in 57 s on an Apple M3 Max (expected work 1.09e10). Not used at test run time; the contract itself re-derives H1's hash and re-checks its PoW on every run. Build: `cc -O3 -march=armv8-a+crypto -pthread mine-h1.c -o mine-h1`. |

## Reproducing H1

```
./mine-h1 \
  010000004024763bc917607d9c6c3e06619e5f573d6a83120e0539c3ca1bff3b000000002a92e169bb84ec21e12565726f7022b1da7ec39676f99eacac193ff66e257901ce177d4bffff002100000000 \
  0000000065465700000000000000000000000000000000000000000000000000 16
# -> 3 3476632234 00000000055099d4fc2650c4ca1720443191f934451301d237826213ca1e6bcf
#    (timestamp offset 3 on top of 41016.timestamp + 600, nonce, display-order hash)
```

The first argument is the 80-byte H1 template (version 1, prev = hash(41016), the label
merkle root, timestamp = 41016.timestamp + 600, nBits `0x2100ffff`, nonce 0); the second
is block 41016's target.
