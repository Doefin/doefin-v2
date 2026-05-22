// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibSettlementStorage} from "../libraries/LibSettlementStorage.sol";
import {LibDiamond} from "../libraries/LibDiamond.sol";
import {Errors} from "../libraries/Errors.sol";
import {Events} from "../libraries/Events.sol";
import {ISettlementAdmin} from "../interfaces/ISettlementAdmin.sol";

/**
 * @title SettlementAdminFacet
 * @author Doefin
 * @notice Owner-only governance for the v3 settlement subsystem — operator
 *         management and the trading pause switch.
 * @dev ARCH-01 / SCRUM-230 — extracted from SettlementFacet so the owner-only
 *      governance surface is no longer co-located with the operator `matchOrders`
 *      hot path. The function bodies are unchanged from their pre-extraction form;
 *      they read/write the settlement namespace ({LibSettlementStorage}).
 */
contract SettlementAdminFacet is ISettlementAdmin {
    // ========================================
    // ADMIN FUNCTIONS
    // ========================================

    /**
     * @notice Set the authorized operator address.
     * @dev Only contract owner.
     * @param _operator The new operator address. Must not be `address(0)`.
     * @custom:audit SEC-011 — pre-fix this function accepted `address(0)` (silently
     *      disabling settlement until a follow-up call) and emitted no event. Now reverts
     *      on zero and emits `OperatorUpdated(old, new)`.
     * @custom:reverts Errors.ZeroAddress when `_operator == address(0)`.
     * @custom:emits OperatorUpdated
     */
    function setOperator(address _operator) external {
        LibDiamond.enforceIsContractOwner();
        if (_operator == address(0)) revert Errors.ZeroAddress();
        LibSettlementStorage.SettlementStorage storage ss = LibSettlementStorage.settlementStorage();
        address oldOperator = ss.operator;
        ss.operator = _operator;
        emit Events.OperatorUpdated(oldOperator, _operator);
    }

    /**
     * @notice Pause all settlement
     * @dev Only contract owner
     * @custom:emits SettlementTradingPaused
     */
    function pauseTrading() external {
        LibDiamond.enforceIsContractOwner();
        LibSettlementStorage.SettlementStorage storage ss = LibSettlementStorage.settlementStorage();
        ss.tradingPaused = true;
        emit Events.SettlementTradingPaused(msg.sender);
    }

    /**
     * @notice Unpause settlement
     * @dev Only contract owner
     * @custom:emits SettlementTradingUnpaused
     */
    function unpauseTrading() external {
        LibDiamond.enforceIsContractOwner();
        LibSettlementStorage.SettlementStorage storage ss = LibSettlementStorage.settlementStorage();
        ss.tradingPaused = false;
        emit Events.SettlementTradingUnpaused(msg.sender);
    }

    // ========================================
    // VIEW FUNCTIONS
    // ========================================

    /// @notice Get the current operator
    function getOperator() external view returns (address) {
        return LibSettlementStorage.settlementStorage().operator;
    }

    /// @notice Check if trading is paused
    function isTradingPaused() external view returns (bool) {
        return LibSettlementStorage.settlementStorage().tradingPaused;
    }
}
