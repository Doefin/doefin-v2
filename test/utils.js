const { keccak256, toUtf8Bytes, solidityPack } = require("ethers/lib/utils");
const { BigNumber } = require("ethers");

const P = BigNumber.from("21888242871839275222246405745257275088696311157297823662689037894645226208583");
const B = BigNumber.from(3);

// Helper: modular exponentiation
function expMod(base, exponent, modulus) {
    if (modulus.eq(0)) throw new Error("Modulus is zero");
    let result = BigNumber.from(1);
    base = base.mod(modulus);
    while (!exponent.isZero()) {
        if (exponent.mod(2).eq(1)) {
            result = result.mul(base).mod(modulus);
        }
        base = base.mul(base).mod(modulus);
        exponent = exponent.div(2);
    }
    return result;
}

// Helper: modular square root (Tonelli–Shanks is general, here simplified since P ≡ 3 (mod 4))
function sqrt(a) {
    return expMod(a, P.add(1).div(4), P);
}

// Get condition ID
function getConditionId(oracle, questionId, outcomeSlotCount) {
    return keccak256(solidityPack(["address", "bytes32", "uint256"], [oracle, questionId, outcomeSlotCount]));
}

// Get position ID
function getPositionId(collateralToken, collectionId) {
    return BigNumber.from(
        keccak256(solidityPack(["address", "bytes32"], [collateralToken, collectionId]))
    );
}

// Get collection ID (this matches the elliptic curve addition logic with ECADD precompile at address 0x06)
async function getCollectionId(parentCollectionId, conditionId, indexSet, ethersProvider) {
    let x1 = BigNumber.from(
        keccak256(solidityPack(["bytes32", "uint256"], [conditionId, indexSet]))
    );
    let odd = x1.shr(255).eq(1);

    let y1, yy;

    do {
        x1 = x1.add(1).mod(P);
        yy = x1.mul(x1).mod(P).mul(x1).mod(P).add(B).mod(P);
        yy = x1.mul(x1).mod(P).mul(x1).mod(P).add(B).mod(P);
        y1 = sqrt(yy);
    } while (!y1.mul(y1).mod(P).eq(yy));

    if ((odd && y1.mod(2).eq(0)) || (!odd && y1.mod(2).eq(1))) {
        y1 = P.sub(y1);
    }

    if (!BigNumber.from(parentCollectionId).eq(0)) {
        let x2 = BigNumber.from(parentCollectionId);
        odd = x2.shr(254).eq(1);
        x2 = x2.shl(2).shr(2);

        yy = x2.mul(x2).mod(P).mul(x2).mod(P).add(B).mod(P);
        let y2 = sqrt(yy);

        if ((odd && y2.mod(2).eq(0)) || (!odd && y2.mod(2).eq(1))) {
            y2 = P.sub(y2);
        }

        if (!y2.mul(y2).mod(P).eq(yy)) {
            throw new Error("Invalid parentCollectionId");
        }

        // Call ECADD precompile at 0x06
        const abiCoder = new ethers.utils.AbiCoder();
        const input = abiCoder.encode(["uint256", "uint256", "uint256", "uint256"], [x1, y1, x2, y2]);
        const result = await ethersProvider.call({ to: "0x0000000000000000000000000000000000000006", data: input });

        [x1, y1] = abiCoder.decode(["uint256", "uint256"], result);
    }

    if (BigNumber.from(y1).mod(2).eq(1)) {
        x1 = BigNumber.from(x1).xor(BigNumber.from(1).shl(254));
    }

    return BigNumber.from(x1).toHexString().padStart(66, '0'); // bytes32 as hex string
}

function parseTransferBatch(receipt, expectedFrom, expectedTo) {
    const batchEvent = receipt.events.find(
        (e) =>
            e.event === "TransferBatch" &&
            e.args.from.toLowerCase() === expectedFrom.toLowerCase() &&
            e.args.to.toLowerCase() === expectedTo.toLowerCase()
    );

    if (!batchEvent) {
        throw new Error("TransferBatch event not found");
    }

    const idsArray = Array.from(batchEvent.args[3]); // ids filed of transfer batch
    const valuesArray = Array.from(batchEvent.args[4]); // values field 

    return {
        positionIds: idsArray.map((id) => id.toString()),
        amounts: valuesArray.map((v) => v.toString()),
    };
}

module.exports = {
    getConditionId,
    getPositionId,
    getCollectionId,
    parseTransferBatch
};
