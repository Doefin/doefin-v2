// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.0;

import {LibDiamond} from "../libraries/LibDiamond.sol";
import {IERC173} from "../interfaces/IERC173.sol";
import {Events} from "../libraries/Events.sol";

/**
 * @title OwnershipFacet
 * @author Doefin
 * @notice Diamond facet implementing ERC173 ownership standard
 * @dev Provides ownership functionality for the Diamond proxy contract
 * @dev Uses LibDiamond for actual ownership storage and validation
 */
contract OwnershipFacet is IERC173 {
    /**
     * @notice Transfers ownership of the contract to a new account
     * @dev Can only be called by the current owner
     * @dev Uses LibDiamond.enforceIsContractOwner() for access control
     * @dev Emits OwnershipTransferred event upon successful transfer
     * @param _newOwner The address that will become the new owner
     * @custom:emits OwnershipTransferred from previous owner to new owner
     * @custom:reverts NotContractOwner if caller is not current owner
     * @custom:security Critical function - controls protocol administration
     */
    function transferOwnership(address _newOwner) external override {
        LibDiamond.enforceIsContractOwner();
        address _previousOwner = LibDiamond.contractOwner();
        LibDiamond.setContractOwner(_newOwner);
        emit Events.OwnershipTransferred(_previousOwner, _newOwner);
    }

    /**
     * @notice Returns the current owner of the contract
     * @dev Reads owner from LibDiamond storage
     * @return owner_ The address of the current contract owner
     * @custom:view Pure read operation with no side effects
     */
    function owner() external view override returns (address owner_) {
        owner_ = LibDiamond.contractOwner();
    }
}
