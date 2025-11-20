/* global ethers task */
require("@nomiclabs/hardhat-waffle");
require("@nomicfoundation/hardhat-verify");
require("solidity-coverage");
require("hardhat-contract-sizer");
require("dotenv").config();

task("accounts", "Prints the list of accounts", async () => {
task("accounts", "Prints the list of accounts", async () => {
  const accounts = await ethers.getSigners();

  for (const account of accounts) {
    console.log(account.address);
  }
});

module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 1, // Minimal runs for smallest bytecode size
      },
      viaIR: true, // Enable IR-based code generator to avoid "stack too deep" errors
      metadata: {
        bytecodeHash: "none" // Remove metadata hash to save bytecode space
      }
    },
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true, // Enable IR-based code generator to avoid "stack too deep" errors
    },
  },
  contractSizer: {
    alphaSort: true,
    runOnCompile: true,
    disambiguatePaths: false,
  },
  networks: {
    hardhat: {
      blockGasLimit: 50000000, // Increase from default 30M for large contracts
      allowUnlimitedContractSize: true // Allow contracts larger than 24KB for testing
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
      chainId: 31337,
    },
    arbitrumSepolia: {
      url: process.env.SEPOLIA_RPC_URL,
      accounts: [process.env.PRIVATE_KEY],
      chainId: 421614,
    },
    arbitrumOne: {
      url: process.env.ARBITRUM_MAINNET_RPC_URL,
      accounts: [process.env.PRIVATE_KEY],
    },
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY,
  },
};
