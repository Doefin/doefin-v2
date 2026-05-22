// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinOrder} from "../libraries/LibDoefinOrder.sol";
import {LibSettlementStorage} from "../libraries/LibSettlementStorage.sol";
import {LibSignature} from "../libraries/LibSignature.sol";
import {Events} from "../libraries/Events.sol";
import {ISignatureVerifier} from "../interfaces/ISignatureVerifier.sol";

/**
 * @title SignatureVerifierFacet
 * @author Doefin
 * @notice EIP-712 order signature verification for the v3 hybrid settlement system
 * @dev Supports EOA signatures (ecrecover) and smart contract wallet signatures (EIP-1271).
 *      Called by SettlementFacet during order settlement to validate both taker and maker signatures.
 *      Uses LibDoefinOrder for all hashing -- does NOT reimplement EIP-712 logic.
 */
contract SignatureVerifierFacet is ISignatureVerifier {
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
        LibSignature.verifyOrderSignature(order, orderHash, signature, signatureType);
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
     * @dev Compute the EIP-712 domain separator using the Diamond's address and chain ID.
     * @return The domain separator.
     * @custom:audit SEC-004 — delegates to {LibDoefinOrder.diamondDomainSeparator} so the
     *      three v3 facets (Settlement, SignatureVerifier, NonceManager) cannot drift.
     */
    function _getDomainSeparator() internal view returns (bytes32) {
        return LibDoefinOrder.diamondDomainSeparator(address(this));
    }

    /**
     * @dev Compute the full EIP-712 order hash
     * @param order The DoefinOrder struct
     * @return The full EIP-712 hash
     */
    function _getOrderHash(LibDoefinOrder.DoefinOrder calldata order) internal view returns (bytes32) {
        return LibDoefinOrder.hashOrderCalldata(order, _getDomainSeparator());
    }

}
