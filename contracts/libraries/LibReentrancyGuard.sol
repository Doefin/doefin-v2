// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.20;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {Errors} from "./Errors.sol";

/**
 * @title LibReentrancyGuard
 * @notice Diamond-compatible reentrancy protection library
 * @dev Maintains the reentrancy state in Diamond storage so it is shared across facets.
 *
 *      Solidity libraries cannot export a modifier for importing contracts to apply, so a
 *      facet that needs reentrancy protection declares its own `nonReentrant` modifier
 *      wrapping these two functions:
 *
 *          modifier nonReentrant() {
 *              LibReentrancyGuard._nonReentrantBefore();
 *              _;
 *              LibReentrancyGuard._nonReentrantAfter();
 *          }
 *
 *      `reentrancyStorage._status` is set to `_NOT_ENTERED` by `LibDoefinStorage.initialize`
 *      at deployment, so the guard never observes the zero (uninitialized) state on a
 *      live Diamond.
 */
library LibReentrancyGuard {
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    /**
     * @notice Check and set the reentrancy guard. Call at the start of a protected function.
     * @dev Reverts {Errors.ReentrantCall} if the guard is already entered.
     */
    function _nonReentrantBefore() internal {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        if (ds.reentrancyStorage._status == _ENTERED) {
            revert Errors.ReentrantCall();
        }

        ds.reentrancyStorage._status = _ENTERED;
    }

    /**
     * @notice Reset the reentrancy guard. Call at the end of a protected function.
     */
    function _nonReentrantAfter() internal {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        ds.reentrancyStorage._status = _NOT_ENTERED;
    }
}
