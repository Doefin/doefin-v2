// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IReentryTarget {
    function withdrawFees(address token, uint256 amount) external;
}

/**
 * @title MaliciousReentrantERC20
 * @notice Test-only ERC20 whose `transfer` hook re-enters the configured target
 *         (the Diamond) with a `withdrawFees` call. Used by the SCRUM-236
 *         reentrancy-regression test to prove the LibReentrancyGuard window
 *         around `AdminConfigFacet.withdrawFees` is effective.
 * @dev The reentry is fired by transfer, captures the inner result, and resets
 *      its arming flag so the next outer transfer does not re-trigger.
 */
contract MaliciousReentrantERC20 is ERC20 {
    address public target;
    uint256 public reentryAmount;
    bool public armed;

    bool public reentryAttempted;
    bool public reentrySucceeded;
    bytes public reentryReturnData;

    constructor() ERC20("Malicious Reentrant", "BAD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setTarget(address _target) external {
        target = _target;
    }

    function arm(uint256 _amount) external {
        reentryAmount = _amount;
        armed = true;
        reentryAttempted = false;
        reentrySucceeded = false;
        reentryReturnData = "";
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (!armed) return;
        if (target == address(0)) return;
        // Only re-enter on transfer OUT of the target (the Diamond paying out fees).
        if (from != target) return;
        armed = false;
        reentryAttempted = true;
        bytes memory call =
            abi.encodeWithSelector(IReentryTarget.withdrawFees.selector, address(this), reentryAmount);
        (bool ok, bytes memory ret) = target.call(call);
        reentrySucceeded = ok;
        reentryReturnData = ret;
    }
}
