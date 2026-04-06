// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinOrder} from "../libraries/LibDoefinOrder.sol";

/**
 * @title INonceManager
 * @author Doefin
 * @notice Interface for on-chain order cancellation and nonce management in the v2.1 settlement system
 */
interface INonceManager {
    function incrementNonce() external returns (uint256 newNonce);

    function cancelOrder(LibDoefinOrder.DoefinOrder calldata order) external;

    function cancelOrders(LibDoefinOrder.DoefinOrder[] calldata orders) external;

    function cancelOrdersForPosition(
        bytes32 positionId,
        uint256 minValidSalt
    ) external;

    function getNonce(address maker) external view returns (uint256);

    function isCancelled(bytes32 orderHash) external view returns (bool);

    function isOrderValid(LibDoefinOrder.DoefinOrder calldata order) external view returns (bool);
}
