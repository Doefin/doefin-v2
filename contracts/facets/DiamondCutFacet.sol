// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.0;

/******************************************************************************\
* Author: Nick Mudge <nick@perfectabstractions.com> (https://twitter.com/mudgen)
* EIP-2535 Diamonds: https://eips.ethereum.org/EIPS/eip-2535
/******************************************************************************/

import {IDiamondCut} from "../interfaces/IDiamondCut.sol";
import {LibDiamond} from "../libraries/LibDiamond.sol";

// Remember to add the loupe functions from DiamondLoupeFacet to the diamond.
// The loupe functions are required by the EIP2535 Diamonds standard

/**
 * @title DiamondCutFacet
 * @author Nick Mudge (Modified for Doefin)
 * @notice Diamond facet implementing EIP-2535 diamond upgrade functionality
 * @dev Provides the core diamond cut operation for adding, replacing, and removing facet functions
 * @dev This facet MUST be included in every diamond for EIP-2535 compliance
 * @dev Only contract owner can perform diamond cuts to prevent unauthorized upgrades
 */
contract DiamondCutFacet is IDiamondCut {
    /**
     * @notice Executes diamond cut operations to upgrade the diamond's functionality
     * @dev Core upgrade function that can add, replace, or remove facet functions atomically
     * @dev Optionally executes initialization code after facet modifications
     * @dev All function selector changes are applied before initialization to ensure consistency
     * @param _diamondCut Array of facet cuts specifying functions to add/replace/remove
     * @param _init Address of contract containing initialization code (address(0) to skip)
     * @param _calldata Initialization function call data (empty bytes to skip)
     * @custom:emits DiamondCut event with complete cut details
     * @custom:reverts NotContractOwner if caller is not diamond owner
     * @custom:reverts Various LibDiamond errors for invalid cut operations
     * @custom:security Owner-only operation - critical for diamond security
     * @custom:note Initialization runs with delegatecall in diamond context
     * @custom:gas Cost scales with number of function selectors being modified
     */
    function diamondCut(FacetCut[] calldata _diamondCut, address _init, bytes calldata _calldata) external override {
        LibDiamond.enforceIsContractOwner();
        LibDiamond.diamondCut(_diamondCut, _init, _calldata);
        emit DiamondCut(_diamondCut, _init, _calldata);
    }
}
