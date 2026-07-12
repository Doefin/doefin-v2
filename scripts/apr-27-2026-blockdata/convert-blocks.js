const fs = require("fs");
const path = require("path");

const rawPath = path.join(__dirname, "raw-blocks.txt");
const outPath = path.join(__dirname, "blocks.json");

const lines = fs.readFileSync(rawPath, "utf8").split("\n");

const blocks = [];
for (const line of lines) {
  // Skip header, separator, and empty lines
  if (!line.trim() || line.startsWith("block_number") || line.startsWith("---") || line.startsWith("----")) {
    continue;
  }

  const parts = line.split("|").map((s) => s.trim());
  if (parts.length < 8 || !parts[0].match(/^\d+$/)) continue;

  blocks.push({
    blockNumber: parseInt(parts[0], 10),
    blockHash: "0x" + parts[1],
    prevBlockHash: "0x" + parts[2],
    merkleRootHash: "0x" + parts[3],
    nBits: parseInt(parts[4], 10),
    version: parseInt(parts[5], 10),
    timestamp: parseInt(parts[6], 10),
    nonce: parseInt(parts[7], 10),
  });
}

// Sort ascending (oldest block first)
blocks.sort((a, b) => a.blockNumber - b.blockNumber);

const output = { count: blocks.length, blocks };
fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

console.log(`Converted ${blocks.length} blocks (${blocks[0].blockNumber} → ${blocks[blocks.length - 1].blockNumber})`);
console.log(`Output: ${outPath}`);
