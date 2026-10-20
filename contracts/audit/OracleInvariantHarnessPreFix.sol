// SPDX-License-Identifier: AGPL-3.0
pragma solidity 0.8.20;

/* ============================================================================
 *                      OracleInvariantHarnessPreFix
 * ----------------------------------------------------------------------------
 * TEST-ONLY NEGATIVE CONTROL. The oracle fuzz harness bound to a verbatim copy
 * of the PRE-SCRUM-521 oracle facet (PreFixDoefinV1BlockHeaderOracle), whose
 * checked left-to-right rewind arithmetic underflows whenever
 * `nextBlockIndex <= depth` (SEC-015). Proves the harness catches that class:
 * echidna_no_panic_nonempty and echidna_valid_chains_accepted MUST FAIL here.
 *
 *   echidna contracts/audit/OracleInvariantHarnessPreFix.sol \
 *     --contract OracleInvariantHarnessPreFix --config security/echidna.oracle.config.yaml
 *   (security/scripts/run-echidna.sh / run-medusa.sh: ORACLE_NEGATIVE_CONTROL=1)
 *
 * Note that SEC-015 does not need the orphan: right after initialisation
 * `nextBlockIndex == 0`, so any replay at depth >= 1 already panics.
 * ==========================================================================*/

import {PreFixDoefinV1BlockHeaderOracle} from "./PreFixDoefinV1BlockHeaderOracle.sol";
import {OracleInvariantHarnessBase} from "./OracleInvariantHarnessBase.sol";

/**
 * @title OracleInvariantHarnessPreFix
 * @author Doefin (audit)
 * @notice Oracle fuzz harness bound to the pre-fix oracle facet (negative control).
 */
contract OracleInvariantHarnessPreFix is OracleInvariantHarnessBase {
    /// @inheritdoc OracleInvariantHarnessBase
    function _newOracleFacet() internal override returns (address) {
        return address(new PreFixDoefinV1BlockHeaderOracle());
    }
}
