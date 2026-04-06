// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinOrder} from "../libraries/LibDoefinOrder.sol";

/**
 * @title ISignatureVerifier
 * @author Doefin
 * @notice Interface for EIP-712 order signature verification in the v2.1 settlement system
 */
interface ISignatureVerifier {
    function verifyOrderSignature(
        LibDoefinOrder.DoefinOrder calldata order,
        bytes calldata signature,
        uint8 signatureType
    ) external view returns (bool);

    function getOrderHash(
        LibDoefinOrder.DoefinOrder calldata order
    ) external view returns (bytes32);

    function getDomainSeparator() external view returns (bytes32);

    function registerOrderSigner(address signer, bool allowed) external;

    function isRegisteredSigner(address scw, address signer) external view returns (bool);
}
