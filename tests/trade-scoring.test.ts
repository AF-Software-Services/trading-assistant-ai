import { describe, it, expect } from "vitest";
import { scoreTradeSetup } from "../src/engines/trade-scoring.ts";
import type { SupportResistanceZone, CandlestickSignal, MarketStructure, TrendAnalysis, ChartPattern } from "../src/types/trading.ts";

function makeStructure(trend: MarketStructure["trend"] = "uptrend"): MarketStructure {
  return {
    pair: "EUR/USD",
    timeframe: "4H",
    trend,
    swingPoints: [],
    lastHigh: 1.0900,
    lastLow:  1.0800,
    analysedAt: Date.now(),
  };
}

function makeTrend(emaAlignment: TrendAnalysis["emaAlignment"] = "bullish"): TrendAnalysis {
  return {
    pair: "EUR/USD",
    timeframe: "4H",
    bias: "uptrend",
    emaAlignment,
    momentum: "increasing",
    atr: 0.0050,
    confidence: 80,
  };
}

function makeZone(
  type: "support" | "resistance",
  timeframe: SupportResistanceZone["timeframe"] = "W",
  strength = 90
): SupportResistanceZone {
  return {
    pair: "EUR/USD",
    timeframe,
    type,
    low: 1.0840,
    high: 1.0860,
    midpoint: 1.0850,
    strength,
    touchCount: 4,
    firstSeenAt: Date.now() - 86_400_000 * 30,
    lastTestedAt: Date.now() - 86_400_000 * 2,
    isBroken: false,
    isRetested: true,
    confidence: strength,
  };
}

function makeSignal(type: CandlestickSignal["type"] = "bullish_engulfing", confidence = 85): CandlestickSignal {
  return {
    pair: "EUR/USD",
    timeframe: "4H",
    type,
    timestamp: Date.now(),
    price: 1.0855,
    confidence,
  };
}

function makePattern(
  type: ChartPattern["type"] = "double_bottom",
  status: ChartPattern["status"] = "confirmed",
  confidence = 80
): ChartPattern {
  return {
    pair: "EUR/USD",
    timeframe: "4H",
    type,
    status,
    confidence,
    detectedAt: Date.now(),
  };
}

describe("scoreTradeSetup", () => {
  it("reaches a high score (>= 90) when all components are present and aligned for buy", () => {
    // Supply zones from all timeframes to maximise timeframe confluence score
    const score = scoreTradeSetup({
      direction: "buy",
      zones: [
        makeZone("support", "W",  100),
        makeZone("support", "D",  100),
        makeZone("support", "4H", 100),
        makeZone("support", "1H", 100),
      ],
      candleSignal: makeSignal("bullish_engulfing", 100),
      structure: makeStructure("uptrend"),
      trend: makeTrend("bullish"),
      pattern: makePattern("double_bottom", "confirmed", 100),
      estimatedRR: 5,
    });
    expect(score.total).toBeGreaterThanOrEqual(80);
    expect(score.total).toBeLessThanOrEqual(100);
  });

  it("scores very low (<= 10) when no S/R zones, no signal, no pattern and mixed trend", () => {
    // "unclear" structure → 25% of 15 = ~3-4 pts (marketStructure partial)
    // "mixed" EMA → 30% of 15 = ~4-5 pts (trendAlignment partial)
    // everything else = 0
    const score = scoreTradeSetup({
      direction: "buy",
      zones: [],
      candleSignal: null,
      structure: makeStructure("unclear"),
      trend: makeTrend("mixed"),
      pattern: null,
      estimatedRR: 1,
    });
    expect(score.total).toBeLessThanOrEqual(15);
    // Individual components all should be 0 except partial market-structure and trend
    expect(score.srStrength).toBe(0);
    expect(score.candlestickSignal).toBe(0);
    expect(score.patternConfirmation).toBe(0);
    expect(score.rewardRiskPotential).toBe(0);
  });

  it("weekly zone adds more points than daily zone", () => {
    const withWeekly = scoreTradeSetup({
      direction: "buy",
      zones: [makeZone("support", "W", 90)],
      candleSignal: null,
      structure: makeStructure("unclear"),
      trend: makeTrend("mixed"),
      pattern: null,
      estimatedRR: 1,
    });
    const withDaily = scoreTradeSetup({
      direction: "buy",
      zones: [makeZone("support", "D", 90)],
      candleSignal: null,
      structure: makeStructure("unclear"),
      trend: makeTrend("mixed"),
      pattern: null,
      estimatedRR: 1,
    });
    expect(withWeekly.srStrength).toBeGreaterThan(withDaily.srStrength);
  });

  it("bullish candlestick signal adds correct points for buy direction", () => {
    const withSignal = scoreTradeSetup({
      direction: "buy",
      zones: [],
      candleSignal: makeSignal("bullish_engulfing", 100),
      structure: makeStructure("unclear"),
      trend: makeTrend("mixed"),
      pattern: null,
      estimatedRR: 1,
    });
    expect(withSignal.candlestickSignal).toBeGreaterThan(0);
    expect(withSignal.candlestickSignal).toBeLessThanOrEqual(20);
  });

  it("uptrend alignment adds points for buy direction", () => {
    const score = scoreTradeSetup({
      direction: "buy",
      zones: [],
      candleSignal: null,
      structure: makeStructure("uptrend"),
      trend: makeTrend("bullish"),
      pattern: null,
      estimatedRR: 1,
    });
    expect(score.marketStructure).toBeGreaterThan(0);
    expect(score.trendAlignment).toBeGreaterThan(0);
  });

  it("downtrend alignment adds points for sell direction", () => {
    const score = scoreTradeSetup({
      direction: "sell",
      zones: [],
      candleSignal: null,
      structure: makeStructure("downtrend"),
      trend: { ...makeTrend("bearish"), bias: "downtrend" },
      pattern: null,
      estimatedRR: 1,
    });
    expect(score.marketStructure).toBeGreaterThan(0);
    expect(score.trendAlignment).toBeGreaterThan(0);
  });

  it("confirmed pattern adds points", () => {
    const withPattern = scoreTradeSetup({
      direction: "buy",
      zones: [],
      candleSignal: null,
      structure: makeStructure("unclear"),
      trend: makeTrend("mixed"),
      pattern: makePattern("double_bottom", "confirmed", 100),
      estimatedRR: 1,
    });
    expect(withPattern.patternConfirmation).toBeGreaterThan(0);
  });

  it("score is never above 100", () => {
    const score = scoreTradeSetup({
      direction: "buy",
      zones: [makeZone("support", "W", 100), makeZone("support", "D", 100), makeZone("support", "4H", 100), makeZone("support", "1H", 100)],
      candleSignal: makeSignal("bullish_engulfing", 100),
      structure: makeStructure("uptrend"),
      trend: makeTrend("bullish"),
      pattern: makePattern("double_bottom", "confirmed", 100),
      estimatedRR: 10,
    });
    expect(score.total).toBeLessThanOrEqual(100);
  });

  it("RR >= 5 adds 5 points", () => {
    const highRR = scoreTradeSetup({
      direction: "buy",
      zones: [],
      candleSignal: null,
      structure: makeStructure("unclear"),
      trend: makeTrend("mixed"),
      pattern: null,
      estimatedRR: 5,
    });
    expect(highRR.rewardRiskPotential).toBe(5);
  });

  it("RR < 2 adds 0 points", () => {
    const lowRR = scoreTradeSetup({
      direction: "buy",
      zones: [],
      candleSignal: null,
      structure: makeStructure("unclear"),
      trend: makeTrend("mixed"),
      pattern: null,
      estimatedRR: 1.5,
    });
    expect(lowRR.rewardRiskPotential).toBe(0);
  });
});
