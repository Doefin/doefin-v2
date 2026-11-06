// SettlementFacet — market and limit pricing (SCRUM-559)
// ============================================================================
// The price rules around the market-order marker, in raw units:
//
//   limit takers     per-fill crossing check, `InvalidMatch` on any leg that misses
//   market takers    `(cash + fees) * unit <= price * filled` for a buy and
//                    `(cash - fees) * unit >= price * filled` for a sell, checked
//                    after the legs, `TakerPriceBreached` when it fails
//   the marker       bits 32..63 of the signed salt, so it survives the salt floor
//                    and cannot be added or stripped without breaking the signature
//   the seller's fee comes out of proceeds on Complementary legs, so a seller
//                    needs no ERC-20 allowance and amounts do not change
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
  MARKET_ORDER_MARKER,
  MAX_FEE_RATE_BPS,
  pad,
  toBigInt,
  ceilDiv,
  snapshotted,
  legCash,
  namedHash,
  rng,
} = require("../../utils/safeSettlementFixture.js");

describe("SettlementFacet — market and limit pricing", function () {
  this.timeout(0);

  let ctx, safes, T, TS, G, H, K;

  const comp = (maker, price, fill, extra = {}) => ({ maker, kind: "Complementary", price, fill, ...extra });
  const mint = (maker, price, fill, extra = {}) => ({ maker, kind: "Mint", price, fill, ...extra });
  const merge = (maker, price, fill, extra = {}) => ({ maker, kind: "Merge", price, fill, ...extra });
  const NO_FEE = { noFee: true };

  before(async function () {
    ctx = await setupSafeSettlement("market-order-pricing");
    safes = await ctx.activeSafes(["T", "TS", "G", "H", "K"]);
    [T, TS, G, H, K] = safes;
  });

  // ──────────────────────────────────────────────────────────────────────
  // Limit takers keep the per-fill check: every leg must cross on its own.
  // ──────────────────────────────────────────────────────────────────────
  describe("limit takers", function () {
    let w, U, F;

    before(async function () {
      w = await ctx.makeWorld(6, safes, "limit-takers");
      U = w.unit;
      F = U;
    });

    // Each row averages exactly 0.50 with one leg on each side of it. `makers` is what G and H
    // should see in cash when a market taker settles the same legs.
    const FAR_LEGS = [
      {
        label: "buy Complementary 0.99 + Complementary 0.01",
        side: BUY,
        taker: () => T,
        legs: () => [comp(G, (99n * U) / 100n, F, NO_FEE), comp(H, U / 100n, F, NO_FEE)],
        makers: [990000n, 10000n],
      },
      {
        label: "buy Complementary 0.99 + Mint with the maker at 0.99 (taker 0.01)",
        side: BUY,
        taker: () => T,
        legs: () => [comp(G, (99n * U) / 100n, F, NO_FEE), mint(H, (99n * U) / 100n, F, NO_FEE)],
        makers: [990000n, -990000n],
      },
      {
        label: "sell Complementary 0.99 + Complementary 0.01",
        side: SELL,
        taker: () => TS,
        legs: () => [comp(G, (99n * U) / 100n, F, NO_FEE), comp(H, U / 100n, F, NO_FEE)],
        makers: [-990000n, -10000n],
      },
      {
        label: "sell Complementary 0.99 + Merge with the maker at 0.99 (taker 0.01)",
        side: SELL,
        taker: () => TS,
        legs: () => [comp(G, (99n * U) / 100n, F, NO_FEE), merge(H, (99n * U) / 100n, F, NO_FEE)],
        makers: [-990000n, 990000n],
      },
    ];

    const cashDeltas = async (tk, fn) => {
      const before = await Promise.all([tk, G, H].map((s) => ctx.balance(w, s.address)));
      const result = await fn();
      const after = await Promise.all([tk, G, H].map((s) => ctx.balance(w, s.address)));
      return { result, deltas: after.map((x, i) => x - before[i]) };
    };

    for (const row of FAR_LEGS) {
      it(`${row.label}: a limit taker reverts InvalidMatch and no cash moves`, async function () {
        await snapshotted(async () => {
          const tk = row.taker();
          const a = await ctx.bundle(w, tk, row.side, row.legs(), { price: U / 2n });
          const { result, deltas } = await cashDeltas(tk, () => ctx.send(a));

          expect(result.name).to.equal("InvalidMatch");
          expect(deltas).to.deep.equal([0n, 0n, 0n]);
          // The total would have held: limit x filled is exactly what these legs cost.
          expect((U / 2n) * BigInt(a.filled) / U).to.equal(a.cash);

          const pastAverage = row.side === BUY ? U / 2n - 1n : U / 2n + 1n;
          const past = await ctx.bundle(w, tk, row.side, row.legs(), { price: pastAverage });
          expect((await ctx.send(past)).name).to.equal("InvalidMatch");
        });
      });

      it(`${row.label}: a market taker settles when the total holds, and makers get their own price`, async function () {
        await snapshotted(async () => {
          const tk = row.taker();
          const a = await ctx.bundle(w, tk, row.side, row.legs(), { market: true, price: U / 2n });
          const { result, deltas } = await cashDeltas(tk, () => ctx.send(a));

          expect(result.name).to.equal("OK");
          expect(deltas).to.deep.equal([row.side === BUY ? -1000000n : 1000000n, ...row.makers]);
        });

        await snapshotted(async () => {
          const pastAverage = row.side === BUY ? U / 2n - 1n : U / 2n + 1n;
          const a = await ctx.bundle(w, row.taker(), row.side, row.legs(), { market: true, price: pastAverage });
          expect((await ctx.send(a)).name).to.equal("TakerPriceBreached");
        });
      });
    }

    const ONE_RAW_THROUGH = [
      { label: "Complementary buy", side: BUY, taker: () => T, leg: () => comp(G, 500001n, F, NO_FEE) },
      { label: "Mint", side: BUY, taker: () => T, leg: () => mint(G, 499999n, F, NO_FEE) },
      { label: "Complementary sell", side: SELL, taker: () => TS, leg: () => comp(G, 499999n, F, NO_FEE) },
      { label: "Merge", side: SELL, taker: () => TS, leg: () => merge(G, 500001n, F, NO_FEE) },
    ];

    for (const row of ONE_RAW_THROUGH) {
      it(`${row.label}: one non-crossing leg at size reverts InvalidMatch, which names no order`, async function () {
        await snapshotted(async () => {
          const a = await ctx.bundle(w, row.taker(), row.side, [row.leg()], { price: 500000n });

          const simulated = await ctx.simulate(a);
          expect(simulated.name).to.equal("InvalidMatch");
          expect(simulated.raw).to.equal(ethers.utils.id("InvalidMatch()").slice(0, 10));
          expect(namedHash(simulated)).to.equal(null);

          expect((await ctx.send(a)).name).to.equal("InvalidMatch");
        });
      });
    }

    it("several settlements of one order: each is bounded, so the running total is too", async function () {
      await snapshotted(async () => {
        const P = 333333n;
        const taker = ctx.order(w, T, w.posA, BUY, 5n * U, P);
        const sig = await ctx.signOrder(T, taker);
        const before = await ctx.balance(w, T.address);

        const results = [];
        let filled = 0n;
        for (const price of [900000n, 1n, 99000n, 333333n]) {
          const a = await ctx.bundle(w, T, BUY, [comp(G, price, U, NO_FEE)], { taker, sig });
          const r = await ctx.send(a);
          results.push(r.name);
          if (r.ok) filled += U;
        }

        const spent = before - (await ctx.balance(w, T.address));
        expect(results).to.deep.equal(["InvalidMatch", "OK", "OK", "OK"]);
        expect(filled).to.equal(3000000n);
        expect(spent).to.equal(432334n);
        expect((P * filled) / U).to.equal(999999n);
        expect(spent * U <= P * filled).to.equal(true);

        const hash = await ctx.contracts.sigVerifier.getOrderHash(taker);
        expect(toBigInt(await ctx.contracts.settlement.getFilledAmount(hash))).to.equal(filled);
      });
    });

    for (const decimals of [6, 8, 18]) {
      it(`dust split at ${decimals} decimals: 20 legs of 1 raw at a maker price of 1.00 give nothing away`, async function () {
        const W = await ctx.makeWorld(decimals, safes, `dust${decimals}`);
        const u = W.unit;
        const n = 20n;
        const makerOrder = ctx.order(W, G, W.posA, SELL, 1000n, u);
        const makerSig = await ctx.signOrder(G, makerOrder);
        const legs = Array.from({ length: Number(n) }, () => comp(G, u, 1n, { ...NO_FEE, order: makerOrder, sig: makerSig }));

        for (const [price, limitTimesFilled] of [[u / 2n, 10n], [1n, 0n]]) {
          await snapshotted(async () => {
            const before = await ctx.balance(W, T.address);

            const limit = await ctx.send(await ctx.bundle(W, T, BUY, legs, { price }));
            expect(limit.name).to.equal("InvalidMatch");
            expect(before - (await ctx.balance(W, T.address))).to.equal(0n);
            expect((price * n) / u).to.equal(limitTimesFilled);

            const market = await ctx.send(await ctx.bundle(W, T, BUY, legs, { market: true, price }));
            expect(market.name).to.equal("TakerPriceBreached");
            expect(before - (await ctx.balance(W, T.address))).to.equal(0n);
          });
        }

        await snapshotted(async () => {
          // At a signed 1.00 the legs cost exactly what they say: no rounding allowance either way.
          const before = await ctx.balance(W, T.address);
          const r = await ctx.send(await ctx.bundle(W, T, BUY, legs, { market: true, price: u }));
          expect(r.name).to.equal("OK");
          expect(before - (await ctx.balance(W, T.address))).to.equal(n);
        });
      });
    }

    describe("fee ceiling", function () {
      const atCap = (price, maker) => {
        const cash = (price * F) / U;
        return comp(maker, price, F, { takerFee: (cash * MAX_FEE_RATE_BPS) / 10000n, makerFee: 0n });
      };
      const overCap = (leg) => ({ ...leg, takerFee: leg.takerFee + 1n });

      it("the total ceiling is linear in cash, so far legs do not raise it", async function () {
        await snapshotted(async () => {
          const near = await ctx.bundle(w, T, BUY, [atCap(U / 2n, G), atCap(U / 2n, H)], { price: U / 2n });
          expect(near.fee).to.equal(10000n);
          expect((await ctx.send(near)).name).to.equal("OK");
        });

        await snapshotted(async () => {
          const farLegs = [atCap((99n * U) / 100n, G), atCap(U / 100n, H)];

          // A limit taker never reaches the fee check on a far leg.
          const limit = await ctx.bundle(w, T, BUY, farLegs, { price: U / 2n });
          expect(limit.fee).to.equal(10000n);
          expect((await ctx.send(limit)).name).to.equal("InvalidMatch");
          const limitOver = await ctx.bundle(w, T, BUY, [overCap(farLegs[0]), farLegs[1]], { price: U / 2n });
          expect((await ctx.send(limitOver)).name).to.equal("InvalidMatch");

          // A market taker does, and the far legs carry the same total.
          const market = await ctx.bundle(w, T, BUY, farLegs, { market: true });
          expect(market.fee).to.equal(10000n);
          const marketOver = await ctx.bundle(w, T, BUY, [overCap(farLegs[0]), farLegs[1]], { market: true });
          expect((await ctx.simulate(marketOver)).name).to.equal("FeeExceedsMaxRate");
          expect((await ctx.send(market)).name).to.equal("OK");
        });
      });

      // Prices chosen so the taker's cash is 0.40 on every path and a limit taker crosses exactly.
      const PATHS = [
        { label: "Complementary buy", side: BUY, taker: () => T, leg: (extra) => comp(G, 400000n, F, extra) },
        { label: "Complementary sell", side: SELL, taker: () => TS, leg: (extra) => comp(G, 400000n, F, extra) },
        { label: "Mint", side: BUY, taker: () => T, leg: (extra) => mint(G, 600000n, F, extra) },
        { label: "Merge", side: SELL, taker: () => TS, leg: (extra) => merge(G, 600000n, F, extra) },
      ];

      for (const path of PATHS) {
        for (const market of [false, true]) {
          it(`${path.label}, ${market ? "market" : "limit"} taker: each party's fee settles at the cap and reverts one raw over`, async function () {
            const { takerCash, makerCash } = legCash(w, path.leg({}));
            const takerCap = (takerCash * MAX_FEE_RATE_BPS) / 10000n;
            const makerCap = (makerCash * MAX_FEE_RATE_BPS) / 10000n;
            expect(takerCap).to.equal(4000n);
            expect(makerCap).to.equal(path.leg({}).kind === "Complementary" ? 4000n : 6000n);

            const tk = path.taker();
            // Far enough past the all-in that only the fee ceiling can object.
            const signed = market ? (path.side === BUY ? 500000n : 300000n) : 400000n;
            const build = (takerFee, makerFee) =>
              ctx.bundle(w, tk, path.side, [path.leg({ takerFee, makerFee })], { market, price: signed });

            await snapshotted(async () => {
              const r = await ctx.send(await build(takerCap, makerCap));
              expect(r.name).to.equal("OK");
            });
            expect((await ctx.simulate(await build(takerCap + 1n, makerCap))).name).to.equal("FeeExceedsMaxRate");
            expect((await ctx.simulate(await build(takerCap, makerCap + 1n))).name).to.equal("FeeExceedsMaxRate");
          });
        }
      }
    });

    describe("solvency on legs that cross", function () {
      const SOLVENCY = [
        {
          label: "Complementary buy",
          side: BUY,
          taker: () => T,
          legs: () => [comp(G, 400000n, F), comp(H, 100000n, F)],
          backing: () => 0n,
        },
        {
          label: "Complementary sell",
          side: SELL,
          taker: () => TS,
          legs: () => [comp(G, 900000n, F), comp(H, 600000n, F)],
          backing: () => 0n,
        },
        {
          label: "Mint",
          side: BUY,
          taker: () => T,
          legs: () => [mint(G, 600000n, F), mint(H, 900000n, F)],
          backing: () => 2n * F,
        },
        {
          label: "Merge",
          side: SELL,
          taker: () => TS,
          legs: () => [merge(G, 400000n, F), merge(H, 100000n, F)],
          backing: () => -2n * F,
        },
      ];

      for (const row of SOLVENCY) {
        it(`${row.label}: the Diamond's balance moves by exactly backing plus accrued fees`, async function () {
          await snapshotted(async () => {
            const diamondBefore = await ctx.balance(w, ctx.diamond);
            const accruedBefore = await ctx.accruedFees(w);
            const a = await ctx.bundle(w, row.taker(), row.side, row.legs(), { price: U / 2n });

            expect((await ctx.send(a)).name).to.equal("OK");

            const diamondDelta = (await ctx.balance(w, ctx.diamond)) - diamondBefore;
            const accruedDelta = (await ctx.accruedFees(w)) - accruedBefore;
            expect(accruedDelta > 0n).to.equal(true);
            expect(diamondDelta).to.equal(row.backing() + accruedDelta);
          });
        });
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Rounding never pushes an exact-price limit fill over the per-fill check.
  // ──────────────────────────────────────────────────────────────────────
  describe("limit-taker rounding", function () {
    it("exact-price fills pass on every path, decimals and leg count", async function () {
      let total = 0;
      let passed = 0;
      let mintFillsOnTheBound = 0;

      for (const decimals of [6, 8, 18]) {
        const W = await ctx.makeWorld(decimals, safes, `round${decimals}`);
        const U = W.unit;
        const prices = [U / 3n, (2n * U) / 3n, U / 7n, U - 1n, 1n + U / 2n, (U * 123457n) / 1000000n + 1n];
        const fills = [1n + U / 3n, U / 7n + 3n, 1234567n, U + 1n];

        for (const P of prices) {
          for (const legCount of [1, 2, 3, 7]) {
            for (const [side, tk, kind] of [
              [BUY, T, "Complementary"],
              [SELL, TS, "Complementary"],
              [BUY, T, "Mint"],
              [SELL, TS, "Merge"],
            ]) {
              const legPrice = kind === "Complementary" ? P : U - P;
              const legs = Array.from({ length: legCount }, (_, i) => ({
                maker: [G, H, K][i % 3],
                kind,
                price: legPrice,
                fill: fills[i % fills.length],
                ...NO_FEE,
              }));
              const dustless = legs.every((l) => {
                const makerCash = (l.price * l.fill) / U;
                return makerCash > 0n && (kind === "Complementary" || l.fill - makerCash > 0n);
              });
              if (!dustless) continue;

              // A raw call, not a transaction: 7 Mint legs can pass the per-transaction gas cap on the
              // instrumented `hardhat coverage` build, and only the outcome matters here.
              const a = await ctx.bundle(W, tk, side, legs, { price: P });
              const r = await ctx.simulate(a);
              total++;
              expect(r.name, `${decimals}dp ${kind} P=${P} legs=${legCount}`).to.equal("OK");
              passed++;
              const bound = legs.reduce((sum, l) => sum + (side === BUY ? ceilDiv(P * l.fill, U) : (P * l.fill) / U), 0n);
              if (kind === "Mint" && a.cash === bound) mintFillsOnTheBound++;
            }
          }
        }
      }

      expect(total).to.equal(264);
      expect(passed).to.equal(264);
      expect(mintFillsOnTheBound).to.equal(60);
    });

    const TIGHT = [
      { decimals: 6, mintCash: 111112n, sellCash: 111111n },
      { decimals: 8, mintCash: 11111112n, sellCash: 11111111n },
      { decimals: 18, mintCash: 111111111111111112n, sellCash: 111111111111111111n },
    ];

    for (const { decimals, mintCash, sellCash } of TIGHT) {
      it(`at ${decimals} decimals one raw of cash either way decides the fill`, async function () {
        const W = await ctx.makeWorld(decimals, safes, `tight${decimals}`);
        const U = W.unit;
        const fill = U / 3n + 1n;
        const P = U / 3n;

        // A Mint at the exact complement rounds up to the ceiling of the taker's price.
        const mintLegs = [mint(G, U - P, fill, NO_FEE)];
        const mintAtP = await ctx.bundle(W, T, BUY, mintLegs, { price: P });
        expect(mintAtP.cash).to.equal(mintCash);
        expect(ceilDiv(P * fill, U)).to.equal(mintCash);
        expect((await ctx.simulate(mintAtP)).name).to.equal("OK");
        const oneLower = ((mintAtP.cash - 1n) * U) / fill;
        expect((await ctx.simulate(await ctx.bundle(W, T, BUY, mintLegs, { price: oneLower }))).name).to.equal("InvalidMatch");

        // A Complementary sell rounds down to the floor of the taker's price.
        const sellLegs = [comp(G, P, fill, NO_FEE)];
        const sellAtP = await ctx.bundle(W, TS, SELL, sellLegs, { price: P });
        expect(sellAtP.cash).to.equal(sellCash);
        expect((await ctx.simulate(sellAtP)).name).to.equal("OK");
        const oneHigher = ceilDiv((sellAtP.cash + 1n) * U, fill);
        expect((await ctx.simulate(await ctx.bundle(W, TS, SELL, sellLegs, { price: oneHigher }))).name).to.equal("InvalidMatch");
      });
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // The marker: bits 32..63 of the signed salt.
  // ──────────────────────────────────────────────────────────────────────
  describe("the salt marker", function () {
    let w, U, F;

    before(async function () {
      w = await ctx.makeWorld(6, safes, "marker");
      U = w.unit;
      F = U;
    });

    const bits32to63 = (salt) => (BigInt(salt) >> 32n) & 0xffffffffn;
    const isMarketLocally = (salt) => bits32to63(salt) === MARKET_ORDER_MARKER;

    // `fillOrder` refuses a market order before it looks at the signature, so a garbage signature
    // tells the contract's own reading of a salt apart: OrderCancelled means market.
    const contractReadsAsMarket = async (salt) => {
      const o = ctx.order(w, G, w.posA, SELL, F, 400000n, { salt: BigInt(salt).toString() });
      const { name } = await ctx.simulateFill(o, "0x" + "11".repeat(65), F, 0n);
      expect(["OrderCancelled", "InvalidOrderSignature"]).to.include(name);
      return name === "OrderCancelled";
    };

    it("nothing clients mint today carries the marker, and the market layout does", async function () {
      const ms = 1793996762378n;
      const r = rng(5);

      const frontend = (ms << 64n) | r.big(32);
      const goSdk = ms;
      const loadTest64 = r.big(64);
      const market = (ms << 64n) | (MARKET_ORDER_MARKER << 32n) | r.big(32);
      // An SDK that ORs the marker into its time-only salt clobbers the bits it needs.
      const sdkTrap = ms | (MARKET_ORDER_MARKER << 32n);

      expect(isMarketLocally(frontend)).to.equal(false);
      expect(isMarketLocally(goSdk)).to.equal(false);
      expect(bits32to63(goSdk)).to.equal(417n);
      expect(isMarketLocally(loadTest64)).to.equal(false);
      expect(isMarketLocally(market)).to.equal(true);
      expect(market.toString().length).to.equal(32); // the backend's salt column is VARCHAR(78)
      expect(market >> 64n).to.equal(ms); // same magnitude and time ordering as a limit salt
      expect(bits32to63(sdkTrap)).to.equal(0xef860dafn);
      expect(isMarketLocally(sdkTrap)).to.equal(false);

      expect(await contractReadsAsMarket(frontend)).to.equal(false);
      expect(await contractReadsAsMarket(goSdk)).to.equal(false);
      expect(await contractReadsAsMarket(loadTest64)).to.equal(false);
      expect(await contractReadsAsMarket(sdkTrap)).to.equal(false);
      expect(await contractReadsAsMarket(market)).to.equal(true);
    });

    it("only bits 32..63 count", async function () {
      const M = MARKET_ORDER_MARKER;

      // Any other bits are free.
      expect(await contractReadsAsMarket(M << 32n)).to.equal(true);
      expect(await contractReadsAsMarket((1n << 255n) | (M << 32n) | 0xffffffffn)).to.equal(true);

      // The marker anywhere else, or one bit off, is a limit order.
      expect(await contractReadsAsMarket(M)).to.equal(false);
      expect(await contractReadsAsMarket(M << 31n)).to.equal(false);
      expect(await contractReadsAsMarket(M << 33n)).to.equal(false);
      expect(await contractReadsAsMarket(M << 64n)).to.equal(false);
      expect(await contractReadsAsMarket((M ^ 1n) << 32n)).to.equal(false);
      expect(await contractReadsAsMarket((M ^ 0x80000000n) << 32n)).to.equal(false);
    });

    it("the salt floor treats the marker in time order; a marker at the top of the word would escape it", async function () {
      const { nonceMgr } = ctx.contracts;
      const ms = 1800000000000n;
      const floor = (ms + 1000n) << 64n;
      const topPrefix = (0xef860c2eca8a3552n << 192n) | (ms << 64n);
      const rows = [
        { salt: ms << 64n, stillValid: false },
        { salt: (ms + 2000n) << 64n, stillValid: true },
        { salt: (ms << 64n) | (MARKET_ORDER_MARKER << 32n), stillValid: false },
        { salt: ((ms + 2000n) << 64n) | (MARKET_ORDER_MARKER << 32n), stillValid: true },
        { salt: topPrefix, stillValid: true },
      ].map((row) => ({ ...row, order: ctx.order(w, G, w.posA, SELL, F, 500000n, { salt: row.salt.toString() }) }));
      const cancelBelow = (salt) =>
        ctx.exec(G, ctx.diamond, nonceMgr.interface.encodeFunctionData("cancelOrdersForPosition", [pad(w.posA), salt.toString()]));

      await snapshotted(async () => {
        for (const row of rows) expect(await nonceMgr.isOrderValid(row.order)).to.equal(true);
        await cancelBelow(floor);
        for (const row of rows) expect(await nonceMgr.isOrderValid(row.order)).to.equal(row.stillValid);
      });

      await snapshotted(async () => {
        // Reaching a top-of-word salt with the floor would brick the position's ordinary orders for good.
        await cancelBelow(topPrefix + 1n);
        const newer = ctx.order(w, G, w.posA, SELL, F, 500000n, { salt: ((ms + 999999n) << 64n).toString() });
        expect(await nonceMgr.isOrderValid(newer)).to.equal(false);
        await expect(cancelBelow(1n << 64n)).to.be.reverted;
        expect(await nonceMgr.isOrderValid(newer)).to.equal(false);
      });
    });

    describe("what stops a market order", function () {
      const signedMarketBuy = () => ctx.bundle(w, T, BUY, [comp(G, 400000n, F)], { market: true });

      it("settles when nothing stops it", async function () {
        await snapshotted(async () => {
          const a = await signedMarketBuy();
          expect(await ctx.contracts.nonceMgr.isOrderValid(a.taker)).to.equal(true);
          expect((await ctx.send(a)).name).to.equal("OK");
        });
      });

      it("a nonce bump", async function () {
        await snapshotted(async () => {
          const { nonceMgr, sigVerifier } = ctx.contracts;
          const a = await signedMarketBuy();
          await ctx.exec(T, ctx.diamond, nonceMgr.interface.encodeFunctionData("incrementNonce", []));

          expect(await nonceMgr.isOrderValid(a.taker)).to.equal(false);
          const r = await ctx.simulate(a);
          expect(r.name).to.equal("OrderNonceInvalid");
          expect(namedHash(r)).to.equal(await sigVerifier.getOrderHash(a.taker));
          expect((await ctx.send(a)).name).to.equal("OrderNonceInvalid");
        });
      });

      it("a salt floor above it", async function () {
        await snapshotted(async () => {
          const { nonceMgr, sigVerifier } = ctx.contracts;
          const a = await signedMarketBuy();
          const floor = (BigInt(a.taker.salt) + 1n).toString();
          await ctx.exec(T, ctx.diamond, nonceMgr.interface.encodeFunctionData("cancelOrdersForPosition", [pad(w.posA), floor]));

          expect(await nonceMgr.isOrderValid(a.taker)).to.equal(false);
          const r = await ctx.simulate(a);
          expect(r.name).to.equal("OrderCancelled");
          expect(namedHash(r)).to.equal(await sigVerifier.getOrderHash(a.taker));
          expect((await ctx.send(a)).name).to.equal("OrderCancelled");
        });
      });

      it("cancelOrder", async function () {
        await snapshotted(async () => {
          const { nonceMgr, sigVerifier } = ctx.contracts;
          const a = await signedMarketBuy();
          const hash = await sigVerifier.getOrderHash(a.taker);
          await ctx.exec(T, ctx.diamond, nonceMgr.interface.encodeFunctionData("cancelOrder", [a.taker]));

          expect(await nonceMgr.isCancelled(hash)).to.equal(true);
          expect(await nonceMgr.isOrderValid(a.taker)).to.equal(false);
          const r = await ctx.simulate(a);
          expect(r.name).to.equal("OrderCancelled");
          expect(namedHash(r)).to.equal(hash);
          expect((await ctx.send(a)).name).to.equal("OrderCancelled");
        });
      });
    });

    it("every on-chain reader of an order works on a market order", async function () {
      const { sigVerifier, nonceMgr } = ctx.contracts;
      const o = ctx.order(w, T, w.posA, BUY, F, 500000n, { salt: ctx.marketSalt().toString() });

      expect(await sigVerifier.getOrderHash(o)).to.equal(ctx.orderDigest(o));
      expect(await nonceMgr.isOrderValid(o)).to.equal(true);
      expect(await sigVerifier.verifyOrderSignature(o, await ctx.signOrder(T, o), 1)).to.equal(true);
    });

    describe("stripping or adding the marker", function () {
      const legs = () => [comp(G, 400000n, F)];

      it("stripping it from a signed market order breaks the signature", async function () {
        await snapshotted(async () => {
          const a = await ctx.bundle(w, T, BUY, legs(), { market: true });
          const strippedSalt = BigInt(a.taker.salt) & ~(0xffffffffn << 32n);
          const stripped = { ...a, taker: { ...a.taker, salt: strippedSalt.toString() } };
          const hash = await ctx.contracts.sigVerifier.getOrderHash(stripped.taker);

          const r = await ctx.simulate(stripped);
          expect(r.name).to.equal("InvalidOrderSignature");
          expect(namedHash(r)).to.equal(hash);
          expect((await ctx.send(stripped)).name).to.equal("InvalidOrderSignature");
        });
      });

      it("adding it to a signed limit order breaks the signature", async function () {
        await snapshotted(async () => {
          const a = await ctx.bundle(w, T, BUY, legs(), { price: 500000n });
          const addedSalt = BigInt(a.taker.salt) | (MARKET_ORDER_MARKER << 32n);
          const added = { ...a, taker: { ...a.taker, salt: addedSalt.toString() } };

          expect((await ctx.simulate(added)).name).to.equal("InvalidOrderSignature");
          expect((await ctx.send(added)).name).to.equal("InvalidOrderSignature");
        });
      });

      it("kept, a market order signed exactly at the all-in settles", async function () {
        await snapshotted(async () => {
          const a = await ctx.bundle(w, T, BUY, legs(), { market: true });

          expect(a.price).to.equal(404000n);
          expect(a.cash).to.equal(400000n);
          expect(a.fee).to.equal(4000n);
          expect((await ctx.send(a)).name).to.equal("OK");
        });
      });

      it("without it, the same signed price is a limit order and the fee goes on top", async function () {
        await snapshotted(async () => {
          const before = await ctx.balance(w, T.address);
          const a = await ctx.bundle(w, T, BUY, [comp(G, 404000n, F)], { price: 404000n });

          expect((await ctx.send(a)).name).to.equal("OK");

          expect(before - (await ctx.balance(w, T.address))).to.equal(408040n);
          expect((404000n * F) / U).to.equal(404000n);
        });
      });

      it("with it, a limit-style price leaves no room for the fee", async function () {
        await snapshotted(async () => {
          const a = await ctx.bundle(w, T, BUY, [comp(G, 400000n, F)], { price: 400000n, market: true });
          expect(a.fee).to.equal(4000n);
          expect((await ctx.send(a)).name).to.equal("TakerPriceBreached");
        });
      });

      it("with it and no fee, a limit-style price settles", async function () {
        await snapshotted(async () => {
          const a = await ctx.bundle(w, T, BUY, [comp(G, 400000n, F, NO_FEE)], { price: 400000n, market: true });
          expect((await ctx.send(a)).name).to.equal("OK");
        });
      });

      it("with it, a Mint leg that rounds up breaks the exact average though the limit rule would pass it", async function () {
        await snapshotted(async () => {
          const P = 400000n;
          const fill = U / 3n + 1n;
          const leg = mint(G, U - P, fill, NO_FEE);
          const market = await ctx.bundle(w, T, BUY, [leg], { price: P, market: true });

          expect(market.cash).to.equal(133334n);
          expect(ceilDiv(P * fill, U)).to.equal(133334n);
          expect((await ctx.simulate(market)).name).to.equal("TakerPriceBreached");
          expect((await ctx.simulate(await ctx.bundle(w, T, BUY, [leg], { price: P }))).name).to.equal("OK");
        });
      });
    });

    describe("a market order as a maker or in fillOrder", function () {
      const P = 400000n;
      const FEE = 4000n; // 100 bps of the cash: legal for any limit order at this price.

      it("a market buy used as a maker reverts OrderCancelled and pays nothing", async function () {
        await snapshotted(async () => {
          const maker = ctx.order(w, G, w.posA, BUY, F, P, { salt: ctx.marketSalt().toString() });
          const before = await ctx.balance(w, G.address);
          const a = await ctx.bundle(w, TS, SELL, [comp(G, P, F, { order: maker, takerFee: 0n, makerFee: FEE })], { price: P });

          expect((await ctx.send(a)).name).to.equal("OrderCancelled");
          expect((await ctx.balance(w, G.address)) - before).to.equal(0n);
        });
      });

      it("a market sell used as a maker reverts OrderCancelled and receives nothing", async function () {
        await snapshotted(async () => {
          const maker = ctx.order(w, G, w.posA, SELL, F, P, { salt: ctx.marketSalt().toString() });
          const before = await ctx.balance(w, G.address);
          const a = await ctx.bundle(w, T, BUY, [comp(G, P, F, { order: maker, takerFee: 0n, makerFee: FEE })], { price: P });

          expect((await ctx.send(a)).name).to.equal("OrderCancelled");
          expect((await ctx.balance(w, G.address)) - before).to.equal(0n);
        });
      });

      it("a market sell through fillOrder reverts OrderCancelled and receives nothing", async function () {
        await snapshotted(async () => {
          const { operator } = ctx.signers;
          await w.token.mint(operator.address, (10n * U).toString());
          await w.token.connect(operator).approve(ctx.diamond, ethers.constants.MaxUint256);
          const o = ctx.order(w, G, w.posA, SELL, F, P, { salt: ctx.marketSalt().toString() });
          const before = await ctx.balance(w, G.address);

          expect((await ctx.sendFill(o, await ctx.signOrder(G, o), F, FEE)).name).to.equal("OrderCancelled");
          expect((await ctx.balance(w, G.address)) - before).to.equal(0n);
        });
      });
    });

    describe("what the contract leaves to the off-chain rules", function () {
      it("a second settlement of the remainder is not refused on-chain", async function () {
        await snapshotted(async () => {
          const taker = ctx.order(w, T, w.posA, BUY, 2n * F, 400000n, { salt: ctx.marketSalt().toString() });
          const sig = await ctx.signOrder(T, taker);

          expect((await ctx.send(await ctx.bundle(w, T, BUY, [comp(G, 400000n, F, NO_FEE)], { taker, sig }))).name).to.equal("OK");
          expect((await ctx.send(await ctx.bundle(w, T, BUY, [comp(H, 400000n, F, NO_FEE)], { taker, sig }))).name).to.equal("OK");

          const hash = await ctx.contracts.sigVerifier.getOrderHash(taker);
          expect(toBigInt(await ctx.contracts.settlement.getFilledAmount(hash))).to.equal(2000000n);
        });
      });

      it("neither a missing expiry nor one in 2100 is refused on-chain", async function () {
        await snapshotted(async () => {
          const none = await ctx.bundle(w, T, BUY, [comp(G, 400000n, F)], { market: true, takerOverrides: { expiration: 0 } });
          const far = await ctx.bundle(w, T, BUY, [comp(H, 400000n, F)], { market: true, takerOverrides: { expiration: 4102444800 } });

          expect((await ctx.send(none)).name).to.equal("OK");
          expect((await ctx.send(far)).name).to.equal("OK");
        });
      });

      for (const signed of [0n, 1n]) {
        it(`a market sell signed at ${signed} raw settles into a 1-raw bid: the signed floor is all the protection there is`, async function () {
          await snapshotted(async () => {
            const before = await ctx.balance(w, TS.address);
            const a = await ctx.bundle(w, TS, SELL, [comp(G, 1n, 2_000_000n, NO_FEE)], { market: true, price: signed });

            expect((await ctx.send(a)).name).to.equal("OK");
            expect((await ctx.balance(w, TS.address)) - before).to.equal(2n);
          });
        });
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Market takers: the exact all-in average, fees included, no rounding allowance.
  // ──────────────────────────────────────────────────────────────────────
  describe("market takers: exact all-in average", function () {
    for (const decimals of [6, 8, 18]) {
      describe(`at ${decimals} decimals`, function () {
        let W, U, F;

        before(async function () {
          W = await ctx.makeWorld(decimals, safes, `allin${decimals}`);
          U = W.unit;
          F = U;
        });

        // Fills that do not sum to a whole token: the tightest signed price is rounded in the
        // taker's favour, and the next price past it must revert.
        const TIGHTEST = [
          {
            label: "Complementary buy",
            side: BUY,
            taker: () => T,
            legs: () => [
              comp(G, (3n * U) / 10n, F / 2n),
              comp(H, (38n * U) / 100n, (6n * F) / 10n),
              comp(K, U / 2n, F / 2n),
            ],
          },
          {
            label: "Mint buy",
            side: BUY,
            taker: () => T,
            legs: () => [mint(G, (7n * U) / 10n, F / 2n), mint(H, (5n * U) / 10n, (6n * F) / 10n)],
          },
          {
            label: "Complementary + Mint buy",
            side: BUY,
            taker: () => T,
            legs: () => [comp(G, (3n * U) / 10n, F / 2n), mint(H, (5n * U) / 10n, (6n * F) / 10n)],
          },
          {
            label: "Complementary sell",
            side: SELL,
            taker: () => TS,
            legs: () => [comp(G, (36n * U) / 100n, F / 2n), comp(H, (31n * U) / 100n, F / 2n)],
          },
          {
            label: "Merge sell",
            side: SELL,
            taker: () => TS,
            legs: () => [merge(G, (64n * U) / 100n, F / 2n), merge(H, (69n * U) / 100n, F / 2n)],
          },
          {
            label: "Complementary + Merge sell",
            side: SELL,
            taker: () => TS,
            legs: () => [comp(G, (36n * U) / 100n, F / 2n), merge(H, (69n * U) / 100n, F / 2n)],
          },
        ];

        for (const row of TIGHTEST) {
          it(`${row.label} with fees: the tightest signed price settles at the bundle's exact cost; one raw past reverts`, async function () {
            await snapshotted(async () => {
              const tk = row.taker();
              const a = await ctx.bundle(W, tk, row.side, row.legs(), { market: true });
              expect(a.fee > 0n).to.equal(true);
              const before = await ctx.balance(W, tk.address);

              expect((await ctx.send(a)).name).to.equal("OK");

              const moved = (await ctx.balance(W, tk.address)) - before;
              expect(moved).to.equal(row.side === BUY ? -(a.cash + a.fee) : a.cash - a.fee);
            });

            await snapshotted(async () => {
              const tk = row.taker();
              const a = await ctx.bundle(W, tk, row.side, row.legs(), { market: true });
              const past = row.side === BUY ? a.price - 1n : a.price + 1n;
              const r = await ctx.simulate(await ctx.bundle(W, tk, row.side, row.legs(), { market: true, price: past }));
              expect(r.name).to.equal("TakerPriceBreached");
            });
          });
        }

        // Fills that sum to exactly one whole token, so the average can land exactly on a raw
        // price: `(cash +/- fees) * unit == price * filled`. Each taker fee is half the ceiling, so one
        // raw more of fee is still legal and only the average can object.
        const halfCapFee = (w, leg) => ({ ...leg, takerFee: legCash(w, leg).takerCash / 200n, makerFee: 0n });
        const ON_THE_LIMIT = [
          {
            label: "Complementary buy",
            side: BUY,
            taker: () => T,
            legs: () => [comp(G, (3n * U) / 10n, F / 2n), comp(H, U / 2n, F / 2n)],
          },
          {
            label: "Complementary sell",
            side: SELL,
            taker: () => TS,
            legs: () => [comp(G, (36n * U) / 100n, F / 2n), comp(H, (64n * U) / 100n, F / 2n)],
          },
          {
            label: "Mint",
            side: BUY,
            taker: () => T,
            legs: () => [mint(G, (7n * U) / 10n, F / 2n), mint(H, (5n * U) / 10n, F / 2n)],
          },
          {
            label: "Merge",
            side: SELL,
            taker: () => TS,
            legs: () => [merge(G, (64n * U) / 100n, F / 2n), merge(H, (36n * U) / 100n, F / 2n)],
          },
          {
            label: "mixed Complementary + Mint",
            side: BUY,
            taker: () => T,
            legs: () => [comp(G, (3n * U) / 10n, F / 2n), mint(H, (5n * U) / 10n, F / 2n)],
          },
          {
            label: "mixed Complementary + Merge",
            side: SELL,
            taker: () => TS,
            legs: () => [comp(G, (36n * U) / 100n, F / 2n), merge(H, (64n * U) / 100n, F / 2n)],
          },
        ];

        for (const row of ON_THE_LIMIT) {
          it(`${row.label} with fees: exactly on the limit passes; one raw of price or of fee past it reverts`, async function () {
            const tk = row.taker();
            const legs = row.legs().map((leg) => halfCapFee(W, { takerSide: row.side, ...leg }));
            const a = await ctx.bundle(W, tk, row.side, legs, { market: true });
            const allIn = row.side === BUY ? a.cash + a.fee : a.cash - a.fee;

            expect(a.fee > 0n).to.equal(true);
            expect(allIn * U).to.equal(a.price * BigInt(a.filled));

            await snapshotted(async () => {
              const before = await ctx.balance(W, tk.address);
              expect((await ctx.send(a)).name).to.equal("OK");
              const moved = (await ctx.balance(W, tk.address)) - before;
              expect(moved).to.equal(row.side === BUY ? -allIn : allIn);
            });

            const pastPrice = row.side === BUY ? a.price - 1n : a.price + 1n;
            const onePricePast = await ctx.bundle(W, tk, row.side, legs, { market: true, price: pastPrice });
            expect((await ctx.simulate(onePricePast)).name).to.equal("TakerPriceBreached");

            const [first, ...rest] = legs;
            const oneFeeMore = [{ ...first, takerFee: first.takerFee + 1n }, ...rest];
            const oneFeePast = await ctx.bundle(W, tk, row.side, oneFeeMore, { market: true, price: a.price });
            expect((await ctx.simulate(oneFeePast)).name).to.equal("TakerPriceBreached");
          });
        }
      });
    }

    it("4 legs across the book: 2 shares at 0.424 charges exactly 0.848, and 0.423999 reverts", async function () {
      const W = await ctx.makeWorld(6, safes, "ex424");
      const legs = [
        comp(G, 300000n, 500000n, NO_FEE),
        comp(H, 380000n, 600000n, NO_FEE),
        comp(K, 500000n, 500000n, NO_FEE),
        comp(G, 550000n, 400000n, NO_FEE),
      ];

      await snapshotted(async () => {
        const before = await ctx.balance(W, T.address);
        const a = await ctx.bundle(W, T, BUY, legs, { market: true, price: 424000n, amount: 2_000_000n });
        expect((await ctx.send(a)).name).to.equal("OK");
        expect(before - (await ctx.balance(W, T.address))).to.equal(848000n);
      });

      await snapshotted(async () => {
        const a = await ctx.bundle(W, T, BUY, legs, { market: true, price: 423999n, amount: 2_000_000n });
        expect((await ctx.send(a)).name).to.equal("TakerPriceBreached");
      });
    });

    it("random mixed-path bundles settle at the exact signed average", async function () {
      let attempted = 0;
      let settled = 0;
      let averageOutOfRange = 0;
      const otherOutcomes = {};

      for (const decimals of [6, 8, 18]) {
        const W = await ctx.makeWorld(decimals, safes, `rand${decimals}`, 100000n);
        const U = W.unit;
        const r = rng(33 + decimals);

        for (let i = 0; i < 100; i++) {
          const side = r.chance(0.5) ? BUY : SELL;
          const tk = side === BUY ? T : TS;
          const legCount = 1 + r.int(3);
          const legs = [];
          let hasDustLeg = false;
          for (let k = 0; k < legCount; k++) {
            const kind = r.chance(0.5) ? "Complementary" : side === BUY ? "Mint" : "Merge";
            const effective = (U * BigInt(1 + r.int(999))) / 1000n + r.below(1000n);
            const price = kind === "Complementary" ? effective : U - effective;
            const leg = { maker: [G, H, K][k], kind, price, fill: 1n + r.below(3n * U) };
            const cash = legCash(W, leg);
            if (cash.makerCash === 0n || (kind !== "Complementary" && cash.takerCash === 0n)) hasDustLeg = true;
            legs.push(leg);
          }
          if (hasDustLeg) continue;

          await snapshotted(async () => {
            const a = await ctx.bundle(W, tk, side, legs, { market: true });
            if (a.price > U || a.price <= 0n) {
              averageOutOfRange++;
              return;
            }
            const before = await ctx.balance(W, tk.address);
            const result = await ctx.send(a);
            attempted++;
            if (!result.ok) {
              otherOutcomes[result.name] = (otherOutcomes[result.name] || 0) + 1;
              return;
            }
            settled++;
            const after = await ctx.balance(W, tk.address);
            const moved = side === BUY ? before - after : after - before;
            const filled = BigInt(a.filled);
            expect(moved).to.equal(side === BUY ? a.cash + a.fee : a.cash - a.fee);
            expect(side === BUY ? moved * U <= a.price * filled : moved * U >= a.price * filled).to.equal(true);
          });
        }
      }

      expect(attempted).to.equal(300);
      expect(settled).to.equal(300);
      expect(averageOutOfRange).to.equal(0);
      expect(otherOutcomes).to.deep.equal({});
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Complementary legs: the seller's fee comes out of proceeds. The buyer pays the seller
  // `cash - sellerFee` and pays `sellerFee` to the Diamond, so a seller needs no allowance.
  // Before the change the seller received `cash` and paid `sellerFee` back from its own
  // balance: buyer -(cash + buyerFee), seller +(cash - sellerFee), bank +(buyerFee + sellerFee).
  // ──────────────────────────────────────────────────────────────────────
  describe("the seller's fee on Complementary legs", function () {
    let W, F;
    const CASH = 500000n;

    before(async function () {
      W = await ctx.makeWorld(6, safes, "seller-fee");
      F = W.unit;
    });

    const DIRECTIONS = [
      { label: "a maker selling to a taker's buy", taker: () => T, side: BUY, seller: () => G, buyer: () => T, maker: () => G },
      { label: "a taker selling to a maker's bid", taker: () => TS, side: SELL, seller: () => TS, buyer: () => H, maker: () => H },
    ];

    const revokeAllowance = (safe) =>
      ctx.exec(safe, W.token.address, W.token.interface.encodeFunctionData("approve", [ctx.diamond, 0]));

    const AMOUNTS = [
      { label: "5,000 each way", buyerFee: 5000n, sellerFee: 5000n, buyerPays: 505000n, sellerGets: 495000n, bank: 10000n },
      { label: "2,000 for the buyer, 5,000 for the seller", buyerFee: 2000n, sellerFee: 5000n, buyerPays: 502000n, sellerGets: 495000n, bank: 7000n },
      { label: "10,000 each way", buyerFee: 10000n, sellerFee: 10000n, buyerPays: 510000n, sellerGets: 490000n, bank: 20000n, maxFeeRateBps: 200 },
    ];

    for (const direction of DIRECTIONS) {
      for (const amounts of AMOUNTS) {
        it(`${direction.label}, ${amounts.label}: a seller with no allowance settles and each party's amounts are the old ones`, async function () {
          await snapshotted(async () => {
            if (amounts.maxFeeRateBps) await ctx.contracts.adminConfig.setMaxFeeRate(amounts.maxFeeRateBps);
            const seller = direction.seller();
            const buyer = direction.buyer();
            await revokeAllowance(seller);
            expect(toBigInt(await W.token.allowance(seller.address, ctx.diamond))).to.equal(0n);

            const takerIsBuyer = direction.side === BUY;
            const leg = comp(direction.maker(), CASH, F, {
              takerFee: takerIsBuyer ? amounts.buyerFee : amounts.sellerFee,
              makerFee: takerIsBuyer ? amounts.sellerFee : amounts.buyerFee,
            });
            const buyerBefore = await ctx.balance(W, buyer.address);
            const sellerBefore = await ctx.balance(W, seller.address);
            const bankBefore = await ctx.accruedFees(W);
            const buyerPositionBefore = await ctx.positionBalance(buyer.address, W.posA);
            const sellerPositionBefore = await ctx.positionBalance(seller.address, W.posA);

            const a = await ctx.bundle(W, direction.taker(), direction.side, [leg], { price: CASH });
            expect((await ctx.send(a)).name).to.equal("OK");

            const buyerPaid = buyerBefore - (await ctx.balance(W, buyer.address));
            const sellerGot = (await ctx.balance(W, seller.address)) - sellerBefore;
            const bank = (await ctx.accruedFees(W)) - bankBefore;

            expect(buyerPaid).to.equal(amounts.buyerPays);
            expect(sellerGot).to.equal(amounts.sellerGets);
            expect(bank).to.equal(amounts.bank);

            // The formula from before the change.
            expect(buyerPaid).to.equal(CASH + amounts.buyerFee);
            expect(sellerGot).to.equal(CASH - amounts.sellerFee);
            expect(bank).to.equal(amounts.buyerFee + amounts.sellerFee);

            // Nothing about the seller's approvals had to change, and the position still moves.
            expect(toBigInt(await W.token.allowance(seller.address, ctx.diamond))).to.equal(0n);
            expect((await ctx.positionBalance(buyer.address, W.posA)) - buyerPositionBefore).to.equal(F);
            expect((await ctx.positionBalance(seller.address, W.posA)) - sellerPositionBefore).to.equal(-F);
          });
        });
      }
    }

    it("a seller with no allowance and no collateral at all still settles, with its proceeds net of the fee", async function () {
      await snapshotted(async () => {
        const holdings = await W.token.balanceOf(G.address);
        await ctx.exec(G, W.token.address, W.token.interface.encodeFunctionData("transfer", [ctx.signers.outsider.address, holdings]));
        await revokeAllowance(G);

        const leg = comp(G, CASH, F, { takerFee: 5000n, makerFee: 5000n });
        const a = await ctx.bundle(W, T, BUY, [leg], { price: CASH });

        expect((await ctx.send(a)).name).to.equal("OK");
        expect(await ctx.balance(W, G.address)).to.equal(495000n);
      });
    });

    it("the buyer needs exactly the old allowance: its own cash plus its own fee", async function () {
      const leg = comp(G, CASH, F, { takerFee: 5000n, makerFee: 5000n });
      const approve = (amount) =>
        ctx.exec(T, W.token.address, W.token.interface.encodeFunctionData("approve", [ctx.diamond, amount.toString()]));

      await snapshotted(async () => {
        await approve(505000n);
        expect((await ctx.send(await ctx.bundle(W, T, BUY, [leg], { price: CASH }))).name).to.equal("OK");
        expect(toBigInt(await W.token.allowance(T.address, ctx.diamond))).to.equal(0n);
      });

      await snapshotted(async () => {
        await approve(504999n);
        const r = await ctx.send(await ctx.bundle(W, T, BUY, [leg], { price: CASH }));
        expect(r.name).to.equal("ERC20InsufficientAllowance");
      });
    });

    it("mixed paths in one bundle: each leg's seller is paid net and the taker's total is the sum of the legs", async function () {
      await snapshotted(async () => {
        await revokeAllowance(G);
        const legs = [
          comp(G, 400000n, F, { takerFee: 4000n, makerFee: 4000n }),
          mint(H, 600000n, F, { takerFee: 4000n, makerFee: 6000n }),
        ];
        const takerBefore = await ctx.balance(W, T.address);
        const sellerBefore = await ctx.balance(W, G.address);
        const minterBefore = await ctx.balance(W, H.address);
        const diamondBefore = await ctx.balance(W, ctx.diamond);
        const bankBefore = await ctx.accruedFees(W);

        const a = await ctx.bundle(W, T, BUY, legs, { market: true });
        expect((await ctx.send(a)).name).to.equal("OK");

        expect(takerBefore - (await ctx.balance(W, T.address))).to.equal(808000n);
        expect((await ctx.balance(W, G.address)) - sellerBefore).to.equal(396000n);
        expect(minterBefore - (await ctx.balance(W, H.address))).to.equal(606000n);
        expect((await ctx.accruedFees(W)) - bankBefore).to.equal(18000n);
        // The Mint leg backs one full pair; everything else in the Diamond's delta is fees.
        expect((await ctx.balance(W, ctx.diamond)) - diamondBefore).to.equal(F + 18000n);
      });
    });
  });
});
