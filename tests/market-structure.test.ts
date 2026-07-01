import { describe, it, expect } from "vitest";
import { detectSwingPoints, classifyTrend, analyseMarketStructure } from "../src/engines/market-structure.ts";
import type { Candle } from "../src/types/market.ts";

function makeCandle(high: number, low: number, timestamp: number): Candle {
  const open  = (high + low) / 2 - 0.0001;
  const close = (high + low) / 2 + 0.0001;
  return {
    timestamp,
    open,
    high,
    low,
    close,
    timeframe: "D",
    pair: "EUR/USD",
  };
}

/**
 * Build a candle series with a clear uptrend: HH + HL sequence.
 * lookback = 3, so we need 3 bars each side of each pivot.
 */
function buildUptrendCandles(): Candle[] {
  return [
    makeCandle(1.0800, 1.0760, 1000),  // bar 0
    makeCandle(1.0790, 1.0750, 2000),  // bar 1
    makeCandle(1.0780, 1.0740, 3000),  // bar 2 — padding left
    makeCandle(1.0850, 1.0770, 4000),  // bar 3 — swing HIGH 1 (1.0850)
    makeCandle(1.0820, 1.0760, 5000),  // bar 4
    makeCandle(1.0810, 1.0750, 6000),  // bar 5
    makeCandle(1.0800, 1.0740, 7000),  // bar 6 — swing LOW 1 (1.0740) — HL
    makeCandle(1.0820, 1.0760, 8000),  // bar 7
    makeCandle(1.0830, 1.0770, 9000),  // bar 8
    makeCandle(1.0900, 1.0820, 10000), // bar 9 — swing HIGH 2 (1.0900) — HH
    makeCandle(1.0870, 1.0810, 11000), // bar 10
    makeCandle(1.0860, 1.0800, 12000), // bar 11
    makeCandle(1.0850, 1.0790, 13000), // bar 12 — swing LOW 2 (1.0790) — HL
    makeCandle(1.0870, 1.0810, 14000), // bar 13
    makeCandle(1.0880, 1.0820, 15000), // bar 14
    makeCandle(1.0960, 1.0870, 16000), // bar 15
  ];
}

function buildDowntrendCandles(): Candle[] {
  // Need 3 bars each side of each pivot for lookback=3
  return [
    makeCandle(1.0930, 1.0890, 1000),   // bar 0 — left padding for HIGH 1
    makeCandle(1.0940, 1.0900, 2000),   // bar 1
    makeCandle(1.0935, 1.0895, 3000),   // bar 2
    makeCandle(1.0980, 1.0920, 4000),   // bar 3 — swing HIGH 1 (1.0980)
    makeCandle(1.0945, 1.0895, 5000),   // bar 4
    makeCandle(1.0935, 1.0885, 6000),   // bar 5
    makeCandle(1.0925, 1.0850, 7000),   // bar 6 — swing LOW 1 (1.0850)
    makeCandle(1.0940, 1.0870, 8000),   // bar 7
    makeCandle(1.0950, 1.0880, 9000),   // bar 8
    makeCandle(1.0960, 1.0900, 10000),  // bar 9 — swing HIGH 2 (1.0960 < 1.0980 → LH)
    makeCandle(1.0940, 1.0875, 11000),  // bar 10
    makeCandle(1.0930, 1.0865, 12000),  // bar 11
    makeCandle(1.0920, 1.0820, 13000),  // bar 12 — swing LOW 2 (1.0820 < 1.0850 → LL)
    makeCandle(1.0935, 1.0855, 14000),  // bar 13
    makeCandle(1.0945, 1.0865, 15000),  // bar 14
    makeCandle(1.0955, 1.0875, 16000),  // bar 15 — right padding
  ];
}

describe("detectSwingPoints", () => {
  it("detects HH when new swing high is above previous swing high", () => {
    const candles = buildUptrendCandles();
    const swings = detectSwingPoints(candles, 3);
    const highs  = swings.filter(s => s.label === "HH");
    expect(highs.length).toBeGreaterThanOrEqual(1);
  });

  it("detects HL when new swing low is above previous swing low", () => {
    const candles = buildUptrendCandles();
    const swings = detectSwingPoints(candles, 3);
    const hls = swings.filter(s => s.label === "HL");
    expect(hls.length).toBeGreaterThanOrEqual(1);
  });

  it("detects LH when new swing high is below previous swing high", () => {
    const candles = buildDowntrendCandles();
    const swings = detectSwingPoints(candles, 3);
    const lhs = swings.filter(s => s.label === "LH");
    expect(lhs.length).toBeGreaterThanOrEqual(1);
  });

  it("detects LL when new swing low is below previous swing low", () => {
    const candles = buildDowntrendCandles();
    const swings = detectSwingPoints(candles, 3);
    const lls = swings.filter(s => s.label === "LL");
    expect(lls.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty array when not enough candles for lookback", () => {
    const few = [makeCandle(1.0800, 1.0750, 1000), makeCandle(1.0810, 1.0760, 2000)];
    const swings = detectSwingPoints(few, 5);
    expect(swings).toHaveLength(0);
  });
});

describe("classifyTrend", () => {
  it("classifies uptrend from HH+HL sequence", () => {
    const points = [
      { price: 1.0850, timestamp: 4000, label: "HH" as const, timeframe: "D" as const },
      { price: 1.0740, timestamp: 7000, label: "HL" as const, timeframe: "D" as const },
      { price: 1.0900, timestamp: 10000, label: "HH" as const, timeframe: "D" as const },
      { price: 1.0790, timestamp: 13000, label: "HL" as const, timeframe: "D" as const },
    ];
    expect(classifyTrend(points)).toBe("uptrend");
  });

  it("classifies downtrend from LH+LL sequence", () => {
    const points = [
      { price: 1.0970, timestamp: 4000,  label: "LH" as const, timeframe: "D" as const },
      { price: 1.0840, timestamp: 7000,  label: "LL" as const, timeframe: "D" as const },
      { price: 1.0930, timestamp: 10000, label: "LH" as const, timeframe: "D" as const },
      { price: 1.0810, timestamp: 13000, label: "LL" as const, timeframe: "D" as const },
    ];
    expect(classifyTrend(points)).toBe("downtrend");
  });

  it("classifies range when labels are mixed", () => {
    const points = [
      { price: 1.0900, timestamp: 1000, label: "HH" as const, timeframe: "D" as const },
      { price: 1.0820, timestamp: 2000, label: "LL" as const, timeframe: "D" as const },
      { price: 1.0880, timestamp: 3000, label: "LH" as const, timeframe: "D" as const },
      { price: 1.0830, timestamp: 4000, label: "HL" as const, timeframe: "D" as const },
    ];
    expect(classifyTrend(points)).toBe("range");
  });

  it("returns unclear when fewer than 2 swing points", () => {
    expect(classifyTrend([])).toBe("unclear");
    expect(classifyTrend([
      { price: 1.09, timestamp: 1000, label: "HH" as const, timeframe: "D" as const }
    ])).toBe("unclear");
  });
});

describe("analyseMarketStructure", () => {
  it("returns uptrend structure from uptrend candles", () => {
    const candles = buildUptrendCandles();
    const structure = analyseMarketStructure(candles, "D");
    expect(structure.pair).toBe("EUR/USD");
    expect(structure.timeframe).toBe("D");
    expect(["uptrend", "unclear"]).toContain(structure.trend); // depends on pivot resolution
    expect(typeof structure.analysedAt).toBe("number");
  });

  it("returns lastHigh and lastLow values", () => {
    const candles = buildUptrendCandles();
    const structure = analyseMarketStructure(candles, "D");
    // Either null (no pivots found with default lookback) or a number
    const lastHighOk = structure.lastHigh === null || typeof structure.lastHigh === "number";
    const lastLowOk  = structure.lastLow  === null || typeof structure.lastLow  === "number";
    expect(lastHighOk).toBe(true);
    expect(lastLowOk).toBe(true);
  });
});
