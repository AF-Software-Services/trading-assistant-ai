/**
 * DXY Regime Filter
 *
 * Shared module, not a bot — consulted by any bot's entry gate. Answers two questions:
 *   1. Direction veto: what is the dollar doing (bullish/bearish/neutral), and does a
 *      proposed trade fight it?
 *   2. Exposure cap: would this trade push the book's net USD notional past a configured
 *      limit, across every bot that's opted into this filter?
 *
 * Master toggle (`enabled`) and every per-instrument override default to OFF — an existing
 * bot's behavior is provably unchanged unless it's explicitly turned on.
 */

import type { Candle, CurrencyPair } from "../types/market.ts";
import type { MarketDataProvider } from "../providers/interface.ts";
import { detectSwingPoints, classifyTrend } from "./market-structure.ts";
import { pipFactor, PIP_VALUE_GBP } from "./pip-value.ts";

export type DxyRegimeState = "bullish" | "bearish" | "neutral";

export interface DxyRegime {
  state: DxyRegimeState;
  asOf: number;
  method: "structure";
}

export interface DxyFilterConfig {
  enabled: boolean;                         // master toggle — default false
  perInstrument?: Record<string, boolean>;  // per-symbol override; only consulted if enabled
  maxNetUsdExposure: number | null;         // GBP notional cap across the book; null = uncapped
  neutralAllowsBoth: boolean;               // default true
}

export const DEFAULT_DXY_FILTER_CONFIG: DxyFilterConfig = {
  enabled: false,
  maxNetUsdExposure: null,
  neutralAllowsBoth: true,
};

// ── Synthetic DXY ────────────────────────────────────────────────────────────────

// Exact ICE formula. cTrader brokers don't generally carry the real ICE dollar index, so
// this is the fallback — callers should try resolving a real DXY-style symbol from the
// broker's own symbol list first (same pattern as any other pair) and only fall back to
// this when none exists.
const DXY_BASE = 50.14348112;
const DXY_COMPONENTS: Array<{ pair: CurrencyPair; exponent: number }> = [
  { pair: "EUR/USD", exponent: -0.576 },
  { pair: "USD/JPY", exponent: 0.136 },
  { pair: "GBP/USD", exponent: -0.119 },
  { pair: "USD/CAD", exponent: 0.091 },
  { pair: "USD/SEK", exponent: 0.042 },
  { pair: "USD/CHF", exponent: 0.036 },
];
// EUR + JPY + GBP alone carry ~83% of the total exponent weight (0.576+0.136+0.119 of
// 1.0 total) — per spec, that's enough to trust a regime read even if a minor component
// (typically USD/SEK) is missing from the broker's symbol list. Below this, skip the point
// rather than compute a misleading value off too few components.
const MIN_COMPONENT_WEIGHT = 0.8;

const DUMMY_PAIR = "EUR/USD" as CurrencyPair; // synthetic candles have no real pair; harmless placeholder, never traded

/**
 * Builds a synthetic DXY close-only "candle" series (open=high=low=close, since regime
 * classification only needs closes — see spec) from whichever component pairs' candle
 * series are supplied. Missing components degrade gracefully: a point is only emitted if
 * the components present cover at least MIN_COMPONENT_WEIGHT of the formula's total weight.
 */
export function synthesizeDxyCandles(
  componentCandles: Partial<Record<CurrencyPair, Candle[]>>
): Candle[] {
  const closesByPair = new Map<CurrencyPair, Map<number, number>>();
  for (const { pair } of DXY_COMPONENTS) {
    const candles = componentCandles[pair];
    if (candles && candles.length > 0) {
      closesByPair.set(pair, new Map(candles.map(c => [c.timestamp, c.close])));
    }
  }
  if (closesByPair.size === 0) return [];

  // Anchor timestamps on whichever available component has the most data points.
  let anchorTimestamps: number[] = [];
  let anchorLen = 0;
  for (const m of closesByPair.values()) {
    if (m.size > anchorLen) { anchorLen = m.size; anchorTimestamps = [...m.keys()]; }
  }
  anchorTimestamps.sort((a, b) => a - b);

  const totalWeight = DXY_COMPONENTS.reduce((sum, c) => sum + Math.abs(c.exponent), 0);
  const out: Candle[] = [];

  for (const ts of anchorTimestamps) {
    let product = DXY_BASE;
    let usedWeight = 0;
    for (const { pair, exponent } of DXY_COMPONENTS) {
      const price = closesByPair.get(pair)?.get(ts);
      if (price === undefined || price <= 0) continue;
      product *= Math.pow(price, exponent);
      usedWeight += Math.abs(exponent);
    }
    if (usedWeight / totalWeight < MIN_COMPONENT_WEIGHT) continue;
    out.push({ timestamp: ts, open: product, high: product, low: product, close: product, timeframe: "4H", pair: DUMMY_PAIR });
  }
  return out;
}

// ── Regime classification ────────────────────────────────────────────────────────

// Reuses market-structure.ts's detectSwingPoints/classifyTrend wholesale — same
// bidirectional-fractal pivot detection and HH/HL/LH/LL classification the trendline and
// structure bots already use, not a reimplementation.
export function classifyDxyRegime(dxyCandles: Candle[]): DxyRegimeState {
  const bias = classifyTrend(detectSwingPoints(dxyCandles));
  if (bias === "uptrend") return "bullish";
  if (bias === "downtrend") return "bearish";
  return "neutral"; // "range" and "unclear" both mean "no clear regime" for this purpose
}

// ── Direction veto ───────────────────────────────────────────────────────────────

/**
 * +1 = trade goes long USD, -1 = trade goes short USD, 0 = non-USD cross (filter doesn't apply).
 * XXX/USD buy = short USD. USD/XXX buy = long USD. Sell is the mirror of buy in both cases.
 */
export function usdSign(pair: string, side: "buy" | "sell"): -1 | 0 | 1 {
  const isUsdQuote = pair.endsWith("/USD");
  const isUsdBase  = pair.startsWith("USD/");
  if (!isUsdQuote && !isUsdBase) return 0;
  const buySign: 1 | -1 = isUsdBase ? 1 : -1;
  return side === "buy" ? buySign : (-buySign as 1 | -1);
}

// ── Notional / exposure ──────────────────────────────────────────────────────────

// GBP notional = lots × lotSize × price × (conversion rate to GBP). Rather than fetching
// the broker's real lotSize separately, this is derived algebraically from the existing
// PIP_VALUE_GBP/PIP_SIZE tables (already the app's one source of truth for per-instrument
// contract specs), since PIP_VALUE_GBP[pair] = lotSize × PIP_SIZE[pair] × conversionRate:
//   conversionRate  = PIP_VALUE_GBP[pair] / (lotSize × PIP_SIZE[pair])
//   notionalGBP     = lots × lotSize × price × conversionRate
//                   = lots × price × PIP_VALUE_GBP[pair] / PIP_SIZE[pair]
//                   = lots × price × PIP_VALUE_GBP[pair] × pipFactor(pair)
// Same order-of-approximation the rest of the app's risk sizing already relies on — not a
// live cross-rate lookup, consistent with how PIP_VALUE_GBP itself is documented.
export function estimateNotionalGBP(pair: string, lots: number, price: number): number {
  const pipValueGbp = PIP_VALUE_GBP[pair] ?? 7.50;
  return lots * price * pipValueGbp * pipFactor(pair);
}

export interface OpenPositionForExposure {
  pair: string;
  direction: "buy" | "sell";
  lots: number;
  price: number; // current/open price, whichever is available
}

// ── Filter ────────────────────────────────────────────────────────────────────────

export class DxyFilter {
  private config: DxyFilterConfig;
  private regime: DxyRegime = { state: "neutral", asOf: 0, method: "structure" };
  private netUsdExposureGBP = 0;

  constructor(config: Partial<DxyFilterConfig> = {}) {
    this.config = { ...DEFAULT_DXY_FILTER_CONFIG, ...config };
  }

  /** Fetches component candles and recomputes the cached regime. Call once per bot scan tick. */
  async refreshRegime(provider: MarketDataProvider, lookback = 200): Promise<DxyRegime> {
    const results = await Promise.all(
      DXY_COMPONENTS.map(async ({ pair }) => {
        try { return [pair, await provider.getCandles(pair, "4H", lookback)] as const; }
        catch { return [pair, [] as Candle[]] as const; }
      })
    );
    const componentCandles: Partial<Record<CurrencyPair, Candle[]>> = {};
    for (const [pair, candles] of results) if (candles.length > 0) componentCandles[pair] = candles;

    const dxyCandles = synthesizeDxyCandles(componentCandles);
    const state = dxyCandles.length > 0 ? classifyDxyRegime(dxyCandles) : "neutral";
    this.regime = { state, asOf: Date.now(), method: "structure" };
    return this.regime;
  }

  getRegime(): DxyRegime {
    return this.regime;
  }

  /** The master toggle — callers use this to skip refreshRegime()/onPositionsChanged() entirely when off. */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  private isEnabledFor(instrument: string): boolean {
    if (!this.config.enabled) return false;
    return this.config.perInstrument?.[instrument] ?? true;
  }

  isTradeAllowed(symbol: string, side: "buy" | "sell", _botId: string): { allowed: boolean; reason: string } {
    if (!this.isEnabledFor(symbol)) return { allowed: true, reason: "DXY filter disabled for this bot/instrument" };

    const sign = usdSign(symbol, side);
    if (sign === 0) return { allowed: true, reason: "non-USD cross — filter doesn't apply" };

    const { state } = this.regime;
    if (state === "neutral") {
      return this.config.neutralAllowsBoth
        ? { allowed: true, reason: "regime neutral — both directions allowed" }
        : { allowed: false, reason: "regime neutral and neutralAllowsBoth is off" };
    }
    if (state === "bullish" && sign === 1)  return { allowed: true,  reason: "trade goes long USD, regime bullish" };
    if (state === "bearish" && sign === -1) return { allowed: true,  reason: "trade goes short USD, regime bearish" };
    return { allowed: false, reason: `trade fights the dollar — regime is ${state}` };
  }

  /** Replaces the cached open-position set used for exposure calc. Call after every scan/fetch. */
  onPositionsChanged(positions: OpenPositionForExposure[]): void {
    this.netUsdExposureGBP = positions.reduce((sum, p) => {
      const sign = usdSign(p.pair, p.direction);
      if (sign === 0) return sum;
      return sum + sign * estimateNotionalGBP(p.pair, p.lots, p.price);
    }, 0);
  }

  wouldBreachExposure(symbol: string, side: "buy" | "sell", notionalGBP: number): boolean {
    if (this.config.maxNetUsdExposure == null) return false;
    const sign = usdSign(symbol, side);
    if (sign === 0) return false;
    const projected = Math.abs(this.netUsdExposureGBP + sign * notionalGBP);
    return projected > this.config.maxNetUsdExposure;
  }
}
