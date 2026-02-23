// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibAccessControl} from "../libraries/LibAccessControl.sol";
import {IAccessControl} from "../interfaces/IAccessControl.sol";
import {Events} from "../libraries/Events.sol";
import {Errors} from "../libraries/Errors.sol";

/**
 * @title AccessControlFacet
 * @author Doefin
 * @notice Diamond facet implementing role-based access control for the protocol
 * @dev Manages market maker permissions and other role-based authorizations
 * @dev Uses LibAccessControl for actual storage and logic implementation
 */
contract AccessControlFacet is IAccessControl {
    /**
     * @notice Grants market maker role to an account
     * @dev Market makers have special privileges for creating conditions and managing markets
     * @dev Only contract owner can grant market maker status
     * @param account The address to grant market maker privileges to
     * @custom:emits MarketMakerStatusUpdated with account and true status
     * @custom:reverts InvalidMakerAddress if account is zero address
     * @custom:reverts AlreadyMarketMaker if account already has market maker role
     * @custom:security Only callable by contract owner via LibAccessControl validation
     */
    function addMarketMaker(address account) external {
        if (account == address(0)) {
            revert Errors.InvalidMakerAddress();
        }
        if (LibAccessControl.isMarketMaker(account)) {
            revert Errors.AlreadyMarketMaker();
        }
        LibAccessControl.setMarketMaker(account, true);
        emit Events.MarketMakerStatusUpdated(account, true);
    }

    /**
     * @notice Revokes market maker role from an account
     * @dev Removes market maker privileges, preventing creation of new conditions
     * @dev Only contract owner can revoke market maker status
     * @dev Does not revert if account is not currently a market maker
     * @param account The address to revoke market maker privileges from
     * @custom:emits MarketMakerStatusUpdated with account and false status
     * @custom:reverts InvalidMakerAddress if account is zero address
     * @custom:security Only callable by contract owner via LibAccessControl validation
     * @custom:note Existing conditions created by this account remain valid
     */
    function removeMarketMaker(address account) external {
        if (account == address(0)) {
            revert Errors.InvalidMakerAddress();
        }
        LibAccessControl.setMarketMaker(account, false);
        emit Events.MarketMakerStatusUpdated(account, false);
    }

    /**
     * @notice Checks if an account has market maker privileges
     * @dev Read-only function to query market maker status
     * @param account The address to check for market maker privileges
     * @return True if the account has market maker role, false otherwise
     * @custom:view Pure read operation with no side effects
     */
    function isMarketMaker(address account) external view returns (bool) {
        return LibAccessControl.isMarketMaker(account);
    }
}
