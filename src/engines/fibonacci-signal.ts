/**
 * Fibonacci Pullback Engine
 *
 * Entry requirements (ALL must be met, on a closed H4 candle):
 *   1. Established H4 trend (HH+HL sequence = up, LH+LL sequence = down) — no trades in a range.
 *   2. Price has traded into the golden pocket (0.50-0.618 retracement, default) of the
 *      latest significant impulse leg, in the trend direction.
 *   3. A confirmation candlestick pattern completes at the pocket, in the trend direction:
 *      bullish engulfing/morning star for longs, bearish engulfing/evening star for shorts.
 *   4. The confirmation candle closes inside [pocketLow, invalidationLevel] (not already
 *      blown through 0.786), if requireCloseInsidePocket.
 *   5. Computed reward:risk clears the configured minimum.
 *
 * Long:  pullback into a golden pocket during an uptrend, confirmed bullish.
 * Short: pullback into a golden pocket during a downtrend, confirmed bearish.
 * SL sits beyond the invalidation level (default) or the leg's origin — buffered by ATR.
 * Entry is a market order on the confirmation candle's close — by the time both the leg and
 * a confirming candle exist, the pullback is already visible, same reasoning the structure
 * bot's market-order entry already uses.
 */

import type { Candle } from "../types/market.ts";
import type { SwingPoint } from "../types/trading.ts";
import { calculateATR } from "./trend.ts";
import { detectSwingPoints, classifyTrend } from "./market-structure.ts";
import { detectAllSignals } from "./candlestick.ts";

export interface FibonacciSignal {
  direction:    "buy" | "sell";
  entryPrice:   number;
  stopLoss:     number;
  takeProfit:   number;
  score:        number;
  reasons:      string[];
  legOriginTs:  number;   // the 1.0 fib level (swing the leg started from)
  legOriginPrice: number;
  legExtremeTs: number;   // the 0.0 fib level (swing the leg ended at — pocket sits near here)
  legExtremePrice: number;
  patternType:  string;   // the confirming CandlestickSignal's type
  confirmedAt:  number;   // timestamp of the confirming candle, for session-filtering by the caller
}

export interface FibonacciTunables {
  pivotLookback:      number; // bars each side for a fractal pivot
  minSwingATR:        number; // a leg counts only if its size >= this × ATR(14)
  pocketLow:           number; // e.g. 0.50
  pocketHigh:           number; // e.g. 0.618
  invalidationLevel:    number; // e.g. 0.786 — a close beyond this kills the setup
  requireCloseInsidePocket: boolean;
  stopMode:             "beyond_invalidation" | "beyond_swing_origin";
  stopBufferATR:        number;
  takeProfitMode:       "prior_swing" | "extension_1272" | "extension_1618" | "fixed_rr";
}

export const DEFAULT_FIBONACCI_TUNABLES: FibonacciTunables = {
  pivotLookback:      3,
  minSwingATR:        2.0,
  pocketLow:           0.5,
  pocketHigh:           0.618,
  invalidationLevel:    0.786,
  requireCloseInsidePocket: true,
  stopMode:             "beyond_invalidation",
  stopBufferATR:        0.5,
  takeProfitMode:       "prior_swing",
};

export function pickFibonacciTunables(settings: Record<string, unknown>): Partial<FibonacciTunables> {
  const picked: Partial<FibonacciTunables> = {};
  for (const key of Object.keys(DEFAULT_FIBONACCI_TUNABLES) as (keyof FibonacciTunables)[]) {
    const value = settings[key];
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
      (picked as any)[key] = value;
    }
  }
  return picked;
}

const BULLISH_PATTERNS = new Set<string>(["bullish_engulfing", "morning_star", "hammer"]);
const BEARISH_PATTERNS = new Set<string>(["bearish_engulfing", "evening_star", "shooting_star"]);
const CONFIRMATION_RECENCY_BARS = 2;

interface ActiveLeg {
  originTs: number;
  originPrice: number;   // 1.0 fib level
  extremeTs: number;
  extremePrice: number;  // 0.0 fib level
}

/**
 * Finds the most recent significant impulse leg in the trend direction — walks backward
 * from the latest swing points looking for the first low→high (uptrend) or high→low
 * (downtrend) pair whose size clears minSwingATR × ATR, per spec §2.3's significance filter
 * (detectSwingPoints itself has no such filter — every pivot is kept, noise included).
 */
function findActiveLeg(
  swings: SwingPoint[],
  trend: "uptrend" | "downtrend",
  atr: number,
  minSwingATR: number,
): ActiveLeg | null {
  const highs = swings.filter(s => s.label === "HH" || s.label === "LH").sort((a, b) => a.timestamp - b.timestamp);
  const lows  = swings.filter(s => s.label === "HL" || s.label === "LL").sort((a, b) => a.timestamp - b.timestamp);
  const minSize = minSwingATR * atr;

  if (trend === "uptrend") {
    for (let i = lows.length - 1; i >= 0; i--) {
      const low = lows[i]!;
      const highAfter = [...highs].reverse().find(h => h.timestamp > low.timestamp);
      if (!highAfter) continue;
      if (highAfter.price - low.price >= minSize) {
        return { originTs: low.timestamp, originPrice: low.price, extremeTs: highAfter.timestamp, extremePrice: highAfter.price };
      }
    }
    return null;
  }

  for (let i = highs.length - 1; i >= 0; i--) {
    const high = highs[i]!;
    const lowAfter = [...lows].reverse().find(l => l.timestamp > high.timestamp);
    if (!lowAfter) continue;
    if (high.price - lowAfter.price >= minSize) {
      return { originTs: high.timestamp, originPrice: high.price, extremeTs: lowAfter.timestamp, extremePrice: lowAfter.price };
    }
  }
  return null;
}

// Price at a given fib fraction of the leg. 0.0 = the leg's extreme (impulse end), 1.0 = the
// leg's origin (impulse start) — matches spec §2.5's convention for both directions.
function fibPrice(leg: ActiveLeg, fraction: number, wantBullish: boolean): number {
  return wantBullish
    ? leg.extremePrice - fraction * (leg.extremePrice - leg.originPrice)
    : leg.extremePrice + fraction * (leg.originPrice - leg.extremePrice);
}

/**
 * Main entry point. Pass 4H candles — trend context, leg detection, fib levels, and
 * confirmation are all derived from this single series (spec is H4-only throughout).
 */
export function detectFibonacciSignal(
  candles:   Candle[],
  rrRatio    = 1.5,
  minReward  = 1.5,
  tunables:  Partial<FibonacciTunables> = {},
): FibonacciSignal | null {
  if (candles.length < 50) return null;
  const t = { ...DEFAULT_FIBONACCI_TUNABLES, ...tunables };

  const atr = calculateATR(candles);
  if (atr <= 0) return null;

  const swings = detectSwingPoints(candles, t.pivotLookback);
  const trendBias = classifyTrend(swings);
  if (trendBias !== "uptrend" && trendBias !== "downtrend") return null; // no range/unclear trades

  const wantBullish = trendBias === "uptrend";
  const leg = findActiveLeg(swings, trendBias, atr, t.minSwingATR);
  if (!leg) return null;

  const pocketNear = fibPrice(leg, t.pocketLow, wantBullish);
  const pocketFar  = fibPrice(leg, t.pocketHigh, wantBullish);
  const pocketLowPrice  = Math.min(pocketNear, pocketFar);
  const pocketHighPrice = Math.max(pocketNear, pocketFar);
  const invalidationPrice = fibPrice(leg, t.invalidationLevel, wantBullish);

  const latest = candles[candles.length - 1]!;

  // Price must have traded into the pocket on this candle.
  const tradedIntoPocket = latest.low <= pocketHighPrice && latest.high >= pocketLowPrice;
  if (!tradedIntoPocket) return null;

  // Confirmation: a reversal candle in the trend direction, within the last couple of bars.
  const recentCandles = candles.slice(-(CONFIRMATION_RECENCY_BARS + 2));
  const candleSignals = detectAllSignals(recentCandles, []);
  const cutoffTs = latest.timestamp - CONFIRMATION_RECENCY_BARS * (latest.timestamp - (candles[candles.length - 2]?.timestamp ?? 0));
  const confirming = candleSignals
    .filter(s => s.timestamp >= cutoffTs && (wantBullish ? BULLISH_PATTERNS.has(s.type) : BEARISH_PATTERNS.has(s.type)))
    .sort((a, b) => b.confidence - a.confidence)[0];
  if (!confirming) return null;

  // The confirming candle must close inside the pocket, not already through invalidation.
  // invalidationPrice (0.786) sits further from the extreme than pocketFar (0.618), on the
  // opposite side of the pocket from pocketNear (0.5) — so the valid band runs from
  // invalidationPrice up to the pocket's near (shallow) edge, not between the two pocket
  // bounds themselves.
  if (t.requireCloseInsidePocket) {
    const closedInside = wantBullish
      ? latest.close >= invalidationPrice && latest.close <= pocketHighPrice
      : latest.close <= invalidationPrice && latest.close >= pocketLowPrice;
    if (!closedInside) return null;
  }

  const direction: "buy" | "sell" = wantBullish ? "buy" : "sell";
  const entryPrice = latest.close;

  const buffer = atr * t.stopBufferATR;
  const stopBase = t.stopMode === "beyond_swing_origin" ? leg.originPrice : invalidationPrice;
  const stopLoss = wantBullish ? stopBase - buffer : stopBase + buffer;

  const riskDistance = Math.abs(entryPrice - stopLoss);
  if (riskDistance <= 0) return null;

  let takeProfit: number;
  switch (t.takeProfitMode) {
    case "prior_swing":
      takeProfit = leg.extremePrice; // the leg's own 0.0 extreme
      break;
    case "extension_1272":
      takeProfit = fibPrice(leg, -0.272, wantBullish); // beyond 0.0 by the extension amount
      break;
    case "extension_1618":
      takeProfit = fibPrice(leg, -0.618, wantBullish);
      break;
    case "fixed_rr":
    default:
      takeProfit = wantBullish ? entryPrice + riskDistance * rrRatio : entryPrice - riskDistance * rrRatio;
      break;
  }

  const achievedRR = Math.abs(takeProfit - entryPrice) / riskDistance;
  if (achievedRR < minReward) return null; // skip — chosen TP doesn't clear the minimum

  const score = Math.round(Math.min(100, confirming.confidence * 0.7 + Math.min(achievedRR / minReward, 2) * 15));

  return {
    direction,
    entryPrice,
    stopLoss,
    takeProfit,
    score,
    reasons: [
      `${wantBullish ? "Bullish" : "Bearish"} pullback into golden pocket (${(t.pocketLow * 100).toFixed(1)}-${(t.pocketHigh * 100).toFixed(1)}%) of leg ${leg.originPrice.toFixed(5)} → ${leg.extremePrice.toFixed(5)}`,
      `Confirmed by ${confirming.type} (${confirming.confidence}% confidence)`,
      `R:R ${achievedRR.toFixed(2)} (min ${minReward})`,
    ],
    legOriginTs: leg.originTs,
    legOriginPrice: leg.originPrice,
    legExtremeTs: leg.extremeTs,
    legExtremePrice: leg.extremePrice,
    patternType: confirming.type,
    confirmedAt: confirming.timestamp,
  };
}
