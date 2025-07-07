// SPDX-License-Identifier: MIT
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {LibDiamond} from "../libraries/LibDiamond.sol";

library LibAccessControl {
    // Owner
    function enforceIsOwner() internal view {
        require(msg.sender == LibDiamond.contractOwner(), "AccessControl: must be owner");
    }

    // MarketMaker
    function isMarketMaker(address _account) internal view returns (bool) {
        return LibDoefinStorage.diamondStorage().accessControl.marketMakers[_account];
    }

    function enforceIsMarketMaker() internal view {
        require(isMarketMaker(msg.sender), "AccessControl: must be market maker");
    }

    function setMarketMaker(address _account, bool _status) internal {
        enforceIsOwner();
        LibDoefinStorage.diamondStorage().accessControl.marketMakers[_account] = _status;
    }
}
