import { describe, it, expect } from "vitest";
import { detectBullishEngulfing, detectBearishEngulfing, detectAllSignals } from "../src/engines/candlestick.ts";
import type { Candle } from "../src/types/market.ts";

function makeCandle(
  open: number,
  close: number,
  opts: Partial<Candle> = {}
): Candle {
  const high = Math.max(open, close) + 0.0005;
  const low  = Math.min(open, close) - 0.0005;
  return {
    timestamp: opts.timestamp ?? Date.now(),
    open,
    high,
    low,
    close,
    timeframe: opts.timeframe ?? "4H",
    pair:      opts.pair ?? "EUR/USD",
    ...opts,
  };
}

describe("detectBullishEngulfing", () => {
  it("detects bullish engulfing when current candle fully engulfs previous bearish candle", () => {
    // prev: bearish (1.0900 → 1.0850)
    // curr: bullish open below prev close, close above prev open → full engulf
    const candles: Candle[] = [
      makeCandle(1.0900, 1.0850, { timestamp: 1000 }),          // bearish
      makeCandle(1.0840, 1.0920, { timestamp: 2000 }),          // bullish, engulfs
    ];
    const signals = detectBullishEngulfing(candles);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.type).toBe("bullish_engulfing");
  });

  it("does NOT detect bullish engulfing on partial engulf (current close < previous open)", () => {
    // prev: bearish 1.0900 → 1.0850
    // curr: bullish but close only at 1.0890 — does not reach prev open (1.0900)
    const candles: Candle[] = [
      makeCandle(1.0900, 1.0850, { timestamp: 1000 }),
      makeCandle(1.0845, 1.0890, { timestamp: 2000 }),  // close < prev open
    ];
    const signals = detectBullishEngulfing(candles);
    expect(signals).toHaveLength(0);
  });

  it("does NOT detect bullish engulfing when previous candle is bullish", () => {
    const candles: Candle[] = [
      makeCandle(1.0850, 1.0910, { timestamp: 1000 }),  // bullish prev
      makeCandle(1.0840, 1.0920, { timestamp: 2000 }),  // bullish curr
    ];
    const signals = detectBullishEngulfing(candles);
    expect(signals).toHaveLength(0);
  });

  it("does NOT detect bullish engulfing when current candle is bearish", () => {
    const candles: Candle[] = [
      makeCandle(1.0900, 1.0850, { timestamp: 1000 }),  // bearish prev
      makeCandle(1.0920, 1.0840, { timestamp: 2000 }),  // bearish curr
    ];
    const signals = detectBullishEngulfing(candles);
    expect(signals).toHaveLength(0);
  });

  it("does NOT detect signal on doji (open == close)", () => {
    const doji: Candle = {
      timestamp: 2000, open: 1.0880, high: 1.0900, low: 1.0860, close: 1.0880,
      timeframe: "4H", pair: "EUR/USD",
    };
    const prev = makeCandle(1.0900, 1.0850, { timestamp: 1000 });
    const signals = detectBullishEngulfing([prev, doji]);
    expect(signals).toHaveLength(0);
  });

  it("does NOT detect when prev candle is a doji (zero body)", () => {
    // Doji prev: engulfing a zero-body candle is meaningless
    const doji = makeCandle(1.0880, 1.0880, { timestamp: 1000 });
    const curr  = makeCandle(1.0870, 1.0920, { timestamp: 2000 });
    const signals = detectBullishEngulfing([doji, curr]);
    expect(signals).toHaveLength(0);
  });

  it("does NOT detect when current body equals previous body (must be strictly larger)", () => {
    // Both bodies are 50 pips — equal, not an engulf
    const prev = makeCandle(1.0900, 1.0850, { timestamp: 1000 }); // body: 50
    const curr = makeCandle(1.0845, 1.0895, { timestamp: 2000 }); // body: 50, same size
    const signals = detectBullishEngulfing([prev, curr]);
    expect(signals).toHaveLength(0);
  });

  it("does NOT detect when current open equals previous close (not strictly below)", () => {
    // curr.open === prev.close — just touching, not opening below
    const prev = makeCandle(1.0900, 1.0850, { timestamp: 1000 });
    const curr = makeCandle(1.0850, 1.0920, { timestamp: 2000 }); // open == prev close
    const signals = detectBullishEngulfing([prev, curr]);
    expect(signals).toHaveLength(0);
  });
});

describe("detectBearishEngulfing", () => {
  it("detects bearish engulfing when current bearish candle fully engulfs previous bullish candle", () => {
    // prev: bullish 1.0850 → 1.0900
    // curr: bearish open >= prev close, close <= prev open
    const candles: Candle[] = [
      makeCandle(1.0850, 1.0900, { timestamp: 1000 }),  // bullish
      makeCandle(1.0910, 1.0840, { timestamp: 2000 }),  // bearish, engulfs
    ];
    const signals = detectBearishEngulfing(candles);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.type).toBe("bearish_engulfing");
  });

  it("does NOT detect bearish engulfing on partial engulf", () => {
    // prev: bullish 1.0850 → 1.0900
    // curr: bearish but close only at 1.0860 — does not reach prev open (1.0850)
    const candles: Candle[] = [
      makeCandle(1.0850, 1.0900, { timestamp: 1000 }),
      makeCandle(1.0905, 1.0860, { timestamp: 2000 }),  // close > prev open
    ];
    const signals = detectBearishEngulfing(candles);
    expect(signals).toHaveLength(0);
  });

  it("does NOT detect bearish engulfing when previous candle is bearish", () => {
    const candles: Candle[] = [
      makeCandle(1.0900, 1.0840, { timestamp: 1000 }),  // bearish prev
      makeCandle(1.0920, 1.0830, { timestamp: 2000 }),  // bearish curr
    ];
    const signals = detectBearishEngulfing(candles);
    expect(signals).toHaveLength(0);
  });
});

describe("detectAllSignals", () => {
  it("detects both bullish and bearish signals in a sequence", () => {
    const candles: Candle[] = [
      makeCandle(1.0900, 1.0850, { timestamp: 1000 }),  // bearish
      makeCandle(1.0840, 1.0920, { timestamp: 2000 }),  // bullish engulfing
      makeCandle(1.0930, 1.0830, { timestamp: 3000 }),  // bearish engulfing
    ];
    const signals = detectAllSignals(candles);
    expect(signals.length).toBeGreaterThanOrEqual(2);
    const types = signals.map(s => s.type);
    expect(types).toContain("bullish_engulfing");
    expect(types).toContain("bearish_engulfing");
  });

  it("returns no signals on flat/doji candles", () => {
    const flat: Candle[] = [
      { timestamp: 1000, open: 1.0880, high: 1.0885, low: 1.0875, close: 1.0880, timeframe: "4H", pair: "EUR/USD" },
      { timestamp: 2000, open: 1.0880, high: 1.0885, low: 1.0875, close: 1.0881, timeframe: "4H", pair: "EUR/USD" },
    ];
    const signals = detectAllSignals(flat);
    expect(signals).toHaveLength(0);
  });
});
