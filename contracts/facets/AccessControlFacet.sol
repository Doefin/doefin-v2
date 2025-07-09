// SPDX-License-Identifier: AGPL-3.0
// Uses shared storage derived from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibAccessControl} from "../libraries/LibAccessControl.sol";
import {IAccessControl} from "../interfaces/IAccessControl.sol";

contract AccessControlFacet is IAccessControl {
    function addMarketMaker(address account) external {
        LibAccessControl.setMarketMaker(account, true);
        emit MarketMakerUpdated(account, true);
    }

    function removeMarketMaker(address account) external {
        LibAccessControl.setMarketMaker(account, false);
        emit MarketMakerUpdated(account, false);
    }

    function isMarketMaker(address account) external view returns (bool) {
        return LibAccessControl.isMarketMaker(account);
    }
}
