/**
 * Structure Engine
 *
 * Entry requirements (ALL must be met):
 *   1. An Area of Interest (AOI) exists on the weekly chart — a confluence of 2+ S/R zones
 *      (from W/D/4H) clustered around the most recent structural swing point.
 *   2. Price is currently trading at/near that AOI.
 *   3. The latest 4H candle(s) show a candlestick reversal pattern confirming the bounce
 *      in the AOI's direction (bullish pattern at a bullish AOI, bearish at a bearish one).
 *
 * Long:  bullish AOI (built around the most recent Higher Low) + bullish reversal candle
 * Short: bearish AOI (built around the most recent Lower High) + bearish reversal candle
 * SL is placed just beyond the AOI's defining swing point (the HL/LH that anchors it).
 *
 * Unlike the trendline engine, this enters on confirmation (market order) rather than
 * anticipating a retest with a resting limit order — by the time both the AOI and a
 * confirming candle exist, the bounce is already visible.
 */

import type { Candle } from "../types/market.ts";
import type { SupportResistanceZone } from "../types/trading.ts";
import { calculateATR } from "./trend.ts";
import {
  detectZones,
  markBrokenByPrice,
  detectAreaOfInterest,
  getNearestZone,
  scoreZone,
} from "./support-resistance.ts";
import { detectAllSignals } from "./candlestick.ts";
import type { TpMode } from "./trendline.ts";

export interface StructureSignal {
  direction:    "buy" | "sell";
  entryPrice:   number;
  stopLoss:     number;
  takeProfit:   number;
  score:        number;
  reasons:      string[];
  zoneType:     "support" | "resistance"; // the type of the AOI's defining zones
  zoneLow:      number;
  zoneHigh:     number;
  patternType:  string; // the confirming CandlestickSignal's type
  confirmedAt:  number; // timestamp of the confirming candle, for session-filtering by the caller
}

// Every numeric threshold here is a per-bot setting (see bot-types.ts BOT_TYPE_REGISTRY),
// same pattern as trendline.ts's TrendlineTunables. minConfluence is a separate direct
// parameter below (not part of this group) since it's a cross-cutting setting shared with
// the caller's own gating logic, same as trendline's swingLookback.
export interface StructureTunables {
  slBufferAtr: number; // SL distance beyond the AOI's defining swing point, in ATR multiples
}

export const DEFAULT_STRUCTURE_TUNABLES: StructureTunables = {
  slBufferAtr: 0.2,
};

export function pickStructureTunables(settings: Record<string, unknown>): Partial<StructureTunables> {
  const picked: Partial<StructureTunables> = {};
  for (const key of Object.keys(DEFAULT_STRUCTURE_TUNABLES) as (keyof StructureTunables)[]) {
    const value = settings[key];
    if (typeof value === "number") picked[key] = value;
  }
  return picked;
}

// candlestick.ts's detectAllSignals returns some pattern types not present in the
// CandlestickSignal.type union declared in types/trading.ts (e.g. "morning_star",
// "evening_star") — this is a pre-existing mismatch elsewhere in the codebase, not
// something introduced here. Grouping by plain string membership (rather than an
// exhaustive switch over the declared union) sidesteps it without adding new errors.
const BULLISH_PATTERNS = new Set<string>(["bullish_engulfing", "morning_star", "hammer"]);
const BEARISH_PATTERNS = new Set<string>(["bearish_engulfing", "evening_star", "shooting_star"]);

// A confirming candle only counts if it's within the last 2 bars — otherwise the
// "bounce" being confirmed is stale relative to the AOI check, which always uses the
// latest candle's price.
const CONFIRMATION_RECENCY_BARS = 2;

/**
 * Main entry point. Pass weekly, daily, and 4H candles — weekly anchors the AOI,
 * daily/4H contribute additional confluence zones, 4H is the confirmation timeframe.
 */
export function detectStructureSignal(
  candlesW:      Candle[],
  candlesD:      Candle[],
  candles4H:     Candle[],
  rrRatio        = 1.5,
  minConfluence  = 2,
  tunables:      Partial<StructureTunables> = {},
  tpMode:        TpMode = "rr",
): StructureSignal | null {
  if (candlesW.length < 10 || candles4H.length < 50) return null;

  const t = { ...DEFAULT_STRUCTURE_TUNABLES, ...tunables };

  const atr = calculateATR(candles4H);
  if (atr <= 0) return null;

  const latest       = candles4H[candles4H.length - 1]!;
  const currentPrice = latest.close;

  const zonesW  = detectZones(candlesW,  "W",  atr);
  const zonesD  = detectZones(candlesD,  "D",  atr);
  const zones4H = detectZones(candles4H, "4H", atr);
  const allZones: SupportResistanceZone[] = markBrokenByPrice(
    [...zonesW, ...zonesD, ...zones4H],
    currentPrice,
    atr,
  );

  const aoi = detectAreaOfInterest(candlesW, allZones, atr, minConfluence);
  if (!aoi) return null;

  // Price must be trading at/near the AOI right now — this isn't an anticipatory
  // setup like the trendline retest, so an AOI price hasn't reached yet doesn't qualify.
  const tolerance = Math.max((aoi.high - aoi.low) * 0.2, atr * 0.1);
  if (currentPrice < aoi.low - tolerance || currentPrice > aoi.high + tolerance) return null;

  const wantBullish = aoi.bias === "bullish";

  // Confirmation: a reversal candle in the AOI's direction, within the last couple of bars.
  const recentCandles  = candles4H.slice(-(CONFIRMATION_RECENCY_BARS + 1));
  const candleSignals  = detectAllSignals(recentCandles, allZones);
  const cutoffTs       = latest.timestamp - CONFIRMATION_RECENCY_BARS * (latest.timestamp - (candles4H[candles4H.length - 2]?.timestamp ?? 0));
  const confirming = candleSignals
    .filter(s => s.timestamp >= cutoffTs && (wantBullish ? BULLISH_PATTERNS.has(s.type) : BEARISH_PATTERNS.has(s.type)))
    .sort((a, b) => b.confidence - a.confidence)[0];
  if (!confirming) return null;

  const direction: "buy" | "sell" = wantBullish ? "buy" : "sell";
  const entryPrice = currentPrice;

  const swingPoint = wantBullish ? aoi.swingLow : aoi.swingHigh;
  const buffer     = atr * t.slBufferAtr;
  const stopLoss   = wantBullish ? swingPoint - buffer : swingPoint + buffer;

  // The AOI zone can be wide enough that price legitimately trades on the far side of the
  // swing point that defines the stop — reject rather than emit a stop on the wrong side of
  // entry (Math.abs() below only guards against a zero-distance stop, not a backwards one).
  if (wantBullish ? stopLoss >= entryPrice : stopLoss <= entryPrice) return null;

  const riskDistance = Math.abs(entryPrice - stopLoss);
  if (riskDistance <= 0) return null;

  const rrTarget = wantBullish ? entryPrice + riskDistance * rrRatio : entryPrice - riskDistance * rrRatio;
  let takeProfit = rrTarget;

  if (tpMode === "atLevel") {
    const opposingType = wantBullish ? "resistance" : "support";
    const nearest = getNearestZone(entryPrice, allZones, opposingType);
    // Only use the opposing zone if it's actually ahead of price (not behind it) — otherwise
    // it wouldn't produce a sane R:R, same fallback rule trendline's atLevel mode follows.
    const validAtLevel = nearest !== null && (wantBullish ? nearest.midpoint > entryPrice : nearest.midpoint < entryPrice);
    if (validAtLevel) takeProfit = nearest!.midpoint;
  }

  const zoneStrengths    = aoi.zones.map(scoreZone);
  const avgZoneStrength  = zoneStrengths.length > 0
    ? zoneStrengths.reduce((a, b) => a + b, 0) / zoneStrengths.length
    : 50;
  const score = Math.round(avgZoneStrength * 0.6 + confirming.confidence * 0.4);

  return {
    direction,
    entryPrice,
    stopLoss,
    takeProfit,
    score,
    reasons: [
      aoi.description,
      `Confirmed by ${confirming.type} (${confirming.confidence}% confidence)`,
    ],
    zoneType:    wantBullish ? "support" : "resistance",
    zoneLow:     aoi.low,
    zoneHigh:    aoi.high,
    patternType: confirming.type,
    confirmedAt: confirming.timestamp,
  };
}
