// SPDX-License-Identifier: MIT
pragma solidity ^0.8.6;

import { LibDiamond } from  "../libraries/LibDiamond.sol";
import { LibERC1155 } from "../libraries/LibERC1155.sol";
import { IERC1155Facet } from "../interfaces/IERC1155.sol";

contract ERC1155Facet is IERC1155Facet {
    function balanceOf(address owner, uint256 id) external view override returns (uint256) {
        return LibERC1155.balanceOf(owner, id);
    }

    function balanceOfBatch(address[] calldata owners, uint256[] calldata ids) external view override returns (uint256[] memory batchBalances) {
        return LibERC1155.balanceOfBatch(owners, ids);
    }

    function setApprovalForAll(address operator, bool approved) external override {
        LibERC1155.setApprovalForAll(msg.sender, operator, approved);
        emit LibERC1155.ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address owner, address operator) external view override returns (bool) {
        return LibERC1155.isApprovedForAll(owner, operator);
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes calldata data) external override {
        LibERC1155.safeTransferFrom(msg.sender, from, to, id, value, data);
    }

    function safeBatchTransferFrom(address from, address to, uint256[] calldata ids, uint256[] calldata values, bytes calldata data) external override {
        LibERC1155.safeBatchTransferFrom(msg.sender, from, to, ids, values, data);
    }
}
