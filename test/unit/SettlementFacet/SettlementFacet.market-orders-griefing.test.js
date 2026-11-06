// SettlementFacet — wallet griefing against a market taker's settlement (SCRUM-559)
// ============================================================================
// Every row is an action a maker's wallet can take between the match engine's
// simulation and the transaction landing. A single bad leg fails the whole bundle,
// so what matters is what each action looks like to the operator: a raw `eth_call`
// (what the engine simulates) and a real transaction (what lands).
//
// Those two disagree on purpose for the wallets that only misbehave when
// `tx.gasprice != 0`. A wallet with its fallback handler removed reverts with empty
// data, which ethers v5 `callStatic` reports as success on a function with no return
// value, so `callStatic` must never be used to check these.

const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const {
  setupSafeSettlement,
  SAFE,
  safeInterface,
  ZERO_ADDRESS,
  BUY,
  SELL,
  EMPTY_REVERT,
  pad,
  snapshotted,
} = require("../../utils/safeSettlementFixture.js");

/// keccak256 of the Safe 1.4.1 proxy's runtime code: what a real user's wallet looks like on-chain.
const SAFE_PROXY_CODE_HASH = "0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c";

describe("SettlementFacet — wallet griefing against a market taker", function () {
  this.timeout(0);

  let ctx, T, TS, G, H;
  let W, F;

  const mint = (maker) => ({ maker, kind: "Mint", price: 600000n, fill: F });
  const compBuy = (maker) => ({ maker, kind: "Complementary", price: 400000n, fill: F });
  const compSell = (maker, price) => ({ maker, kind: "Complementary", price, fill: F });

  const tokenCall = (fn, args) => W.token.interface.encodeFunctionData(fn, args);
  const erc1155Call = (fn, args) => ctx.contracts.erc1155Facet.interface.encodeFunctionData(fn, args);
  const nonceCall = (fn, args) => ctx.contracts.nonceMgr.interface.encodeFunctionData(fn, args);
  const signerCall = (fn, args) => ctx.contracts.sigVerifier.interface.encodeFunctionData(fn, args);
  const safeCall = (fn, args) => safeInterface.encodeFunctionData(fn, args);

  // Any fee the chain will accept. Only `tx.gasprice != 0` matters, for the wallets that key off it.
  const liveTx = async () => {
    const { baseFeePerGas } = await ethers.provider.getBlock("latest");
    return { gasLimit: 3_000_000, maxFeePerGas: baseFeePerGas.mul(2).add(1_000_000), maxPriorityFeePerGas: 1_000_000 };
  };

  before(async function () {
    ctx = await setupSafeSettlement("market-order-griefing");
    const safes = await ctx.activeSafes(["T", "TS", "G", "H"]);
    [T, TS, G, H] = safes;
    W = await ctx.makeWorld(6, safes, "griefing");
    F = 1_000_000n;
  });

  describe("every wallet action, on matchOrders with a market taker", function () {
    const ROWS = [
      { label: "control: no wallet change", setup: async () => {}, legs: () => [mint(G)], call: "OK", tx: "OK" },
      {
        label: "revokes the ERC-20 allowance",
        setup: () => ctx.exec(G, W.token.address, tokenCall("approve", [ctx.diamond, 0])),
        legs: () => [mint(G)],
        call: "ERC20InsufficientAllowance",
        tx: "ERC20InsufficientAllowance",
      },
      {
        label: "spends the ERC-20",
        setup: async () =>
          ctx.exec(G, W.token.address, tokenCall("transfer", [ctx.signers.outsider.address, await W.token.balanceOf(G.address)])),
        legs: () => [mint(G)],
        call: "ERC20InsufficientBalance",
        tx: "ERC20InsufficientBalance",
      },
      {
        label: "revokes the ERC-1155 approval",
        setup: () => ctx.exec(G, ctx.diamond, erc1155Call("setApprovalForAll", [ctx.diamond, false])),
        legs: () => [compBuy(G)],
        call: "NotOwnerNorApproved",
        tx: "NotOwnerNorApproved",
      },
      {
        label: "moves the position tokens away",
        setup: async () =>
          ctx.exec(
            G,
            ctx.diamond,
            erc1155Call("safeTransferFrom", [
              G.address,
              ctx.signers.outsider.address,
              W.posA,
              await ctx.contracts.erc1155Facet.balanceOf(G.address, W.posA),
              "0x",
            ]),
          ),
        legs: () => [compBuy(G)],
        call: "Panic(0x11)",
        tx: "Panic(0x11)",
      },
      {
        label: "removes the fallback handler",
        setup: () => ctx.exec(G, G.address, safeCall("setFallbackHandler", [ZERO_ADDRESS])),
        legs: () => [mint(G)],
        call: EMPTY_REVERT,
        tx: EMPTY_REVERT,
      },
      {
        label: "deregisters the signer",
        setup: () => ctx.exec(G, ctx.diamond, signerCall("registerOrderSigner", [G.wallet.address, false])),
        legs: () => [mint(G)],
        call: "InvalidOrderSignature",
        tx: "InvalidOrderSignature",
      },
      {
        label: "installs a handler that always reverts",
        setup: async () => {
          const handler = await hostileHandler(0);
          await ctx.exec(G, G.address, safeCall("setFallbackHandler", [handler.address]));
        },
        legs: () => [mint(G)],
        call: 'Error("hostile: always")',
        tx: 'Error("hostile: always")',
      },
      {
        label: "bumps its nonce",
        setup: () => ctx.exec(G, ctx.diamond, nonceCall("incrementNonce", [])),
        legs: () => [mint(G)],
        call: "OrderNonceInvalid",
        tx: "OrderNonceInvalid",
      },
      {
        label: "raises its salt floor",
        setup: () =>
          ctx.exec(G, ctx.diamond, nonceCall("cancelOrdersForPosition", [pad(W.posB), ethers.constants.MaxUint256.div(2)])),
        legs: () => [mint(G)],
        call: "OrderCancelled",
        tx: "OrderCancelled",
      },
      {
        // The seller's fee comes out of proceeds now, so this no longer griefs anything.
        label: "a seller with no ERC-20 allowance and a fee above 0",
        setup: () => ctx.exec(G, W.token.address, tokenCall("approve", [ctx.diamond, 0])),
        legs: () => [compBuy(G)],
        call: "OK",
        tx: "OK",
      },
    ];

    const hostileHandler = async (mode, token = ZERO_ADDRESS, spender = ZERO_ADDRESS, banned = ZERO_ADDRESS) =>
      (await ethers.getContractFactory("HostileHandler")).deploy(mode, token, spender, banned);

    for (const row of ROWS) {
      it(`${row.label}: eth_call ${row.call}, real transaction ${row.tx}`, async function () {
        await snapshotted(async () => {
          await row.setup();
          const a = await ctx.bundle(W, T, BUY, row.legs(), { market: true });

          expect((await ctx.simulate(a)).name).to.equal(row.call);
          expect((await ctx.send(a, await liveTx())).name).to.equal(row.tx);
        });
      });
    }

    it("a removed fallback handler reverts with data that is truly empty", async function () {
      await snapshotted(async () => {
        await ctx.exec(G, G.address, safeCall("setFallbackHandler", [ZERO_ADDRESS]));
        const a = await ctx.bundle(W, T, BUY, [mint(G)], { market: true });

        const r = await ctx.simulate(a);

        expect(r.ok).to.equal(false);
        expect(r.raw).to.equal("0x");
      });
    });

    it("a contract that is not a Safe passes eth_call and reverts on the real transaction", async function () {
      await snapshotted(async () => {
        const wallet = await ctx.ownerWallet("fake");
        const FakeSafe = await ethers.getContractFactory("FakeSafe");
        const fake = await FakeSafe.connect(wallet).deploy(SAFE.singleton.address, SAFE.handler.address, wallet.address);
        const fakeExec = (to, data) => fake.exec(to, data).then((tx) => tx.wait());

        await fakeExec(W.token.address, tokenCall("approve", [ctx.diamond, ethers.constants.MaxUint256]));
        await fakeExec(ctx.diamond, signerCall("registerOrderSigner", [wallet.address, true]));
        await fakeExec(ctx.diamond, erc1155Call("setApprovalForAll", [ctx.diamond, true]));
        await W.token.mint(fake.address, (1000n * W.unit).toString());
        const { owner } = ctx.signers;
        const { erc1155Facet } = ctx.contracts;
        await erc1155Facet.connect(owner).safeTransferFrom(owner.address, fake.address, W.posA, (10n * W.unit).toString(), "0x");
        await erc1155Facet.connect(owner).safeTransferFrom(owner.address, fake.address, W.posB, (10n * W.unit).toString(), "0x");
        await (await fake.arm(true)).wait();

        const fakeMaker = { tag: "fake", address: fake.address, wallet };
        const a = await ctx.bundle(W, T, BUY, [mint(fakeMaker), mint(H)], { market: true });

        expect((await ctx.simulate(a)).name).to.equal("OK");
        expect((await ctx.send(a, await liveTx())).name).to.equal('Error("fake safe: live tx")');

        // The real Safes in this suite all carry the canonical proxy code; the fake does not.
        expect(ethers.utils.keccak256(await ethers.provider.getCode(T.address))).to.equal(SAFE_PROXY_CODE_HASH);
        expect(ethers.utils.keccak256(await ethers.provider.getCode(fake.address))).to.not.equal(SAFE_PROXY_CODE_HASH);
      });
    });

    it("a maker that expires between the simulation and landing passes eth_call and reverts OrderCancelled", async function () {
      await snapshotted(async () => {
        const now = (await ethers.provider.getBlock("latest")).timestamp;
        const a = await ctx.bundle(W, T, BUY, [{ ...compBuy(G), overrides: { expiration: now + 20 } }], { market: true });

        expect((await ctx.simulate(a)).name).to.equal("OK");

        await network.provider.send("evm_increaseTime", [30]);
        expect((await ctx.send(a, await liveTx())).name).to.equal("OrderCancelled");
      });
    });

    it("one maker on two sell legs whose balance covers each but not the sum reverts Panic(0x11)", async function () {
      await snapshotted(async () => {
        const held = await ctx.contracts.erc1155Facet.balanceOf(G.address, W.posA);
        const leave = ethers.BigNumber.from(((F * 3n) / 2n).toString());
        await ctx.exec(
          G,
          ctx.diamond,
          erc1155Call("safeTransferFrom", [G.address, ctx.signers.outsider.address, W.posA, held.sub(leave), "0x"]),
        );

        const a = await ctx.bundle(W, T, BUY, [compBuy(G), compBuy(G)], { market: true });
        expect((await ctx.simulate(a)).name).to.equal("Panic(0x11)");

        const eachAlone = await ctx.bundle(W, T, BUY, [compBuy(G)], { market: true });
        expect((await ctx.simulate(eachAlone)).name).to.equal("OK");
      });
    });

    describe("other hostile wallet shapes", function () {
      it("a handler that returns the wrong selector reverts ERC1155ReceiverRejectedTokens", async function () {
        await snapshotted(async () => {
          const handler = await hostileHandler(1);
          await ctx.exec(G, G.address, safeCall("setFallbackHandler", [handler.address]));
          const a = await ctx.bundle(W, T, BUY, [mint(G)], { market: true });

          expect((await ctx.simulate(a)).name).to.equal("ERC1155ReceiverRejectedTokens");
          expect((await ctx.send(a, await liveTx())).name).to.equal("ERC1155ReceiverRejectedTokens");
        });
      });

      it("a handler that only refuses live transactions passes eth_call and reverts on the real transaction", async function () {
        await snapshotted(async () => {
          const handler = await hostileHandler(2);
          await ctx.exec(G, G.address, safeCall("setFallbackHandler", [handler.address]));
          const a = await ctx.bundle(W, T, BUY, [mint(G)], { market: true });

          expect((await ctx.simulate(a)).name).to.equal("OK");
          expect((await ctx.send(a, await liveTx())).name).to.equal('Error("hostile: live tx")');
        });
      });

      it("a handler that burns the gas it is given reverts with its own error inside a 5M cap", async function () {
        await snapshotted(async () => {
          const handler = await hostileHandler(3);
          await ctx.exec(G, G.address, safeCall("setFallbackHandler", [handler.address]));
          const a = await ctx.bundle(W, T, BUY, [mint(G)], { market: true });

          const r = await ctx.simulate(a, { gas: ethers.utils.hexValue(5_000_000) });
          expect(r.name).to.equal('Error("hostile: burnt")');
        });
      });

      it("a handler that revokes the allowance mid-bundle lets the first leg through and fails the second", async function () {
        await snapshotted(async () => {
          const handler = await hostileHandler(4, W.token.address, ctx.diamond);
          await ctx.exec(G, G.address, safeCall("enableModule", [handler.address]));
          await ctx.exec(G, G.address, safeCall("setFallbackHandler", [handler.address]));
          const firstLeg = compSell(G, 500000n);
          const secondLeg = compSell(G, 450000n);

          const both = await ctx.bundle(W, TS, SELL, [firstLeg, secondLeg], { market: true });
          expect((await ctx.simulate(both)).name).to.equal("ERC20InsufficientAllowance");

          const firstAlone = await ctx.bundle(W, TS, SELL, [firstLeg], { market: true });
          expect((await ctx.simulate(firstAlone)).name).to.equal("OK");
        });
      });

      it("a taker's own handler that bans one counterparty fails only the bundles with that counterparty", async function () {
        await snapshotted(async () => {
          const handler = await hostileHandler(5, ZERO_ADDRESS, ZERO_ADDRESS, H.address);
          await ctx.exec(T, T.address, safeCall("setFallbackHandler", [handler.address]));
          const banned = 'Error("hostile: banned counterparty")';

          const both = await ctx.bundle(W, T, BUY, [compBuy(G), compBuy(H)], { market: true });
          expect((await ctx.simulate(both)).name).to.equal(banned);

          const withH = await ctx.bundle(W, T, BUY, [compBuy(H)], { market: true });
          expect((await ctx.simulate(withH)).name).to.equal(banned);

          const withG = await ctx.bundle(W, T, BUY, [compBuy(G)], { market: true });
          expect((await ctx.simulate(withG)).name).to.equal("OK");
        });
      });

      it("a singleton swapped by delegatecall refuses the position tokens", async function () {
        await snapshotted(async () => {
          const singleton = await (await ethers.getContractFactory("HostileSingleton")).deploy();
          const writer = await (await ethers.getContractFactory("SlotZeroWriter")).deploy();
          await ctx.exec(G, writer.address, writer.interface.encodeFunctionData("set", [singleton.address]), 1);
          const a = await ctx.bundle(W, T, BUY, [mint(G)], { market: true });

          expect((await ctx.simulate(a)).name).to.equal('Error("hostile singleton")');
          expect((await ctx.send(a, await liveTx())).name).to.equal('Error("hostile singleton")');
        });
      });

      it("a guard that refuses every Safe transaction cannot touch settlement", async function () {
        await snapshotted(async () => {
          const guard = await (await ethers.getContractFactory("HostileGuard")).deploy();
          await ctx.exec(G, G.address, safeCall("setGuard", [guard.address]));
          const a = await ctx.bundle(W, T, BUY, [mint(G)], { market: true });

          expect((await ctx.simulate(a)).name).to.equal("OK");
          expect((await ctx.send(a, await liveTx())).name).to.equal("OK");
        });
      });
    });
  });
});
