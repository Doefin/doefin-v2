// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.20;

import {LibDoefinStorage} from "../libraries/LibDoefinStorage.sol";
import {LibAdminConfigStorage} from "../libraries/LibAdminConfigStorage.sol";
import {LibPositionRegistry} from "../libraries/LibPositionRegistry.sol";
import {IMarketData} from "../interfaces/IMarketData.sol";
import {Errors} from "../libraries/Errors.sol";

/**
 * @title MarketDataFacet
 * @author Doefin
 * @notice Diamond facet providing comprehensive market and position data queries
 * @dev Implements IMarketData interface for accessing market metadata, position information, and condition data
 * @dev Part of the Diamond pattern implementation enabling modular market data access
 * @dev All functions are view-only and optimized for efficient data retrieval across market structures
 * @custom:facet Market data access and position information queries
 * @custom:diamond Part of the EIP-2535 Diamond Standard implementation
 * @custom:ctf Integration with Gnosis Conditional Token Framework for position data
 * @custom:registry Uses LibPositionRegistry for centralized position and market management
 */
contract MarketDataFacet is IMarketData {
    /**
     * @notice Retrieves all markets associated with a specific condition across different collaterals and parents
     * @dev Returns comprehensive market metadata for all markets linked to the condition
     * @dev Markets are differentiated by collateral token and parent collection combinations
     * @param conditionId The unique condition identifier to query markets for
     * @return markets Array of complete market metadata for all markets associated with the condition
     * @custom:view Read-only access to position registry storage
     * @custom:market Comprehensive market discovery for condition-based queries
     * @custom:registry Delegates to LibPositionRegistry.getMarketsForCondition for implementation
     * @custom:ctf Compatible with Gnosis CTF condition and market structures
     */
    function getMarketsByCondition(bytes32 conditionId) external view override returns (LibDoefinStorage.MarketMetadata[] memory markets) {
        // Use the new registry function that returns all markets for a condition
        return LibPositionRegistry.getMarketsForCondition(conditionId);
    }

    // SCRUM-234 (dead-code B-1/B-2) — `getAllPositionIdsByCondition` and
    // `getPositionIdsByMarket` were removed. Layer-3 reachability confirmed zero
    // callers across contracts/ + doefin-backend/ + doefin-frontend/ + ops scripts
    // + tests; both were registered selectors with no integration surface.

    /**
     * @notice Retrieves complete market metadata for a specific position token
     * @dev Returns comprehensive market information including collateral token, parent collection, position IDs, and partitions
     * @dev Validates position existence and delegates to LibPositionRegistry for data retrieval
     * @param positionId The unique position identifier to query market metadata for
     * @return metadata Complete market metadata including collateral token, parent collection, position IDs, and partitions
     * @custom:view Read-only access to position registry storage via library
     * @custom:validation Uses existing LibPositionRegistry validation for position existence
     * @custom:metadata Comprehensive market data structure with all relevant information
     * @custom:delegation Delegates to LibPositionRegistry.getMarketMetadata for implementation
     */
    function getMarketMetadata(uint256 positionId) external view override returns (LibDoefinStorage.MarketMetadata memory metadata) {
        // Use existing validation from LibPositionRegistry
        return LibPositionRegistry.getMarketMetadata(positionId);
    }

    /**
     * @notice Retrieves market metadata for a specific market combination of condition, parent, and collateral
     * @dev Returns complete market metadata for the exact market defined by the three parameters
     * @dev Validates market existence before returning metadata to ensure data integrity
     * @param conditionId The unique condition identifier
     * @param parentCollectionId The parent collection identifier for market segmentation
     * @param collateralToken The collateral token address for the specific market
     * @return metadata Complete market metadata for the specific market combination
     * @custom:view Read-only access to market metadata via market key lookup
     * @custom:validation Ensures market exists before returning data
     * @custom:market Uses centralized market key building for consistent identification
     * @custom:revert Errors.ConditionDoesNotExist() if market combination doesn't exist
     */
    function getMarketMetadataByMarket(
        bytes32 conditionId,
        bytes32 parentCollectionId,
        address collateralToken
    ) external view override returns (LibDoefinStorage.MarketMetadata memory metadata) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        // Create the market key using centralized helper
        bytes32 marketKeyHash = LibPositionRegistry.buildMarketKey(conditionId, parentCollectionId, collateralToken);

        LibDoefinStorage.MarketMetadata storage storedMetadata = ds.positionRegistry.marketsByKey[marketKeyHash];

        // Validate market exists
        if (storedMetadata.collateralToken == address(0)) {
            revert Errors.ConditionDoesNotExist();
        }

        return storedMetadata;
    }

    /**
     * @notice Retrieves the collateral token address associated with a specific position
     * @dev Essential for understanding what token is used as collateral for the position
     * @dev Delegates to LibPositionRegistry for position-to-collateral mapping
     * @param positionId The unique position identifier to query collateral for
     * @return collateralToken The address of the ERC20 collateral token for the position
     * @custom:view Read-only access to position registry collateral mapping
     * @custom:position Core position metadata for trading and settlement operations
     * @custom:delegation Delegates to LibPositionRegistry.getCollateralToken for implementation
     * @custom:token Returns ERC20 token address used as collateral for the position
     */
    function getCollateralToken(uint256 positionId) external view override returns (address collateralToken) {
        return LibPositionRegistry.getCollateralToken(positionId);
    }

    /**
     * @notice Retrieves the collateral token unit/digits configuration for a position
     * @dev Returns the unit per pair value used for precision and calculation in trading operations
     * @dev Validates position existence and retrieves unit configuration from admin storage
     * @param positionId The unique position identifier to query collateral unit for
     * @return unit The unit per pair value for the collateral token (e.g., 1e18 for 18-decimal tokens)
     * @custom:view Read-only access to admin configuration storage
     * @custom:validation Validates position existence before accessing unit configuration
     * @custom:precision Essential for accurate trading calculations and token conversions
     * @custom:admin Uses the admin-config storage namespace for collateral unit settings
     */
    function getCollateralUnit(uint256 positionId) external view override returns (uint256 unit) {
        // Validate position first
        LibPositionRegistry.validatePositionId(positionId);

        // Get collateral token
        address collateralToken = LibPositionRegistry.getCollateralToken(positionId);

        // Get unit from the admin-config namespace
        return LibAdminConfigStorage.adminConfigStorage().unitPerPair[collateralToken];
    }

    /**
     * @notice Retrieves the condition ID associated with a specific position
     * @dev Returns the unique condition identifier that the position token represents
     * @dev Validates position existence and accesses position-to-condition mapping
     * @param positionId The unique position identifier to query condition for
     * @return conditionId The unique condition identifier associated with the position
     * @custom:view Read-only access to position registry condition mapping
     * @custom:validation Validates position existence using LibPositionRegistry
     * @custom:ctf Essential for Gnosis CTF integration and condition resolution
     * @custom:mapping Uses direct storage mapping for efficient condition lookup
     */
    /// @dev SCRUM-234 (dead-code A-15) — routed through
    ///      {LibPositionRegistry.getConditionId} (which calls `validatePositionId` and
    ///      then reads `conditionIdByPositionId`), mirroring the pattern of
    ///      {getComplement} below. The library function now has a real production
    ///      caller, removing the asymmetric direct-storage-read previously used here.
    function getConditionId(uint256 positionId) external view override returns (bytes32) {
        return LibPositionRegistry.getConditionId(positionId);
    }

    /**
     * @notice Retrieves the complement position ID for a given position in binary outcome markets
     * @dev Returns the opposing position ID in binary markets (YES/NO, WIN/LOSE, etc.)
     * @dev Essential for understanding market structure and position relationships
     * @param positionId The unique position identifier to find complement for
     * @return complementId The complement position ID representing the opposite outcome
     * @custom:view Read-only access to position complement mapping
     * @custom:binary Essential for binary outcome market operations and position pairing
     * @custom:delegation Delegates to LibPositionRegistry.getComplement for implementation
     * @custom:market Core market structure function for position relationship understanding
     */
    function getComplement(uint256 positionId) external view override returns (uint256 complementId) {
        // Use existing library function
        return LibPositionRegistry.getComplement(positionId);
    }

    /**
     * @notice Retrieves comprehensive position information in a single efficient call
     * @dev Aggregates condition ID, collateral token, unit, complement, and market metadata
     * @dev Optimized for scenarios requiring complete position context in a single transaction
     * @dev Validates position existence once and efficiently accesses all related data
     * @param positionId The unique position identifier to query comprehensive information for
     * @return conditionId The unique condition identifier associated with the position
     * @return collateralToken The address of the ERC20 collateral token for the position
     * @return unit The unit per pair value for collateral token precision
     * @return complementId The complement position ID representing the opposite outcome
     * @return metadata Complete market metadata including all market configuration data
     * @custom:view Read-only comprehensive position data aggregation
     * @custom:optimization Single validation with multiple data access for efficiency
     * @custom:validation Comprehensive token allowance and position existence checking
     * @custom:aggregation Combines multiple position-related queries into single call
     * @custom:revert Errors.TokenNotAllowed() if collateral token not configured
     */
    function getPositionInfo(
        uint256 positionId
    )
        external
        view
        override
        returns (bytes32 conditionId, address collateralToken, uint256 unit, uint256 complementId, LibDoefinStorage.MarketMetadata memory metadata)
    {
        // SCRUM-234 (A-15) + CR-3291973204 — route every read through
        // LibPositionRegistry. Each library getter calls validatePositionId
        // internally, so the bespoke `validatePositionId` call above is
        // redundant. Matches getConditionId (line ~150) and the
        // `.coderabbit.yml` MarketDataFacet contract that forbids facets from
        // reading positionRegistry storage directly (broken-encapsulation
        // regression check).
        conditionId = LibPositionRegistry.getConditionId(positionId);
        collateralToken = LibPositionRegistry.getCollateralToken(positionId);
        complementId = LibPositionRegistry.getComplement(positionId);
        metadata = LibPositionRegistry.getMarketMetadata(positionId);

        // Get unit from the admin-config namespace
        LibAdminConfigStorage.AdminConfigStorage storage acs = LibAdminConfigStorage.adminConfigStorage();
        if (!acs.isAllowed[collateralToken]) {
            revert Errors.TokenNotAllowed();
        }
        unit = acs.unitPerPair[collateralToken];
    }
}
