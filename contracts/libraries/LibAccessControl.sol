// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibAdminConfigStorage} from "./LibAdminConfigStorage.sol";
import {LibAccessControlStorage} from "./LibAccessControlStorage.sol";
import {LibDiamond} from "./LibDiamond.sol";
import {Errors} from "./Errors.sol";

library LibAccessControl {
    // Owner
    function isOwner(address _account) internal view returns (bool) {
        return _account == LibDiamond.contractOwner();
    }

    // MarketMaker
    function isMarketMaker(address _account) internal view returns (bool) {
        return LibAccessControlStorage.accessControlStorage().marketMakers[_account];
    }

    function enforceIsMarketMaker() internal view {
        if (!isMarketMaker(msg.sender)) {
            revert Errors.NotMarketMaker();
        }
    }

    function isCollateralTokenAllowed(address _token) internal view returns (bool) {
        return LibAdminConfigStorage.adminConfigStorage().isAllowed[_token];
    }

    function setMarketMaker(address _account, bool _status) internal {
        if (!isOwner(msg.sender)) {
            revert Errors.NotContractOwner();
        }
        LibAccessControlStorage.accessControlStorage().marketMakers[_account] = _status;
    }
}
