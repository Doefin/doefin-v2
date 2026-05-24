// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibERC1155} from "../libraries/LibERC1155.sol";

/**
 * @title LibERC1155Harness
 * @notice Test-only harness exposing the internal mint/burn helpers of
 *         `LibERC1155`. The library's `_mint` / `_batchMint` / `_batchBurn`
 *         are only ever called from the CTF split/merge/redeem flows, which
 *         always pass well-formed arguments — so their input-validation
 *         reverts (and the single-`_mint` happy path) are unreachable through
 *         any facet. This harness drives them directly. It operates on its
 *         own EIP-7201 `AppStorage` namespace, isolated from any Diamond.
 *
 *         Mirrors the existing `DoefinOrderHarness` library-test pattern.
 */
contract LibERC1155Harness {
    function mint(address to, uint256 id, uint256 value, bytes calldata data) external {
        LibERC1155._mint(to, id, value, data);
    }

    function batchMint(
        address to,
        uint256[] calldata ids,
        uint256[] calldata values,
        bytes calldata data
    ) external {
        LibERC1155._batchMint(to, ids, values, data);
    }

    function batchBurn(address from, uint256[] calldata ids, uint256[] calldata values) external {
        LibERC1155._batchBurn(from, ids, values);
    }

    function balanceOf(address owner, uint256 id) external view returns (uint256) {
        return LibERC1155.balanceOf(owner, id);
    }
}
