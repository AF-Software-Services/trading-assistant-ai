import type { MarketDataProvider } from "./interface.ts";
import type { CurrencyPair, Timeframe, Candle, PriceTick } from "../types/market.ts";

const INTERVAL_MAP: Record<Timeframe, string> = {
  "1H": "1h",
  "4H": "4h",
  "D":  "1day",
  "W":  "1week",
};

export class TwelveDataProvider implements MarketDataProvider {
  constructor(private readonly apiKey: string) {}

  async getCandles(pair: CurrencyPair, timeframe: Timeframe, count: number): Promise<Candle[]> {
    const symbol   = pair; // Twelve Data accepts "GBP/USD" format directly
    const interval = INTERVAL_MAP[timeframe];
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${count}&apikey=${this.apiKey}&format=JSON`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Twelve Data HTTP ${res.status}`);

    const data = await res.json() as { status?: string; message?: string; values?: Array<{ datetime: string; open: string; high: string; low: string; close: string }> };

    if (data.status === "error") throw new Error(`Twelve Data error: ${data.message}`);
    if (!data.values) throw new Error("Twelve Data returned no values");

    return data.values
      .slice()
      .reverse()
      .map(v => ({
        timestamp: new Date(v.datetime).getTime(),
        open:  parseFloat(v.open),
        high:  parseFloat(v.high),
        low:   parseFloat(v.low),
        close: parseFloat(v.close),
        timeframe,
        pair,
      }));
  }

  async getLatestPrice(pair: CurrencyPair): Promise<PriceTick> {
    const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(pair)}&apikey=${this.apiKey}`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`Twelve Data HTTP ${res.status}`);

    const data = await res.json() as { price?: string; message?: string };
    if (!data.price) throw new Error(`Twelve Data price error: ${data.message}`);

    const mid = parseFloat(data.price);
    return { pair, bid: mid, ask: mid, mid, timestamp: Date.now() };
  }
}
