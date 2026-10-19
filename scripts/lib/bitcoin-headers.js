/**
 * Real Bitcoin headers from a mempool.space-compatible API, in the contract's
 * `LibDoefinStorage.BlockHeader` field shape (the same shape the oracle fixtures use).
 *
 * Used by the SCRUM-214 oracle-hardening fork rehearsal to submit headers mined after the
 * fork point. Read-only: it only issues GET requests.
 */

const crypto = require("crypto");

const MEMPOOL_API = process.env.MEMPOOL_API || "https://mempool.space/api";

function sha256d(buf) {
  return crypto.createHash("sha256").update(crypto.createHash("sha256").update(buf).digest()).digest();
}

/** Parse a raw 80-byte header (hex) into contract field shape; hashes in display (big-endian) order. */
function parseRawHeader(rawHex, blockNumber) {
  const buf = Buffer.from(String(rawHex).replace(/^0x/, ""), "hex");
  if (buf.length !== 80) throw new Error(`raw header must be 80 bytes, got ${buf.length}`);
  return {
    prevBlockHash: "0x" + Buffer.from(buf.subarray(4, 36)).reverse().toString("hex"),
    merkleRootHash: "0x" + Buffer.from(buf.subarray(36, 68)).reverse().toString("hex"),
    blockHash: "0x" + Buffer.from(sha256d(buf)).reverse().toString("hex"),
    blockNumber,
    version: buf.readUInt32LE(0),
    timestamp: buf.readUInt32LE(68),
    nBits: buf.readUInt32LE(72),
    nonce: buf.readUInt32LE(76),
  };
}

async function get(path) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${MEMPOOL_API}${path}`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
      return (await res.text()).trim();
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

async function tipHeight() {
  return Number(await get("/blocks/tip/height"));
}

/** Canonical header at `height`, parsed and checked against the API's block hash. */
async function headerAt(height) {
  const hash = await get(`/block-height/${height}`);
  const header = parseRawHeader(await get(`/block/${hash}/header`), height);
  if (header.blockHash.toLowerCase() !== `0x${hash}`.toLowerCase()) {
    throw new Error(`header ${height}: re-derived hash ${header.blockHash} != API hash ${hash}`);
  }
  return header;
}

/** Canonical headers `from..to` (inclusive), each linked to the previous one. */
async function headersRange(from, to) {
  const out = [];
  for (let h = from; h <= to; h++) {
    const header = await headerAt(h);
    if (out.length && header.prevBlockHash.toLowerCase() !== out[out.length - 1].blockHash.toLowerCase()) {
      throw new Error(`header ${h} does not link to ${h - 1}`);
    }
    out.push(header);
  }
  return out;
}

module.exports = { MEMPOOL_API, parseRawHeader, tipHeight, headerAt, headersRange };
