// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.20;

import {LibAccessControlStorage} from "./LibAccessControlStorage.sol";
import {LibSettlementStorage} from "./LibSettlementStorage.sol";
import {Errors} from "./Errors.sol";

/**
 * @title LibAccessControl
 * @author Doefin
 * @notice Role-enforcement helpers for the protocol's two non-owner roles — the
 *         market-maker role and the settlement operator.
 * @dev SCRUM-230 (ARCH-02 / ARCH-06) — slimmed from a v2-era grab-bag. The
 *      owner-check re-export (`isOwner`) and the collateral-allow-list getter
 *      (`isCollateralTokenAllowed`) were removed: owner checks now go through
 *      {LibDiamond.enforceIsContractOwner} directly (the EIP-2535 canonical
 *      source), and the collateral allow-list is read from {LibAdminConfigStorage}
 *      at its use sites. `setMarketMaker` is a pure storage setter — the calling
 *      facet owns the authorization gate.
 */
library LibAccessControl {
    // ----- Market-maker role -----

    /// @notice Whether `_account` holds the market-maker role.
    function isMarketMaker(address _account) internal view returns (bool) {
        return LibAccessControlStorage.accessControlStorage().marketMakers[_account];
    }

    /// @notice Revert unless the caller holds the market-maker role.
    function enforceIsMarketMaker() internal view {
        if (!isMarketMaker(msg.sender)) {
            revert Errors.NotMarketMaker();
        }
    }

    /// @notice Set the market-maker flag for an account.
    /// @dev Pure storage setter — NOT an authorization gate. The calling facet
    ///      (`AccessControlFacet`) enforces the owner check explicitly via
    ///      {LibDiamond.enforceIsContractOwner}.
    function setMarketMaker(address _account, bool _status) internal {
        LibAccessControlStorage.accessControlStorage().marketMakers[_account] = _status;
    }

    // ----- Settlement operator role -----

    /// @notice Revert unless the caller is the authorized settlement operator.
    function enforceIsOperator() internal view {
        if (msg.sender != LibSettlementStorage.settlementStorage().operator) {
            revert Errors.UnauthorizedOperator(msg.sender);
        }
    }
}
