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
        /// @notice Position ID to its complement position ID
        mapping(bytes32 => bytes32) positionToComplement;
        /// @notice Position ID to its parent condition ID
        mapping(bytes32 => bytes32) positionToCondition;
        /// @notice Position ID to its collateral token address
        mapping(bytes32 => address) positionToCollateral;
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
