// SPDX-License-Identifier: AGPL-3.0
// Uses shared storage derived from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

/**
 * @title IERC1155TokenReceiver
 * @dev Interface for contracts that want to handle safe receipt of ERC1155 tokens.
 *      See https://eips.ethereum.org/EIPS/eip-1155
 */
interface IERC1155TokenReceiver {
    /**
     * @notice Handle the receipt of a single ERC1155 token type.
     * @dev Must return `bytes4(keccak256("onERC1155Received(address,address,uint256,uint256,bytes)"))`
     *      (i.e. `0xf23a6e61`) to accept the transfer.
     * @param operator The address that initiated the transfer (i.e. msg.sender)
     * @param from The address which previously owned the token
     * @param id The ID of the token being transferred
     * @param value The amount of tokens being transferred
     * @param data Additional data with no specified format
     * @return The selector to confirm the token transfer acceptance
     */
    function onERC1155Received(
        address operator,
        address from,
        uint256 id,
        uint256 value,
        bytes calldata data
    ) external returns (bytes4);

    /**
     * @notice Handle the receipt of multiple ERC1155 token types.
     * @dev Must return `bytes4(keccak256("onERC1155BatchReceived(address,address,uint256[],uint256[],bytes)"))`
     *      (i.e. `0xbc197c81`) to accept the transfer.
     * @param operator The address that initiated the batch transfer (i.e. msg.sender)
     * @param from The address which previously owned the token
     * @param ids The IDs of each token being transferred
     * @param values The amounts of each token being transferred
     * @param data Additional data with no specified format
     * @return The selector to confirm the batch transfer acceptance
     */
    function onERC1155BatchReceived(
        address operator,
        address from,
        uint256[] calldata ids,
        uint256[] calldata values,
        bytes calldata data
    ) external returns (bytes4);
}