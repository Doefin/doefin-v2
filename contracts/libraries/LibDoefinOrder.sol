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
    struct DoefinOrder {
        uint256 salt;
        address maker;           // SCW (Safe) address holding funds
        address signer;          // EOA that signed the order
        bytes32 positionId;      // CTF ERC1155 position ID
        address collateralToken;
        uint8 side;              // 0 = BUY, 1 = SELL
        uint128 amount;
        uint128 pricePerToken;
        uint128 minFillAmount;
        uint8 orderType;         // 0 = Standard, 1 = FixedCC, 2 = DynamicCC
        address quoteCurrency;   // Zero address for standard orders
        uint128 exchangeRate;    // 0 for standard, fixed rate or floor rate for CC
        uint16 feeRateBps;
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
        "uint128 minFillAmount,"
        "uint8 orderType,"
        "address quoteCurrency,"
        "uint128 exchangeRate,"
        "uint16 feeRateBps,"
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
                order.minFillAmount,
                order.orderType,
                order.quoteCurrency,
                order.exchangeRate,
                order.feeRateBps,
                order.expiration,
                order.nonce
            )
        );
    }

    /// @notice Compute the EIP-712 domain separator
    /// @param name The protocol name ("Doefin Exchange")
    /// @param version The protocol version ("2.1")
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
}
