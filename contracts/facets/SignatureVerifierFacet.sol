// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinOrder} from "../libraries/LibDoefinOrder.sol";
import {LibSettlementStorage} from "../libraries/LibSettlementStorage.sol";
import {Errors} from "../libraries/Errors.sol";
import {Events} from "../libraries/Events.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ISignatureVerifier} from "../interfaces/ISignatureVerifier.sol";

/**
 * @title SignatureVerifierFacet
 * @author Doefin
 * @notice EIP-712 order signature verification for the v2.1 hybrid settlement system
 * @dev Supports EOA signatures (ecrecover) and smart contract wallet signatures (EIP-1271).
 *      Called by SettlementFacet during order settlement to validate both taker and maker signatures.
 *      Uses LibDoefinOrder for all hashing -- does NOT reimplement EIP-712 logic.
 */
contract SignatureVerifierFacet is ISignatureVerifier {
    /// @notice EIP-1271 magic value returned on successful signature validation
    bytes4 internal constant EIP1271_MAGIC_VALUE = 0x1626ba7e;

    // ========================================
    // EXTERNAL VIEW FUNCTIONS
    // ========================================

    /**
     * @notice Verify an order signature and return true if valid
     * @dev For signatureType 0 (EOA): ecrecover must match order.signer, and signer must equal maker.
     *      For signatureType 1 (EIP-1271): ecrecover must match order.signer, then either the signer
     *      is pre-registered for the maker SCW, or IERC1271.isValidSignature on the maker must return
     *      the magic value.
     * @param order The DoefinOrder struct
     * @param signature The 65-byte ECDSA signature
     * @param signatureType 0 = EOA, 1 = EIP-1271
     * @return True if the signature is valid
     * @custom:reverts InvalidOrderSignature if signature verification fails
     * @custom:reverts InvalidSignatureLength if signature is not 65 bytes
     */
    function verifyOrderSignature(
        LibDoefinOrder.DoefinOrder calldata order,
        bytes calldata signature,
        uint8 signatureType
    ) external view returns (bool) {
        bytes32 orderHash = _getOrderHash(order);
        _verifySignature(order, orderHash, signature, signatureType);
        return true;
    }

    /**
     * @notice Compute the full EIP-712 hash of an order
     * @param order The DoefinOrder struct
     * @return The EIP-712 hash (\\x19\\x01 + domain separator + struct hash)
     */
    function getOrderHash(
        LibDoefinOrder.DoefinOrder calldata order
    ) external view returns (bytes32) {
        return _getOrderHash(order);
    }

    /**
     * @notice Get the EIP-712 domain separator for this contract
     * @return The domain separator computed from the Diamond's address and current chain ID
     */
    function getDomainSeparator() external view returns (bytes32) {
        return _getDomainSeparator();
    }

    /**
     * @notice Register an EOA as authorized signer for a smart contract wallet
     * @dev Only the SCW itself can call this (msg.sender == the SCW).
     *      Registered signers can bypass the EIP-1271 isValidSignature call during verification.
     * @param signer The EOA signer address to register or unregister
     * @param allowed Whether the signer should be authorized
     * @custom:emits OrderSignerRegistered
     */
    function registerOrderSigner(address signer, bool allowed) external {
        LibSettlementStorage.SettlementStorage storage ss = LibSettlementStorage.settlementStorage();
        ss.registeredOrderSigners[msg.sender][signer] = allowed;
        emit Events.OrderSignerRegistered(msg.sender, signer, allowed);
    }

    /**
     * @notice Check if a signer is registered for a SCW
     * @param scw The smart contract wallet address
     * @param signer The EOA signer address
     * @return True if the signer is registered for the SCW
     */
    function isRegisteredSigner(address scw, address signer) external view returns (bool) {
        LibSettlementStorage.SettlementStorage storage ss = LibSettlementStorage.settlementStorage();
        return ss.registeredOrderSigners[scw][signer];
    }

    // ========================================
    // INTERNAL FUNCTIONS
    // ========================================

    /**
     * @dev Compute the EIP-712 domain separator using the Diamond's address and chain ID
     * @return The domain separator
     */
    function _getDomainSeparator() internal view returns (bytes32) {
        return LibDoefinOrder.domainSeparator(
            "Doefin Exchange",
            "2.1",
            block.chainid,
            address(this)
        );
    }

    /**
     * @dev Compute the full EIP-712 order hash
     * @param order The DoefinOrder struct
     * @return The full EIP-712 hash
     */
    function _getOrderHash(LibDoefinOrder.DoefinOrder calldata order) internal view returns (bytes32) {
        return LibDoefinOrder.hashOrderCalldata(order, _getDomainSeparator());
    }

    /**
     * @dev Core verification logic for both EOA and EIP-1271 signatures
     * @param order The DoefinOrder struct
     * @param orderHash The pre-computed EIP-712 order hash
     * @param signature The 65-byte ECDSA signature
     * @param signatureType 0 = EOA, 1 = EIP-1271
     * @custom:reverts InvalidOrderSignature if verification fails
     * @custom:reverts InvalidSignatureLength if signature is not 65 bytes
     */
    function _verifySignature(
        LibDoefinOrder.DoefinOrder calldata order,
        bytes32 orderHash,
        bytes calldata signature,
        uint8 signatureType
    ) internal view {
        address recoveredSigner = _recoverSigner(orderHash, signature);

        if (recoveredSigner == address(0) || recoveredSigner != order.signer) {
            revert Errors.InvalidOrderSignature(orderHash);
        }

        if (signatureType == 0) {
            // EOA mode: signer must equal maker
            if (order.signer != order.maker) {
                revert Errors.InvalidOrderSignature(orderHash);
            }
        } else if (signatureType == 1) {
            // EIP-1271 mode: skip isValidSignature call if signer is pre-registered
            LibSettlementStorage.SettlementStorage storage ss = LibSettlementStorage.settlementStorage();
            if (!ss.registeredOrderSigners[order.maker][order.signer]) {
                // Fall through to EIP-1271 validation on the maker SCW
                bytes4 result = IERC1271(order.maker).isValidSignature(orderHash, signature);
                if (result != EIP1271_MAGIC_VALUE) {
                    revert Errors.InvalidOrderSignature(orderHash);
                }
            }
        } else {
            revert Errors.InvalidOrderSignature(orderHash);
        }
    }

    /**
     * @dev Recover signer address from a 65-byte ECDSA signature
     * @dev Normalizes v to 27/28 if provided as 0/1
     * @param digest The message hash that was signed
     * @param signature The 65-byte ECDSA signature (r + s + v)
     * @return The recovered signer address (address(0) if invalid)
     * @custom:reverts InvalidSignatureLength if signature is not 65 bytes
     */
    function _recoverSigner(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        if (signature.length != 65) {
            revert Errors.InvalidSignatureLength();
        }

        bytes32 r;
        bytes32 s;
        uint8 v;

        assembly {
            // calldata layout: signature.offset points to the data
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }

        // Normalize v: some signers return 0/1 instead of 27/28
        if (v < 27) {
            v += 27;
        }

        return ecrecover(digest, v, r, s);
    }
}
