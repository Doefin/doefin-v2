// BlockHeaderUtils — Bitcoin difficulty maths against real mainnet data (ORC-001 / ORC-002 / ORC-010)
// ----------------------------------------------------------------------------
// The oracle's period-boundary rule requires a header's nBits to equal Bitcoin Core's
// `CalculateNextWorkRequired` over the closing period. A single-bit error here would make the
// oracle reject the real first block of the next period and freeze, so the formula is checked
// against real retarget boundaries (test/data/retarget_boundaries/boundaries.json, fetched from
// mempool.space): the powLimit cap era (4032), the first rise (32256), the July-2021 drop
// (689472), and the last four Base-mainnet-era periods (965664..971712).

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { boundaries } = require("../../data/retarget_boundaries/boundaries.json");

const POW_LIMIT = ethers.BigNumber.from("0x00000000ffff0000000000000000000000000000000000000000000000000000");
const TWO_WEEKS = 14 * 24 * 3600;

describe("BlockHeaderUtils — retarget, compact encoding and work", function () {
  let utils;

  before(async function () {
    const Harness = await ethers.getContractFactory("BlockHeaderUtilsHarness");
    utils = await Harness.deploy();
    await utils.deployed();
  });

  describe("requiredBoundaryNBits reproduces every real retarget boundary", function () {
    for (const b of boundaries) {
      it(`boundary ${b.boundary}: 0x${b.periodLast.bits.toString(16)} -> 0x${b.boundaryBlock.bits.toString(16)}`, async function () {
        const required = await utils.requiredBoundaryNBits(
          b.periodLast.bits,
          b.periodFirst.timestamp,
          b.periodLast.timestamp,
        );
        expect(required).to.equal(b.boundaryBlock.bits);
      });
    }
  });

  describe("compact encoding round-trips every real nBits", function () {
    it("encodeCompact(decodeCompactStrict(nBits)) == nBits", async function () {
      const all = new Set();
      for (const b of boundaries) {
        all.add(b.periodFirst.bits);
        all.add(b.periodLast.bits);
        all.add(b.boundaryBlock.bits);
      }
      for (const nBits of all) {
        expect(await utils.encodeCompact(await utils.decodeCompactStrict(nBits))).to.equal(nBits);
      }
    });
  });

  describe("nextPeriodTarget clamps like Bitcoin Core", function () {
    const prevTarget = ethers.BigNumber.from("0x0000000000000000000221ef0000000000000000000000000000000000000000");

    it("a period faster than T/4 is clamped to a 4x harder target", async function () {
      expect(await utils.nextPeriodTarget(prevTarget, 1_000_000, 1_000_000 + 60)).to.equal(prevTarget.div(4));
    });

    it("a period slower than 4T is clamped to a 4x easier target", async function () {
      expect(await utils.nextPeriodTarget(prevTarget, 1_000_000, 1_000_000 + 10 * TWO_WEEKS)).to.equal(prevTarget.mul(4));
    });

    it("a last timestamp before the first (out-of-order timestamps) clamps to T/4, no underflow", async function () {
      expect(await utils.nextPeriodTarget(prevTarget, 2_000_000, 1_000_000)).to.equal(prevTarget.div(4));
    });

    it("the result is capped at powLimit", async function () {
      expect(await utils.nextPeriodTarget(POW_LIMIT, 0, 4 * TWO_WEEKS)).to.equal(POW_LIMIT);
    });

    it("a target whose product would overflow returns powLimit instead of reverting", async function () {
      expect(await utils.nextPeriodTarget(ethers.constants.MaxUint256.div(2), 0, 4 * TWO_WEEKS)).to.equal(POW_LIMIT);
    });
  });

  describe("decodeCompactStrict rejects what Bitcoin Core rejects (ORC-010)", function () {
    for (const [label, nBits] of [
      ["zero mantissa", 0x1d000000],
      ["exponent 0 (target truncates to zero)", 0x00ffffff],
      ["sign bit set", 0x1d80ffff],
      ["overflowing exponent", 0x2300ffff],
    ]) {
      it(`${label}: 0x${nBits.toString(16).padStart(8, "0")} reverts BlockHeaderOracle_InvalidTargetNBits`, async function () {
        await expect(utils.decodeCompactStrict(nBits)).to.be.revertedWith("BlockHeaderOracle_InvalidTargetNBits()");
      });
    }

    it("accepts the powLimit encoding 0x1d00ffff", async function () {
      expect(await utils.decodeCompactStrict(0x1d00ffff)).to.equal(POW_LIMIT);
    });
  });

  describe("blockWork matches Bitcoin Core GetBlockProof", function () {
    it("powLimit work is 2^32 + 2^16 + 1 hashes (difficulty 1)", async function () {
      // 2^256 / (0xffff·2^208 + 1) = 4295032833
      expect(await utils.blockWork(POW_LIMIT)).to.equal(4295032833);
    });

    it("a harder target carries more work", async function () {
      const easy = await utils.blockWork(POW_LIMIT);
      const hard = await utils.blockWork(POW_LIMIT.div(1000));
      expect(hard).to.be.gt(easy.mul(999));
    });
  });
});
