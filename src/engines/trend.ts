import type { Candle, Timeframe } from "../types/market.ts";
import type { MarketStructure, TrendAnalysis, TrendBias } from "../types/trading.ts";
import { EMA_PERIODS, ATR_PERIOD } from "../config/index.ts";

/**
 * Calculate EMA for a candle series. Returns array aligned with input (same length).
 * Values at indices before enough data is available are seeded from the SMA.
 */
export function calculateEMA(candles: Candle[], period: number): number[] {
  if (candles.length === 0) return [];
  const multiplier = 2 / (period + 1);
  const result: number[] = [];

  // Seed from first SMA
  let sum = 0;
  const seedLen = Math.min(period, candles.length);
  for (let i = 0; i < seedLen; i++) {
    sum += candles[i]?.close ?? 0;
  }
  let ema = sum / seedLen;

  for (let i = 0; i < candles.length; i++) {
    if (i < seedLen - 1) {
      // Fill early values with NaN-equivalent (0 sentinel) — consumer must check
      result.push(0);
    } else if (i === seedLen - 1) {
      result.push(ema);
    } else {
      const close = candles[i]?.close ?? ema;
      ema = close * multiplier + ema * (1 - multiplier);
      result.push(ema);
    }
  }

  return result;
}

/**
 * Calculate Average True Range (ATR) using Wilder's smoothing.
 */
export function calculateATR(candles: Candle[], period: number = ATR_PERIOD): number {
  if (candles.length < 2) return 0;

  const trValues: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];
    if (!curr || !prev) continue;
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low  - prev.close)
    );
    trValues.push(tr);
  }

  if (trValues.length === 0) return 0;
  const len = Math.min(period, trValues.length);

  // Seed ATR from simple average of first `len` true ranges
  let atr = 0;
  for (let i = 0; i < len; i++) {
    atr += trValues[i] ?? 0;
  }
  atr /= len;

  // Wilder's smoothing for subsequent values
  for (let i = len; i < trValues.length; i++) {
    atr = (atr * (period - 1) + (trValues[i] ?? 0)) / period;
  }

  return atr;
}

/**
 * Determine EMA alignment from the last valid EMA values.
 */
function emaAlignment(
  ema9:  number[],
  ema21: number[],
  ema50: number[],
  atr: number
): TrendAnalysis["emaAlignment"] {
  const e9  = ema9[ema9.length - 1]   ?? 0;
  const e21 = ema21[ema21.length - 1] ?? 0;
  const e50 = ema50[ema50.length - 1] ?? 0;

  // All within ATR * 0.1 → flat
  const flatThreshold = atr * 0.1;
  if (
    Math.abs(e9 - e21) < flatThreshold &&
    Math.abs(e21 - e50) < flatThreshold
  ) {
    return "flat";
  }

  if (e9 > e21 && e21 > e50) return "bullish";
  if (e9 < e21 && e21 < e50) return "bearish";
  return "mixed";
}

/**
 * Assess momentum by comparing close to previous close direction vs EMA slope.
 */
function assessMomentum(candles: Candle[], ema9: number[]): TrendAnalysis["momentum"] {
  if (candles.length < 3 || ema9.length < 3) return "neutral";

  const e9Now  = ema9[ema9.length - 1] ?? 0;
  const e9Prev = ema9[ema9.length - 2] ?? 0;
  const e9Two  = ema9[ema9.length - 3] ?? 0;

  const slopeNow  = e9Now  - e9Prev;
  const slopePrev = e9Prev - e9Two;

  if (slopeNow > slopePrev) return "increasing";
  if (slopeNow < slopePrev) return "decreasing";
  return "neutral";
}

/**
 * Combine EMA analysis with market structure bias to produce a TrendAnalysis.
 */
export function analyseTrend(
  candles: Candle[],
  structure: MarketStructure
): TrendAnalysis {
  const pair = candles[0]?.pair ?? "EUR/USD";
  const timeframe: Timeframe = candles[0]?.timeframe ?? "D";

  const ema9  = calculateEMA(candles, EMA_PERIODS.fast);
  const ema21 = calculateEMA(candles, EMA_PERIODS.slow);
  const ema50 = calculateEMA(candles, EMA_PERIODS.trend);
  const atr   = calculateATR(candles);

  const alignment = emaAlignment(ema9, ema21, ema50, atr);
  const momentum  = assessMomentum(candles, ema9);

  // Combine EMA alignment with market structure trend
  let bias: TrendBias;
  if (alignment === "bullish" && (structure.trend === "uptrend" || structure.trend === "unclear")) {
    bias = "uptrend";
  } else if (alignment === "bearish" && (structure.trend === "downtrend" || structure.trend === "unclear")) {
    bias = "downtrend";
  } else if (alignment === "flat") {
    bias = "range";
  } else if (alignment === "mixed") {
    bias = structure.trend; // fall back to market structure
  } else {
    bias = structure.trend;
  }

  // Confidence: how well EMA and structure agree
  const emaStructureAgree =
    (alignment === "bullish" && structure.trend === "uptrend") ||
    (alignment === "bearish" && structure.trend === "downtrend") ||
    (alignment === "flat"    && structure.trend === "range");

  const confidence = emaStructureAgree ? 80 : 50;

  return {
    pair,
    timeframe,
    bias,
    emaAlignment: alignment,
    momentum,
    atr,
    confidence,
  };
}
