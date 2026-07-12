// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinOrder} from "../libraries/LibDoefinOrder.sol";

/**
 * @title DoefinOrderHarness
 * @notice Test harness that exposes LibDoefinOrder internals for the Hardhat / EIP-712
 *         differential test suite.
 * @dev SCRUM-234 (dead-code A-12/13/14) — the harness used to call the library's
 *      `memory` variants `hash` / `domainSeparator` / `hashOrder`. Production facets only
 *      use the `calldata` variants and `diamondDomainSeparator`, so the memory variants
 *      were dead in production but kept alive by this harness. The harness now uses the
 *      calldata variants for the order-hash paths and inlines the EIP-712 domain math
 *      directly so it can still be tested against arbitrary `(name, version, chainId,
 *      verifyingContract)` tuples — preserving the existing external test API while
 *      letting the three library `memory` variants be removed.
 */
contract DoefinOrderHarness {
    function DOEFIN_ORDER_TYPEHASH() external pure returns (bytes32) {
        return LibDoefinOrder.DOEFIN_ORDER_TYPEHASH;
    }

    function DOMAIN_SEPARATOR_TYPEHASH() external pure returns (bytes32) {
        return LibDoefinOrder.DOMAIN_SEPARATOR_TYPEHASH;
    }

    /// @notice EIP-712 struct hash for a DoefinOrder.
    function hash(LibDoefinOrder.DoefinOrder calldata order) external pure returns (bytes32) {
        return LibDoefinOrder.hashCalldata(order);
    }

    /// @notice EIP-712 domain separator for an arbitrary `(name, version, chainId,
    ///         verifyingContract)`. Mirrors the formula in
    ///         `LibDoefinOrder.diamondDomainSeparator` but exposes the four-tuple form
    ///         needed by negative / differential tests that the production
    ///         `diamondDomainSeparator(address)` doesn't.
    function domainSeparator(
        string memory name,
        string memory version,
        uint256 chainId,
        address verifyingContract
    ) external pure returns (bytes32) {
        return keccak256(
            abi.encode(
                LibDoefinOrder.DOMAIN_SEPARATOR_TYPEHASH,
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifyingContract
            )
        );
    }

    /// @notice Full EIP-712 order digest (`\x19\x01 || domainSeparator || structHash`).
    function hashOrder(
        LibDoefinOrder.DoefinOrder calldata order,
        bytes32 _domainSeparator
    ) external pure returns (bytes32) {
        return LibDoefinOrder.hashOrderCalldata(order, _domainSeparator);
    }
}
