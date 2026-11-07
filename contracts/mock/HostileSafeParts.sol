// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.20;

/// @dev The Safe entry point a handler enabled as a module can call back into.
interface ISafeModule {
    function execTransactionFromModule(address to, uint256 value, bytes memory data, uint8 operation) external returns (bool);
}

/**
 * @title HostileHandler
 * @notice Fallback handler a Safe owner can install to grief a settlement that pays position tokens
 *         into the Safe. Settlement griefing tests only.
 * @dev Modes: 0 always reverts, 1 returns the wrong selector, 2 reverts only on a live transaction
 *      (`tx.gasprice != 0`, so `eth_call` passes), 3 burns the gas it is given, 4 revokes `spender`'s
 *      `token` allowance through the Safe mid-settlement (the handler must also be an enabled module),
 *      5 refuses tokens coming from `banned`.
 */
contract HostileHandler {
    uint8 public immutable mode;
    address public immutable token;
    address public immutable spender;
    address public immutable banned;

    constructor(uint8 m, address t, address s, address b) {
        mode = m;
        token = t;
        spender = s;
        banned = b;
    }

    function onERC1155Received(address, address from, uint256, uint256, bytes calldata) external returns (bytes4) {
        if (mode == 0) revert("hostile: always");
        if (mode == 1) return 0xdeadbeef;
        if (mode == 2) {
            require(tx.gasprice == 0, "hostile: live tx");
        }
        if (mode == 3) {
            uint256 x;
            while (gasleft() > 30000) {
                x = uint256(keccak256(abi.encode(x)));
            }
            revert("hostile: burnt");
        }
        if (mode == 4) {
            ISafeModule(msg.sender).execTransactionFromModule(token, 0, abi.encodeWithSignature("approve(address,uint256)", spender, 0), 0);
        }
        if (mode == 5) {
            require(from != banned, "hostile: banned counterparty");
        }
        return this.onERC1155Received.selector;
    }
}

/// @notice Singleton that refuses everything: a Safe proxy pointed at it rejects every incoming call.
contract HostileSingleton {
    fallback() external payable {
        revert("hostile singleton");
    }

    receive() external payable {}
}

/// @notice Delegatecall target that overwrites a Safe proxy's singleton slot.
contract SlotZeroWriter {
    function set(address impl) external {
        assembly {
            sstore(0, impl)
        }
    }
}
