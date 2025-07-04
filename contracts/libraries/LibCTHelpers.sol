// SPDX-License-Identifier: MIT
pragma solidity ^0.8.6;

library LibCTHelpers {
    uint256 constant P = 21888242871839275222246405745257275088696311157297823662689037894645226208583;
    uint256 constant B = 3;

    function getConditionId(
        address oracle,
        bytes32 questionId,
        uint256 outcomeSlotCount
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(oracle, questionId, outcomeSlotCount));
    }

    function getPositionId(
        address collateralToken,
        bytes32 collectionId
    ) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(collateralToken, collectionId)));
    }

    function getCollectionId(
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256 indexSet
    ) internal view returns (bytes32) {
        uint256 x1 = uint256(keccak256(abi.encodePacked(conditionId, indexSet)));
        bool odd = (x1 >> 255) != 0;
        uint256 y1;
        uint256 yy;

        do {
            x1 = addmod(x1, 1, P);
            yy = addmod(mulmod(x1, mulmod(x1, x1, P), P), B, P);
            y1 = sqrt(yy);
        } while (mulmod(y1, y1, P) != yy);

        if ((odd && y1 % 2 == 0) || (!odd && y1 % 2 == 1)) {
            y1 = P - y1;
        }

        if (parentCollectionId != 0) {
            uint256 x2 = uint256(parentCollectionId);
            odd = (x2 >> 254) != 0;
            x2 = (x2 << 2) >> 2;
            yy = addmod(mulmod(x2, mulmod(x2, x2, P), P), B, P);
            uint256 y2 = sqrt(yy);
            if ((odd && y2 % 2 == 0) || (!odd && y2 % 2 == 1)) {
                y2 = P - y2;
            }
            require(mulmod(y2, y2, P) == yy, "Invalid parentCollectionId");

            // ECADD precompile (0x06)
            (bool success, bytes memory ret) = address(6).staticcall(abi.encode(x1, y1, x2, y2));
            require(success, "ECADD failed");
            (x1, y1) = abi.decode(ret, (uint256, uint256));
        }

        if (y1 % 2 == 1) {
            x1 ^= 1 << 254;
        }

        return bytes32(x1);
    }

    function sqrt(uint256 xx) internal pure returns (uint256 r) {
        if (xx == 0) return 0;
        else if (xx <= 3) return 1;
        uint256 z = (xx + 1) / 2;
        r = xx;
        while (z < r) {
            r = z;
            z = (xx / z + z) / 2;
        }
    }
}
