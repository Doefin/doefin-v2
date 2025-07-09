// SPDX-License-Identifier: AGPL-3.0
// Uses shared storage derived from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {LibDiamond} from "../libraries/LibDiamond.sol";

library LibAccessControl {
    // Owner
    function isOwner(address _account) internal view returns (bool) {
        return _account == LibDiamond.contractOwner();
    }

    // MarketMaker
    function isMarketMaker(address _account) internal view returns (bool) {
        return LibDoefinStorage.diamondStorage().accessControl.marketMakers[_account];
    }

    function enforceIsMarketMaker() internal view {
        require(isMarketMaker(msg.sender), "AccessControl: must be market maker");
    }

    function setMarketMaker(address _account, bool _status) internal {
        require(isOwner(msg.sender), "AccessControl: must be owner");
        LibDoefinStorage.diamondStorage().accessControl.marketMakers[_account] = _status;
    }
}
