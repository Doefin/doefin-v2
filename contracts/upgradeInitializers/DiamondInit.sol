// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.0;

/******************************************************************************\
* Author: Nick Mudge <nick@perfectabstractions.com> (https://twitter.com/mudgen)
* EIP-2535 Diamonds: https://eips.ethereum.org/EIPS/eip-2535
*
* Implementation of a diamond.
/******************************************************************************/

import {LibDiamond} from "../libraries/LibDiamond.sol";
import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {IDiamondLoupe} from "../interfaces/IDiamondLoupe.sol";
import {IDiamondCut} from "../interfaces/IDiamondCut.sol";
import {IERC173} from "../interfaces/IERC173.sol";
import {IERC165} from "../interfaces/IERC165.sol";
import {IConditionalTokens} from "../interfaces/IConditionalTokens.sol";
import {IConditionManager} from "../interfaces/IConditionManager.sol";
import {IERC1155Facet} from "../interfaces/IERC1155.sol";
import {IERC1155TokenReceiver} from "../interfaces/IERC1155TokenReceiver.sol";
import {IAccessControl} from "../interfaces/IAccessControl.sol";
import {IAdminConfig} from "../interfaces/IAdminConfig.sol";
import {IExchange} from "../interfaces/IExchange.sol";
import {IMarketExecution} from "../interfaces/IMarketExecution.sol";
import {IRouteSimulation} from "../interfaces/IRouteSimulation.sol";
import {IDoefinBlockHeaderOracle} from "../interfaces/IDoefinBlockHeaderOracle.sol";

// It is expected that this contract is customized if you want to deploy your diamond
// with data from a deployment script. Use the init function to initialize state variables
// of your diamond. Add parameters to the init function if you need to.

/**
 * @title DiamondInit
 * @author Nick Mudge (Modified for Doefin)
 * @notice Initialization contract for diamond proxy deployment and upgrades
 * @dev Provides one-time initialization setup for the Doefin diamond including ownership, fees, and interfaces
 * @dev Called via delegatecall during diamond deployment to configure initial state
 * @dev Customizable for specific deployment requirements and state variable initialization
 * @custom:deployment Used during initial diamond proxy deployment phase
 * @custom:upgrade Can be used for state migrations during diamond upgrades
 * @custom:pattern Standard EIP-2535 initialization contract pattern
 */
contract DiamondInit {
    /**
     * @notice Initializes the diamond with owner, fee configuration, and ERC-165 interfaces
     * @dev Sets up complete diamond state including ownership, trading fees, and supported interfaces
     * @dev Called via delegatecall from DiamondCutFacet during deployment
     * @param _owner Address to be set as the contract owner with administrative privileges
     * @custom:delegation Executed via delegatecall to maintain diamond storage context
     * @custom:fees Initializes protocol fees: 5% resolution, 1% maker, 2% taker
     * @custom:interfaces Registers all supported ERC-165 interfaces for protocol compliance
     * @custom:deployment One-time setup function for diamond initialization
     * @custom:owner Sets contract owner for administrative operations
     */
    // You can add parameters to this function in order to pass in
    // data to set your own state variables
    function init(address _owner) external {
        LibDiamond.setContractOwner(_owner);

        // Initialize Doefin storage with fee configuration
        LibDoefinStorage.initialize(
            _owner, // feeReceiver
            500, // resolutionFeeBps (5%)
            100, // makerTradingFeeBps (1%)
            200 // takerTradingFeeBps (2%)
        );

        // adding ERC165 data
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        ds.supportedInterfaces[type(IERC165).interfaceId] = true;
        ds.supportedInterfaces[type(IDiamondCut).interfaceId] = true;
        ds.supportedInterfaces[type(IDiamondLoupe).interfaceId] = true;
        ds.supportedInterfaces[type(IERC173).interfaceId] = true;
        ds.supportedInterfaces[type(IConditionalTokens).interfaceId] = true;
        ds.supportedInterfaces[type(IConditionManager).interfaceId] = true;
        ds.supportedInterfaces[type(IERC1155Facet).interfaceId] = true;
        ds.supportedInterfaces[type(IERC1155TokenReceiver).interfaceId] = true;
        ds.supportedInterfaces[type(IAccessControl).interfaceId] = true;
        ds.supportedInterfaces[type(IAdminConfig).interfaceId] = true;
        ds.supportedInterfaces[type(IExchange).interfaceId] = true;
        ds.supportedInterfaces[type(IMarketExecution).interfaceId] = true;
        ds.supportedInterfaces[type(IRouteSimulation).interfaceId] = true;
        ds.supportedInterfaces[type(IDoefinBlockHeaderOracle).interfaceId] = true;

        // add your own state variables
        // EIP-2535 specifies that the `diamondCut` function takes two optional
        // arguments: address _init and bytes calldata _calldata
        // These arguments are used to execute an arbitrary function using delegatecall
        // in order to set state variables in the diamond during deployment or an upgrade
        // More info here: https://eips.ethereum.org/EIPS/eip-2535#diamond-interface
    }
}
