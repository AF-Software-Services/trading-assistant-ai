import type { MarketDataProvider } from "./interface.ts";
import type { CurrencyPair, Timeframe, Candle, PriceTick } from "../types/market.ts";
import type { TradingService } from "../trading/service.ts";

// ProtoOATrendbarPeriod values this app actually uses — the bot engine only ever
// requests "4H" and "D"; "1H"/"2H"/"W" are unused but mapped anyway for completeness.
const PERIOD_BY_TIMEFRAME: Record<Timeframe, number | undefined> = {
  "1H": 9,   // H1
  "2H": undefined, // no native cTrader period — unused by the app
  "4H": 10,  // H4
  "D":  12,  // D1
  "W":  13,  // W1
};

const M1_PERIOD = 1;

export class CTraderMarketDataProvider implements MarketDataProvider {
  constructor(private readonly trading: TradingService) {}

  async getCandles(pair: CurrencyPair, timeframe: Timeframe, count: number): Promise<Candle[]> {
    const period = PERIOD_BY_TIMEFRAME[timeframe];
    if (period === undefined) throw new Error(`cTrader trendbars don't support timeframe "${timeframe}"`);

    const symbolId = await this.trading.resolveSymbolId(pair);
    const bars = await this.trading.getTrendbars(symbolId, period, count);

    return bars.map(b => ({
      timestamp: b.timestamp,
      open:  b.open,
      high:  b.high,
      low:   b.low,
      close: b.close,
      volume: b.volume,
      timeframe,
      pair,
    }));
  }

  async getLatestPrice(pair: CurrencyPair): Promise<PriceTick> {
    const symbolId = await this.trading.resolveSymbolId(pair);
    // count=1 can land inside the currently-forming bar (not yet in the broker's completed
    // history) and come back empty — asking for a few and taking the last one is robust to that.
    const bars = await this.trading.getTrendbars(symbolId, M1_PERIOD, 5);
    const last = bars[bars.length - 1];
    if (!last) throw new Error(`No recent price data for ${pair}`);
    return { pair, bid: last.close, ask: last.close, mid: last.close, timestamp: last.timestamp };
  }
}
