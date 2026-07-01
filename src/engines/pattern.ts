import type { Candle } from "../types/market.ts";
import type { ChartPattern } from "../types/trading.ts";

// TODO v2: implement with multi-bar state machine.
// Each pattern requires tracking interim swing points across multiple candles.
// Suggested approach: maintain a stateful PatternScanner class that processes
// one candle at a time and emits events when patterns complete.

/**
 * Detect a double top pattern.
 * TODO v2: A double top forms when price makes two roughly equal highs separated
 * by a trough. Confirm when price closes below the neckline (trough low).
 * Target = neckline - (high - neckline).
 */
export function detectDoubleTop(_candles: Candle[]): ChartPattern | null {
  // TODO v2: implement
  return null;
}

/**
 * Detect a double bottom pattern.
 * TODO v2: A double bottom forms when price makes two roughly equal lows separated
 * by a peak. Confirm when price closes above the neckline (peak high).
 * Target = neckline + (neckline - low).
 */
export function detectDoubleBottom(_candles: Candle[]): ChartPattern | null {
  // TODO v2: implement
  return null;
}

/**
 * Detect a head and shoulders pattern.
 * TODO v2: Left shoulder (high) → head (higher high) → right shoulder (lower high,
 * approximately equal to left). Neckline connects the two troughs. Confirm on
 * break below neckline. Target = neckline - (head - neckline).
 */
export function detectHeadAndShoulders(_candles: Candle[]): ChartPattern | null {
  // TODO v2: implement
  return null;
}

/**
 * Detect an inverse head and shoulders pattern (mirror of head and shoulders).
 * TODO v2: implement
 */
export function detectInverseHeadAndShoulders(_candles: Candle[]): ChartPattern | null {
  // TODO v2: implement
  return null;
}

/**
 * Run all pattern detectors and return confirmed/forming patterns.
 * In v1 this always returns an empty array.
 */
export function detectAllPatterns(_candles: Candle[]): ChartPattern[] {
  // TODO v2: aggregate results from all detectors
  return [];
}
