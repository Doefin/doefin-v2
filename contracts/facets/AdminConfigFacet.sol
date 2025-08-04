// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {IAdminConfig} from "../interfaces/IAdminConfig.sol";
import {LibDiamond} from "../libraries/LibDiamond.sol";
import {Errors} from "../libraries/Errors.sol";

contract AdminConfigFacet is IAdminConfig {
    function addCollateralToken(address token, uint256 unitPerPair) external override {
        LibDiamond.enforceIsContractOwner();
        if(token == address(0)) revert Errors.InvalidTokenAddress();
        if(unitPerPair == 0) revert Errors.InvalidUnitPerPair();

        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        if(ds.adminConfigStorage.isAllowed[token]) 
            revert Errors.TokenAlreadyAllowed();

        ds.adminConfigStorage.isAllowed[token] = true;
        ds.adminConfigStorage.unitPerPair[token] = unitPerPair;

        emit CollateralTokenAdded(token, unitPerPair);
    }

    function removeCollateralToken(address token) external override {
        LibDiamond.enforceIsContractOwner();
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();

        if(!ds.adminConfigStorage.isAllowed[token])
            revert Errors.TokenNotAllowed();

        ds.adminConfigStorage.isAllowed[token] = false;
        delete ds.adminConfigStorage.unitPerPair[token];

        emit CollateralTokenRemoved(token);
    }

    function setFeeReceiver(address feeReceiver) external override {
        LibDiamond.enforceIsContractOwner();
        if(feeReceiver == address(0))
            revert Errors.InvalidFeeReceiver();
        LibDoefinStorage.diamondStorage().adminConfigStorage.feeReceiver = feeReceiver;
        emit FeeReceiverUpdated(feeReceiver);
    }

    function setResolutionFeeBps(uint256 bps) external override {
        LibDiamond.enforceIsContractOwner();
        if(bps > 10_000) 
            revert Errors.FeeTooHigh();

        LibDoefinStorage.diamondStorage().adminConfigStorage.resolutionFeeBps = bps;
        emit ResolutionFeeUpdated(bps);
    }

    function setTradingFeesBps(uint256 makerBps, uint256 takerBps) external override {
        LibDiamond.enforceIsContractOwner();
        if(makerBps > 10_000 || takerBps > 10_000) 
            revert Errors.FeeTooHigh();

        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        ds.adminConfigStorage.makerTradingFeeBps = makerBps;
        ds.adminConfigStorage.takerTradingFeeBps = takerBps;

        emit TradingFeesUpdated(makerBps, takerBps);
    }

    function isAllowedCollateral(address token) external view override returns (bool) {
        return LibDoefinStorage.diamondStorage().adminConfigStorage.isAllowed[token];
    }

    function getCollateralUnit(address token) external view override returns (uint256) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        if(!ds.adminConfigStorage.isAllowed[token])
            revert Errors.TokenNotAllowed();
        return ds.adminConfigStorage.unitPerPair[token];
    }

    function getFees() external view returns (address feeReceiver, uint256 resolutionFeeBps, uint256 makerTradingFeeBps, uint256 takerTradingFeeBps) {
        LibDoefinStorage.AdminConfigStorage storage cfg = LibDoefinStorage.diamondStorage().adminConfigStorage;
        return (cfg.feeReceiver, cfg.resolutionFeeBps, cfg.makerTradingFeeBps, cfg.takerTradingFeeBps);
    }
}
