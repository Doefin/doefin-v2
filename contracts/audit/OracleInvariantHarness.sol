// SPDX-License-Identifier: AGPL-3.0
pragma solidity 0.8.20;

/* ============================================================================
 *                      OracleInvariantHarness
 * ----------------------------------------------------------------------------
 * TEST-ONLY. Echidna / Medusa property-fuzzing harness for the PRODUCTION
 * Bitcoin block-header oracle facet (DoefinV1BlockHeaderOracleFacet), driven
 * with real Bitcoin headers only. SCRUM-521-AUDIT-SCOPE.
 *
 *   echidna contracts/audit/OracleInvariantHarness.sol \
 *     --contract OracleInvariantHarness --config security/echidna.oracle.config.yaml
 *   medusa fuzz --config security/medusa.oracle.json
 *
 * All actions, properties and the reference model live in
 * OracleInvariantHarnessBase.sol (see its header). Expected result: every
 * echidna_* property holds.
 *
 * This contract MUST NEVER be added to the production deploy script. It is
 * excluded from Slither / solhint / coverage with the rest of contracts/audit/.
 * ==========================================================================*/

import {HarnessOwnableOracle} from "./HarnessOwnableOracle.sol";
import {OracleInvariantHarnessBase} from "./OracleInvariantHarnessBase.sol";

/**
 * @title OracleInvariantHarness
 * @author Doefin (audit)
 * @notice Oracle fuzz harness bound to the production oracle facet.
 */
contract OracleInvariantHarness is OracleInvariantHarnessBase {
    /// @inheritdoc OracleInvariantHarnessBase
    /// @dev The production facet plus the clone-ownership hook ORC-008's owner-only init needs.
    function _newOracleFacet() internal override returns (address) {
        return address(new HarnessOwnableOracle());
    }

    /// @dev ORC-007: the production facet reads the median-time window by height.
    function _mtpWindowFixed() internal pure override returns (bool) {
        return true;
    }
}
