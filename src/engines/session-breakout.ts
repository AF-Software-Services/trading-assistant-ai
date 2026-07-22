/**
 * Session Breakout Engine (prototype)
 *
 * Classic "London breakout" concept: the Asian session (21:00-07:00 UTC) typically trades
 * a tight, low-volatility range while Asia is closed and London/NY haven't opened yet. Once
 * London opens, a genuine directional move often breaks that range decisively — this strategy
 * trades that break, not a trendline or an oscillator extreme.
 *
 * Entry: the latest closed candle closes beyond the most recently completed Asian session's
 * high/low, by more than a small buffer (avoids reacting to marginal noise).
 * SL: the opposite side of the Asian range (a genuine reversal back through the whole range
 * invalidates the breakout thesis).
 * TP: a multiple of the range's own width, projected from the breakout point (a "measured
 * move" — the classic target for this style of breakout).
 */

import type { Candle } from "../types/market.ts";
import { calculateATR } from "./trend.ts";

export interface SessionBreakoutSignal {
  direction:    "buy" | "sell";
  entryPrice:   number;
  stopLoss:     number;
  takeProfit:   number;
  score:        number;
  reasons:      string[];
  sessionHigh:  number;
  sessionLow:   number;
  sessionStartTs: number;
}

export interface SessionBreakoutTunables {
  breakBufferAtr:   number; // how far past the range edge counts as a genuine break
  rangeMultiplier:  number; // TP = range width * this, projected from the breakout
  maxRangeAtr:      number; // reject if the Asian range itself is too wide (already trending, not consolidating)
  minRangeAtr:      number; // reject if the range is too tight (near-zero volatility, no real level)
  slMode:           "opposite" | "nearSide"; // "opposite" = full range invalidation; "nearSide" = tight stop just beyond the breakout level itself
  slBufferAtr:      number; // only used by "nearSide" mode
}

export const DEFAULT_SESSION_BREAKOUT_TUNABLES: SessionBreakoutTunables = {
  breakBufferAtr:  0.1,
  rangeMultiplier: 1.5,
  maxRangeAtr:     3.0,
  minRangeAtr:     0.3,
  slMode:          "opposite",
  slBufferAtr:     0.2,
};

// Reads tunables off a bot's settings blob — only copies over fields that are actually the
// right type, leaving the rest to DEFAULT_SESSION_BREAKOUT_TUNABLES. Same pattern as
// pickTrendlineTunables/pickFibonacciTunables.
export function pickSessionBreakoutTunables(settings: Record<string, unknown>): Partial<SessionBreakoutTunables> {
  const picked: Partial<SessionBreakoutTunables> = {};
  for (const key of ["breakBufferAtr", "rangeMultiplier", "maxRangeAtr", "minRangeAtr", "slBufferAtr"] as const) {
    const value = settings[key];
    if (typeof value === "number") picked[key] = value;
  }
  if (settings["slMode"] === "opposite" || settings["slMode"] === "nearSide") {
    picked.slMode = settings["slMode"];
  }
  return picked;
}

function hourUtc(ts: number): number {
  return new Date(ts).getUTCHours();
}

function isAsianHour(h: number): boolean {
  return h >= 21 || h < 7;
}

/**
 * Finds the most recently COMPLETED Asian session block (a contiguous run of asian-hour
 * candles) that ends strictly before the latest candle. Returns its high/low/start timestamp,
 * or null if no complete block is found in the given history.
 */
function findLastCompletedAsianSession(candles: Candle[]): { high: number; low: number; startTs: number; endIdx: number } | null {
  const n = candles.length;
  let i = n - 2; // skip the latest candle itself — we're looking for a session that already ended

  // Skip forward past any trailing non-asian candles (today's london/ny so far)
  while (i >= 0 && !isAsianHour(hourUtc(candles[i]!.timestamp))) i--;
  if (i < 0) return null;

  // Now walk backward through the contiguous asian block
  let high = -Infinity, low = Infinity, endIdx = i;
  while (i >= 0 && isAsianHour(hourUtc(candles[i]!.timestamp))) {
    high = Math.max(high, candles[i]!.high);
    low  = Math.min(low,  candles[i]!.low);
    i--;
  }
  const startTs = candles[i + 1]!.timestamp;
  return { high, low, startTs, endIdx };
}

/**
 * Main entry point. Pass 1H candles — session boundaries are hour-precise, a coarser
 * timeframe can't resolve them.
 */
export function detectSessionBreakoutSignal(
  candles: Candle[],
  tunables: Partial<SessionBreakoutTunables> = {},
): SessionBreakoutSignal | null {
  const t = { ...DEFAULT_SESSION_BREAKOUT_TUNABLES, ...tunables };
  if (candles.length < 30) return null;

  const atr = calculateATR(candles);
  if (atr <= 0) return null;

  const latest = candles[candles.length - 1]!;
  // Only trade the breakout while still in the london/ny window, not from inside the next
  // asian session (that would just be re-detecting the same old range).
  if (isAsianHour(hourUtc(latest.timestamp))) return null;

  const session = findLastCompletedAsianSession(candles);
  if (!session) return null;

  const rangeWidth = session.high - session.low;
  if (rangeWidth < atr * t.minRangeAtr) return null; // no real range — too flat to mean anything
  if (rangeWidth > atr * t.maxRangeAtr) return null; // already trending through Asia — not a coiled range

  const buffer = atr * t.breakBufferAtr;
  const brokeUp   = latest.close > session.high + buffer;
  const brokeDown = latest.close < session.low  - buffer;
  if (!brokeUp && !brokeDown) return null;

  const direction: "buy" | "sell" = brokeUp ? "buy" : "sell";
  const entryPrice = latest.close;
  const nearSideBuffer = atr * t.slBufferAtr;
  const stopLoss = t.slMode === "nearSide"
    ? (brokeUp ? session.high - nearSideBuffer : session.low + nearSideBuffer)
    : (brokeUp ? session.low : session.high);
  const takeProfit = brokeUp
    ? entryPrice + rangeWidth * t.rangeMultiplier
    : entryPrice - rangeWidth * t.rangeMultiplier;

  const riskDistance = Math.abs(entryPrice - stopLoss);
  if (riskDistance <= 0) return null;
  const achievedRR = Math.abs(takeProfit - entryPrice) / riskDistance;

  const score = Math.round(Math.min(100, 50 + Math.min(achievedRR, 3) * 10 + (rangeWidth / atr) * 5));

  return {
    direction,
    entryPrice,
    stopLoss,
    takeProfit,
    score,
    reasons: [
      `Asian session range: ${session.low.toFixed(5)} - ${session.high.toFixed(5)} (${(rangeWidth / atr).toFixed(2)}x ATR)`,
      `Broke ${brokeUp ? "above" : "below"} the range on close ${entryPrice.toFixed(5)}`,
      `Target: ${t.rangeMultiplier}x range width (R:R ${achievedRR.toFixed(2)})`,
    ],
    sessionHigh: session.high,
    sessionLow:  session.low,
    sessionStartTs: session.startTs,
  };
}
