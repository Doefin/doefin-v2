// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

/**
 * @title LibDoefinOrder
 * @author Doefin
 * @notice EIP-712 order struct and hashing for off-chain signed orders
 * @dev The struct field order and types MUST match the backend Python EIP-712 definition byte-for-byte.
 *      signature and signatureType are NOT part of the struct hash — they are passed alongside.
 */
library LibDoefinOrder {
    // ========================================
    // ORDER STRUCT
    // ========================================

    /// @notice Off-chain signed order for the hybrid settlement model
    /// @dev Field order is canonical and must not be reordered
    /// @dev SCRUM-224 — `feeRateBps` removed: the fee is no longer signed by the
    ///      maker. The operator supplies the per-leg fee amount at settlement and
    ///      the contract enforces an admin-set maximum rate (Polymarket V2 model).
    struct DoefinOrder {
        uint256 salt;
        address maker;           // SCW (Safe) address holding funds
        address signer;          // EOA that signed the order
        bytes32 positionId;      // CTF ERC1155 position ID
        address collateralToken;
        uint8 side;              // 0 = BUY, 1 = SELL
        uint128 amount;
        uint128 pricePerToken;
        uint64 expiration;       // 0 = no expiry
        uint256 nonce;
    }

    // ========================================
    // EIP-712 TYPE HASHES
    // ========================================

    /// @notice EIP-712 typehash for the DoefinOrder struct
    bytes32 internal constant DOEFIN_ORDER_TYPEHASH = keccak256(
        "DoefinOrder("
        "uint256 salt,"
        "address maker,"
        "address signer,"
        "bytes32 positionId,"
        "address collateralToken,"
        "uint8 side,"
        "uint128 amount,"
        "uint128 pricePerToken,"
        "uint64 expiration,"
        "uint256 nonce"
        ")"
    );

    /// @notice EIP-712 domain separator typehash
    bytes32 internal constant DOMAIN_SEPARATOR_TYPEHASH = keccak256(
        "EIP712Domain("
        "string name,"
        "string version,"
        "uint256 chainId,"
        "address verifyingContract"
        ")"
    );

    /// @notice Precomputed keccak256 of the EIP-712 domain `name` and `version` (GAS-002).
    /// @dev The protocol name/version are compile-time constants; hashing them from
    ///      `string memory` on every `diamondDomainSeparator` call is a hot-path cost
    ///      avoided by precomputing the hashes here.
    bytes32 internal constant DOMAIN_NAME_HASH = keccak256("Doefin Exchange");
    bytes32 internal constant DOMAIN_VERSION_HASH = keccak256("3");

    // ========================================
    // HASHING FUNCTIONS
    // ========================================

    /// @notice Compute the EIP-712 struct hash of a DoefinOrder
    /// @param order The order to hash
    /// @return The keccak256 struct hash
    function hash(DoefinOrder memory order) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                DOEFIN_ORDER_TYPEHASH,
                order.salt,
                order.maker,
                order.signer,
                order.positionId,
                order.collateralToken,
                order.side,
                order.amount,
                order.pricePerToken,
                order.expiration,
                order.nonce
            )
        );
    }

    /// @notice Compute the EIP-712 domain separator
    /// @param name The protocol name ("Doefin Exchange")
    /// @param version The protocol version ("3")
    /// @param chainId The chain ID
    /// @param verifyingContract The Diamond proxy address
    /// @return The keccak256 domain separator
    function domainSeparator(
        string memory name,
        string memory version,
        uint256 chainId,
        address verifyingContract
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_SEPARATOR_TYPEHASH,
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifyingContract
            )
        );
    }

    /// @notice Convenience helper: compute the canonical Diamond domain separator using the
    ///         current `block.chainid` and the supplied verifying contract.
    /// @dev Used by all three v3 facets (Settlement, SignatureVerifier, NonceManager) so
    ///      they cannot drift. SEC-004 — pre-fix, SettlementFacet cached the separator with
    ///      no `chainId` guard while the other two facets recomputed it on every call; a
    ///      chain fork could leave cancellations unable to match the settlement digest.
    function diamondDomainSeparator(address verifyingContract) internal view returns (bytes32) {
        // GAS-002: build the separator from the precomputed name/version hashes rather
        // than re-hashing the constant strings via domainSeparator(string,string,...).
        return keccak256(
            abi.encode(
                DOMAIN_SEPARATOR_TYPEHASH,
                DOMAIN_NAME_HASH,
                DOMAIN_VERSION_HASH,
                block.chainid,
                verifyingContract
            )
        );
    }

    /// @notice Compute the full EIP-712 hash (\\x19\\x01 + domain + struct)
    /// @param order The order to hash
    /// @param _domainSeparator The pre-computed domain separator
    /// @return The final signable hash
    function hashOrder(
        DoefinOrder memory order,
        bytes32 _domainSeparator
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                _domainSeparator,
                hash(order)
            )
        );
    }

    // ========================================
    // CALLDATA VARIANTS (gas optimization)
    // ========================================

    /// @notice Compute the EIP-712 struct hash of a DoefinOrder (calldata version)
    /// @dev Avoids implicit calldata-to-memory copy when called from facets
    /// @param order The order in calldata
    /// @return The keccak256 struct hash
    function hashCalldata(DoefinOrder calldata order) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                DOEFIN_ORDER_TYPEHASH,
                order.salt,
                order.maker,
                order.signer,
                order.positionId,
                order.collateralToken,
                order.side,
                order.amount,
                order.pricePerToken,
                order.expiration,
                order.nonce
            )
        );
    }

    /// @notice Compute the full EIP-712 hash (calldata version)
    /// @param order The order in calldata
    /// @param _domainSeparator The pre-computed domain separator
    /// @return The final signable hash
    function hashOrderCalldata(
        DoefinOrder calldata order,
        bytes32 _domainSeparator
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                _domainSeparator,
                hashCalldata(order)
            )
        );
    }
}
