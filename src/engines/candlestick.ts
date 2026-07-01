import type { Candle } from "../types/market.ts";
import type { CandlestickSignal, SupportResistanceZone } from "../types/trading.ts";
import { isNearZone } from "./support-resistance.ts";

const TIMEFRAME_WEIGHT: Record<string, number> = {
  W:  1.0,
  D:  0.85,
  "4H": 0.70,
  "1H": 0.55,
};

/**
 * Calculate body size as fraction of total range.
 */
function bodyRatio(candle: Candle): number {
  const range = candle.high - candle.low;
  if (range === 0) return 0;
  return Math.abs(candle.close - candle.open) / range;
}

/**
 * Engulf ratio: how much of the previous body the current body covers.
 * > 1.0 means full engulf.
 */
function engulfRatio(current: Candle, previous: Candle): number {
  const prevBody = Math.abs(previous.close - previous.open);
  const currBody = Math.abs(current.close  - current.open);
  if (prevBody === 0) return 0;
  return currBody / prevBody;
}

/**
 * Base confidence from engulf ratio and body ratio.
 * Adjusted upward when the signal occurs near a relevant S/R zone.
 */
function engulfConfidence(
  current: Candle,
  previous: Candle,
  zones: SupportResistanceZone[],
  signalType: "bullish_engulfing" | "bearish_engulfing"
): number {
  const er   = engulfRatio(current, previous);
  const br   = bodyRatio(current);
  const tfW  = TIMEFRAME_WEIGHT[current.timeframe] ?? 0.55;

  // Base score from engulf ratio (bigger = better, capped at 1.5x = max)
  const erScore = Math.min(er / 1.5, 1.0) * 50;
  // Body dominance score
  const brScore = br * 30;
  // Timeframe score
  const tfScore = tfW * 20;

  let confidence = erScore + brScore + tfScore;

  // Zone bonus: +10 if occurring at a relevant zone
  const relevantType = signalType === "bullish_engulfing" ? "support" : "resistance";
  const nearRelevant = zones.some(
    z => z.type === relevantType && isNearZone(current.close, z)
  );
  if (nearRelevant) confidence = Math.min(confidence + 10, 100);

  return Math.round(Math.min(confidence, 100));
}

/**
 * Detect bullish engulfing patterns on closed candles.
 * Conditions:
 * - Previous candle is bearish (close < open)
 * - Current candle is bullish (close > open)
 * - Current open <= previous close
 * - Current close >= previous open
 */
export function detectBullishEngulfing(
  candles: Candle[],
  zones: SupportResistanceZone[] = []
): CandlestickSignal[] {
  const signals: CandlestickSignal[] = [];

  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    if (!prev || !curr) continue;

    const prevBearish = prev.close < prev.open;
    const currBullish = curr.close > curr.open;
    const openBelow   = curr.open  <= prev.close;
    const closeAbove  = curr.close >= prev.open;

    if (prevBearish && currBullish && openBelow && closeAbove) {
      signals.push({
        pair: curr.pair,
        timeframe: curr.timeframe,
        type: "bullish_engulfing",
        timestamp: curr.timestamp,
        price: curr.close,
        confidence: engulfConfidence(curr, prev, zones, "bullish_engulfing"),
      });
    }
  }

  return signals;
}

/**
 * Detect bearish engulfing patterns on closed candles.
 * Conditions:
 * - Previous candle is bullish (close > open)
 * - Current candle is bearish (close < open)
 * - Current open >= previous close
 * - Current close <= previous open
 */
export function detectBearishEngulfing(
  candles: Candle[],
  zones: SupportResistanceZone[] = []
): CandlestickSignal[] {
  const signals: CandlestickSignal[] = [];

  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    if (!prev || !curr) continue;

    const prevBullish  = prev.close > prev.open;
    const currBearish  = curr.close < curr.open;
    const openAbove    = curr.open  >= prev.close;
    const closeBelow   = curr.close <= prev.open;

    if (prevBullish && currBearish && openAbove && closeBelow) {
      signals.push({
        pair: curr.pair,
        timeframe: curr.timeframe,
        type: "bearish_engulfing",
        timestamp: curr.timestamp,
        price: curr.close,
        confidence: engulfConfidence(curr, prev, zones, "bearish_engulfing"),
      });
    }
  }

  return signals;
}

/**
 * Detect all supported candlestick signals.
 */
export function detectAllSignals(
  candles: Candle[],
  zones: SupportResistanceZone[] = []
): CandlestickSignal[] {
  return [
    ...detectBullishEngulfing(candles, zones),
    ...detectBearishEngulfing(candles, zones),
  ].sort((a, b) => a.timestamp - b.timestamp);
}
