// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {IAdminConfig} from "../interfaces/IAdminConfig.sol";
import {LibDiamond} from "../libraries/LibDiamond.sol";

contract AdminConfigFacet is IAdminConfig {
    function addCollateralToken(address token, uint256 unitPerPair) external override {
        LibDiamond.enforceIsContractOwner();
        require(token != address(0), "AdminConfig: invalid token address");
        require(unitPerPair > 0, "AdminConfig: unit must be > 0");

        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        require(!ds.adminConfigStorage.isAllowed[token], "AdminConfig: token already allowed");

        ds.adminConfigStorage.isAllowed[token] = true;
        ds.adminConfigStorage.unitPerPair[token] = unitPerPair;

        emit CollateralTokenAdded(token, unitPerPair);
    }

    function removeCollateralToken(address token) external override {
        LibDiamond.enforceIsContractOwner();
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        require(ds.adminConfigStorage.isAllowed[token], "AdminConfig: token not allowed");

        ds.adminConfigStorage.isAllowed[token] = false;
        delete ds.adminConfigStorage.unitPerPair[token];

        emit CollateralTokenRemoved(token);
    }

    function setFeeReceiver(address feeReceiver) external override {
        LibDiamond.enforceIsContractOwner();
        require(feeReceiver != address(0), "AdminConfig: invalid fee receiver");
        LibDoefinStorage.diamondStorage().adminConfigStorage.feeReceiver = feeReceiver;
        emit FeeReceiverUpdated(feeReceiver);
    }

    function setResolutionFeeBps(uint16 bps) external override {
        LibDiamond.enforceIsContractOwner();
        require(bps <= 10_000, "AdminConfig: fee too high");

        LibDoefinStorage.diamondStorage().adminConfigStorage.resolutionFeeBps = bps;
        emit ResolutionFeeUpdated(bps);
    }

    function setTradingFeesBps(uint16 makerBps, uint16 takerBps) external override {
        LibDiamond.enforceIsContractOwner();
        require(makerBps <= 10_000 && takerBps <= 10_000, "AdminConfig: fee too high");

        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        ds.adminConfigStorage.makerTradingFeeBps = makerBps;
        ds.adminConfigStorage.takerTradingFeeBps = takerBps;

        emit TradingFeesUpdated(makerBps, takerBps);
    }

    function isAllowedCollateral(address token) external view override returns (bool) {
        return LibDoefinStorage.diamondStorage().adminConfigStorage.isAllowed[token];
    }

    function getCollateralUnit(address token) external view override returns (uint256) {
        require(LibDoefinStorage.diamondStorage().adminConfigStorage.isAllowed[token], "AdminConfig: token not allowed");
        return LibDoefinStorage.diamondStorage().adminConfigStorage.unitPerPair[token];
    }

    function getFees() external view returns (address feeReceiver, uint16 resolutionFeeBps, uint16 makerTradingFeeBps, uint16 takerTradingFeeBps) {
        LibDoefinStorage.AdminConfigStorage storage cfg = LibDoefinStorage.diamondStorage().adminConfigStorage;
        return (cfg.feeReceiver, cfg.resolutionFeeBps, cfg.makerTradingFeeBps, cfg.takerTradingFeeBps);
    }
}
