import type { Candle } from "../types/market.ts";
import type { TrendBias } from "../types/trading.ts";

export interface FibLevel {
  ratio:   number;   // 0.382, 0.5, 0.618 etc
  price:   number;
  label:   string;   // "38.2%", "50%", "61.8%"
  isDiscount: boolean; // true = buy zone, false = sell zone
}

export interface FibZone {
  swingHigh:  number;
  swingLow:   number;
  levels:     FibLevel[];
  bias:       TrendBias;
  // The "golden zone" — 50-61.8% retracement — highest probability entry
  goldenZoneHigh: number;
  goldenZoneLow:  number;
}

const RATIOS = [
  { ratio: 0.236, label: "23.6%" },
  { ratio: 0.382, label: "38.2%" },
  { ratio: 0.5,   label: "50.0%" },
  { ratio: 0.618, label: "61.8%" },
  { ratio: 0.786, label: "78.6%" },
];

/**
 * Find the most recent significant swing high and low from the last N candles.
 */
function findSwing(candles: Candle[], lookback = 50): { high: number; low: number; highIdx: number; lowIdx: number } {
  const slice = candles.slice(-lookback);
  let high = -Infinity, low = Infinity, highIdx = 0, lowIdx = 0;
  for (let i = 0; i < slice.length; i++) {
    if (slice[i]!.high > high) { high = slice[i]!.high; highIdx = i; }
    if (slice[i]!.low  < low)  { low  = slice[i]!.low;  lowIdx  = i; }
  }
  return { high, low, highIdx, lowIdx };
}

/**
 * Calculate Fibonacci retracement levels based on the prevailing trend bias.
 *
 * Uptrend  → swing from low to high → retracement levels are DISCOUNT zones (buy)
 * Downtrend → swing from high to low → retracement levels are PREMIUM zones (sell)
 */
export function calculateFibLevels(candles: Candle[], bias: TrendBias): FibZone | null {
  if (candles.length < 20) return null;
  if (bias !== "uptrend" && bias !== "downtrend") return null;

  const { high, low, highIdx, lowIdx } = findSwing(candles);
  if (high === low) return null;

  // Validate swing order — in uptrend low should precede high, vice versa for downtrend
  const swingValid = bias === "uptrend"
    ? lowIdx < highIdx
    : highIdx < lowIdx;

  // Still calculate even if swing order is off — just less reliable
  const range  = high - low;
  const levels: FibLevel[] = RATIOS.map(({ ratio, label }) => {
    // Uptrend: retrace DOWN from high (discount = below current price)
    // Downtrend: retrace UP from low (premium = above current price)
    const price = bias === "uptrend"
      ? high - range * ratio
      : low  + range * ratio;

    return {
      ratio,
      price: +price.toFixed(5),
      label,
      isDiscount: bias === "uptrend",
    };
  });

  // Golden zone: 50–61.8% retracement (highest probability reversal area)
  const goldenZoneHigh = bias === "uptrend"
    ? high - range * 0.5
    : low  + range * 0.618;
  const goldenZoneLow = bias === "uptrend"
    ? high - range * 0.618
    : low  + range * 0.5;

  return {
    swingHigh: +high.toFixed(5),
    swingLow:  +low.toFixed(5),
    levels,
    bias,
    goldenZoneHigh: +goldenZoneHigh.toFixed(5),
    goldenZoneLow:  +goldenZoneLow.toFixed(5),
  };
}

/**
 * Check if a price is within a Fibonacci discount/premium zone.
 * Returns the nearest level and whether price is in the golden zone.
 */
export function priceAtFibLevel(price: number, fib: FibZone, atr: number): {
  atLevel: boolean;
  inGoldenZone: boolean;
  nearestLevel: FibLevel | null;
  distanceAtr: number;
} {
  const tolerance = atr * 0.5;

  const inGoldenZone =
    price >= Math.min(fib.goldenZoneLow, fib.goldenZoneHigh) - tolerance &&
    price <= Math.max(fib.goldenZoneLow, fib.goldenZoneHigh) + tolerance;

  let nearestLevel: FibLevel | null = null;
  let minDist = Infinity;

  for (const level of fib.levels) {
    const dist = Math.abs(price - level.price);
    if (dist < minDist) {
      minDist = dist;
      nearestLevel = level;
    }
  }

  const distanceAtr = minDist / atr;
  const atLevel = distanceAtr <= 0.5;

  return { atLevel, inGoldenZone, nearestLevel, distanceAtr: +distanceAtr.toFixed(2) };
}
