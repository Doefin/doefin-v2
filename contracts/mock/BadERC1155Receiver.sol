// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

/**
 * @title BadERC1155Receiver
 * @notice Test-only contract. Implements the ERC-1155 receiver hooks but
 *         returns a non-magic selector, so a transfer into it must be
 *         rejected by `LibERC1155._doSafeTransfer*AcceptanceCheck` with
 *         `ERC1155ReceiverRejectedTokens`.
 */
contract BadERC1155Receiver {
    function onERC1155Received(
        address,
        address,
        uint256,
        uint256,
        bytes calldata
    ) external pure returns (bytes4) {
        return 0xdeadbeef; // not IERC1155TokenReceiver.onERC1155Received.selector
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        return 0xdeadbeef; // not IERC1155TokenReceiver.onERC1155BatchReceived.selector
    }
}
