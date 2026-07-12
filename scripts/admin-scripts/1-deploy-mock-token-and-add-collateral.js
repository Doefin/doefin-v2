const { ethers } = require("hardhat");
require("dotenv").config();

async function deployOrAttach(name, symbol, decimals, existingAddress, provider) {
    if (existingAddress) {
        try {
            const token = await ethers.getContractAt("MockERC20", existingAddress);
            const onChainSymbol = await token.symbol();
            const onChainDecimals = await token.decimals();
            console.log(`   ✅ Reusing ${onChainSymbol} (${onChainDecimals} dec) at ${existingAddress}`);
            return { token, address: existingAddress, deployed: false };
        } catch {
            console.log(`   ⚠️  Could not connect to ${existingAddress}, deploying new ${symbol}`);
        }
    }

    console.log(`   Deploying ${name} (${symbol}, ${decimals} decimals)...`);
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy(name, symbol, decimals);
    await token.deployed();
    await token.deployTransaction.wait(2);
    console.log(`   ✅ ${symbol} deployed at ${token.address}`);
    return { token, address: token.address, deployed: true };
}

async function registerCollateral(diamond, tokenAddress, decimals, symbol) {
    let isAlready = false;
    try {
        isAlready = await diamond.isAllowedCollateral(tokenAddress);
    } catch {}

    if (isAlready) {
        console.log(`   ✅ ${symbol} already registered as collateral`);
        return;
    }

    const unitPerPair = ethers.utils.parseUnits("1", decimals);
    const tx = await diamond.addCollateralToken(tokenAddress, unitPerPair, { gasLimit: 500000 });
    await tx.wait();
    console.log(`   ✅ ${symbol} registered as collateral (unit: 1e${decimals})`);
}

async function main() {
    console.log("🚀 Deploying mock tokens and registering as collateral...");

    const [deployer] = await ethers.getSigners();
    console.log("📝 Account:", deployer.address);
    console.log("💰 Balance:", ethers.utils.formatEther(await deployer.getBalance()), "ETH");

    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS;
    if (!DIAMOND_ADDRESS) throw new Error("❌ DIAMOND_ADDRESS not set in .env");
    console.log("💎 Diamond:", DIAMOND_ADDRESS);

    // ── Deploy tokens ────────────────────────────────────────────────────────
    console.log("\n1️⃣  mWBTC (8 decimals)");
    const { token: wbtc, address: wbtcAddress, deployed: wbtcNew } =
        await deployOrAttach("Mock Wrapped Bitcoin", "mWBTC", 8, process.env.MWBTC_TOKEN_ADDRESS);

    console.log("\n2️⃣  mUSDT (6 decimals)");
    const { token: usdt, address: usdtAddress, deployed: usdtNew } =
        await deployOrAttach("Mock Tether USD", "mUSDT", 6, process.env.MUSDT_TOKEN_ADDRESS);

    // ── Mint initial supply to deployer ──────────────────────────────────────
    if (wbtcNew) {
        const supply = ethers.utils.parseUnits("1000000", 8); // 1 M mWBTC
        await (await wbtc.mint(deployer.address, supply)).wait();
        console.log("\n   Minted 1,000,000 mWBTC to deployer");
    }
    if (usdtNew) {
        const supply = ethers.utils.parseUnits("1000000000", 6); // 1 B mUSDT
        await (await usdt.mint(deployer.address, supply)).wait();
        console.log("   Minted 1,000,000,000 mUSDT to deployer");
    }

    // ── Register both as collateral ──────────────────────────────────────────
    console.log("\n3️⃣  Registering collateral tokens...");
    const AdminConfigFacet = await ethers.getContractFactory("AdminConfigFacet");
    const diamond = AdminConfigFacet.attach(DIAMOND_ADDRESS);

    await registerCollateral(diamond, wbtcAddress, 8, "mWBTC");
    await registerCollateral(diamond, usdtAddress, 6, "mUSDT");

    // ── Summary ──────────────────────────────────────────────────────────────
    console.log("\n🎉 Done!");
    console.log("\n📋 Add to .env:");
    console.log(`MWBTC_TOKEN_ADDRESS=${wbtcAddress}`);
    console.log(`MUSDT_TOKEN_ADDRESS=${usdtAddress}`);
    console.log(`COLLATERAL_TOKEN_ADDRESS=${wbtcAddress}   # backward-compat alias → mWBTC`);

    console.log("\n🔄 Next: run script 2 (add market maker), then script 3 (mint & approve)");
}

main()
    .then(() => process.exit(0))
    .catch((err) => { console.error("❌", err); process.exit(1); });
