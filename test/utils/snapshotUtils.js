async function takeSnapshot() {
    return await ethers.provider.send("evm_snapshot", []);
}

async function revertToSnapshot(snapshotId) {
    await ethers.provider.send("evm_revert", [snapshotId]);
}

module.exports = {
    takeSnapshot,
    revertToSnapshot,
};