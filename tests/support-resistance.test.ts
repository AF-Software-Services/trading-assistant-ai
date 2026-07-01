import { describe, it, expect } from "vitest";
import {
  detectZones,
  isNearZone,
  getNearestZone,
  scoreZone,
} from "../src/engines/support-resistance.ts";
import type { Candle } from "../src/types/market.ts";
import type { SupportResistanceZone } from "../src/types/trading.ts";

function makeCandle(
  high: number,
  low: number,
  timestamp: number,
  pair: Candle["pair"] = "EUR/USD",
  timeframe: Candle["timeframe"] = "D"
): Candle {
  const mid = (high + low) / 2;
  return {
    timestamp,
    open:  mid - 0.0001,
    high,
    low,
    close: mid + 0.0001,
    timeframe,
    pair,
  };
}

/**
 * Build a series with a clear resistance cluster at ~1.0950
 * and a support cluster at ~1.0750.
 * lookback=3 so we need 3 bars each side of each pivot.
 */
function buildZoneCandles(tf: Candle["timeframe"] = "D"): Candle[] {
  // Use lookback=3 (default PIVOT_LOOKBACK=5 but detectZones uses detectSwingPoints default)
  // We need 3 bars each side of each pivot for PIVOT_LOOKBACK=5 we need 5 each side.
  // Build a longer series: 5 left-padding + swing + 5 right-padding per pivot
  return [
    // Left padding for HIGH 1 (5 bars)
    makeCandle(1.0810, 1.0780, 1000, "EUR/USD", tf),
    makeCandle(1.0815, 1.0782, 2000, "EUR/USD", tf),
    makeCandle(1.0812, 1.0779, 3000, "EUR/USD", tf),
    makeCandle(1.0813, 1.0780, 4000, "EUR/USD", tf),
    makeCandle(1.0811, 1.0778, 5000, "EUR/USD", tf),
    // swing HIGH 1 at 1.0952
    makeCandle(1.0952, 1.0820, 6000, "EUR/USD", tf),
    // Right padding / left padding for LOW 1 (5 bars each)
    makeCandle(1.0880, 1.0810, 7000, "EUR/USD", tf),
    makeCandle(1.0870, 1.0805, 8000, "EUR/USD", tf),
    makeCandle(1.0875, 1.0808, 9000, "EUR/USD", tf),
    makeCandle(1.0872, 1.0806, 10000, "EUR/USD", tf),
    makeCandle(1.0873, 1.0807, 11000, "EUR/USD", tf),
    // swing LOW 1 at 1.0755
    makeCandle(1.0790, 1.0755, 12000, "EUR/USD", tf),
    // bridge to HIGH 2
    makeCandle(1.0830, 1.0780, 13000, "EUR/USD", tf),
    makeCandle(1.0840, 1.0790, 14000, "EUR/USD", tf),
    makeCandle(1.0850, 1.0800, 15000, "EUR/USD", tf),
    makeCandle(1.0848, 1.0798, 16000, "EUR/USD", tf),
    makeCandle(1.0849, 1.0799, 17000, "EUR/USD", tf),
    // swing HIGH 2 at 1.0948 (within ATR*0.3 of 1.0952)
    makeCandle(1.0948, 1.0840, 18000, "EUR/USD", tf),
    // bridge to LOW 2
    makeCandle(1.0890, 1.0825, 19000, "EUR/USD", tf),
    makeCandle(1.0885, 1.0820, 20000, "EUR/USD", tf),
    makeCandle(1.0882, 1.0818, 21000, "EUR/USD", tf),
    makeCandle(1.0881, 1.0817, 22000, "EUR/USD", tf),
    makeCandle(1.0883, 1.0819, 23000, "EUR/USD", tf),
    // swing LOW 2 at 1.0758 (merges with LOW 1)
    makeCandle(1.0795, 1.0758, 24000, "EUR/USD", tf),
    // Right padding (5 bars)
    makeCandle(1.0830, 1.0785, 25000, "EUR/USD", tf),
    makeCandle(1.0840, 1.0790, 26000, "EUR/USD", tf),
    makeCandle(1.0845, 1.0795, 27000, "EUR/USD", tf),
    makeCandle(1.0843, 1.0793, 28000, "EUR/USD", tf),
    makeCandle(1.0844, 1.0794, 29000, "EUR/USD", tf),
  ];
}

describe("detectZones", () => {
  it("detects at least one resistance zone from swing highs", () => {
    const candles = buildZoneCandles();
    const atr = 0.0050;
    const zones = detectZones(candles, "D", atr);
    const resistance = zones.filter(z => z.type === "resistance");
    expect(resistance.length).toBeGreaterThanOrEqual(1);
  });

  it("detects at least one support zone from swing lows", () => {
    const candles = buildZoneCandles();
    const atr = 0.0050;
    const zones = detectZones(candles, "D", atr);
    const support = zones.filter(z => z.type === "support");
    expect(support.length).toBeGreaterThanOrEqual(1);
  });

  it("merges two pivots within ATR*0.3 into a single zone", () => {
    // HIGH 1 = 1.0952, HIGH 2 = 1.0948 — difference = 0.0004
    // ATR * 0.3 = 0.005 * 0.3 = 0.0015 — so they should merge
    const candles = buildZoneCandles();
    const atr = 0.0050;
    const zones = detectZones(candles, "D", atr);
    const resistance = zones.filter(z => z.type === "resistance");
    // Expect a zone that covers both highs
    const merged = resistance.find(z => z.touchCount >= 2);
    expect(merged).toBeTruthy();
    if (merged) {
      expect(merged.touchCount).toBeGreaterThanOrEqual(2);
    }
  });

  it("zone touch count reflects number of grouped pivots", () => {
    const candles = buildZoneCandles();
    const atr = 0.0050;
    const zones = detectZones(candles, "D", atr);
    for (const z of zones) {
      expect(z.touchCount).toBeGreaterThanOrEqual(2); // MIN_ZONE_TOUCHES
    }
  });

  it("weekly zone scores higher than 1H zone with same touch count", () => {
    const base: SupportResistanceZone = {
      pair: "EUR/USD",
      timeframe: "W",
      type: "resistance",
      low: 1.0940,
      high: 1.0960,
      midpoint: 1.0950,
      strength: 0,
      touchCount: 3,
      firstSeenAt: Date.now() - 86_400_000 * 7,
      lastTestedAt: Date.now() - 86_400_000,
      isBroken: false,
      isRetested: false,
      confidence: 0,
    };
    const weekly = scoreZone({ ...base, timeframe: "W", strength: 0 });
    const h1     = scoreZone({ ...base, timeframe: "1H", strength: 0 });
    expect(weekly).toBeGreaterThan(h1);
  });
});

describe("isNearZone", () => {
  const zone: SupportResistanceZone = {
    pair: "EUR/USD",
    timeframe: "D",
    type: "support",
    low: 1.0740,
    high: 1.0760,
    midpoint: 1.0750,
    strength: 60,
    touchCount: 3,
    firstSeenAt: Date.now() - 86_400_000 * 10,
    lastTestedAt: Date.now() - 86_400_000,
    isBroken: false,
    isRetested: false,
    confidence: 60,
  };

  it("returns true when price is within the zone", () => {
    expect(isNearZone(1.0750, zone)).toBe(true);
  });

  it("returns true when price is within tolerance outside the zone", () => {
    // Zone: 1.0740–1.0760. Height=0.002. Tol=20%=0.0004. Price=1.0736 — within tol
    expect(isNearZone(1.0736, zone)).toBe(true);
  });

  it("returns false when price is far from zone", () => {
    expect(isNearZone(1.0900, zone)).toBe(false);
  });
});

describe("getNearestZone", () => {
  const zones: SupportResistanceZone[] = [
    {
      pair: "EUR/USD", timeframe: "D", type: "support",
      low: 1.0740, high: 1.0760, midpoint: 1.0750,
      strength: 60, touchCount: 3,
      firstSeenAt: 1000, lastTestedAt: 2000,
      isBroken: false, isRetested: false, confidence: 60,
    },
    {
      pair: "EUR/USD", timeframe: "D", type: "support",
      low: 1.0620, high: 1.0640, midpoint: 1.0630,
      strength: 50, touchCount: 2,
      firstSeenAt: 1000, lastTestedAt: 2000,
      isBroken: false, isRetested: false, confidence: 50,
    },
  ];

  it("returns the nearest support zone to price", () => {
    const nearest = getNearestZone(1.0800, zones, "support");
    expect(nearest?.midpoint).toBe(1.0750);  // closer to 1.0800 than 1.0630
  });

  it("returns null when no zones of the requested type exist", () => {
    const nearest = getNearestZone(1.0800, zones, "resistance");
    expect(nearest).toBeNull();
  });
});
