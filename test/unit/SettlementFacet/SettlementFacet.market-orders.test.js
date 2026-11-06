// SettlementFacet — market orders (SCRUM-559)
// ============================================================================
// A taker whose signed salt has the marker in bits 32..63 is a market order:
// it skips the per-fill crossing check, and `matchOrders` enforces its signed
// price as the exact all-in average after the legs. Limit takers keep today's
// per-fill check. A market order can never be a maker or go through `fillOrder`.
//
// Every order here is signature type 1 from a real Safe 1.4.1 with a registered
// signer (see `test/utils/safeSettlementFixture.js`). Reverts are checked with a
// raw `eth_call` or a real transaction, never `callStatic`.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  setupSafeSettlement,
  BUY,
  SELL,
  MAX_FEE_RATE_BPS,
  toBigInt,
  snapshotted,
  namedHash,
  rng,
} = require("../../utils/safeSettlementFixture.js");

describe("SettlementFacet — market orders", function () {
  this.timeout(0);

  let ctx, safes, T, TS, G, H, K;

  before(async function () {
    ctx = await setupSafeSettlement("market-orders");
    safes = await ctx.activeSafes(["T", "TS", "G", "H", "K"]);
    [T, TS, G, H, K] = safes;
  });

  describe("entry points", function () {
    let w, U, F;

    before(async function () {
      w = await ctx.makeWorld(6, safes, "entry");
      U = w.unit;
      F = U;
    });

    // Prices that cross for a limit taker and stay inside the signed price for a market taker.
    const PATHS = [
      { label: "Complementary buy", side: BUY, taker: () => T, kind: "Complementary", makerPrice: 400000n, takerPrice: 500000n },
      { label: "Complementary sell", side: SELL, taker: () => TS, kind: "Complementary", makerPrice: 500000n, takerPrice: 400000n },
      { label: "Mint", side: BUY, taker: () => T, kind: "Mint", makerPrice: 600000n, takerPrice: 500000n },
      { label: "Merge", side: SELL, taker: () => TS, kind: "Merge", makerPrice: 400000n, takerPrice: 500000n },
    ];

    const makerSideOf = (path) => (path.kind === "Complementary" ? (path.side === BUY ? SELL : BUY) : path.side);
    const makerPositionOf = (path) => (path.kind === "Complementary" ? w.posA : w.posB);

    for (const path of PATHS) {
      for (const takerIsMarket of [false, true]) {
        const takerLabel = takerIsMarket ? "market" : "limit";

        it(`${path.label}: ${takerLabel} taker against a limit maker settles`, async function () {
          await snapshotted(async () => {
            const tk = path.taker();
            const a = await ctx.bundle(
              w,
              tk,
              path.side,
              [{ maker: G, kind: path.kind, price: path.makerPrice, fill: F, noFee: true }],
              { market: takerIsMarket, price: path.takerPrice },
            );
            const before = await ctx.balance(w, tk.address);

            expect((await ctx.send(a)).name).to.equal("OK");

            const moved = (await ctx.balance(w, tk.address)) - before;
            expect(path.side === BUY ? -moved : moved).to.equal(a.cash);
          });
        });

        it(`${path.label}: ${takerLabel} taker against a market maker reverts OrderCancelled naming the maker`, async function () {
          await snapshotted(async () => {
            const maker = ctx.order(w, G, makerPositionOf(path), makerSideOf(path), F, path.makerPrice, {
              salt: ctx.marketSalt().toString(),
            });
            const makerHash = await ctx.contracts.sigVerifier.getOrderHash(maker);
            const a = await ctx.bundle(
              w,
              path.taker(),
              path.side,
              [{ maker: G, kind: path.kind, price: path.makerPrice, fill: F, order: maker, noFee: true }],
              { market: takerIsMarket, price: path.takerPrice },
            );

            const r = await ctx.simulate(a);

            expect(r.name).to.equal("OrderCancelled");
            expect(namedHash(r)).to.equal(makerHash);
          });
        });
      }
    }

    describe("fillOrder", function () {
      // The operator is the counterparty: it needs collateral and position inventory.
      const withOperatorInventory = (fn) =>
        snapshotted(async () => {
          const { operator, owner } = ctx.signers;
          const { erc1155Facet } = ctx.contracts;
          await w.token.mint(operator.address, (100n * U).toString());
          await w.token.connect(operator).approve(ctx.diamond, ethers.constants.MaxUint256);
          await erc1155Facet.connect(owner).safeTransferFrom(owner.address, operator.address, w.posA, (100n * U).toString(), "0x");
          await erc1155Facet.connect(operator).setApprovalForAll(ctx.diamond, true);
          await fn();
        });

      for (const [label, side] of [["buy", BUY], ["sell", SELL]]) {
        it(`a limit ${label} fills`, async function () {
          await withOperatorInventory(async () => {
            const o = ctx.order(w, G, w.posA, side, F, 400000n);
            const sig = await ctx.signOrder(G, o);

            expect((await ctx.simulateFill(o, sig, F, 4000n)).name).to.equal("OK");
            expect((await ctx.sendFill(o, sig, F, 4000n)).name).to.equal("OK");
          });
        });

        it(`a market ${label} reverts OrderCancelled naming the order`, async function () {
          await withOperatorInventory(async () => {
            const o = ctx.order(w, G, w.posA, side, F, 400000n, { salt: ctx.marketSalt().toString() });
            const hash = await ctx.contracts.sigVerifier.getOrderHash(o);
            const sig = await ctx.signOrder(G, o);

            const r = await ctx.simulateFill(o, sig, F, 4000n);

            expect(r.name).to.equal("OrderCancelled");
            expect(namedHash(r)).to.equal(hash);
            expect((await ctx.sendFill(o, sig, F, 4000n)).name).to.equal("OrderCancelled");
            expect(toBigInt(await ctx.contracts.settlement.getFilledAmount(hash))).to.equal(0n);
          });
        });
      }
    });

    it("a market maker is refused before its signature is looked at; a limit maker is not", async function () {
      await snapshotted(async () => {
        const garbage = "0x" + "11".repeat(65);
        const marketMaker = ctx.order(w, G, w.posA, SELL, F, 400000n, { salt: ctx.marketSalt().toString() });
        const limitMaker = ctx.order(w, G, w.posA, SELL, F, 400000n);
        const leg = (order) => ({ maker: G, kind: "Complementary", price: 400000n, fill: F, order, sig: garbage, noFee: true });

        const refused = await ctx.simulate(await ctx.bundle(w, T, BUY, [leg(marketMaker)], { price: 500000n }));
        const badSignature = await ctx.simulate(await ctx.bundle(w, T, BUY, [leg(limitMaker)], { price: 500000n }));

        expect(refused.name).to.equal("OrderCancelled");
        expect(badSignature.name).to.equal("InvalidOrderSignature");
      });
    });

    it("a bundle with one market maker names that leg, and the honest legs settle without it", async function () {
      await snapshotted(async () => {
        // What the match engine does: simulate, drop the leg the revert names, simulate again, send.
        const bad = ctx.order(w, H, w.posA, SELL, F, 400000n, { salt: ctx.marketSalt().toString() });
        const badHash = await ctx.contracts.sigVerifier.getOrderHash(bad);
        const legs = [
          { maker: G, kind: "Complementary", price: 400000n, fill: F, noFee: true },
          { maker: H, kind: "Complementary", price: 400000n, fill: F, order: bad, noFee: true },
          { maker: K, kind: "Complementary", price: 400000n, fill: F, noFee: true },
        ];

        const named = await ctx.simulate(await ctx.bundle(w, T, BUY, legs, { price: 500000n, amount: 3n * F }));

        expect(named.name).to.equal("OrderCancelled");
        expect(namedHash(named)).to.equal(badHash);

        const honest = await ctx.bundle(w, T, BUY, [legs[0], legs[2]], { price: 500000n, amount: 3n * F });
        expect((await ctx.send(honest)).name).to.equal("OK");
      });
    });

    describe("far legs and the per-fill check", function () {
      const FAR_LEGS = [
        {
          label: "buy 0.99 + 0.01",
          side: BUY,
          taker: () => T,
          legs: () => [
            { maker: G, kind: "Complementary", price: (99n * U) / 100n, fill: F, noFee: true },
            { maker: H, kind: "Complementary", price: U / 100n, fill: F, noFee: true },
          ],
        },
        {
          label: "buy Mint legs averaging 0.50",
          side: BUY,
          taker: () => T,
          legs: () => [
            { maker: G, kind: "Mint", price: U / 100n, fill: F, noFee: true },
            { maker: H, kind: "Mint", price: (99n * U) / 100n, fill: F, noFee: true },
          ],
        },
        {
          label: "sell 0.99 + 0.01",
          side: SELL,
          taker: () => TS,
          legs: () => [
            { maker: G, kind: "Complementary", price: U / 100n, fill: F, noFee: true },
            { maker: H, kind: "Complementary", price: (99n * U) / 100n, fill: F, noFee: true },
          ],
        },
        {
          label: "sell Merge legs averaging 0.50",
          side: SELL,
          taker: () => TS,
          legs: () => [
            { maker: G, kind: "Merge", price: (99n * U) / 100n, fill: F, noFee: true },
            { maker: H, kind: "Merge", price: U / 100n, fill: F, noFee: true },
          ],
        },
      ];

      for (const row of FAR_LEGS) {
        it(`${row.label}: a limit taker reverts InvalidMatch; a market taker settles at the average`, async function () {
          await snapshotted(async () => {
            const tk = row.taker();
            const limit = await ctx.simulate(await ctx.bundle(w, tk, row.side, row.legs(), { price: U / 2n }));
            expect(limit.name).to.equal("InvalidMatch");

            await snapshotted(async () => {
              const a = await ctx.bundle(w, tk, row.side, row.legs(), { market: true, price: U / 2n });
              const before = await ctx.balance(w, tk.address);

              expect((await ctx.send(a)).name).to.equal("OK");

              // 2 shares at an average of 0.50 is exactly 1.00 either way.
              const moved = (await ctx.balance(w, tk.address)) - before;
              expect(moved).to.equal(row.side === BUY ? -1000000n : 1000000n);
            });

            const pastAverage = row.side === BUY ? U / 2n - 1n : U / 2n + 1n;
            const past = await ctx.simulate(await ctx.bundle(w, tk, row.side, row.legs(), { market: true, price: pastAverage }));
            expect(past.name).to.equal("TakerPriceBreached");
          });
        });
      }

      const ONE_RAW_THROUGH = [
        { label: "Complementary buy", side: BUY, taker: () => T, kind: "Complementary", price: 500001n },
        { label: "Mint", side: BUY, taker: () => T, kind: "Mint", price: 499999n },
        { label: "Complementary sell", side: SELL, taker: () => TS, kind: "Complementary", price: 499999n },
        { label: "Merge", side: SELL, taker: () => TS, kind: "Merge", price: 500001n },
      ];

      for (const row of ONE_RAW_THROUGH) {
        it(`${row.label}: a limit taker one raw through its price reverts InvalidMatch`, async function () {
          await snapshotted(async () => {
            const a = await ctx.bundle(
              w,
              row.taker(),
              row.side,
              [{ maker: G, kind: row.kind, price: row.price, fill: F, noFee: true }],
              { price: 500000n },
            );
            expect((await ctx.simulate(a)).name).to.equal("InvalidMatch");
          });
        });
      }

      it("a limit taker at exactly its price pays the fee on top, as before", async function () {
        await snapshotted(async () => {
          const before = await ctx.balance(w, T.address);
          const a = await ctx.bundle(
            w,
            T,
            BUY,
            [{ maker: G, kind: "Complementary", price: 500000n, fill: F, takerFee: 5000n, makerFee: 5000n }],
            { price: 500000n },
          );

          expect((await ctx.send(a)).name).to.equal("OK");
          expect(before - (await ctx.balance(w, T.address))).to.equal(505000n);
        });
      });
    });

    describe("price edges with the per-fill check skipped", function () {
      const EDGES = [
        {
          label: "Mint with the maker at unit (the taker would pay nothing)",
          expected: "ZeroAmount",
          side: BUY,
          taker: () => T,
          leg: () => ({ maker: G, kind: "Mint", price: U, fill: F, noFee: true }),
          price: () => U,
        },
        {
          label: "Merge with the maker at unit (the taker would get nothing)",
          expected: "ZeroAmount",
          side: SELL,
          taker: () => TS,
          leg: () => ({ maker: G, kind: "Merge", price: U, fill: F, noFee: true }),
          price: () => 1n,
        },
        {
          label: "Mint with the maker at 0",
          expected: "ZeroAmount",
          side: BUY,
          taker: () => T,
          leg: () => ({ maker: G, kind: "Mint", price: 0n, fill: F, noFee: true }),
          price: () => U,
        },
        {
          label: "Complementary with the maker above unit",
          expected: "InvalidPrice",
          side: BUY,
          taker: () => T,
          leg: () => ({ maker: G, kind: "Complementary", price: U + 1n, fill: F, noFee: true }),
          price: () => U,
        },
        {
          label: "a market taker signed above unit",
          expected: "InvalidPrice",
          side: BUY,
          taker: () => T,
          leg: () => ({ maker: G, kind: "Complementary", price: U / 2n, fill: F, noFee: true }),
          price: () => U + 1n,
        },
        {
          label: "a market buy signed at 0",
          expected: "TakerPriceBreached",
          side: BUY,
          taker: () => T,
          leg: () => ({ maker: G, kind: "Complementary", price: U / 2n, fill: F, noFee: true }),
          price: () => 0n,
        },
      ];

      for (const edge of EDGES) {
        it(`${edge.label} reverts ${edge.expected}`, async function () {
          await snapshotted(async () => {
            const a = await ctx.bundle(w, edge.taker(), edge.side, [edge.leg()], { market: true, price: edge.price() });
            expect((await ctx.simulate(a)).name).to.equal(edge.expected);
          });
        });
      }
    });

    describe("an order the signer marks on purpose", function () {
      it("is only tighter for that signer: far legs settle within the signed total, fees included", async function () {
        await snapshotted(async () => {
          const before = await ctx.balance(w, T.address);
          const a = await ctx.bundle(
            w,
            T,
            BUY,
            [
              { maker: G, kind: "Complementary", price: (9n * U) / 10n, fill: F, takerFee: 5000n, makerFee: 0n },
              { maker: H, kind: "Complementary", price: U / 10n, fill: F, takerFee: 1000n, makerFee: 0n },
            ],
            { market: true, price: 503000n },
          );

          expect((await ctx.send(a)).name).to.equal("OK");

          const paid = before - (await ctx.balance(w, T.address));
          const signedTotal = (503000n * 2n * F) / U;
          expect(paid).to.equal(1006000n);
          expect(signedTotal).to.equal(1006000n);
        });
      });

      it("can settle twice on-chain: one settlement per market order is an off-chain rule", async function () {
        await snapshotted(async () => {
          const taker = ctx.order(w, T, w.posA, BUY, 2n * F, 400000n, { salt: ctx.marketSalt().toString() });
          const sig = await ctx.signOrder(T, taker);
          const leg = (maker) => ({ maker, kind: "Complementary", price: 400000n, fill: F, noFee: true });

          expect((await ctx.send(await ctx.bundle(w, T, BUY, [leg(G)], { taker, sig }))).name).to.equal("OK");
          expect((await ctx.send(await ctx.bundle(w, T, BUY, [leg(H)], { taker, sig }))).name).to.equal("OK");
        });
      });
    });
  });

  describe("model-based fuzz", function () {
    const BUNDLES_PER_DECIMALS = 300;

    it("every random bundle, as a limit taker and as a market taker, matches a model of the rules", async function () {
      const tally = { limit: {}, market: {} };
      let compared = 0;
      let settledExactlyOnAllIn = 0;

      for (const decimals of [6, 8, 18]) {
        const w = await ctx.makeWorld(decimals, safes, `fuzz${decimals}`, 100000n);
        const U = w.unit;
        const r = rng(9000 + decimals);
        const cap = (cash) => (cash * MAX_FEE_RATE_BPS) / 10000n;
        const randomPrice = () => {
          const grid = (U * BigInt(1 + r.int(999))) / 1000n;
          const p = r.chance(0.5) ? grid : grid + r.below(1000n);
          return p < 1n ? 1n : p >= U ? U - 1n : p;
        };

        for (let i = 0; i < BUNDLES_PER_DECIMALS; i++) {
          const side = r.chance(0.5) ? BUY : SELL;
          const tk = side === BUY ? T : TS;
          const legCount = 1 + r.int(3);
          const legs = [];
          for (let k = 0; k < legCount; k++) {
            const kind = r.chance(0.5) ? "Complementary" : side === BUY ? "Mint" : "Merge";
            const effective = randomPrice();
            const price = kind === "Complementary" ? effective : U - effective;
            const fill = r.int(10) === 0 ? 1n + r.below(3000n) : 1n + r.below(3n * U);
            const makerCash = (price * fill) / U;
            const takerCash = kind === "Complementary" ? makerCash : fill - makerCash;
            const leg = { maker: [G, H, K][k], kind, price, fill };
            const feeShape = r.int(10);
            if (feeShape < 3) {
              leg.noFee = true;
            } else {
              leg.takerFee = r.below(cap(takerCash) + 1n);
              leg.makerFee = r.below(cap(makerCash) + 1n);
              if (feeShape === 9) leg.takerFee = cap(takerCash) + 1n;
            }
            legs.push(leg);
          }

          // The model's view of cash, fees and fill.
          let cash = 0n;
          let fee = 0n;
          let filled = 0n;
          const economics = legs.map((l) => {
            const makerCash = (l.price * l.fill) / U;
            const takerCash = l.kind === "Complementary" ? makerCash : l.fill - makerCash;
            const takerFee = l.noFee ? 0n : l.takerFee;
            const makerFee = l.noFee ? 0n : l.makerFee;
            cash += takerCash;
            fee += takerFee;
            filled += l.fill;
            return { makerCash, takerCash, takerFee, makerFee };
          });
          const allIn = side === BUY ? cash + fee : cash - fee;
          const exact = side === BUY ? (allIn * U + filled - 1n) / filled : (allIn * U) / filled;

          // Signed price: exactly on the all-in, one raw past it, or anywhere.
          const priceShape = r.int(3);
          let signed = priceShape === 0 ? exact : priceShape === 1 ? (side === BUY ? exact - 1n : exact + 1n) : randomPrice();
          if (signed < 0n) signed = 0n;
          if (signed > U) signed = U;

          const model = (market) => {
            for (let j = 0; j < legs.length; j++) {
              const l = legs[j];
              const e = economics[j];
              if (!market) {
                if (l.kind === "Complementary" && (side === BUY ? signed < l.price : l.price < signed)) return "InvalidMatch";
                if (l.kind === "Mint" && signed + l.price < U) return "InvalidMatch";
                if (l.kind === "Merge" && signed + l.price > U) return "InvalidMatch";
              }
              const dust = l.kind === "Complementary" ? e.makerCash === 0n : e.makerCash === 0n || e.takerCash === 0n;
              if (dust) return "ZeroAmount";
              if (e.takerFee > cap(e.takerCash) || e.makerFee > cap(e.makerCash)) return "FeeExceedsMaxRate";
            }
            if (market && !(side === BUY ? allIn * U <= signed * filled : allIn * U >= signed * filled)) return "TakerPriceBreached";
            return "OK";
          };

          for (const market of [false, true]) {
            await snapshotted(async () => {
              const label = `${decimals}dp bundle #${i} as a ${market ? "market" : "limit"} taker`;
              const a = await ctx.bundle(w, tk, side, legs, { price: signed, market });
              const parties = [tk, G, H, K];
              const balancesBefore = await Promise.all(parties.map((s) => ctx.balance(w, s.address)));
              const diamondBefore = await ctx.balance(w, ctx.diamond);
              const accruedBefore = await ctx.accruedFees(w);
              const positionBefore = await ctx.positionBalance(tk.address, w.posA);

              const result = await ctx.send(a);
              compared++;

              const expected = model(market);
              const bucket = market ? tally.market : tally.limit;
              bucket[result.name] = (bucket[result.name] || 0) + 1;
              expect(result.name, label).to.equal(expected);
              if (!result.ok) return;

              const balancesAfter = await Promise.all(parties.map((s) => ctx.balance(w, s.address)));
              const takerDelta = balancesAfter[0] - balancesBefore[0];
              let backing = 0n;
              let allFees = 0n;
              const makerDeltas = [0n, 0n, 0n];
              legs.forEach((l, j) => {
                const e = economics[j];
                allFees += e.takerFee + e.makerFee;
                if (l.kind === "Complementary") {
                  makerDeltas[j] += side === BUY ? e.makerCash - e.makerFee : -(e.makerCash + e.makerFee);
                } else if (l.kind === "Mint") {
                  makerDeltas[j] += -(e.makerCash + e.makerFee);
                  backing += l.fill;
                } else {
                  makerDeltas[j] += e.makerCash - e.makerFee;
                  backing -= l.fill;
                }
              });

              expect(takerDelta, `${label}: taker cash`).to.equal(side === BUY ? -allIn : allIn);
              makerDeltas.forEach((want, j) => {
                expect(balancesAfter[j + 1] - balancesBefore[j + 1], `${label}: maker ${j} cash`).to.equal(want);
              });
              expect((await ctx.balance(w, ctx.diamond)) - diamondBefore, `${label}: Diamond`).to.equal(backing + allFees);
              expect((await ctx.accruedFees(w)) - accruedBefore, `${label}: accrued`).to.equal(allFees);
              expect((await ctx.positionBalance(tk.address, w.posA)) - positionBefore, `${label}: position`).to.equal(
                side === BUY ? filled : -filled,
              );

              if (market) {
                const withinAverage = side === BUY ? -takerDelta * U <= signed * filled : takerDelta * U >= signed * filled;
                expect(withinAverage, `${label}: average`).to.equal(true);
                if (signed === exact) settledExactlyOnAllIn++;
              }
            });
          }
        }
      }

      // The generator is seeded, so these are exact. They also prove the run was not vacuous: every
      // outcome the rules allow showed up, and a limit taker never hit the market taker's error.
      expect(compared).to.equal(1800);
      expect(tally.limit).to.deep.equal({ OK: 263, InvalidMatch: 571, FeeExceedsMaxRate: 66 });
      expect(tally.market).to.deep.equal({ TakerPriceBreached: 379, OK: 362, FeeExceedsMaxRate: 159 });
      expect(settledExactlyOnAllIn).to.equal(251);
    });
  });
});
