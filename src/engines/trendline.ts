/**
 * Trendline Engine
 *
 * Entry requirements (ALL must be met):
 *   1. Established trendline: 2+ swing touches on a descending resistance OR ascending support
 *   2. Clean break through the trendline (close > 0.5 ATR beyond it)
 *   3. Retest: price returns to the broken line within 5 bars and closes back on the break side
 *   4. Daily bias alignment — only take setups in the direction of the daily trend
 *
 * Long:  break + retest of a descending resistance (line flips to support)
 * Short: break + retest of an ascending support (line flips to resistance)
 * SL is placed just beyond the broken trendline at the retest bar.
 */

import type { Candle } from "../types/market.ts";
import { calculateATR } from "./trend.ts";
import { detectZones, getNearestZone } from "./support-resistance.ts";

export type TpMode = "rr" | "atLevel";

// cTrader quotes JPY pairs to 3 decimal places and everything else to 5 (same convention
// already used for display elsewhere, e.g. ui/src/main.ts's `symbol.includes('JPY') ? 3 : 5`).
// Rounding every pair to 5 decimals here used to silently produce unplaceable JPY orders —
// the broker rejects them outright ("more digits than symbol allows"), discarding an
// otherwise-valid signal with no retry, not just losing a bit of precision.
export function roundPrice(price: number, pair: string): number {
  const factor = pair.includes("JPY") ? 1000 : 100000;
  return Math.round(price * factor) / factor;
}

export interface DetectedLine {
  type:    "resistance" | "support";
  p1Index: number;
  p2Index: number;
  p1Price: number;
  p2Price: number;
  slope:   number;
  touches: number;
  strength: number;
}

export interface TrendlineSignal {
  direction:     "buy" | "sell";
  entryPrice:    number;
  stopLoss:      number;
  takeProfit:    number;
  score:         number;
  reasons:       string[];
  actionLine:    DetectedLine;
  safetyLine:    DetectedLine;
  breakIndex:    number;
  retestIndex:   number;
  safetyAtEntry: number;
}

// Every numeric threshold in the detection/entry logic below used to be a bare literal.
// Pulling them out lets each bot instance tune its own setup criteria (and backtest the
// result) without touching code — see bot-types.ts BOT_TYPE_REGISTRY for the defaults,
// which match the values these constants held before this became configurable.
export interface TrendlineTunables {
  slBufferAtr:       number; // SL distance beyond the flipped line, in ATR multiples
  breakThresholdAtr: number; // how far price must close past a line to count as "broken"
  retestWindowBars:  number; // bars allowed for the retest after a break
  retestRecencyBars: number; // how stale a retest can be and still count
  touchToleranceAtr: number; // how close price must come to a line to count as a touch
  minStopDistAtr:    number; // minimum allowed stop distance (rejects too-tight setups)
  minTouches:        number; // minimum touches a line needs to be considered
}

export const DEFAULT_TRENDLINE_TUNABLES: TrendlineTunables = {
  slBufferAtr:       0.1,
  breakThresholdAtr: 0.5,
  retestWindowBars:  6,
  retestRecencyBars: 3,
  touchToleranceAtr: 0.3,
  minStopDistAtr:    0.2,
  minTouches:        2,
};

// Reads tunables off a bot's settings blob (values may be missing or wrong-typed if the bot
// predates a given field, or settings_json was hand-edited) — only copies over fields that are
// actually numbers, leaving the rest to DEFAULT_TRENDLINE_TUNABLES inside detectTrendlineSignal.
export function pickTrendlineTunables(settings: Record<string, unknown>): Partial<TrendlineTunables> {
  const picked: Partial<TrendlineTunables> = {};
  for (const key of Object.keys(DEFAULT_TRENDLINE_TUNABLES) as (keyof TrendlineTunables)[]) {
    const value = settings[key];
    if (typeof value === "number") picked[key] = value;
  }
  return picked;
}

// ── Swing points ──────────────────────────────────────────────────────────────

function swingHighs(candles: Candle[], lookback = 5): number[] {
  const out: number[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const hi = candles[i]!.high;
    let ok = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j !== i && (candles[j]?.high ?? 0) >= hi) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

function swingLows(candles: Candle[], lookback = 5): number[] {
  const out: number[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const lo = candles[i]!.low;
    let ok = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j !== i && (candles[j]?.low ?? Infinity) <= lo) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

function projectPrice(line: DetectedLine, index: number): number {
  return line.p1Price + line.slope * (index - line.p1Index);
}

// ── Engulfing candle check ────────────────────────────────────────────────────

/**
 * Bullish engulfing: current candle is green AND its body fully engulfs the previous candle's body.
 * Also accepts a hammer (long lower wick, small body near top) as confirmation.
 */
function isBullishEngulfing(candles: Candle[], index: number): boolean {
  if (index < 1) return false;
  const curr = candles[index]!;
  const prev = candles[index - 1]!;

  // Classic engulfing
  const currBodyLo = Math.min(curr.open, curr.close);
  const currBodyHi = Math.max(curr.open, curr.close);
  const prevBodyLo = Math.min(prev.open, prev.close);
  const prevBodyHi = Math.max(prev.open, prev.close);

  const isEngulfing = curr.close > curr.open               // green candle
    && currBodyLo <= prevBodyLo                             // body engulfs below
    && currBodyHi >= prevBodyHi;                            // body engulfs above

  // Hammer: lower wick >= 2x body, body in upper 40% of candle range
  const range    = curr.high - curr.low;
  const bodySize = Math.abs(curr.close - curr.open);
  const lowerWick = Math.min(curr.open, curr.close) - curr.low;
  const isHammer = range > 0 && lowerWick >= bodySize * 2 && lowerWick >= range * 0.5
    && curr.close > curr.open; // closes green

  return isEngulfing || isHammer;
}

/**
 * Bearish engulfing: current candle is red AND its body fully engulfs the previous candle's body.
 * Also accepts a shooting star (long upper wick, small body near bottom).
 */
function isBearishEngulfing(candles: Candle[], index: number): boolean {
  if (index < 1) return false;
  const curr = candles[index]!;
  const prev = candles[index - 1]!;

  const currBodyLo = Math.min(curr.open, curr.close);
  const currBodyHi = Math.max(curr.open, curr.close);
  const prevBodyLo = Math.min(prev.open, prev.close);
  const prevBodyHi = Math.max(prev.open, prev.close);

  const isEngulfing = curr.close < curr.open               // red candle
    && currBodyLo <= prevBodyLo
    && currBodyHi >= prevBodyHi;

  // Shooting star: upper wick >= 2x body, body in lower 40% of candle range
  const range     = curr.high - curr.low;
  const bodySize  = Math.abs(curr.close - curr.open);
  const upperWick = curr.high - Math.max(curr.open, curr.close);
  const isStar    = range > 0 && upperWick >= bodySize * 2 && upperWick >= range * 0.5
    && curr.close < curr.open; // closes red

  return isEngulfing || isStar;
}

// ── Daily bias ────────────────────────────────────────────────────────────────

/**
 * Returns "bullish", "bearish", or "neutral" from the last 20 daily candles.
 * Uses a simple 20-candle EMA comparison: close vs EMA direction.
 */
export function getDailyBias(dailyCandles: Candle[]): "bullish" | "bearish" | "neutral" {
  if (dailyCandles.length < 5) return "neutral";
  const last  = dailyCandles[dailyCandles.length - 1]!;
  const prev5 = dailyCandles[dailyCandles.length - 5]!;
  const diff  = last.close - prev5.close;
  const atr   = calculateATR(dailyCandles.slice(-20));
  if (diff > atr * 0.5)  return "bullish";
  if (diff < -atr * 0.5) return "bearish";
  return "neutral";
}

// ── Trading session ───────────────────────────────────────────────────────────

// A simpler 3-way, no-gap split than journal.ts's getSession() (which has separate overlap/
// off-hours buckets for descriptive labeling) — a filtering decision needs every hour to map
// to exactly one session, not "off_hours".
export type TradingSession = "asian" | "london" | "ny";

export function getTradingSession(hourUtc: number): TradingSession {
  if (hourUtc >= 21 || hourUtc < 7) return "asian";
  if (hourUtc >= 7  && hourUtc < 13) return "london";
  return "ny";
}

// ── Build trendlines ──────────────────────────────────────────────────────────

function buildLines(
  candles:   Candle[],
  swings:    number[],
  type:      "resistance" | "support",
  atr:       number,
  tunables:  TrendlineTunables,
): DetectedLine[] {
  if (swings.length < 2) return [];
  const result: DetectedLine[] = [];
  const tolerance = atr * 0.15;

  // Anchor from the most significant point first:
  // Bearish → highest swing high; bullish → lowest swing low
  // Only the top 4 resulting lines are ever kept (see slice(0, 4) below), and the strongest
  // anchors are overwhelmingly where winning lines come from — so cap the anchor candidates
  // here too. Without this, cost scales O(swings²) with however many swings a volatile pair
  // happens to have; capping bounds it to O(MAX_ANCHORS × swings) regardless.
  const MAX_ANCHORS = 15;
  const sortedBySignificance = [...swings].sort((a, b) =>
    type === "resistance"
      ? candles[b]!.high - candles[a]!.high  // highest first
      : candles[a]!.low  - candles[b]!.low   // lowest first
  ).slice(0, MAX_ANCHORS);

  for (const anchorIdx of sortedBySignificance) {
    const priceA = type === "resistance" ? candles[anchorIdx]!.high : candles[anchorIdx]!.low;

    // Try each later swing in chronological order as the second point
    const laterSwings = swings.filter(i => i > anchorIdx).sort((a, b) => a - b);

    for (const endIdx of laterSwings) {
      if (endIdx - anchorIdx < 15) continue;

      const priceB = type === "resistance" ? candles[endIdx]!.high : candles[endIdx]!.low;
      const slope  = (priceB - priceA) / (endIdx - anchorIdx);

      // Strictly descending resistance (p2 < p1); strictly ascending support (p2 > p1)
      if (type === "resistance" && slope >= 0) continue;
      if (type === "support"    && slope <= 0) continue;

      // No candle high/low between the two anchors may pierce the line
      let clean = true;
      for (let k = anchorIdx + 1; k < endIdx; k++) {
        const proj = priceA + slope * (k - anchorIdx);
        if (type === "resistance" && candles[k]!.high > proj + tolerance) { clean = false; break; }
        if (type === "support"    && candles[k]!.low  < proj - tolerance) { clean = false; break; }
      }
      if (!clean) continue;

      // Count additional touches
      let touches = 2;
      for (let k = anchorIdx + 1; k < endIdx; k++) {
        const proj  = priceA + slope * (k - anchorIdx);
        const price = type === "resistance" ? candles[k]!.high : candles[k]!.low;
        if (Math.abs(price - proj) <= atr * tunables.touchToleranceAtr) touches++;
      }
      if (touches < tunables.minTouches) continue;

      result.push({
        type, p1Index: anchorIdx, p2Index: endIdx,
        p1Price: priceA, p2Price: priceB,
        slope, touches, strength: 50 + touches * 5,
      });
    }
  }

  result.sort((a, b) => b.p2Index !== a.p2Index ? b.p2Index - a.p2Index : b.touches - a.touches);
  return result.slice(0, 4);
}

// ── TP-at-level targeting ───────────────────────────────────────────────────────

// Finds the nearest opposing S/R zone ahead of entry in the trade's direction, reusing the
// same zone detection the chart overlay uses. Returns null if none exists (e.g. clear air
// ahead) — the caller falls back to the R:R-based target rather than leaving TP unset.
function findTpAtLevel(
  candles:    Candle[],
  entryPrice: number,
  breakDir:   "buy" | "sell",
  atr:        number,
): number | null {
  const zones      = detectZones(candles, "4H", atr);
  const targetType = breakDir === "buy" ? "resistance" : "support";
  const ahead       = zones.filter(z =>
    targetType === "resistance" ? z.midpoint > entryPrice : z.midpoint < entryPrice
  );
  const nearest = getNearestZone(entryPrice, ahead, targetType);
  return nearest ? nearest.midpoint : null;
}

// ── Detect breakout from a single trendline ───────────────────────────────────

/**
 * Long:  descending resistance trendline broken + retested (line flips to support)
 * Short: ascending support trendline broken + retested (line flips to resistance)
 * SL is placed just beyond the broken trendline at the retest bar.
 */
function detectSetupForLine(
  candles:   Candle[],
  line:      DetectedLine,
  atr:       number,
  rrRatio:   number,
  dailyBias: "bullish" | "bearish" | "neutral",
  tunables:  TrendlineTunables,
  tpMode:    TpMode,
  requireCandleConfirmation: boolean,
): TrendlineSignal | null {
  // Direction follows line type: resistance break → long, support break → short
  const breakDir: "buy" | "sell" = line.type === "resistance" ? "buy" : "sell";

  // Daily bias filter (neutral = allow both directions)
  if (dailyBias === "bullish" && breakDir === "sell") return null;
  if (dailyBias === "bearish" && breakDir === "buy")  return null;

  const total          = candles.length;
  const breakThreshold = atr * tunables.breakThresholdAtr;

  // ── Phase 1: find the initial break close ────────────────────────────────────
  const scanFrom = Math.max(line.p2Index + 1, total - 30);
  let breakIdx   = -1;

  for (let i = scanFrom; i < total - 1; i++) {
    const c    = candles[i]!;
    const proj = projectPrice(line, i);
    if (breakDir === "buy"  && c.close > proj + breakThreshold) { breakIdx = i; break; }
    if (breakDir === "sell" && c.close < proj - breakThreshold) { breakIdx = i; break; }
  }
  if (breakIdx === -1) return null;

  // ── Phase 2: retest of the broken trendline ───────────────────────────────────
  // Price must return to the broken line within retestWindowBars and close back on the
  // break side — confirming the line has flipped from resistance to support (or vice versa).
  const retestWindow = Math.min(breakIdx + tunables.retestWindowBars, total);
  let retestIdx = -1;

  for (let i = breakIdx + 1; i < retestWindow; i++) {
    const c    = candles[i]!;
    const proj = projectPrice(line, i);

    if (breakDir === "buy") {
      const touchedLine = c.low  <= proj + breakThreshold;
      const heldAbove   = c.close > proj;
      if (touchedLine && heldAbove) { retestIdx = i; break; }
      if (c.close < proj - breakThreshold) break; // break failed — abort
    } else {
      const touchedLine = c.high >= proj - breakThreshold;
      const heldBelow   = c.close < proj;
      if (touchedLine && heldBelow) { retestIdx = i; break; }
      if (c.close > proj + breakThreshold) break;
    }
  }

  if (retestIdx === -1) return null;
  if (retestIdx < total - tunables.retestRecencyBars) return null; // stale — retest not recent enough

  // Optional extra confirmation: require the retest candle itself to be a bullish/bearish
  // engulfing (or hammer/shooting star) in the break direction, not just a close on the
  // right side of the line.
  if (requireCandleConfirmation) {
    const confirmed = breakDir === "buy"
      ? isBullishEngulfing(candles, retestIdx)
      : isBearishEngulfing(candles, retestIdx);
    if (!confirmed) return null;
  }

  // ── Trade levels ─────────────────────────────────────────────────────────────
  const retestCandle  = candles[retestIdx]!;
  const lineAtRetest  = projectPrice(line, retestIdx);
  const stopBuffer    = atr * tunables.slBufferAtr;

  const entryPrice = retestCandle.close;
  const stopLoss   = breakDir === "buy"
    ? lineAtRetest - stopBuffer   // SL just below flipped support
    : lineAtRetest + stopBuffer;  // SL just above flipped resistance

  const stopDist = Math.abs(entryPrice - stopLoss);
  if (stopDist < atr * tunables.minStopDistAtr) return null;

  const rrTakeProfit = breakDir === "buy"
    ? entryPrice + stopDist * rrRatio
    : entryPrice - stopDist * rrRatio;

  // atLevel targets the next opposing S/R zone instead of a fixed R:R multiple — but only
  // if that target is at least as far as the stop (R:R >= 1). A zone sitting almost on top
  // of entry would otherwise produce a trade with worse-than-coinflip payoff economics;
  // falling back to the R:R target in that case keeps every trade's reward sane.
  let takeProfit = rrTakeProfit;
  if (tpMode === "atLevel") {
    const levelTarget = findTpAtLevel(candles, entryPrice, breakDir, atr);
    if (levelTarget !== null && Math.abs(levelTarget - entryPrice) >= stopDist) {
      takeProfit = levelTarget;
    }
  }

  // ── Scoring ───────────────────────────────────────────────────────────────────
  let score = 55;
  score += dailyBias !== "neutral" ? 20 : 0;
  score += Math.min((line.touches - 2) * 5, 10); // bonus for extra touches (max +10)
  const rrActual = stopDist > 0 ? Math.abs(takeProfit - entryPrice) / stopDist : 0;
  if (rrActual >= 2)   score += 15;
  else if (rrActual >= 1.5) score += 10;
  score = Math.min(100, Math.round(score));

  const lineLabel    = line.type === "resistance" ? "Descending resistance" : "Ascending support";
  const projAtBreak  = projectPrice(line, breakIdx);
  const projAtRetest = projectPrice(line, retestIdx);
  const pair         = candles[0]!.pair;

  return {
    direction:     breakDir,
    entryPrice:    roundPrice(entryPrice, pair),
    stopLoss:      roundPrice(stopLoss, pair),
    takeProfit:    roundPrice(takeProfit, pair),
    score,
    reasons: [
      `${lineLabel} trendline break: close ${breakDir === "buy" ? "above" : "below"} ${projAtBreak.toFixed(5)} (${line.touches} touches)`,
      `Retest confirmed: line held at ${projAtRetest.toFixed(5)} (${retestIdx - breakIdx} bar${retestIdx - breakIdx !== 1 ? "s" : ""} after break)`,
      `SL just ${breakDir === "buy" ? "below" : "above"} broken line: ${stopLoss.toFixed(5)}`,
      dailyBias !== "neutral" ? `Daily bias: ${dailyBias} (aligned)` : "Daily bias: neutral",
    ],
    actionLine:    line,
    safetyLine:    line,  // same line used for SL projection (slope trails the trendline)
    breakIndex:    breakIdx,
    retestIndex:   retestIdx,
    safetyAtEntry: roundPrice(lineAtRetest, pair),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Main entry point. Pass 4H candles and optionally daily candles for bias filtering.
 */
export function detectTrendlineSignal(
  candles:      Candle[],
  rrRatio       = 1.5,
  lookback      = 5,
  dailyCandles?: Candle[],
  tunables:     Partial<TrendlineTunables> = {},
  tpMode:       TpMode = "rr",
  requireCandleConfirmation = false,
): TrendlineSignal | null {
  if (candles.length < 50) return null;

  const t = { ...DEFAULT_TRENDLINE_TUNABLES, ...tunables };

  const atr = calculateATR(candles);
  if (atr <= 0) return null;

  const dailyBias = dailyCandles ? getDailyBias(dailyCandles) : "neutral";

  const highs = swingHighs(candles, lookback);
  const lows  = swingLows(candles,  lookback);

  // Longs: scan all descending resistance lines for a break+retest
  // Shorts: scan all ascending support lines for a break+retest
  const resistanceLines = buildLines(candles, highs, "resistance", atr, t);
  const supportLines    = buildLines(candles, lows,  "support",    atr, t);

  const signals: TrendlineSignal[] = [];

  for (const line of resistanceLines) {
    const sig = detectSetupForLine(candles, line, atr, rrRatio, dailyBias, t, tpMode, requireCandleConfirmation);
    if (sig) signals.push(sig);
  }

  for (const line of supportLines) {
    const sig = detectSetupForLine(candles, line, atr, rrRatio, dailyBias, t, tpMode, requireCandleConfirmation);
    if (sig) signals.push(sig);
  }

  if (signals.length === 0) return null;
  return signals.sort((a, b) => b.score - a.score)[0]!;
}

/**
 * Check whether price has crossed the Safety Line — exit signal for live trades.
 */
export function isSafetyLineCrossed(
  currentPrice: number,
  direction:    "buy" | "sell",
  safetyLine:   DetectedLine,
  currentIndex: number,
): boolean {
  const proj = projectPrice(safetyLine, currentIndex);
  return direction === "buy" ? currentPrice < proj : currentPrice > proj;
}

export interface TrendlineOverlayLine {
  type:        "resistance" | "support";
  p1Timestamp: number;
  p2Timestamp: number;
  p1Price:     number;
  p2Price:     number;
  currentPrice: number;
  touches:     number;
}

export interface TrendlineOverlayResult {
  resistanceLines: TrendlineOverlayLine[];
  supportLines:    TrendlineOverlayLine[];
}

/**
 * Builds trendlines for chart overlay use.
 *
 * Rules that must ALL be satisfied:
 *   1. Anchor = highest swing high (resistance) / lowest swing low (support).
 *   2. p2 must be within the last 60 bars — older endpoints project too far right.
 *   3. Every candle HIGH between p1 and p2 must sit AT OR BELOW the resistance line
 *      (and every LOW above the support line). Strict — no candle may pierce.
 *   4. The line must still be unbroken between p2 and the current bar — if price
 *      has already closed through it, the line is historical and is excluded.
 */
function buildLinesFromAnchor(
  candles:   Candle[],
  swings:    number[],
  type:      "resistance" | "support",
  atr:       number,
  maxLines = 5,
): DetectedLine[] {
  if (swings.length < 2) return [];
  const n         = candles.length;
  const tolerance = atr * 0.15; // tight: only allow minor wick overshoot
  const result: DetectedLine[] = [];

  // Most significant anchor: highest swing high for resistance, lowest low for support
  const byPrice = [...swings].sort((a, b) =>
    type === "resistance"
      ? candles[b]!.high - candles[a]!.high
      : candles[a]!.low  - candles[b]!.low,
  );
  // Try the two most significant anchors for variety
  const anchors = byPrice.slice(0, 2);

  for (const anchorIdx of anchors) {
    const priceA = type === "resistance" ? candles[anchorIdx]!.high : candles[anchorIdx]!.low;

    // p2 must be a RECENT swing point — prevents lines extending far through current bars
    const recentSwings = swings.filter(i => i > anchorIdx && i >= n - 60);

    for (const endIdx of recentSwings) {
      const priceB = type === "resistance" ? candles[endIdx]!.high : candles[endIdx]!.low;
      const slope  = (priceB - priceA) / (endIdx - anchorIdx);

      // Strictly descending resistance; strictly ascending support
      if (type === "resistance" && slope >= 0) continue;
      if (type === "support"    && slope <= 0) continue;
      if (endIdx - anchorIdx < 8) continue;

      // Rule 3: every candle between the anchors must not pierce the line
      let clean = true;
      for (let k = anchorIdx + 1; k < endIdx; k++) {
        const proj = priceA + slope * (k - anchorIdx);
        if (type === "resistance" && candles[k]!.high > proj + tolerance) { clean = false; break; }
        if (type === "support"    && candles[k]!.low  < proj - tolerance) { clean = false; break; }
      }
      if (!clean) continue;

      // Rule 4: line must still be unbroken from p2 to the current bar
      for (let k = endIdx + 1; k < n; k++) {
        const proj = priceA + slope * (k - anchorIdx);
        // Use close (not wick) for post-p2 break detection — a wick past is ok, a close past is not
        if (type === "resistance" && candles[k]!.close > proj + atr * 0.3) { clean = false; break; }
        if (type === "support"    && candles[k]!.close < proj - atr * 0.3) { clean = false; break; }
      }
      if (!clean) continue;

      // Count additional touches
      let touches = 2;
      for (let k = anchorIdx + 1; k < endIdx; k++) {
        const proj  = priceA + slope * (k - anchorIdx);
        const price = type === "resistance" ? candles[k]!.high : candles[k]!.low;
        if (Math.abs(price - proj) <= atr * 0.3) touches++;
      }

      result.push({
        type, p1Index: anchorIdx, p2Index: endIdx, p1Price: priceA, p2Price: priceB,
        slope, touches, strength: 50 + touches * 5,
      });
    }
  }

  result.sort((a, b) => b.p2Index !== a.p2Index ? b.p2Index - a.p2Index : b.touches - a.touches);
  return result.slice(0, maxLines);
}

/**
 * Returns all valid trendlines for chart rendering — resistance lines descending
 * from the highest swing high and support lines ascending from the lowest swing low.
 * Lines are returned separately (not as converging pairs) so the chart shows all of them.
 */
export function detectTrendlineOverlays(
  candles:      Candle[],
  _dailyCandles?: Candle[],
): TrendlineOverlayResult {
  if (candles.length < 50) return { resistanceLines: [], supportLines: [] };
  const atr = calculateATR(candles);
  if (atr <= 0) return { resistanceLines: [], supportLines: [] };

  // Wider lookback finds more significant swing pivots for cleaner trendlines
  const highs = swingHighs(candles, 8);
  const lows  = swingLows(candles,  8);

  const resistance = buildLinesFromAnchor(candles, highs, "resistance", atr);
  const support    = buildLinesFromAnchor(candles, lows,  "support",    atr);

  const lastIdx = candles.length - 1;
  const toOverlay = (line: DetectedLine): TrendlineOverlayLine => ({
    type:         line.type,
    p1Timestamp:  candles[line.p1Index]!.timestamp,
    p2Timestamp:  candles[line.p2Index]!.timestamp,
    p1Price:      line.p1Price,
    p2Price:      line.p2Price,
    currentPrice: projectPrice(line, lastIdx),
    touches:      line.touches,
  });

  return {
    resistanceLines: resistance.map(toOverlay),
    supportLines:    support.map(toOverlay),
  };
}
