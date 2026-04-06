// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {LibDoefinOrder} from "../libraries/LibDoefinOrder.sol";

/**
 * @title ISettlement
 * @author Doefin
 * @notice Interface for the v2.1 hybrid settlement facet
 * @dev Operator-only entry point for executing matched order pairs on-chain
 */
interface ISettlement {
    function matchOrders(
        LibDoefinOrder.DoefinOrder calldata takerOrder,
        bytes calldata takerSignature,
        uint8 takerSignatureType,
        LibDoefinOrder.DoefinOrder[] calldata makerOrders,
        bytes[] calldata makerSignatures,
        uint8[] calldata makerSignatureTypes,
        uint128 takerFillAmount,
        uint128[] calldata makerFillAmounts
    ) external;

    function fillOrder(
        LibDoefinOrder.DoefinOrder calldata order,
        bytes calldata signature,
        uint8 signatureType,
        uint128 fillAmount
    ) external;

    function setOperator(address _operator) external;

    function pauseTrading() external;

    function unpauseTrading() external;

    function getFilledAmount(bytes32 orderHash) external view returns (uint256);

    function getOperator() external view returns (address);

    function isTradingPaused() external view returns (bool);

    function registerPositionPair(
        bytes32 positionIdA,
        bytes32 positionIdB,
        bytes32 conditionId,
        address collateralToken
    ) external;
}
