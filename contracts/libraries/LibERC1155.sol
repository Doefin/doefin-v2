// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {IERC1155TokenReceiver} from "../interfaces/IERC1155TokenReceiver.sol";
import {Errors} from "./Errors.sol";
import {Events} from "./Events.sol";

library LibERC1155 {
    function balanceOf(address owner, uint256 id) internal view returns (uint256) {
        if (owner == address(0)) revert Errors.ZeroAddressQuery();
        return LibDoefinStorage.diamondStorage().erc1155Storage.erc1155Balances[id][owner];
    }

    function balanceOfBatch(address[] memory owners, uint256[] memory ids) internal view returns (uint256[] memory batchBalances) {
        if (owners.length == 0 || ids.length == 0) {
            return new uint256[](0);
        }
        if (owners.length != ids.length) revert Errors.ArrayLengthMismatch();
        batchBalances = new uint256[](owners.length);
        for (uint256 i = 0; i < owners.length; ++i) {
            if (owners[i] == address(0)) revert Errors.ZeroAddressQuery();
            batchBalances[i] = LibDoefinStorage.diamondStorage().erc1155Storage.erc1155Balances[ids[i]][owners[i]];
        }
    }

    function setApprovalForAll(
        address owner,
        address operator,
        bool approved
    ) internal {
        LibDoefinStorage.diamondStorage().erc1155Storage.erc1155OperatorApprovals[owner][operator] = approved;
        emit Events.ApprovalForAll(owner, operator, approved);
    }

    function isApprovedForAll(address owner, address operator) internal view returns (bool) {
        return LibDoefinStorage.diamondStorage().erc1155Storage.erc1155OperatorApprovals[owner][operator];
    }

    function safeTransferFrom(
        address operator,
        address from,
        address to,
        uint256 id,
        uint256 value,
        bytes memory data
    ) internal {
        if (from == address(0) || to == address(0)) revert Errors.TransferToZeroAddress();

        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        if (from != operator && !ds.erc1155Storage.erc1155OperatorApprovals[from][operator]) {
            revert Errors.NotOwnerNorApproved();
        }

        ds.erc1155Storage.erc1155Balances[id][from] -= value;
        ds.erc1155Storage.erc1155Balances[id][to] += value;

        emit Events.TransferSingle(operator, from, to, id, value);

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
        if (from == address(0) || to == address(0)) revert Errors.TransferToZeroAddress();
        if (ids.length == 0 || values.length == 0) revert Errors.EmptyArray();
        if (ids.length != values.length) revert Errors.ArrayLengthMismatch();

        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        if (from != operator && !ds.erc1155Storage.erc1155OperatorApprovals[from][operator]) revert Errors.NotOwnerNorApproved();

        for (uint256 i = 0; i < ids.length; ++i) {
            ds.erc1155Storage.erc1155Balances[ids[i]][from] -= values[i];
            ds.erc1155Storage.erc1155Balances[ids[i]][to] += values[i];
        }

        emit Events.TransferBatch(operator, from, to, ids, values);

        _doSafeBatchTransferAcceptanceCheck(operator, from, to, ids, values, data);
    }

    function _mint(
        address to,
        uint256 id,
        uint256 value,
        bytes memory data
    ) internal {
        if (to == address(0)) revert Errors.MintToZeroAddress();

        LibDoefinStorage.diamondStorage().erc1155Storage.erc1155Balances[id][to] += value;

        emit Events.TransferSingle(msg.sender, address(0), to, id, value);

        _doSafeTransferAcceptanceCheck(msg.sender, address(0), to, id, value, data);
    }

    function _batchMint(
        address to,
        uint256[] memory ids,
        uint256[] memory values,
        bytes memory data
    ) internal {
        if (to == address(0)) revert Errors.MintToZeroAddress();
        if (ids.length != values.length) revert Errors.ArrayLengthMismatch();

        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        for (uint256 i = 0; i < ids.length; ++i) {
            ds.erc1155Storage.erc1155Balances[ids[i]][to] += values[i];
        }

        emit Events.TransferBatch(msg.sender, address(0), to, ids, values);

        _doSafeBatchTransferAcceptanceCheck(msg.sender, address(0), to, ids, values, data);
    }

    function _burn(
        address from,
        uint256 id,
        uint256 value
    ) internal {
        LibDoefinStorage.diamondStorage().erc1155Storage.erc1155Balances[id][from] -= value;

        emit Events.TransferSingle(msg.sender, from, address(0), id, value);
    }

    function _batchBurn(
        address from,
        uint256[] memory ids,
        uint256[] memory values
    ) internal {
        if (ids.length != values.length) revert Errors.ArrayLengthMismatch();

        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        for (uint256 i = 0; i < ids.length; ++i) {
            ds.erc1155Storage.erc1155Balances[ids[i]][from] -= values[i];
        }

        emit Events.TransferBatch(msg.sender, from, address(0), ids, values);
    }

    function _doSafeTransferAcceptanceCheck(
        address operator,
        address from,
        address to,
        uint256 id,
        uint256 value,
        bytes memory data
    ) private {
        if (to.code.length > 0) {
            if (IERC1155TokenReceiver(to).onERC1155Received(operator, from, id, value, data) != IERC1155TokenReceiver.onERC1155Received.selector)
                revert Errors.ERC1155ReceiverRejectedTokens();
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
            if (
                IERC1155TokenReceiver(to).onERC1155BatchReceived(operator, from, ids, values, data) !=
                IERC1155TokenReceiver.onERC1155BatchReceived.selector
            ) revert Errors.ERC1155ReceiverRejectedTokens();
        }
    }
}
