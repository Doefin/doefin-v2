// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinOrder} from "../libraries/LibDoefinOrder.sol";

/**
 * @title DoefinOrderHarness
 * @notice Test harness that exposes LibDoefinOrder internal functions for Hardhat tests
 */
contract DoefinOrderHarness {
    function DOEFIN_ORDER_TYPEHASH() external pure returns (bytes32) {
        return LibDoefinOrder.DOEFIN_ORDER_TYPEHASH;
    }

    function DOMAIN_SEPARATOR_TYPEHASH() external pure returns (bytes32) {
        return LibDoefinOrder.DOMAIN_SEPARATOR_TYPEHASH;
    }

    function hash(LibDoefinOrder.DoefinOrder memory order) external pure returns (bytes32) {
        return LibDoefinOrder.hash(order);
    }

    function domainSeparator(
        string memory name,
        string memory version,
        uint256 chainId,
        address verifyingContract
    ) external pure returns (bytes32) {
        return LibDoefinOrder.domainSeparator(name, version, chainId, verifyingContract);
    }

    function hashOrder(
        LibDoefinOrder.DoefinOrder memory order,
        bytes32 _domainSeparator
    ) external pure returns (bytes32) {
        return LibDoefinOrder.hashOrder(order, _domainSeparator);
    }
}
