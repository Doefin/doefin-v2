// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.20;

import {LibCTFCondition} from "../libraries/LibCTFCondition.sol";
import {LibAdminConfigStorage} from "../libraries/LibAdminConfigStorage.sol";
import {LibReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {LibERC1155} from "../libraries/LibERC1155.sol";

/**
 * @title CTFInternalHarness
 * @notice TEST-ONLY (CTF-008): calls LibCTFCondition's internal split variant — the one settlement
 *         uses with the Diamond as holder — with and without holding the reentrancy lock.
 */
contract CTFInternalHarness {
    function setUp(address collateralToken, bytes32 questionId) external returns (bytes32 conditionId) {
        LibAdminConfigStorage.adminConfigStorage().isAllowed[collateralToken] = true;
        conditionId = LibCTFCondition.prepareCondition(address(this), questionId, 2);
    }

    function splitWithoutLock(address collateralToken, bytes32 conditionId, uint256 amount) external {
        LibCTFCondition._splitPositionInternal(address(this), collateralToken, bytes32(0), conditionId, amount, _binary());
    }

    function splitHoldingLock(address collateralToken, bytes32 conditionId, uint256 amount) external {
        LibReentrancyGuard._nonReentrantBefore();
        LibCTFCondition._splitPositionInternal(address(this), collateralToken, bytes32(0), conditionId, amount, _binary());
        LibReentrancyGuard._nonReentrantAfter();
    }

    function balanceOf(uint256 id) external view returns (uint256) {
        return LibERC1155.balanceOf(address(this), id);
    }

    function _binary() private pure returns (uint256[] memory partition) {
        partition = new uint256[](2);
        partition[0] = 1;
        partition[1] = 2;
    }
}
