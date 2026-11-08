// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.20;

/**
 * @title FakeSafe
 * @notice Not a Safe: custom code that writes the canonical singleton and fallback handler into the
 *         storage slots a Safe keeps them in, so a check that only reads those slots is fooled.
 *         Once armed it refuses position tokens on a live transaction while `eth_call` still passes.
 *         Settlement griefing tests only.
 */
contract FakeSafe {
    address private slot0;
    address public immutable owner;
    bool public armed;

    constructor(address singleton, address handler, address o) {
        owner = o;
        assembly {
            sstore(0, singleton)
            sstore(0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5, handler)
        }
    }

    function arm(bool a) external {
        require(msg.sender == owner, "owner");
        armed = a;
    }

    function exec(address to, bytes calldata data) external {
        require(msg.sender == owner, "owner");
        (bool ok, ) = to.call(data);
        require(ok, "exec failed");
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external view returns (bytes4) {
        require(!armed || tx.gasprice == 0, "fake safe: live tx");
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155BatchReceived.selector;
    }
}

/// @notice Guard that refuses every Safe transaction. Used to show a guard cannot touch settlement.
contract HostileGuard {
    function supportsInterface(bytes4) external pure returns (bool) {
        return true;
    }

    function checkTransaction(
        address,
        uint256,
        bytes memory,
        uint8,
        uint256,
        uint256,
        uint256,
        address,
        address payable,
        bytes memory,
        address
    ) external pure {
        revert("guard: no");
    }

    function checkAfterExecution(bytes32, bool) external pure {
        revert("guard: no");
    }
}
