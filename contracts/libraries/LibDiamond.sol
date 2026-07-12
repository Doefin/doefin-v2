// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

/******************************************************************************\
* Author: Nick Mudge <nick@perfectabstractions.com> (https://twitter.com/mudgen)
* EIP-2535 Diamonds: https://eips.ethereum.org/EIPS/eip-2535
/******************************************************************************/
import {IDiamondCut} from "../interfaces/IDiamondCut.sol";
import {Errors} from "./Errors.sol";

// Remember to add the loupe functions from DiamondLoupeFacet to the diamond.
// The loupe functions are required by the EIP2535 Diamonds standard

/**
 * @dev Error thrown when diamond initialization function call fails
 * @param _initializationContractAddress The address of the initialization contract that failed
 * @param _calldata The calldata that was used in the failed initialization call
 * @custom:error Provides detailed context for initialization failures during diamond cuts
 */
error InitializationFunctionReverted(address _initializationContractAddress, bytes _calldata);

/**
 * @title LibDiamond
 * @author Nick Mudge (Modified for Doefin)
 * @notice Core library implementing EIP-2535 Diamond Standard storage and functionality
 * @dev Provides the foundation for upgradeable modular smart contracts using the Diamond pattern
 * @dev Manages facet addresses, function selectors, and diamond storage using deterministic storage slots
 * @dev All diamond operations (add/replace/remove facets) are performed through this library
 * @custom:standard Implements EIP-2535 Diamond Standard for unlimited contract size and upgradeability
 * @custom:security Uses deterministic storage slots to prevent storage collisions
 * @custom:pattern Diamond proxy pattern with delegatecall routing to modular facet contracts
 */

library LibDiamond {
    // 32 bytes keccak hash of a string to use as a diamond storage location.
    bytes32 constant DIAMOND_STORAGE_POSITION = keccak256("diamond.standard.diamond.storage");

    /**
     * @dev Maps function selectors to their implementing facets and positions
     * @param facetAddress The contract address implementing the function selector
     * @param functionSelectorPosition Position in the facetFunctionSelectors.functionSelectors array
     * @custom:storage Efficient lookup structure for O(1) function routing
     */
    struct FacetAddressAndPosition {
        address facetAddress;
        uint96 functionSelectorPosition; // position in facetFunctionSelectors.functionSelectors array
    }

    /**
     * @dev Maps facet addresses to their function selectors and position data
     * @param functionSelectors Array of all function selectors implemented by this facet
     * @param facetAddressPosition Position of facetAddress in the global facetAddresses array
     * @custom:storage Enables facet-level operations and introspection
     */
    struct FacetFunctionSelectors {
        bytes4[] functionSelectors;
        uint256 facetAddressPosition; // position of facetAddress in facetAddresses array
    }

    /**
     * @dev Main diamond storage structure containing all diamond state
     * @param selectorToFacetAndPosition Maps function selectors to implementing facets
     * @param facetFunctionSelectors Maps facet addresses to their function selectors
     * @param facetAddresses Array of all registered facet addresses
     * @param supportedInterfaces ERC-165 interface support mapping
     * @param contractOwner Address with administrative privileges over the diamond
     * @custom:storage Uses deterministic storage slot to avoid conflicts with facet storage
     * @custom:diamond Central data structure for all diamond operations and state
     */
    struct DiamondStorage {
        // maps function selector to the facet address and
        // the position of the selector in the facetFunctionSelectors.selectors array
        mapping(bytes4 => FacetAddressAndPosition) selectorToFacetAndPosition;
        // maps facet addresses to function selectors
        mapping(address => FacetFunctionSelectors) facetFunctionSelectors;
        // facet addresses
        address[] facetAddresses;
        // Used to query if a contract implements an interface.
        // Used to implement ERC-165.
        mapping(bytes4 => bool) supportedInterfaces;
        // owner of the contract
        address contractOwner;
    }

    /**
     * @notice Provides access to the diamond storage using deterministic storage slot
     * @dev Uses assembly to assign storage to a specific slot preventing storage collisions
     * @dev Storage slot is calculated as keccak256("diamond.standard.diamond.storage")
     * @return ds Reference to the DiamondStorage struct containing all diamond state
     * @custom:storage Deterministic storage pattern for proxy contracts
     * @custom:gas Assembly optimized for efficient storage access
     * @custom:security Prevents storage layout conflicts between diamond and facets
     */
    function diamondStorage() internal pure returns (DiamondStorage storage ds) {
        bytes32 position = DIAMOND_STORAGE_POSITION;
        // assigns struct storage slot to the storage position
        assembly {
            ds.slot := position
        }
    }

    /**
     * @notice Updates the contract owner in diamond storage
     * @dev Sets new owner address in the centralized diamond storage structure
     * @dev Does not emit events - caller responsible for event emission if needed
     * @param _newOwner Address of the new contract owner
     * @custom:access Internal function - access control enforced by caller
     * @custom:ownership Part of ERC-173 ownership standard implementation
     */
    function setContractOwner(address _newOwner) internal {
        DiamondStorage storage ds = diamondStorage();
        ds.contractOwner = _newOwner;
    }

    /**
     * @notice Retrieves the current contract owner from diamond storage
     * @dev Reads owner address from the centralized diamond storage structure
     * @dev Used by ownership functions and access control mechanisms
     * @return contractOwner_ Address of the current contract owner
     * @custom:view Read-only function for ownership queries
     * @custom:ownership Part of ERC-173 ownership standard implementation
     */
    function contractOwner() internal view returns (address contractOwner_) {
        contractOwner_ = diamondStorage().contractOwner;
    }

    /**
     * @notice Ensures that the caller is the contract owner
     * @dev Reverts with NotContractOwner error if caller is not the owner
     * @dev Used as access control modifier in diamond upgrade operations
     * @custom:access Access control function for administrative operations
     * @custom:revert Errors.NotContractOwner() if caller is not the owner
     * @custom:ownership Part of ERC-173 ownership standard implementation
     */
    function enforceIsContractOwner() internal view {
        if (msg.sender != diamondStorage().contractOwner) {
            revert Errors.NotContractOwner();
        }
    }

    /**
     * @notice Internal implementation of diamond cutting (adding/replacing/removing facets)
     * @dev Processes diamond cuts and optionally executes initialization function
     * @dev Supports batch operations for multiple facets in a single transaction
     * @param _diamondCut Array of FacetCut structs defining the upgrade operations
     * @param _init Address of optional initialization contract (address(0) to skip)
     * @param _calldata Encoded function call for initialization contract
     * @custom:upgrade Core diamond upgrade functionality implementing EIP-2535
     * @custom:batch Processes multiple facet operations atomically
     * @custom:initialization Supports post-upgrade initialization via delegatecall
     * @custom:revert Various errors for invalid operations (see individual functions)
     */
    // Internal function version of diamondCut
    function diamondCut(IDiamondCut.FacetCut[] memory _diamondCut, address _init, bytes memory _calldata) internal {
        for (uint256 facetIndex; facetIndex < _diamondCut.length; facetIndex++) {
            IDiamondCut.FacetCutAction action = _diamondCut[facetIndex].action;
            if (action == IDiamondCut.FacetCutAction.Add) {
                addFunctions(_diamondCut[facetIndex].facetAddress, _diamondCut[facetIndex].functionSelectors);
            } else if (action == IDiamondCut.FacetCutAction.Replace) {
                replaceFunctions(_diamondCut[facetIndex].facetAddress, _diamondCut[facetIndex].functionSelectors);
            } else if (action == IDiamondCut.FacetCutAction.Remove) {
                removeFunctions(_diamondCut[facetIndex].facetAddress, _diamondCut[facetIndex].functionSelectors);
            } else {
                revert("LibDiamondCut: Incorrect FacetCutAction");
            }
        }
        initializeDiamondCut(_init, _calldata);
    }

    /**
     * @notice Adds new function selectors to a facet in the diamond
     * @dev Registers new functions that can be called on the diamond proxy
     * @dev Validates that functions don't already exist and facet has contract code
     * @param _facetAddress Address of the facet contract implementing the functions
     * @param _functionSelectors Array of 4-byte function selectors to add
     * @custom:upgrade Part of diamond cut ADD operation
     * @custom:validation Ensures no duplicate functions and valid facet address
     * @custom:revert Errors.NoSelectorsInFacet() if empty selector array
     * @custom:revert Errors.AddFacetCannotBeZero() if facet address is zero
     * @custom:revert Errors.CannotAddExistingFunction() if function already exists
     */
    function addFunctions(address _facetAddress, bytes4[] memory _functionSelectors) internal {
        if (_functionSelectors.length == 0) {
            revert Errors.NoSelectorsInFacet();
        }
        DiamondStorage storage ds = diamondStorage();
        if (_facetAddress == address(0)) {
            revert Errors.AddFacetCannotBeZero();
        }
        uint96 selectorPosition = uint96(ds.facetFunctionSelectors[_facetAddress].functionSelectors.length);
        // add new facet address if it does not exist
        if (selectorPosition == 0) {
            addFacet(ds, _facetAddress);
        }
        for (uint256 selectorIndex; selectorIndex < _functionSelectors.length; selectorIndex++) {
            bytes4 selector = _functionSelectors[selectorIndex];
            address oldFacetAddress = ds.selectorToFacetAndPosition[selector].facetAddress;
            if (oldFacetAddress != address(0)) {
                revert Errors.CannotAddExistingFunction();
            }
            addFunction(ds, selector, selectorPosition, _facetAddress);
            selectorPosition++;
        }
    }

    /**
     * @notice Replaces existing function selectors with new implementations
     * @dev Updates function routing to point to new facet for existing selectors
     * @dev Removes old function mappings and adds new ones atomically
     * @param _facetAddress Address of the new facet contract implementing the functions
     * @param _functionSelectors Array of 4-byte function selectors to replace
     * @custom:upgrade Part of diamond cut REPLACE operation
     * @custom:validation Ensures functions exist and aren't being replaced with same facet
     * @custom:revert Errors.NoSelectorsInFacet() if empty selector array
     * @custom:revert Errors.AddFacetCannotBeZero() if facet address is zero
     * @custom:revert Errors.CannotReplaceWithSameFunction() if replacing with same facet
     */
    function replaceFunctions(address _facetAddress, bytes4[] memory _functionSelectors) internal {
        if (_functionSelectors.length == 0) {
            revert Errors.NoSelectorsInFacet();
        }
        DiamondStorage storage ds = diamondStorage();
        if (_facetAddress == address(0)) {
            revert Errors.AddFacetCannotBeZero();
        }
        uint96 selectorPosition = uint96(ds.facetFunctionSelectors[_facetAddress].functionSelectors.length);
        // add new facet address if it does not exist
        if (selectorPosition == 0) {
            addFacet(ds, _facetAddress);
        }
        for (uint256 selectorIndex; selectorIndex < _functionSelectors.length; selectorIndex++) {
            bytes4 selector = _functionSelectors[selectorIndex];
            address oldFacetAddress = ds.selectorToFacetAndPosition[selector].facetAddress;
            if (oldFacetAddress == _facetAddress) {
                revert Errors.CannotReplaceWithSameFunction();
            }
            removeFunction(ds, oldFacetAddress, selector);
            addFunction(ds, selector, selectorPosition, _facetAddress);
            selectorPosition++;
        }
    }

    /**
     * @notice Removes function selectors from the diamond
     * @dev Deletes function mappings making those functions no longer callable
     * @dev Requires facet address to be address(0) as per EIP-2535 specification
     * @param _facetAddress Must be address(0) for remove operations
     * @param _functionSelectors Array of 4-byte function selectors to remove
     * @custom:upgrade Part of diamond cut REMOVE operation
     * @custom:validation Ensures facet address is zero and functions exist
     * @custom:revert Errors.NoSelectorsInFacet() if empty selector array
     * @custom:revert Errors.RemoveFacetAddressMustBeZero() if facet address not zero
     * @custom:standard EIP-2535 requires address(0) for remove operations
     */
    function removeFunctions(address _facetAddress, bytes4[] memory _functionSelectors) internal {
        if (_functionSelectors.length == 0) {
            revert Errors.NoSelectorsInFacet();
        }
        DiamondStorage storage ds = diamondStorage();
        // if function does not exist then do nothing and return
        if (_facetAddress != address(0)) {
            revert Errors.RemoveFacetAddressMustBeZero();
        }
        for (uint256 selectorIndex; selectorIndex < _functionSelectors.length; selectorIndex++) {
            bytes4 selector = _functionSelectors[selectorIndex];
            address oldFacetAddress = ds.selectorToFacetAndPosition[selector].facetAddress;
            removeFunction(ds, oldFacetAddress, selector);
        }
    }

    /**
     * @notice Registers a new facet address in the diamond
     * @dev Validates facet has contract code and adds to facetAddresses array
     * @dev Sets up initial position tracking for the new facet
     * @param ds DiamondStorage struct reference for state modifications
     * @param _facetAddress Address of the facet contract to register
     * @custom:validation Ensures facet contract exists and has code
     * @custom:storage Updates facetAddresses array and position mappings
     * @custom:revert ContractCodeSizeZero via enforceHasContractCode if no code
     */
    function addFacet(DiamondStorage storage ds, address _facetAddress) internal {
        enforceHasContractCode(_facetAddress, "LibDiamondCut: New facet has no code");
        ds.facetFunctionSelectors[_facetAddress].facetAddressPosition = ds.facetAddresses.length;
        ds.facetAddresses.push(_facetAddress);
    }

    /**
     * @notice Registers a single function selector to facet mapping
     * @dev Updates both selector-to-facet and facet-to-selectors mappings
     * @dev Maintains position data for efficient removal operations
     * @param ds DiamondStorage struct reference for state modifications
     * @param _selector 4-byte function selector to register
     * @param _selectorPosition Position in the facet's function selector array
     * @param _facetAddress Address of the facet implementing the function
     * @custom:storage Dual mapping update for bidirectional lookup
     * @custom:gas Optimized for batch operations with position tracking
     */
    function addFunction(DiamondStorage storage ds, bytes4 _selector, uint96 _selectorPosition, address _facetAddress) internal {
        ds.selectorToFacetAndPosition[_selector].functionSelectorPosition = _selectorPosition;
        ds.facetFunctionSelectors[_facetAddress].functionSelectors.push(_selector);
        ds.selectorToFacetAndPosition[_selector].facetAddress = _facetAddress;
    }

    /**
     * @notice Removes a function selector from diamond routing
     * @dev Uses swap-and-pop pattern for efficient array element removal
     * @dev Cleans up facet data if no more functions remain
     * @param ds DiamondStorage struct reference for state modifications
     * @param _facetAddress Address of the facet containing the function
     * @param _selector 4-byte function selector to remove
     * @custom:validation Ensures function exists and isn't immutable
     * @custom:algorithm Swap-and-pop for O(1) array element removal
     * @custom:cleanup Removes facet if no functions remain
     * @custom:revert Errors.CannotRemoveNonExistentFunction() if function doesn't exist
     * @custom:revert Errors.CannotRemoveImmutableFunction() if function is immutable
     */
    function removeFunction(DiamondStorage storage ds, address _facetAddress, bytes4 _selector) internal {
        if (_facetAddress == address(0)) {
            revert Errors.CannotRemoveNonExistentFunction();
        }
        // an immutable function is a function defined directly in a diamond
        if (_facetAddress == address(this)) {
            revert Errors.CannotRemoveImmutableFunction();
        }
        // replace selector with last selector, then delete last selector
        uint256 selectorPosition = ds.selectorToFacetAndPosition[_selector].functionSelectorPosition;
        uint256 lastSelectorPosition = ds.facetFunctionSelectors[_facetAddress].functionSelectors.length - 1;
        // if not the same then replace _selector with lastSelector
        if (selectorPosition != lastSelectorPosition) {
            bytes4 lastSelector = ds.facetFunctionSelectors[_facetAddress].functionSelectors[lastSelectorPosition];
            ds.facetFunctionSelectors[_facetAddress].functionSelectors[selectorPosition] = lastSelector;
            ds.selectorToFacetAndPosition[lastSelector].functionSelectorPosition = uint96(selectorPosition);
        }
        // delete the last selector
        ds.facetFunctionSelectors[_facetAddress].functionSelectors.pop();
        delete ds.selectorToFacetAndPosition[_selector];

        // if no more selectors for facet address then delete the facet address
        if (lastSelectorPosition == 0) {
            // replace facet address with last facet address and delete last facet address
            uint256 lastFacetAddressPosition = ds.facetAddresses.length - 1;
            uint256 facetAddressPosition = ds.facetFunctionSelectors[_facetAddress].facetAddressPosition;
            if (facetAddressPosition != lastFacetAddressPosition) {
                address lastFacetAddress = ds.facetAddresses[lastFacetAddressPosition];
                ds.facetAddresses[facetAddressPosition] = lastFacetAddress;
                ds.facetFunctionSelectors[lastFacetAddress].facetAddressPosition = facetAddressPosition;
            }
            ds.facetAddresses.pop();
            delete ds.facetFunctionSelectors[_facetAddress].facetAddressPosition;
        }
    }

    /**
     * @notice Executes optional initialization function after diamond cut operations
     * @dev Performs delegatecall to initialization contract for post-upgrade setup
     * @dev Safely handles initialization failures with detailed error reporting
     * @param _init Address of initialization contract (address(0) to skip initialization)
     * @param _calldata Encoded function call data for the initialization function
     * @custom:initialization Post-upgrade setup mechanism via delegatecall
     * @custom:safety Comprehensive error handling with error bubbling
     * @custom:validation Ensures initialization contract has code before calling
     * @custom:revert InitializationFunctionReverted if initialization fails
     * @custom:delegate Uses delegatecall to maintain diamond storage context
     */
    function initializeDiamondCut(address _init, bytes memory _calldata) internal {
        if (_init == address(0)) {
            return;
        }
        enforceHasContractCode(_init, "LibDiamondCut: _init address has no code");
        (bool success, bytes memory error) = _init.delegatecall(_calldata);
        if (!success) {
            if (error.length > 0) {
                // bubble up error
                /// @solidity memory-safe-assembly
                assembly {
                    let returndata_size := mload(error)
                    revert(add(32, error), returndata_size)
                }
            } else {
                revert InitializationFunctionReverted(_init, _calldata);
            }
        }
    }

    /**
     * @notice Validates that an address contains contract code
     * @dev Uses assembly to check contract code size at the specified address
     * @dev Critical validation for facet addresses to prevent invalid diamond cuts
     * @param _contract Address to validate for contract code existence
     * @param _errorMessage Custom error message for revert
     * @custom:validation Essential security check for all facet operations
     * @custom:gas Assembly optimized for efficient code size checking
     * @custom:revert Errors.ContractCodeSizeZero() if address has no code
     * @custom:security Prevents addition of EOA addresses as facets
     */
    function enforceHasContractCode(address _contract, string memory _errorMessage) internal view {
        uint256 contractSize;
        assembly {
            contractSize := extcodesize(_contract)
        }
        if (contractSize == 0) {
            revert Errors.ContractCodeSizeZero();
        }
    }
}
