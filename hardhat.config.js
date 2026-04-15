/* global ethers task */
require("@nomiclabs/hardhat-waffle");
require("@nomicfoundation/hardhat-verify");
require("solidity-coverage");
require("hardhat-contract-sizer");
require("dotenv").config();

const allowUnlimitedContractSizeForTests =
  process.env.ALLOW_UNLIMITED_CONTRACT_SIZE === "true";

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
        runs: 1, // Production-standard optimization for balanced gas efficiency and bytecode size
      },
      viaIR: true, // Enable IR-based code generator to avoid "stack too deep" errors
      metadata: {
        bytecodeHash: "none" // Remove metadata hash to save bytecode space
      }
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
      // Default false to keep main build size checks; set env ALLOW_UNLIMITED_CONTRACT_SIZE=true for test runs
      allowUnlimitedContractSize: allowUnlimitedContractSizeForTests,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
    arbitrumSepolia: {
      url: process.env.SEPOLIA_RPC_URL,
      accounts: [process.env.PRIVATE_KEY],
      chainId: 421614,
    },
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_ENDPOINT,
      accounts: [process.env.PRIVATE_KEY],
      chainId: 84532,
    },
    arbitrumOne: {
      url: process.env.ARBITRUM_MAINNET_RPC_URL,
      accounts: [process.env.PRIVATE_KEY],
    },
  },
  etherscan: {
    apiKey: {
      mainnet: process.env.ETHERSCAN_API_KEY || "",
      arbitrumOne: process.env.ARBISCAN_API_KEY || "",
      arbitrumSepolia: process.env.ARBISCAN_API_KEY || "",
      baseSepolia: process.env.BASESCAN_API_KEY || "",
    },
    customChains: [
      {
        network: "baseSepolia",
        chainId: 84532,
        urls: {
          apiURL: "https://api-sepolia.basescan.org/api",
          browserURL: "https://sepolia.basescan.org",
        },
      },
    ],
  },
};
