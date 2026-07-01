import type { CurrencyPair, Timeframe, Candle, PriceTick } from "../types/market.ts";

export interface MarketDataProvider {
  getCandles(pair: CurrencyPair, timeframe: Timeframe, count: number): Promise<Candle[]>;
  getLatestPrice(pair: CurrencyPair): Promise<PriceTick>;
}
