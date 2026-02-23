// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.0;
/******************************************************************************\
* Author: Nick Mudge <nick@perfectabstractions.com> (https://twitter.com/mudgen)
* EIP-2535 Diamonds: https://eips.ethereum.org/EIPS/eip-2535
/******************************************************************************/

import {LibDiamond} from "../libraries/LibDiamond.sol";
import {IDiamondLoupe} from "../interfaces/IDiamondLoupe.sol";
import {IERC165} from "../interfaces/IERC165.sol";

// The functions in DiamondLoupeFacet MUST be added to a diamond.
// The EIP-2535 Diamond standard requires these functions.

/**
 * @title DiamondLoupeFacet
 * @author Nick Mudge (Modified for Doefin)
 * @notice Diamond facet implementing EIP-2535 diamond introspection functionality
 * @dev Provides required diamond loupe functions for querying diamond structure and capabilities
 * @dev This facet MUST be included in every diamond for EIP-2535 compliance
 * @dev All functions are view-only and provide transparency about diamond composition
 */
contract DiamondLoupeFacet is IDiamondLoupe, IERC165 {
    // Diamond Loupe Functions
    ////////////////////////////////////////////////////////////////////
    /// These functions are expected to be called frequently by tools.
    //
    // struct Facet {
    //     address facetAddress;
    //     bytes4[] functionSelectors;
    // }

    /**
     * @notice Retrieves all facets and their supported function selectors
     * @dev Essential for understanding complete diamond functionality and structure
     * @dev Returns comprehensive mapping of all available functions to their implementations
     * @return facets_ Array of Facet structs containing addresses and function selectors
     * @custom:view Read-only function providing complete diamond transparency
     * @custom:gas Cost scales with total number of facets and functions in diamond
     * @custom:standard Required by EIP-2535 for diamond introspection
     * @custom:note Helpful for off-chain tools and contract verification
     */
    function facets() external view override returns (Facet[] memory facets_) {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        uint256 numFacets = ds.facetAddresses.length;
        facets_ = new Facet[](numFacets);
        for (uint256 i; i < numFacets; i++) {
            address facetAddress_ = ds.facetAddresses[i];
            facets_[i].facetAddress = facetAddress_;
            facets_[i].functionSelectors = ds.facetFunctionSelectors[facetAddress_].functionSelectors;
        }
    }

    /**
     * @notice Retrieves all function selectors supported by a specific facet
     * @dev Useful for understanding what functionality a particular facet provides
     * @dev Returns empty array if facet address is not registered in the diamond
     * @param _facet The facet address to query for function selectors
     * @return facetFunctionSelectors_ Array of 4-byte function selectors supported by the facet
     * @custom:view Read-only function for facet-specific introspection
     * @custom:gas Constant time lookup regardless of total diamond size
     * @custom:standard Required by EIP-2535 for facet-level transparency
     * @custom:note Useful for verifying facet deployment and function availability
     */
    function facetFunctionSelectors(address _facet) external view override returns (bytes4[] memory facetFunctionSelectors_) {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        facetFunctionSelectors_ = ds.facetFunctionSelectors[_facet].functionSelectors;
    }

    /**
     * @notice Retrieves all facet addresses currently registered in the diamond
     * @dev Provides a complete list of all implementation contracts used by the diamond
     * @dev Order matches the internal facetAddresses array maintained by LibDiamond
     * @return facetAddresses_ Array of all facet contract addresses
     * @custom:view Read-only function for high-level diamond structure overview
     * @custom:gas Linear cost based on number of registered facets
     * @custom:standard Required by EIP-2535 for diamond composition transparency
     * @custom:note Useful for audit trails and upgrade verification
     */
    function facetAddresses() external view override returns (address[] memory facetAddresses_) {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        facetAddresses_ = ds.facetAddresses;
    }

    /**
     * @notice Finds the facet address that implements a specific function selector
     * @dev Core lookup function for understanding function routing in the diamond
     * @dev Returns address(0) if no facet implements the specified function
     * @param _functionSelector The 4-byte function selector to query
     * @return facetAddress_ The facet address implementing the function, or address(0) if not found
     * @custom:view Read-only function for function-to-facet resolution
     * @custom:gas Constant time O(1) lookup via mapping
     * @custom:standard Required by EIP-2535 for function resolution transparency
     * @custom:note Essential for debugging function calls and verifying routing
     */
    function facetAddress(bytes4 _functionSelector) external view override returns (address facetAddress_) {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        facetAddress_ = ds.selectorToFacetAndPosition[_functionSelector].facetAddress;
    }

    /**
     * @notice Implements ERC-165 interface detection for the diamond
     * @dev Reports which interfaces the diamond supports through its various facets
     * @dev Interface support is configured during diamond initialization and upgrades
     * @param _interfaceId The interface identifier to check support for
     * @return True if the diamond supports the specified interface, false otherwise
     * @custom:view Read-only function for interface compliance checking
     * @custom:gas Constant time lookup via mapping
     * @custom:standard Implements ERC-165 standard for interface detection
     * @custom:note Interface support is managed through LibDiamond storage
     */
    function supportsInterface(bytes4 _interfaceId) external view override returns (bool) {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        return ds.supportedInterfaces[_interfaceId];
    }
}
