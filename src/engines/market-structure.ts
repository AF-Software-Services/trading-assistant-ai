import type { Candle, Timeframe } from "../types/market.ts";
import type { MarketStructure, SwingPoint, SwingLabel, TrendBias } from "../types/trading.ts";
import { PIVOT_LOOKBACK } from "../config/index.ts";

/**
 * Detect swing highs and lows using a pivot lookback window.
 * A swing high at index i is a candle whose high is the highest
 * among the `lookback` candles to each side.
 * A swing low at index i is the mirror.
 */
export function detectSwingPoints(
  candles: Candle[],
  lookback: number = PIVOT_LOOKBACK
): SwingPoint[] {
  if (candles.length < lookback * 2 + 1) return [];

  const highs: Array<{ price: number; timestamp: number }> = [];
  const lows: Array<{ price: number; timestamp: number }> = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const candle = candles[i];
    if (!candle) continue;

    let isSwingHigh = true;
    let isSwingLow  = true;

    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      const c = candles[j];
      if (!c) continue;
      if (c.high >= candle.high) isSwingHigh = false;
      if (c.low  <= candle.low)  isSwingLow  = false;
    }

    if (isSwingHigh) highs.push({ price: candle.high, timestamp: candle.timestamp });
    if (isSwingLow)  lows.push({ price: candle.low,  timestamp: candle.timestamp });
  }

  // Label swing highs
  const labelledHighs: SwingPoint[] = [];
  for (let i = 0; i < highs.length; i++) {
    const curr = highs[i];
    const prev = highs[i - 1];
    if (!curr) continue;
    let label: SwingLabel;
    if (!prev) {
      label = "HH"; // baseline — first pivot, assume HH
    } else {
      label = curr.price > prev.price ? "HH" : "LH";
    }
    labelledHighs.push({ price: curr.price, timestamp: curr.timestamp, label, timeframe: candles[0]?.timeframe ?? "D" });
  }

  // Label swing lows
  const labelledLows: SwingPoint[] = [];
  for (let i = 0; i < lows.length; i++) {
    const curr = lows[i];
    const prev = lows[i - 1];
    if (!curr) continue;
    let label: SwingLabel;
    if (!prev) {
      label = "HL"; // baseline
    } else {
      label = curr.price > prev.price ? "HL" : "LL";
    }
    labelledLows.push({ price: curr.price, timestamp: curr.timestamp, label, timeframe: candles[0]?.timeframe ?? "D" });
  }

  // Merge and sort by timestamp
  const all = [...labelledHighs, ...labelledLows].sort((a, b) => a.timestamp - b.timestamp);
  return all;
}

/**
 * Classify trend from the last N swing points.
 * Uses the last 4 points, checking the balance of bullish vs bearish labels.
 */
export function classifyTrend(swingPoints: SwingPoint[]): TrendBias {
  if (swingPoints.length < 2) return "unclear";

  const recent = swingPoints.slice(-6);

  let bullish = 0;
  let bearish = 0;

  for (const sp of recent) {
    if (sp.label === "HH" || sp.label === "HL") bullish++;
    if (sp.label === "LH" || sp.label === "LL") bearish++;
  }

  if (bullish >= 3 && bearish <= 1) return "uptrend";
  if (bearish >= 3 && bullish <= 1) return "downtrend";
  if (bullish > 0 && bearish > 0)   return "range";
  return "unclear";
}

/**
 * Full market structure analysis for a given candle array and timeframe.
 */
export function analyseMarketStructure(
  candles: Candle[],
  timeframe: Timeframe
): MarketStructure {
  const pair = candles[0]?.pair ?? "EUR/USD";
  const swingPoints = detectSwingPoints(candles);
  const trend = classifyTrend(swingPoints);

  const highs = swingPoints.filter(sp => sp.label === "HH" || sp.label === "LH");
  const lows  = swingPoints.filter(sp => sp.label === "HL" || sp.label === "LL");

  const lastHigh = highs.length > 0 ? (highs[highs.length - 1]?.price ?? null) : null;
  const lastLow  = lows.length  > 0 ? (lows[lows.length  - 1]?.price ?? null) : null;

  return {
    pair,
    timeframe,
    trend,
    swingPoints,
    lastHigh,
    lastLow,
    analysedAt: Date.now(),
  };
}
