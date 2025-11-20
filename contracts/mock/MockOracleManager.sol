// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

/**
 * @title MockOracleManager
 * @notice Mock oracle manager for testing oracle adapter integration
 * @dev Simulates adapter registration and configuration for testing
 */
contract MockOracleManager {
    struct AdapterConfig {
        address adapterAddress;
        uint256 maxStaleness;
        uint256 failureCount;
        bool enabled;
    }

    mapping(bytes32 => AdapterConfig) public adapters;
    address public owner;

    event AdapterRegistered(bytes32 indexed adapterId, address indexed adapterAddress);

    modifier onlyOwner() {
        require(msg.sender == owner, "MockOracleManager: not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function registerAdapter(
        bytes32 adapterId,
        address adapterAddress,
        uint256 maxStaleness
    ) external onlyOwner {
        adapters[adapterId] = AdapterConfig({
            adapterAddress: adapterAddress,
            maxStaleness: maxStaleness,
            failureCount: 0,
            enabled: true
        });

        emit AdapterRegistered(adapterId, adapterAddress);
    }

    function getAdapterConfig(bytes32 adapterId)
        external
        view
        returns (AdapterConfig memory)
    {
        return adapters[adapterId];
    }
}
