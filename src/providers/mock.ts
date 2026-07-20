import type { MarketDataProvider } from "./interface.ts";
import type { CurrencyPair, Timeframe, Candle, PriceTick } from "../types/market.ts";

const BASE_PRICES: Record<CurrencyPair, number> = {
  "EUR/USD":   1.0850,
  "GBP/USD":   1.2650,
  "GBP/CAD":   1.7200,
  "USD/JPY":   149.50,
  "EUR/GBP":   0.8580,
  "AUD/USD":   0.6520,
  "US500":     6300,
  "NAS100":    23000,
  "GER40":     24000,
  "UK100":     8900,
  "XAU/USD":   3990,
  "XAG/USD":   56,
  "WTI/USD":   79,
  "BRENT/USD": 84,
  "NATGAS":    3.5,
  "COPPER":    4.6,
  "USD/CAD":   1.3800,
  "USD/SEK":   9.6500,
  "USD/CHF":   0.8000,
};

const TIMEFRAME_MS: Record<Timeframe, number> = {
  "1H": 3_600_000,
  "2H": 7_200_000,
  "4H": 14_400_000,
  "D":  86_400_000,
  "W":  604_800_000,
};

// Typical volatility (as fraction of price) per timeframe
const TIMEFRAME_VOLATILITY: Record<Timeframe, number> = {
  "1H": 0.0008,
  "2H": 0.0011,
  "4H": 0.0015,
  "D":  0.0035,
  "W":  0.0080,
};

/**
 * Simple seeded pseudo-random number generator (mulberry32).
 * Returns a function that yields values in [0, 1).
 */
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pairSeed(pair: CurrencyPair, timeframe: Timeframe): number {
  let hash = 0;
  const str = `${pair}:${timeframe}`;
  for (let i = 0; i < str.length; i++) {
    hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export class MockMarketDataProvider implements MarketDataProvider {
  async getCandles(pair: CurrencyPair, timeframe: Timeframe, count: number): Promise<Candle[]> {
    const rng = seededRng(pairSeed(pair, timeframe));
    const intervalMs = TIMEFRAME_MS[timeframe];
    const volatility = TIMEFRAME_VOLATILITY[timeframe];
    const basePrice = BASE_PRICES[pair];

    // Generate candle closes as a random walk
    const closes: number[] = new Array(count) as number[];
    let price = basePrice;

    // Warm up the walk so we don't always start at exact base
    for (let i = 0; i < 20; i++) {
      price *= 1 + (rng() - 0.5) * volatility * 2;
    }

    for (let i = 0; i < count; i++) {
      price *= 1 + (rng() - 0.495) * volatility * 2; // slight upward drift
      closes[i] = price;
    }

    const now = Date.now();
    // Align to interval boundary
    const latestTimestamp = Math.floor(now / intervalMs) * intervalMs;

    const candles: Candle[] = [];
    for (let i = 0; i < count; i++) {
      const idx = i;
      const timestamp = latestTimestamp - (count - 1 - idx) * intervalMs;
      const close = closes[idx] ?? basePrice;
      const open = idx === 0 ? close * (1 + (rng() - 0.5) * volatility) : (closes[idx - 1] ?? close);

      const bodyHigh = Math.max(open, close);
      const bodyLow  = Math.min(open, close);

      // Wicks: random extension beyond body
      const upperWick = bodyHigh * (1 + rng() * volatility * 1.5);
      const lowerWick = bodyLow  * (1 - rng() * volatility * 1.5);

      const high = Math.max(upperWick, bodyHigh);
      const low  = Math.min(lowerWick, bodyLow);

      candles.push({
        timestamp,
        open:  +open.toFixed(5),
        high:  +high.toFixed(5),
        low:   +low.toFixed(5),
        close: +close.toFixed(5),
        volume: Math.floor(rng() * 5000 + 500),
        timeframe,
        pair,
      });
    }

    return candles;
  }

  async getLatestPrice(pair: CurrencyPair): Promise<PriceTick> {
    const rng = seededRng(pairSeed(pair, "1H") ^ Date.now());
    const base = BASE_PRICES[pair];
    const spread = pair === "USD/JPY" ? 0.02 : 0.0001;
    const mid = base * (1 + (rng() - 0.5) * 0.0002);
    const bid = mid - spread / 2;
    const ask = mid + spread / 2;
    return {
      pair,
      bid: +bid.toFixed(5),
      ask: +ask.toFixed(5),
      mid: +mid.toFixed(5),
      timestamp: Date.now(),
    };
  }
}
