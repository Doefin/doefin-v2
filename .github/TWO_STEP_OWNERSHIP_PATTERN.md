# Two-Step Ownership Transfer Pattern

**Status**: 📋 Documented for Future Implementation  
**Priority**: Medium (Security Enhancement)  
**Estimated Effort**: 4-6 hours  
**Target Version**: V2.x or Security Enhancement Sprint

---

## Executive Summary

This document outlines the implementation of a two-step ownership transfer pattern across contracts that manage their own ownership (non-Diamond contracts). The two-step pattern prevents accidental ownership transfer to incorrect addresses by requiring the new owner to explicitly accept ownership.

**Expected Benefits**:
- **Security**: Prevents irreversible ownership transfer to wrong/typo'd addresses
- **Explicit Confirmation**: New owner must explicitly accept, proving they control the address
- **Industry Standard**: Follows OpenZeppelin's Ownable2Step pattern

**Current Status**:
- ✅ **Implemented**: `BlockScholesOracleAdapter` (standalone contract)
- ⏳ **Needs Review**: `MockOracleAdapter` (if it requires ownership transfer)
- ✅ **Not Required**: Diamond facets (use centralized `OwnershipFacet`)

---

## Pattern Overview

### Single-Step Pattern (Current - Risky)

```solidity
// ❌ RISKY: Immediate, irreversible transfer
function transferOwnership(address newOwner) external onlyOwner {
    if (newOwner == address(0)) revert InvalidAddress();
    owner = newOwner;
    emit OwnershipTransferred(msg.sender, newOwner);
}
```

**Risk**: Typo in address → permanent loss of ownership

### Two-Step Pattern (Recommended - Safe)

```solidity
// ✅ SAFE: Propose ownership transfer
function proposeOwnership(address newOwner) external onlyOwner {
    if (newOwner == address(0)) revert InvalidAddress();
    pendingOwner = newOwner;
    emit OwnershipProposed(owner, newOwner);
}

// ✅ SAFE: New owner must explicitly accept
function acceptOwnership() external {
    if (msg.sender != pendingOwner) revert NotPendingOwner();
    address previousOwner = owner;
    owner = pendingOwner;
    pendingOwner = address(0);
    emit OwnershipTransferred(previousOwner, owner);
}
```

**Benefit**: New owner must call `acceptOwnership()`, proving they control the address

---

## Implementation Checklist

### Step 1: Add Storage Variable

```solidity
// In contract storage section
address public owner;
address public pendingOwner;  // ADD THIS
```

### Step 2: Add Events

```solidity
// In events section
event OwnershipProposed(address indexed currentOwner, address indexed proposedOwner);  // ADD THIS
event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
```

### Step 3: Add Custom Error

```solidity
// In Errors.sol
/// @notice Thrown when caller is not the pending owner
error NotPendingOwner();
```

### Step 4: Replace Single Function with Two

**Remove**:
```solidity
function transferOwnership(address newOwner) external onlyOwner {
    // ... old implementation
}
```

**Add**:
```solidity
function proposeOwnership(address newOwner) external onlyOwner {
    if (newOwner == address(0)) {
        revert Errors.InvalidAddress();
    }
    pendingOwner = newOwner;
    emit OwnershipProposed(owner, newOwner);
}

function acceptOwnership() external {
    if (msg.sender != pendingOwner) {
        revert Errors.NotPendingOwner();
    }
    address previousOwner = owner;
    owner = pendingOwner;
    pendingOwner = address(0);
    emit OwnershipTransferred(previousOwner, owner);
}
```

### Step 5: Update Constructor (Optional but Recommended)

Keep constructor simple - it already emits `OwnershipTransferred(address(0), msg.sender)`:

```solidity
constructor() {
    owner = msg.sender;
    emit OwnershipTransferred(address(0), msg.sender);
}
```

---

## Contracts Requiring Review

### 1. MockOracleAdapter (`contracts/mock/MockOracleAdapter.sol`)

**Current Status**: Has single-step `transferOwnership()`  
**Location**: Around lines 180-187  
**Action Required**: 
- Review if ownership transfer is actually needed in tests
- If yes, implement two-step pattern
- If no, consider removing or documenting as test-only

**Code to Review**:
```solidity
function transferOwnership(address newOwner) external onlyOwner {
    if (newOwner == address(0)) {
        revert Errors.InvalidAddress();
    }
    address previousOwner = owner;
    owner = newOwner;
    emit Events.OwnershipTransferred(previousOwner, newOwner);
}
```

**Recommendation**: 
- If this is only for testing, keep single-step but add comment: `// Single-step for testing convenience`
- If used in production-like scenarios, upgrade to two-step

### 2. Diamond OwnershipFacet (`contracts/facets/OwnershipFacet.sol`)

**Current Status**: Uses single-step via `LibDiamond.setContractOwner()`  
**Action Required**: Consider upgrading Diamond's core ownership pattern

**Current Implementation**:
```solidity
function transferOwnership(address _newOwner) external override {
    LibDiamond.enforceIsContractOwner();
    address _previousOwner = LibDiamond.contractOwner();
    LibDiamond.setContractOwner(_newOwner);
    emit Events.OwnershipTransferred(_previousOwner, _newOwner);
}
```

**Considerations**:
- Diamond is the core protocol contract
- Ownership transfer is critical operation
- Two-step pattern would add significant safety
- Requires changes to `LibDiamond` library
- Breaking change to IERC173 interface (would need custom interface)

**Recommendation**: 
- **High Priority** - Diamond should use two-step pattern
- Implement as separate enhancement ticket
- Requires careful testing and migration planning
- Consider creating `proposeOwnership()` and `acceptOwnership()` alongside existing function

---

## Diamond Pattern Considerations

### Why Diamond Facets Don't Need This

Diamond facets (like `OrderCreationFacet`, `OracleManagerFacet`, etc.) use the centralized `OwnershipFacet`:

```solidity
// In any facet
function adminFunction() external {
    LibDiamond.enforceIsContractOwner();  // Uses Diamond's owner
    // ... admin logic
}
```

**Key Points**:
- All facets share the same owner (stored in `LibDiamond`)
- Only `OwnershipFacet` can change ownership
- One place to implement two-step pattern (in `OwnershipFacet`)

### Standalone Contracts That Need This

Contracts deployed separately from Diamond:
1. ✅ `BlockScholesOracleAdapter` - **Already Implemented**
2. ⏳ `MockOracleAdapter` - Needs review (test contract)
3. Any future oracle adapters deployed standalone

---

## Testing Requirements

### Unit Tests for Two-Step Pattern

```javascript
describe("Two-Step Ownership Transfer", () => {
  it("should allow owner to propose new owner", async () => {
    await contract.proposeOwnership(newOwner.address);
    expect(await contract.pendingOwner()).to.equal(newOwner.address);
  });

  it("should emit OwnershipProposed event", async () => {
    await expect(contract.proposeOwnership(newOwner.address))
      .to.emit(contract, "OwnershipProposed")
      .withArgs(owner.address, newOwner.address);
  });

  it("should revert if proposing zero address", async () => {
    await expect(contract.proposeOwnership(ethers.constants.AddressZero))
      .to.be.revertedWith("InvalidAddress");
  });

  it("should allow pending owner to accept ownership", async () => {
    await contract.proposeOwnership(newOwner.address);
    await contract.connect(newOwner).acceptOwnership();
    expect(await contract.owner()).to.equal(newOwner.address);
    expect(await contract.pendingOwner()).to.equal(ethers.constants.AddressZero);
  });

  it("should emit OwnershipTransferred on acceptance", async () => {
    await contract.proposeOwnership(newOwner.address);
    await expect(contract.connect(newOwner).acceptOwnership())
      .to.emit(contract, "OwnershipTransferred")
      .withArgs(owner.address, newOwner.address);
  });

  it("should revert if non-pending owner tries to accept", async () => {
    await contract.proposeOwnership(newOwner.address);
    await expect(contract.connect(randomUser).acceptOwnership())
      .to.be.revertedWith("NotPendingOwner");
  });

  it("should revert if accepting without proposal", async () => {
    await expect(contract.connect(newOwner).acceptOwnership())
      .to.be.revertedWith("NotPendingOwner");
  });

  it("should allow owner to change proposed owner", async () => {
    await contract.proposeOwnership(newOwner.address);
    await contract.proposeOwnership(anotherOwner.address);
    expect(await contract.pendingOwner()).to.equal(anotherOwner.address);
  });

  it("should prevent old owner from admin actions after transfer", async () => {
    await contract.proposeOwnership(newOwner.address);
    await contract.connect(newOwner).acceptOwnership();
    await expect(contract.connect(owner).adminFunction())
      .to.be.revertedWith("NotOwner");
  });
});
```

---

## Integration Testing

### Test Scenarios

1. **Happy Path**:
   - Owner proposes new owner
   - New owner accepts
   - New owner can perform admin functions
   - Old owner cannot perform admin functions

2. **Cancellation/Override**:
   - Owner proposes owner A
   - Before acceptance, owner proposes owner B
   - Owner B can accept (overrides A)
   - Owner A cannot accept

3. **Security Tests**:
   - Non-owner cannot propose
   - Non-pending-owner cannot accept
   - Zero address proposal reverts
   - Acceptance without proposal reverts

4. **Event Emission**:
   - `OwnershipProposed` emitted with correct parameters
   - `OwnershipTransferred` emitted on acceptance
   - `OwnershipTransferred(address(0), deployer)` in constructor

---

## Migration Guide for Existing Contracts

### For Contracts Already Deployed

**Option 1: Upgrade with New Functions (Recommended)**

Add new two-step functions alongside existing:

```solidity
// Keep old function for backward compatibility (deprecated)
/// @notice Deprecated: Use proposeOwnership + acceptOwnership instead
function transferOwnership(address newOwner) external onlyOwner {
    // Redirect to two-step pattern
    proposeOwnership(newOwner);
}

// Add new two-step functions
function proposeOwnership(address newOwner) external onlyOwner { ... }
function acceptOwnership() external { ... }
```

**Migration Steps**:
1. Deploy upgraded contract
2. Announce deprecation of `transferOwnership()`
3. Update documentation and integrations
4. Remove deprecated function in next major version

**Option 2: Breaking Change (Clean Slate)**

Remove old function entirely:
- Only for major version upgrades
- Requires all integrations to update
- Cleaner codebase

---

## Diamond OwnershipFacet Upgrade Plan

### Current Diamond Ownership

```solidity
// OwnershipFacet.sol
function transferOwnership(address _newOwner) external override {
    LibDiamond.enforceIsContractOwner();
    address _previousOwner = LibDiamond.contractOwner();
    LibDiamond.setContractOwner(_newOwner);
    emit Events.OwnershipTransferred(_previousOwner, _newOwner);
}
```

### Proposed Upgrade

**Step 1: Add to LibDiamond**

```solidity
// LibDiamond.sol
struct DiamondStorage {
    // ... existing fields
    address pendingOwner;  // ADD THIS
}

function setPendingOwner(address _pendingOwner) internal {
    DiamondStorage storage ds = diamondStorage();
    ds.pendingOwner = _pendingOwner;
}

function pendingOwner() internal view returns (address) {
    return diamondStorage().pendingOwner;
}
```

**Step 2: Update OwnershipFacet**

```solidity
// OwnershipFacet.sol
function proposeOwnership(address _newOwner) external {
    LibDiamond.enforceIsContractOwner();
    if (_newOwner == address(0)) revert Errors.InvalidAddress();
    LibDiamond.setPendingOwner(_newOwner);
    emit Events.OwnershipProposed(LibDiamond.contractOwner(), _newOwner);
}

function acceptOwnership() external {
    if (msg.sender != LibDiamond.pendingOwner()) {
        revert Errors.NotPendingOwner();
    }
    address previousOwner = LibDiamond.contractOwner();
    LibDiamond.setContractOwner(msg.sender);
    LibDiamond.setPendingOwner(address(0));
    emit Events.OwnershipTransferred(previousOwner, msg.sender);
}

function pendingOwner() external view returns (address) {
    return LibDiamond.pendingOwner();
}

// Keep for backward compatibility (deprecated)
function transferOwnership(address _newOwner) external override {
    proposeOwnership(_newOwner);
}
```

**Step 3: Add Events to Events.sol**

```solidity
// Events.sol
event OwnershipProposed(address indexed currentOwner, address indexed proposedOwner);
// OwnershipTransferred already exists
```

**Step 4: Add Error to Errors.sol**

```solidity
// Errors.sol
error NotPendingOwner();
// Already added
```

---

## Benefits Summary

### Security
- ✅ Prevents typo-induced ownership loss
- ✅ Requires explicit confirmation from new owner
- ✅ New owner proves they control the address

### User Experience
- ✅ Two clear steps: propose → accept
- ✅ Clear event trail for off-chain monitoring
- ✅ Can override proposal before acceptance

### Industry Standard
- ✅ Matches OpenZeppelin's Ownable2Step
- ✅ Used by major protocols (Uniswap, Aave)
- ✅ Auditor-recommended pattern

---

## Implementation Priority

### Immediate (Already Done)
- ✅ `BlockScholesOracleAdapter` - Implemented

### High Priority (Next Sprint)
- 🔴 **Diamond OwnershipFacet** - Critical for protocol safety
- 🟡 Review `MockOracleAdapter` - Determine if needed

### Medium Priority (Future Enhancement)
- 🟢 Any new standalone oracle adapters
- 🟢 Any future utility contracts with ownership

---

## Related References

- **OpenZeppelin Ownable2Step**: https://docs.openzeppelin.com/contracts/api/access#Ownable2Step
- **EIP-173 (Ownership Standard)**: https://eips.ethereum.org/EIPS/eip-173
- **Diamond Pattern (EIP-2535)**: https://eips.ethereum.org/EIPS/eip-2535
- **Security Best Practices**: https://consensys.github.io/smart-contract-best-practices/

---

## Decision Record

**Date**: November 27, 2025  
**Decision**: Two-step pattern implemented for `BlockScholesOracleAdapter`, documented for future contracts  
**Rationale**: 
- `BlockScholesOracleAdapter` is standalone and needs secure ownership transfer
- Diamond facets use centralized `OwnershipFacet` (one place to upgrade later)
- Pattern should be applied to Diamond in future security enhancement sprint

**Next Actions**:
- [ ] Review MockOracleAdapter ownership needs
- [ ] Create ticket for Diamond OwnershipFacet upgrade
- [ ] Add two-step pattern to new contract templates
- [ ] Update security documentation

**Approved By**: [To be filled]  
**Review Date**: [To be scheduled for next security review]

---

**Document Version**: 1.0  
**Last Updated**: November 27, 2025  
**Author**: GitHub Copilot (AI Assistant)  
**Purpose**: Guide implementation of two-step ownership pattern for enhanced security
