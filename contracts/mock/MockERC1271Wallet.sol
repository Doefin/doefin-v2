// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/**
 * @title MockERC1271Wallet
 * @notice Mock smart contract wallet for testing EIP-1271 signature verification
 */
contract MockERC1271Wallet is IERC1271 {
    bytes4 internal constant MAGIC_VALUE = 0x1626ba7e;

    bool public shouldReturnValid;

    constructor(bool _shouldReturnValid) {
        shouldReturnValid = _shouldReturnValid;
    }

    function setShouldReturnValid(bool _valid) external {
        shouldReturnValid = _valid;
    }

    receive() external payable {}

    function isValidSignature(bytes32, bytes calldata) external view override returns (bytes4) {
        if (shouldReturnValid) {
            return MAGIC_VALUE;
        }
        return 0xffffffff;
    }
}
