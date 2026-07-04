import type { Direction, SupportResistanceZone, CandlestickSignal, MarketStructure, TrendAnalysis, ChartPattern } from "../types/trading.ts";
import type { MtfAlignment, TradeClass } from "./mtf-alignment.ts";
import type { FibZone } from "./fibonacci.ts";
import { priceAtFibLevel } from "./fibonacci.ts";

export interface ScoreBreakdown {
  htfAlignment:    number;  // max 30 — W/D/4H trend agreement
  discountPremium: number;  // max 25 — price at key level (zone + fib)
  triggerSignal:   number;  // max 20 — engulfing / H&S at that level
  structureIntact: number;  // max 15 — HH/HL or LH/LL still valid
  rrQuality:       number;  // max 10 — reward/risk ratio
  total:           number;  // max 100
  tradeClass:      TradeClass;
  blockers:        string[]; // reasons this setup was rejected / weakened
}

export function scoreTradeSetup(params: {
  direction:    "buy" | "sell";
  price:        number;
  atr:          number;
  mtf:          MtfAlignment;
  zones:        SupportResistanceZone[];
  fib:          FibZone | null;
  candleSignal: CandlestickSignal | null;
  structure:    MarketStructure;
  trend:        TrendAnalysis;
  pattern:      ChartPattern | null;
  estimatedRR:  number;
  tradeClass:   TradeClass;
}): ScoreBreakdown {
  const {
    direction, price, atr, mtf, zones, fib,
    candleSignal, structure, pattern, estimatedRR, tradeClass,
  } = params;

  const blockers: string[] = [];

  // ── 1. HTF Alignment (30 pts) ────────────────────────────────────────────────
  // All 3 aligned = 30, 2 aligned = 18, 1 = 0 (MIXED)
  // Counter trend gets a heavy penalty — only valid at major Weekly zones
  let htfAlignment = 0;
  if (tradeClass === "PRO_TREND") {
    htfAlignment = mtf.alignScore === 3 ? 30 : 18;
  } else if (tradeClass === "COUNTER_TREND") {
    htfAlignment = 8; // max possible for counter trend
    blockers.push("Counter trend — reduced score, major level required");
  } else {
    htfAlignment = 0;
    blockers.push("Mixed HTF signals — no clear bias");
  }

  // ── 2. Discount / Premium Zone (25 pts) ──────────────────────────────────────
  // Price must be AT a key level — W/D zone or Fib golden zone
  // 4H-only zone = partial credit
  let discountPremium = 0;
  const relevantType  = direction === "buy" ? "support" : "resistance";
  const relevantZones = zones.filter(z => z.type === relevantType && !z.isBroken);

  // Find if price is near a zone
  let bestZoneScore  = 0;
  let bestZoneTf     = "";
  for (const zone of relevantZones) {
    const dist = Math.abs(price - zone.midpoint) / atr;
    if (dist <= 1.0) {
      const tfScore = zone.timeframe === "W" ? 25
                    : zone.timeframe === "D" ? 20
                    : zone.timeframe === "4H" ? 12
                    : 6;
      const zoneQuality = Math.round((zone.strength / 100) * tfScore);
      if (zoneQuality > bestZoneScore) {
        bestZoneScore = zoneQuality;
        bestZoneTf    = zone.timeframe;
      }
    }
  }

  // Check Fib confluence
  let fibBonus = 0;
  if (fib) {
    const fibCheck = priceAtFibLevel(price, fib, atr);
    if (fibCheck.inGoldenZone) {
      fibBonus = 5; // golden zone (50-61.8%) bonus
    } else if (fibCheck.atLevel) {
      fibBonus = 3;
    }
  }

  discountPremium = Math.min(25, bestZoneScore + fibBonus);

  if (discountPremium === 0) {
    blockers.push("Price not at a key discount/premium level");
  } else if (discountPremium < 10 && bestZoneTf === "4H") {
    blockers.push("Only 4H zone — no Weekly/Daily confluence");
  }

  // Counter trend REQUIRES a Weekly/Daily zone — 4H alone is not enough
  if (tradeClass === "COUNTER_TREND" && bestZoneTf === "4H") {
    discountPremium = Math.min(discountPremium, 5);
    blockers.push("Counter trend needs Weekly/Daily level — 4H zone insufficient");
  }

  // ── 3. Trigger Signal (20 pts) ───────────────────────────────────────────────
  // Engulfing candle or H&S at the zone = trigger
  // Must be AT the level to score fully — signal in empty space scores low
  let triggerSignal = 0;
  const atLevel     = discountPremium >= 10;

  // Candlestick signal
  if (candleSignal) {
    const dirMatch =
      (direction === "buy"  && ["bullish_engulfing", "hammer", "pin_bar"].includes(candleSignal.type)) ||
      (direction === "sell" && ["bearish_engulfing", "shooting_star", "pin_bar"].includes(candleSignal.type));

    if (dirMatch) {
      const signalScore = Math.round((candleSignal.confidence / 100) * 16);
      triggerSignal = atLevel ? signalScore : Math.round(signalScore * 0.4);
    }
  }

  // H&S pattern (adds on top of or replaces candle signal)
  if (pattern) {
    const patternMatch =
      (direction === "buy"  && pattern.type === "inverse_head_and_shoulders") ||
      (direction === "sell" && pattern.type === "head_and_shoulders");

    if (patternMatch) {
      const patScore = pattern.status === "confirmed"
        ? Math.round((pattern.confidence / 100) * 20)
        : Math.round((pattern.confidence / 100) * 10);
      triggerSignal = Math.max(triggerSignal, atLevel ? patScore : Math.round(patScore * 0.5));
    }
  }

  if (triggerSignal === 0) {
    blockers.push("No trigger signal — waiting for engulfing candle or H&S confirmation");
  }

  // ── 4. Structure Intact (15 pts) ─────────────────────────────────────────────
  // Is the trend structure still valid? HL holding in uptrend, LH in downtrend
  let structureIntact = 0;
  const structTrend   = structure.trend;

  if (
    (direction === "buy"  && structTrend === "uptrend")   ||
    (direction === "sell" && structTrend === "downtrend")
  ) {
    structureIntact = 15;
  } else if (structTrend === "range") {
    structureIntact = 7;
    if (tradeClass === "PRO_TREND") blockers.push("4H structure ranging — less clear trend");
  } else {
    structureIntact = 0;
    blockers.push("4H structure opposes trade direction");
  }

  // ── 5. R:R Quality (10 pts) ──────────────────────────────────────────────────
  let rrQuality = 0;
  if (estimatedRR >= 5)      rrQuality = 10;
  else if (estimatedRR >= 4) rrQuality = 8;
  else if (estimatedRR >= 3) rrQuality = 5;
  else if (estimatedRR >= 2) rrQuality = 2;
  else {
    rrQuality = 0;
    blockers.push(`R:R too low (${estimatedRR.toFixed(1)}:1) — minimum 3:1 required`);
  }

  const total = Math.min(100,
    htfAlignment + discountPremium + triggerSignal + structureIntact + rrQuality
  );

  return {
    htfAlignment,
    discountPremium,
    triggerSignal,
    structureIntact,
    rrQuality,
    total,
    tradeClass,
    blockers,
  };
}

/**
 * Hard gates — setup must pass ALL of these regardless of total score.
 * Returns null if valid, or a rejection reason string.
 * signalConfidence ≥ 85 at a W/D zone unlocks softer counter-trend gates.
 */
export function checkHardGates(params: {
  score:            ScoreBreakdown;
  tradeClass:       TradeClass;
  estimatedRR:      number;
  signalConfidence?: number;
}): string | null {
  const { score, tradeClass, estimatedRR, signalConfidence = 0 } = params;
  const isHighConfReversal = tradeClass === "COUNTER_TREND" && signalConfidence >= 85;

  if (tradeClass === "MIXED") return "Mixed HTF signals — no trade";
  if (score.htfAlignment < 8)    return "Insufficient HTF alignment";
  if (score.discountPremium < 8) return "Price not at a discount/premium zone";

  const minRR = isHighConfReversal ? 2.0 : 2.5;
  if (estimatedRR < minRR) return `R:R too low (${estimatedRR.toFixed(1)}:1)`;

  // Counter trend: stricter requirements, slightly relaxed for high-confidence signals at key levels
  if (tradeClass === "COUNTER_TREND") {
    if (score.discountPremium < 15) return "Counter trend requires Weekly/Daily zone";
    const minTrigger = isHighConfReversal ? 8 : 10;
    if (score.triggerSignal < minTrigger) return "Counter trend requires strong trigger signal";
    const minTotal = isHighConfReversal ? 50 : 60;
    if (score.total < minTotal) return "Counter trend score too low";
  }

  return null;
}
