// SPDX-License-Identifier: AGPL-3.0
pragma solidity 0.8.20;

import {DoefinV1BlockHeaderOracle} from "../facets/DoefinV1BlockHeaderOracleFacet.sol";
import {LibDiamond} from "../libraries/LibDiamond.sol";

/**
 * @title HarnessOwnableOracle
 * @author Doefin (audit)
 * @notice TEST-ONLY. The production oracle facet plus one hook that lets an EIP-1167 clone
 *         claim Diamond ownership of its own storage.
 * @dev ORC-008 made `initializeBlockHeaderOracle` owner-only. The fuzz harness runs each world
 *      as a clone of the facet (Diamond-equivalent delegatecall over the clone's storage), which
 *      has no owner, so the harness claims ownership of every fresh clone before initialising it.
 *      The facet's own code is inherited unchanged. MUST NEVER be cut into a Diamond.
 */
contract HarnessOwnableOracle is DoefinV1BlockHeaderOracle {
    /// @notice First caller becomes the owner of this instance's storage; no-op afterwards.
    function harnessClaimOwnership() external {
        if (LibDiamond.contractOwner() == address(0)) LibDiamond.setContractOwner(msg.sender);
    }
}
