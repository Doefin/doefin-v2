# ORC-001 — real 2010 Bitcoin chain plus one attacker header with real proof-of-work

Used by `test/audit/ORC-001-nbits-not-validated.test.js` (oracle review
`audit/findings/oracle-scsvs-v10-review.md`, finding ORC-001).

## Why 2010 data, and why this window

The end-to-end PoC needs a DifficultyThreshold question whose **honest** answer is YES,
i.e. a real chain with contract integer difficulty ≥ 2 (`threshold` must be ≥ 1 and the
rule is `difficulty > threshold`). A synthetic chain cannot provide that: integer
difficulty ≥ 1 means a target ≤ 2^224, i.e. ≥ 2^32 hashes per header. Real Bitcoin
headers already carry that work, and Feb-2010 difficulty (≈2.5) is low enough that ONE
attacker block at that difficulty can be mined on a laptop.

The window straddles the retarget at **42336** (nBits `0x1c654657` → `0x1c43b3e5`,
difficulty 2.5277 → 3.7812, contract integer 2 → 3). The PoC's question targets 42336,
the first block of the NEXT epoch, so it stays valid under the epoch rule proposed for
ORC-006, and its honest answer (difficulty 3 > 2) depends on the retarget itself.

## Files

| File | Contents |
|---|---|
| `blocks-42312-42350.json` | Bitcoin mainnet headers 42312–42350, fetched 2026-10-19 from mempool.space (`/api/block-height/<h>` → hash, `/api/block/<hash>/header` → raw 80 bytes). Each `blockHash` is re-derived by double-SHA256 of `rawHeader`, matches mempool.space, links to its predecessor, and meets its own target. |
| `attacker-h1.json` | The attacker's header **H1**: child of real block 42328, hash `0x000000002cc54317…8c93`, which is below block 42328's real target (one genuine block of proof-of-work at difficulty 2.53), while **declaring nBits `0x2100ffff`** (target ≈ 2^256·(1 − 2^-16), integer difficulty 0). The oracle accepts it, and every later header then needs about one nonce try. Merkle root = SHA-256 of a fixed label (the oracle never checks it). |
| `mine-h1.c` | The one-off CPU miner (ARMv8 SHA-256 instructions, midstate, 16 threads, ~300 MH/s on an Apple M3 Max). Expected work at this difficulty is 1.09e10 hashes (~40 s); this H1 was a lucky draw after ~3.0e9 (10 s). Not used at test run time: the contract itself re-derives H1's hash and re-checks its PoW on every run. Build: `cc -O3 -march=armv8-a+crypto -pthread mine-h1.c -o mine-h1`. |

## Reproducing H1

```
./mine-h1 \
  01000000a90c1bf11a3b10f92e83660942d41b23e57ddd1a351e655723be492e000000002a92e169bb84ec21e12565726f7022b1da7ec39676f99eacac193ff66e257901bdce844bffff002100000000 \
  0000000065465700000000000000000000000000000000000000000000000000 16
# -> 0 2337006435 000000002cc54317de7cf7e585fdfa7c7516214f053b3e8e3addf5b50a938c93
#    (timestamp offset 0 on top of 42328.timestamp + 600, nonce, display-order hash)
```

The first argument is the 80-byte H1 template (version 1, prev = hash(42328), the label
merkle root, timestamp = 42328.timestamp + 600, nBits `0x2100ffff`, nonce 0); the second
is block 42328's target.
