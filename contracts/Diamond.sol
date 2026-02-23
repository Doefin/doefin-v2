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

import {LibDiamond} from "./libraries/LibDiamond.sol";
import {LibAccessControl} from "./libraries/LibAccessControl.sol";
import {IDiamondCut} from "./interfaces/IDiamondCut.sol";
import {Errors} from "./libraries/Errors.sol";

/**
 * @title Diamond
 * @author Nick Mudge (Modified for Doefin)
 * @notice Main Diamond proxy contract implementing EIP-2535 Diamond Standard
 * @dev Acts as a proxy that delegates function calls to appropriate facet implementations
 * @dev Supports unlimited contract size by routing functions to modular facets
 * @dev Immutable proxy address with upgradeable implementation logic
 * @custom:security Uses delegatecall for facet execution - facets share proxy storage
 * @custom:standard EIP-2535 compliant diamond implementation
 */
contract Diamond {
    /**
     * @notice Initializes the Diamond with contract owner and essential diamond cut functionality
     * @dev Sets up the minimal diamond structure with diamond cut facet for future upgrades
     * @dev Diamond cut facet is added immediately to enable adding other facets post-deployment
     * @param _contractOwner Address that will have administrative control over the diamond
     * @param _diamondCutFacet Address of the DiamondCutFacet contract for upgrade functionality
     * @custom:emits DiamondCut event via LibDiamond for the initial facet addition
     * @custom:security Owner has full control over diamond upgrades - use multisig in production
     * @custom:note Constructor is payable to support diamonds that need initial ETH balance
     */
    constructor(address _contractOwner, address _diamondCutFacet) payable {
        LibDiamond.setContractOwner(_contractOwner);

        // Add the diamondCut external function from the diamondCutFacet
        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](1);
        bytes4[] memory functionSelectors = new bytes4[](1);
        functionSelectors[0] = IDiamondCut.diamondCut.selector;
        cut[0] = IDiamondCut.FacetCut({facetAddress: _diamondCutFacet, action: IDiamondCut.FacetCutAction.Add, functionSelectors: functionSelectors});
        LibDiamond.diamondCut(cut, address(0), "");
    }

    /**
     * @notice Fallback function that routes calls to appropriate facet implementations
     * @dev Core proxy functionality - finds facet for function selector and delegates call
     * @dev Uses assembly for gas-efficient function routing and return data handling
     * @dev All facet functions are executed in the context of this Diamond storage
     * @custom:reverts FunctionDoesNotExist if no facet implements the called function
     * @custom:security Critical function - all external calls go through this routing
     * @custom:gas Optimized assembly implementation for minimal proxy overhead
     * @custom:note Return data is forwarded directly from facet execution
     */
    fallback() external payable {
        LibDiamond.DiamondStorage storage ds;
        bytes32 position = LibDiamond.DIAMOND_STORAGE_POSITION;
        // get diamond storage
        assembly {
            ds.slot := position
        }
        // get facet from function selector
        address facet = ds.selectorToFacetAndPosition[msg.sig].facetAddress;
        if (facet == address(0)) {
            revert Errors.FunctionDoesNotExist();
        }
        // Execute external function from facet using delegatecall and return any value.
        assembly {
            // copy function selector and any arguments
            calldatacopy(0, 0, calldatasize())
            // execute function call using the facet
            let result := delegatecall(gas(), facet, 0, calldatasize(), 0, 0)
            // get any return value
            returndatacopy(0, 0, returndatasize())
            // return any return value or error back to the caller
            switch result
            case 0 {
                revert(0, returndatasize())
            }
            default {
                return(0, returndatasize())
            }
        }
    }

    /**
     * @notice Receive function to accept ETH transfers to the Diamond
     * @dev Allows the Diamond to receive ETH for protocols that need native token handling
     * @dev ETH sent here becomes part of the Diamond's balance available to facets
     * @custom:note Facets can use address(this).balance to access received ETH
     */
    receive() external payable {}
}
