// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.6;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title MaliciousReentrantOperator
 * @notice Test-only mock. A settlement operator that attempts to reenter the
 *         SettlementFacet from inside the ERC-1155 `onERC1155Received` callback
 *         that fires while a sell-side `fillOrder` is mid-execution.
 * @dev Exercises the `nonReentrant` guard (LibReentrancyGuard). The operator is
 *      the most-privileged settlement caller, so this is the only actor that can
 *      pass the `onlyOperator` modifier on a reentrant call — it is the worst
 *      case for the reentrancy guard and the only one that can actually reach
 *      `LibReentrancyGuard._nonReentrantBefore` a second time.
 *
 *      The reentrant call is made via a low-level `call` and its result is
 *      CAPTURED (not bubbled) so the test can assert the reentrant attempt
 *      specifically reverted with `ReentrantCall()`. `onERC1155Received` then
 *      returns the ERC-1155 magic value so the OUTER `fillOrder` completes —
 *      proving the guard rejects the reentry without corrupting the legit call.
 */
contract MaliciousReentrantOperator {
    address public settlement;
    bytes public reentryCalldata;

    bool public reentryAttempted;
    bool public reentrySucceeded;
    bytes public reentryReturnData;

    function setSettlement(address _settlement) external {
        settlement = _settlement;
    }

    /// @notice Calldata the mock replays against the settlement facet on callback.
    function setReentryCalldata(bytes calldata data) external {
        reentryCalldata = data;
    }

    /// @notice Approve `spender` (the Diamond) to pull this contract's collateral
    ///         so the sell-side fill's operator-payment leg can complete.
    function approveCollateral(address token, address spender) external {
        IERC20(token).approve(spender, type(uint256).max);
    }

    /// @notice Kick off the settlement call that triggers the ERC-1155 callback.
    function fire(bytes calldata callData) external {
        (bool ok, bytes memory ret) = settlement.call(callData);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    function onERC1155Received(
        address,
        address,
        uint256,
        uint256,
        bytes calldata
    ) external returns (bytes4) {
        // Reenter exactly once; capture the outcome rather than bubbling it.
        if (!reentryAttempted) {
            reentryAttempted = true;
            (bool ok, bytes memory ret) = settlement.call(reentryCalldata);
            reentrySucceeded = ok;
            reentryReturnData = ret;
        }
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        return this.onERC1155BatchReceived.selector;
    }
}
