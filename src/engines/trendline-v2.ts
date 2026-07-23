/**
 * Trendline V2 Engine
 *
 * A deliberately different lifecycle from the original trendline bot (trendline.ts), which
 * re-derives candidate lines fresh every scan with no memory of what's already broken. Here:
 *
 *   - Lines are discovered once (via the same swing-point/line-building math as the original
 *     bot, reused directly) and then persisted — they stay in an "active" watch-set across
 *     scans until a genuine close-based break retires them permanently. A brief wick through
 *     a line does NOT retire it; only a confirmed close beyond it does.
 *   - While a trade is open on a pair, no *new* lines are discovered — only the already-known
 *     active set gets checked. A second already-known line breaking while a trade is open is
 *     itself an independent second entry, not suppressed.
 *   - Entry prioritises the first (earliest-formed) qualifying active line, not the most
 *     recent/steepest one.
 *   - Take-profit is dynamic: the nearest active line of the opposite type, checked every tick
 *     (see hasCrossedOppositeLine) rather than a fixed price set once at entry. Falls back to a
 *     fixed reward:risk multiple only if no opposite line is known yet.
 *   - The stop loss uses cTrader's own native trailing stop (placed at order time via the
 *     trailingStopLoss flag) rather than the original bot's client-side trendline-slope trail —
 *     the broker trails it server-side, maintaining the same distance the initial stop was set
 *     at from the retest price.
 *
 * All swing-point/line-construction/candle-confirmation math is reused directly from
 * trendline.ts, not reimplemented.
 */

import type { Candle } from "../types/market.ts";
import {
  swingHighs, swingLows, buildLines, roundPrice,
} from "./trendline.ts";
import type { DetectedLine, TrendlineTunables } from "./trendline.ts";
import type { TrendlineV2Line } from "../bot/trendline-v2-store.ts";

const FOUR_HOUR_MS = 4 * 60 * 60 * 1000;

export interface TrendlineV2Tunables {
  breakThresholdAtr:  number; // how far a close must move past a line to count as broken
  retestWindowBars:   number; // bars allowed for the retest after a break
  retestRecencyBars:  number; // how stale a retest can be and still count
  touchToleranceAtr:  number; // how close price must come to a line to count as a touch
  minStopDistAtr:     number; // minimum allowed stop distance (rejects too-tight setups)
  minTouches:         number; // minimum touches a line needs to be considered
  slBufferAtr:        number; // SL distance beyond the flipped line, in ATR multiples
  fallbackRewardRisk: number; // used only if no opposite line exists yet at entry time
}

export const DEFAULT_TRENDLINE_V2_TUNABLES: TrendlineV2Tunables = {
  breakThresholdAtr:  0.5,
  retestWindowBars:   6,
  retestRecencyBars:  3,
  touchToleranceAtr:  0.3,
  minStopDistAtr:     0.2,
  minTouches:         2,
  slBufferAtr:        0.1,
  fallbackRewardRisk: 2.0,
};

export function pickTrendlineV2Tunables(settings: Record<string, unknown>): Partial<TrendlineV2Tunables> {
  const picked: Partial<TrendlineV2Tunables> = {};
  for (const key of Object.keys(DEFAULT_TRENDLINE_V2_TUNABLES) as (keyof TrendlineV2Tunables)[]) {
    const value = settings[key];
    if (typeof value === "number") picked[key] = value;
  }
  return picked;
}

export interface DiscoveredLine {
  lineType: "resistance" | "support";
  p1Ts:     number;
  p2Ts:     number;
  p1Price:  number;
  p2Price:  number;
  slope:    number;
  touches:  number;
}

// Fresh line discovery — identical construction to the original trendline bot's buildLines(),
// just converted from candle-index anchors to timestamps so lines can be persisted and
// re-checked across scans independent of whatever candle window a future scan happens to fetch.
export function discoverLines(
  candles:  Candle[],
  atr:      number,
  tunables: TrendlineV2Tunables,
): DiscoveredLine[] {
  const lineTunables: TrendlineTunables = {
    slBufferAtr:       tunables.slBufferAtr,
    breakThresholdAtr: tunables.breakThresholdAtr,
    retestWindowBars:  tunables.retestWindowBars,
    retestRecencyBars: tunables.retestRecencyBars,
    touchToleranceAtr: tunables.touchToleranceAtr,
    minStopDistAtr:    tunables.minStopDistAtr,
    minTouches:        tunables.minTouches,
  };
  const resistanceLines = buildLines(candles, swingHighs(candles, 5), "resistance", atr, lineTunables);
  const supportLines    = buildLines(candles, swingLows(candles, 5),  "support",    atr, lineTunables);

  const toDiscovered = (l: DetectedLine): DiscoveredLine => ({
    lineType: l.type,
    p1Ts:     candles[l.p1Index]!.timestamp,
    p2Ts:     candles[l.p2Index]!.timestamp,
    p1Price:  l.p1Price,
    p2Price:  l.p2Price,
    slope:    l.slope,
    touches:  l.touches,
  });
  return [...resistanceLines, ...supportLines].map(toDiscovered);
}

// Projects a persisted line's price at an arbitrary future timestamp — the timestamp-based
// equivalent of trendline.ts's index-based projectPrice(), needed because a persisted line's
// anchors aren't guaranteed to be at any particular index in a future scan's candle array.
export function projectLineAt(line: TrendlineV2Line, timestamp: number): number {
  return line.p1Price + line.slope * ((timestamp - line.p1Ts) / FOUR_HOUR_MS);
}

// An active (not-yet-broken) line is, by construction, always on the "correct" side of price —
// an active resistance line is always currently above price (if it weren't, it would already
// be broken), an active support line always below. Take-profit is a *break* of that opposite
// line in the trade's own favourable direction: a resistance target (a buy's TP, since a buy
// enters off broken support) is hit once price closes at or above the line's current
// projection; a support target (a sell's TP) once price closes at or below it.
export function hasCrossedOppositeLine(candle: Candle, line: TrendlineV2Line): boolean {
  const proj = projectLineAt(line, candle.timestamp);
  return line.lineType === "resistance" ? candle.close >= proj : candle.close <= proj;
}

// Picks the current best opposite-type active line to serve as a trade's take-profit
// reference — the most recently formed line of the opposite type, since that's the most
// relevant to current price action. Returns null if none exist yet.
//
// latestCandleTs excludes any candidate whose second anchor is the current (still-forming or
// just-closed) candle — a line's second anchor is a confirmed swing point, and a swing point
// on the very latest candle can't yet be confirmed (there's no future price action to confirm
// it against). This should already be structurally impossible given swingHighs/swingLows'
// own lookback requirement, but the TP reference is exactly the place a shaky anchor would be
// most costly, so it's guarded explicitly here too.
export function pickOppositeLine(
  activeLines:     TrendlineV2Line[],
  brokenLineType:  "resistance" | "support",
  latestCandleTs:  number,
): TrendlineV2Line | null {
  const oppositeType = brokenLineType === "resistance" ? "support" : "resistance";
  const candidates = activeLines.filter(l => l.lineType === oppositeType && l.p2Ts < latestCandleTs);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, l) => (l.p2Ts > best.p2Ts ? l : best), candidates[0]!);
}

interface LineBreakCheck {
  broken:      boolean;
  breakIndex?: number;
  retested?:   boolean;
  retestIndex?: number;
  entryPrice?: number;
  stopLoss?:   number;
}

// Checks ONE persisted line against the current candle window for (a) a fresh break and
// (b) whether that break has also been retested — mirrors trendline.ts's detectSetupForLine
// phases 1+2 exactly (same 30-bar recency window, same break-threshold/retest-window/
// retest-recency semantics), just re-expressed against a timestamp-anchored persisted line
// instead of an in-scan DetectedLine.
function checkLineForBreak(
  candles:  Candle[],
  line:     TrendlineV2Line,
  atr:      number,
  tunables: TrendlineV2Tunables,
): LineBreakCheck {
  const breakDir: "buy" | "sell" = line.lineType === "resistance" ? "buy" : "sell";
  const breakThreshold = atr * tunables.breakThresholdAtr;
  const total = candles.length;

  const scanFrom = Math.max(0, total - 30);
  let breakIdx = -1;
  for (let i = scanFrom; i < total - 1; i++) {
    const c = candles[i]!;
    if (c.timestamp <= line.p2Ts) continue; // never evaluate a break before the line's own anchors
    const proj = projectLineAt(line, c.timestamp);
    if (breakDir === "buy"  && c.close > proj + breakThreshold) { breakIdx = i; break; }
    if (breakDir === "sell" && c.close < proj - breakThreshold) { breakIdx = i; break; }
  }
  if (breakIdx === -1) return { broken: false };

  const retestWindow = Math.min(breakIdx + tunables.retestWindowBars, total);
  let retestIdx = -1;
  for (let i = breakIdx + 1; i < retestWindow; i++) {
    const c = candles[i]!;
    const proj = projectLineAt(line, c.timestamp);
    if (breakDir === "buy") {
      const touchedLine = c.low <= proj + breakThreshold;
      const heldAbove   = c.close > proj;
      if (touchedLine && heldAbove) { retestIdx = i; break; }
      if (c.close < proj - breakThreshold) break;
    } else {
      const touchedLine = c.high >= proj - breakThreshold;
      const heldBelow   = c.close < proj;
      if (touchedLine && heldBelow) { retestIdx = i; break; }
      if (c.close > proj + breakThreshold) break;
    }
  }

  if (retestIdx === -1 || retestIdx < total - tunables.retestRecencyBars) {
    return { broken: true, breakIndex: breakIdx };
  }

  const retestCandle = candles[retestIdx]!;
  const lineAtRetest = projectLineAt(line, retestCandle.timestamp);
  const stopBuffer   = atr * tunables.slBufferAtr;
  const entryPrice   = retestCandle.close;
  const stopLoss      = breakDir === "buy" ? lineAtRetest - stopBuffer : lineAtRetest + stopBuffer;
  const stopDist      = Math.abs(entryPrice - stopLoss);
  if (stopDist < atr * tunables.minStopDistAtr) return { broken: true, breakIndex: breakIdx };

  return { broken: true, breakIndex: breakIdx, retested: true, retestIndex: retestIdx, entryPrice, stopLoss };
}

export interface TrendlineV2Entry {
  lineId:     string; // the (now-retired) line whose break+retest produced this entry
  lineType:   "resistance" | "support";
  direction:  "buy" | "sell";
  entryPrice: number;
  stopLoss:   number;
  score:      number;
  reasons:    string[];
}

export interface TrendlineV2ScanResult {
  brokenLineIds: string[]; // every active line that broke this scan — caller retires all of these
  entry:         TrendlineV2Entry | null;
}

// Main entry point. candles must be 4H, matching the timeframe FOUR_HOUR_MS assumes throughout.
// activeLines should already be ordered earliest-p1Ts-first (trendline-v2-store's
// getActiveLines() does this) so the first line to produce a valid entry this scan is the
// earliest-formed one, per Andrew's "entry should happen on the first line, not a later one."
export function scanTrendlineV2(
  candles:     Candle[],
  activeLines: TrendlineV2Line[],
  atr:         number,
  tunables:    TrendlineV2Tunables,
  dailyBias:   "bullish" | "bearish" | "neutral",
): TrendlineV2ScanResult {
  const brokenLineIds: string[] = [];
  let entry: TrendlineV2Entry | null = null;
  const pair = candles[0]?.pair ?? "";

  for (const line of activeLines) {
    const breakDir: "buy" | "sell" = line.lineType === "resistance" ? "buy" : "sell";
    if (dailyBias === "bullish" && breakDir === "sell") continue;
    if (dailyBias === "bearish" && breakDir === "buy")  continue;

    const check = checkLineForBreak(candles, line, atr, tunables);
    if (!check.broken) continue;
    brokenLineIds.push(line.id);

    if (!entry && check.retested && check.entryPrice !== undefined && check.stopLoss !== undefined) {
      let score = 55;
      score += dailyBias !== "neutral" ? 20 : 0;
      score += Math.min((line.touches - 2) * 5, 10);
      score = Math.min(100, Math.round(score));

      entry = {
        lineId:     line.id,
        lineType:   line.lineType,
        direction:  breakDir,
        entryPrice: roundPrice(check.entryPrice, pair),
        stopLoss:   roundPrice(check.stopLoss, pair),
        score,
        reasons: [
          `${line.lineType === "resistance" ? "Descending resistance" : "Ascending support"} broken (first-formed active line, ${line.touches} touches)`,
          `Retest confirmed ${(check.retestIndex ?? 0) - (check.breakIndex ?? 0)} bar(s) after break`,
          dailyBias !== "neutral" ? `Daily bias: ${dailyBias} (aligned)` : "Daily bias: neutral",
        ],
      };
    }
  }

  return { brokenLineIds, entry };
}
