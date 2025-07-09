// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

library LibErrors {
    // AdminConfigFacet errors
    error InvalidTokenAddress();
    error TokenAlreadyAllowed();
    error TokenNotAllowed();
    error InvalidFeeReceiver();
    error FeeTooHigh();
}
