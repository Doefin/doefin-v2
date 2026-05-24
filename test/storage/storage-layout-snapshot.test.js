const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = require("hardhat");

/**
 * Storage-layout snapshot test — ARCH-05 / SCRUM-229 (Task B).
 *
 * The Doefin Diamond reaches its storage through assembly slot assignment, so the
 * compiler emits no `storageLayout` for the storage libraries. `StorageLayoutProbe`
 * (contracts/mock) declares the structs as state variables to make the layout
 * observable; this test reads it back and asserts it against a committed baseline.
 *
 * A failure means a storage field changed slot/offset. On a deployed Diamond that is
 * a layout break — the next `diamondCut` would write a new field over live data.
 * Every intentional layout change must be paired with a reviewed snapshot update:
 *
 *     UPDATE_STORAGE_SNAPSHOT=true npx hardhat test test/storage/storage-layout-snapshot.test.js
 *
 * with the snapshot diff reviewed in the PR.
 */

const PROBE_FQN = "contracts/mock/StorageLayoutProbe.sol:StorageLayoutProbe";
const SNAPSHOT_PATH = path.join(__dirname, "storage-layout.snapshot.json");

// Only the protocol's own storage structs are tracked; the primitive / mapping /
// array helper types in the solc `types` map are ignored.
const TRACKED_STRUCT_PREFIXES = [
  "struct LibDoefinStorage.",
  "struct LibSettlementStorage.",
  "struct LibAdminConfigStorage.",
  "struct LibAccessControlStorage.",
];

// EIP-7201 namespaces (SCRUM-229). Slot derivation:
//   keccak256(abi.encode(uint256(keccak256(id)) - 1)) & ~bytes32(uint256(0xff))
// `getter` is the StorageLayoutProbe function exposing the on-chain STORAGE_POSITION
// constant, so the test can prove the hardcoded slot matches the formula.
const ERC7201_NAMESPACES = [
  { id: "doefin.storage", getter: "appStorageSlot" },
  { id: "doefin.settlement.storage", getter: "settlementStorageSlot" },
  { id: "doefin.admin-config.storage", getter: "adminConfigStorageSlot" },
  { id: "doefin.access-control.storage", getter: "accessControlStorageSlot" },
];

// Single-slot flags keep a plain keccak256 slot — not growable namespaces.
const PLAIN_KECCAK_SLOTS = ["doefin.storage.initialized"];

function erc7201Slot(id) {
  const seed = ethers.BigNumber.from(
    ethers.utils.keccak256(ethers.utils.toUtf8Bytes(id))
  );
  const inner = ethers.utils.defaultAbiCoder.encode(["uint256"], [seed.sub(1)]);
  const hashed = ethers.BigNumber.from(ethers.utils.keccak256(inner));
  const mask = ethers.constants.MaxUint256.sub(255); // ~bytes32(uint256(0xff))
  return ethers.utils.hexZeroPad(hashed.and(mask).toHexString(), 32);
}

function plainKeccakSlot(seed) {
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(seed));
}

async function readProbeStorageLayout() {
  await hre.run("compile");
  const buildInfo = await hre.artifacts.getBuildInfo(PROBE_FQN);
  if (!buildInfo) {
    throw new Error(`build-info not found for ${PROBE_FQN}.`);
  }
  const [sourceName, contractName] = PROBE_FQN.split(":");
  const output =
    buildInfo.output.contracts[sourceName] &&
    buildInfo.output.contracts[sourceName][contractName];
  if (!output || !output.storageLayout) {
    throw new Error(
      "storageLayout missing from build-info — add 'storageLayout' to " +
        "solidity.settings.outputSelection in hardhat.config.js."
    );
  }
  return output.storageLayout;
}

/**
 * Normalize the solc storageLayout into an astId-independent snapshot keyed by
 * struct label. Each struct maps to its members in declaration order, each member
 * recording { field, slot, offset, type, bytes }. The solc type-id strings (which
 * embed astIds and drift on unrelated edits) are never stored — only the stable,
 * human-readable type `label` and `numberOfBytes`.
 */
function buildSnapshot(layout) {
  const types = layout.types || {};
  const snapshot = {};
  for (const typeDef of Object.values(types)) {
    const label = typeDef.label;
    if (!TRACKED_STRUCT_PREFIXES.some((p) => label.startsWith(p))) continue;
    if (!typeDef.members) continue; // structs only
    snapshot[label] = typeDef.members.map((m) => {
      const memberType = types[m.type];
      return {
        field: m.label,
        slot: String(m.slot),
        offset: m.offset,
        type: memberType ? memberType.label : m.type,
        bytes: memberType ? String(memberType.numberOfBytes) : null,
      };
    });
  }
  // deterministic key order
  return Object.keys(snapshot)
    .sort()
    .reduce((acc, k) => {
      acc[k] = snapshot[k];
      return acc;
    }, {});
}

describe("Storage-layout snapshot (ARCH-05 / SCRUM-229)", function () {
  this.timeout(180000);

  let snapshot;

  before(async function () {
    const layout = await readProbeStorageLayout();
    snapshot = buildSnapshot(layout);
  });

  it("the compiler emits a storageLayout for the tracked storage structs", function () {
    expect(Object.keys(snapshot).length).to.be.greaterThan(0);
    expect(snapshot).to.have.property("struct LibDoefinStorage.AppStorage");
    expect(snapshot).to.have.property(
      "struct LibSettlementStorage.SettlementStorage"
    );
    expect(snapshot).to.have.property(
      "struct LibAdminConfigStorage.AdminConfigStorage"
    );
    expect(snapshot).to.have.property(
      "struct LibAccessControlStorage.AccessControlStorage"
    );
  });

  it("matches the committed storage-layout snapshot", function () {
    if (process.env.UPDATE_STORAGE_SNAPSHOT === "true") {
      fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + "\n");
      console.log(`    ↳ storage-layout snapshot written: ${SNAPSHOT_PATH}`);
      return;
    }
    expect(
      fs.existsSync(SNAPSHOT_PATH),
      "snapshot file missing — generate it with UPDATE_STORAGE_SNAPSHOT=true"
    ).to.equal(true);
    const committed = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8"));
    expect(snapshot).to.deep.equal(
      committed,
      "storage layout drifted from the committed snapshot — a field changed " +
        "slot/offset. If intentional, regenerate with UPDATE_STORAGE_SNAPSHOT=true " +
        "and review the diff in the PR."
    );
  });

  it("the EIP-7201 slot constants match the formula", async function () {
    const Probe = await ethers.getContractFactory("StorageLayoutProbe");
    const probe = await Probe.deploy();
    await probe.deployed();
    for (const ns of ERC7201_NAMESPACES) {
      const onchain = (await probe[ns.getter]()).toLowerCase();
      expect(onchain).to.equal(
        erc7201Slot(ns.id).toLowerCase(),
        `${ns.id}: STORAGE_POSITION constant does not match the EIP-7201 formula`
      );
    }
  });

  it("no two storage namespaces derive the same slot", function () {
    const slots = [
      ...ERC7201_NAMESPACES.map((ns) => erc7201Slot(ns.id).toLowerCase()),
      ...PLAIN_KECCAK_SLOTS.map((s) => plainKeccakSlot(s).toLowerCase()),
    ];
    expect(new Set(slots).size).to.equal(
      slots.length,
      "two storage namespaces hash to the same slot"
    );
  });
});
