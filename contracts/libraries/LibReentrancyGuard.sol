// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

import {LibDoefinStorage} from "./LibDoefinStorage.sol";
import {Errors} from "./Errors.sol";

/**
 * @title LibReentrancyGuard
 * @notice Diamond-compatible reentrancy protection library
 * @dev Uses Diamond storage to maintain reentrancy state across facets
 */
library LibReentrancyGuard {
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    /**
     * @notice Initialize reentrancy guard if not already initialized
     */
    function _initReentrancyGuard() internal {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        if (ds.reentrancyStorage._status == 0) {
            ds.reentrancyStorage._status = _NOT_ENTERED;
        }
    }

    /**
     * @notice Check and set reentrancy guard
     * @dev Call this at the start of protected functions
     */
    function _nonReentrantBefore() internal {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        
        // Initialize on first use
        if (ds.reentrancyStorage._status == 0) {
            ds.reentrancyStorage._status = _NOT_ENTERED;
        }
        
        // Check for reentrancy
        if (ds.reentrancyStorage._status == _ENTERED) {
            revert Errors.ReentrantCall();
        }

        // Set entered state
        ds.reentrancyStorage._status = _ENTERED;
    }

    /**
     * @notice Reset reentrancy guard
     * @dev Call this at the end of protected functions
     */
    function _nonReentrantAfter() internal {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        ds.reentrancyStorage._status = _NOT_ENTERED;
    }

    /**
     * @notice Check if currently in a non-reentrant call
     */
    function _isEntered() internal view returns (bool) {
        LibDoefinStorage.DiamondStorage storage ds = LibDoefinStorage.diamondStorage();
        return ds.reentrancyStorage._status == _ENTERED;
    }

    /**
     * @notice Modifier for reentrancy protection
     * @dev Use this modifier on functions that need protection
     */
    modifier nonReentrant() {
        _nonReentrantBefore();
        _;
        _nonReentrantAfter();
    }
}