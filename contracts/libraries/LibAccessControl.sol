// SPDX-License-Identifier: MIT
pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";

library LibAccessControl {

    // Owner
    function enforceIsOwner() internal view {
        require(msg.sender == accessConLibDoefinStorage.diamondStorage().accessControl.owner, "AccessControl: must be owner");
    }

    // MarketMaker
    function isMarketMaker(address _account) internal view returns (bool) {
        return accessConLibDoefinStorage.diamondStorage().accessControl.marketMakers[_account];
    }

    function enforceIsMarketMaker() internal view {
        require(isMarketMaker(msg.sender), "AccessControl: must be market maker");
    }

    function setMarketMaker(address _account, bool _status) internal {
        enforceIsOwner();
        accessConLibDoefinStorage.diamondStorage().accessControl.marketMakers[_account] = _status;
    }

    function setOwner(address _owner) internal {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        require(ds.accessControl.owner == address(0), "AccessControl: owner already set");
        ds.accessControl.owner = _owner;
    }

    function getOwner() internal view returns (address) {
        return accessControlStorage().owner;
    }
}
