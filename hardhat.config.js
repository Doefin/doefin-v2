/* global ethers task */
require("@nomiclabs/hardhat-waffle");
require("@nomicfoundation/hardhat-verify");
require("solidity-coverage");
require("hardhat-contract-sizer");
require("hardhat-gas-reporter");
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
        // SCRUM-231 (GAS-001): tuned for the constantly-called settlement hot path
        // rather than one-shot deploy size. All facets retain ample 24 KiB headroom.
        runs: 200,
      },
      viaIR: true, // Enable IR-based code generator to avoid "stack too deep" errors
      metadata: {
        bytecodeHash: "none" // Remove metadata hash to save bytecode space
      },
      // Emit `storageLayout` alongside Hardhat's default outputs so the
      // storage-layout snapshot test (ARCH-05 / SCRUM-229) can read every
      // struct's slot/offset back from build-info. The other selections are
      // Hardhat's defaults, restated so adding `storageLayout` cannot drop them.
      outputSelection: {
        "*": {
          "*": [
            "abi",
            "evm.bytecode",
            "evm.deployedBytecode",
            "evm.methodIdentifiers",
            "metadata",
            "storageLayout",
          ],
          "": ["ast"],
        },
      },
    },
  },
  contractSizer: {
    alphaSort: true,
    runOnCompile: true,
    disambiguatePaths: false,
  },
  gasReporter: {
    // Enabled only when REPORT_GAS=true (npm run audit:gas).
    enabled: process.env.REPORT_GAS === "true",
    // Base is an OP-stack L2 — report L1 calldata cost alongside L2 execution.
    L2: "base",
    offline: true, // no price API calls — report gas units, deterministic
    outputFile: "audit/output/gas/gas-report.txt",
    reportFormat: "markdown",
    noColors: true,
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
    // url/accounts fall back to safe defaults so `hardhat compile` works
    // without a .env (e.g. inside the audit container). Deploying to these
    // networks still requires the real env vars.
    arbitrumSepolia: {
      url: process.env.SEPOLIA_RPC_URL || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 421614,
    },
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_ENDPOINT || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 84532,
    },
    base: {
      url: process.env.BASE_MAINNET_RPC_ENDPOINT || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 8453,
    },
    arbitrumOne: {
      url: process.env.ARBITRUM_MAINNET_RPC_URL || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
    customChains: [
      {
        network: "baseSepolia",
        chainId: 84532,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api?chainid=84532",
          browserURL: "https://sepolia.basescan.org",
        },
      },
      {
        network: "base",
        chainId: 8453,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api?chainid=8453",
          browserURL: "https://basescan.org",
        },
      },
    ],
  },
};
