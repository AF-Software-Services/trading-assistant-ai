import type { MarketDataProvider } from "./interface.ts";
import type { CurrencyPair, Timeframe, Candle, PriceTick } from "../types/market.ts";

// How long to cache each timeframe's candle data (seconds)
const CANDLE_TTL: Record<Timeframe, number> = {
  "1H":  5  * 60,   // 5 min
  "4H":  15 * 60,   // 15 min
  "D":   60 * 60,   // 1 hour
  "W":   4  * 3600, // 4 hours
};
const TICK_TTL = 60; // 1 min for live price

export class CachedProvider implements MarketDataProvider {
  constructor(
    private readonly inner: MarketDataProvider,
    private readonly kv: KVNamespace,
  ) {}

  async getCandles(pair: CurrencyPair, timeframe: Timeframe, count: number): Promise<Candle[]> {
    const key = `candles:${pair}:${timeframe}:${count}`;
    const cached = await this.kv.get<Candle[]>(key, "json");
    if (cached) return cached;

    const candles = await this.inner.getCandles(pair, timeframe, count);
    await this.kv.put(key, JSON.stringify(candles), { expirationTtl: CANDLE_TTL[timeframe] });
    return candles;
  }

  async getLatestPrice(pair: CurrencyPair): Promise<PriceTick> {
    const key = `tick:${pair}`;
    const cached = await this.kv.get<PriceTick>(key, "json");
    if (cached) return cached;

    const tick = await this.inner.getLatestPrice(pair);
    await this.kv.put(key, JSON.stringify(tick), { expirationTtl: TICK_TTL });
    return tick;
  }
}
