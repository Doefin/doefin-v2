// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibAccessControl} from "../libraries/LibAccessControl.sol";
import {IAccessControl} from "../interfaces/IAccessControl.sol";
import {Events} from "../libraries/Events.sol";
import {Errors} from "../libraries/Errors.sol";

contract AccessControlFacet is IAccessControl {
    function addMarketMaker(address account) external {
        if(account == address(0)) {
            revert Errors.InvalidMakerAddress();
        }
        if(LibAccessControl.isMarketMaker(account)) {
            revert Errors.AlreadyMarketMaker();
        }
        LibAccessControl.setMarketMaker(account, true);
        emit Events.MarketMakerStatusUpdated(account, true);
    }

    function removeMarketMaker(address account) external {
        if(account == address(0)) {
            revert Errors.InvalidMakerAddress();
        }
        LibAccessControl.setMarketMaker(account, false);
        emit Events.MarketMakerStatusUpdated(account, false);
    }

    function isMarketMaker(address account) external view returns (bool) {
        return LibAccessControl.isMarketMaker(account);
    }
}
