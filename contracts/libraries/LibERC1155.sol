// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {IERC1155TokenReceiver} from "../interfaces/IERC1155TokenReceiver.sol";

library LibERC1155 {
    function balanceOf(address owner, uint256 id) internal view returns (uint256) {
        require(owner != address(0), "ERC1155: balance query for zero address");
        return LibDoefinStorage.diamondStorage().erc1155Storage.erc1155Balances[id][owner];
    }

    function balanceOfBatch(address[] memory owners, uint256[] memory ids) internal view returns (uint256[] memory batchBalances) {
        require(owners.length == ids.length, "ERC1155: owners and IDs length mismatch");
        batchBalances = new uint256[](owners.length);
        for (uint256 i = 0; i < owners.length; ++i) {
            require(owners[i] != address(0), "ERC1155: zero address in batch query");
            batchBalances[i] = LibDoefinStorage.diamondStorage().erc1155Storage.erc1155Balances[ids[i]][owners[i]];
        }
    }

    function setApprovalForAll(address owner, address operator, bool approved) internal {
        LibDoefinStorage.diamondStorage().erc1155Storage.erc1155OperatorApprovals[owner][operator] = approved;
    }

    function isApprovedForAll(address owner, address operator) internal view returns (bool) {
        return LibDoefinStorage.diamondStorage().erc1155Storage.erc1155OperatorApprovals[owner][operator];
    }

    function safeTransferFrom(address operator, address from, address to, uint256 id, uint256 value, bytes memory data) internal {
        require(to != address(0), "ERC1155: transfer to zero address");

        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        require(from == operator || ds.erc1155Storage.erc1155OperatorApprovals[from][operator], "ERC1155: not owner nor approved");

        ds.erc1155Storage.erc1155Balances[id][from] -= value;
        ds.erc1155Storage.erc1155Balances[id][to] += value;

        emit TransferSingle(operator, from, to, id, value);

        _doSafeTransferAcceptanceCheck(operator, from, to, id, value, data);
    }

    function safeBatchTransferFrom(
        address operator,
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values,
        bytes memory data
    ) internal {
        require(ids.length == values.length, "ERC1155: ids and values length mismatch");
        require(to != address(0), "ERC1155: transfer to zero address");

        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        require(from == operator || ds.erc1155Storage.erc1155OperatorApprovals[from][operator], "ERC1155: not owner nor approved");

        for (uint256 i = 0; i < ids.length; ++i) {
            ds.erc1155Storage.erc1155Balances[ids[i]][from] -= values[i];
            ds.erc1155Storage.erc1155Balances[ids[i]][to] += values[i];
        }

        emit TransferBatch(operator, from, to, ids, values);

        _doSafeBatchTransferAcceptanceCheck(operator, from, to, ids, values, data);
    }

    function _mint(address to, uint256 id, uint256 value, bytes memory data) internal {
        require(to != address(0), "ERC1155: mint to zero address");

        LibDoefinStorage.diamondStorage().erc1155Storage.erc1155Balances[id][to] += value;

        emit TransferSingle(msg.sender, address(0), to, id, value);

        _doSafeTransferAcceptanceCheck(msg.sender, address(0), to, id, value, data);
    }

    function _batchMint(address to, uint256[] memory ids, uint256[] memory values, bytes memory data) internal {
        require(to != address(0), "ERC1155: batch mint to zero address");
        require(ids.length == values.length, "ERC1155: ids and values length mismatch");

        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        for (uint256 i = 0; i < ids.length; ++i) {
            ds.erc1155Storage.erc1155Balances[ids[i]][to] += values[i];
        }

        emit TransferBatch(msg.sender, address(0), to, ids, values);

        _doSafeBatchTransferAcceptanceCheck(msg.sender, address(0), to, ids, values, data);
    }

    function _burn(address from, uint256 id, uint256 value) internal {
        LibDoefinStorage.diamondStorage().erc1155Storage.erc1155Balances[id][from] -= value;

        emit TransferSingle(msg.sender, from, address(0), id, value);
    }

    function _batchBurn(address from, uint256[] memory ids, uint256[] memory values) internal {
        require(ids.length == values.length, "ERC1155: ids and values length mismatch");

        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        for (uint256 i = 0; i < ids.length; ++i) {
            ds.erc1155Storage.erc1155Balances[ids[i]][from] -= values[i];
        }

        emit TransferBatch(msg.sender, from, address(0), ids, values);
    }

    function _doSafeTransferAcceptanceCheck(address operator, address from, address to, uint256 id, uint256 value, bytes memory data) private {
        if (to.code.length > 0) {
            require(
                IERC1155TokenReceiver(to).onERC1155Received(operator, from, id, value, data) == IERC1155TokenReceiver.onERC1155Received.selector,
                "ERC1155: receiver rejected tokens"
            );
        }
    }

    function _doSafeBatchTransferAcceptanceCheck(
        address operator,
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values,
        bytes memory data
    ) private {
        if (to.code.length > 0) {
            require(
                IERC1155TokenReceiver(to).onERC1155BatchReceived(operator, from, ids, values, data) ==
                    IERC1155TokenReceiver.onERC1155BatchReceived.selector,
                "ERC1155: receiver rejected tokens"
            );
        }
    }

    // Emit events for compatibility
    event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value);
    event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
}
