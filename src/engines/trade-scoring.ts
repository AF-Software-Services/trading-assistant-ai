import type { Direction } from "../types/trading.ts";
import type { SupportResistanceZone, CandlestickSignal, MarketStructure, TrendAnalysis, ChartPattern, ScoreBreakdown } from "../types/trading.ts";

// Maximum points per component
const MAX_SR_STRENGTH       = 20;
const MAX_TF_IMPORTANCE     = 15;
const MAX_CANDLESTICK       = 20;
const MAX_MARKET_STRUCTURE  = 15;
const MAX_TREND_ALIGNMENT   = 15;
const MAX_PATTERN           = 10;
const MAX_RR_POTENTIAL      = 5;

const TIMEFRAME_ZONE_SCORES: Record<string, number> = {
  W:    MAX_SR_STRENGTH,      // 20
  D:    15,
  "4H": 10,
  "1H": 5,
};

/**
 * Score a potential trade setup from 0–100 across 7 components.
 */
export function scoreTradeSetup(params: {
  direction: Direction;
  zones: SupportResistanceZone[];
  candleSignal: CandlestickSignal | null;
  structure: MarketStructure;
  trend: TrendAnalysis;
  pattern: ChartPattern | null;
  estimatedRR: number;
}): ScoreBreakdown {
  const { direction, zones, candleSignal, structure, trend, pattern, estimatedRR } = params;

  // --- SR Strength ---
  // Find the strongest relevant zone (support for buy, resistance for sell)
  const relevantType = direction === "buy" ? "support" : "resistance";
  const relevantZones = zones.filter(z => z.type === relevantType && !z.isBroken);

  let srStrength = 0;
  if (relevantZones.length > 0) {
    const best = relevantZones.reduce((a, b) => a.strength > b.strength ? a : b);
    // Scale zone strength (0–100) to max points based on timeframe
    const maxForTf = TIMEFRAME_ZONE_SCORES[best.timeframe] ?? 5;
    srStrength = Math.round((best.strength / 100) * maxForTf);
  }

  // --- Timeframe Importance (confluence) ---
  // Count distinct timeframes that have a relevant zone near price
  const timeframeSet = new Set(relevantZones.map(z => z.timeframe));
  const tfCount = timeframeSet.size;
  const timeframeImportance = Math.min(tfCount * 5, MAX_TF_IMPORTANCE);

  // --- Candlestick Signal ---
  let candlestickSignal = 0;
  if (candleSignal) {
    const dirMatch =
      (direction === "buy"  && candleSignal.type === "bullish_engulfing") ||
      (direction === "sell" && candleSignal.type === "bearish_engulfing") ||
      (direction === "buy"  && (candleSignal.type === "hammer" || candleSignal.type === "pin_bar")) ||
      (direction === "sell" && (candleSignal.type === "shooting_star" || candleSignal.type === "pin_bar"));
    if (dirMatch) {
      candlestickSignal = Math.round((candleSignal.confidence / 100) * MAX_CANDLESTICK);
    } else {
      // Opposing signal — partial penalty
      candlestickSignal = Math.round((candleSignal.confidence / 100) * MAX_CANDLESTICK * 0.3);
    }
  }

  // --- Market Structure ---
  let marketStructure = 0;
  const structureTrend = structure.trend;
  if (
    (direction === "buy"  && structureTrend === "uptrend") ||
    (direction === "sell" && structureTrend === "downtrend")
  ) {
    marketStructure = MAX_MARKET_STRUCTURE; // Full marks for trend alignment
  } else if (structureTrend === "range") {
    marketStructure = Math.round(MAX_MARKET_STRUCTURE * 0.5);
  } else if (structureTrend === "unclear") {
    marketStructure = Math.round(MAX_MARKET_STRUCTURE * 0.25);
  }
  // Opposing trend = 0

  // --- Trend Alignment ---
  let trendAlignment = 0;
  const ema = trend.emaAlignment;
  if (
    (direction === "buy"  && ema === "bullish") ||
    (direction === "sell" && ema === "bearish")
  ) {
    trendAlignment = Math.round((trend.confidence / 100) * MAX_TREND_ALIGNMENT);
  } else if (ema === "mixed" || ema === "flat") {
    trendAlignment = Math.round(MAX_TREND_ALIGNMENT * 0.3);
  }

  // --- Pattern Confirmation ---
  let patternConfirmation = 0;
  if (pattern && pattern.status === "confirmed") {
    const patternDirectionMatch =
      (direction === "buy"  && (pattern.type === "double_bottom" || pattern.type === "inverse_head_and_shoulders")) ||
      (direction === "sell" && (pattern.type === "double_top"    || pattern.type === "head_and_shoulders"));
    if (patternDirectionMatch) {
      patternConfirmation = Math.round((pattern.confidence / 100) * MAX_PATTERN);
    }
  } else if (pattern && pattern.status === "forming") {
    patternConfirmation = Math.round(MAX_PATTERN * 0.4);
  }

  // --- R:R Potential ---
  let rewardRiskPotential = 0;
  if (estimatedRR >= 5) {
    rewardRiskPotential = 5;
  } else if (estimatedRR >= 3) {
    rewardRiskPotential = 3;
  } else if (estimatedRR >= 2) {
    rewardRiskPotential = 1;
  }

  const total = Math.min(
    100,
    srStrength +
    timeframeImportance +
    candlestickSignal +
    marketStructure +
    trendAlignment +
    patternConfirmation +
    rewardRiskPotential
  );

  return {
    srStrength,
    timeframeImportance,
    candlestickSignal,
    marketStructure,
    trendAlignment,
    patternConfirmation,
    rewardRiskPotential,
    total,
  };
}
