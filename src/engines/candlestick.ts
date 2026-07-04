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
    // Strict: current body must OPEN below and CLOSE strictly above the prior body
    const openBelow  = curr.open  < prev.close;
    const closeAbove = curr.close > prev.open;

    const prevBody  = Math.abs(prev.close - prev.open);
    const currBody  = Math.abs(curr.close - curr.open);
    const currRange = curr.high - curr.low;

    // Previous candle must have a real body (not a doji), current body must be larger
    if (prevBody === 0 || currRange === 0) continue;
    if (currBody / currRange < 0.3) continue;   // current must be a real body
    if (currBody <= prevBody) continue;           // current must fully engulf previous

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
 * - Current body strictly opens above and closes below the prior bullish body
 * - Current body must be larger than the prior body
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

    const prevBullish = prev.close > prev.open;
    const currBearish = curr.close < curr.open;
    // Strict: current body must OPEN strictly above and CLOSE below the prior body
    const openAbove  = curr.open  > prev.close;
    const closeBelow = curr.close < prev.open;

    const prevBody  = Math.abs(prev.close - prev.open);
    const currBody  = Math.abs(curr.close - curr.open);
    const currRange = curr.high - curr.low;

    if (prevBody === 0 || currRange === 0) continue;
    if (currBody / currRange < 0.3) continue;
    if (currBody <= prevBody) continue;

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
 * Shooting Star — bearish reversal single candle.
 * Small real body near the low, upper wick ≥ 2× body, little/no lower wick.
 */
export function detectShootingStar(
  candles: Candle[],
  zones: SupportResistanceZone[] = []
): CandlestickSignal[] {
  const signals: CandlestickSignal[] = [];
  for (const c of candles) {
    const body      = Math.abs(c.close - c.open);
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const range     = c.high - c.low;
    if (range === 0 || body === 0) continue;
    if (upperWick < body * 2) continue;          // upper wick must be 2× body
    if (lowerWick > body * 0.5) continue;        // minimal lower wick
    if (body / range > 0.35) continue;           // body must be small relative to range

    const tfW  = TIMEFRAME_WEIGHT[c.timeframe] ?? 0.55;
    const relevantZone = zones.some(z => z.type === "resistance" && isNearZone(c.close, z));
    let confidence = Math.round((upperWick / range) * 60 + tfW * 30 + (relevantZone ? 10 : 0));
    confidence = Math.min(confidence, 100);

    signals.push({ pair: c.pair, timeframe: c.timeframe, type: "shooting_star", timestamp: c.timestamp, price: c.close, confidence });
  }
  return signals;
}

/**
 * Hammer — bullish reversal single candle.
 * Small real body near the high, lower wick ≥ 2× body, little/no upper wick.
 */
export function detectHammer(
  candles: Candle[],
  zones: SupportResistanceZone[] = []
): CandlestickSignal[] {
  const signals: CandlestickSignal[] = [];
  for (const c of candles) {
    const body      = Math.abs(c.close - c.open);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const upperWick = c.high - Math.max(c.open, c.close);
    const range     = c.high - c.low;
    if (range === 0 || body === 0) continue;
    if (lowerWick < body * 2) continue;
    if (upperWick > body * 0.5) continue;
    if (body / range > 0.35) continue;

    const tfW  = TIMEFRAME_WEIGHT[c.timeframe] ?? 0.55;
    const relevantZone = zones.some(z => z.type === "support" && isNearZone(c.close, z));
    let confidence = Math.round((lowerWick / range) * 60 + tfW * 30 + (relevantZone ? 10 : 0));
    confidence = Math.min(confidence, 100);

    signals.push({ pair: c.pair, timeframe: c.timeframe, type: "hammer", timestamp: c.timestamp, price: c.close, confidence });
  }
  return signals;
}

/**
 * Morning Star — 3-candle bullish reversal.
 * Candle 1: large bearish. Candle 2: small body (indecision). Candle 3: large bullish closing above 50% of candle 1.
 */
export function detectMorningStar(
  candles: Candle[],
  zones: SupportResistanceZone[] = []
): CandlestickSignal[] {
  const signals: CandlestickSignal[] = [];
  for (let i = 2; i < candles.length; i++) {
    const c1 = candles[i - 2]!;
    const c2 = candles[i - 1]!;
    const c3 = candles[i]!;

    const body1 = c1.open - c1.close;   // bearish: positive
    const body2 = Math.abs(c2.close - c2.open);
    const body3 = c3.close - c3.open;   // bullish: positive

    if (body1 < 0) continue;            // c1 must be bearish
    if (body3 < 0) continue;            // c3 must be bullish
    if (body2 > body1 * 0.3) continue;  // c2 must be small (star)

    const midC1 = (c1.open + c1.close) / 2;
    if (c3.close < midC1) continue;     // c3 must close above 50% of c1

    // Additional: c2 gaps down from c1 (relaxed for forex — just check c2 body is lower)
    if (Math.max(c2.open, c2.close) > c1.close + body1 * 0.1) continue;

    const tfW = TIMEFRAME_WEIGHT[c3.timeframe] ?? 0.55;
    const atSupport = zones.some(z => z.type === "support" && isNearZone(c3.close, z));
    const confidence = Math.min(100, Math.round(
      (body3 / body1) * 40 + tfW * 40 + (atSupport ? 20 : 0)
    ));

    signals.push({ pair: c3.pair, timeframe: c3.timeframe, type: "morning_star", timestamp: c3.timestamp, price: c3.close, confidence });
  }
  return signals;
}

/**
 * Evening Star — 3-candle bearish reversal (mirror of Morning Star).
 * Candle 1: large bullish. Candle 2: small body. Candle 3: large bearish closing below 50% of candle 1.
 */
export function detectEveningStar(
  candles: Candle[],
  zones: SupportResistanceZone[] = []
): CandlestickSignal[] {
  const signals: CandlestickSignal[] = [];
  for (let i = 2; i < candles.length; i++) {
    const c1 = candles[i - 2]!;
    const c2 = candles[i - 1]!;
    const c3 = candles[i]!;

    const body1 = c1.close - c1.open;   // bullish: positive
    const body2 = Math.abs(c2.close - c2.open);
    const body3 = c3.open - c3.close;   // bearish: positive

    if (body1 < 0) continue;
    if (body3 < 0) continue;
    if (body2 > body1 * 0.3) continue;

    const midC1 = (c1.open + c1.close) / 2;
    if (c3.close > midC1) continue;

    if (Math.min(c2.open, c2.close) < c1.close - body1 * 0.1) continue;

    const tfW = TIMEFRAME_WEIGHT[c3.timeframe] ?? 0.55;
    const atResistance = zones.some(z => z.type === "resistance" && isNearZone(c3.close, z));
    const confidence = Math.min(100, Math.round(
      (body3 / body1) * 40 + tfW * 40 + (atResistance ? 20 : 0)
    ));

    signals.push({ pair: c3.pair, timeframe: c3.timeframe, type: "evening_star", timestamp: c3.timestamp, price: c3.close, confidence });
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
    ...detectMorningStar(candles, zones),
    ...detectEveningStar(candles, zones),
    ...detectShootingStar(candles, zones),
    ...detectHammer(candles, zones),
  ].sort((a, b) => a.timestamp - b.timestamp);
}
