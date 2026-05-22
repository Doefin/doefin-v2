// SPDX-License-Identifier: AGPL-3.0
// Based on Diamond Standard by Nick Mudge: https://github.com/mudgen/diamond-3-hardhat
// Uses shared logic from Gnosis Conditional Tokens Framework: https://github.com/gnosis/conditional-tokens-contracts

pragma solidity ^0.8.6;

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
    /// @notice Get all markets for a given condition (now returns all markets across different collaterals/parents)
    /// @param conditionId The condition identifier
    /// @return markets Array of market metadata for all markets associated with the condition
    function getMarketsByCondition(bytes32 conditionId) external view override returns (LibDoefinStorage.MarketMetadata[] memory markets) {
        // Use the new registry function that returns all markets for a condition
        return LibPositionRegistry.getMarketsForCondition(conditionId);
    }

    /**
     * @notice Retrieves all position IDs across all markets for a specific condition
     * @dev Aggregates position IDs from all markets (different collateral/parent combinations) for the condition
     * @dev Useful for comprehensive position discovery and condition-wide analysis
     * @param conditionId The unique condition identifier to query position IDs for
     * @return positionIds Array of all position IDs associated with the condition across all markets
     * @custom:view Read-only aggregation of position data across markets
     * @custom:aggregation Combines position IDs from multiple markets into single array
     * @custom:condition Condition-centric view of all associated position tokens
     * @custom:gas Linear cost based on total number of markets and positions for the condition
     */
    /// @notice Get all position IDs across all markets for a given condition
    /// @param conditionId The condition identifier
    /// @return positionIds Array of all position IDs associated with the condition
    function getAllPositionIdsByCondition(bytes32 conditionId) external view returns (uint256[] memory positionIds) {
        LibDoefinStorage.MarketMetadata[] memory markets = LibPositionRegistry.getMarketsForCondition(conditionId);

        // Calculate total position count
        uint256 totalPositions = 0;
        for (uint256 i = 0; i < markets.length; i++) {
            totalPositions += markets[i].positionIds.length;
        }

        // Build combined array
        positionIds = new uint256[](totalPositions);
        uint256 index = 0;
        for (uint256 i = 0; i < markets.length; i++) {
            for (uint256 j = 0; j < markets[i].positionIds.length; j++) {
                positionIds[index] = markets[i].positionIds[j];
                index++;
            }
        }
    }

    /**
     * @notice Retrieves position IDs for a specific market defined by condition, parent, and collateral
     * @dev Returns position IDs for the exact market combination, not aggregated across markets
     * @dev Market is uniquely identified by the combination of all three parameters
     * @param conditionId The unique condition identifier
     * @param parentCollectionId The parent collection identifier for market segmentation
     * @param collateralToken The collateral token address for the specific market
     * @return positionIds Array of position IDs for the specific market combination
     * @custom:view Read-only access to specific market position data
     * @custom:market Precise market identification using three-parameter key
     * @custom:validation Uses centralized market key building and existence validation
     * @custom:revert Errors.ConditionDoesNotExist() if market combination doesn't exist
     */
    /// @notice Get position IDs for a specific market (condition + parent + collateral)
    /// @param conditionId The condition identifier
    /// @param parentCollectionId The parent collection identifier
    /// @param collateralToken The collateral token address
    /// @return positionIds Array of position IDs for the specific market
    function getPositionIdsByMarket(
        bytes32 conditionId,
        bytes32 parentCollectionId,
        address collateralToken
    ) external view override returns (uint256[] memory positionIds) {
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();

        // Create the market key using centralized helper
        bytes32 marketKeyHash = LibPositionRegistry.buildMarketKey(conditionId, parentCollectionId, collateralToken);

        LibDoefinStorage.MarketMetadata storage metadata = ds.positionRegistry.marketsByKey[marketKeyHash];

        // Validate market exists
        if (metadata.collateralToken == address(0)) {
            revert Errors.ConditionDoesNotExist();
        }

        return metadata.positionIds;
    }

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
    /// @notice Get market metadata for a specific position
    /// @param positionId The position identifier
    /// @return metadata Complete market metadata including collateral token, parent collection, position IDs, and partitions
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
    /// @notice Get market metadata for a specific market combination
    /// @param conditionId The condition identifier
    /// @param parentCollectionId The parent collection identifier
    /// @param collateralToken The collateral token address
    /// @return metadata Complete market metadata for the specific market
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
    /// @notice Get the collateral token address for a position
    /// @param positionId The position identifier
    /// @return collateralToken The address of the collateral token
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
     * @custom:admin Uses admin configuration storage for collateral unit settings
     */
    /// @notice Get the collateral token unit/digits for a position
    /// @param positionId The position identifier
    /// @return unit The unit per pair for the collateral token
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
    /// @notice Get the condition ID for a position
    /// @param positionId The position identifier
    /// @return conditionId The condition identifier
    function getConditionId(uint256 positionId) external view override returns (bytes32 conditionId) {
        // Validate position first
        LibPositionRegistry.validatePositionId(positionId);

        // Use existing mapping
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        return ds.positionRegistry.conditionIdByPositionId[positionId];
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
    /// @notice Get the complement position ID for a given position
    /// @param positionId The position identifier
    /// @return complementId The complement position ID
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
    /// @notice Get comprehensive position information in one call
    /// @param positionId The position identifier
    /// @return conditionId The condition identifier
    /// @return collateralToken The collateral token address
    /// @return unit The collateral token unit
    /// @return complementId The complement position ID
    /// @return metadata The complete market metadata
    function getPositionInfo(
        uint256 positionId
    )
        external
        view
        override
        returns (bytes32 conditionId, address collateralToken, uint256 unit, uint256 complementId, LibDoefinStorage.MarketMetadata memory metadata)
    {
        // Validate position exists once
        LibPositionRegistry.validatePositionId(positionId);

        // Get all information efficiently
        LibDoefinStorage.AppStorage storage ds = LibDoefinStorage.appStorage();
        conditionId = ds.positionRegistry.conditionIdByPositionId[positionId];
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
