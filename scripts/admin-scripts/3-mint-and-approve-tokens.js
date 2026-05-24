const { ethers } = require("hardhat");
require("dotenv").config();

async function mintAndApprove({ tokenAddress, diamond, deployer, recipient, mintAmountOverride }) {
    const token = await ethers.getContractAt("MockERC20", tokenAddress);
    const symbol = await token.symbol();
    const decimals = await token.decimals();

    console.log(`\n── ${symbol} (${decimals} dec) at ${tokenAddress}`);

    // Mint
    const defaultMint = symbol === "mWBTC"
        ? ethers.utils.parseUnits("10000", decimals)   // 10 K mWBTC
        : ethers.utils.parseUnits("10000000", decimals); // 10 M mUSDT

    const mintAmount = mintAmountOverride
        ? ethers.utils.parseUnits(mintAmountOverride, decimals)
        : defaultMint;

    const balanceBefore = await token.balanceOf(recipient);
    console.log(`   Balance before: ${ethers.utils.formatUnits(balanceBefore, decimals)} ${symbol}`);

    const mintTx = await token.mint(recipient, mintAmount, { gasLimit: 150000 });
    await mintTx.wait();
    const balanceAfter = await token.balanceOf(recipient);
    console.log(`   Minted ${ethers.utils.formatUnits(mintAmount, decimals)} → balance: ${ethers.utils.formatUnits(balanceAfter, decimals)} ${symbol}`);

    // Approve (only when recipient == deployer — can't approve on behalf of another address)
    if (recipient.toLowerCase() !== deployer.address.toLowerCase()) {
        console.log(`   ⏭️  Skipping approval (recipient ≠ deployer)`);
        return;
    }

    const approveTx = await token.approve(diamond, balanceAfter, { gasLimit: 100000 });
    await approveTx.wait();
    const allowance = await token.allowance(deployer.address, diamond);
    console.log(`   Approved ${ethers.utils.formatUnits(allowance, decimals)} ${symbol} to Diamond`);
}

async function main() {
    console.log("🚀 Minting and approving mock tokens...");

    const [deployer] = await ethers.getSigners();
    console.log("📝 Account:", deployer.address);
    console.log("💰 Balance:", ethers.utils.formatEther(await deployer.getBalance()), "ETH");

    const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS;
    const MWBTC_ADDRESS = process.env.MWBTC_TOKEN_ADDRESS;
    const MUSDT_ADDRESS = process.env.MUSDT_TOKEN_ADDRESS;
    const RECIPIENT = process.env.MINT_RECIPIENT || deployer.address;
    const MINT_AMOUNT = process.env.MINT_AMOUNT; // optional override (same for both tokens)

    if (!DIAMOND_ADDRESS) throw new Error("❌ DIAMOND_ADDRESS not set");
    if (!MWBTC_ADDRESS && !MUSDT_ADDRESS) throw new Error("❌ Set MWBTC_TOKEN_ADDRESS and/or MUSDT_TOKEN_ADDRESS in .env");

    console.log("💎 Diamond:", DIAMOND_ADDRESS);
    console.log("🎯 Recipient:", RECIPIENT);

    if (MWBTC_ADDRESS) {
        await mintAndApprove({
            tokenAddress: MWBTC_ADDRESS,
            diamond: DIAMOND_ADDRESS,
            deployer,
            recipient: RECIPIENT,
            mintAmountOverride: MINT_AMOUNT,
        });
    }

    if (MUSDT_ADDRESS) {
        await mintAndApprove({
            tokenAddress: MUSDT_ADDRESS,
            diamond: DIAMOND_ADDRESS,
            deployer,
            recipient: RECIPIENT,
            mintAmountOverride: MINT_AMOUNT,
        });
    }

    console.log("\n🎉 Done!");
}

main()
    .then(() => process.exit(0))
    .catch((err) => { console.error("❌", err); process.exit(1); });
