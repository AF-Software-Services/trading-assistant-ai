import type { Candle, Timeframe } from "../types/market.ts";
import type { SupportResistanceZone } from "../types/trading.ts";
import { ZONE_ATR_MULTIPLIER, MIN_ZONE_TOUCHES } from "../config/index.ts";
import { detectSwingPoints } from "./market-structure.ts";
import { calculateATR } from "./trend.ts";

const TIMEFRAME_WEIGHT: Record<Timeframe, number> = {
  W:  40,
  D:  30,
  "4H": 20,
  "1H": 10,
};

/**
 * Group nearby pivot prices into zones. Two pivots are merged if they are
 * within `atr * ZONE_ATR_MULTIPLIER` of each other.
 */
function groupPivots(
  prices: Array<{ price: number; timestamp: number }>,
  atr: number,
  tolerance: number
): Array<{ prices: number[]; firstSeenAt: number; lastTestedAt: number }> {
  const groups: Array<{ prices: number[]; firstSeenAt: number; lastTestedAt: number }> = [];

  for (const p of prices) {
    let merged = false;
    for (const g of groups) {
      const avg = g.prices.reduce((a, b) => a + b, 0) / g.prices.length;
      if (Math.abs(p.price - avg) <= atr * tolerance) {
        g.prices.push(p.price);
        if (p.timestamp < g.firstSeenAt) g.firstSeenAt = p.timestamp;
        if (p.timestamp > g.lastTestedAt) g.lastTestedAt = p.timestamp;
        merged = true;
        break;
      }
    }
    if (!merged) {
      groups.push({ prices: [p.price], firstSeenAt: p.timestamp, lastTestedAt: p.timestamp });
    }
  }

  return groups;
}

/**
 * Detect support and resistance zones from swing points.
 */
export function detectZones(
  candles: Candle[],
  timeframe: Timeframe,
  atr: number
): SupportResistanceZone[] {
  if (candles.length === 0) return [];
  const pair = candles[0]?.pair ?? "EUR/USD";
  const swings = detectSwingPoints(candles);

  const resistancePivots = swings
    .filter(sp => sp.label === "HH" || sp.label === "LH")
    .map(sp => ({ price: sp.price, timestamp: sp.timestamp }));

  const supportPivots = swings
    .filter(sp => sp.label === "HL" || sp.label === "LL")
    .map(sp => ({ price: sp.price, timestamp: sp.timestamp }));

  const tolerance = ZONE_ATR_MULTIPLIER;
  const resistanceGroups = groupPivots(resistancePivots, atr, tolerance);
  const supportGroups    = groupPivots(supportPivots, atr, tolerance);

  const zones: SupportResistanceZone[] = [];
  const tfWeight = TIMEFRAME_WEIGHT[timeframe];

  for (const g of resistanceGroups) {
    if (g.prices.length < MIN_ZONE_TOUCHES) continue;
    const low  = Math.min(...g.prices);
    const high = Math.max(...g.prices);
    const midpoint = (low + high) / 2;
    const touchCount = g.prices.length;
    const strength = scoreZoneRaw(touchCount, tfWeight, g.lastTestedAt, false);
    zones.push({
      pair,
      timeframe,
      type: "resistance",
      low:  +low.toFixed(5),
      high: +high.toFixed(5),
      midpoint: +midpoint.toFixed(5),
      strength,
      touchCount,
      firstSeenAt:  g.firstSeenAt,
      lastTestedAt: g.lastTestedAt,
      isBroken: false,
      isRetested: touchCount >= 3,
      confidence: strength,
    });
  }

  for (const g of supportGroups) {
    if (g.prices.length < MIN_ZONE_TOUCHES) continue;
    const low  = Math.min(...g.prices);
    const high = Math.max(...g.prices);
    const midpoint = (low + high) / 2;
    const touchCount = g.prices.length;
    const strength = scoreZoneRaw(touchCount, tfWeight, g.lastTestedAt, false);
    zones.push({
      pair,
      timeframe,
      type: "support",
      low:  +low.toFixed(5),
      high: +high.toFixed(5),
      midpoint: +midpoint.toFixed(5),
      strength,
      touchCount,
      firstSeenAt:  g.firstSeenAt,
      lastTestedAt: g.lastTestedAt,
      isBroken: false,
      isRetested: touchCount >= 3,
      confidence: strength,
    });
  }

  return zones;
}

function scoreZoneRaw(
  touchCount: number,
  tfWeight: number,
  lastTestedAt: number,
  isRetested: boolean
): number {
  // Touch count contribution (up to 40 pts)
  const touchScore = Math.min(touchCount * 10, 40);

  // Timeframe weight (up to 40 pts, already 10–40)
  const tfScore = tfWeight;

  // Freshness: more recent = stronger (up to 10 pts)
  const ageMs = Date.now() - lastTestedAt;
  const ageDays = ageMs / 86_400_000;
  const freshnessScore = Math.max(0, 10 - ageDays * 0.5);

  // Retest bonus (up to 10 pts)
  const retestScore = isRetested ? 10 : 0;

  return Math.min(100, Math.round(touchScore + tfScore + freshnessScore + retestScore));
}

/**
 * Score a zone (public API uses the zone's own fields).
 */
export function scoreZone(zone: SupportResistanceZone): number {
  return scoreZoneRaw(
    zone.touchCount,
    TIMEFRAME_WEIGHT[zone.timeframe],
    zone.lastTestedAt,
    zone.isRetested
  );
}

/**
 * Returns true when price is within tolerance of a zone's range.
 * Default tolerance = 20% of zone height, minimum 0.0001.
 */
export function isNearZone(
  price: number,
  zone: SupportResistanceZone,
  tolerance?: number
): boolean {
  const zoneHeight = zone.high - zone.low;
  const tol = tolerance ?? Math.max(zoneHeight * 0.2, 0.0001);
  return price >= zone.low - tol && price <= zone.high + tol;
}

/**
 * Return the nearest zone of the given type, or null if none exist.
 */
export interface ZoneAlert {
  zone: SupportResistanceZone;
  distanceAtr: number; // how many ATRs away price is from zone midpoint
  status: "testing" | "approaching"; // testing = inside zone, approaching = within 0.5 ATR
}

/**
 * Mark zones broken by the current live price.
 * A resistance zone is broken if price has closed or is currently trading above its high.
 * A support zone is broken if price is trading below its low.
 * Call this after detectZones() to keep isBroken status current with intraday price.
 */
export function markBrokenByPrice(
  zones: SupportResistanceZone[],
  livePrice: number,
  atr: number,
): SupportResistanceZone[] {
  return zones.map(z => {
    if (z.isBroken) return z;
    const clearance = atr * 0.3; // price must be meaningfully through the zone, not just touching
    const broken =
      (z.type === "resistance" && livePrice > z.high + clearance) ||
      (z.type === "support"    && livePrice < z.low  - clearance);
    return broken ? { ...z, isBroken: true } : z;
  });
}

/**
 * Return zones that price is currently testing or approaching (within 0.5 ATR).
 * "testing" = price is inside the zone bounds.
 * "approaching" = price is within 0.5 ATR of the zone midpoint.
 */
export function getZoneAlerts(
  price: number,
  zones: SupportResistanceZone[],
  atr: number
): ZoneAlert[] {
  const alerts: ZoneAlert[] = [];
  for (const zone of zones) {
    if (zone.isBroken) continue;
    const distanceAtr = Math.abs(price - zone.midpoint) / atr;
    if (price >= zone.low && price <= zone.high) {
      alerts.push({ zone, distanceAtr: 0, status: "testing" });
    } else if (distanceAtr <= 0.5) {
      alerts.push({ zone, distanceAtr: +distanceAtr.toFixed(2), status: "approaching" });
    }
  }
  return alerts.sort((a, b) => a.distanceAtr - b.distanceAtr);
}

/**
 * Detect fresh price reaction levels from the last N candles — areas where price
 * sharply reversed but hasn't yet formed enough touches to become a confirmed zone.
 * Useful for flagging new lows/highs before swing-point detection catches them.
 */
export function detectReactionLevels(
  candles: Candle[],
  atr: number,
  lookback = 10,
): Array<{ type: "support" | "resistance"; price: number; strength: "strong" | "moderate"; candleAt: number; description: string }> {
  const slice   = candles.slice(-lookback);
  const results: Array<{ type: "support" | "resistance"; price: number; strength: "strong" | "moderate"; candleAt: number; description: string }> = [];

  for (let i = 1; i < slice.length - 1; i++) {
    const c    = slice[i]!;
    const prev = slice[i - 1]!;
    const next = slice[i + 1]!;

    const body      = Math.abs(c.close - c.open);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const upperWick = c.high - Math.max(c.open, c.close);
    const range     = c.high - c.low;

    // Support reaction: long lower wick (≥ 40% of range) AND next candle closes higher
    if (lowerWick >= range * 0.4 && lowerWick >= atr * 0.3 && next.close > c.low + atr * 0.5) {
      const strength = lowerWick >= atr * 0.8 ? "strong" : "moderate";
      results.push({
        type: "support",
        price: +c.low.toFixed(5),
        strength,
        candleAt: c.timestamp,
        description: `${strength} rejection wick at ${c.low.toFixed(5)} — lower wick ${(lowerWick / atr).toFixed(1)}× ATR, bounce confirmed next candle`,
      });
    }

    // Resistance reaction: long upper wick (≥ 40% of range) AND next candle closes lower
    if (upperWick >= range * 0.4 && upperWick >= atr * 0.3 && next.close < c.high - atr * 0.5) {
      const strength = upperWick >= atr * 0.8 ? "strong" : "moderate";
      results.push({
        type: "resistance",
        price: +c.high.toFixed(5),
        strength,
        candleAt: c.timestamp,
        description: `${strength} rejection wick at ${c.high.toFixed(5)} — upper wick ${(upperWick / atr).toFixed(1)}× ATR, rejection confirmed next candle`,
      });
    }

    // Sharp V-reversal support: big red candle followed immediately by big green candle
    if (i >= 1) {
      const bigDrop   = prev.close < prev.open && (prev.open - prev.close) >= atr * 0.5;
      const bigBounce = c.close > c.open && (c.close - c.open) >= atr * 0.5 && c.low <= prev.low;
      if (bigDrop && bigBounce) {
        results.push({
          type: "support",
          price: +Math.min(prev.low, c.low).toFixed(5),
          strength: "strong",
          candleAt: c.timestamp,
          description: `V-reversal support at ${Math.min(prev.low, c.low).toFixed(5)} — sharp drop then immediate strong bounce`,
        });
      }
    }
  }

  // Deduplicate levels within 0.5 ATR of each other
  const deduped: typeof results = [];
  for (const r of results) {
    const dup = deduped.find(d => d.type === r.type && Math.abs(d.price - r.price) < atr * 0.5);
    if (!dup) deduped.push(r);
  }
  return deduped;
}

export interface AreaOfInterest {
  bias:       "bullish" | "bearish";
  low:        number;   // lower bound of the AOI
  high:       number;   // upper bound of the AOI
  zones:      SupportResistanceZone[];  // weekly zones inside the AOI
  swingLow:   number;   // the HL (bullish) or LL (bearish) that defines the floor
  swingHigh:  number;   // the HH (bullish) or LH (bearish) that defines the ceiling
  entryIdeal: number;   // upper edge of AOI for buy, lower edge for sell
  description: string;
}

/**
 * Identify an Area of Interest on the weekly chart.
 *
 * A bullish AOI sits between the most recent Higher Low and Higher High on W.
 * A bearish AOI sits between the most recent Lower High and Lower Low on W.
 * At least 3 weekly S/R zones must cluster within that swing range for the
 * AOI to be considered valid — fewer zones means insufficient confluence.
 */
export function detectAreaOfInterest(
  candlesW: Candle[],
  atr: number,
  minZones = 3,
): AreaOfInterest | null {
  if (candlesW.length < 10) return null;

  const swings = detectSwingPoints(candlesW);
  const zones  = detectZones(candlesW, "W", atr).filter(z => !z.isBroken);

  if (swings.length < 4 || zones.length < minZones) return null;

  // Look for a bullish AOI: most recent HL followed by a HH
  const bullish = (() => {
    for (let i = swings.length - 1; i >= 1; i--) {
      const curr = swings[i]!;
      const prev = swings[i - 1]!;
      if (curr.label === "HH" && prev.label === "HL") {
        const floor   = prev.price;  // HL
        const ceiling = curr.price;  // HH
        const inside  = zones.filter(z => z.midpoint >= floor && z.midpoint <= ceiling);
        if (inside.length >= minZones) {
          const entryIdeal = inside.reduce((min, z) => z.low < min ? z.low : min, inside[0]!.low);
          return {
            bias: "bullish" as const,
            low: floor, high: ceiling,
            zones: inside,
            swingLow: floor, swingHigh: ceiling,
            entryIdeal,
            description: `Bullish AOI between W-HL ${floor.toFixed(5)} and W-HH ${ceiling.toFixed(5)} — ${inside.length} weekly zones confluent. Ideal entry near ${entryIdeal.toFixed(5)}.`,
          };
        }
      }
    }
    return null;
  })();

  if (bullish) return bullish;

  // Look for a bearish AOI: most recent LH followed by a LL
  for (let i = swings.length - 1; i >= 1; i--) {
    const curr = swings[i]!;
    const prev = swings[i - 1]!;
    if (curr.label === "LL" && prev.label === "LH") {
      const ceiling = prev.price;  // LH
      const floor   = curr.price;  // LL
      const inside  = zones.filter(z => z.midpoint >= floor && z.midpoint <= ceiling);
      if (inside.length >= minZones) {
        const entryIdeal = inside.reduce((max, z) => z.high > max ? z.high : max, inside[0]!.high);
        return {
          bias: "bearish" as const,
          low: floor, high: ceiling,
          zones: inside,
          swingLow: floor, swingHigh: ceiling,
          entryIdeal,
          description: `Bearish AOI between W-LH ${ceiling.toFixed(5)} and W-LL ${floor.toFixed(5)} — ${inside.length} weekly zones confluent. Ideal entry near ${entryIdeal.toFixed(5)}.`,
        };
      }
    }
  }

  return null;
}

export function getNearestZone(
  price: number,
  zones: SupportResistanceZone[],
  type: "support" | "resistance"
): SupportResistanceZone | null {
  const filtered = zones.filter(z => z.type === type && !z.isBroken);
  if (filtered.length === 0) return null;

  return filtered.reduce((nearest, zone) => {
    const distNearest = Math.abs(price - nearest.midpoint);
    const distZone    = Math.abs(price - zone.midpoint);
    return distZone < distNearest ? zone : nearest;
  });
}
