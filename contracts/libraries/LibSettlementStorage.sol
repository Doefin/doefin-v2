// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

/**
 * @title LibSettlementStorage
 * @author Doefin
 * @notice Storage layout for the v2.1 hybrid settlement system
 * @dev Uses a dedicated storage slot separate from the main AppStorage to avoid
 *      layout collisions. Follows the same keccak256 slot + assembly pattern as LibDoefinStorage.
 */
library LibSettlementStorage {
    bytes32 constant STORAGE_POSITION = keccak256("doefin.settlement.storage");

    /// @notice Storage struct for the settlement system
    /// @dev SCRUM-89: The three former position-lookup mappings at slots 6/7/8
    ///      (positionToComplement / positionToCondition / positionToCollateral)
    ///      are now reserved/unused. SettlementFacet reads the CTF position
    ///      registry (LibPositionRegistry in AppStorage) instead — it is
    ///      populated automatically on every splitPosition.
    ///
    ///      These slots are kept as named `__reserved_scrum89_*` placeholders
    ///      rather than deleted so that domainSeparator (slot 9) and __gap keep
    ///      their offsets across the diamond-cut upgrade. Any value previously
    ///      written to these slots (mapping *roots* are always zero, so in
    ///      practice nothing) stays inert.
    struct SettlementStorage {
        /// @notice The authorized operator address that can submit matched orders
        address operator;
        /// @notice Whether trading is currently paused
        bool tradingPaused;
        /// @notice Tracks cumulative filled amount per order hash
        mapping(bytes32 => uint256) orderHashToFilledAmount;
        /// @notice Current nonce per maker — orders with nonce < current are invalid
        mapping(address => uint256) makerToNonce;
        /// @notice Individually cancelled order hashes
        mapping(bytes32 => bool) cancelledOrders;
        /// @notice Minimum salt per maker+position — orders with salt < minSalt are invalid
        mapping(address => mapping(bytes32 => uint256)) makerPositionToMinSalt;
        /// @notice Delegated signers: maker => signer => authorized
        mapping(address => mapping(address => bool)) registeredOrderSigners;
        /// @dev Reserved (SCRUM-89): was positionToComplement. Do not reuse — reading
        ///      this slot returns 0 on every live Diamond (mapping roots are zero).
        bytes32 __reserved_scrum89_positionToComplement;
        /// @dev Reserved (SCRUM-89): was positionToCondition.
        bytes32 __reserved_scrum89_positionToCondition;
        /// @dev Reserved (SCRUM-89): was positionToCollateral.
        bytes32 __reserved_scrum89_positionToCollateral;
        /// @notice Cached EIP-712 domain separator (set via cacheDomainSeparator())
        bytes32 domainSeparator;
        /// @notice Reserved for future storage fields
        uint256[49] __gap;
    }

    /// @notice Returns a pointer to the settlement storage struct at the fixed slot
    /// @return ss Storage pointer to SettlementStorage
    function settlementStorage() internal pure returns (SettlementStorage storage ss) {
        bytes32 position = STORAGE_POSITION;
        assembly {
            ss.slot := position
        }
    }
}
