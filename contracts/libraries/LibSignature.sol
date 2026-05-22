// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {LibDoefinOrder} from "./LibDoefinOrder.sol";
import {LibSettlementStorage} from "./LibSettlementStorage.sol";
import {Errors} from "./Errors.sol";

/**
 * @title LibSignature
 * @author Doefin
 * @notice Shared ECDSA + EIP-1271 signature primitives for the Doefin protocol
 * @dev Single source of truth for v normalization, low-`s` malleability rejection, and
 *      EIP-1271 dispatch. Promoted from duplicated implementations in
 *      SettlementFacet and SignatureVerifierFacet (SEC-005).
 * @custom:security Always rejects high-`s` signatures (lower half of secp256k1 order only)
 *      and normalizes `v` to 27/28. Returns `address(0)` for invalid recoveries so callers
 *      can match the existing `recoveredSigner == address(0)` check pattern.
 * @custom:audit SEC-005 — was multiple copies that lacked v normalization and the low-`s`
 *      malleability check; consolidated here. REMAINING-1 corroborates.
 */
library LibSignature {
    /// @notice secp256k1 half curve order — EIP-2 / Ethereum Yellow Paper. The maximum
    ///         valid `s` value to enforce signature non-malleability.
    bytes32 internal constant SECP256K1_HALF_N =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    /// @notice EIP-1271 magic value returned by `isValidSignature` on success.
    bytes4 internal constant EIP1271_MAGIC_VALUE = 0x1626ba7e;

    /**
     * @dev Recover the signer from a 65-byte ECDSA signature stored in calldata.
     * @param digest The 32-byte message digest that was signed.
     * @param signature The 65-byte signature `r || s || v`.
     * @return signer The recovered signer address, or `address(0)` on failure.
     * @custom:reverts InvalidSignatureLength if `signature.length != 65`.
     */
    function recoverCalldata(bytes32 digest, bytes calldata signature) internal pure returns (address signer) {
        if (signature.length != 65) revert Errors.InvalidSignatureLength();

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        return _recover(digest, r, s, v);
    }

    /**
     * @dev Verify an EIP-1271 signature against a smart-contract signer.
     * @dev Uses the typed `IERC1271(signer).isValidSignature(...)` dispatch rather than a
     *      raw `staticcall`; the compiler enforces the call's success and decodes the
     *      return value, eliminating two classes of regression (silent failure on a
     *      non-existent target, malformed return decode).
     * @param signer The contract claimed as the signer (must implement IERC1271).
     * @param digest The message hash that was signed.
     * @param signature The signature to verify.
     * @return True if `signer.isValidSignature(digest, signature)` returned the magic value.
     */
    function verifyEIP1271(address signer, bytes32 digest, bytes memory signature) internal view returns (bool) {
        try IERC1271(signer).isValidSignature(digest, signature) returns (bytes4 result) {
            return result == EIP1271_MAGIC_VALUE;
        } catch {
            return false;
        }
    }

    /**
     * @dev Internal raw recovery. Normalizes `v` (0/1 → 27/28) and rejects high-`s`
     *      malleable signatures by returning `address(0)`.
     */
    function _recover(bytes32 digest, bytes32 r, bytes32 s, uint8 v) private pure returns (address) {
        // Normalize v: some signers return 0/1 instead of 27/28
        if (v < 27) v += 27;

        // Reject malleable signatures: s must be in the lower half of the curve order
        if (uint256(s) > uint256(SECP256K1_HALF_N)) {
            return address(0);
        }

        return ecrecover(digest, v, r, s);
    }

    /**
     * @notice Verify an EIP-712 order signature — EOA (type 0) or EIP-1271 (type 1).
     * @dev The single dispatch wrapper for the v3 facets. Promoted from byte-for-byte
     *      copies in SettlementFacet and SignatureVerifierFacet (CPX-001 / SCRUM-230):
     *      a settlement-facet copy and an orderbook-pre-check copy could drift apart,
     *      so the signature-acceptance policy now lives here once.
     * @param order The DoefinOrder being verified.
     * @param orderHash The pre-computed EIP-712 order hash.
     * @param signature The 65-byte ECDSA signature.
     * @param signatureType 0 = EOA (signer must be maker), 1 = EIP-1271 (or a
     *        pre-registered delegated signer); any other value is rejected.
     * @custom:reverts InvalidOrderSignature if recovery fails, the recovered signer
     *      does not match `order.signer`, the type-0 signer is not the maker, the
     *      EIP-1271 check fails, or `signatureType > 1`.
     */
    function verifyOrderSignature(
        LibDoefinOrder.DoefinOrder calldata order,
        bytes32 orderHash,
        bytes calldata signature,
        uint8 signatureType
    ) internal view {
        address recoveredSigner = recoverCalldata(orderHash, signature);
        if (recoveredSigner == address(0) || recoveredSigner != order.signer) {
            revert Errors.InvalidOrderSignature(orderHash);
        }

        if (signatureType == 0) {
            // EOA: signer must be maker
            if (order.signer != order.maker) revert Errors.InvalidOrderSignature(orderHash);
        } else if (signatureType == 1) {
            // EIP-1271: short-circuit on a pre-registered EOA signer; otherwise dispatch
            // to IERC1271(maker).isValidSignature.
            LibSettlementStorage.SettlementStorage storage ss = LibSettlementStorage.settlementStorage();
            if (!ss.registeredOrderSigners[order.maker][order.signer]) {
                if (!verifyEIP1271(order.maker, orderHash, signature)) {
                    revert Errors.InvalidOrderSignature(orderHash);
                }
            }
        } else {
            revert Errors.InvalidOrderSignature(orderHash);
        }
    }
}
