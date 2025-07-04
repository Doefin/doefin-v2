// SPDX-License-Identifier: MIT
pragma solidity ^0.8.6;

import { LibDoefinStorage } from "../libraries/LibDoefinStorage.sol";
import { ICollateralVault } from "../interfaces/ICollateralVault.sol";
import { IERC165} from "../interfaces/IERC165.sol";

contract CollateralVaultFacet is ICollateralVault, IERC165 {
    using LibDoefinStorage for LibDoefinStorage.DiamondStorage;

    function lockCollateral(address user, address token, uint256 amount) external override {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        ds.vault.lockedBalance[user][token] += amount;
        emit CollateralLocked(user, token, amount);
    }

    function releaseCollateral(address user, address token, uint256 amount) external override {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        require(ds.vault.lockedBalance[user][token] >= amount, "Insufficient locked balance");
        ds.vault.lockedBalance[user][token] -= amount;
        emit CollateralReleased(user, token, amount);
    }

    function getLockedBalance(address user, address token) external view override returns (uint256) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        return ds.vault.lockedBalance[user][token];
    }

    function supportsInterface(bytes4 interfaceId) 
        external 
        pure 
        override 
        returns (bool) 
    {
        return 
            interfaceId == type(ICollateralVault).interfaceId || 
            interfaceId == type(IERC165).interfaceId;
    }
}