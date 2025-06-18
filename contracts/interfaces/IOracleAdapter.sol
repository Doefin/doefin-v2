// SPDX-License-Identifier: MIT
pragma solidity ^0.8.6;

interface IOracleAdapter {
    event OutcomeReported(bytes32 indexed conditionId, uint[] payouts);

    function reportOutcome(bytes32 conditionId, uint[] calldata payouts) external;
    function linkConditionToFeed(bytes32 conditionId, bytes32 externalFeedId) external;
}
