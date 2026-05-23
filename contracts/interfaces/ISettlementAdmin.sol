// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.20;

/**
 * @title ISettlementAdmin
 * @author Doefin
 * @notice Owner-only governance interface for the v3 settlement subsystem
 * @dev Operator management and the trading pause switch. Split out of {ISettlement}
 *      (ARCH-01 / SCRUM-230) so the operator hot-path surface and the owner-only
 *      governance surface are distinct interfaces — an off-chain integrator of the
 *      hot path no longer imports governance selectors it must never call.
 */
interface ISettlementAdmin {
    function setOperator(address _operator) external;

    function pauseTrading() external;

    function unpauseTrading() external;

    function getOperator() external view returns (address);

    function isTradingPaused() external view returns (bool);
}
