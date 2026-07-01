import type { Candle } from "../types/market.ts";
import type { ChartPattern } from "../types/trading.ts";

function simpleATR(candles: Candle[]): number {
  const last = candles.slice(-14);
  return last.reduce((sum, c) => sum + (c.high - c.low), 0) / last.length;
}

interface SwingHigh {
  index: number;
  price: number;
  timestamp: number;
}

interface SwingLow {
  index: number;
  price: number;
  timestamp: number;
}

function getSwingHighs(candles: Candle[]): SwingHigh[] {
  const highs: SwingHigh[] = [];
  const slice = candles.slice(-100);
  const offset = candles.length - slice.length;
  for (let i = 1; i < slice.length - 1; i++) {
    if (slice[i]!.high > slice[i - 1]!.high && slice[i]!.high > slice[i + 1]!.high) {
      highs.push({ index: offset + i, price: slice[i]!.high, timestamp: slice[i]!.timestamp });
    }
  }
  return highs;
}

function getSwingLows(candles: Candle[]): SwingLow[] {
  const lows: SwingLow[] = [];
  const slice = candles.slice(-100);
  const offset = candles.length - slice.length;
  for (let i = 1; i < slice.length - 1; i++) {
    if (slice[i]!.low < slice[i - 1]!.low && slice[i]!.low < slice[i + 1]!.low) {
      lows.push({ index: offset + i, price: slice[i]!.low, timestamp: slice[i]!.timestamp });
    }
  }
  return lows;
}

/** Find local minimum between two candle indices */
function localMinBetween(candles: Candle[], fromIdx: number, toIdx: number): { price: number; timestamp: number } {
  let min = Infinity;
  let ts = candles[fromIdx]!.timestamp;
  for (let i = fromIdx; i <= toIdx && i < candles.length; i++) {
    if (candles[i]!.low < min) {
      min = candles[i]!.low;
      ts = candles[i]!.timestamp;
    }
  }
  return { price: min, timestamp: ts };
}

/** Find local maximum between two candle indices */
function localMaxBetween(candles: Candle[], fromIdx: number, toIdx: number): { price: number; timestamp: number } {
  let max = -Infinity;
  let ts = candles[fromIdx]!.timestamp;
  for (let i = fromIdx; i <= toIdx && i < candles.length; i++) {
    if (candles[i]!.high > max) {
      max = candles[i]!.high;
      ts = candles[i]!.timestamp;
    }
  }
  return { price: max, timestamp: ts };
}

export function detectHeadAndShoulders(candles: Candle[]): ChartPattern | null {
  if (candles.length < 20) return null;
  const atr = simpleATR(candles);
  const highs = getSwingHighs(candles);
  if (highs.length < 3) return null;

  let best: ChartPattern | null = null;

  for (let i = 0; i < highs.length - 2; i++) {
    const ls = highs[i]!;
    const head = highs[i + 1]!;
    const rs = highs[i + 2]!;

    if (head.price <= ls.price) continue;
    if (head.price <= rs.price) continue;
    if (Math.abs(ls.price - rs.price) >= atr * 2) continue;
    if (rs.index - ls.index < 10) continue;

    const trough1 = localMinBetween(candles, ls.index, head.index);
    const trough2 = localMinBetween(candles, head.index, rs.index);
    const necklinePrice = (trough1.price + trough2.price) / 2;
    const target = necklinePrice - (head.price - necklinePrice);

    const lastClose = candles[candles.length - 1]!.close;
    const status: "forming" | "confirmed" = lastClose < necklinePrice ? "confirmed" : "forming";

    const shoulderDiff = Math.abs(ls.price - rs.price);
    const symmetryScore = Math.max(0, 30 - (shoulderDiff / atr) * 15);
    const confidence = Math.round(50 + symmetryScore + (status === "confirmed" ? 20 : 0));

    const pattern: ChartPattern = {
      pair: "EUR/USD" as any,
      timeframe: "4H" as any,
      type: "head_and_shoulders",
      status,
      neckline: necklinePrice,
      target,
      confidence,
      detectedAt: Date.now(),
      extendedData: {
        leftShoulderTimestamp: ls.timestamp,
        leftShoulderPrice: ls.price,
        headTimestamp: head.timestamp,
        headPrice: head.price,
        rightShoulderTimestamp: rs.timestamp,
        rightShoulderPrice: rs.price,
        necklineLeft: trough1.timestamp,
        necklineRight: trough2.timestamp,
        necklinePrice,
      },
    };

    if (!best || rs.index > (best.extendedData?.rightShoulderTimestamp ?? 0)) {
      best = pattern;
    }
  }

  return best;
}

export function detectInverseHeadAndShoulders(candles: Candle[]): ChartPattern | null {
  if (candles.length < 20) return null;
  const atr = simpleATR(candles);
  const lows = getSwingLows(candles);
  if (lows.length < 3) return null;

  let best: ChartPattern | null = null;

  for (let i = 0; i < lows.length - 2; i++) {
    const ls = lows[i]!;
    const head = lows[i + 1]!;
    const rs = lows[i + 2]!;

    if (head.price >= ls.price) continue;
    if (head.price >= rs.price) continue;
    if (Math.abs(ls.price - rs.price) >= atr * 2) continue;
    if (rs.index - ls.index < 10) continue;

    const peak1 = localMaxBetween(candles, ls.index, head.index);
    const peak2 = localMaxBetween(candles, head.index, rs.index);
    const necklinePrice = (peak1.price + peak2.price) / 2;
    const target = necklinePrice + (necklinePrice - head.price);

    const lastClose = candles[candles.length - 1]!.close;
    const status: "forming" | "confirmed" = lastClose > necklinePrice ? "confirmed" : "forming";

    const shoulderDiff = Math.abs(ls.price - rs.price);
    const symmetryScore = Math.max(0, 30 - (shoulderDiff / atr) * 15);
    const confidence = Math.round(50 + symmetryScore + (status === "confirmed" ? 20 : 0));

    const pattern: ChartPattern = {
      pair: "EUR/USD" as any,
      timeframe: "4H" as any,
      type: "inverse_head_and_shoulders",
      status,
      neckline: necklinePrice,
      target,
      confidence,
      detectedAt: Date.now(),
      extendedData: {
        leftShoulderTimestamp: ls.timestamp,
        leftShoulderPrice: ls.price,
        headTimestamp: head.timestamp,
        headPrice: head.price,
        rightShoulderTimestamp: rs.timestamp,
        rightShoulderPrice: rs.price,
        necklineLeft: peak1.timestamp,
        necklineRight: peak2.timestamp,
        necklinePrice,
      },
    };

    if (!best || rs.index > (best.extendedData?.rightShoulderTimestamp ?? 0)) {
      best = pattern;
    }
  }

  return best;
}

export function detectDoubleTop(_candles: Candle[]): ChartPattern | null {
  return null;
}

export function detectDoubleBottom(_candles: Candle[]): ChartPattern | null {
  return null;
}

export function detectAllPatterns(candles: Candle[]): ChartPattern[] {
  return [
    detectHeadAndShoulders(candles),
    detectInverseHeadAndShoulders(candles),
    detectDoubleTop(candles),
    detectDoubleBottom(candles),
  ].filter((p): p is ChartPattern => p !== null);
}
