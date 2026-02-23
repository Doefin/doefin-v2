# Contributing to Doefin V2

We welcome contributions to Doefin V2! This document provides guidelines for contributing to the project.

## 🚀 Getting Started

### Prerequisites

- Node.js 16.0.0 or later
- Git
- Basic knowledge of Solidity and smart contract development
- Understanding of the Diamond Standard (EIP-2535)

### Development Setup

1. **Fork the Repository**
   ```bash
   # Fork on GitHub, then clone your fork
   git clone https://github.com/YOUR_USERNAME/doefin-v2.git
   cd doefin-v2
   ```

2. **Install Dependencies**
   ```bash
   npm install
   ```

3. **Set Up Environment**
   ```bash
   cp .env.example .env
   # Edit .env with your local configuration
   ```

4. **Run Tests**
   ```bash
   npm test
   ```

## 📋 Development Guidelines

### Branch Strategy

- `main` - Production-ready code
- `dev` - Integration branch for new features
- `feature/feature-name` - Feature development branches
- `fix/issue-description` - Bug fix branches

### Workflow

1. **Create Feature Branch**
   ```bash
   git checkout dev
   git pull origin dev
   git checkout -b feature/your-feature-name
   ```

2. **Develop & Test**
   - Write code following our style guidelines
   - Add comprehensive unit tests
   - Ensure all tests pass
   - Maintain or increase test coverage

3. **Commit Changes**
   ```bash
   # Use conventional commit format
   git add .
   git commit -m "feat: add new oracle adapter functionality"
   ```

4. **Submit Pull Request**
   - Push branch to your fork
   - Create PR against `dev` branch
   - Fill out PR template completely
   - Request review from maintainers

### Commit Message Format

We use [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
type(scope): description

[optional body]

[optional footer]
```

**Types:**
- `feat`: New features
- `fix`: Bug fixes
- `docs`: Documentation changes
- `style`: Code style changes (no logic changes)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

**Examples:**
```bash
feat(oracle): add difficulty range question type
fix(matching): resolve partial fill calculation error
docs(readme): update deployment instructions
test(settlement): add edge case tests for cross-currency
```

## 🧪 Testing Requirements

### Test Coverage

- All new features must include comprehensive tests
- Minimum 90% line coverage required
- Test both success and failure scenarios
- Include edge cases and boundary conditions

### Test Categories

1. **Unit Tests** (`test/unit/`)
   - Test individual functions and contracts
   - Mock external dependencies
   - Fast execution

2. **Integration Tests** (`test/integration/`)
   - Test interactions between contracts
   - End-to-end workflow testing
   - Real-world scenario simulation

3. **Oracle Tests** (`test/oracle/`)
   - Bitcoin header validation
   - Settlement mechanism testing
   - Edge case scenarios

### Running Tests

```bash
# All tests
npm test

# Specific categories
npm run test:unit
npm run test:integration

# With coverage
npm run test:coverage

# Gas reporting
npm run gas-report
```

## 🎨 Code Style

### Solidity Style

Follow the [Solidity Style Guide](https://docs.soliditylang.org/en/v0.8.20/style-guide.html) with these additions:

1. **Naming Conventions**
   ```solidity
   // Contracts: PascalCase
   contract MarketExecutionFacet

   // Functions: camelCase
   function createOrder()

   // Variables: camelCase
   uint256 orderCount

   // Constants: UPPER_SNAKE_CASE
   uint256 constant MAX_ORDERS = 1000

   // Events: PascalCase
   event OrderCreated()
   ```

2. **Documentation**
   - Use NatSpec for all public functions
   - Include @param and @return descriptions
   - Document complex logic with inline comments

3. **Structure**
   ```solidity
   // SPDX-License-Identifier: AGPL-3.0
   pragma solidity ^0.8.6;

   // Imports
   import {...}

   // Contracts
   contract ExampleFacet {
       // Events
       // Modifiers
       // Functions (external, public, internal, private)
   }
   ```

### JavaScript/TypeScript Style

- Use ESLint configuration provided
- 2-space indentation
- Single quotes for strings
- Trailing commas where appropriate

### Documentation

- Update relevant documentation for changes
- Include examples for new features
- Keep README current with new functionality

## 🔒 Security Guidelines

### Security Reviews

- All changes affecting core logic require security review
- Consider economic implications of changes
- Test against common attack vectors

### Common Vulnerabilities

Be aware of and test for:
- Reentrancy attacks
- Integer overflow/underflow
- Front-running vulnerabilities
- Oracle manipulation
- Access control bypasses

### Security Checklist

- [ ] All external calls properly protected
- [ ] State changes follow checks-effects-interactions pattern
- [ ] Access control properly implemented
- [ ] Integer arithmetic safe
- [ ] Gas optimization doesn't compromise security

## 📝 Pull Request Guidelines

### PR Template

When creating a PR, please include:

1. **Description**: Clear description of changes
2. **Type**: Feature, fix, documentation, etc.
3. **Testing**: Description of testing performed
4. **Breaking Changes**: Any breaking changes
5. **Checklist**: Complete the provided checklist

### Review Process

1. **Automated Checks**
   - All tests must pass
   - Code coverage requirements met
   - Linting passes

2. **Manual Review**
   - Code quality and style
   - Security considerations
   - Documentation completeness

3. **Approval**
   - At least one maintainer approval required
   - All feedback addressed

## 🐛 Reporting Issues

### Bug Reports

When reporting bugs, please include:

1. **Environment**: Network, versions, configuration
2. **Steps to Reproduce**: Clear steps to reproduce issue
3. **Expected Behavior**: What should happen
4. **Actual Behavior**: What actually happens
5. **Additional Context**: Logs, screenshots, etc.

### Feature Requests

For feature requests, please include:

1. **Problem Statement**: What problem does this solve?
2. **Proposed Solution**: How should it work?
3. **Alternatives**: Other solutions considered
4. **Additional Context**: Examples, mockups, etc.

## 💬 Communication

- **Issues**: Use GitHub Issues for bugs and features
- **Discussions**: Use GitHub Discussions for questions
- **Discord**: Join our Discord for real-time chat
- **Code Review**: Use GitHub PR comments

## 🏆 Recognition

Contributors will be:
- Listed in project contributors
- Acknowledged in release notes
- Invited to contributor Discord channels

## 📄 License

By contributing to Doefin V2, you agree that your contributions will be licensed under the AGPL-3.0 license.

---

Thank you for contributing to Doefin V2! 🙏